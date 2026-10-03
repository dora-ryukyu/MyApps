/**
 * pipeline.mjs — 顔検出と匿名化の純粋ロジック
 *
 * DOM / WebGL / Worker に依存しない計算だけを置く。ブラウザ (worker.js,
 * script.js) からも Node の node:test からも同じように import して検証できる。
 *
 * 推論そのものは worker.js が担当する:
 *   - 顔検出 … MediaPipe Tasks Vision の FaceDetector (BlazeFace short-range)
 *
 * ここにはモデル選択・検出結果の正規化・匿名化領域の計算・画素加工
 * (ぼかし / モザイク / 黒塗り / 絵文字の下地) の純関数を置く。
 *
 * 出典:
 *   https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js
 *   https://www.npmjs.com/package/@mediapipe/tasks-vision
 *   https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite
 */

/* ==========================================================
   MediaPipe Tasks Vision
   ========================================================== */

/** 依存を固定する。更新時はこの 1 箇所だけ変える。 */
export const MEDIAPIPE_VERSION = '1.0.1';
export const MEDIAPIPE_MODULE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
export const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

/**
 * 独自キャッシュの名前。MediaPipe は Cache Storage を使わないため、
 * モデル (tflite) は worker.js が明示的にここへ保存する。
 */
export const CACHE_NAME = 'face-privacy-cache';
export const CACHE_PREFIX = 'face-privacy';

/**
 * MediaPipe WASM ランタイムの合計バイト数 (2026-10-03 時点、jsDelivr の
 * パッケージ内容から実測)。vision_bundle.mjs + module 版 wasm/js。
 * 初回ダウンロード量の表示とテストにだけ使う。
 */
export const RUNTIME_BYTES = 155439 + 323415 + 11756972;

/* ==========================================================
   モデルカタログ
   ========================================================== */

export const MODEL_CATALOG = Object.freeze({
  'blaze-face-short-range': Object.freeze({
    key: 'blaze-face-short-range',
    modelId: 'blaze_face_short_range',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    label: 'BlazeFace short-range（MediaPipe）',
    shortLabel: 'BlazeFace',
    description: '顔の矩形と 6 キーポイントを返す軽量モデル。画像 1 枚あたり数百 ms。',
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js',
    /** tflite の実バイト数 (2026-10-03 HEAD で確認) */
    bytes: 229746,
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));
export const DEFAULT_MODE = 'blaze-face-short-range';

/** 既定の信頼度・重複除去 (MediaPipe の既定値に合わせる) */
export const DEFAULT_CONFIDENCE = 0.5;
export const DEFAULT_SUPPRESSION = 0.3;

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

/**
 * 実行デバイス (MediaPipe の delegate) を決める。
 * MediaPipe の GPU は WebGL2 ベース。無ければ CPU (WASM)。
 */
export function chooseRuntime(hasWebGL2) {
  return hasWebGL2 ? 'GPU' : 'CPU';
}

/** 初回ダウンロード量 (モデル + WASM ランタイム) をバイトで見積もる */
export function estimateDownloadBytes(modeKey) {
  return getModel(modeKey).bytes + RUNTIME_BYTES;
}

/**
 * モードと実行環境から、実際に使うモデル・delegate を決める。
 * worker.js と script.js の両方がこれを使い、表示と実推論を一致させる。
 */
export function chooseModel(modeKey, hasWebGL2) {
  const model = getModel(modeKey);
  return Object.freeze({
    modeKey: model.key,
    label: model.label,
    shortLabel: model.shortLabel,
    description: model.description,
    modelId: model.modelId,
    modelUrl: model.url,
    license: model.license,
    commercial: model.commercial,
    homepage: model.homepage,
    delegate: chooseRuntime(Boolean(hasWebGL2)),
    bytes: estimateDownloadBytes(model.key),
  });
}

/* ==========================================================
   矩形の計算
   ========================================================== */

function isPositiveSize(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * 矩形を画像内に収め、座標を整数に丸める。
 * 座標が逆転していても xmin<=xmax / ymin<=ymax に正規化する。
 */
export function clampBox(box, width, height) {
  if (!box || typeof box !== 'object') throw new Error('矩形が不正です');
  const values = ['xmin', 'ymin', 'xmax', 'ymax'].map((key) => Number(box[key]));
  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error('矩形の座標が数値ではありません');
  }
  let [xmin, ymin, xmax, ymax] = values;
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];

  const maxX = isPositiveSize(width) ? width : Infinity;
  const maxY = isPositiveSize(height) ? height : Infinity;
  xmin = Math.min(Math.max(0, xmin), maxX);
  ymin = Math.min(Math.max(0, ymin), maxY);
  xmax = Math.min(Math.max(0, xmax), maxX);
  ymax = Math.min(Math.max(0, ymax), maxY);

  return {
    xmin: Math.round(xmin),
    ymin: Math.round(ymin),
    xmax: Math.round(xmax),
    ymax: Math.round(ymax),
  };
}

/** 矩形の面積 (重なりは考慮しない) */
export function boxArea(box) {
  const b = clampBox(box);
  return Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
}

/** 2 つの矩形が重なる面積 */
export function intersectionArea(a, b) {
  const x = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
  const y = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  return x * y;
}

/** IoU (Intersection over Union) */
export function iou(a, b) {
  const inter = intersectionArea(clampBox(a), clampBox(b));
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** 複数の矩形をまとめて覆う最小の矩形。空配列なら null。 */
export function unionBox(boxes) {
  if (!Array.isArray(boxes)) throw new Error('矩形の配列ではありません');
  if (boxes.length === 0) return null;
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const box of boxes) {
    const b = clampBox(box);
    xmin = Math.min(xmin, b.xmin);
    ymin = Math.min(ymin, b.ymin);
    xmax = Math.max(xmax, b.xmax);
    ymax = Math.max(ymax, b.ymax);
  }
  return { xmin, ymin, xmax, ymax };
}

/**
 * 矩形の各辺を、辺の長さ × ratio だけ外側へ広げる (拡張マージン)。
 * ratio は 0 以上。画像寸法を渡すと画像内にクランプする。
 */
export function expandBox(box, ratio = 0, width, height) {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new Error(`不正な拡張マージンです: ${ratio}`);
  }
  const b = clampBox(box, width, height);
  const dx = Math.round((b.xmax - b.xmin) * ratio);
  const dy = Math.round((b.ymax - b.ymin) * ratio);
  return clampBox(
    {
      xmin: b.xmin - dx,
      ymin: b.ymin - dy,
      xmax: b.xmax + dx,
      ymax: b.ymax + dy,
    },
    width,
    height,
  );
}

/** 2 つの矩形が重なる、または gap 画素以内に接するか */
export function isNear(a, b, gap = 0) {
  if (!Number.isFinite(gap) || gap < 0) {
    throw new Error(`不正なギャップです: ${gap}`);
  }
  const a1 = clampBox(a);
  const b1 = clampBox(b);
  const gapX = Math.max(a1.xmin, b1.xmin) - Math.min(a1.xmax, b1.xmax);
  const gapY = Math.max(a1.ymin, b1.ymin) - Math.min(a1.ymax, b1.ymax);
  return gapX <= gap && gapY <= gap;
}

/**
 * 重なる矩形を統合する。gap を与えると、その距離以内の矩形もまとめる。
 * 統合できる組が無くなるまで繰り返す。
 */
export function mergeBoxes(boxes, gap = 0) {
  if (!Array.isArray(boxes)) throw new Error('矩形の配列ではありません');
  if (!Number.isFinite(gap) || gap < 0) {
    throw new Error(`不正なギャップです: ${gap}`);
  }
  let items = boxes.map((box) => clampBox(box));
  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (const box of items) {
      let merged = false;
      for (let i = 0; i < out.length; i += 1) {
        if (isNear(out[i], box, gap)) {
          out[i] = unionBox([out[i], box]);
          merged = true;
          changed = true;
          break;
        }
      }
      if (!merged) out.push(box);
    }
    items = out;
  }
  return items;
}

/**
 * 矩形を整数の画素領域 (x, y, w, h) に変換し、画像内にクランプする。
 * w/h は 0 以上 (空の矩形は 0 を返す)。
 */
export function toPixelRegion(box, width, height) {
  if (!isPositiveSize(width) || !isPositiveSize(height)) {
    throw new Error(`画像寸法が不正です: ${width}×${height}`);
  }
  const b = clampBox(box, width, height);
  return {
    x: b.xmin,
    y: b.ymin,
    w: Math.max(0, b.xmax - b.xmin),
    h: Math.max(0, b.ymax - b.ymin),
  };
}

/* ==========================================================
   検出結果の正規化 (MediaPipe → 内部表現)
   ========================================================== */

/**
 * MediaPipe の正規化キーポイント (0..1) を画素座標へ変換する。
 * @param {Array<{x:number,y:number}>} keypoints
 */
export function keypointsToPixels(keypoints, width, height) {
  if (!Array.isArray(keypoints)) return [];
  const out = [];
  for (const kp of keypoints) {
    const x = Number(kp && kp.x);
    const y = Number(kp && kp.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x: x * width, y: y * height });
  }
  return out;
}

/**
 * MediaPipe の Detection から矩形を取り出す。
 * boundingBox が無ければ null。
 */
export function detectionToBox(detection, width, height) {
  const bb = detection && detection.boundingBox;
  if (!bb) return null;
  try {
    return clampBox(
      {
        xmin: bb.originX,
        ymin: bb.originY,
        xmax: Number(bb.originX) + Number(bb.width),
        ymax: Number(bb.originY) + Number(bb.height),
      },
      width,
      height,
    );
  } catch {
    return null;
  }
}

/**
 * MediaPipe FaceDetector の出力 ({ detections: [...] }) を正規化する。
 * 出力: スコア降順・整数座標・id 付きの配列。
 *
 * @param {object|Array} raw detect() の戻り値
 * @param {number} width  元画像幅
 * @param {number} height 元画像高さ
 */
export function parseDetections(raw, width, height) {
  const list =
    raw && Array.isArray(raw.detections)
      ? raw.detections
      : Array.isArray(raw)
        ? raw
        : [];
  const out = [];
  for (const det of list) {
    if (!det || typeof det !== 'object') continue;
    const category = Array.isArray(det.categories) ? det.categories[0] : null;
    const score = Number(category ? category.score : det.score);
    const box = detectionToBox(det, width, height) ||
      (det.box ? safeClamp(det.box, width, height) : null);
    if (!box) continue;
    out.push({
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
      box,
      keypoints: keypointsToPixels(det.keypoints, width, height),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((det, index) => ({ ...det, id: index }));
}

function safeClamp(box, width, height) {
  try {
    return clampBox(box, width, height);
  } catch {
    return null;
  }
}

/* ==========================================================
   匿名化領域の計画
   ========================================================== */

/**
 * 検出/手動の矩形リストから、実際に加工する画素領域を作る。
 * 有効な矩形だけを拡張マージンで広げ、必要なら統合し、画素領域へ変換する。
 *
 * @param {Array<{box?:object, enabled?:boolean}>} items
 * @param {{width:number,height:number,margin?:number,merge?:boolean,gap?:number}} options
 */
export function buildRegions(items, options = {}) {
  const { width, height, margin = 0, merge = false, gap = 0 } = options;
  const boxes = [];
  for (const item of items || []) {
    if (!item) continue;
    if (item.enabled === false) continue;
    const box = item.box || item;
    const clamped = safeClamp(box, width, height);
    if (clamped) boxes.push(clamped);
  }
  const expanded = boxes.map((box) => expandBox(box, margin, width, height));
  const merged = merge ? mergeBoxes(expanded, gap) : expanded;
  return merged
    .map((box) => toPixelRegion(box, width, height))
    .filter((region) => region.w > 0 && region.h > 0);
}

/* ==========================================================
   ぼかし / モザイク のパラメータ計算
   ========================================================== */

function clamp01(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

/** 矩形の短辺と強度からぼかし半径 (画素) を決める。1〜64 に制限。 */
export function computeBlurRadius(box, strength = 0.5) {
  const b = clampBox(box);
  const shortSide = Math.max(1, Math.min(b.xmax - b.xmin, b.ymax - b.ymin));
  const radius = Math.round(shortSide * clamp01(strength) * 0.25);
  return Math.max(1, Math.min(64, radius));
}

/** ぼかし半径からカーネル情報 (常に奇数サイズ) を作る。 */
export function computeBlurKernel(box, strength = 0.5) {
  const radius = computeBlurRadius(box, strength);
  return { radius, size: radius * 2 + 1 };
}

/** 矩形の短辺とブロック数から、モザイクのタイル 1 辺 (画素) を決める。 */
export function computeMosaicTile(box, blocks = 12) {
  const b = clampBox(box);
  const shortSide = Math.max(1, Math.min(b.xmax - b.xmin, b.ymax - b.ymin));
  const count = Math.max(1, Math.round(Number(blocks) || 12));
  const tile = Math.round(shortSide / count);
  return Math.max(1, Math.min(64, tile));
}

/** 絵文字を 1 文字だけ描くときのフォントサイズ (画素)。 */
export function emojiFontSize(box) {
  const b = clampBox(box);
  const shortSide = Math.max(1, Math.min(b.xmax - b.xmin, b.ymax - b.ymin));
  return Math.max(8, Math.round(shortSide * 0.85));
}

/* ==========================================================
   匿名化モード
   ========================================================== */

export const REDACTION_MODES = Object.freeze([
  Object.freeze({ key: 'blur', label: 'ぼかし', description: '矩形全体をぼかして輪郭を消す。' }),
  Object.freeze({ key: 'mosaic', label: 'モザイク', description: 'ブロック平均で画素を粗くする。' }),
  Object.freeze({ key: 'black', label: '黒塗り', description: '矩形を黒で塗りつぶす (最も確実)。' }),
  Object.freeze({ key: 'emoji', label: '絵文字', description: '下地を塗った上に絵文字を重ねる。' }),
]);

export const MODE_KEYS = Object.freeze(REDACTION_MODES.map((mode) => mode.key));
export const DEFAULT_REDACTION = 'blur';

export function getMode(modeKey) {
  const mode = REDACTION_MODES.find((entry) => entry.key === modeKey);
  if (!mode) throw new Error(`未知の匿名化モードです: ${modeKey}`);
  return mode;
}

/** 絵文字モードで選べる候補 (DOM で使う) */
export const EMOJI_CHOICES = Object.freeze(['😀', '🙂', '😎', '🐱', '🐶', '🐻', '🌸']);

/* ==========================================================
   画素加工 (ImageData 風オブジェクトを直接書き換える)
   ========================================================== */

function clampRegion(region, width, height) {
  const x = Math.max(0, Math.min(width, Math.floor(Number(region && region.x) || 0)));
  const y = Math.max(0, Math.min(height, Math.floor(Number(region && region.y) || 0)));
  const w = Math.max(0, Math.min(width - x, Math.floor(Number(region && region.w) || 0)));
  const h = Math.max(0, Math.min(height - y, Math.floor(Number(region && region.h) || 0)));
  return { x, y, w, h };
}

function assertImageData(imageData) {
  if (!imageData || !imageData.data || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height)) {
    throw new Error('ImageData 風オブジェクトが不正です');
  }
}

/** 領域を単色で塗りつぶす。color は [r,g,b,a] (既定は黒)。 */
export function fillRegion(imageData, region, color = [0, 0, 0, 255]) {
  assertImageData(imageData);
  const { data, width, height } = imageData;
  const r = clampRegion(region, width, height);
  const [cr, cg, cb, ca = 255] = color;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = cr;
      data[i + 1] = cg;
      data[i + 2] = cb;
      data[i + 3] = ca;
    }
  }
}

/**
 * 領域をモザイク化する。tile 画素ごとのブロック平均で塗る。
 * 端の半端なブロックも実際の範囲で平均する。
 */
export function mosaicRegion(imageData, region, tile = 8) {
  assertImageData(imageData);
  const { data, width, height } = imageData;
  const r = clampRegion(region, width, height);
  const t = Math.max(1, Math.floor(Number(tile) || 1));
  for (let by = r.y; by < r.y + r.h; by += t) {
    const y2 = Math.min(r.y + r.h, by + t);
    for (let bx = r.x; bx < r.x + r.w; bx += t) {
      const x2 = Math.min(r.x + r.w, bx + t);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let n = 0;
      for (let y = by; y < y2; y += 1) {
        for (let x = bx; x < x2; x += 1) {
          const i = (y * width + x) * 4;
          sr += data[i];
          sg += data[i + 1];
          sb += data[i + 2];
          sa += data[i + 3];
          n += 1;
        }
      }
      const ar = Math.round(sr / n);
      const ag = Math.round(sg / n);
      const ab = Math.round(sb / n);
      const aa = Math.round(sa / n);
      for (let y = by; y < y2; y += 1) {
        for (let x = bx; x < x2; x += 1) {
          const i = (y * width + x) * 4;
          data[i] = ar;
          data[i + 1] = ag;
          data[i + 2] = ab;
          data[i + 3] = aa;
        }
      }
    }
  }
}

/**
 * 領域をぼかす。横→縦の 2 パス box blur。端は領域内でクランプする。
 * 領域の外側の画素は変更しない。
 */
export function blurRegion(imageData, region, radius = 4) {
  assertImageData(imageData);
  const { data, width, height } = imageData;
  const r = clampRegion(region, width, height);
  const rad = Math.max(0, Math.floor(Number(radius) || 0));
  if (rad === 0 || r.w === 0 || r.h === 0) return;

  const src = data.slice();
  const tmp = data.slice();
  const size = rad * 2 + 1;

  // 横方向: src → tmp
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let k = -rad; k <= rad; k += 1) {
        const xx = Math.min(r.x + r.w - 1, Math.max(r.x, x + k));
        const i = (y * width + xx) * 4;
        sr += src[i];
        sg += src[i + 1];
        sb += src[i + 2];
        sa += src[i + 3];
      }
      const o = (y * width + x) * 4;
      tmp[o] = Math.round(sr / size);
      tmp[o + 1] = Math.round(sg / size);
      tmp[o + 2] = Math.round(sb / size);
      tmp[o + 3] = Math.round(sa / size);
    }
  }

  // 縦方向: tmp → data
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let k = -rad; k <= rad; k += 1) {
        const yy = Math.min(r.y + r.h - 1, Math.max(r.y, y + k));
        const i = (yy * width + x) * 4;
        sr += tmp[i];
        sg += tmp[i + 1];
        sb += tmp[i + 2];
        sa += tmp[i + 3];
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(sr / size);
      data[o + 1] = Math.round(sg / size);
      data[o + 2] = Math.round(sb / size);
      data[o + 3] = Math.round(sa / size);
    }
  }
}

/**
 * 1 つの領域をモードに従って匿名化する。
 * 絵文字モードは下地だけを塗る (文字は DOM 側で描く)。
 *
 * @param {{data:Uint8ClampedArray,width:number,height:number}} imageData
 * @param {{x:number,y:number,w:number,h:number}} region
 * @param {'blur'|'mosaic'|'black'|'emoji'} mode
 * @param {{strength?:number,blocks?:number,background?:number[]}} [options]
 */
export function applyRedaction(imageData, region, mode, options = {}) {
  assertImageData(imageData);
  switch (mode) {
    case 'blur': {
      const radius =
        options.radius != null ? options.radius : computeBlurRadius(region, options.strength);
      blurRegion(imageData, region, radius);
      return;
    }
    case 'mosaic': {
      const tile =
        options.tile != null ? options.tile : computeMosaicTile(region, options.blocks);
      mosaicRegion(imageData, region, tile);
      return;
    }
    case 'black':
      fillRegion(imageData, region, options.color || [0, 0, 0, 255]);
      return;
    case 'emoji':
      fillRegion(imageData, region, options.background || [255, 255, 255, 255]);
      return;
    default:
      throw new Error(`未知の匿名化モードです: ${mode}`);
  }
}

/** 複数領域をまとめて匿名化する。 */
export function applyRedactions(imageData, regions, mode, options = {}) {
  if (!Array.isArray(regions)) throw new Error('領域の配列ではありません');
  for (const region of regions) {
    applyRedaction(imageData, region, mode, options);
  }
}

/* ==========================================================
   表示ヘルパー / ファイル名
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

/** 匿名化後のダウンロードファイル名を作る */
export function buildDownloadName(originalName, mode = 'privacy') {
  const suffix = sanitizeBaseName(mode) || 'privacy';
  return `${sanitizeBaseName(originalName)}-${suffix}.png`;
}

/** 一括保存 ZIP のファイル名を作る (now を渡すとテストしやすい) */
export function buildZipName(now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `face-privacy-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`;
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

/** File / Blob 風オブジェクトが処理対象にできるか */
export function isSupportedImage(file) {
  if (!file) return false;
  return isSupportedImageType(file.type) || hasImageExtension(file.name);
}
