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
} from './pipeline.mjs';

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
