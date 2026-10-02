/**
 * worker.js — 音声文字起こし・翻訳の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロード・推論はすべて
 * この Web Worker 内で実行する。
 *
 * 実行基盤: Transformers.js v4 (WebGPU EP)
 * モデル:   onnx-community/granite-speech-4.1-2b-ONNX (Granite Speech 4.1 2B, q4f16)
 *
 * IBM 公式 WebGPU デモ (granite-speech-webgpu/app.js) と同じ構成:
 *   AutoProcessor → GraniteSpeechForConditionalGeneration → TextStreamer
 */

import {
  MODEL_ID,
  SAMPLE_RATE,
  MAX_NEW_TOKENS,
  TRANSFORMERS_MODULE_URL,
  DTYPE_WEBGPU,
  DTYPE_WASM,
  buildTaskPrompt,
  sliceSeconds,
  formatBytes,
  DIARIZATION_MODEL_BASE_URL,
  DIARIZATION_CACHE_NAME,
  DIARIZATION_STREAMING_MODE,
  resolveDiarizationDtype,
  estimateDiarizationBytes,
} from './pipeline.mjs';
import { Diarizer, DEFAULT_FEATURE_CONFIG } from './diarizer.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let processor = null;
let model = null;
let backend = 'wasm';
let usedDtype = 'q4';
let busy = false;
let cancelRequested = false;
let shimApplied = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (madeinllm の WebGPU 判定方式を踏襲)
   ========================================================== */
async function detectBackend() {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const fp16 =
          adapter.features && typeof adapter.features.has === 'function'
            ? adapter.features.has('shader-f16')
            : false;
        return { device: 'webgpu', fp16 };
      }
    } catch (err) {
      console.warn('WebGPU アダプタの取得に失敗:', err);
    }
  }
  return { device: 'wasm', fp16: false };
}

/* ==========================================================
   モデル読み込み
   ========================================================== */
async function loadLibraries() {
  if (tf) return;
  status('library', 'Transformers.js を読み込み中…');
  tf = await import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL);
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true;
  try {
    if (tf.env.backends && tf.env.backends.onnx && tf.env.backends.onnx.wasm) {
      // GitHub Pages は COOP/COEP を返さないためマルチスレッド WASM を無効化する
      tf.env.backends.onnx.wasm.numThreads = 1;
    }
  } catch {
    /* 環境によっては存在しない */
  }
}

/**
 * onnx-community の 4.1-2b エクスポートは、エンコーダ特徴量の数と
 * <|audio|> トークン数が一致しないことがある。IBM 公式デモと同じ補正を入れる。
 * 上流の export / transformers.js PR #1685 が取り込まれたら削除してよい。
 */
function applyAudioFeatureShim(candidate) {
  if (shimApplied || !candidate) return;
  try {
    const original = candidate._merge_input_ids_with_audio_features;
    if (typeof original !== 'function') return;
    const bound = original.bind(candidate);
    const patched = function (kwargs) {
      if (!kwargs || !kwargs.audio_features) return bound(kwargs);
      const audioTokenId =
        this.config.ignore_index ?? this.config.audio_token_id ?? this.config.audio_token_index;
      const idsFlat = kwargs.input_ids.tolist().flat();
      const nTokens = idsFlat.filter((x) => Number(x) === Number(audioTokenId)).length;
      const hidden = kwargs.audio_features.dims.at(-1);
      let nFeatures = 1;
      for (let i = 0; i < kwargs.audio_features.dims.length - 1; i++) {
        nFeatures *= kwargs.audio_features.dims[i];
      }
      if (nFeatures === nTokens) return bound(kwargs);

      console.warn(
        `[shim] audio features/tokens mismatch: features=${nFeatures}, tokens=${nTokens}, adjusting`,
      );
      const flat = kwargs.audio_features.view(-1, hidden);
      const src = flat.data;
      let dst;
      if (nFeatures > nTokens) {
        dst = src.slice(0, nTokens * hidden);
      } else {
        dst = new src.constructor(nTokens * hidden);
        if (nFeatures > 0) {
          dst.set(src);
          const lastStart = (nFeatures - 1) * hidden;
          const lastVec = src.subarray(lastStart, lastStart + hidden);
          for (let i = nFeatures; i < nTokens; i++) {
            dst.set(lastVec, i * hidden);
          }
        }
      }
      return bound({
        ...kwargs,
        audio_features: new tf.Tensor(flat.type, dst, [nTokens, hidden]),
      });
    };
    candidate._merge_input_ids_with_audio_features = patched;
    const proto = Object.getPrototypeOf(candidate);
    if (proto) proto._merge_input_ids_with_audio_features = patched;
    shimApplied = true;
  } catch (err) {
    console.warn('audio feature shim を適用できませんでした:', err);
  }
}

function makeProgressCallback() {
  const fileProgress = {};
  let lastUpdate = 0;
  return (progress) => {
    if (!progress || progress.status !== 'progress' || !progress.total) return;
    const key = progress.file || progress.name || 'unknown';
    fileProgress[key] = { loaded: progress.loaded, total: progress.total };

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastUpdate < 100) return;
    lastUpdate = now;

    let loaded = 0;
    let total = 0;
    for (const f of Object.values(fileProgress)) {
      loaded += f.loaded;
      total += f.total;
    }
    post('progress', {
      stage: 'download',
      file: key,
      loaded,
      total,
      percent: total > 0 ? (loaded / total) * 100 : 0,
    });
  };
}

async function loadProcessor() {
  status('processor', 'プロセッサ (音声前処理) を準備中…');
  processor = await tf.AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: makeProgressCallback(),
  });
}

async function loadModel(device, dtype) {
  status('model', '音声モデルを読み込み中… (初回は約 1.7 GB のダウンロード)');
  const loaded = await tf.GraniteSpeechForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: makeProgressCallback(),
  });
  applyAudioFeatureShim(loaded);
  return loaded;
}

async function init() {
  await loadLibraries();
  const detection = await detectBackend();
  backend = detection.device;
  post('backend', { backend, fp16: detection.fp16 });

  await loadProcessor();

  const dtype = backend === 'webgpu' ? DTYPE_WEBGPU : DTYPE_WASM;
  try {
    model = await loadModel(backend, dtype);
    usedDtype = backend === 'webgpu' ? 'q4f16' : 'q4';
  } catch (err) {
    if (backend === 'webgpu') {
      // WebGPU 経路が失敗したら WASM + q4 に落とす (madeinllm と同じフォールバック)
      console.warn('WebGPU での読み込みに失敗。WASM にフォールバックします:', err);
      backend = 'wasm';
      post('backend', { backend, fp16: false, fallback: true });
      model = await loadModel('wasm', DTYPE_WASM);
      usedDtype = 'q4';
    } else {
      throw err;
    }
  }

  post('ready', { backend, dtype: usedDtype, modelId: MODEL_ID, sampleRate: SAMPLE_RATE });
}

/* ==========================================================
   推論
   ========================================================== */
async function transcribe({ task, segments, samples }) {
  const content = buildTaskPrompt(task);
  const messages = [{ role: 'user', content }];
  const text = processor.tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  });

  cancelRequested = false;
  const startedAt = performance.now();
  let completed = 0;

  for (let index = 0; index < segments.length; index++) {
    if (cancelRequested) break;
    const segment = segments[index];
    const audio = sliceSeconds(samples, SAMPLE_RATE, segment.start, segment.end);
    if (audio.length < SAMPLE_RATE * 0.05) continue;

    status('process', `セグメント ${index + 1}/${segments.length} を推論中… (${backend})`);

    const inputs = await processor(text, audio, { sampling_rate: SAMPLE_RATE });

    let accumulated = '';
    const streamer = new tf.TextStreamer(processor.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        accumulated += chunk;
        post('partial', {
          segmentIndex: index,
          start: segment.start,
          end: segment.end,
          text: accumulated,
        });
      },
    });

    const t0 = performance.now();
    await model.generate({ ...inputs, max_new_tokens: MAX_NEW_TOKENS, streamer });
    completed++;

    post('segment', {
      segmentIndex: index,
      start: segment.start,
      end: segment.end,
      text: accumulated.trim(),
      elapsedMs: Math.round(performance.now() - t0),
    });
  }

  post('done', {
    cancelled: cancelRequested,
    segmentCount: completed,
    elapsedMs: Math.round(performance.now() - startedAt),
    backend,
  });
}

/* ==========================================================
   キャッシュ
   ========================================================== */
async function clearCache() {
  try {
    if (typeof caches === 'undefined') {
      post('cache-cleared', { removed: 0 });
      return;
    }
    const keys = await caches.keys();
    const targets = keys.filter((key) => key.startsWith('transformers-cache'));
    await Promise.all(targets.map((key) => caches.delete(key)));
    post('cache-cleared', { removed: targets.length });
  } catch (err) {
    post('error', { stage: 'cache', error: String(err) });
  }
}

/* ==========================================================
   話者分離 (Nemotron 3 Diarization)
   ==========================================================
   Transformers.js に diarization パイプラインが無いため、
   onnxruntime-web を直接使ってストリーミング Sortformer を回す。
   前処理・キャッシュ・後処理は diarizer.mjs の純粋ロジックに置く。
   ========================================================== */

const ORT_VERSION = '1.30.0';
const ORT_MODULE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`;
const ORT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let ort = null;
let diarizer = null;

async function loadOrt() {
  if (ort) return ort;
  status('diarization-library', 'ONNX Runtime Web を読み込み中…');
  ort = await import(/* @vite-ignore */ ORT_MODULE_URL);
  try {
    ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
    ort.env.wasm.numThreads = 1;
  } catch {
    /* 環境によっては存在しない */
  }
  return ort;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`設定の取得に失敗しました: ${res.status} ${url}`);
  return res.json();
}

/** レスポンスを読みつつ進捗を通知し、ArrayBuffer を返す */
async function readWithProgress(response, onProgress) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return response.arrayBuffer();
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/** Cache Storage (transformers-cache) に保存しつつ取得する */
async function fetchCached(url, onProgress) {
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(DIARIZATION_CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`モデルの取得に失敗しました: ${res.status} ${url}`);
    const forCache = res.clone();
    const buffer = await readWithProgress(res, onProgress);
    try {
      await cache.put(url, forCache);
    } catch {
      /* 容量不足などは無視して続行 */
    }
    return buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`モデルの取得に失敗しました: ${res.status} ${url}`);
  return readWithProgress(res, onProgress);
}

async function fetchDiarizationFiles(dtype) {
  const base = DIARIZATION_MODEL_BASE_URL;
  const report = (file) => (loaded, total) =>
    post('progress', {
      stage: 'diarization-download',
      file,
      loaded,
      total,
      percent: total > 0 ? (loaded / total) * 100 : 0,
    });
  const modelBuffer = await fetchCached(`${base}/onnx/model_${dtype}.onnx`, report(`model_${dtype}.onnx`));
  const dataBuffer = await fetchCached(
    `${base}/onnx/model_${dtype}.onnx_data`,
    report(`model_${dtype}.onnx_data`),
  );
  return { modelBuffer, dataBuffer };
}

async function createDiarizationSession(runtime, device, dtype, files) {
  return runtime.InferenceSession.create(files.modelBuffer, {
    executionProviders: [device === 'webgpu' ? 'webgpu' : 'wasm'],
    externalData: [{ path: `model_${dtype}.onnx_data`, data: files.dataBuffer }],
    graphOptimizationLevel: 'all',
  });
}

async function loadDiarizer(device) {
  if (diarizer) return diarizer;
  const runtime = await loadOrt();
  const base = DIARIZATION_MODEL_BASE_URL;
  let dtype = resolveDiarizationDtype(device);
  status(
    'diarization-model',
    `話者分離モデルを読み込み中… (初回は約 ${formatBytes(estimateDiarizationBytes(dtype))} のダウンロード)`,
  );

  const [modelConfig, processorConfig] = await Promise.all([
    fetchJson(`${base}/config.json`),
    fetchJson(`${base}/processor_config.json`),
  ]);

  let files = await fetchDiarizationFiles(dtype);
  let session;
  try {
    session = await createDiarizationSession(runtime, device, dtype, files);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // WebGPU 経路が失敗したら WASM + q4 に落とす
    console.warn('WebGPU での話者分離セッション作成に失敗。WASM にフォールバックします:', err);
    dtype = resolveDiarizationDtype('wasm');
    files = await fetchDiarizationFiles(dtype);
    session = await createDiarizationSession(runtime, 'wasm', dtype, files);
    device = 'wasm';
  }

  const makeTensor = (type, data, dims) => new runtime.Tensor(type, data, dims);
  diarizer = new Diarizer(
    session,
    { model: modelConfig, processor: processorConfig },
    DIARIZATION_STREAMING_MODE,
    DEFAULT_FEATURE_CONFIG,
    makeTensor,
  );
  post('diarization-ready', {
    dtype,
    device,
    numSpeakers: diarizer.numSpeakers,
    frameDuration: diarizer.frameDurationSeconds,
  });
  return diarizer;
}

async function diarize(samples) {
  const instance = await loadDiarizer(backend);
  instance.reset();
  status('diarization', '話者を判定中…');
  const startedAt = performance.now();
  const pushed = await instance.push(samples);
  const flushed = await instance.flush();
  const probabilities = new Float32Array(pushed.probabilities.length + flushed.probabilities.length);
  probabilities.set(pushed.probabilities, 0);
  probabilities.set(flushed.probabilities, pushed.probabilities.length);
  post(
    'diarization',
    {
      probabilities: probabilities.buffer,
      numFrames: pushed.numFrames + flushed.numFrames,
      numSpeakers: instance.numSpeakers,
      frameDuration: instance.frameDurationSeconds,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
    [probabilities.buffer],
  );
}

/* ==========================================================
   メッセージ処理
   ========================================================== */
self.addEventListener('message', async (event) => {
  const message = event.data || {};
  const type = message.type;

  if (type === 'init') {
    if (busy) return;
    busy = true;
    try {
      await init();
    } catch (err) {
      console.error(err);
      post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'transcribe') {
    if (busy) {
      post('error', { stage: 'transcribe', error: '推論中です。完了までお待ちください。' });
      return;
    }
    if (!model || !processor) {
      post('error', { stage: 'transcribe', error: 'モデルがまだ準備できていません。' });
      return;
    }
    busy = true;
    try {
      const samples = new Float32Array(message.samples);
      if (message.speakerMode) {
        // 話者分離に失敗しても文字起こしは続行する
        try {
          await diarize(samples);
        } catch (err) {
          console.error('diarization failed:', err);
          post('diarization-error', {
            error: err && err.message ? err.message : String(err),
          });
        }
      }
      await transcribe({ task: message.task, segments: message.segments || [], samples });
    } catch (err) {
      console.error(err);
      post('error', {
        stage: 'transcribe',
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'cancel') {
    cancelRequested = true;
    return;
  }

  if (type === 'clear-cache') {
    await clearCache();
  }
});
