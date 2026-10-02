/**
 * pipeline.mjs — インタラクティブ画像セグメンテーション (SAM) の純粋ロジック
 *
 * DOM / WebGPU / Worker に依存しない。ブラウザでも Node でも同じように動く
 * 計算だけを置き、worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは worker.js が担当する:
 *   - SAM … Transformers.js v4 の `SamModel` + `AutoProcessor`
 *     (`mask-generation` は Transformers.js にパイプラインが無いため直接使う)
 *
 * ここにはモデル選択・プロンプト (点/矩形) の座標変換・候補マスクの選択・
 * マスク合成・切り抜き範囲などの純関数を置く。
 *
 * 出典:
 *   https://huggingface.co/Xenova/slimsam-77-uniform
 *   https://huggingface.co/Xenova/sam-vit-base
 *   https://huggingface.co/spaces/webml-community/segment-anything-webgpu
 */

/* ==========================================================
   Transformers.js
   ========================================================== */

export const TRANSFORMERS_VERSION = '4.3.0';
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/** Transformers.js がモデルを保存する Cache Storage の既定プレフィックス */
export const CACHE_PREFIX = 'transformers-cache';

/* ==========================================================
   モデルカタログ
   ==========================================================
   ファイルサイズは 2026-10-02 時点の HuggingFace API (tree, 実バイト) の実測値。
   同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

export const MODEL_CATALOG = Object.freeze({
  'slimsam-77-uniform': Object.freeze({
    key: 'slimsam-77-uniform',
    modelId: 'Xenova/slimsam-77-uniform',
    task: 'mask-generation',
    label: 'SlimSAM 77 (uniform)',
    shortLabel: 'SlimSAM 77',
    description: 'SAM を蒸留した軽量版。点/矩形プロンプトで任意の物体を画素単位に切り出す。',
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/Xenova/slimsam-77-uniform',
    /** dtype ごとの重みファイルと実バイト数。SAM は encoder と decoder の 2 ファイル構成。 */
    files: Object.freeze({
      fp32: Object.freeze({
        'onnx/vision_encoder.onnx': 23276014,
        'onnx/prompt_encoder_mask_decoder.onnx': 16557892,
      }),
      fp16: Object.freeze({
        'onnx/vision_encoder_fp16.onnx': 12170657,
        'onnx/prompt_encoder_mask_decoder_fp16.onnx': 8550118,
      }),
      q8: Object.freeze({
        'onnx/vision_encoder_quantized.onnx': 8882165,
        'onnx/prompt_encoder_mask_decoder_quantized.onnx': 4903810,
      }),
    }),
    extraFiles: Object.freeze({ 'config.json': 379, 'preprocessor_config.json': 466 }),
    /** 実行環境ごとの既定 dtype。WebGPU は fp16、WASM は軽量な q8 (quantized)。 */
    dtype: Object.freeze({ webgpu: 'fp16', wasm: 'q8' }),
  }),
  'sam-vit-base': Object.freeze({
    key: 'sam-vit-base',
    modelId: 'Xenova/sam-vit-base',
    task: 'mask-generation',
    label: 'SAM ViT-Base',
    shortLabel: 'SAM ViT-B',
    description: '原論文の ViT-Base。軽量版より高精度だが重い (WebGPU 推奨)。',
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/Xenova/sam-vit-base',
    files: Object.freeze({
      fp32: Object.freeze({
        'onnx/vision_encoder.onnx': 359323905,
        'onnx/prompt_encoder_mask_decoder.onnx': 16557892,
      }),
      fp16: Object.freeze({
        'onnx/vision_encoder_fp16.onnx': 180194619,
        'onnx/prompt_encoder_mask_decoder_fp16.onnx': 8550118,
      }),
      q8: Object.freeze({
        'onnx/vision_encoder_quantized.onnx': 101088469,
        'onnx/prompt_encoder_mask_decoder_quantized.onnx': 4903810,
      }),
    }),
    extraFiles: Object.freeze({ 'config.json': 440, 'preprocessor_config.json': 466 }),
    dtype: Object.freeze({ webgpu: 'fp16', wasm: 'q8' }),
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));
export const DEFAULT_MODE = 'slimsam-77-uniform';

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

/** モデル × デバイスで使う dtype を返す */
export function resolveDtype(modeKey, device) {
  const model = getModel(modeKey);
  const dtype = model.dtype[device] || model.dtype.wasm || 'fp32';
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
 * モード × 実行環境から、実際に使うモデル・デバイス・dtype を決める。
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
    task: model.task,
    device,
    dtype,
    modelId: model.modelId,
    license: model.license,
    commercial: model.commercial,
    homepage: model.homepage,
    bytes: estimateModelBytes(model.key, device),
  });
}

/* ==========================================================
   プロンプト (点 / 矩形) の座標変換
   ==========================================================
   ブラウザ側は画像内の正規化座標 (0..1) で点と矩形を持つ。
   SAM へは「モデル入力にリサイズされた画像」の画素座標で渡す必要があるため、
   processor が返す reshaped_input_sizes (height, width) を使って変換する。
   ========================================================== */

/** 0..1 に丸める。数値でなければ例外。 */
export function clampUnit(value, name = 'value') {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${name} が数値ではありません`);
  return Math.min(1, Math.max(0, num));
}

/** 正規化点を検証して 0..1 に丸める */
export function normalizePoint(point) {
  if (!point || typeof point !== 'object') throw new Error('点が不正です');
  return { x: clampUnit(point.x, '点の x'), y: clampUnit(point.y, '点の y') };
}

/**
 * 正規化点を、モデル入力画像 (reshaped) の画素座標へ変換する。
 * @param {{x:number,y:number}} point 正規化 (0..1)
 * @param {{width:number,height:number}} reshapedSize モデル入力の (幅, 高さ)
 */
export function reshapePoint(point, reshapedSize) {
  const p = normalizePoint(point);
  if (!reshapedSize || !(reshapedSize.width > 0) || !(reshapedSize.height > 0)) {
    throw new Error('リサイズ後の寸法が不正です');
  }
  return {
    x: p.x * reshapedSize.width,
    y: p.y * reshapedSize.height,
  };
}

/**
 * 正規化点の配列を、SAM が取る平坦な座標列にする。
 * 点が無い場合は null を返す。
 * @param {Array<{x:number,y:number,label?:number}>} points
 * @param {{width:number,height:number}} reshapedSize
 */
export function pointsToFlat(points, reshapedSize) {
  if (!Array.isArray(points)) throw new Error('点の配列ではありません');
  if (points.length === 0) return null;
  const data = [];
  const labels = [];
  for (const point of points) {
    const p = reshapePoint(point, reshapedSize);
    data.push(p.x, p.y);
    // label: 1=前景, 0=背景 (右クリック)。既定は前景。
    labels.push(point.label === 0 ? 0 : 1);
  }
  return { data, labels };
}

/**
 * 点プロンプトを SAM の `input_points` / `input_labels` の形にする。
 * dims は [batch=1, point_batch=1, num_points, 2] / [1, 1, num_points]。
 */
export function buildPointPrompt(points, reshapedSize) {
  const flat = pointsToFlat(points, reshapedSize);
  if (!flat) return null;
  const n = flat.labels.length;
  return {
    points: { data: flat.data, dims: [1, 1, n, 2] },
    labels: { data: flat.labels, dims: [1, 1, n] },
  };
}

/** 正規化矩形を検証して 0..1 に丸める (x/y 反転は正規化) */
export function normalizeBox(box) {
  if (!box || typeof box !== 'object') throw new Error('矩形が不正です');
  let xmin = clampUnit(box.xmin, '矩形の xmin');
  let ymin = clampUnit(box.ymin, '矩形の ymin');
  let xmax = clampUnit(box.xmax, '矩形の xmax');
  let ymax = clampUnit(box.ymax, '矩形の ymax');
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  return { xmin, ymin, xmax, ymax };
}

/**
 * 矩形プロンプトを SAM の `input_boxes` の形にする。
 * dims は [batch=1, num_boxes, 4] で座標はリサイズ後画素 (x1,y1,x2,y2)。
 * 矩形が無い場合は null。
 */
export function buildBoxPrompt(boxes, reshapedSize) {
  if (!Array.isArray(boxes)) throw new Error('矩形の配列ではありません');
  if (boxes.length === 0) return null;
  if (!reshapedSize || !(reshapedSize.width > 0) || !(reshapedSize.height > 0)) {
    throw new Error('リサイズ後の寸法が不正です');
  }
  const data = [];
  for (const box of boxes) {
    const b = normalizeBox(box);
    data.push(
      b.xmin * reshapedSize.width,
      b.ymin * reshapedSize.height,
      b.xmax * reshapedSize.width,
      b.ymax * reshapedSize.height,
    );
  }
  return { data, dims: [1, boxes.length, 4] };
}

/**
 * 矩形を SAM の点プロンプト形式へ変換する。
 * 元論文の predictor と同じく、左上を label 2、右下を label 3 として渡す。
 * これにより prompt encoder の入力が点だけで済み、`input_boxes` 入力の有無に
 * 依存せずに矩形プロンプトを扱える。
 */
export function boxesToCornerPoints(boxes, reshapedSize) {
  if (!Array.isArray(boxes)) throw new Error('矩形の配列ではありません');
  if (boxes.length === 0) return null;
  if (!reshapedSize || !(reshapedSize.width > 0) || !(reshapedSize.height > 0)) {
    throw new Error('リサイズ後の寸法が不正です');
  }
  const data = [];
  const labels = [];
  for (const box of boxes) {
    const b = normalizeBox(box);
    data.push(
      b.xmin * reshapedSize.width,
      b.ymin * reshapedSize.height,
      b.xmax * reshapedSize.width,
      b.ymax * reshapedSize.height,
    );
    labels.push(2, 3);
  }
  return { data, labels };
}

/**
 * 点と矩形をまとめて Tensor 化できるデータに落とす。
 * 点も矩形も無ければ例外 (何を切り抜くか決まっていない)。
 *
 * `inputPoints` / `inputLabels` には、ユーザーの点に加えて矩形の 2 隅
 * (label 2/3) を連結したものを入れる。worker はこれを使う。
 * `inputBoxes` は `input_boxes` 入力をサポートする実装向けの補助表現。
 *
 * @returns {{inputPoints:object,inputLabels:object,inputBoxes:object|null,pointCount:number,boxCount:number}}
 */
export function buildPrompt({ points, boxes, reshapedSize } = {}) {
  const pointFlat = pointsToFlat(Array.isArray(points) ? points : [], reshapedSize);
  const cornerFlat = boxesToCornerPoints(Array.isArray(boxes) ? boxes : [], reshapedSize);
  if (!pointFlat && !cornerFlat) {
    throw new Error('点または矩形のプロンプトが必要です');
  }
  const combined = {
    data: [...(pointFlat ? pointFlat.data : []), ...(cornerFlat ? cornerFlat.data : [])],
    labels: [...(pointFlat ? pointFlat.labels : []), ...(cornerFlat ? cornerFlat.labels : [])],
  };
  const n = combined.labels.length;
  const boxPrompt = buildBoxPrompt(Array.isArray(boxes) ? boxes : [], reshapedSize);
  return {
    inputPoints: { data: combined.data, dims: [1, 1, n, 2] },
    inputLabels: { data: combined.labels, dims: [1, 1, n] },
    inputBoxes: boxPrompt,
    pointCount: pointFlat ? pointFlat.labels.length : 0,
    boxCount: boxPrompt ? boxPrompt.dims[1] : 0,
  };
}

/* ==========================================================
   マスク (0/1 の平面) の計算
   ==========================================================
   SAM は 1 プロンプトにつき 3 候補のマスクを返す。
   worker 側で post_process_masks の結果を「各候補が 0/1 の Uint8Array 平面」に
   正規化してから、ここにある選択・合成ロジックへ渡す。
   ========================================================== */

/**
 * RawImage 風オブジェクト ({width,height,channels,data}) を候補マスクの平面に分解する。
 * data は HWC (ピクセルごとに候補が連続) を想定する。
 * @returns {Uint8Array[]} 候補ごとの 0/1 平面 (長さ width*height)
 */
export function extractMaskPlanes(rawImageLike) {
  if (!rawImageLike || typeof rawImageLike !== 'object') throw new Error('マスク画像が不正です');
  const { width, height, channels } = rawImageLike;
  const data = rawImageLike.data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`マスク寸法が不正です: ${width}×${height}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`マスクのチャンネル数が不正です: ${channels}`);
  }
  if (!data || data.length < width * height * channels) {
    throw new Error('マスクのデータが不足しています');
  }
  const pixels = width * height;
  const planes = [];
  for (let m = 0; m < channels; m += 1) {
    const plane = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i += 1) {
      plane[i] = data[i * channels + m] ? 1 : 0;
    }
    planes.push(plane);
  }
  return planes;
}

/** マスクの面積 (立っているピクセル数) */
export function maskArea(plane) {
  if (!plane || typeof plane.length !== 'number') throw new Error('マスクが不正です');
  let count = 0;
  for (let i = 0; i < plane.length; i += 1) if (plane[i]) count += 1;
  return count;
}

/** 2 つのマスクの IoU。和集合が空なら 0。 */
export function maskIou(a, b) {
  if (!a || !b || a.length !== b.length) throw new Error('マスクの長さが一致しません');
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av || bv) union += 1;
    if (av && bv) inter += 1;
  }
  return union > 0 ? inter / union : 0;
}

/**
 * 候補マスクからスコア最大のものを選ぶ (SAM の iou_scores に対応)。
 * @returns {{index:number,score:number|null}}
 */
export function selectBestMask(planes, scores) {
  if (!Array.isArray(planes) || planes.length === 0) throw new Error('候補マスクがありません');
  const list = Array.isArray(scores) ? scores : [];
  if (list.length === 0) return { index: 0, score: null };
  let best = 0;
  for (let i = 1; i < planes.length; i += 1) {
    const cur = Number(list[i]);
    const prev = Number(list[best]);
    if (Number.isFinite(cur) && (!Number.isFinite(prev) || cur > prev)) best = i;
  }
  const score = Number(list[best]);
  return { index: best, score: Number.isFinite(score) ? score : null };
}

/**
 * 直前のマスク (reference) と十分に重なる候補のうち、スコア最大のものを選ぶ。
 * 点を追加して refinement するときに、マスクが別物体へ飛ぶのを防ぐ。
 * 重なる候補が無ければ通常のスコア選択にフォールバックする。
 */
export function selectMaskByIou(planes, scores, reference, minIou = 0.5) {
  if (!Array.isArray(planes) || planes.length === 0) throw new Error('候補マスクがありません');
  if (!Number.isFinite(minIou) || minIou < 0 || minIou > 1) {
    throw new Error(`不正な IoU しきい値です: ${minIou}`);
  }
  if (!reference) return { ...selectBestMask(planes, scores), iou: null };

  const list = Array.isArray(scores) ? scores : [];
  let best = -1;
  let bestScore = -Infinity;
  let bestIou = 0;
  for (let i = 0; i < planes.length; i += 1) {
    const overlap = maskIou(planes[i], reference);
    if (overlap < minIou) continue;
    const score = Number(list[i]);
    const effective = Number.isFinite(score) ? score : 0;
    if (effective > bestScore) {
      best = i;
      bestScore = effective;
      bestIou = overlap;
    }
  }
  if (best === -1) return { ...selectBestMask(planes, scores), iou: null };
  return { index: best, score: Number.isFinite(bestScore) ? bestScore : null, iou: bestIou };
}

/** マスクの外接矩形。空なら null。xmax/ymax は「最後の +1」で幅にそのまま使える。 */
export function maskBoundingBox(plane, width, height) {
  if (!plane) throw new Error('マスクが不正です');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`寸法が不正です: ${width}×${height}`);
  }
  let xmin = width;
  let ymin = height;
  let xmax = -1;
  let ymax = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!plane[row + x]) continue;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  if (xmax < 0) return null;
  return { xmin, ymin, xmax: xmax + 1, ymax: ymax + 1 };
}

/**
 * マスクの外接矩形に余白を足し、画像内に収めた切り抜き範囲を返す。
 * 空のマスクなら null。
 */
export function computeMaskCrop(plane, width, height, padding = 0) {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error(`不正な余白です: ${padding}`);
  }
  const bbox = maskBoundingBox(plane, width, height);
  if (!bbox) return null;
  const pad = Math.round(padding);
  const x = Math.max(0, bbox.xmin - pad);
  const y = Math.max(0, bbox.ymin - pad);
  const x2 = Math.min(width, bbox.xmax + pad);
  const y2 = Math.min(height, bbox.ymax + pad);
  const w = Math.max(1, x2 - x);
  const h = Math.max(1, y2 - y);
  return { x, y, w, h };
}

/**
 * 元画像の RGBA にマスクを適用して切り抜き (アルファ合成) する。
 * 新しい Uint8ClampedArray を返し、元データは変更しない。
 * @param {Uint8ClampedArray|Uint8Array} sourceData RGBA
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} plane 0/1 マスク
 * @param {{invert?:boolean,opacity?:number,background?:number[]}} [options]
 */
export function compositePixels(sourceData, width, height, plane, options = {}) {
  if (!sourceData || sourceData.length < width * height * 4) {
    throw new Error('元画像の RGBA データが不足しています');
  }
  if (!plane || plane.length < width * height) {
    throw new Error('マスクのデータが不足しています');
  }
  const invert = Boolean(options.invert);
  let opacity = Number(options.opacity);
  if (!Number.isFinite(opacity)) opacity = 1;
  opacity = Math.min(1, Math.max(0, opacity));
  const background = Array.isArray(options.background) && options.background.length === 4
    ? options.background
    : [0, 0, 0, 0];

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const keep = invert ? !plane[i] : Boolean(plane[i]);
    const offset = i * 4;
    if (keep) {
      out[offset] = sourceData[offset];
      out[offset + 1] = sourceData[offset + 1];
      out[offset + 2] = sourceData[offset + 2];
      out[offset + 3] = Math.round((sourceData[offset + 3] ?? 255) * opacity);
    } else {
      out[offset] = background[0];
      out[offset + 1] = background[1];
      out[offset + 2] = background[2];
      out[offset + 3] = background[3];
    }
  }
  return out;
}

/**
 * マスクを色付きの RGBA 平面にする (マスク PNG の書き出し用)。
 * @param {{color?:number[],background?:number[]}} [options]
 */
export function maskPlaneToRGBA(plane, width, height, options = {}) {
  if (!plane || plane.length < width * height) throw new Error('マスクのデータが不足しています');
  const color = Array.isArray(options.color) && options.color.length >= 3
    ? options.color
    : [124, 58, 237];
  const background = Array.isArray(options.background) && options.background.length === 4
    ? options.background
    : [0, 0, 0, 0];
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    if (plane[i]) {
      out[offset] = color[0];
      out[offset + 1] = color[1];
      out[offset + 2] = color[2];
      out[offset + 3] = 255;
    } else {
      out[offset] = background[0];
      out[offset + 1] = background[1];
      out[offset + 2] = background[2];
      out[offset + 3] = background[3];
    }
  }
  return out;
}

/* ==========================================================
   他アプリへの受け渡し (handoff)
   ==========================================================
   sessionStorage 経由で切り抜き画像とマスクを渡す。
   image-studio / bg-remove / (将来の) inpainting が同じキーを読む。
   キー文字列は各アプリで一致させること。
   ========================================================== */

export const SEGMENT_HANDOFF_KEY = 'myapps:segment-handoff';

/** 受け渡しオブジェクトを検証して作る */
export function buildHandoff({ cutoutDataUrl, maskDataUrl = null, width, height, sourceName = 'image' } = {}) {
  if (typeof cutoutDataUrl !== 'string' || !cutoutDataUrl.startsWith('data:image/')) {
    throw new Error('切り抜き画像の data URL が不正です');
  }
  if (maskDataUrl !== null && (typeof maskDataUrl !== 'string' || !maskDataUrl.startsWith('data:image/'))) {
    throw new Error('マスク画像の data URL が不正です');
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`切り抜き寸法が不正です: ${width}×${height}`);
  }
  return {
    version: 1,
    source: 'segment-anything',
    sourceName: String(sourceName || 'image'),
    width,
    height,
    cutoutDataUrl,
    maskDataUrl: maskDataUrl || null,
  };
}

export function serializeHandoff(handoff) {
  return JSON.stringify(buildHandoff(handoff));
}

/** 壊れた JSON や必須キー欠落は null を返す (呼び出し側で無視できる) */
export function parseHandoff(json) {
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.cutoutDataUrl !== 'string' || !parsed.cutoutDataUrl.startsWith('data:image/')) {
    return null;
  }
  if (!Number.isInteger(parsed.width) || parsed.width <= 0) return null;
  if (!Number.isInteger(parsed.height) || parsed.height <= 0) return null;
  return {
    version: Number.isInteger(parsed.version) ? parsed.version : 1,
    source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    sourceName: typeof parsed.sourceName === 'string' ? parsed.sourceName : 'image',
    width: parsed.width,
    height: parsed.height,
    cutoutDataUrl: parsed.cutoutDataUrl,
    maskDataUrl: typeof parsed.maskDataUrl === 'string' ? parsed.maskDataUrl : null,
  };
}

/* ==========================================================
   表示 / ファイル名 / 入力判定
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

/** 0..1 のスコアを百分率の文字列にする */
export function formatScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '-';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

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

/** マスク PNG のファイル名 */
export function buildMaskName(originalName) {
  return `${sanitizeBaseName(originalName)}-mask.png`;
}

/** 切り抜き PNG のファイル名 */
export function buildCutoutName(originalName) {
  return `${sanitizeBaseName(originalName)}-cutout.png`;
}

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

/** File / Blob 風オブジェクトが処理対象にできるか */
export function isSupportedImage(file) {
  if (!file) return false;
  return isSupportedImageType(file.type) || hasImageExtension(file.name);
}
