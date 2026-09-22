/**
 * pipeline.mjs — アップスケール (超解像) の純粋ロジック
 *
 * DOM / WebGPU / Worker に依存しない。ブラウザでも Node でも同じように動く
 * 計算だけを置き、worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは worker.js が担当する:
 *   - Swin2SR       … Transformers.js v4 の `image-to-image` パイプライン
 *   - Real-ESRGAN   … onnxruntime-web を直接使う (任意エンジン)
 * ここにはモデル選択・タイル分割・重ね合わせ・表示ヘルパーなどの純関数を置く。
 *
 * 出典:
 *   https://huggingface.co/Xenova/swin2SR-classical-sr-x2-64
 *   https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr
 *   https://github.com/gqgs/upscalejs
 */

/* ==========================================================
   Transformers.js / ONNX Runtime
   ========================================================== */

export const TRANSFORMERS_VERSION = '4.2.0';
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/** Real-ESRGAN エンジン用の onnxruntime-web (Transformers.js 内蔵版は取り出せないため別途読み込む) */
export const ONNXRUNTIME_VERSION = '1.22.0';
export const ONNXRUNTIME_MODULE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_VERSION}/dist/ort.webgpu.min.mjs`;
export const ONNXRUNTIME_WASM_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_VERSION}/dist/`;

/** Transformers.js がモデルを保存する Cache Storage の既定プレフィックス */
export const CACHE_PREFIX = 'transformers-cache';

/* ==========================================================
   モデルカタログ
   ==========================================================
   ファイルサイズは 2026-09-22 時点の HuggingFace API (tree, 実バイト) の実測値。
   同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

const SWIN2SR_X2_FILES = Object.freeze({
  fp32: Object.freeze({ 'onnx/model.onnx': 54428699 }),
  fp16: Object.freeze({ 'onnx/model_fp16.onnx': 32428109 }),
  q8: Object.freeze({ 'onnx/model_quantized.onnx': 21471413 }),
  q4: Object.freeze({ 'onnx/model_q4.onnx': 23192795 }),
  q4f16: Object.freeze({ 'onnx/model_q4f16.onnx': 15612018 }),
});

const SWIN2SR_X4_FILES = Object.freeze({
  fp32: Object.freeze({ 'onnx/model.onnx': 52772645 }),
  fp16: Object.freeze({ 'onnx/model_fp16.onnx': 32357522 }),
  q8: Object.freeze({ 'onnx/model_quantized.onnx': 21438622 }),
  q4: Object.freeze({ 'onnx/model_q4.onnx': 23047336 }),
  q4f16: Object.freeze({ 'onnx/model_q4f16.onnx': 15541345 }),
});

export const MODEL_CATALOG = Object.freeze({
  'swin2sr-x2': Object.freeze({
    key: 'swin2sr-x2',
    label: 'Swin2SR 2x（汎用）',
    shortLabel: 'Swin2SR 2x',
    description: 'スクリーンショットや写真の 2 倍拡大。軽量で既定。',
    engine: 'transformers',
    task: 'image-to-image',
    modelId: 'Xenova/swin2SR-classical-sr-x2-64',
    scale: 2,
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/Xenova/swin2SR-classical-sr-x2-64',
    tile: Object.freeze({ size: 512, overlap: 32 }),
    files: SWIN2SR_X2_FILES,
    extraFiles: Object.freeze({ 'config.json': 825, 'preprocessor_config.json': 152 }),
    dtype: Object.freeze({ webgpu: 'fp16', wasm: 'q8' }),
  }),

  'swin2sr-x4': Object.freeze({
    key: 'swin2sr-x4',
    label: 'Swin2SR 4x（劣化に強い）',
    shortLabel: 'Swin2SR 4x',
    description: '圧縮ノイズのある実写向けの 4 倍拡大。real-world 系。',
    engine: 'transformers',
    task: 'image-to-image',
    modelId: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    scale: 4,
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    tile: Object.freeze({ size: 256, overlap: 16 }),
    files: SWIN2SR_X4_FILES,
    extraFiles: Object.freeze({ 'config.json': 837, 'preprocessor_config.json': 152 }),
    dtype: Object.freeze({ webgpu: 'fp16', wasm: 'q8' }),
  }),

  'realesrgan-anime-x4': Object.freeze({
    key: 'realesrgan-anime-x4',
    label: 'Real-ESRGAN 4x（イラスト）',
    shortLabel: 'Real-ESRGAN 4x',
    description: 'アニメ・イラスト・線画向けの 4 倍拡大。任意エンジン。',
    engine: 'ort',
    modelUrl:
      'https://huggingface.co/tidus2102/Real-ESRGAN/resolve/main/RealESR-AnimeVideo-v3_x4.onnx',
    scale: 4,
    license: 'BSD-3-Clause',
    commercial: true,
    homepage: 'https://huggingface.co/tidus2102/Real-ESRGAN',
    tile: Object.freeze({ size: 256, overlap: 16 }),
    files: Object.freeze({
      fp32: Object.freeze({ 'onnx/RealESR-AnimeVideo-v3_x4.onnx': 2495473 }),
    }),
    extraFiles: Object.freeze({}),
    dtype: Object.freeze({ webgpu: 'fp32', wasm: 'fp32' }),
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));
export const DEFAULT_MODE = 'swin2sr-x2';

/** 未知のキーは例外にする (無言のフォールバックを避ける) */
export function getModel(modeKey) {
  const model = MODEL_CATALOG[modeKey];
  if (!model) throw new Error(`未知のモデルです: ${modeKey}`);
  return model;
}

/** UI の選択肢を配列で返す */
export function listModels() {
  return MODEL_KEYS.map((key) => MODEL_CATALOG[key]);
}

/* ==========================================================
   バックエンド / dtype の決定
   ========================================================== */

/** WebGPU が使えるかどうかから実行デバイスを選ぶ */
export function detectDevice(hasWebGPU) {
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** モデル × デバイスで使う dtype を返す (ORT エンジンは常に fp32) */
export function resolveDtype(modeKey, device) {
  const model = getModel(modeKey);
  const dtype = model.dtype[device] || model.dtype.wasm || model.dtype.fp32;
  if (!model.files[dtype]) {
    throw new Error(`${modeKey} には dtype "${dtype}" の重みがありません`);
  }
  return dtype;
}

/** 初回ダウンロード量 (重み + config) をバイトで見積もる */
export function estimateModelBytes(modeKey, device) {
  const model = getModel(modeKey);
  const dtype = resolveDtype(modeKey, device);
  let total = 0;
  for (const size of Object.values(model.files[dtype])) total += size;
  for (const size of Object.values(model.extraFiles)) total += size;
  return total;
}

/**
 * モード × 実行環境から、実際に使うモデル・デバイス・dtype・タイル設定を決める。
 * worker.js と script.js の両方がこれを使い、表示と実推論を一致させる。
 */
export function chooseModel(modeKey, hasWebGPU) {
  const model = getModel(modeKey);
  const device = detectDevice(Boolean(hasWebGPU));
  const dtype = resolveDtype(model.key, device);
  return Object.freeze({
    modeKey: model.key,
    label: model.label,
    shortLabel: model.shortLabel,
    description: model.description,
    engine: model.engine,
    scale: model.scale,
    device,
    dtype,
    modelId: model.modelId || null,
    modelUrl: model.modelUrl || null,
    license: model.license,
    commercial: model.commercial,
    homepage: model.homepage,
    tile: model.tile,
    bytes: estimateModelBytes(model.key, device),
  });
}

/* ==========================================================
   タイル分割 / 重ね合わせ
   ==========================================================
   Transformer 系の超解像は巨大な画像を一度に処理するとメモリを
   大量に使う。入力をタイルに分け、縁を overlap だけ重ねて推論し、
   最後に重み付きで重ね合わせる (overlap-add / feather blending)。
   ========================================================== */

/** 出力の総画素数の上限。これを超える入力を弾いて OOM を防ぐ。 */
export const MAX_OUTPUT_PIXELS = 40000000;

/** 入力寸法と倍率から出力寸法を求める */
export function outputSize(width, height, scale) {
  assertPixels(width, height, '入力');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`不正な倍率です: ${scale}`);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function assertPixels(width, height, name) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${name}寸法が不正です: ${width}×${height}`);
  }
}

/** 出力が大きすぎないか確認する。超えていれば例外。 */
export function assertOutputFits(width, height, scale) {
  const out = outputSize(width, height, scale);
  const pixels = out.width * out.height;
  if (pixels > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `出力が大きすぎます (${out.width}×${out.height} = ${pixels.toLocaleString()} px)。` +
        `上限は ${MAX_OUTPUT_PIXELS.toLocaleString()} px です。`,
    );
  }
  return out;
}

/** 1 軸ぶんのタイル開始位置を重複なく昇順で返す */
export function axisStarts(length, tileSize, overlap) {
  if (!Number.isInteger(tileSize) || tileSize <= 0) throw new Error(`不正なタイルサイズです: ${tileSize}`);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= tileSize) {
    throw new Error(`不正なオーバーラップです: ${overlap}`);
  }
  if (length <= tileSize) return [0];
  const step = tileSize - overlap;
  const starts = [];
  for (let s = 0; s < length; s += step) {
    if (s + tileSize >= length) {
      const last = length - tileSize;
      if (starts[starts.length - 1] !== last) starts.push(last);
      break;
    }
    starts.push(s);
  }
  return starts;
}

/**
 * 入力画像をタイルに分割する。
 *
 * @param {number} width  入力幅 (px)
 * @param {number} height 入力高さ (px)
 * @param {{tileSize?: number, overlap?: number, scale?: number}} [options]
 * @returns {Array<{x:number,y:number,w:number,h:number,outX:number,outY:number,outW:number,outH:number,feather:number,hasLeft:boolean,hasRight:boolean,hasTop:boolean,hasBottom:boolean}>}
 */
export function computeTiles(width, height, options = {}) {
  assertPixels(width, height, '入力');
  const scale = options.scale ?? 1;
  const tileSize = Math.max(1, Math.round(options.tileSize ?? width));
  const overlap = Math.max(0, Math.round(options.overlap ?? 0));
  if (overlap >= tileSize) throw new Error('オーバーラップはタイルサイズより小さくしてください');

  const xs = axisStarts(width, tileSize, overlap);
  const ys = axisStarts(height, tileSize, overlap);
  const feather = Math.round(overlap * scale);
  const tiles = [];
  for (const y of ys) {
    for (const x of xs) {
      const w = Math.min(tileSize, width - x);
      const h = Math.min(tileSize, height - y);
      tiles.push({
        x,
        y,
        w,
        h,
        outX: x * scale,
        outY: y * scale,
        outW: w * scale,
        outH: h * scale,
        feather,
        hasLeft: x > 0,
        hasRight: x + w < width,
        hasTop: y > 0,
        hasBottom: y + h < height,
      });
    }
  }
  return tiles;
}

/** 出力タイル内の 1 軸方向の重み (0..1)。縁でフェザリングする。 */
function edgeWeight(pos, size, hasBefore, hasAfter, feather) {
  let w = 1;
  if (feather > 0) {
    if (hasBefore && pos < feather) w = Math.min(w, (pos + 0.5) / feather);
    if (hasAfter && size - 1 - pos < feather) w = Math.min(w, (size - 1 - pos + 0.5) / feather);
  }
  return w;
}

/** 3ch / 4ch のバイト列を RGBA に揃える (元は変更しない) */
export function toRgba(data, width, height) {
  const pixels = width * height;
  if (!data || typeof data.length !== 'number') throw new Error('画素データが不正です');
  if (data.length === pixels * 4) return new Uint8ClampedArray(data);
  if (data.length === pixels * 3) {
    const out = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i += 1) {
      out[i * 4] = data[i * 3];
      out[i * 4 + 1] = data[i * 3 + 1];
      out[i * 4 + 2] = data[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  throw new Error(`画素数が一致しません (${data.length} / ${pixels}px)`);
}

/**
 * タイル推論の結果を重み付きで重ね合わせ、1 枚の RGBA に合成する。
 *
 * @param {ReturnType<typeof computeTiles>} tiles
 * @param {Array<{data: Uint8ClampedArray|Uint8Array, width: number, height: number}>} outputs
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {Uint8ClampedArray} RGBA
 */
export function blendTiles(tiles, outputs, outWidth, outHeight) {
  if (!Array.isArray(tiles) || tiles.length === 0) throw new Error('タイルがありません');
  if (!Array.isArray(outputs) || outputs.length !== tiles.length) {
    throw new Error('タイル数と推論結果の数が一致しません');
  }
  assertPixels(outWidth, outHeight, '出力');

  // 1 枚だけならそのまま RGBA に整える
  if (tiles.length === 1) {
    const tile = tiles[0];
    const out = outputs[0];
    if (out.width !== tile.outW || out.height !== tile.outH) {
      throw new Error(`出力タイル寸法が想定と違います (${out.width}×${out.height})`);
    }
    return toRgba(out.data, out.width, out.height);
  }

  const acc = new Float32Array(outWidth * outHeight * 3);
  const weights = new Float32Array(outWidth * outHeight);

  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    const out = outputs[i];
    if (out.width !== tile.outW || out.height !== tile.outH) {
      throw new Error(`出力タイル寸法が想定と違います (${out.width}×${out.height})`);
    }
    const rgba = toRgba(out.data, out.width, out.height);
    for (let py = 0; py < out.height; py += 1) {
      const wy = edgeWeight(py, out.height, tile.hasTop, tile.hasBottom, tile.feather);
      const outY = tile.outY + py;
      for (let px = 0; px < out.width; px += 1) {
        const wx = edgeWeight(px, out.width, tile.hasLeft, tile.hasRight, tile.feather);
        const w = wx * wy;
        const si = (py * out.width + px) * 4;
        const di = outY * outWidth + tile.outX + px;
        acc[di * 3] += rgba[si] * w;
        acc[di * 3 + 1] += rgba[si + 1] * w;
        acc[di * 3 + 2] += rgba[si + 2] * w;
        weights[di] += w;
      }
    }
  }

  const result = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    const di = i * 4;
    if (w > 1e-6) {
      result[di] = acc[i * 3] / w;
      result[di + 1] = acc[i * 3 + 1] / w;
      result[di + 2] = acc[i * 3 + 2] / w;
    }
    result[di + 3] = 255;
  }
  return result;
}

/** タイル分割が必要かどうか */
export function needsTiling(width, height, tile) {
  return Boolean(tile) && (width > tile.size || height > tile.size);
}

/* ==========================================================
   表示ヘルパー
   ========================================================== */

/** バイト数を人が読める表記にする (1024 基準) */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const kib = bytes / 1024;
  if (kib < 1) return `${bytes} B`;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

/* ==========================================================
   ファイル名
   ========================================================== */

/** 元ファイル名から安全なベース名を作る (拡張子とパスを除去) */
export function sanitizeBaseName(name) {
  const base = String(name ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '');
  const safe = base
    .replace(/[^0-9A-Za-z_\-\.]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '');
  return safe.slice(0, 60) || 'image';
}

/** ダウンロードファイル名を作る */
export function buildDownloadName(originalName, scale) {
  const suffix = Number.isFinite(scale) && scale > 0 ? `${Math.round(scale)}x` : 'upscaled';
  return `${sanitizeBaseName(originalName)}-${suffix}.png`;
}

/* ==========================================================
   入力画像の判定
   ========================================================== */

const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
]);

/** data:URL も含め、このアプリが読める画像形式かどうか */
export function isSupportedImageType(type) {
  return typeof type === 'string' && SUPPORTED_IMAGE_TYPES.includes(type.toLowerCase());
}

/** 拡張子から画像らしさを判定する (MIME が空のドロップ対策) */
export function hasImageExtension(name) {
  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(name ?? ''));
}

/**
 * File / Blob 風オブジェクトが処理対象にできるか。
 * @param {{type?: string, name?: string}} file
 */
export function isSupportedImage(file) {
  if (!file) return false;
  return isSupportedImageType(file.type) || hasImageExtension(file.name);
}
