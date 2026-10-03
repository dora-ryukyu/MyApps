/**
 * worker.js — 顔検出の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * エンジン: MediaPipe Tasks Vision の FaceDetector (BlazeFace short-range)。
 * 画像のデコード (createImageBitmap) はメインスレッドで済ませ、ここでは
 * ImageBitmap を受け取って処理する。
 *
 * モデル (tflite) は Cache Storage (`face-privacy-cache`) に保存し、
 * 2 回目以降は再ダウンロードしない。
 */

import {
  MEDIAPIPE_MODULE_URL,
  MEDIAPIPE_WASM_URL,
  CACHE_NAME,
  CACHE_PREFIX,
  DEFAULT_CONFIDENCE,
  DEFAULT_SUPPRESSION,
  chooseModel,
  getModel,
  parseDetections,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let mp = null; // MediaPipe モジュール
let vision = null; // WasmFileset
let detector = null;
let active = null; // { modeKey, delegate, detector }
let busy = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定
   ==========================================================
   MediaPipe の GPU delegate は WebGL2 ベース。worker では
   OffscreenCanvas から WebGL2 が取れるかで判断する。
   ========================================================== */
function hasWebGL2() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const canvas = new OffscreenCanvas(1, 1);
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

/* ==========================================================
   MediaPipe の読み込み
   ========================================================== */
async function loadRuntime() {
  if (mp) return mp;
  status('library', 'MediaPipe Tasks Vision を読み込み中…');
  mp = await import(/* @vite-ignore */ MEDIAPIPE_MODULE_URL);
  return mp;
}

async function getVisionFileset() {
  if (vision) return vision;
  const runtime = await loadRuntime();
  vision = await runtime.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL, true);
  return vision;
}

/* ==========================================================
   モデルの取得 (Cache Storage 対応)
   ========================================================== */
async function readWithProgress(response, total, onProgress) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ loaded: received, total: total || received });
  }
  const out = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

async function loadModelBuffer(model) {
  let cache = null;
  try {
    if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME);
  } catch {
    cache = null;
  }

  if (cache) {
    const hit = await cache.match(model.url);
    if (hit) {
      post('status', { stage: 'model', message: 'キャッシュ済みのモデルを使用します' });
      return new Uint8Array(await hit.arrayBuffer());
    }
  }

  status('model', '顔検出モデルをダウンロード中…');
  const response = await fetch(model.url);
  if (!response.ok) {
    throw new Error(`モデルの取得に失敗しました (${response.status})`);
  }
  const total = Number(response.headers.get('content-length')) || model.bytes || 0;
  const buffer = await readWithProgress(response, total, (info) => {
    post('progress', { stage: 'download', loaded: info.loaded, total: info.total });
  });

  if (cache) {
    try {
      await cache.put(
        model.url,
        new Response(buffer.slice(0), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );
    } catch (err) {
      console.warn('モデルをキャッシュできませんでした:', err);
    }
  }
  return buffer;
}

/* ==========================================================
   モデル読み込み / タスク生成
   ========================================================== */
function createDetector(fileset, buffer, delegate) {
  return mp.FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetBuffer: buffer,
      delegate,
    },
    minDetectionConfidence: DEFAULT_CONFIDENCE,
    minSuppressionThreshold: DEFAULT_SUPPRESSION,
    runningMode: 'IMAGE',
  });
}

async function loadModel(modeKey) {
  const fileset = await getVisionFileset();
  const choice = chooseModel(modeKey, hasWebGL2());

  if (active && active.modeKey === choice.modeKey) {
    post('ready', readyPayload(choice, active.delegate));
    return;
  }

  const buffer = await loadModelBuffer(getModel(modeKey));

  if (detector) {
    try {
      detector.close();
    } catch {
      /* 既に閉じている */
    }
    detector = null;
  }

  let delegate = choice.delegate;
  try {
    detector = await createDetector(fileset, buffer, delegate);
  } catch (err) {
    if (delegate !== 'CPU') {
      console.warn('GPU delegate の初期化に失敗、CPU に切り替えます:', err);
      status('delegate', 'GPU が使えないため CPU に切り替えます…');
      delegate = 'CPU';
      detector = await createDetector(fileset, buffer, delegate);
    } else {
      throw err;
    }
  }

  active = { modeKey: choice.modeKey, delegate, detector };
  post('ready', readyPayload(choice, delegate));
}

function readyPayload(choice, delegate) {
  return {
    modeKey: choice.modeKey,
    modelId: choice.modelId,
    delegate,
    license: choice.license,
    commercial: choice.commercial,
  };
}

/* ==========================================================
   推論
   ========================================================== */
function clamp01(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

async function detectFaces({ bitmap, width, height, confidence, suppression }) {
  if (!active || !active.detector) {
    if (bitmap && bitmap.close) bitmap.close();
    throw new Error('モデルがまだ準備できていません。');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    if (bitmap && bitmap.close) bitmap.close();
    throw new Error(`画像寸法が不正です: ${width}×${height}`);
  }

  const minConfidence = clamp01(confidence, DEFAULT_CONFIDENCE);
  const minSuppression = clamp01(suppression, DEFAULT_SUPPRESSION);

  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let raw;
  try {
    await active.detector.setOptions({
      minDetectionConfidence: minConfidence,
      minSuppressionThreshold: minSuppression,
      runningMode: 'IMAGE',
    });
    raw = active.detector.detect(bitmap);
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }

  const detections = parseDetections(raw, width, height);
  post('detections', {
    width,
    height,
    detections,
    confidence: minConfidence,
    suppression: minSuppression,
    elapsedMs: Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    ),
  });
}

/* ==========================================================
   キャッシュ削除
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
      if (message.bitmap && message.bitmap.close) message.bitmap.close();
      post('error', { stage: 'process', error: '処理中です。完了までお待ちください。' });
      return;
    }
    busy = true;
    try {
      await detectFaces(message);
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
