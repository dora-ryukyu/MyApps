/**
 * pipeline.mjs — 画像一括処理の純ロジック
 *
 * DOM に依存しない計算だけをまとめる:
 *   - 形式 (JPEG / WebP / AVIF / PNG) と拡張子・MIME の対応
 *   - リサイズ後のサイズ計算 (長辺 / 短辺 / %、拡大しない)
 *   - 連番リネームと出力名の衝突回避
 *   - 透かしの配置計算と回転角の正規化
 *   - 入力 1 件ごとの処理方針 (再エンコード / バイトコピー) の決定
 *   - JPEG からのメタデータ (EXIF / コメント) 除去
 *   - 処理結果の集計
 *
 * node --test からそのまま検証できる。ブラウザでも `type="module"` の
 * Worker / メインスレッドから同じ関数を import して使う。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 出力形式として選べる値。'keep' は元の形式を保つ。 */
export const FORMATS = ['keep', 'jpeg', 'webp', 'avif', 'png'];

/** 形式ごとの拡張子・MIME・可逆性 */
export const FORMAT_INFO = {
  jpeg: { ext: '.jpg', mime: 'image/jpeg', lossy: true, quality: true, label: 'JPEG' },
  webp: { ext: '.webp', mime: 'image/webp', lossy: true, quality: true, label: 'WebP' },
  avif: { ext: '.avif', mime: 'image/avif', lossy: true, quality: true, label: 'AVIF' },
  png: { ext: '.png', mime: 'image/png', lossy: false, quality: false, label: 'PNG' },
};

/** リサイズの基準 */
export const RESIZE_MODES = ['none', 'long', 'short', 'percent'];

/** 透かしの位置 */
export const WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
];

export const DEFAULT_QUALITY = 0.9;

/** 出力する 1 辺の上限 (px)。これを超える値は指定できない。 */
export const MAX_DIMENSION = 30000;

/** 連番のゼロ埋め桁数の上限 */
export const MAX_PAD = 8;

/** 1 回の一括処理で扱えるファイル数の上限 */
export const MAX_FILES = 500;

/* ==========================================================
   形式とファイル名
   ========================================================== */

/** 拡張子から正規の形式名を返す (対応外は null) */
export function formatFromName(name) {
  const ext = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  if (!ext) return null;
  switch (ext[1]) {
    case 'jpg':
    case 'jpeg':
    case 'jpe':
    case 'jfif':
      return 'jpeg';
    case 'png':
      return 'png';
    case 'webp':
      return 'webp';
    case 'avif':
      return 'avif';
    default:
      return null;
  }
}

/** 元のファイル名から MIME を推定する (不明なら空文字) */
export function mimeFromName(name) {
  const format = formatFromName(name);
  return format ? FORMAT_INFO[format].mime : '';
}

/** 選択された形式 ('keep' 可) を、実際に出力する形式へ解決する */
export function resolveTargetFormat(requested, originalName) {
  if (requested && requested !== 'keep' && FORMAT_INFO[requested]) return requested;
  return formatFromName(originalName) || 'png';
}

export function isLossyFormat(format) {
  const info = FORMAT_INFO[format];
  return info ? info.lossy : false;
}

export function qualityApplies(format) {
  const info = FORMAT_INFO[format];
  return info ? info.quality : false;
}

/** 品質を 0.1..1.0 へ丸める (可逆形式では無意味なので既定値を返す) */
export function clampQuality(quality) {
  const value = Number(quality);
  if (!Number.isFinite(value)) return DEFAULT_QUALITY;
  return Math.min(1, Math.max(0.1, Math.round(value * 100) / 100));
}

/** 出力形式から拡張子を返す。'keep' は元の拡張子を尊重する。 */
export function extensionFor(format, originalName = '') {
  if (format === 'keep') {
    const match = String(originalName || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
    return match ? match[1] : '.png';
  }
  const info = FORMAT_INFO[format];
  return info ? info.ext : '.png';
}

/**
 * 出力形式から MIME を返す。'keep' は元の拡張子から推定し、
 * 分からなければ PNG とみなす。
 */
export function mimeFor(format, originalName = '') {
  if (format === 'keep') {
    return mimeFromName(originalName) || 'image/png';
  }
  const info = FORMAT_INFO[format];
  return info ? info.mime : 'image/png';
}

/* ==========================================================
   文字列ユーティリティ
   ========================================================== */

/** パス区切り・制御文字・禁止文字を除いた安全なベース名にする */
export function sanitizeBaseName(name) {
  let value = String(name == null ? '' : name)
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (value.length > 120) value = value.slice(0, 120);
  return value;
}

/** 末尾の拡張子を外したベース名を返す（先頭のドットは拡張子とみなさない） */
export function stripExtension(name) {
  const value = String(name == null ? '' : name);
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return value;
  return value.slice(0, dot);
}

/* ==========================================================
   リサイズ
   ========================================================== */

function toPositiveInt(value, fallback = 1) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * リサイズ後のサイズを計算する。
 *
 * options.mode: 'none' | 'long' | 'short' | 'percent'
 * options.value: 長辺/短辺の px、または %（mode が 'none' のときは無視）
 * options.allowUpscale: 既定 false（拡大しない）
 */
export function computeOutputSize(srcWidth, srcHeight, options = {}) {
  const width = toPositiveInt(srcWidth, 1);
  const height = toPositiveInt(srcHeight, 1);
  const mode = RESIZE_MODES.includes(options.mode) ? options.mode : 'none';
  const allowUpscale = options.allowUpscale === true;

  let scale = 1;
  if (mode === 'long') {
    const target = Number(options.value);
    const longEdge = Math.max(width, height);
    if (Number.isFinite(target) && target > 0) scale = target / longEdge;
  } else if (mode === 'short') {
    const target = Number(options.value);
    const shortEdge = Math.min(width, height);
    if (Number.isFinite(target) && target > 0) scale = target / shortEdge;
  } else if (mode === 'percent') {
    const percent = Number(options.value);
    if (Number.isFinite(percent) && percent > 0) scale = percent / 100;
  }

  if (!allowUpscale && scale > 1) scale = 1;
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const outWidth = Math.max(1, Math.min(MAX_DIMENSION, Math.round(width * scale)));
  const outHeight = Math.max(1, Math.min(MAX_DIMENSION, Math.round(height * scale)));

  return {
    width: outWidth,
    height: outHeight,
    scale,
    changed: outWidth !== width || outHeight !== height,
  };
}

/* ==========================================================
   リネーム
   ========================================================== */

/**
 * 連番のファイル名を作る。
 *
 * options.prefix    接頭辞（既定 'image'）
 * options.index     0 始まりの連番
 * options.start     開始番号（既定 1）
 * options.pad       ゼロ埋め桁数（既定 3）
 * options.format    出力形式（拡張子の決定に使う）
 * options.useOriginal true なら元のファイル名を保つ
 * options.originalName 元のファイル名
 */
export function buildSequentialName(options = {}) {
  const {
    prefix = 'image',
    index = 0,
    start = 1,
    pad = 3,
    format = 'jpeg',
    useOriginal = false,
    originalName = '',
  } = options;

  // 「元名を保つ」モードでは、形式が変わらない限り元の拡張子を尊重する
  // (.jpeg を .jpg に勝手に変えない)。
  const sourceFormat = formatFromName(originalName);
  const ext =
    format === 'keep' || (useOriginal && sourceFormat === format)
      ? extensionFor('keep', originalName)
      : extensionFor(format, originalName);

  if (useOriginal) {
    const base = sanitizeBaseName(stripExtension(originalName)) || 'image';
    return `${base}${ext}`;
  }

  const safePrefix = sanitizeBaseName(prefix) || 'image';
  const safePad = Math.min(MAX_PAD, Math.max(0, Math.round(Number(pad) || 0)));
  const startNumber = Math.round(Number(start));
  const base = Number.isFinite(startNumber) ? startNumber : 1;
  const number = base + Math.max(0, Math.round(Number(index) || 0));
  const numText = String(number).padStart(safePad, '0');
  return `${safePrefix}_${numText}${ext}`;
}

/** 名前を base と拡張子へ分ける（先頭のドットは拡張子とみなさない） */
function splitName(name) {
  const value = String(name == null ? '' : name);
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return { base: value, ext: '' };
  return { base: value.slice(0, dot), ext: value.slice(dot) };
}

/**
 * 出力名の衝突を ` (1)`, ` (2)` … で解消する。
 * 大文字小文字は同一視する。入力順は保つ。
 */
export function resolveOutputNames(names) {
  const used = new Set();
  const counts = new Map();
  return (Array.isArray(names) ? names : []).map((raw) => {
    const name = String(raw == null ? '' : raw) || 'image';
    const key = name.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      if (!counts.has(key)) counts.set(key, 0);
      return name;
    }
    const { base, ext } = splitName(name);
    let n = counts.get(key) || 0;
    let candidate;
    do {
      n += 1;
      candidate = `${base} (${n})${ext}`;
    } while (used.has(candidate.toLowerCase()));
    counts.set(key, n);
    used.add(candidate.toLowerCase());
    counts.set(candidate.toLowerCase(), 0);
    return candidate;
  });
}

/* ==========================================================
   透かし
   ========================================================== */

/** 回転角を 0..360 に正規化する */
export function normalizeRotation(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** 正規化した回転角をラジアンへ */
export function rotationRadians(degrees) {
  return (normalizeRotation(degrees) * Math.PI) / 180;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 透かし (画像) をキャンバス上に置く矩形を計算する。
 *
 * options.position: WATERMARK_POSITIONS のいずれか
 * options.margin:   端からの余白 (px)
 * options.scale:    透かし自体の拡大率 (0 より大きい)
 */
export function computeWatermarkLayout(options = {}) {
  const canvasWidth = toPositiveInt(options.canvasWidth, 1);
  const canvasHeight = toPositiveInt(options.canvasHeight, 1);
  const position = WATERMARK_POSITIONS.includes(options.position)
    ? options.position
    : 'bottom-right';
  const margin = Math.max(0, Math.round(Number(options.margin) || 0));
  const scale = Number(options.scale);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  const width = Math.max(1, Math.round(toPositiveInt(options.watermarkWidth, 1) * safeScale));
  const height = Math.max(1, Math.round(toPositiveInt(options.watermarkHeight, 1) * safeScale));

  let x;
  if (position === 'top-left' || position === 'bottom-left') {
    x = margin;
  } else if (position === 'top-right' || position === 'bottom-right') {
    x = canvasWidth - width - margin;
  } else {
    x = Math.round((canvasWidth - width) / 2);
  }

  let y;
  if (position === 'top-left' || position === 'top-right') {
    y = margin;
  } else if (position === 'bottom-left' || position === 'bottom-right') {
    y = canvasHeight - height - margin;
  } else {
    y = Math.round((canvasHeight - height) / 2);
  }

  return {
    x: clamp(x, 0, Math.max(0, canvasWidth - width)),
    y: clamp(y, 0, Math.max(0, canvasHeight - height)),
    width,
    height,
  };
}

/* ==========================================================
   処理方針
   ========================================================== */

function normalizeResize(resize) {
  const mode = resize && RESIZE_MODES.includes(resize.mode) ? resize.mode : 'none';
  const value = resize ? Number(resize.value) : 0;
  return { mode, value: Number.isFinite(value) ? value : 0 };
}

/**
 * 入力一覧と設定から、1 件ごとの処理内容を決める。
 *
 * entries: [{ id, name, width, height }]
 * settings: {
 *   resize:      { mode, value },
 *   format:      'keep' | 'jpeg' | 'webp' | 'avif' | 'png',
 *   rename:      { mode: 'sequence' | 'keep', prefix, start, pad },
 *   watermark:   { enabled: boolean },
 *   stripMetadata: boolean,
 * }
 *
 * 戻り値: [{ id, sourceName, outputName, targetFormat, width, height,
 *           resizeChanged, watermark, stripMetadata, passthrough }]
 *   passthrough=true なら再エンコードせず、必要ならバイト列から
 *   メタデータを落としてコピーするだけ。
 */
export function buildJobPlan(entries, settings = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const resize = normalizeResize(settings.resize);
  const rename = settings.rename || {};
  const useOriginal = rename.mode === 'keep';
  const watermarkEnabled = Boolean(settings.watermark && settings.watermark.enabled);
  const stripMetadata = settings.stripMetadata !== false;

  const planned = list.map((entry, index) => {
    const sourceName = String((entry && entry.name) || '');
    const sourceWidth = toPositiveInt(entry && entry.width, 1);
    const sourceHeight = toPositiveInt(entry && entry.height, 1);
    const targetFormat = resolveTargetFormat(settings.format, sourceName);
    const size = computeOutputSize(sourceWidth, sourceHeight, {
      mode: resize.mode,
      value: resize.value,
      allowUpscale: false,
    });
    const sourceFormat = formatFromName(sourceName);

    const outputName = buildSequentialName({
      prefix: rename.prefix,
      index,
      start: rename.start,
      pad: rename.pad,
      format: targetFormat,
      useOriginal,
      originalName: sourceName,
    });

    const needsTranscode =
      size.changed || watermarkEnabled || targetFormat !== sourceFormat;

    return {
      id: entry && entry.id != null ? entry.id : index,
      sourceName,
      outputName,
      targetFormat,
      width: size.width,
      height: size.height,
      resizeChanged: size.changed,
      sourceWidth,
      sourceHeight,
      watermark: watermarkEnabled,
      stripMetadata,
      passthrough: !needsTranscode,
    };
  });

  const uniqueNames = resolveOutputNames(planned.map((job) => job.outputName));
  return planned.map((job, index) => ({ ...job, outputName: uniqueNames[index] }));
}

/* ==========================================================
   JPEG メタデータ除去
   ========================================================== */

/** 0xFFD8 (SOI) で始まる JPEG か */
export function isJpeg(bytes) {
  return bytes && bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isStandaloneMarker(marker) {
  // RSTn (D0-D7), SOI (D8), EOI (D9), TEM (01)
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * JPEG からメタデータ (APP1 = EXIF/XMP、COM = コメント) を落とす。
 * SOS (0xDA) 以降の圧縮データはそのまま残す。
 *
 * 戻り値: { bytes, removed: number, hadMetadata: boolean }
 * 不正な入力 (SOI でない) はそのまま返す。
 */
export function stripJpegMetadata(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (!isJpeg(input)) {
    return { bytes: input, removed: 0, hadMetadata: false };
  }

  const out = [];
  let removed = 0;
  let cursor = 0;

  // SOI
  out.push(input[0], input[1]);
  cursor = 2;

  while (cursor + 1 < input.length) {
    if (input[cursor] !== 0xff) {
      // マーカー境界が壊れている → 以降は触らずコピー
      break;
    }
    const marker = input[cursor + 1];
    if (marker === 0xff) {
      // パディング
      cursor += 1;
      continue;
    }
    if (marker === 0xd9) {
      out.push(input[cursor], input[cursor + 1]);
      cursor += 2;
      out.push(...input.subarray(cursor));
      return { bytes: new Uint8Array(out), removed, hadMetadata: removed > 0 };
    }
    if (isStandaloneMarker(marker)) {
      out.push(input[cursor], input[cursor + 1]);
      cursor += 2;
      continue;
    }

    const length = (input[cursor + 2] << 8) | input[cursor + 3];
    if (length < 2 || cursor + 2 + length > input.length) {
      break;
    }
    const segmentEnd = cursor + 2 + length;

    const isMetadata = marker === 0xe1 /* APP1: EXIF / XMP */ || marker === 0xfe /* COM */;
    if (isMetadata) {
      removed += 1;
    } else {
      out.push(...input.subarray(cursor, segmentEnd));
    }
    cursor = segmentEnd;

    if (marker === 0xda /* SOS */) {
      // 走査データ本体はそのまま
      out.push(...input.subarray(cursor));
      return { bytes: new Uint8Array(out), removed, hadMetadata: removed > 0 };
    }
  }

  // 終端マーカーが見つからなかった場合も、ここまでを返す
  out.push(...input.subarray(cursor));
  return { bytes: new Uint8Array(out), removed, hadMetadata: removed > 0 };
}

/** APP1 / COM を含む JPEG か（テスト・表示用） */
export function hasJpegMetadata(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (!isJpeg(input)) return false;
  let cursor = 2;
  while (cursor + 3 < input.length) {
    if (input[cursor] !== 0xff) return false;
    const marker = input[cursor + 1];
    if (marker === 0xff) {
      cursor += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return false;
    if (isStandaloneMarker(marker)) {
      cursor += 2;
      continue;
    }
    const length = (input[cursor + 2] << 8) | input[cursor + 3];
    if (length < 2) return false;
    if (marker === 0xe1 || marker === 0xfe) return true;
    cursor += 2 + length;
  }
  return false;
}

/* ==========================================================
   表示・集計
   ========================================================== */

export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 処理結果を集計する。
 * items: [{ inputBytes, outputBytes, skipped }]
 */
export function summarizeResults(items) {
  const list = Array.isArray(items) ? items : [];
  let inputBytes = 0;
  let outputBytes = 0;
  let skipped = 0;
  for (const item of list) {
    inputBytes += Math.max(0, Number(item && item.inputBytes) || 0);
    outputBytes += Math.max(0, Number(item && item.outputBytes) || 0);
    if (item && item.skipped) skipped += 1;
  }
  const ratio = inputBytes > 0 ? outputBytes / inputBytes : 0;
  return {
    count: list.length,
    done: list.length - skipped,
    skipped,
    inputBytes,
    outputBytes,
    savedBytes: inputBytes - outputBytes,
    ratio,
  };
}
