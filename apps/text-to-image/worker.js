/**
 * worker.js — テキスト→画像生成の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロード・ONNX セッション生成・
 * 推論はすべてこの Web Worker 内で実行する。
 *
 * 実行基盤: ONNX Runtime Web 1.29.0 (WebGPU EP) + Transformers.js 4.2.0 (CLIP tokenizer)
 * モデル:   utkucoban/NanoDiffuser (約 382MiB, one-step SDXS)
 *
 * 純粋な計算は pipeline.mjs、キャッシュは model-cache.mjs に分離してある。
 */

import {
  MODEL_ID,
  MANIFEST_URL,
  TOKENIZER_ID,
  MODEL_TOKENIZER_SUBFOLDER,
  ORT_MODULE_URL,
  ORT_CDN_BASE,
  TRANSFORMERS_MODULE_URL,
  DEFAULT_MANIFEST,
  MODEL_FILE_SIZES,
  validateManifest,
  modelFilesFromManifest,
  externalDataPathCandidates,
  cacheRevision,
  createInitialLatent,
  denoiseStep,
  float32ToFloat16Array,
  tensorDataToFloat32,
  padOrTruncateTokens,
  nchwToRgba,
  resolveRoleInputs,
  resolveRoleOutput,
} from './pipeline.mjs';
import { createModelStore, CACHE_PREFIX } from './model-cache.mjs';

/* ==========================================================
   状態
   ========================================================== */
let ort = null;
let tf = null;
let manifest = null;
let tokenizer = null;
let store = null;
let backend = 'wasm';
let sessions = null; // { textEncoder, unet, decoder }
let inputs = null; // 各セッションの入力名解決結果
let outputs = null; // 各セッションの出力名
let timestepType = null; // 'float32' | 'int64' など (実行時に確定)
let busy = false;
// 外部重みへの参照を保持する。ORT が遅延読み込みする場合に備えて GC を防ぐ。
let modelBlobs = null;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   ライブラリ読み込み
   ========================================================== */
async function loadLibraries() {
  if (ort && tf) return;
  status('library', 'ONNX Runtime Web と Transformers.js を読み込み中…');
  const [ortModule, tfModule] = await Promise.all([
    import(/* @vite-ignore */ ORT_MODULE_URL),
    import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL),
  ]);
  ort = ortModule;
  tf = tfModule;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = ORT_CDN_BASE;
  ort.env.logLevel = 'error';
  tf.env.allowLocalModels = false;
}

/* ==========================================================
   バックエンド判定
   ========================================================== */
async function detectBackend() {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const fp16 = adapter.features && adapter.features.has ? adapter.features.has('shader-f16') : false;
        return { ep: 'webgpu', fp16 };
      }
    } catch (err) {
      console.warn('WebGPU アダプタの取得に失敗:', err);
    }
  }
  return { ep: 'wasm', fp16: false };
}

/* ==========================================================
   manifest / tokenizer / モデル本体
   ========================================================== */
async function loadManifest() {
  status('manifest', 'モデル設定を取得中…');
  let raw = DEFAULT_MANIFEST;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (res.ok) raw = await res.json();
  } catch (err) {
    console.warn('manifest.json を取得できなかったため既定値を使います:', err);
  }
  return validateManifest(raw);
}

async function loadTokenizer() {
  status('tokenizer', 'CLIP トークナイザーを準備中…');
  const progress_callback = (data) => {
    if (data && data.status === 'progress' && data.total) {
      post('progress', {
        stage: 'tokenizer',
        file: data.file,
        loaded: data.loaded,
        total: data.total,
      });
    }
  };
  try {
    return await tf.AutoTokenizer.from_pretrained(TOKENIZER_ID, { progress_callback });
  } catch (err) {
    // 標準 CLIP トークナイザが取得できない場合はモデル同梱のものを試す
    console.warn('標準 CLIP tokenizer の取得に失敗。モデル同梱 tokenizer を試します:', err);
    return await tf.AutoTokenizer.from_pretrained(MODEL_ID, {
      subfolder: MODEL_TOKENIZER_SUBFOLDER,
      progress_callback,
    });
  }
}

function assetList() {
  const assets = [];
  for (const file of modelFilesFromManifest(manifest)) {
    assets.push({ name: file.name, url: file.url, external: false });
    assets.push({
      name: file.externalDataName,
      url: file.externalDataUrl,
      external: true,
    });
  }
  return assets;
}

async function downloadModels() {
  const assets = assetList();
  const totalBytes = assets.reduce((sum, a) => sum + (MODEL_FILE_SIZES[a.name] || 0), 0);
  const loadedByUrl = new Map();

  function reportProgress(stage) {
    let loaded = 0;
    for (const size of loadedByUrl.values()) loaded += size;
    post('progress', {
      stage,
      overallLoaded: loaded,
      overallTotal: totalBytes,
      file: currentFile,
      fileIndex: currentIndex,
      fileCount: assets.length,
    });
  }

  let currentFile = '';
  let currentIndex = 0;
  const blobs = new Map();

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    currentFile = asset.name;
    currentIndex = i + 1;
    reportProgress('download');
    const blob = await store.load(asset.url, {
      expectedSize: MODEL_FILE_SIZES[asset.name] || 0,
    });
    blobs.set(asset.name, blob);
    loadedByUrl.set(asset.url, blob.size);
    reportProgress('download');
  }
  return blobs;
}

function inputTypeHint(session, name) {
  const md = session && session.inputMetadata;
  if (!md) return null;
  try {
    const entry = typeof md.get === 'function' ? md.get(name) : md[name];
    return entry && entry.type ? entry.type : null;
  } catch {
    return null;
  }
}

function makeFloatTensor(type, float32Data, dims) {
  if (type === 'float32') return new ort.Tensor('float32', float32Data, dims);
  return new ort.Tensor('float16', float32ToFloat16Array(float32Data), dims);
}

async function createGraphSession(file, blobs, ep) {
  const onnxBlob = blobs.get(file.name);
  const dataBlob = blobs.get(file.externalDataName);
  // ORT の create() は Blob を受け付けないため、グラフ本体は Uint8Array に変換する。
  // 外部重み (数百 MB) は Blob のまま渡せるのでメモリコピーを避ける。
  const onnxBytes = new Uint8Array(await onnxBlob.arrayBuffer());
  const candidates = externalDataPathCandidates(file.name);
  let lastError = null;
  for (const path of candidates) {
    try {
      return await ort.InferenceSession.create(onnxBytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
        externalData: [{ path, data: dataBlob }],
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `${file.name} のセッション生成に失敗しました: ${lastError ? lastError.message : '不明なエラー'}`,
  );
}

async function initSessions(blobs) {
  status('session', 'ONNX セッションを初期化中… (初回は数十秒かかることがあります)');
  const files = modelFilesFromManifest(manifest);
  const textEncoder = await createGraphSession(files[0], blobs, backend);
  const unet = await createGraphSession(files[1], blobs, backend);
  const decoder = await createGraphSession(files[2], blobs, backend);

  const resolvedInputs = {
    textEncoder: resolveRoleInputs('text_encoder', textEncoder.inputNames),
    unet: resolveRoleInputs('unet', unet.inputNames),
    decoder: resolveRoleInputs('decoder', decoder.inputNames),
  };
  if (!resolvedInputs.textEncoder.input_ids) {
    throw new Error(`text_encoder の入力 (input_ids) を特定できません: ${textEncoder.inputNames}`);
  }
  for (const key of ['sample', 'timestep', 'encoder_hidden_states']) {
    if (!resolvedInputs.unet[key]) {
      throw new Error(`unet の入力 (${key}) を特定できません: ${unet.inputNames}`);
    }
  }
  if (!resolvedInputs.decoder.latent) {
    throw new Error(`decoder の入力 (latent) を特定できません: ${decoder.inputNames}`);
  }

  inputs = resolvedInputs;
  outputs = {
    textEncoder: resolveRoleOutput('text_encoder', textEncoder.outputNames),
    unet: resolveRoleOutput('unet', unet.outputNames),
    decoder: resolveRoleOutput('decoder', decoder.outputNames),
  };
  sessions = { textEncoder, unet, decoder };

  // 入力型がメタデータから分かる場合は反映する
  timestepType = inputTypeHint(unet, resolvedInputs.unet.timestep) || 'float32';
}

/* ==========================================================
   推論
   ========================================================== */
function tokenizePrompt(prompt) {
  const maxTokens = manifest.maxPromptTokens;
  const padId = Number.isInteger(tokenizer.pad_token_id) ? tokenizer.pad_token_id : 49407;
  const encoded = tokenizer(prompt, {
    padding: 'max_length',
    max_length: maxTokens,
    truncation: true,
  });
  const rawIds = encoded.input_ids;
  const ids = Array.from(rawIds.data, (v) => Number(v));
  const inputIds = padOrTruncateTokens(ids, maxTokens, padId);

  let attentionMask = null;
  if (encoded.attention_mask) {
    attentionMask = padOrTruncateTokens(
      Array.from(encoded.attention_mask.data, Number),
      maxTokens,
      0,
    );
  }
  return { inputIds, attentionMask };
}

async function encodeText(tokens) {
  const feed = {};
  feed[inputs.textEncoder.input_ids] = new ort.Tensor('int32', tokens.inputIds, [1, manifest.maxPromptTokens]);
  if (inputs.textEncoder.attention_mask && tokens.attentionMask) {
    feed[inputs.textEncoder.attention_mask] = new ort.Tensor('int32', tokens.attentionMask, [
      1,
      manifest.maxPromptTokens,
    ]);
  }
  const result = await sessions.textEncoder.run(feed);
  const output = result[outputs.textEncoder];
  const data = tensorDataToFloat32(output.type, output.data);
  return { data, dims: output.dims };
}

function makeTimestepTensor(type, value) {
  if (type === 'int64') {
    return new ort.Tensor('int64', BigInt64Array.from([BigInt(Math.round(value))]), [1]);
  }
  if (type === 'int32') {
    return new ort.Tensor('int32', Int32Array.from([Math.round(value)]), [1]);
  }
  return new ort.Tensor('float32', Float32Array.from([value]), [1]);
}

async function runUnet(modelInput, textEmbedding) {
  const sampleType = inputTypeHint(sessions.unet, inputs.unet.sample) || 'float16';
  const textType = inputTypeHint(sessions.unet, inputs.unet.encoder_hidden_states) || 'float16';

  const makeFeed = () => {
    const feed = {};
    feed[inputs.unet.sample] = makeFloatTensor(sampleType, modelInput, manifest.latentShape);
    feed[inputs.unet.encoder_hidden_states] = makeFloatTensor(textType, textEmbedding.data, textEmbedding.dims);
    feed[inputs.unet.timestep] = makeTimestepTensor(timestepType, manifest.scheduler.timestep);
    return feed;
  };

  try {
    const result = await sessions.unet.run(makeFeed());
    return tensorDataToFloat32(result[outputs.unet].type, result[outputs.unet].data);
  } catch (err) {
    // timestep の型推定が外れていた場合だけ int64 で一度だけ再試行する
    if (timestepType !== 'int64') {
      console.warn('U-Net の初回実行に失敗。timestep を int64 として再試行します:', err);
      timestepType = 'int64';
      const result = await sessions.unet.run(makeFeed());
      return tensorDataToFloat32(result[outputs.unet].type, result[outputs.unet].data);
    }
    throw err;
  }
}

async function runDecoder(latent) {
  const type = inputTypeHint(sessions.decoder, inputs.decoder.latent) || 'float16';
  const feed = {};
  feed[inputs.decoder.latent] = makeFloatTensor(type, latent, manifest.latentShape);
  const result = await sessions.decoder.run(feed);
  const output = result[outputs.decoder];
  const data = tensorDataToFloat32(output.type, output.data);
  return { data, dims: output.dims };
}

async function generate({ prompt, seed }) {
  const t0 = performance.now();

  status('tokenize', 'プロンプトを解析中…');
  const tokens = tokenizePrompt(prompt);

  status('encode', 'テキストを埋め込みに変換中…');
  const textEmbedding = await encodeText(tokens);

  status('denoise', 'one-step でノイズを除去中…');
  const initialLatent = createInitialLatent(seed, manifest.latentShape, manifest.scheduler.initNoiseSigma);
  const modelInput = new Float32Array(initialLatent.length);
  for (let i = 0; i < modelInput.length; i++) {
    modelInput[i] = initialLatent[i] * manifest.scheduler.modelInputScale;
  }
  const noisePrediction = await runUnet(modelInput, textEmbedding);
  const denoised = denoiseStep(
    initialLatent,
    noisePrediction,
    manifest.scheduler.sampleCoefficient,
    manifest.scheduler.outputCoefficient,
  );

  status('decode', '画像にデコード中…');
  const decoded = await runDecoder(denoised);

  const dims = decoded.dims;
  const height = manifest.height;
  const width = manifest.width;
  const channels = dims.length >= 3 ? dims[dims.length - 3] : 1;
  const rgba = nchwToRgba(decoded.data, channels, height, width, 0, 1);

  const elapsedMs = Math.round(performance.now() - t0);
  post(
    'result',
    {
      pixels: rgba.buffer,
      width,
      height,
      seed,
      prompt,
      elapsedMs,
      backend,
    },
    [rgba.buffer],
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
      await loadLibraries();
      const detection = await detectBackend();
      backend = detection.ep;
      post('backend', { backend, fp16: detection.fp16 });
      manifest = await loadManifest();
      tokenizer = await loadTokenizer();
      const revision = cacheRevision(manifest);
      store = createModelStore({
        cacheName: `${CACHE_PREFIX}${revision}`,
        onProgress: ({ url, loaded, total }) => {
          post('progress', { stage: 'download', url, loaded, total });
        },
      });
      const blobs = await downloadModels();
      modelBlobs = blobs;
      await initSessions(blobs);
      post('ready', {
        backend,
        fp16: detection.fp16,
        manifest: {
          width: manifest.width,
          height: manifest.height,
          modelId: manifest.modelId,
          format: manifest.format,
        },
      });
    } catch (err) {
      console.error(err);
      post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'generate') {
    if (busy) {
      post('error', { stage: 'generate', error: '生成中です。完了までお待ちください。' });
      return;
    }
    if (!sessions) {
      post('error', { stage: 'generate', error: 'モデルがまだ準備できていません。' });
      return;
    }
    busy = true;
    try {
      await generate({ prompt: message.prompt, seed: message.seed });
    } catch (err) {
      console.error(err);
      post('error', { stage: 'generate', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'clear-cache') {
    try {
      const removed = store ? await store.clear() : 0;
      post('cache-cleared', { removed });
    } catch (err) {
      post('error', { stage: 'cache', error: String(err) });
    }
  }
});
