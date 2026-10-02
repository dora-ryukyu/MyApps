/**
 * worker.js — アップスケール (超解像) の推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * エンジン:
 *   - transformers … Transformers.js v4 の `image-to-image` パイプライン (Swin2SR)
 *   - ort          … onnxruntime-web を直接使う (Real-ESRGAN)
 *
 * 大きい画像は pipeline.mjs の computeTiles / blendTiles で
 * タイル分割 → overlap-add 合成する。
 *
 * 画像の読み込み (デコード) はメインスレッドで済ませ、ここでは生の RGBA
 * バイト列を受け取って処理する。
 */

import {
  TRANSFORMERS_MODULE_URL,
  ONNXRUNTIME_MODULE_URL,
  ONNXRUNTIME_WASM_PATH,
  CACHE_PREFIX,
  getModel,
  chooseModel,
  computeTiles,
  blendTiles,
  assertOutputFits,
  toRgba,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let ort = null;
let backend = 'wasm';
let fp16 = false;
let backendDetected = false;
let active = null; // { engine, scale, tile, modelId, modelUrl, device, dtype, pipe? , session?, inputName?, outputName? }
let busy = false;

function post(type, payload = {}, transfer) {
  self.postMessage({ type, ...payload }, transfer || []);
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (bg-remove / voice-transcriber と同じ方式)
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
   onnxruntime-web (Real-ESRGAN)
   ========================================================== */
async function loadOrt() {
  if (ort) return ort;
  status('library', 'ONNX Runtime を読み込み中…');
  const mod = await import(/* @vite-ignore */ ONNXRUNTIME_MODULE_URL);
  ort = mod.default && mod.default.InferenceSession ? mod.default : mod;
  try {
    if (ort.env && ort.env.wasm) {
      ort.env.wasm.wasmPaths = ONNXRUNTIME_WASM_PATH;
      ort.env.wasm.numThreads = 1;
    }
    if (ort.env) ort.env.logLevel = 'error';
  } catch {
    /* 環境によっては存在しない */
  }
  return ort;
}

/** Cache Storage 経由でモデルを取得する (2 回目以降は再ダウンロードしない) */
async function fetchModelBytes(url) {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_PREFIX);
      const cached = await cache.match(url);
      if (cached) {
        post('status', { stage: 'model', message: 'キャッシュからモデルを読み込み中…' });
        return new Uint8Array(await cached.arrayBuffer());
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`モデルの取得に失敗しました (HTTP ${response.status})`);
      cache.put(url, response.clone()).catch(() => {
        /* キャッシュ不可でも続行する */
      });
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      console.warn('キャッシュ経由の取得に失敗、直接取得します:', err);
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`モデルの取得に失敗しました (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
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

  const model = getModel(choice.modeKey);
  status('model', `${model.label} を読み込み中…`);

  if (choice.engine === 'ort') {
    await loadOrt();
    const bytes = await fetchModelBytes(choice.modelUrl);
    const executionProviders = backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const fixedTile = ortFixedTile(session, inputName);
    // モデルが固定寸法を要求する場合は、そのサイズでタイルを切る
    const effectiveTile = fixedTile
      ? { size: Math.min(fixedTile.width, fixedTile.height), overlap: choice.tile.overlap }
      : choice.tile;
    active = {
      ...choice,
      tile: effectiveTile,
      backend,
      kind: 'ort',
      session,
      inputName,
      outputName,
      fixedTile,
    };
  } else {
    await loadTransformers();
    const pipe = await tf.pipeline(choice.task, choice.modelId, {
      device: choice.device,
      dtype: choice.dtype,
      progress_callback: makeProgressCallback(),
    });
    active = { ...choice, backend, kind: 'transformers', pipe };
  }

  post('ready', readyPayload(choice));
  return choice;
}

/** ORT セッションの入力が固定寸法なら、そのタイルサイズを返す (動的なら null) */
function ortFixedTile(session, inputName) {
  try {
    const meta = session.inputMetadata && session.inputMetadata[inputName];
    const dims = meta && meta.dimensions;
    if (!Array.isArray(dims)) return null;
    const h = dims[dims.length - 2];
    const w = dims[dims.length - 1];
    if (Number.isInteger(h) && Number.isInteger(w) && h > 0 && w > 0) return { width: w, height: h };
  } catch {
    /* メタデータが取れない環境では動的扱い */
  }
  return null;
}

function readyPayload(choice) {
  return {
    modeKey: choice.modeKey,
    engine: choice.engine,
    scale: choice.scale,
    device: choice.device,
    dtype: choice.dtype,
    backend,
    fp16,
    license: choice.license,
    commercial: choice.commercial,
  };
}

/* ==========================================================
   タイル処理
   ========================================================== */
function cropRgba(source, sourceWidth, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let py = 0; py < h; py += 1) {
    const srcRow = (y + py) * sourceWidth + x;
    const dstRow = py * w;
    for (let px = 0; px < w; px += 1) {
      const si = (srcRow + px) * 4;
      const di = (dstRow + px) * 4;
      out[di] = source[si];
      out[di + 1] = source[si + 1];
      out[di + 2] = source[si + 2];
      out[di + 3] = source[si + 3];
    }
  }
  return out;
}

/** Transformers.js の image-to-image パイプラインで 1 タイル推論する */
async function runTransformersTile(tileRgba, w, h) {
  const image = new tf.RawImage(tileRgba, w, h, 4);
  const result = await active.pipe(image);
  const out = Array.isArray(result) ? result[0] : result;
  if (!out || !out.data) throw new Error('推論結果が空でした。');
  return { data: out.data, width: out.width, height: out.height };
}

/** onnxruntime-web で 1 タイル推論する (Real-ESRGAN) */
async function runOrtTile(tileRgba, w, h) {
  const fixed = active.fixedTile;
  const targetW = fixed ? fixed.width : alignUp(w, 4);
  const targetH = fixed ? fixed.height : alignUp(h, 4);
  const planes = 3 * targetH * targetW;
  const input = new Float32Array(planes);

  // NHWC(RGBA) → NCHW(float, 0..1)。はみ出した領域は端の画素で埋める。
  for (let y = 0; y < targetH; y += 1) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < targetW; x += 1) {
      const sx = Math.min(x, w - 1);
      const si = (sy * w + sx) * 4;
      const offset = y * targetW + x;
      input[offset] = tileRgba[si] / 255;
      input[targetH * targetW + offset] = tileRgba[si + 1] / 255;
      input[2 * targetH * targetW + offset] = tileRgba[si + 2] / 255;
    }
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, targetH, targetW]);
  const outputs = await active.session.run({ [active.inputName]: tensor });
  const result = outputs[active.outputName];

  const dims = result.dims;
  const outH = dims[dims.length - 2];
  const outW = dims[dims.length - 1];
  const scaleX = outW / targetW;
  const scaleY = outH / targetH;
  const cropW = Math.max(1, Math.round(w * scaleX));
  const cropH = Math.max(1, Math.round(h * scaleY));

  const raw = result.data;
  const isByte = raw instanceof Uint8Array || raw instanceof Uint8ClampedArray;
  const plane = outH * outW;
  const rgba = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y += 1) {
    for (let x = 0; x < cropW; x += 1) {
      const px = y * outW + x;
      const di = (y * cropW + x) * 4;
      const r = raw[px];
      const g = raw[plane + px];
      const b = raw[2 * plane + px];
      rgba[di] = isByte ? r : r * 255;
      rgba[di + 1] = isByte ? g : g * 255;
      rgba[di + 2] = isByte ? b : b * 255;
      rgba[di + 3] = 255;
    }
  }
  return { data: rgba, width: cropW, height: cropH };
}

function alignUp(value, multiple) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

/** ニアレストで RGBA を目的寸法に合わせる (パイプライン出力の端数対策) */
function fitRgba(rgba, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return rgba;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/** 推論結果を RGBA に揃え、タイルが期待する出力寸法に合わせる */
function normalizeTileOutput(result, tile) {
  const rgba = toRgba(result.data, result.width, result.height);
  return {
    data: fitRgba(rgba, result.width, result.height, tile.outW, tile.outH),
    width: tile.outW,
    height: tile.outH,
  };
}

async function processImage({ width, height, data }) {
  if (!active) throw new Error('モデルがまだ準備できていません。');

  const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  const expected = width * height * 4;
  if (pixels.length < expected) {
    throw new Error(`RGBA データが不足しています (${pixels.length} < ${expected})`);
  }

  const scale = active.scale;
  const out = assertOutputFits(width, height, scale);
  const tile = active.tile || { size: Math.max(width, height), overlap: 0 };
  const tiles = computeTiles(width, height, {
    tileSize: tile.size,
    overlap: tile.overlap,
    scale,
  });

  status('process', `${tiles.length > 1 ? `タイル分割 ${tiles.length} 枚を推論中` : '推論中'}… (${backend})`);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const outputs = [];
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    const tileRgba = cropRgba(pixels, width, t.x, t.y, t.w, t.h);
    const raw =
      active.kind === 'ort'
        ? await runOrtTile(tileRgba, t.w, t.h)
        : await runTransformersTile(tileRgba, t.w, t.h);
    outputs.push(normalizeTileOutput(raw, t));
    post('progress', { stage: 'process', done: i + 1, total: tiles.length });
  }

  const blended = blendTiles(tiles, outputs, out.width, out.height);
  const buffer =
    blended.byteOffset === 0 && blended.byteLength === blended.buffer.byteLength
      ? blended.buffer
      : blended.slice().buffer;

  post(
    'result',
    {
      width: out.width,
      height: out.height,
      channels: 4,
      tiles: tiles.length,
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
      await loadModel(message.modeKey);
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
