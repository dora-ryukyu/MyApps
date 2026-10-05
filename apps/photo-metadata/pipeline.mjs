/**
 * pipeline.mjs — 写真メタデータ (EXIF/GPS) アプリの純ロジック
 *
 * DOM に依存しない部分だけをまとめる:
 *   - ファイル形式の判定 (JPEG / PNG / HEIC / TIFF / WebP)
 *   - EXIF タグの分類 (位置情報 / 撮影日時 / 機材 / 作者 / サムネイル)
 *   - keep / remove プランとプリセット
 *   - GPS 座標の少数化と地図リンク
 *   - JPEG セグメント / PNG チャンクの走査とメタデータ除去
 *   - piexif オブジェクトのフィルタリングと JPEG 書き戻し
 *   - exifr の解析結果からの要約 / 削除確認
 *   - CSV / JSON レポート
 *
 * `exifr` / `piexif` は第1引数で受け取る。ブラウザでは CDN の
 * window.exifr / window.piexif を、node --test では npm の
 * exifr / piexifjs を渡す。これにより DOM もバンドラも無しに
 * 「読む → 消す → もう一度読んで残っていないか確認」まで検証できる。
 *
 * 出典:
 *   https://github.com/MikeKovarik/exifr  (MIT, 7.1.3)
 *   https://github.com/hMatoba/piexifjs (MIT, 1.0.6)
 *   https://exiftool.org/TagNames/EXIF.html
 */

/* ==========================================================
   定数
   ========================================================== */

export const APP_ID = 'photo-metadata';

/** 同梱せず CDN から読むライブラリの版と出典 (監査用) */
export const EXIFR_VERSION = '7.1.3';
export const EXIFR_LICENSE = 'MIT';
export const EXIFR_SOURCE = 'https://github.com/MikeKovarik/exifr';
export const PIEXIF_VERSION = '1.0.6';
export const PIEXIF_LICENSE = 'MIT';
export const PIEXIF_SOURCE = 'https://github.com/hMatoba/piexifjs';

/** 読める形式 (exifr が対応) */
export const READABLE_FORMATS = ['jpeg', 'png', 'heic', 'tiff', 'webp'];
/** 書き戻せる形式。HEIC / TIFF / WebP はブラウザ内で安全に書き換えられない */
export const WRITABLE_FORMATS = ['jpeg', 'png'];

export const FORMAT_LABELS = {
  jpeg: 'JPEG',
  png: 'PNG',
  heic: 'HEIC/HEIF',
  tiff: 'TIFF',
  webp: 'WebP',
  unknown: '不明',
};

/* ==========================================================
   EXIF タグの分類
   piexif オブジェクトは数値タグ、exifr の解析結果は名前で扱う。
   ========================================================== */

/** 撮影日時に関係する piexif の数値タグ */
export const DATETIME_TAG_IDS = {
  '0th': [306], // DateTime / ModifyDate
  Exif: [36867, 36868, 36880, 36881, 36882, 37520, 37521, 37522],
};

/** 機材 (カメラ・レンズ・現像ソフト) に関係する piexif の数値タグ */
export const CAMERA_TAG_IDS = {
  '0th': [271, 272, 305], // Make / Model / Software
  Exif: [37500, 42016, 42032, 42033, 42034, 42035, 42036, 42037], // MakerNote / ImageUniqueID / OwnerName / BodySerial / LensSpec / LensMake / LensModel / LensSerial
};

/** 作者・著作権・説明に関係する piexif の数値タグ */
export const AUTHOR_TAG_IDS = {
  '0th': [270, 315, 33432, 40091, 40092, 40093, 40094, 40095], // ImageDescription / Artist / Copyright / XP*
  Exif: [37510], // UserComment
};

/** exifr の解析結果 (名前) を表示カテゴリへ割り当てる */
const NAME_GROUP = {
  latitude: 'gps',
  longitude: 'gps',
  GPSLatitude: 'gps',
  GPSLongitude: 'gps',
  GPSLatitudeRef: 'gps',
  GPSLongitudeRef: 'gps',
  GPSAltitude: 'gps',
  GPSAltitudeRef: 'gps',
  GPSTimeStamp: 'gps',
  GPSDateStamp: 'gps',
  GPSProcessingMethod: 'gps',
  GPSSpeed: 'gps',
  GPSSpeedRef: 'gps',
  GPSImgDirection: 'gps',
  GPSImgDirectionRef: 'gps',
  GPSDestBearing: 'gps',
  GPSDestBearingRef: 'gps',
  GPSHPositioningError: 'gps',
  GPSVersionID: 'gps',
  GPSDifferential: 'gps',
  GPSSatellites: 'gps',
  GPSStatus: 'gps',
  GPSMeasureMode: 'gps',
  GPSDOP: 'gps',
  GPSMapDatum: 'gps',
  GPSAreaInformation: 'gps',

  ModifyDate: 'datetime',
  DateTimeOriginal: 'datetime',
  CreateDate: 'datetime',
  DateTimeDigitized: 'datetime',
  OffsetTime: 'datetime',
  OffsetTimeOriginal: 'datetime',
  OffsetTimeDigitized: 'datetime',
  SubSecTime: 'datetime',
  SubSecTimeOriginal: 'datetime',
  SubSecTimeDigitized: 'datetime',

  Make: 'camera',
  Model: 'camera',
  Software: 'camera',
  LensModel: 'camera',
  LensMake: 'camera',
  LensSerialNumber: 'camera',
  BodySerialNumber: 'camera',
  CameraOwnerName: 'camera',
  LensSpecification: 'camera',
  FNumber: 'camera',
  ApertureValue: 'camera',
  ExposureTime: 'camera',
  ShutterSpeedValue: 'camera',
  ISO: 'camera',
  ISOSpeedRatings: 'camera',
  FocalLength: 'camera',
  FocalLengthIn35mmFormat: 'camera',
  ExposureProgram: 'camera',
  ExposureMode: 'camera',
  MeteringMode: 'camera',
  Flash: 'camera',
  WhiteBalance: 'camera',
  ColorSpace: 'camera',
  ExifImageWidth: 'camera',
  ExifImageHeight: 'camera',
  ImageUniqueID: 'camera',
  MakerNote: 'camera',

  Artist: 'author',
  Copyright: 'author',
  ImageDescription: 'author',
  UserComment: 'author',
  XPTitle: 'author',
  XPComment: 'author',
  XPAuthor: 'author',
  XPKeywords: 'author',
  XPSubject: 'author',
};

/** 表示カテゴリの定義 (UI のチェックボックス順) */
export const CATEGORIES = [
  { key: 'gps', label: '位置情報 (GPS)', hint: '自宅・撮影地の座標', group: 'gps' },
  { key: 'datetime', label: '撮影日時', hint: '撮影した日時・タイムゾーン', group: 'datetime' },
  { key: 'camera', label: '機材・設定', hint: 'メーカー・機種・レンズ・露出', group: 'camera' },
  { key: 'author', label: '作者・著作権', hint: '作者名・コメント・説明', group: 'author' },
  { key: 'thumbnail', label: 'サムネイル', hint: 'EXIF 内蔵の縮小画像', group: 'thumbnail' },
  { key: 'xmp', label: 'XMP', hint: 'Adobe 系の追加メタデータ (GPS を含むことがある)', group: 'xmp' },
  { key: 'iptc', label: 'IPTC / Photoshop', hint: 'キャプション・位置などの旧規格', group: 'iptc' },
  { key: 'comment', label: 'コメント', hint: 'JPEG の COM セグメント', group: 'comment' },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

/** プランのプリセット */
export const PLAN_PRESETS = {
  'keep-all': {
    label: 'すべて保持',
    plan: { gps: true, datetime: true, camera: true, author: true, thumbnail: true, xmp: true, iptc: true, comment: true },
  },
  'remove-gps': {
    label: 'GPS だけ消す',
    plan: { gps: false, datetime: true, camera: true, author: true, thumbnail: true, xmp: true, iptc: true, comment: true },
  },
  'remove-all': {
    label: 'すべて消す',
    plan: { gps: false, datetime: false, camera: false, author: false, thumbnail: false, xmp: false, iptc: false, comment: false },
  },
  'keep-datetime': {
    label: '撮影日時だけ残す',
    plan: { gps: false, datetime: true, camera: false, author: false, thumbnail: false, xmp: false, iptc: false, comment: false },
  },
};

/* ==========================================================
   ユーティリティ
   ========================================================== */

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const n = Math.max(0, Number(bytes));
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** バイト列 → 各文字コード 0-255 のバイナリ文字列 (piexif の入出力形式) */
export function bytesToBinaryString(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return out;
}

/** バイナリ文字列 → Uint8Array */
export function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function ascii(bytes, offset, length) {
  let s = '';
  for (let i = 0; i < length; i += 1) s += String.fromCharCode(bytes[offset + i] || 0);
  return s;
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function matchAscii(bytes, offset, text) {
  return ascii(bytes, offset, text.length) === text;
}

/* ==========================================================
   形式判定
   ========================================================== */

export function detectFormat(bytes) {
  if (!bytes || bytes.length < 12) return 'unknown';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (matchAscii(bytes, 0, 'RIFF') && matchAscii(bytes, 8, 'WEBP')) return 'webp';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00)) {
    return 'tiff';
  }
  if (matchAscii(bytes, 4, 'ftyp')) {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

export function canWrite(format) {
  return WRITABLE_FORMATS.includes(format);
}

/** 選択的なタグ保持ができる形式か (PNG は eXIf を丸ごとしか扱えない) */
export function supportsSelective(format) {
  return format === 'jpeg';
}

/* ==========================================================
   プラン
   ========================================================== */

function defaultPlan() {
  const plan = {};
  for (const key of CATEGORY_KEYS) plan[key] = true;
  return plan;
}

/** 部分プランを既定 (保持) で埋めて正規化する */
export function normalizePlan(plan) {
  const base = defaultPlan();
  if (!plan || typeof plan !== 'object') return base;
  for (const key of CATEGORY_KEYS) {
    if (typeof plan[key] === 'boolean') base[key] = plan[key];
  }
  return base;
}

export function presetPlan(name) {
  const preset = PLAN_PRESETS[name];
  return preset ? normalizePlan(preset.plan) : defaultPlan();
}

/** EXIF (APP1/eXIf) を書き戻す必要があるか */
export function exifWillRemain(plan) {
  const p = normalizePlan(plan);
  return p.gps || p.datetime || p.camera || p.author || p.thumbnail;
}

/** EXIF を新しく作らず丸ごと削除するか */
export function removesAllExif(plan) {
  return !exifWillRemain(plan);
}

/** 人間向けにプランを要約する (例: "GPS を削除 / 他は保持") */
export function summarizePlan(plan) {
  const p = normalizePlan(plan);
  const removed = CATEGORIES.filter((c) => !p[c.key]).map((c) => c.label);
  if (removed.length === 0) return 'すべて保持';
  if (removed.length === CATEGORY_KEYS.length) return 'すべて削除';
  return `${removed.join('・')}を削除`;
}

/* ==========================================================
   GPS
   ========================================================== */

/** 度分秒 ([[d,1],[m,1],[s,1]] 等) を十進度へ */
export function dmsToDecimal(dms) {
  if (!Array.isArray(dms) || dms.length === 0) return null;
  const deg = toNumber(dms[0]);
  const min = dms.length > 1 ? toNumber(dms[1]) : 0;
  const sec = dms.length > 2 ? toNumber(dms[2]) : 0;
  if (deg === null || min === null || sec === null) return null;
  return deg + min / 60 + sec / 3600;
}

function toNumber(value) {
  if (Array.isArray(value) && value.length >= 2) return value[0] / value[1];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** 参照 (N/S/E/W) を符号へ */
export function applyRef(decimal, ref) {
  if (decimal === null || decimal === undefined) return null;
  const r = String(ref || '').toUpperCase();
  if (r === 'S' || r === 'W') return -Math.abs(decimal);
  return decimal;
}

/** exifr の解析結果から十進の緯度経度を取り出す */
export function resolveCoordinates(parsed) {
  if (!parsed) return null;
  let lat = toNumber(parsed.latitude);
  let lon = toNumber(parsed.longitude);
  if (lat === null && parsed.GPSLatitude !== undefined) {
    lat = applyRef(dmsToDecimal(parsed.GPSLatitude), parsed.GPSLatitudeRef);
  }
  if (lon === null && parsed.GPSLongitude !== undefined) {
    lon = applyRef(dmsToDecimal(parsed.GPSLongitude), parsed.GPSLongitudeRef);
  }
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null; // 0,0 は未設定のことが多い
  return { latitude: lat, longitude: lon };
}

export function formatCoordinate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(6);
}

/** 地図へのリンク (ブラウザで開くだけ。画像は送らない) */
export function buildMapLinks(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const q = `${lat},${lon}`;
  return [
    { label: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}` },
    { label: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${q}` },
  ];
}

/* ==========================================================
   JPEG セグメント
   ========================================================== */

const MARKER_NAMES = {
  0xe0: 'APP0',
  0xe1: 'APP1',
  0xe2: 'APP2',
  0xe3: 'APP3',
  0xe4: 'APP4',
  0xe5: 'APP5',
  0xe6: 'APP6',
  0xe7: 'APP7',
  0xe8: 'APP8',
  0xe9: 'APP9',
  0xea: 'APP10',
  0xeb: 'APP11',
  0xec: 'APP12',
  0xed: 'APP13',
  0xee: 'APP14',
  0xef: 'APP15',
  0xfe: 'COM',
  0xda: 'SOS',
  0xd9: 'EOI',
};

export function isJpeg(bytes) {
  return !!bytes && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** APP セグメントの中身から種類を判定する */
export function identifyJpegApp(bytes, marker, dataOffset, dataLength) {
  if (marker === 0xfe) return 'comment';
  if (marker === 0xe1 && dataLength >= 6 && matchAscii(bytes, dataOffset, 'Exif\0\0')) return 'app1-exif';
  if (marker === 0xe1 && dataLength >= 29 && matchAscii(bytes, dataOffset, 'http://ns.adobe.com/xap/1.0/')) return 'app1-xmp';
  if (marker === 0xe2 && dataLength >= 12 && matchAscii(bytes, dataOffset, 'ICC_PROFILE\0')) return 'app2-icc';
  if (marker === 0xed && dataLength >= 14 && matchAscii(bytes, dataOffset, 'Photoshop 3.0\0')) return 'app13-iptc';
  return 'other';
}

/** JPEG のメタデータセグメント (SOS より前) を列挙する */
export function scanJpegSegments(bytes) {
  const segments = [];
  if (!isJpeg(bytes)) return segments;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xda) {
      const len = i + 3 < bytes.length ? ((bytes[i + 2] << 8) | bytes[i + 3]) : 0;
      segments.push({ marker, markerName: 'SOS', kind: 'sos', offset: i, length: 2 + len });
      break;
    }
    if (marker === 0xd9) {
      segments.push({ marker, markerName: 'EOI', kind: 'eoi', offset: i, length: 2 });
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    const dataOffset = i + 4;
    const dataLength = len - 2;
    segments.push({
      marker,
      markerName: MARKER_NAMES[marker] || `0xFF${marker.toString(16).toUpperCase()}`,
      kind: identifyJpegApp(bytes, marker, dataOffset, dataLength),
      offset: i,
      length: 2 + len,
      dataOffset,
      dataLength,
    });
    i += 2 + len;
  }
  return segments;
}

/** JPEG から XMP / IPTC / COM を画素を触らずに取り除く */
export function stripJpegMetadata(bytes, options = {}) {
  const opts = { xmp: false, iptc: false, comment: false, ...options };
  if (!isJpeg(bytes)) return bytes;
  const chunks = [bytes.subarray(0, 2)];
  let i = 2;
  let rest = null;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      rest = bytes.subarray(i);
      break;
    }
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) {
      rest = bytes.subarray(i);
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) {
      rest = bytes.subarray(i);
      break;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const segEnd = i + 2 + len;
    const kind = identifyJpegApp(bytes, marker, i + 4, len - 2);
    const drop =
      (opts.xmp && kind === 'app1-xmp') ||
      (opts.iptc && kind === 'app13-iptc') ||
      (opts.comment && kind === 'comment');
    if (!drop) chunks.push(bytes.subarray(i, Math.min(segEnd, bytes.length)));
    i = segEnd;
  }
  if (rest) chunks.push(rest);
  return concatChunks(chunks);
}

/* ==========================================================
   PNG チャンク
   ========================================================== */

export function isPng(bytes) {
  return (
    !!bytes &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/** PNG のチャンク一覧 (長さ・種類・オフセット) */
export function scanPngChunks(bytes) {
  const chunks = [];
  if (!isPng(bytes)) return chunks;
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = readUint32(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    chunks.push({ type, offset: i, length, total: 12 + length, dataOffset: i + 8 });
    i += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** PNG からメタデータチャンクを除く (iCCP などの色情報は残す) */
export function stripPngMetadata(bytes, options = {}) {
  const opts = { exif: false, text: false, time: false, ...options };
  if (!isPng(bytes)) return bytes;
  const chunks = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = readUint32(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    const total = 12 + length;
    const drop =
      (opts.exif && type === 'eXIf') ||
      (opts.text && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt')) ||
      (opts.time && type === 'tIME');
    if (!drop) chunks.push(bytes.subarray(i, Math.min(i + total, bytes.length)));
    i += total;
    if (type === 'IEND') break;
  }
  if (i < bytes.length) chunks.push(bytes.subarray(i));
  return concatChunks(chunks);
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/* ==========================================================
   piexif オブジェクトのフィルタ / JPEG 書き戻し
   ========================================================== */

function removeTags(exifObj, spec) {
  for (const ifd of Object.keys(spec)) {
    if (!exifObj[ifd]) continue;
    for (const id of spec[ifd]) delete exifObj[ifd][id];
  }
}

export function filterExifObject(exifObject, plan) {
  const p = normalizePlan(plan);
  const out = {};
  for (const ifd of ['0th', 'Exif', 'GPS', 'Interop', '1st']) {
    out[ifd] = { ...((exifObject && exifObject[ifd]) || {}) };
  }
  out.thumbnail = (exifObject && exifObject.thumbnail) || null;

  if (!p.gps) out.GPS = {};
  if (!p.thumbnail) {
    out['1st'] = {};
    out.thumbnail = null;
  }
  if (!p.datetime) removeTags(out, DATETIME_TAG_IDS);
  if (!p.camera) removeTags(out, CAMERA_TAG_IDS);
  if (!p.author) removeTags(out, AUTHOR_TAG_IDS);

  // Interop IFD は日時/機材のどちらかを残す場合のみ意味がある
  if (!p.camera && !p.datetime) out.Interop = {};

  // Exif IFD に何か残すなら ExifVersion を保証する (piexif の整合性)
  if (Object.keys(out.Exif).length > 0 && out.Exif[36864] === undefined) {
    out.Exif[36864] = '0230';
  }
  return out;
}

/** プランに従って JPEG バイト列を書き換える (piexif を注入) */
export function rewriteJpeg(bytes, { plan, exifObject, piexif } = {}) {
  const p = normalizePlan(plan);
  if (!piexif) throw new Error('piexif が必要です');
  if (!isJpeg(bytes)) throw new Error('JPEG ではありません');
  const bin = bytesToBinaryString(bytes);
  let outBin;
  if (exifWillRemain(p)) {
    outBin = piexif.insert(piexif.dump(filterExifObject(exifObject, p)), bin);
  } else {
    outBin = piexif.remove(bin);
  }
  let out = binaryStringToBytes(outBin);
  out = stripJpegMetadata(out, { xmp: !p.xmp, iptc: !p.iptc, comment: !p.comment });
  return out;
}

/**
 * PNG を書き換える。eXIf は 1 つの TIFF ブロックなので選択編集できない。
 * どれか 1 つでも「削除」が指定されていればメタデータチャンクを丸ごと除く。
 */
export function rewritePng(bytes, { plan } = {}) {
  const p = normalizePlan(plan);
  const removeExif = !(p.gps && p.datetime && p.camera && p.author);
  const removeText = !(p.xmp && p.iptc && p.comment);
  const removeTime = !p.datetime;
  return stripPngMetadata(bytes, { exif: removeExif, text: removeText, time: removeTime });
}

/** 対応形式ならプランを適用する。非対応形式は null を返す */
export function rewriteImage(bytes, { plan, exifObject, piexif } = {}) {
  const format = detectFormat(bytes);
  if (format === 'jpeg') return { bytes: rewriteJpeg(bytes, { plan, exifObject, piexif }), format };
  if (format === 'png') return { bytes: rewritePng(bytes, { plan }), format };
  return null;
}

/* ==========================================================
   exifr 解析結果の要約 / 確認
   ========================================================== */

/** 撮影日時を読みやすい文字列にする */
export function formatExifDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    );
  }
  const s = String(value);
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}`;
  return s;
}

export function orientationLabel(value) {
  const n = toNumber(value);
  const table = {
    1: '正常',
    2: '左右反転',
    3: '180° 回転',
    4: '上下反転',
    5: '90° 回転 + 反転',
    6: '90° 回転',
    7: '270° 回転 + 反転',
    8: '270° 回転',
  };
  return n !== null && table[n] ? `${table[n]} (${n})` : null;
}

/** 解析結果を表示用の行 (カテゴリ別) に変換する */
export function groupExifRows(parsed) {
  const groups = { gps: [], datetime: [], camera: [], author: [], other: [] };
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined || value === '') continue;
      const group = NAME_GROUP[key] || 'other';
      groups[group].push({ key, value: formatExifValue(key, value) });
    }
  }
  return {
    groups,
    hasGps: resolveCoordinates(parsed) !== null || groups.gps.length > 0,
    hasExif: parsed !== null && parsed !== undefined && Object.keys(parsed).length > 0,
  };
}

function formatExifValue(key, value) {
  if (value instanceof Date || /Date$/.test(key)) return formatExifDate(value);
  if (key === 'Orientation') return orientationLabel(value) || String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (Array.isArray(value)) return value.map((v) => (v instanceof Date ? formatExifDate(v) : String(v))).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 書き出したファイルを読み直して、消すはずの情報が残っていないか確認する。
 * 返り値は残ってしまったカテゴリのキー配列 (空なら OK)。
 */
export function verifyRemoval(parsed, plan) {
  const p = normalizePlan(plan);
  const leaks = [];
  if (!p.gps && parsed && (resolveCoordinates(parsed) !== null || hasAny(parsed, 'gps'))) leaks.push('gps');
  if (!p.datetime && parsed && hasAny(parsed, 'datetime')) leaks.push('datetime');
  if (!p.camera && parsed && hasAny(parsed, 'camera')) leaks.push('camera');
  if (!p.author && parsed && hasAny(parsed, 'author')) leaks.push('author');
  return leaks;
}

function hasAny(parsed, group) {
  return Object.keys(parsed || {}).some((key) => NAME_GROUP[key] === group);
}

/* ==========================================================
   CSV / JSON レポート
   ========================================================== */

export const REPORT_COLUMNS = [
  { key: 'file', label: 'file' },
  { key: 'format', label: 'format' },
  { key: 'sizeBytes', label: 'size_bytes' },
  { key: 'hasExif', label: 'has_exif' },
  { key: 'hasGps', label: 'has_gps' },
  { key: 'latitude', label: 'latitude' },
  { key: 'longitude', label: 'longitude' },
  { key: 'datetimeOriginal', label: 'datetime_original' },
  { key: 'make', label: 'make' },
  { key: 'model', label: 'model' },
  { key: 'orientation', label: 'orientation' },
  { key: 'software', label: 'software' },
  { key: 'plan', label: 'plan' },
  { key: 'outputBytes', label: 'output_bytes' },
  { key: 'leaks', label: 'leaks' },
  { key: 'status', label: 'status' },
];

/** 1 ファイルの処理結果をレポート行にする */
export function buildReportRow(record) {
  const { file, format, sizeBytes, parsed, plan, outputBytes, leaks, error, status } = record || {};
  const coords = resolveCoordinates(parsed);
  return {
    file: file || '',
    format: FORMAT_LABELS[format] || format || '',
    sizeBytes: sizeBytes ?? '',
    hasExif: parsed ? 'yes' : 'no',
    hasGps: coords ? 'yes' : 'no',
    latitude: coords ? formatCoordinate(coords.latitude) : '',
    longitude: coords ? formatCoordinate(coords.longitude) : '',
    datetimeOriginal: parsed
      ? formatExifDate(parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate) || ''
      : '',
    make: parsed ? parsed.Make || '' : '',
    model: parsed ? parsed.Model || '' : '',
    orientation: parsed ? orientationLabel(parsed.Orientation) || '' : '',
    software: parsed ? parsed.Software || '' : '',
    plan: summarizePlan(plan),
    outputBytes: outputBytes ?? '',
    leaks: Array.isArray(leaks) && leaks.length ? leaks.join('|') : '',
    status: status || (error ? `error: ${error}` : 'ok'),
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows, columns = REPORT_COLUMNS) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = (rows || []).map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...body].join('\r\n');
}

export function toJson(rows) {
  return JSON.stringify(rows || [], null, 2);
}
