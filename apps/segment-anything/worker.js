/**
 * worker.js — インタラクティブ画像セグメンテーション (SAM) の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * エンジン: Transformers.js v4 の `SamModel` + `AutoProcessor`。
 * `mask-generation` は Transformers.js にパイプラインが無いため、
 * 公式 Space と同じ手順で直接呼ぶ:
 *   1. processor(image) で前処理し、get_image_embeddings で埋め込みを作る
 *   2. 点/矩形プロンプトから input_points / input_labels の Tensor を作る
 *   3. model(...) を実行し pred_masks / iou_scores を得る
 *   4. post_process_masks で元画像サイズへ戻し、候補マスクを 0/1 平面に分解する
 *
 * 画像のデコードはメインスレッドで済ませ、ここでは生の RGBA バイト列を受け取る。
 */

import {
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  chooseModel,
  buildPrompt,
  extractMaskPlanes,
  selectBestMask,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let backend = 'wasm';
let fp16 = false;
let backendDetected = false;
let active = null; // { modeKey, device, dtype, backend, model, processor }
let imageProcessed = null;
let imageEmbeddings = null;
let imageSize = null; // { width, height }
let reshapedSize = null; // { width, height } モデル入力の寸法
let busy = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (object-detector / bg-remove と同じ方式)
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

/** 進捗コールバック。from_pretrained は progress_total も流してくれる。 */
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
  imageProcessed = null;
  imageEmbeddings = null;

  status('model', `${choice.shortLabel} を読み込み中…`);
  await loadTransformers();
  const options = {
    device: choice.device,
    dtype: choice.dtype,
    progress_callback: makeProgressCallback(),
  };
  const model = await tf.SamModel.from_pretrained(choice.modelId, options);
  const processor = await tf.AutoProcessor.from_pretrained(choice.modelId, options);
  active = {
    modeKey: choice.modeKey,
    device: choice.device,
    dtype: choice.dtype,
    backend,
    model,
    processor,
  };

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
   画像の埋め込み (encode)
   ========================================================== */
async function encodeImage({ width, height, data }) {
  if (!active) throw new Error('モデルがまだ準備できていません。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`画像寸法が不正です: ${width}×${height}`);
  }
  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  if (pixels.length < width * height * 4) {
    throw new Error(`RGBA データが不足しています (${pixels.length} < ${width * height * 4})`);
  }

  status('encode', `画像を解析中… (${backend})`);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const image = new tf.RawImage(pixels, width, height, 4);
  imageProcessed = await active.processor(image);
  imageEmbeddings = await active.model.get_image_embeddings(imageProcessed);
  imageSize = { width, height };

  const reshaped = imageProcessed.reshaped_input_sizes[0];
  // HeightWidth は [height, width] の順
  reshapedSize = { width: reshaped[1], height: reshaped[0] };

  post('encoded', {
    width,
    height,
    reshapedWidth: reshapedSize.width,
    reshapedHeight: reshapedSize.height,
    elapsedMs: Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    ),
  });
}

/* ==========================================================
   プロンプトからのマスク生成
   ========================================================== */
function toTensorData(values, type) {
  if (type === 'int64') return values.map((value) => BigInt(value));
  return values.map((value) => Number(value));
}

/** ネストした post_process 結果から最初のマスク Tensor を取り出す */
function pickMaskTensor(result) {
  let node = result;
  while (Array.isArray(node)) node = node[0];
  return node;
}

async function generateMask({ points, boxes, referenceIndex }) {
  if (!active) throw new Error('モデルがまだ準備できていません。');
  if (!imageEmbeddings || !imageProcessed) {
    throw new Error('先に画像を解析してください。');
  }

  const prompt = buildPrompt({ points, boxes, reshapedSize });
  const feeds = {
    ...imageEmbeddings,
    input_points: new tf.Tensor('float32', toTensorData(prompt.inputPoints.data), prompt.inputPoints.dims),
    input_labels: new tf.Tensor('int64', toTensorData(prompt.inputLabels.data, 'int64'), prompt.inputLabels.dims),
  };

  status('process', `セグメンテーション中… (${backend})`);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  // input_boxes を受け付ける実装なら使う。失敗したら点 (label 2/3) のみで再試行する。
  let outputs = null;
  if (prompt.inputBoxes) {
    try {
      const withBoxes = {
        ...feeds,
        input_boxes: new tf.Tensor('float32', toTensorData(prompt.inputBoxes.data), prompt.inputBoxes.dims),
      };
      outputs = await active.model(withBoxes);
    } catch (err) {
      console.warn('input_boxes 経路に失敗したため点プロンプトで再試行します:', err);
      outputs = null;
    }
  }
  if (!outputs) outputs = await active.model(feeds);

  const processed = await active.processor.post_process_masks(
    outputs.pred_masks,
    imageProcessed.original_sizes,
    imageProcessed.reshaped_input_sizes,
  );
  const rawMask = tf.RawImage.fromTensor(pickMaskTensor(processed));
  const planes = extractMaskPlanes(rawMask);
  const scores = Array.from(outputs.iou_scores.data, (value) => Number(value));
  const chosen = selectBestMask(planes, scores);

  const transfer = planes.map((plane) => plane.buffer);
  post(
    'mask',
    {
      width: imageSize.width,
      height: imageSize.height,
      planes,
      scores,
      index: chosen.index,
      score: chosen.score,
      referenceIndex: Number.isInteger(referenceIndex) ? referenceIndex : null,
      elapsedMs: Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
      ),
    },
    transfer,
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
      await loadModel(message.modeKey);
    } catch (err) {
      console.error(err);
      post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'encode') {
    if (busy) {
      post('error', { stage: 'encode', error: '処理中です。完了までお待ちください。' });
      return;
    }
    busy = true;
    try {
      await encodeImage(message);
    } catch (err) {
      console.error(err);
      post('error', { stage: 'encode', error: err && err.message ? err.message : String(err) });
    } finally {
      busy = false;
    }
    return;
  }

  if (type === 'segment') {
    if (busy) {
      post('error', { stage: 'process', error: '処理中です。完了までお待ちください。' });
      return;
    }
    busy = true;
    try {
      await generateMask(message);
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
