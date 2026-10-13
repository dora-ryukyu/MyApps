import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMATS,
  FORMAT_INFO,
  RESIZE_MODES,
  WATERMARK_POSITIONS,
  DEFAULT_QUALITY,
  MAX_DIMENSION,
  formatFromName,
  mimeFromName,
  resolveTargetFormat,
  isLossyFormat,
  qualityApplies,
  clampQuality,
  extensionFor,
  mimeFor,
  sanitizeBaseName,
  stripExtension,
  computeOutputSize,
  buildSequentialName,
  resolveOutputNames,
  normalizeRotation,
  rotationRadians,
  computeWatermarkLayout,
  buildJobPlan,
  isJpeg,
  stripJpegMetadata,
  hasJpegMetadata,
  formatBytes,
  summarizeResults,
} from '../pipeline.mjs';

/* ==========================================================
   テスト用ヘルパー
   ========================================================== */

function seg(marker, payload) {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

function jpegWithExif() {
  const app0 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
  const exif = seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Array(20).fill(7)]);
  const comment = seg(0xfe, [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const sosPayload = [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00];
  const sos = seg(0xda, sosPayload);
  return Uint8Array.from([
    0xff, 0xd8,
    ...app0,
    ...exif,
    ...comment,
    ...sos,
    0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

/* ==========================================================
   形式とファイル名
   ========================================================== */

test('定数は期待どおりの値を含む', () => {
  assert.ok(FORMATS.includes('keep'));
  assert.ok(FORMATS.includes('webp'));
  assert.ok(RESIZE_MODES.includes('long'));
  assert.ok(WATERMARK_POSITIONS.includes('bottom-right'));
  assert.equal(DEFAULT_QUALITY, 0.9);
  assert.ok(MAX_DIMENSION >= 10000);
  assert.equal(FORMAT_INFO.jpeg.ext, '.jpg');
  assert.equal(FORMAT_INFO.png.mime, 'image/png');
});

test('formatFromName は拡張子から形式を推定する', () => {
  assert.equal(formatFromName('photo.JPG'), 'jpeg');
  assert.equal(formatFromName('a.jpeg'), 'jpeg');
  assert.equal(formatFromName('b.png'), 'png');
  assert.equal(formatFromName('c.webp'), 'webp');
  assert.equal(formatFromName('d.avif'), 'avif');
  assert.equal(formatFromName('e.gif'), null);
  assert.equal(formatFromName('noext'), null);
  assert.equal(formatFromName(''), null);
});

test('resolveTargetFormat は keep を元の形式へ解決する', () => {
  assert.equal(resolveTargetFormat('webp', 'a.png'), 'webp');
  assert.equal(resolveTargetFormat('keep', 'a.png'), 'png');
  assert.equal(resolveTargetFormat('keep', 'a.JPG'), 'jpeg');
  assert.equal(resolveTargetFormat('keep', 'a.gif'), 'png');
  assert.equal(resolveTargetFormat('bogus', 'a.png'), 'png');
});

test('extensionFor / mimeFor は形式と元ファイル名から決まる', () => {
  assert.equal(extensionFor('webp', 'a.png'), '.webp');
  assert.equal(extensionFor('keep', 'a.PNG'), '.png');
  assert.equal(extensionFor('keep', 'a.gif'), '.gif');
  assert.equal(extensionFor('keep', 'noext'), '.png');
  assert.equal(mimeFor('avif', 'a.jpg'), 'image/avif');
  assert.equal(mimeFor('keep', 'a.webp'), 'image/webp');
  assert.equal(mimeFor('keep', 'a.xyz'), 'image/png');
  assert.equal(mimeFromName('a.jpeg'), 'image/jpeg');
  assert.equal(mimeFromName('a.gif'), '');
});

test('isLossyFormat / qualityApplies / clampQuality', () => {
  assert.equal(isLossyFormat('jpeg'), true);
  assert.equal(isLossyFormat('png'), false);
  assert.equal(qualityApplies('webp'), true);
  assert.equal(qualityApplies('png'), false);
  assert.equal(clampQuality(0.95), 0.95);
  assert.equal(clampQuality(2), 1);
  assert.equal(clampQuality(0), 0.1);
  assert.equal(clampQuality(Number.NaN), DEFAULT_QUALITY);
  assert.equal(clampQuality(0.877), 0.88);
});

test('sanitizeBaseName / stripExtension', () => {
  assert.equal(sanitizeBaseName('a/b:c*?"<>|d'), 'a_b_c_d');
  assert.equal(sanitizeBaseName('  photo.  '), 'photo');
  assert.equal(sanitizeBaseName(''), '');
  assert.equal(sanitizeBaseName(null), '');
  assert.equal(stripExtension('photo.jpg'), 'photo');
  assert.equal(stripExtension('a.b.png'), 'a.b');
  assert.equal(stripExtension('noext'), 'noext');
  assert.equal(stripExtension('.gitignore'), '.gitignore');
});

/* ==========================================================
   リサイズ
   ========================================================== */

test('computeOutputSize: none は元のサイズ', () => {
  assert.deepEqual(computeOutputSize(1920, 1080, { mode: 'none' }), {
    width: 1920,
    height: 1080,
    scale: 1,
    changed: false,
  });
  assert.deepEqual(computeOutputSize(50, 50), { width: 50, height: 50, scale: 1, changed: false });
});

test('computeOutputSize: long は長辺に合わせ縦横比を保つ', () => {
  assert.deepEqual(computeOutputSize(4000, 3000, { mode: 'long', value: 2000 }), {
    width: 2000,
    height: 1500,
    scale: 0.5,
    changed: true,
  });
  assert.deepEqual(computeOutputSize(3000, 4000, { mode: 'long', value: 2000 }), {
    width: 1500,
    height: 2000,
    scale: 0.5,
    changed: true,
  });
});

test('computeOutputSize: short は短辺に合わせる', () => {
  assert.deepEqual(computeOutputSize(4000, 3000, { mode: 'short', value: 1500 }), {
    width: 2000,
    height: 1500,
    scale: 0.5,
    changed: true,
  });
});

test('computeOutputSize: percent は % 指定', () => {
  assert.deepEqual(computeOutputSize(1000, 500, { mode: 'percent', value: 50 }), {
    width: 500,
    height: 250,
    scale: 0.5,
    changed: true,
  });
});

test('computeOutputSize は既定で拡大しない', () => {
  assert.deepEqual(computeOutputSize(320, 240, { mode: 'long', value: 1920 }), {
    width: 320,
    height: 240,
    scale: 1,
    changed: false,
  });
  const upscaled = computeOutputSize(320, 240, {
    mode: 'long',
    value: 640,
    allowUpscale: true,
  });
  assert.equal(upscaled.width, 640);
  assert.equal(upscaled.height, 480);
  assert.equal(upscaled.changed, true);
});

test('computeOutputSize は不正な入力を 1px 以上に丸める', () => {
  assert.equal(computeOutputSize(0, 0).width, 1);
  assert.equal(computeOutputSize(10, 10, { mode: 'percent', value: 0 }).width, 10);
  assert.equal(computeOutputSize(10, 10, { mode: 'long', value: Number.NaN }).width, 10);
});

/* ==========================================================
   リネーム
   ========================================================== */

test('buildSequentialName は接頭辞 + ゼロ埋め連番 + 拡張子', () => {
  assert.equal(
    buildSequentialName({ prefix: 'trip', index: 0, start: 1, pad: 3, format: 'jpeg' }),
    'trip_001.jpg',
  );
  assert.equal(
    buildSequentialName({ prefix: 'trip', index: 9, start: 1, pad: 2, format: 'webp' }),
    'trip_10.webp',
  );
  assert.equal(
    buildSequentialName({ index: 0, start: 5, pad: 0, format: 'png' }),
    'image_5.png',
  );
  assert.equal(
    buildSequentialName({ prefix: '', index: 0, format: 'png' }),
    'image_001.png',
  );
});

test('buildSequentialName は元名を保つモードを持つ', () => {
  assert.equal(
    buildSequentialName({
      useOriginal: true,
      originalName: 'photo.raw.jpg',
      format: 'webp',
    }),
    'photo.raw.webp',
  );
  assert.equal(
    buildSequentialName({ useOriginal: true, originalName: 'a/b.png', format: 'keep' }),
    'a_b.png',
  );
  assert.equal(
    buildSequentialName({ useOriginal: true, originalName: '.gitignore', format: 'png' }),
    '.gitignore.png',
  );
});

test('resolveOutputNames は重複を (1), (2) で解消する', () => {
  assert.deepEqual(resolveOutputNames(['a.jpg', 'b.jpg', 'a.jpg']), [
    'a.jpg',
    'b.jpg',
    'a (1).jpg',
  ]);
  assert.deepEqual(resolveOutputNames(['x.png', 'X.PNG']), ['x.png', 'X (1).PNG']);
  assert.deepEqual(resolveOutputNames(['noext', 'noext']), ['noext', 'noext (1)']);
  assert.deepEqual(resolveOutputNames(['a', 'a', 'a']), ['a', 'a (1)', 'a (2)']);
});

/* ==========================================================
   透かし
   ========================================================== */

test('normalizeRotation / rotationRadians', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(Number.NaN), 0);
  assert.ok(Math.abs(rotationRadians(180) - Math.PI) < 1e-9);
});

test('computeWatermarkLayout は位置と余白から矩形を決める', () => {
  const base = { canvasWidth: 1000, canvasHeight: 500, watermarkWidth: 100, watermarkHeight: 50 };
  assert.deepEqual(computeWatermarkLayout({ ...base, position: 'top-left', margin: 10 }), {
    x: 10,
    y: 10,
    width: 100,
    height: 50,
  });
  assert.deepEqual(computeWatermarkLayout({ ...base, position: 'bottom-right', margin: 20 }), {
    x: 880,
    y: 430,
    width: 100,
    height: 50,
  });
  assert.deepEqual(computeWatermarkLayout({ ...base, position: 'center' }), {
    x: 450,
    y: 225,
    width: 100,
    height: 50,
  });
});

test('computeWatermarkLayout は scale を適用し、はみ出しを抑える', () => {
  const scaled = computeWatermarkLayout({
    canvasWidth: 1000,
    canvasHeight: 500,
    watermarkWidth: 100,
    watermarkHeight: 50,
    position: 'bottom-right',
    margin: 10,
    scale: 2,
  });
  assert.equal(scaled.width, 200);
  assert.equal(scaled.height, 100);
  assert.equal(scaled.x, 790);
  assert.equal(scaled.y, 390);

  const clamped = computeWatermarkLayout({
    canvasWidth: 100,
    canvasHeight: 100,
    watermarkWidth: 400,
    watermarkHeight: 400,
    position: 'bottom-right',
    margin: 10,
  });
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 400);
});

/* ==========================================================
   処理方針
   ========================================================== */

test('buildJobPlan はリサイズ・形式変換・連番をまとめて決める', () => {
  const entries = [
    { id: 'a', name: 'a.jpg', width: 4000, height: 3000 },
    { id: 'b', name: 'b.jpg', width: 800, height: 600 },
  ];
  const plan = buildJobPlan(entries, {
    resize: { mode: 'long', value: 2000 },
    format: 'webp',
    rename: { mode: 'sequence', prefix: 'trip', start: 1, pad: 3 },
    watermark: { enabled: false },
    stripMetadata: true,
  });

  assert.equal(plan.length, 2);
  assert.equal(plan[0].outputName, 'trip_001.webp');
  assert.equal(plan[0].targetFormat, 'webp');
  assert.equal(plan[0].width, 2000);
  assert.equal(plan[0].height, 1500);
  assert.equal(plan[0].resizeChanged, true);
  assert.equal(plan[0].passthrough, false);

  assert.equal(plan[1].outputName, 'trip_002.webp');
  assert.equal(plan[1].width, 800);
  assert.equal(plan[1].resizeChanged, false);
  assert.equal(plan[1].passthrough, false, '形式が変わるので再エンコード');
});

test('buildJobPlan は変更が無い JPEG を passthrough にする', () => {
  const entries = [{ id: 0, name: 'photo.jpeg', width: 1000, height: 800 }];
  const plan = buildJobPlan(entries, {
    resize: { mode: 'none', value: 0 },
    format: 'keep',
    rename: { mode: 'keep' },
    watermark: { enabled: false },
    stripMetadata: true,
  });
  assert.equal(plan[0].passthrough, true);
  assert.equal(plan[0].outputName, 'photo.jpeg');
  assert.equal(plan[0].stripMetadata, true);
});

test('buildJobPlan は透かしがあれば passthrough にしない', () => {
  const plan = buildJobPlan([{ id: 0, name: 'photo.png', width: 500, height: 500 }], {
    resize: { mode: 'none' },
    format: 'keep',
    rename: { mode: 'keep' },
    watermark: { enabled: true },
    stripMetadata: false,
  });
  assert.equal(plan[0].passthrough, false);
  assert.equal(plan[0].watermark, true);
  assert.equal(plan[0].targetFormat, 'png');
});

test('buildJobPlan は同名の出力を衝突回避する', () => {
  const entries = [
    { id: 0, name: 'same.jpg', width: 100, height: 100 },
    { id: 1, name: 'same.jpg', width: 100, height: 100 },
  ];
  const plan = buildJobPlan(entries, {
    resize: { mode: 'none' },
    format: 'keep',
    rename: { mode: 'keep' },
    stripMetadata: false,
  });
  assert.deepEqual(
    plan.map((job) => job.outputName),
    ['same.jpg', 'same (1).jpg'],
  );
});

/* ==========================================================
   JPEG メタデータ
   ========================================================== */

test('isJpeg は SOI マーカーを見る', () => {
  assert.equal(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), true);
  assert.equal(isJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isJpeg(new Uint8Array(0)), false);
});

test('hasJpegMetadata / stripJpegMetadata は APP1 と COM を落とす', () => {
  const original = jpegWithExif();
  assert.equal(hasJpegMetadata(original), true);

  const { bytes, removed, hadMetadata } = stripJpegMetadata(original);
  assert.equal(removed, 2, 'APP1 と COM の 2 セグメントを除去');
  assert.equal(hadMetadata, true);
  assert.equal(hasJpegMetadata(bytes), false, '除去後はメタデータが無い');

  // SOI で始まり EOI で終わり、APP0 (JFIF) と走査データが残る
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[bytes.length - 2], 0xff);
  assert.equal(bytes[bytes.length - 1], 0xd9);
  const jfif = String.fromCharCode(...bytes.subarray(6, 10));
  assert.equal(jfif, 'JFIF');
  const scanIndex = bytes.findIndex((b, i) => b === 0x11 && bytes[i + 1] === 0x22);
  assert.ok(scanIndex > 0, '走査データが残っている');
  assert.ok(bytes.length < original.length);
});

test('stripJpegMetadata は JPEG 以外をそのまま返す', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const result = stripJpegMetadata(png);
  assert.equal(result.removed, 0);
  assert.equal(result.hadMetadata, false);
  assert.deepEqual([...result.bytes], [...png]);
});

test('stripJpegMetadata はメタデータの無い JPEG を変えない', () => {
  const app0 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
  const sos = seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const plain = Uint8Array.from([0xff, 0xd8, ...app0, ...sos, 0x55, 0xff, 0xd9]);
  const { bytes, removed } = stripJpegMetadata(plain);
  assert.equal(removed, 0);
  assert.deepEqual([...bytes], [...plain]);
});

/* ==========================================================
   表示・集計
   ========================================================== */

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('summarizeResults は合計と削減量を返す', () => {
  const result = summarizeResults([
    { inputBytes: 1000, outputBytes: 400 },
    { inputBytes: 2000, outputBytes: 2500, skipped: true },
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.done, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.inputBytes, 3000);
  assert.equal(result.outputBytes, 2900);
  assert.equal(result.savedBytes, 100);
  assert.ok(Math.abs(result.ratio - 2900 / 3000) < 1e-9);

  const empty = summarizeResults([]);
  assert.equal(empty.ratio, 0);
  assert.equal(empty.count, 0);
});
