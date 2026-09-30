/**
 * worker.js — 物体検出の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * エンジン: Transformers.js v4 の `object-detection` パイプライン (D-FINE nano)。
 * 画像の読み込み (デコード) はメインスレッドで済ませ、ここでは生の RGBA
 * バイト列を受け取って処理する。
 */

import {
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  chooseModel,
  parseDetections,
  nms,
  DEFAULT_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let backend = 'wasm';
let fp16 = false;
let backendDetected = false;
let active = null; // { modeKey, device, dtype, backend, pipe }
let busy = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (upscale-studio / bg-remove と同じ方式)
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
   Transformers.js
   ========================================================== */
async function loadTransformers() {
  if (tf) return tf;
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
  return tf;
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

/* ==========================================================
   モデル読み込み
   ========================================================== */
async function loadModel(modeKey) {
  await detectBackend();
  post('backend', { backend, fp16, fallback: false });

  const choice = chooseModel(modeKey, backend === 'webgpu');
  if (
    active &&
    active.modeKey === choice.modeKey &&
    active.dtype === choice.dtype &&
    active.backend === backend
  ) {
    post('ready', readyPayload(choice));
    return choice;
  }
  active = null;

  status('model', `${choice.shortLabel} を読み込み中…`);
  await loadTransformers();
  const pipe = await tf.pipeline(choice.task, choice.modelId, {
    device: choice.device,
    dtype: choice.dtype,
    progress_callback: makeProgressCallback(),
  });
  active = { modeKey: choice.modeKey, device: choice.device, dtype: choice.dtype, backend, pipe };

  post('ready', readyPayload(choice));
  return choice;
}

function readyPayload(choice) {
  return {
    modeKey: choice.modeKey,
    task: choice.task,
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
function clampThreshold(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0.01, num));
}

async function detectObjects({ width, height, data, threshold, iouThreshold }) {
  if (!active) throw new Error('モデルがまだ準備できていません。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`画像寸法が不正です: ${width}×${height}`);
  }

  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  const expected = width * height * 4;
  if (pixels.length < expected) {
    throw new Error(`RGBA データが不足しています (${pixels.length} < ${expected})`);
  }

  const scoreThreshold = clampThreshold(threshold, DEFAULT_THRESHOLD);
  const iou = clampThreshold(iouThreshold, DEFAULT_IOU_THRESHOLD);
  status('process', `推論中… (${backend}, しきい値 ${Math.round(scoreThreshold * 100)}%)`);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const image = new tf.RawImage(pixels, width, height, 4);
  const raw = await active.pipe(image, { threshold: scoreThreshold });
  const parsed = parseDetections(raw, width, height);
  const filtered = nms(parsed, iou).map((det, index) => ({ ...det, id: index }));

  post('detections', {
    width,
    height,
    detections: filtered,
    threshold: scoreThreshold,
    iouThreshold: iou,
    elapsedMs: Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    ),
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
      await loadModel(message.modeKey);
    } catch (err) {
      console.error(err);
      post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'detect') {
    if (busy) {
      post('error', { stage: 'process', error: '処理中です。完了までお待ちください。' });
      return;
    }
    busy = true;
    try {
      await detectObjects(message);
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
