/**
 * pipeline.mjs — NanoDiffuser 推論パイプラインの純粋ロジック
 *
 * このファイルは DOM / WebGPU / Worker に依存しない。
 * 「ブラウザでも Node でも同じように動く計算」だけを置き、
 * worker.js からも test/ からも import される。
 *
 * パイプラインの仕様はモデルカード (utkucoban/NanoDiffuser) に準拠:
 *   1. CLIP tokenizer でプロンプトを 77 トークンに揃える (INT32)
 *   2. シード付きガウスノイズ [1,4,64,64] を生成
 *   3. one-step U-Net (timestep 999) を 1 回だけ実行
 *   4. DEIS の 1-step 係数で latent を更新
 *   5. TAESD (AutoencoderTiny) で 512x512 にデコード
 *
 * 出典: https://huggingface.co/utkucoban/NanoDiffuser
 */

/* ==========================================================
   モデル / CDN の固定情報
   ========================================================== */

export const MODEL_ID = 'utkucoban/NanoDiffuser';
export const MODEL_REVISION = 'main';
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`;
export const MANIFEST_URL = `${MODEL_BASE_URL}/manifest.json`;

/**
 * CLIP tokenizer。
 * NanoDiffuser 同梱の tokenizer は `tokenizer/` サブフォルダにあり、
 * Transformers.js 4.2.0 の `subfolder` では読み込めないことを実機確認済み
 * (2026-09-17, `Cannot read properties of undefined (reading 'tokenizer_class')`)。
 * CLIP のトークナイザは共用なので、動作確認済みの標準 CLIP トークナイザを使う。
 */
export const TOKENIZER_ID = 'Xenova/clip-vit-base-patch32';
/** モデル同梱 tokenizer のサブフォルダ (上の読み込みに失敗した場合の保険) */
export const MODEL_TOKENIZER_SUBFOLDER = 'tokenizer';

export const ORT_VERSION = '1.29.0';
export const TRANSFORMERS_VERSION = '4.2.0';
export const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_MODULE_URL = `${ORT_CDN_BASE}ort.webgpu.min.mjs`;
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/**
 * manifest.json が取得できない場合に使う既定値。
 * 値は 2026-09-17 時点の NanoDiffuser の公開 manifest と一致する。
 */
export const DEFAULT_MANIFEST = Object.freeze({
  format: 'sdxs-webgpu-v1',
  modelId: 'IDKiro/sdxs-512-dreamshaper',
  width: 512,
  height: 512,
  latentShape: [1, 4, 64, 64],
  maxPromptTokens: 77,
  models: {
    textEncoder: 'text_encoder_q4.onnx',
    unet: 'unet_mixed_q4q8.onnx',
    decoder: 'vae_decoder_fp16.onnx',
  },
  scheduler: {
    timestep: 999.0,
    initNoiseSigma: 1.0,
    modelInputScale: 1.0,
    sampleCoefficient: 14.642590522766113,
    outputCoefficient: -14.579278945922852,
  },
});

/**
 * モデル資産のバイト数 (2026-09-17 時点、HF のファイルツリーより)。
 * 進捗バーの分母と切り詰め検出にだけ使う。実ファイルが大きい分には問題ない。
 */
export const MODEL_FILE_SIZES = Object.freeze({
  'text_encoder_q4.onnx': 165192,
  'text_encoder_q4.onnx.data': 66276792,
  'unet_mixed_q4q8.onnx': 58597136,
  'unet_mixed_q4q8.onnx.data': 269300480,
  'vae_decoder_fp16.onnx': 29879,
  'vae_decoder_fp16.onnx.data': 2441088,
});

export function modelFileUrl(name) {
  return `${MODEL_BASE_URL}/${name}`;
}

/* ==========================================================
   manifest の検証
   ========================================================== */

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('manifest.json の形式が不正です');
  }
  const m = {
    ...DEFAULT_MANIFEST,
    ...raw,
    models: { ...DEFAULT_MANIFEST.models, ...(raw.models || {}) },
    scheduler: { ...DEFAULT_MANIFEST.scheduler, ...(raw.scheduler || {}) },
  };
  if (!isPositiveInt(m.width) || !isPositiveInt(m.height)) {
    throw new Error('manifest.json: width/height が不正です');
  }
  if (!Array.isArray(m.latentShape) || m.latentShape.length !== 4) {
    throw new Error('manifest.json: latentShape が不正です');
  }
  if (!isPositiveInt(m.maxPromptTokens)) {
    throw new Error('manifest.json: maxPromptTokens が不正です');
  }
  for (const key of ['textEncoder', 'unet', 'decoder']) {
    if (typeof m.models[key] !== 'string' || m.models[key].length === 0) {
      throw new Error(`manifest.json: models.${key} が不正です`);
    }
  }
  for (const key of ['timestep', 'initNoiseSigma', 'modelInputScale', 'sampleCoefficient', 'outputCoefficient']) {
    if (typeof m.scheduler[key] !== 'number' || !Number.isFinite(m.scheduler[key])) {
      throw new Error(`manifest.json: scheduler.${key} が不正です`);
    }
  }
  return m;
}

/** 3 つの ONNX グラフと、その外部重みファイルの一覧を返す */
export function modelFilesFromManifest(manifest) {
  const names = [manifest.models.textEncoder, manifest.models.unet, manifest.models.decoder];
  return names.map((name) => ({
    name,
    url: modelFileUrl(name),
    externalDataName: `${name}.data`,
    externalDataUrl: modelFileUrl(`${name}.data`),
  }));
}

/** 外部重みの "location" 文字列として試す候補 (グラフ側の表記ゆれに備える) */
export function externalDataPathCandidates(name) {
  const base = name.replace(/\.onnx$/, '');
  const candidates = [
    `${name}.data`,
    `./${name}.data`,
    `${base}.onnx_data`,
    `./${base}.onnx_data`,
    name,
    `./${name}`,
    `${base}.data`,
    `./${base}.data`,
  ];
  return [...new Set(candidates)];
}

/** キャッシュ名に埋め込む短い revision。manifest が変わったら別キャッシュになる。 */
export function cacheRevision(manifest) {
  const relevant = {
    format: manifest?.format,
    width: manifest?.width,
    height: manifest?.height,
    latentShape: manifest?.latentShape,
    models: manifest?.models,
    scheduler: manifest?.scheduler,
  };
  return hashString(JSON.stringify(relevant));
}

/** FNV-1a 32bit。暗号用途ではなくキャッシュのバージョニング用途。 */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ==========================================================
   乱数 (シード付き) とノイズ
   ========================================================== */

/** mulberry32: 32bit シードの決定的 PRNG (返り値は [0,1)) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller で標準正規乱数を length 個生成する */
export function gaussianNoise(seed, length) {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('length は 0 以上の整数である必要があります');
  }
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 2) {
    let u1 = rand();
    if (u1 <= Number.MIN_VALUE) u1 = Number.MIN_VALUE; // log(0) 回避
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    out[i] = r * Math.cos(theta);
    if (i + 1 < length) out[i + 1] = r * Math.sin(theta);
  }
  return out;
}

export function shapeSize(shape) {
  return shape.reduce((acc, d) => acc * d, 1);
}

/** 初期 latent = ガウスノイズ × initNoiseSigma */
export function createInitialLatent(seed, latentShape, initNoiseSigma = 1) {
  const latent = gaussianNoise(seed, shapeSize(latentShape));
  if (initNoiseSigma !== 1) {
    for (let i = 0; i < latent.length; i++) latent[i] *= initNoiseSigma;
  }
  return latent;
}

/** DEIS 1-step: denoised = sampleCoeff * initialLatent + outputCoeff * noisePrediction */
export function denoiseStep(initialLatent, noisePrediction, sampleCoefficient, outputCoefficient) {
  if (initialLatent.length !== noisePrediction.length) {
    throw new Error(
      `latent と予測のサイズが一致しません (${initialLatent.length} vs ${noisePrediction.length})`,
    );
  }
  const out = new Float32Array(initialLatent.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = sampleCoefficient * initialLatent[i] + outputCoefficient * noisePrediction[i];
  }
  return out;
}

/* ==========================================================
   float16 <-> float32
   ONNX Runtime Web の float16 Tensor は Uint16Array (生ビット) を受け付ける。
   Float16Array が使える環境でも Uint16Array を渡せば内部で変換される。
   ========================================================== */

const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);

/** float32 の値を IEEE754 half のビット列 (uint16) に変換する */
export function floatToHalf(value) {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 0x7e00;
    return value > 0 ? 0x7c00 : 0xfc00;
  }
  _f32[0] = value;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;

  if (e < 103) return bits; // アンダーフロー → ±0
  if (e > 142) {
    bits |= 0x7c00; // inf
    const mantissa = x & 0x007fffff;
    if (e === 255 && mantissa !== 0) bits |= 0x0200; // NaN
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

export function float32ToFloat16Array(input) {
  const out = new Uint16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = floatToHalf(input[i]);
  return out;
}

/** IEEE754 half のビット列 (uint16) を float32 の値に戻す */
export function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

export function float16ArrayToFloat32(input) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = halfToFloat(input[i]);
  return out;
}

/**
 * ORT Tensor の data を float32 に正規化する。
 * - float32: そのまま
 * - float16: Uint16Array (生ビット) または Float16Array (数値) の両対応
 */
export function tensorDataToFloat32(type, data) {
  switch (type) {
    case 'float32':
      return data instanceof Float32Array ? data : Float32Array.from(data);
    case 'float64':
      return Float32Array.from(data);
    case 'float16': {
      if (typeof Float16Array !== 'undefined' && data instanceof Float16Array) {
        return Float32Array.from(data);
      }
      return float16ArrayToFloat32(data);
    }
    default:
      throw new Error(`float へ変換できない Tensor 型です: ${type}`);
  }
}

/* ==========================================================
   トークナイズ結果を 77 トークンに揃える
   ========================================================== */

/**
 * token id 列を maxLength に切り詰め、足りない分を padId で埋める。
 * ids の要素は number / bigint / string のいずれでもよい。
 */
export function padOrTruncateTokens(ids, maxLength, padId) {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error('maxLength は正の整数である必要があります');
  }
  const out = new Int32Array(maxLength);
  out.fill(padId);
  const n = Math.min(ids.length, maxLength);
  for (let i = 0; i < n; i++) out[i] = Number(ids[i]);
  return out;
}

/* ==========================================================
   画像変換 (NCHW float -> RGBA)
   ========================================================== */

/**
 * [C,H,W] のチャンネルファースト float 配列を RGBA8 に変換する。
 * デコーダは [0,1] を出力する契約なので既定は min=0,max=1。
 */
export function nchwToRgba(data, channels, height, width, min = 0, max = 1) {
  const expected = channels * height * width;
  if (data.length < expected) {
    throw new Error(`画像データが不足しています (${data.length} < ${expected})`);
  }
  const scale = 255 / (max - min);
  const rgba = new Uint8ClampedArray(height * width * 4);
  const plane = height * width;
  const single = channels === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (let c = 0; c < 3; c++) {
        // 1ch はグレースケールとして複製、2ch 以下でも先頭チャンネルで埋める
        const channelIndex = single ? 0 : Math.min(c, channels - 1);
        const v = data[channelIndex * plane + p];
        rgba[p * 4 + c] = Math.round((v - min) * scale);
      }
      rgba[p * 4 + 3] = 255;
    }
  }
  return rgba;
}

/* ==========================================================
   ONNX セッションの入出力名を役割に割り当てる
   ========================================================== */

const ROLE_PATTERNS = {
  text_encoder: {
    input_ids: [/^input_ids$/, /input_ids/, /^input$/],
    attention_mask: [/attention_mask/, /^mask$/],
  },
  unet: {
    sample: [/^sample$/, /^latent/, /^noise/, /sample/, /latent/],
    timestep: [/timestep/, /^t$/, /^time$/],
    encoder_hidden_states: [/encoder_hidden_states/, /encoder_hidden/, /context/, /text_emb/, /embedding/],
  },
  decoder: {
    latent: [/^latent$/, /latent/, /^sample$/, /^z$/],
  },
};

const OUTPUT_PATTERNS = {
  text_encoder: [/last_hidden_state/, /hidden/, /embedding/, /output/],
  unet: [/out_sample/, /^sample$/, /output/],
  decoder: [/^image$/, /image/, /^sample$/, /output/],
};

function matchName(names, patterns, used) {
  for (const pattern of patterns) {
    for (const name of names) {
      if (used.has(name)) continue;
      if (pattern.test(name)) return name;
    }
  }
  return null;
}

/**
 * セッションの入力名一覧から、役割ごとの入力名を推定する。
 * 見つからない役割は null になる。呼び出し側で必須チェックする。
 */
export function resolveRoleInputs(role, inputNames) {
  const patterns = ROLE_PATTERNS[role];
  if (!patterns) throw new Error(`未知の role: ${role}`);
  const used = new Set();
  const resolved = {};
  for (const [key, keyPatterns] of Object.entries(patterns)) {
    const match = matchName(inputNames, keyPatterns, used);
    if (match) {
      resolved[key] = match;
      used.add(match);
    } else {
      resolved[key] = null;
    }
  }
  return resolved;
}

export function resolveRoleOutput(role, outputNames) {
  const patterns = OUTPUT_PATTERNS[role];
  if (!patterns) throw new Error(`未知の role: ${role}`);
  return matchName(outputNames, patterns, new Set()) || outputNames[0] || null;
}
