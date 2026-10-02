/**
 * worker.js — 背景除去の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * 実行基盤: Transformers.js v4
 * モデル:
 *   - Xenova/modnet        … `background-removal` パイプラインで実行 (人物)
 *   - briaai/RMBG-1.4      … `SegformerForSemanticSegmentation` を明示して実行 (汎用)
 *
 * 補足: RMBG-1.4 の config.json は model_type が "SegformerForSemanticSegmentation" であり、
 * Transformers.js の AutoModel 解決 (model_type → クラス名の Map 引き) では
 * `background-removal` パイプラインから読み込めない (2026-09-21 に実機で確認)。
 * そのため RMBG だけはアーキテクチャクラスを直接ロードし、
 * パイプラインと同じ後処理 (sigmoid → 255 正規化 → マスク resize → putAlpha) を行う。
 *
 * 画像の読み込み (デコード) はメインスレッドで済ませ、ここでは生の RGBA
 * バイト列を受け取って RawImage を作る (worker 内の Image デコードに依存しない)。
 */

import {
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  getModel,
  chooseModel,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let backend = 'wasm';
let fp16 = false;
let backendDetected = false;
let active = null; // { modelKey, modelId, dtype, kind, pipe? , processor?, net? }
let busy = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (madeinllm / voice-transcriber と同じ方式)
   ========================================================== */
async function detectBackend() {
  if (backendDetected) return { device: backend, fp16 };
  backendDetected = true;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        backend = 'webgpu';
        fp16 =
          adapter.features && typeof adapter.features.has === 'function'
            ? adapter.features.has('shader-f16')
            : false;
        return { device: backend, fp16 };
      }
    } catch (err) {
      console.warn('WebGPU アダプタの取得に失敗:', err);
    }
  }
  backend = 'wasm';
  fp16 = false;
  return { device: backend, fp16 };
}

/* ==========================================================
   ライブラリ / モデル読み込み
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

/** 進捗コールバック。pipeline() は progress_total も流してくれる。 */
function makeProgressCallback() {
  let lastUpdate = 0;
  return (info) => {
    if (!info) return;
    if (info.status === 'progress_total') {
      post('progress', {
        stage: 'download',
        progress: info.progress,
        loaded: info.loaded,
        total: info.total,
      });
      return;
    }
    if (info.status === 'progress' && info.total) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      post('progress', {
        stage: 'download',
        file: info.file || info.name || 'model',
        loaded: info.loaded,
        total: info.total,
      });
    }
  };
}

async function loadModel(subjectKey) {
  await loadLibraries();
  await detectBackend();
  post('backend', { backend, fp16, fallback: false });

  const choice = chooseModel(subjectKey, backend === 'webgpu');
  if (active && active.modelKey === choice.modelKey && active.dtype === choice.dtype) {
    post('ready', readyPayload(choice));
    return choice;
  }

  const model = getModel(choice.modelKey);
  status('model', `${model.label} を読み込み中…`);

  const options = {
    device: choice.device,
    dtype: choice.dtype,
    progress_callback: makeProgressCallback(),
  };

  if (choice.modelKey === 'rmbg') {
    const processor = await tf.AutoProcessor.from_pretrained(model.modelId, {
      progress_callback: makeProgressCallback(),
    });
    const net = await tf.SegformerForSemanticSegmentation.from_pretrained(model.modelId, options);
    active = { ...choice, kind: 'segformer', processor, net };
  } else {
    const pipe = await tf.pipeline('background-removal', model.modelId, options);
    active = { ...choice, kind: 'pipeline', pipe };
  }

  post('ready', readyPayload(choice));
  return choice;
}

function readyPayload(choice) {
  return {
    subjectKey: choice.subjectKey,
    modelKey: choice.modelKey,
    modelId: choice.modelId,
    device: choice.device,
    dtype: choice.dtype,
    backend,
    fp16,
    license: choice.license,
    commercial: choice.commercial,
  };
}

/* ==========================================================
   推論
   ========================================================== */

/** background-removal パイプラインと同じ後処理でアルファ付き RawImage を作る */
async function runSegformer(image) {
  const inputs = await active.processor(image);
  const session = active.net.sessions['model'];
  const feeds = session.inputNames.includes('pixel_values')
    ? { ...inputs }
    : { [session.inputNames[0]]: inputs.pixel_values };

  const output = await active.net(feeds);
  let tensor = output[session.outputNames[0]];
  if (tensor.dims.length === 4) tensor = tensor[0];

  // 出力がロジットなら sigmoid を適用 (パイプラインと同じ epsilon 判定)
  const epsilon = 1e-5;
  const needsSigmoid = tensor.data.some((x) => x < -epsilon || x > 1 + epsilon);
  if (needsSigmoid && typeof tensor.sigmoid_ === 'function') tensor.sigmoid_();

  const mask = await tf.RawImage.fromTensor(tensor.mul_(255).to('uint8')).resize(
    image.width,
    image.height,
  );
  const cloned = image.clone();
  cloned.putAlpha(mask);
  return cloned;
}

async function runModel(image) {
  if (active.kind === 'pipeline') {
    const result = await active.pipe(image);
    return Array.isArray(result) ? result[0] : result;
  }
  return runSegformer(image);
}

async function processImage({ width, height, data }) {
  if (!active) throw new Error('モデルがまだ準備できていません。');
  if (!tf || !tf.RawImage) throw new Error('Transformers.js の RawImage が利用できません。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('画像サイズが不正です。');
  }
  const expected = width * height * 4;
  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  if (pixels.length < expected) {
    throw new Error(`RGBA データが不足しています (${pixels.length} < ${expected})`);
  }

  const image = new tf.RawImage(pixels, width, height, 4);
  status('process', `背景を推定中… (${backend})`);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const output = await runModel(image);
  if (!output || !output.data) throw new Error('推論結果が空でした。');

  const rgba = output.data;
  const buffer =
    rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
      ? rgba.buffer
      : rgba.slice().buffer;

  post(
    'result',
    {
      width: output.width,
      height: output.height,
      channels: output.channels || 4,
      elapsedMs: Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
      ),
      data: buffer,
    },
    [buffer],
  );
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
    const targets = keys.filter((key) => key.startsWith(CACHE_PREFIX));
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

  if (type === 'load') {
    if (busy) return;
    busy = true;
    try {
      await loadModel(message.subjectKey);
    } catch (err) {
      console.error(err);
      post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'process') {
    if (busy) {
      post('error', { stage: 'process', error: '処理中です。完了までお待ちください。' });
      return;
    }
    busy = true;
    try {
      await processImage(message);
    } catch (err) {
      console.error(err);
      post('error', { stage: 'process', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'clear-cache') {
    await clearCache();
  }
});
