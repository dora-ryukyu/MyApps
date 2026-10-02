import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CATALOG,
  MODEL_KEYS,
  DEFAULT_MODE,
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  getModel,
  listModels,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  clampUnit,
  normalizePoint,
  reshapePoint,
  pointsToFlat,
  buildPointPrompt,
  normalizeBox,
  buildBoxPrompt,
  boxesToCornerPoints,
  buildPrompt,
  extractMaskPlanes,
  maskArea,
  maskIou,
  selectBestMask,
  selectMaskByIou,
  maskBoundingBox,
  computeMaskCrop,
  compositePixels,
  maskPlaneToRGBA,
  buildHandoff,
  serializeHandoff,
  parseHandoff,
  SEGMENT_HANDOFF_KEY,
  formatBytes,
  formatScore,
  sanitizeBaseName,
  buildMaskName,
  buildCutoutName,
  isSupportedImageType,
  hasImageExtension,
  isSupportedImage,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは SlimSAM と ViT-Base の 2 件で、既定は SlimSAM', () => {
  assert.deepEqual(MODEL_KEYS, ['slimsam-77-uniform', 'sam-vit-base']);
  assert.equal(DEFAULT_MODE, 'slimsam-77-uniform');
  assert.equal(MODEL_CATALOG['slimsam-77-uniform'].task, 'mask-generation');
  assert.equal(MODEL_CATALOG['slimsam-77-uniform'].modelId, 'Xenova/slimsam-77-uniform');
  assert.equal(MODEL_CATALOG['sam-vit-base'].modelId, 'Xenova/sam-vit-base');
  assert.equal(listModels().length, 2);
});

test('未知のモデルは例外、listModels はカタログの値を返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.equal(listModels()[0], MODEL_CATALOG[DEFAULT_MODE]);
});

test('両モデルとも Apache-2.0 で商用可', () => {
  for (const key of MODEL_KEYS) {
    assert.equal(MODEL_CATALOG[key].license, 'Apache-2.0');
    assert.equal(MODEL_CATALOG[key].commercial, true);
  }
});

test('dtype はデバイスごとに定義され、重みファイルが存在する', () => {
  for (const key of MODEL_KEYS) {
    const model = MODEL_CATALOG[key];
    for (const device of ['webgpu', 'wasm']) {
      const dtype = resolveDtype(key, device);
      assert.ok(model.files[dtype], `${key}/${device} の dtype ${dtype} が無い`);
    }
    assert.equal(resolveDtype(key, 'webgpu'), 'fp16');
    assert.equal(resolveDtype(key, 'wasm'), 'q8');
  }
});

test('detectDevice は WebGPU の有無で webgpu/wasm を返す', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');
});

test('estimateModelBytes は重み + config の実測値の合計を返す', () => {
  assert.equal(estimateModelBytes('slimsam-77-uniform', 'wasm'), 8882165 + 4903810 + 379 + 466);
  assert.equal(estimateModelBytes('slimsam-77-uniform', 'webgpu'), 12170657 + 8550118 + 379 + 466);
  assert.equal(estimateModelBytes('sam-vit-base', 'wasm'), 101088469 + 4903810 + 440 + 466);
  assert.equal(estimateModelBytes('sam-vit-base', 'webgpu'), 180194619 + 8550118 + 440 + 466);
});

test('chooseModel はデバイスと dtype を決め、凍結した設定を返す', () => {
  const wasm = chooseModel('slimsam-77-uniform', false);
  assert.equal(wasm.device, 'wasm');
  assert.equal(wasm.dtype, 'q8');
  assert.equal(wasm.task, 'mask-generation');
  assert.equal(wasm.bytes, 13786820);
  assert.ok(Object.isFrozen(wasm));

  const gpu = chooseModel('slimsam-77-uniform', true);
  assert.equal(gpu.device, 'webgpu');
  assert.equal(gpu.dtype, 'fp16');
  assert.equal(gpu.bytes, 20721620);
});

/* ==========================================================
   プロンプトの座標変換
   ========================================================== */

test('clampUnit は 0..1 に丸め、非数値は拒否する', () => {
  assert.equal(clampUnit(0.5), 0.5);
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(2), 1);
  assert.equal(clampUnit('0.25'), 0.25);
  assert.throws(() => clampUnit('x'), /数値/);
  assert.throws(() => clampUnit(NaN), /数値/);
});

test('normalizePoint は点を検証して丸める', () => {
  assert.deepEqual(normalizePoint({ x: -1, y: 2 }), { x: 0, y: 1 });
  assert.deepEqual(normalizePoint({ x: 0.3, y: 0.7 }), { x: 0.3, y: 0.7 });
  assert.throws(() => normalizePoint(null), /点が不正/);
});

test('reshapePoint は正規化点をモデル入力の画素座標へ変換する', () => {
  assert.deepEqual(reshapePoint({ x: 0.5, y: 0.25 }, { width: 1024, height: 768 }), {
    x: 512,
    y: 192,
  });
  assert.throws(() => reshapePoint({ x: 0.5, y: 0.5 }, { width: 0, height: 10 }), /寸法/);
});

test('pointsToFlat は座標とラベルを平坦化し、空なら null', () => {
  const flat = pointsToFlat(
    [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.1, label: 0 },
    ],
    { width: 100, height: 200 },
  );
  assert.deepEqual(flat.data, [25, 100, 75, 20]);
  assert.deepEqual(flat.labels, [1, 0]);
  assert.equal(pointsToFlat([], { width: 10, height: 10 }), null);
  assert.throws(() => pointsToFlat('x', { width: 10, height: 10 }), /配列/);
});

test('buildPointPrompt は SAM の入力形状にする', () => {
  const prompt = buildPointPrompt([{ x: 0.5, y: 0.5 }], { width: 100, height: 100 });
  assert.deepEqual(prompt.points.dims, [1, 1, 1, 2]);
  assert.deepEqual(prompt.labels.dims, [1, 1, 1]);
  assert.deepEqual(prompt.points.data, [50, 50]);
  assert.equal(buildPointPrompt([], { width: 10, height: 10 }), null);
});

test('normalizeBox は座標の逆転を直す', () => {
  assert.deepEqual(normalizeBox({ xmin: 0.8, ymin: 0.9, xmax: 0.2, ymax: 0.1 }), {
    xmin: 0.2,
    ymin: 0.1,
    xmax: 0.8,
    ymax: 0.9,
  });
  assert.throws(() => normalizeBox(null), /矩形が不正/);
});

test('buildBoxPrompt は [1, N, 4] の (x1,y1,x2,y2) を作る', () => {
  const prompt = buildBoxPrompt([{ xmin: 0.1, ymin: 0.2, xmax: 0.5, ymax: 0.6 }], {
    width: 1000,
    height: 500,
  });
  assert.deepEqual(prompt.dims, [1, 1, 4]);
  assert.deepEqual(prompt.data, [100, 100, 500, 300]);
  assert.equal(buildBoxPrompt([], { width: 10, height: 10 }), null);
});

test('boxesToCornerPoints は矩形を label 2/3 の 2 点にする', () => {
  const corners = boxesToCornerPoints([{ xmin: 0.1, ymin: 0.2, xmax: 0.5, ymax: 0.6 }], {
    width: 1000,
    height: 500,
  });
  assert.deepEqual(corners.data, [100, 100, 500, 300]);
  assert.deepEqual(corners.labels, [2, 3]);
  assert.equal(boxesToCornerPoints([], { width: 10, height: 10 }), null);
});

test('buildPrompt は点と矩形の 2 隅をまとめ、空なら例外', () => {
  const pointOnly = buildPrompt({
    points: [{ x: 0.5, y: 0.5 }],
    reshapedSize: { width: 100, height: 100 },
  });
  assert.equal(pointOnly.pointCount, 1);
  assert.equal(pointOnly.boxCount, 0);
  assert.deepEqual(pointOnly.inputLabels.data, [1]);

  const boxOnly = buildPrompt({
    boxes: [{ xmin: 0.1, ymin: 0.1, xmax: 0.4, ymax: 0.4 }],
    reshapedSize: { width: 100, height: 100 },
  });
  assert.equal(boxOnly.pointCount, 0);
  assert.equal(boxOnly.boxCount, 1);
  assert.deepEqual(boxOnly.inputPoints.data, [10, 10, 40, 40]);
  assert.deepEqual(boxOnly.inputLabels.data, [2, 3]);
  assert.deepEqual(boxOnly.inputBoxes.data, [10, 10, 40, 40]);

  const combined = buildPrompt({
    points: [{ x: 0.5, y: 0.5 }],
    boxes: [{ xmin: 0.1, ymin: 0.1, xmax: 0.4, ymax: 0.4 }],
    reshapedSize: { width: 100, height: 100 },
  });
  assert.equal(combined.inputLabels.dims[2], 3);

  assert.throws(() => buildPrompt({ reshapedSize: { width: 10, height: 10 } }), /プロンプト/);
});

/* ==========================================================
   マスクの計算
   ========================================================== */

test('extractMaskPlanes は HWC を候補ごとの 0/1 平面に分解する', () => {
  const planes = extractMaskPlanes({
    width: 2,
    height: 2,
    channels: 3,
    data: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
  });
  assert.equal(planes.length, 3);
  assert.deepEqual([...planes[0]], [1, 0, 0, 1]);
  assert.deepEqual([...planes[1]], [0, 1, 0, 1]);
  assert.deepEqual([...planes[2]], [0, 0, 1, 0]);
  assert.throws(() => extractMaskPlanes(null), /不正/);
  assert.throws(
    () => extractMaskPlanes({ width: 0, height: 2, channels: 1, data: [] }),
    /寸法/,
  );
});

test('maskArea / maskIou が正しい', () => {
  const a = Uint8Array.from([1, 1, 0, 0]);
  const b = Uint8Array.from([1, 0, 1, 0]);
  assert.equal(maskArea(a), 2);
  assert.equal(maskIou(a, a), 1);
  assert.equal(maskIou(a, b), 1 / 3);
  assert.equal(maskIou(a, Uint8Array.from([0, 0, 0, 0])), 0);
  assert.throws(() => maskIou(a, Uint8Array.from([1, 0, 0])), /一致/);
});

test('selectBestMask はスコア最大の候補を選ぶ', () => {
  const planes = [
    Uint8Array.from([1, 0, 0, 0]),
    Uint8Array.from([0, 1, 0, 0]),
    Uint8Array.from([0, 0, 1, 0]),
  ];
  assert.deepEqual(selectBestMask(planes, [0.2, 0.9, 0.5]), { index: 1, score: 0.9 });
  assert.deepEqual(selectBestMask(planes, []), { index: 0, score: null });
  assert.deepEqual(selectBestMask(planes, [NaN, NaN, NaN]), { index: 0, score: null });
  assert.throws(() => selectBestMask([], []), /候補マスク/);
});

test('selectMaskByIou は reference と重なる候補から選び、無ければフォールバック', () => {
  const planes = [
    Uint8Array.from([1, 1, 0, 0]),
    Uint8Array.from([0, 0, 1, 1]),
    Uint8Array.from([1, 0, 0, 1]),
  ];
  const reference = Uint8Array.from([1, 1, 0, 0]);
  const picked = selectMaskByIou(planes, [0.9, 0.99, 0.4], reference, 0.5);
  assert.equal(picked.index, 0);
  assert.equal(picked.iou, 1);

  const fallback = selectMaskByIou(planes, [0.9, 0.99, 0.4], Uint8Array.from([0, 0, 0, 0]), 0.5);
  assert.equal(fallback.index, 1);
  assert.equal(fallback.iou, null);

  const noRef = selectMaskByIou(planes, [0.9, 0.99, 0.4], null);
  assert.equal(noRef.index, 1);
  assert.throws(() => selectMaskByIou(planes, [], reference, 2), /IoU/);
});

test('maskBoundingBox は外接矩形を返し、空なら null', () => {
  const plane = new Uint8Array(4 * 4);
  plane[5] = 1;
  plane[6] = 1;
  plane[9] = 1;
  assert.deepEqual(maskBoundingBox(plane, 4, 4), { xmin: 1, ymin: 1, xmax: 3, ymax: 3 });
  assert.equal(maskBoundingBox(new Uint8Array(16), 4, 4), null);
  assert.throws(() => maskBoundingBox(plane, 0, 4), /寸法/);
});

test('computeMaskCrop は余白を足して画像内に収める', () => {
  const plane = new Uint8Array(10 * 10);
  plane[3 * 10 + 3] = 1;
  plane[4 * 10 + 4] = 1;
  assert.deepEqual(computeMaskCrop(plane, 10, 10, 0), { x: 3, y: 3, w: 2, h: 2 });
  assert.deepEqual(computeMaskCrop(plane, 10, 10, 2), { x: 1, y: 1, w: 6, h: 6 });
  assert.equal(computeMaskCrop(new Uint8Array(100), 10, 10), null);
  assert.throws(() => computeMaskCrop(plane, 10, 10, -1), /余白/);
});

test('compositePixels はマスク外を透明にし、invert / opacity / 背景色に対応する', () => {
  const src = Uint8ClampedArray.from([
    10, 20, 30, 255,
    40, 50, 60, 255,
    70, 80, 90, 128,
    1, 2, 3, 4,
  ]);
  const plane = Uint8Array.from([1, 0, 1, 0]);
  const out = compositePixels(src, 2, 2, plane);
  assert.deepEqual([...out.slice(0, 4)], [10, 20, 30, 255]);
  assert.deepEqual([...out.slice(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...out.slice(8, 12)], [70, 80, 90, 128]);

  const inverted = compositePixels(src, 2, 2, plane, { invert: true, background: [9, 9, 9, 7] });
  assert.deepEqual([...inverted.slice(0, 4)], [9, 9, 9, 7]);
  assert.deepEqual([...inverted.slice(4, 8)], [40, 50, 60, 255]);

  const faded = compositePixels(src, 2, 2, plane, { opacity: 0.5 });
  assert.equal(faded[3], 128);
  assert.throws(() => compositePixels(new Uint8ClampedArray(4), 2, 2, plane), /RGBA/);
});

test('maskPlaneToRGBA は前景を色、背景を透過にする', () => {
  const plane = Uint8Array.from([1, 0]);
  const out = maskPlaneToRGBA(plane, 2, 1, { color: [124, 58, 237] });
  assert.deepEqual([...out.slice(0, 4)], [124, 58, 237, 255]);
  assert.deepEqual([...out.slice(4, 8)], [0, 0, 0, 0]);
  assert.throws(() => maskPlaneToRGBA(new Uint8Array(1), 2, 1), /不足/);
});

/* ==========================================================
   受け渡し (handoff)
   ========================================================== */

test('handoff は build → serialize → parse で往復し、壊れた入力は null', () => {
  const handoff = buildHandoff({
    cutoutDataUrl: 'data:image/png;base64,AAAA',
    maskDataUrl: 'data:image/png;base64,BBBB',
    width: 100,
    height: 50,
    sourceName: 'photo.png',
  });
  assert.equal(handoff.version, 1);
  assert.equal(handoff.source, 'segment-anything');
  assert.equal(SEGMENT_HANDOFF_KEY, 'myapps:segment-handoff');

  const parsed = parseHandoff(serializeHandoff(handoff));
  assert.deepEqual(parsed, handoff);

  assert.equal(parseHandoff('not json'), null);
  assert.equal(parseHandoff('{}'), null);
  assert.equal(parseHandoff(JSON.stringify({ cutoutDataUrl: 'x', width: 1, height: 1 })), null);
  assert.throws(() => buildHandoff({ cutoutDataUrl: 'x', width: 1, height: 1 }), /data URL/);
  assert.throws(
    () => buildHandoff({ cutoutDataUrl: 'data:image/png;base64,AA', width: 0, height: 1 }),
    /寸法/,
  );
});

/* ==========================================================
   表示 / ファイル名 / 入力判定
   ========================================================== */

test('formatBytes と formatScore は表記を整える', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(13786820), '13.1 MiB');
  assert.equal(formatBytes(NaN), '-');
  assert.equal(formatScore(0.5), '50%');
  assert.equal(formatScore(0.999), '100%');
  assert.equal(formatScore(undefined), '-');
});

test('sanitizeBaseName / buildMaskName / buildCutoutName', () => {
  assert.equal(sanitizeBaseName('my photo.png'), 'my_photo');
  assert.equal(sanitizeBaseName('/a/b/c.jpg'), 'c');
  assert.equal(sanitizeBaseName(undefined), 'image');
  assert.equal(buildMaskName('photo.jpg'), 'photo-mask.png');
  assert.equal(buildCutoutName('photo.jpg'), 'photo-cutout.png');
});

test('画像形式の判定', () => {
  assert.equal(isSupportedImageType('image/png'), true);
  assert.equal(isSupportedImageType('IMAGE/JPEG'), true);
  assert.equal(isSupportedImageType('application/pdf'), false);
  assert.equal(hasImageExtension('a.webp'), true);
  assert.equal(hasImageExtension('a.heic'), false);
  assert.equal(isSupportedImage({ type: '', name: 'x.png' }), true);
  assert.equal(isSupportedImage({ type: 'application/pdf', name: 'x.pdf' }), false);
  assert.equal(isSupportedImage(null), false);
});

test('依存バージョンと キャッシュ名が固定されている', () => {
  assert.equal(TRANSFORMERS_VERSION, '4.3.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.3.0'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
});
