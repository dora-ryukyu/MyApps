import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  detectFormat,
  canWrite,
  supportsSelective,
  formatBytes,
  bytesToBinaryString,
  binaryStringToBytes,
  normalizePlan,
  presetPlan,
  exifWillRemain,
  removesAllExif,
  summarizePlan,
  CATEGORY_KEYS,
  CATEGORIES,
  dmsToDecimal,
  applyRef,
  resolveCoordinates,
  formatCoordinate,
  buildMapLinks,
  isJpeg,
  scanJpegSegments,
  stripJpegMetadata,
  isPng,
  scanPngChunks,
  stripPngMetadata,
  filterExifObject,
  rewriteJpeg,
  rewritePng,
  rewriteImage,
  formatExifDate,
  orientationLabel,
  groupExifRows,
  verifyRemoval,
  buildReportRow,
  toCsv,
  toJson,
  REPORT_COLUMNS,
  EXIFR_VERSION,
  PIEXIF_VERSION,
} from '../pipeline.mjs';

const require = createRequire(import.meta.url);
const piexif = require('piexifjs');
const exifr = require('exifr');

/* ==========================================================
   テスト用データ
   ========================================================== */

// 1x1 の白 JPEG (EXIF 無し)。piexif の insert/remove の土台に使う。
const BASE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function baseJpegBytes() {
  return new Uint8Array(Buffer.from(BASE_JPEG_B64, 'base64'));
}

function asciiBytes(text) {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

function segment(marker, payload) {
  const len = payload.length + 2;
  return Uint8Array.from([0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sampleExifObject() {
  return {
    '0th': { 271: 'TestMake', 272: 'TestModel', 305: 'TestSoft', 306: '2026:10:04 12:00:00', 274: 1, 315: 'howl' },
    Exif: { 36864: '0230', 36867: '2026:10:04 12:00:00', 42036: 'LensX', 37510: 'secret note' },
    GPS: { 1: 'N', 2: [[35, 1], [41, 1], [1, 1]], 3: 'E', 4: [[139, 1], [46, 1], [1, 1]] },
    Interop: {},
    '1st': {},
    thumbnail: null,
  };
}

/* ==========================================================
   形式判定 / 基本
   ========================================================== */

test('detectFormat は各形式の署名を判定する', () => {
  assert.equal(detectFormat(baseJpegBytes()), 'jpeg');
  assert.equal(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'png');
  assert.equal(detectFormat(asciiBytes('RIFF....WEBP')), 'webp');
  assert.equal(detectFormat(concat(asciiBytes('\x00\x00\x00\x18ftypheic'), new Uint8Array(8))), 'heic');
  assert.equal(detectFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), 'tiff');
  assert.equal(detectFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), 'unknown');
});

test('canWrite / supportsSelective は JPEG と PNG を区別する', () => {
  assert.equal(canWrite('jpeg'), true);
  assert.equal(canWrite('png'), true);
  assert.equal(canWrite('heic'), false);
  assert.equal(canWrite('tiff'), false);
  assert.equal(supportsSelective('jpeg'), true);
  assert.equal(supportsSelective('png'), false);
});

test('formatBytes は単位を丸める', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(null), '—');
});

test('バイナリ文字列との相互変換は往復する', () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 200, 255]);
  const bin = bytesToBinaryString(bytes);
  assert.equal(bin.length, 6);
  assert.deepEqual([...binaryStringToBytes(bin)], [...bytes]);
});

/* ==========================================================
   プラン
   ========================================================== */

test('normalizePlan は欠けたキーを保持で埋める', () => {
  const p = normalizePlan({ gps: false });
  assert.equal(p.gps, false);
  for (const key of CATEGORY_KEYS) {
    if (key !== 'gps') assert.equal(p[key], true);
  }
});

test('presetPlan はプリセットを返す', () => {
  assert.equal(removesAllExif(presetPlan('remove-all')), true);
  const removeGps = presetPlan('remove-gps');
  assert.equal(removeGps.gps, false);
  assert.equal(removeGps.datetime, true);
  assert.equal(exifWillRemain(removeGps), true);
  const keepDate = presetPlan('keep-datetime');
  assert.equal(keepDate.datetime, true);
  assert.equal(keepDate.camera, false);
});

test('summarizePlan は削除対象を並べる', () => {
  assert.equal(summarizePlan(presetPlan('keep-all')), 'すべて保持');
  assert.equal(summarizePlan(presetPlan('remove-all')), 'すべて削除');
  assert.equal(summarizePlan(presetPlan('remove-gps')), '位置情報 (GPS)を削除');
});

test('CATEGORIES は 8 カテゴリを定義する', () => {
  assert.equal(CATEGORIES.length, 8);
  for (const key of ['gps', 'datetime', 'camera', 'author', 'thumbnail', 'xmp', 'iptc', 'comment']) {
    assert.ok(CATEGORY_KEYS.includes(key), `${key} が無い`);
  }
});

/* ==========================================================
   GPS
   ========================================================== */

test('dmsToDecimal / applyRef は座標を十進にする', () => {
  const lat = dmsToDecimal([[35, 1], [41, 1], [1, 1]]);
  assert.ok(Math.abs(lat - (35 + 41 / 60 + 1 / 3600)) < 1e-9);
  assert.equal(applyRef(lat, 'N'), lat);
  assert.equal(applyRef(lat, 'S'), -lat);
  assert.equal(applyRef(139.7, 'W'), -139.7);
  assert.equal(dmsToDecimal([]), null);
});

test('resolveCoordinates は latitude/longitude と GPS 配列の両方に対応する', () => {
  assert.deepEqual(resolveCoordinates({ latitude: 35.5, longitude: 139.5 }), { latitude: 35.5, longitude: 139.5 });
  const fromDms = resolveCoordinates({
    GPSLatitude: [[35, 1], [41, 1], [1, 1]],
    GPSLatitudeRef: 'N',
    GPSLongitude: [[139, 1], [46, 1], [1, 1]],
    GPSLongitudeRef: 'E',
  });
  assert.ok(Math.abs(fromDms.latitude - 35.68361) < 1e-4);
  assert.ok(Math.abs(fromDms.longitude - 139.76694) < 1e-4);
  assert.equal(resolveCoordinates({ latitude: 0, longitude: 0 }), null);
  assert.equal(resolveCoordinates({}), null);
  assert.equal(resolveCoordinates(null), null);
});

test('formatCoordinate / buildMapLinks は表示とリンクを作る', () => {
  assert.equal(formatCoordinate(35.6836111), '35.683611');
  assert.equal(formatCoordinate(undefined), '—');
  const links = buildMapLinks(35.68, 139.76);
  assert.equal(links.length, 2);
  assert.ok(links[0].url.includes('openstreetmap.org'));
  assert.ok(links[1].url.includes('google.com/maps'));
  assert.deepEqual(buildMapLinks(NaN, 1), []);
});

/* ==========================================================
   JPEG セグメント
   ========================================================== */

function sampleJpegWithMetadata() {
  const exifPayload = concat(asciiBytes('Exif\0\0'), asciiBytes('dummy-exif'));
  const xmpPayload = concat(asciiBytes('http://ns.adobe.com/xap/1.0/'), asciiBytes('<xmp/>'));
  const iptcPayload = concat(asciiBytes('Photoshop 3.0\0'), asciiBytes('iptc'));
  return concat(
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, asciiBytes('JFIF\0')),
    segment(0xe1, exifPayload),
    segment(0xe1, xmpPayload),
    segment(0xe2, concat(asciiBytes('ICC_PROFILE\0'), asciiBytes('iccdata'))),
    segment(0xed, iptcPayload),
    segment(0xfe, asciiBytes('a comment')),
    segment(0xda, asciiBytes('sos-header')),
    asciiBytes('image-data'),
    new Uint8Array([0xff, 0xd9]),
  );
}

test('scanJpegSegments は APP セグメントと種類を列挙する', () => {
  const segments = scanJpegSegments(sampleJpegWithMetadata());
  const kinds = segments.map((s) => s.kind);
  assert.ok(kinds.includes('app1-exif'));
  assert.ok(kinds.includes('app1-xmp'));
  assert.ok(kinds.includes('app2-icc'));
  assert.ok(kinds.includes('app13-iptc'));
  assert.ok(kinds.includes('comment'));
  assert.ok(kinds.includes('sos'));
  const exif = segments.find((s) => s.kind === 'app1-exif');
  assert.equal(exif.markerName, 'APP1');
  assert.ok(exif.length > 2);
});

test('stripJpegMetadata は画素と ICC を残しメタデータ種別だけ除く', () => {
  const input = sampleJpegWithMetadata();
  const out = stripJpegMetadata(input, { xmp: true, iptc: true, comment: true });
  assert.ok(isJpeg(out));
  const kinds = scanJpegSegments(out).map((s) => s.kind);
  assert.ok(!kinds.includes('app1-xmp'), 'XMP が残っている');
  assert.ok(!kinds.includes('app13-iptc'), 'IPTC が残っている');
  assert.ok(!kinds.includes('comment'), 'COM が残っている');
  assert.ok(kinds.includes('app1-exif'), 'EXIF まで消してはいけない');
  assert.ok(kinds.includes('app2-icc'), 'ICC を消してはいけない');
  assert.ok(kinds.includes('sos'), '画像データを壊してはいけない');
  const text = (b) => String.fromCharCode(...b);
  assert.ok(!text(out).includes('a comment'));
  assert.ok(text(out).includes('iccdata'));
});

test('stripJpegMetadata は指定しないメタデータを保持する', () => {
  const input = sampleJpegWithMetadata();
  const out = stripJpegMetadata(input, { comment: true });
  const kinds = scanJpegSegments(out).map((s) => s.kind);
  assert.ok(kinds.includes('app1-xmp'), 'XMP を消してしまった');
  assert.ok(kinds.includes('app13-iptc'), 'IPTC を消してしまった');
  assert.ok(!kinds.includes('comment'), 'COM が残っている');
});

/* ==========================================================
   PNG チャンク
   ========================================================== */

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function samplePng() {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat(
    sig,
    pngChunk('IHDR', new Uint8Array(13)),
    pngChunk('iCCP', asciiBytes('color-profile')),
    pngChunk('eXIf', asciiBytes('exif-block')),
    pngChunk('tEXt', asciiBytes('Comment\0secret')),
    pngChunk('tIME', new Uint8Array(7)),
    pngChunk('IDAT', asciiBytes('pixels')),
    pngChunk('IEND', new Uint8Array(0)),
  );
}

test('scanPngChunks / stripPngMetadata は色情報を残しメタデータを除く', () => {
  const input = samplePng();
  assert.equal(isPng(input), true);
  const types = scanPngChunks(input).map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'iCCP', 'eXIf', 'tEXt', 'tIME', 'IDAT', 'IEND']);

  const out = stripPngMetadata(input, { exif: true, text: true, time: true });
  const outTypes = scanPngChunks(out).map((c) => c.type);
  assert.deepEqual(outTypes, ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.ok(String.fromCharCode(...out).includes('color-profile'), 'iCCP を消してはいけない');
  assert.ok(String.fromCharCode(...out).includes('pixels'), 'IDAT を消してはいけない');
});

test('rewritePng は選択編集が要る場合 eXIf を丸ごと除くが他は保持する', () => {
  const input = samplePng();
  const out = rewritePng(input, { plan: presetPlan('remove-gps') });
  const types = scanPngChunks(out).map((c) => c.type);
  assert.ok(!types.includes('eXIf'), 'eXIf が残っている');
  assert.ok(types.includes('tEXt'), 'GPS だけの削除でテキストまで消してはいけない');
  assert.ok(types.includes('iCCP'));
});

test('rewritePng (remove-all) は tEXt も tIME も除く', () => {
  const input = samplePng();
  const out = rewritePng(input, { plan: presetPlan('remove-all') });
  const types = scanPngChunks(out).map((c) => c.type);
  for (const t of ['eXIf', 'tEXt', 'tIME']) assert.ok(!types.includes(t), `${t} が残っている`);
  assert.deepEqual(types, ['IHDR', 'iCCP', 'IDAT', 'IEND']);
});

/* ==========================================================
   piexif オブジェクトのフィルタ
   ========================================================== */

test('filterExifObject は GPS/日時/機材/作者/サムネイルを個別に除く', () => {
  const src = sampleExifObject();
  const removeGps = filterExifObject(src, presetPlan('remove-gps'));
  assert.deepEqual(removeGps.GPS, {});
  assert.equal(removeGps['0th'][271], 'TestMake');
  assert.equal(removeGps.Exif[36867], '2026:10:04 12:00:00');

  const keepOnlyDate = filterExifObject(src, presetPlan('keep-datetime'));
  assert.equal(keepOnlyDate['0th'][306], '2026:10:04 12:00:00');
  assert.equal(keepOnlyDate['0th'][271], undefined, 'Make が残っている');
  assert.equal(keepOnlyDate.Exif[42036], undefined, 'LensModel が残っている');
  assert.deepEqual(keepOnlyDate.GPS, {});
  assert.equal(keepOnlyDate.Exif[36864], '0230', 'ExifVersion が保証されていない');

  const removeAll = filterExifObject(src, presetPlan('remove-all'));
  assert.deepEqual(removeAll.GPS, {});
  for (const id of [36867, 42036, 37510]) {
    assert.equal(removeAll.Exif[id], undefined, `Exif タグ ${id} が残っている`);
  }
  for (const id of [271, 272, 305, 306, 315]) {
    assert.equal(removeAll['0th'][id], undefined, `タグ ${id} が残っている`);
  }
  // Orientation (274) は表示の向きに関わる構造情報なので保持する
  assert.equal(removeAll['0th'][274], 1);
});

test('filterExifObject は元オブジェクトを破壊しない', () => {
  const src = sampleExifObject();
  const snapshot = JSON.parse(JSON.stringify(src));
  filterExifObject(src, presetPlan('remove-all'));
  assert.deepEqual(JSON.parse(JSON.stringify(src)), snapshot);
});

/* ==========================================================
   要約 / 確認
   ========================================================== */

test('formatExifDate / orientationLabel は表示用に整える', () => {
  assert.equal(formatExifDate('2026:10:04 12:30:00'), '2026-10-04 12:30:00');
  assert.equal(orientationLabel(6), '90° 回転 (6)');
  assert.equal(orientationLabel(1), '正常 (1)');
  assert.equal(orientationLabel(99), null);
});

test('groupExifRows はカテゴリ別にまとめ GPS 有無を返す', () => {
  const { groups, hasGps, hasExif } = groupExifRows({
    Make: 'Canon',
    DateTimeOriginal: '2026:10:04 12:00:00',
    latitude: 35.68,
    longitude: 139.76,
  });
  assert.equal(hasExif, true);
  assert.equal(hasGps, true);
  assert.equal(groups.camera.length, 1);
  assert.equal(groups.datetime.length, 1);
  assert.equal(groups.gps.length, 2);
});

test('verifyRemoval は残ってしまったカテゴリを返す', () => {
  const parsed = { latitude: 35.68, longitude: 139.76, Make: 'Canon', DateTimeOriginal: '2026:10:04 12:00:00' };
  assert.deepEqual(verifyRemoval(parsed, presetPlan('remove-all')).sort(), ['camera', 'datetime', 'gps']);
  assert.deepEqual(verifyRemoval(parsed, presetPlan('remove-gps')).sort(), ['gps']);
  assert.deepEqual(verifyRemoval(null, presetPlan('remove-all')), []);
});

/* ==========================================================
   レポート
   ========================================================== */

test('buildReportRow / toCsv / toJson は処理結果を書き出す', () => {
  const row = buildReportRow({
    file: 'a.jpg',
    format: 'jpeg',
    sizeBytes: 2048,
    parsed: { latitude: 35.68, longitude: 139.76, Make: 'Canon', Model: 'X', DateTimeOriginal: '2026:10:04 12:00:00' },
    plan: presetPlan('remove-gps'),
    outputBytes: 1800,
    leaks: [],
    status: 'ok',
  });
  assert.equal(row.hasGps, 'yes');
  assert.equal(row.make, 'Canon');
  assert.equal(row.plan, '位置情報 (GPS)を削除');

  const csv = toCsv([row]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], REPORT_COLUMNS.map((c) => c.label).join(','));
  assert.ok(lines[1].includes('a.jpg'));
  assert.ok(lines[1].includes('2026-10-04 12:00:00'));

  const json = JSON.parse(toJson([row]));
  assert.equal(json.length, 1);
  assert.equal(json[0].format, 'JPEG');
});

test('toCsv はカンマ・引用符・改行をエスケープする', () => {
  const csv = toCsv([{ file: 'a,"b"\nc.jpg' }], [{ key: 'file', label: 'file' }]);
  assert.equal(csv, 'file\r\n"a,""b""\nc.jpg"');
});

/* ==========================================================
   実ライブラリでの往復 (読む → 消す → 確認)
   ========================================================== */

function buildJpegWithExif() {
  const bin = bytesToBinaryString(baseJpegBytes());
  return Uint8Array.from(Buffer.from(piexif.insert(piexif.dump(sampleExifObject()), bin), 'latin1'));
}

test('exifr は作成した EXIF を読める', async () => {
  const withExif = buildJpegWithExif();
  const parsed = await exifr.parse(withExif, { tiff: true, exif: true, gps: true, interop: true, reviveValues: false });
  assert.equal(parsed.Make, 'TestMake');
  assert.ok(Math.abs(parsed.latitude - 35.68361) < 1e-4);
});

test('rewriteJpeg (remove-all) は GPS と全 EXIF を消し画像を保つ', async () => {
  const withExif = buildJpegWithExif();
  const original = baseJpegBytes();
  const exifObject = piexif.load(bytesToBinaryString(withExif));

  const out = rewriteJpeg(withExif, { plan: presetPlan('remove-all'), exifObject, piexif });

  const parsed = await exifr.parse(out, { tiff: true, exif: true, gps: true, interop: true, xmp: true, iptc: true, reviveValues: false });
  assert.equal(parsed, undefined, 'EXIF が残っている');
  assert.deepEqual([...out], [...original], '画素 (画像データ) が変化している');
  const kinds = scanJpegSegments(out).map((s) => s.kind);
  assert.ok(!kinds.includes('app1-exif'));
});

test('rewriteJpeg (remove-gps) は GPS だけ消して日時と機材を残す', async () => {
  const withExif = buildJpegWithExif();
  const exifObject = piexif.load(bytesToBinaryString(withExif));
  const out = rewriteJpeg(withExif, { plan: presetPlan('remove-gps'), exifObject, piexif });

  const parsed = await exifr.parse(out, { tiff: true, exif: true, gps: true, interop: true, reviveValues: false });
  assert.equal(resolveCoordinates(parsed), null, 'GPS が残っている');
  assert.equal(parsed.Make, 'TestMake', '機材を消してしまった');
  assert.equal(parsed.DateTimeOriginal, '2026:10:04 12:00:00', '日時を消してしまった');
  assert.deepEqual(verifyRemoval(parsed, presetPlan('remove-gps')), []);
});

test('rewriteJpeg (keep-datetime) は日時だけ残す', async () => {
  const withExif = buildJpegWithExif();
  const exifObject = piexif.load(bytesToBinaryString(withExif));
  const out = rewriteJpeg(withExif, { plan: presetPlan('keep-datetime'), exifObject, piexif });

  const parsed = await exifr.parse(out, { tiff: true, exif: true, gps: true, interop: true, reviveValues: false });
  assert.equal(parsed.DateTimeOriginal, '2026:10:04 12:00:00');
  assert.equal(parsed.Make, undefined, '機材が残っている');
  assert.equal(resolveCoordinates(parsed), null, 'GPS が残っている');
});

test('rewriteImage は非対応形式で null を返す', () => {
  const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(rewriteImage(tiff, { plan: presetPlan('remove-all'), piexif }), null);
  const png = samplePng();
  const result = rewriteImage(png, { plan: presetPlan('remove-all'), piexif });
  assert.equal(result.format, 'png');
  assert.ok(isPng(result.bytes));
});

test('ライブラリの版を記録している', () => {
  assert.equal(EXIFR_VERSION, '7.1.3');
  assert.equal(PIEXIF_VERSION, '1.0.6');
});
