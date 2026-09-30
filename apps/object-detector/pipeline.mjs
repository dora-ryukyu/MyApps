/**
 * pipeline.mjs — 物体検出の純粋ロジック
 *
 * DOM / WebGPU / Worker に依存しない。ブラウザでも Node でも同じように動く
 * 計算だけを置き、worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは worker.js が担当する:
 *   - D-FINE nano … Transformers.js v4 の `object-detection` パイプライン
 *
 * ここにはモデル選択・検出結果の正規化・NMS・切り出し範囲の計算などの純関数を置く。
 *
 * 出典:
 *   https://huggingface.co/onnx-community/dfine-nano-coco-ONNX
 *   https://huggingface.co/ustc-community/dfine-nano-coco
 *   https://arxiv.org/abs/2410.13842
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
   ファイルサイズは 2026-09-30 時点の HuggingFace API (tree, 実バイト) の実測値。
   同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

export const MODEL_CATALOG = Object.freeze({
  'dfine-nano': Object.freeze({
    key: 'dfine-nano',
    modelId: 'onnx-community/dfine-nano-coco-ONNX',
    task: 'object-detection',
    label: 'D-FINE nano（COCO 80 クラス）',
    shortLabel: 'D-FINE nano',
    description: 'リアルタイム DETR 系。人・乗り物・動物・家具などを矩形で検出。',
    license: 'Apache-2.0',
    commercial: true,
    homepage: 'https://huggingface.co/onnx-community/dfine-nano-coco-ONNX',
    /** dtype ごとの重みファイルと実バイト数 */
    files: Object.freeze({
      fp32: Object.freeze({ 'onnx/model.onnx': 15434994 }),
      q8: Object.freeze({ 'onnx/model_quantized.onnx': 4807354 }),
      int8: Object.freeze({ 'onnx/model_int8.onnx': 4807354 }),
      uint8: Object.freeze({ 'onnx/model_uint8.onnx': 4807428 }),
      q4: Object.freeze({ 'onnx/model_q4.onnx': 10921805 }),
      bnb4: Object.freeze({ 'onnx/model_bnb4.onnx': 10830816 }),
    }),
    extraFiles: Object.freeze({ 'config.json': 6570, 'preprocessor_config.json': 444 }),
    /** 実行環境ごとの既定 dtype。WebGPU は fp32、WASM は軽量な q8。 */
    dtype: Object.freeze({ webgpu: 'fp32', wasm: 'q8' }),
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));
export const DEFAULT_MODE = 'dfine-nano';

/** 既定のスコアしきい値と NMS の IoU しきい値 */
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_IOU_THRESHOLD = 0.6;

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
   クラス
   ==========================================================
   COCO の 80 クラス。id2label (config.json) と同じ順序。
   ========================================================== */

export const COCO_CLASSES = Object.freeze([
  'person', 'bicycle', 'car', 'motorbike', 'aeroplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'sofa', 'pottedplant', 'bed', 'diningtable', 'toilet', 'tvmonitor', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]);

/** よく使うクラスの日本語表記。無いものは英語ラベルをそのまま返す。 */
export const CLASS_LABELS_JA = Object.freeze({
  person: '人',
  bicycle: '自転車',
  car: '車',
  motorbike: 'バイク',
  aeroplane: '飛行機',
  bus: 'バス',
  train: '電車',
  truck: 'トラック',
  boat: 'ボート',
  'traffic light': '信号機',
  'fire hydrant': '消火栓',
  'stop sign': '停止標識',
  bench: 'ベンチ',
  bird: '鳥',
  cat: '猫',
  dog: '犬',
  horse: '馬',
  sheep: '羊',
  cow: '牛',
  elephant: '象',
  bear: 'クマ',
  zebra: 'シマウマ',
  giraffe: 'キリン',
  backpack: 'リュック',
  umbrella: '傘',
  handbag: 'ハンドバッグ',
  tie: 'ネクタイ',
  suitcase: 'スーツケース',
  bottle: 'ボトル',
  'wine glass': 'ワイングラス',
  cup: 'カップ',
  fork: 'フォーク',
  knife: 'ナイフ',
  spoon: 'スプーン',
  bowl: 'ボウル',
  banana: 'バナナ',
  apple: 'りんご',
  sandwich: 'サンドイッチ',
  orange: 'オレンジ',
  pizza: 'ピザ',
  donut: 'ドーナツ',
  cake: 'ケーキ',
  chair: '椅子',
  sofa: 'ソファ',
  pottedplant: '鉢植え',
  bed: 'ベッド',
  diningtable: '食卓',
  toilet: 'トイレ',
  tvmonitor: 'モニター',
  laptop: 'ノートPC',
  mouse: 'マウス',
  remote: 'リモコン',
  keyboard: 'キーボード',
  'cell phone': '携帯電話',
  microwave: '電子レンジ',
  oven: 'オーブン',
  toaster: 'トースター',
  sink: '流し',
  refrigerator: '冷蔵庫',
  book: '本',
  clock: '時計',
  vase: '花瓶',
  scissors: 'はさみ',
  'teddy bear': 'ぬいぐるみ',
  'hair drier': 'ドライヤー',
  toothbrush: '歯ブラシ',
});

/** クラス名の日本語表記 (無ければそのまま) */
export function labelJa(label) {
  return CLASS_LABELS_JA[label] || String(label ?? 'unknown');
}

/** クラス名から表示色を決める (同じ入力なら常に同じ色) */
export function classColor(label) {
  const text = String(label ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 72%, 52%)`;
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
 *
 * @param {{xmin:number,ymin:number,xmax:number,ymax:number}} box
 * @param {number} [width]  画像幅 (省略時は 0 以上のみ保証)
 * @param {number} [height] 画像高さ
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

/**
 * クラスごとの非最大抑制 (NMS)。
 * スコアの高い順に残し、同じクラスで IoU がしきい値を超える重複を捨てる。
 *
 * @param {Array<{label:string,score:number,box:object}>} detections
 * @param {number} [iouThreshold=0.5]
 * @returns {typeof detections} スコア降順のフィルタ済み配列
 */
export function nms(detections, iouThreshold = 0.5) {
  if (!Array.isArray(detections)) throw new Error('検出結果が配列ではありません');
  if (!Number.isFinite(iouThreshold) || iouThreshold < 0 || iouThreshold > 1) {
    throw new Error(`不正な IoU しきい値です: ${iouThreshold}`);
  }
  const sorted = detections
    .map((det, index) => ({ det, index }))
    .sort((a, b) => b.det.score - a.det.score || a.index - b.index);

  const kept = [];
  const keptByLabel = new Map();
  for (const { det } of sorted) {
    const sameLabel = keptByLabel.get(det.label) || [];
    const overlaps = sameLabel.some((other) => iou(other.box, det.box) > iouThreshold);
    if (overlaps) continue;
    sameLabel.push(det);
    keptByLabel.set(det.label, sameLabel);
    kept.push(det);
  }
  return kept;
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
 * 切り出し範囲 (x, y, w, h) を画像内で計算する。
 * padding は矩形の各辺に足す画素数。
 *
 * @param {{xmin:number,ymin:number,xmax:number,ymax:number}} box
 * @param {number} width
 * @param {number} height
 * @param {number} [padding=0]
 */
export function computeCropRegion(box, width, height, padding = 0) {
  if (!isPositiveSize(width) || !isPositiveSize(height)) {
    throw new Error(`画像寸法が不正です: ${width}×${height}`);
  }
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error(`不正な余白です: ${padding}`);
  }
  const b = clampBox(box, width, height);
  const pad = Math.round(padding);
  const x = Math.max(0, b.xmin - pad);
  const y = Math.max(0, b.ymin - pad);
  const x2 = Math.min(width, b.xmax + pad);
  const y2 = Math.min(height, b.ymax + pad);
  const w = Math.max(1, x2 - x);
  const h = Math.max(1, y2 - y);
  const x0 = Math.min(x, Math.max(0, width - w));
  const y0 = Math.min(y, Math.max(0, height - h));
  return { x: x0, y: y0, w: Math.min(w, width), h: Math.min(h, height) };
}

/* ==========================================================
   検出結果の正規化
   ========================================================== */

/**
 * Transformers.js の object-detection 出力を正規化する。
 * 入力: [{ score, label, box: { xmin, ymin, xmax, ymax } }, ...]
 * 出力: スコア降順・整数座標・クランプ済みの配列 (id 付き)。
 *
 * @param {Array} raw
 * @param {number} [width]  元画像幅 (指定すると矩形を画像内にクランプ)
 * @param {number} [height] 元画像高さ
 */
export function parseDetections(raw, width, height) {
  if (!Array.isArray(raw)) return [];
  const hasSize = isPositiveSize(width) && isPositiveSize(height);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const score = Number(item.score);
    if (!Number.isFinite(score)) continue;
    const label = typeof item.label === 'string' && item.label ? item.label : 'unknown';
    let box;
    try {
      box = clampBox(item.box || item, hasSize ? width : undefined, hasSize ? height : undefined);
    } catch {
      continue;
    }
    out.push({ label, score, box });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((det, index) => ({ ...det, id: index }));
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

/** 0..1 のスコアを百分率の文字列にする */
export function formatScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '-';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
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
export function buildDownloadName(originalName, suffix = 'detect') {
  return `${sanitizeBaseName(originalName)}-${suffix}.png`;
}

/** 切り出した物体のファイル名を作る */
export function buildCropName(originalName, label, index) {
  const safeLabel = sanitizeBaseName(label);
  return `${sanitizeBaseName(originalName)}-${safeLabel}-${index + 1}.png`;
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
