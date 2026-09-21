/**
 * pipeline.mjs — 背景除去の純粋ロジック
 *
 * このファイルは DOM / WebGPU / Worker に依存しない。
 * 「ブラウザでも Node でも同じように動く計算」だけを置き、
 * worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは Transformers.js v4 の `background-removal` パイプラインに任せる
 * (worker.js)。ここにはモデル選択・サイズ見積り・合成などの純関数を置く。
 *
 * 出典:
 *   https://github.com/huggingface/transformers.js/pull/1216
 *   https://huggingface.co/Xenova/modnet
 *   https://huggingface.co/briaai/RMBG-1.4
 */

/* ==========================================================
   Transformers.js
   ========================================================== */

export const TRANSFORMERS_VERSION = '4.2.0';
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/** Transformers.js がモデルを保存する Cache Storage の既定プレフィックス */
export const CACHE_PREFIX = 'transformers-cache';

/* ==========================================================
   モデルカタログ
   ==========================================================
   ファイルサイズは 2026-09-21 時点の HuggingFace API (blobs=true) の実測値。
   同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

export const MODEL_CATALOG = Object.freeze({
  modnet: Object.freeze({
    key: 'modnet',
    modelId: 'Xenova/modnet',
    label: 'MODNet（人物向け）',
    description: '人物の切り抜きに最適化された軽量マッティングモデル。',
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/Xenova/modnet',
    /** dtype ごとの重みファイルと実バイト数 */
    files: Object.freeze({
      fp32: Object.freeze({ 'onnx/model.onnx': 25888640 }),
      fp16: Object.freeze({ 'onnx/model_fp16.onnx': 12984781 }),
      q8: Object.freeze({ 'onnx/model_quantized.onnx': 6632188 }),
    }),
    extraFiles: Object.freeze({ 'config.json': 83, 'preprocessor_config.json': 365 }),
    /** 実行環境ごとの既定 dtype。MODNet はモデルカードの例と同じ fp32 を使う。 */
    dtype: Object.freeze({ webgpu: 'fp32', wasm: 'fp32' }),
  }),

  rmbg: Object.freeze({
    key: 'rmbg',
    modelId: 'briaai/RMBG-1.4',
    label: 'RMBG-1.4（汎用）',
    description: '人物以外（ペット・商品・家具など）にも対応する汎用セグメンテーション。',
    license: 'bria-rmbg-1.4（非商用）',
    commercial: false,
    homepage: 'https://huggingface.co/briaai/RMBG-1.4',
    files: Object.freeze({
      q8: Object.freeze({ 'onnx/model_quantized.onnx': 44403226 }),
      fp16: Object.freeze({ 'onnx/model_fp16.onnx': 88217533 }),
      fp32: Object.freeze({ 'onnx/model.onnx': 176153355 }),
    }),
    extraFiles: Object.freeze({ 'config.json': 548, 'preprocessor_config.json': 345 }),
    dtype: Object.freeze({ webgpu: 'q8', wasm: 'q8' }),
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));

/**
 * 被写体の種類。UI の選択肢とモデルの対応。
 * 既定は人物 (MODNet)。RMBG は人物以外向けの任意選択。
 */
export const SUBJECTS = Object.freeze([
  Object.freeze({
    key: 'person',
    label: '人物',
    description: '人・集合写真・ポートレート',
    modelKey: 'modnet',
  }),
  Object.freeze({
    key: 'general',
    label: '人物以外（汎用）',
    description: 'ペット・商品・家具・ロゴなど',
    modelKey: 'rmbg',
  }),
]);

export const DEFAULT_SUBJECT = 'person';

/** 未知のキーは例外にする (無言のフォールバックを避ける) */
export function getModel(modelKey) {
  const model = MODEL_CATALOG[modelKey];
  if (!model) throw new Error(`未知のモデルです: ${modelKey}`);
  return model;
}

/** 被写体キーから定義を返す。未知なら既定 (人物) にフォールバック。 */
export function getSubject(subjectKey) {
  return SUBJECTS.find((s) => s.key === subjectKey) || SUBJECTS.find((s) => s.key === DEFAULT_SUBJECT);
}

/* ==========================================================
   バックエンド / dtype の決定
   ========================================================== */

/** WebGPU が使えるかどうかから実行デバイスを選ぶ */
export function detectDevice(hasWebGPU) {
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** モデル × デバイスで使う dtype を返す */
export function resolveDtype(modelKey, device) {
  const model = getModel(modelKey);
  const dtype = model.dtype[device] || model.dtype.wasm || model.dtype.fp32;
  if (!model.files[dtype]) {
    throw new Error(`${modelKey} には dtype "${dtype}" の重みがありません`);
  }
  return dtype;
}

/** 初回ダウンロード量 (重み + config) をバイトで見積もる */
export function estimateModelBytes(modelKey, device) {
  const model = getModel(modelKey);
  const dtype = resolveDtype(modelKey, device);
  let total = 0;
  for (const size of Object.values(model.files[dtype])) total += size;
  for (const size of Object.values(model.extraFiles)) total += size;
  return total;
}

/**
 * 被写体 × 実行環境から、実際に使うモデル・デバイス・dtype を決める。
 * worker.js と script.js の両方がこれを使い、表示と実推論を一致させる。
 */
export function chooseModel(subjectKey, hasWebGPU) {
  const subject = getSubject(subjectKey);
  const model = getModel(subject.modelKey);
  const device = detectDevice(Boolean(hasWebGPU));
  const dtype = resolveDtype(model.key, device);
  return Object.freeze({
    subjectKey: subject.key,
    subjectLabel: subject.label,
    modelKey: model.key,
    modelId: model.modelId,
    device,
    dtype,
    label: model.label,
    license: model.license,
    commercial: model.commercial,
    homepage: model.homepage,
    bytes: estimateModelBytes(model.key, device),
  });
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
   色
   ========================================================== */

/** #rgb / #rrggbb を {r,g,b} に変換する */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') throw new TypeError('色は文字列で指定してください');
  let body = hex.trim().replace(/^#/, '');
  if (body.length === 3) {
    body = body
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(body)) throw new Error(`不正な色指定です: ${hex}`);
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

/** {r,g,b} または色文字列を {r,g,b} に正規化する */
export function normalizeRgb(color) {
  if (color && typeof color === 'object' && 'r' in color && 'g' in color && 'b' in color) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    return { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b) };
  }
  return hexToRgb(color);
}

/* ==========================================================
   合成 (前景のアルファで背景に重ねる)
   ========================================================== */

function assertRgba(rgba, name) {
  if (!rgba || typeof rgba.length !== 'number' || rgba.length % 4 !== 0) {
    throw new Error(`${name} は RGBA のバイト列である必要があります`);
  }
}

/**
 * 背景を単色で塗り、前景をアルファ合成する。
 * 出力は不透明 (alpha=255) の RGBA。
 */
export function composeOnColor(rgba, color) {
  assertRgba(rgba, '前景');
  const { r, g, b } = normalizeRgb(color);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    const inv = 1 - a;
    out[i] = rgba[i] * a + r * inv;
    out[i + 1] = rgba[i + 1] * a + g * inv;
    out[i + 2] = rgba[i + 2] * a + b * inv;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * 背景画像 (同じ寸法の RGBA) に前景をアルファ合成する。
 * 出力は不透明 (alpha=255) の RGBA。
 */
export function composeOnBackground(rgba, background) {
  assertRgba(rgba, '前景');
  assertRgba(background, '背景');
  if (rgba.length !== background.length) {
    throw new Error('前景と背景の画素数が一致しません');
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    const inv = 1 - a;
    out[i] = rgba[i] * a + background[i] * inv;
    out[i + 1] = rgba[i + 1] * a + background[i + 1] * inv;
    out[i + 2] = rgba[i + 2] * a + background[i + 2] * inv;
    out[i + 3] = 255;
  }
  return out;
}

/** 前景をそのまま複製する (透過 PNG 用) */
export function keepTransparent(rgba) {
  assertRgba(rgba, '前景');
  return new Uint8ClampedArray(rgba);
}

export const BACKGROUND_MODES = Object.freeze([
  Object.freeze({ key: 'transparent', label: '透過のまま' }),
  Object.freeze({ key: 'color', label: '単色' }),
  Object.freeze({ key: 'image', label: '画像' }),
]);

/**
 * 合成モードに応じて出力 RGBA を作る。
 * @param {Uint8ClampedArray} rgba 前景 (背景除去済み, alpha 付き)
 * @param {'transparent'|'color'|'image'} mode
 * @param {{color?: string|{r:number,g:number,b:number}, background?: Uint8ClampedArray}} [options]
 */
export function compose(rgba, mode, options = {}) {
  switch (mode) {
    case 'transparent':
      return keepTransparent(rgba);
    case 'color':
      return composeOnColor(rgba, options.color);
    case 'image':
      return composeOnBackground(rgba, options.background);
    default:
      throw new Error(`未知の合成モードです: ${mode}`);
  }
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
export function buildDownloadName(originalName, mode) {
  const suffix = mode === 'transparent' ? 'nobg' : 'composite';
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
