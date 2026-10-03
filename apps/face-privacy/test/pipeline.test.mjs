import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIAPIPE_VERSION,
  MEDIAPIPE_MODULE_URL,
  MEDIAPIPE_WASM_URL,
  CACHE_NAME,
  CACHE_PREFIX,
  RUNTIME_BYTES,
  MODEL_CATALOG,
  MODEL_KEYS,
  DEFAULT_MODE,
  DEFAULT_CONFIDENCE,
  DEFAULT_SUPPRESSION,
  getModel,
  listModels,
  chooseRuntime,
  estimateDownloadBytes,
  chooseModel,
  clampBox,
  boxArea,
  intersectionArea,
  iou,
  unionBox,
  expandBox,
  isNear,
  mergeBoxes,
  toPixelRegion,
  keypointsToPixels,
  detectionToBox,
  parseDetections,
  buildRegions,
  computeBlurRadius,
  computeBlurKernel,
  computeMosaicTile,
  emojiFontSize,
  REDACTION_MODES,
  MODE_KEYS,
  DEFAULT_REDACTION,
  getMode,
  EMOJI_CHOICES,
  fillRegion,
  mosaicRegion,
  blurRegion,
  applyRedaction,
  applyRedactions,
  formatBytes,
  formatScore,
  sanitizeBaseName,
  buildDownloadName,
  buildZipName,
  isSupportedImageType,
  hasImageExtension,
  isSupportedImage,
} from '../pipeline.mjs';

/* ==========================================================
   ヘルパー
   ========================================================== */

function makeImage(width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  return { data, width, height };
}

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは BlazeFace 1 件で、既定と一致する', () => {
  assert.deepEqual(MODEL_KEYS, ['blaze-face-short-range']);
  assert.equal(DEFAULT_MODE, 'blaze-face-short-range');
  assert.equal(MODEL_CATALOG['blaze-face-short-range'].modelId, 'blaze_face_short_range');
  assert.equal(listModels().length, 1);
});

test('未知のモデルは例外、listModels はカタログの値を返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.equal(listModels()[0], MODEL_CATALOG[DEFAULT_MODE]);
});

test('ライセンスは Apache-2.0 で商用可、モデルは実測バイト数を持つ', () => {
  const model = MODEL_CATALOG['blaze-face-short-range'];
  assert.equal(model.license, 'Apache-2.0');
  assert.equal(model.commercial, true);
  assert.equal(model.bytes, 229746);
  assert.ok(model.url.endsWith('blaze_face_short_range.tflite'));
});

test('chooseRuntime は WebGL2 の有無で GPU/CPU を返す', () => {
  assert.equal(chooseRuntime(true), 'GPU');
  assert.equal(chooseRuntime(false), 'CPU');
  assert.equal(chooseRuntime(undefined), 'CPU');
});

test('estimateDownloadBytes はモデル + ランタイムの合計を返す', () => {
  assert.equal(estimateDownloadBytes('blaze-face-short-range'), 229746 + RUNTIME_BYTES);
  assert.equal(RUNTIME_BYTES, 155439 + 323415 + 11756972);
});

test('chooseModel は delegate を決め、凍結した設定を返す', () => {
  const cpu = chooseModel('blaze-face-short-range', false);
  assert.equal(cpu.delegate, 'CPU');
  assert.equal(cpu.bytes, 229746 + RUNTIME_BYTES);
  assert.ok(Object.isFrozen(cpu));

  const gpu = chooseModel('blaze-face-short-range', true);
  assert.equal(gpu.delegate, 'GPU');
  assert.equal(gpu.license, 'Apache-2.0');
});

test('依存バージョンとキャッシュ名が固定されている', () => {
  assert.equal(MEDIAPIPE_VERSION, '1.0.1');
  assert.ok(MEDIAPIPE_MODULE_URL.includes('@1.0.1/vision_bundle.mjs'));
  assert.ok(MEDIAPIPE_WASM_URL.endsWith('@1.0.1/wasm'));
  assert.equal(CACHE_NAME, 'face-privacy-cache');
  assert.equal(CACHE_PREFIX, 'face-privacy');
  assert.equal(DEFAULT_CONFIDENCE, 0.5);
  assert.equal(DEFAULT_SUPPRESSION, 0.3);
});

/* ==========================================================
   矩形
   ========================================================== */

test('clampBox は逆転を直し、画像内に収めて整数に丸める', () => {
  assert.deepEqual(clampBox({ xmin: 8, ymin: 8, xmax: 2, ymax: 2 }), {
    xmin: 2,
    ymin: 2,
    xmax: 8,
    ymax: 8,
  });
  assert.deepEqual(clampBox({ xmin: -5, ymin: -5, xmax: 20, ymax: 20 }, 10, 10), {
    xmin: 0,
    ymin: 0,
    xmax: 10,
    ymax: 10,
  });
  assert.deepEqual(clampBox({ xmin: 1.4, ymin: 2.6, xmax: 5.5, ymax: 7.5 }), {
    xmin: 1,
    ymin: 3,
    xmax: 6,
    ymax: 8,
  });
});

test('clampBox は不正な入力を拒否する', () => {
  assert.throws(() => clampBox(null), /矩形が不正/);
  assert.throws(() => clampBox({ xmin: 'a', ymin: 0, xmax: 1, ymax: 1 }), /数値/);
});

test('boxArea / intersectionArea / iou が正しい', () => {
  const a = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
  const b = { xmin: 5, ymin: 5, xmax: 15, ymax: 15 };
  assert.equal(boxArea(a), 100);
  assert.equal(intersectionArea(a, b), 25);
  assert.equal(intersectionArea(a, { xmin: 20, ymin: 20, xmax: 30, ymax: 30 }), 0);
  assert.equal(iou(a, b), 25 / 175);
  assert.equal(iou(a, a), 1);
});

test('unionBox は全矩形を覆い、空なら null', () => {
  assert.equal(unionBox([]), null);
  assert.deepEqual(
    unionBox([
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
      { xmin: 5, ymin: -5, xmax: 20, ymax: 8 },
    ]),
    { xmin: 0, ymin: 0, xmax: 20, ymax: 10 },
  );
});

test('expandBox は辺の長さ × ratio だけ外側へ広げ、画像内に収める', () => {
  assert.deepEqual(expandBox({ xmin: 10, ymin: 10, xmax: 20, ymax: 20 }, 0.5, 100, 100), {
    xmin: 5,
    ymin: 5,
    xmax: 25,
    ymax: 25,
  });
  assert.deepEqual(expandBox({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, 0.5, 100, 100), {
    xmin: 0,
    ymin: 0,
    xmax: 15,
    ymax: 15,
  });
  assert.deepEqual(expandBox({ xmin: 10, ymin: 10, xmax: 20, ymax: 20 }, 0, 100, 100), {
    xmin: 10,
    ymin: 10,
    xmax: 20,
    ymax: 20,
  });
});

test('expandBox は負の ratio を拒否する', () => {
  assert.throws(() => expandBox({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, -0.1), /拡張マージン/);
  assert.throws(() => expandBox({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, NaN), /拡張マージン/);
});

test('isNear は重なり / gap 以内を判定する', () => {
  const a = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
  assert.equal(isNear(a, { xmin: 5, ymin: 5, xmax: 15, ymax: 15 }), true);
  assert.equal(isNear(a, { xmin: 12, ymin: 0, xmax: 22, ymax: 10 }), false);
  assert.equal(isNear(a, { xmin: 12, ymin: 0, xmax: 22, ymax: 10 }, 2), true);
  assert.equal(isNear(a, { xmin: 20, ymin: 0, xmax: 30, ymax: 10 }, 2), false);
});

test('mergeBoxes は重なりを統合し、離れた矩形は残す', () => {
  const merged = mergeBoxes([
    { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    { xmin: 5, ymin: 5, xmax: 15, ymax: 15 },
  ]);
  assert.deepEqual(merged, [{ xmin: 0, ymin: 0, xmax: 15, ymax: 15 }]);

  const separate = mergeBoxes([
    { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    { xmin: 50, ymin: 50, xmax: 60, ymax: 60 },
  ]);
  assert.equal(separate.length, 2);
});

test('mergeBoxes は gap で近接をまとめ、連鎖的に統合する', () => {
  const near = mergeBoxes(
    [
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
      { xmin: 12, ymin: 0, xmax: 22, ymax: 10 },
    ],
    2,
  );
  assert.deepEqual(near, [{ xmin: 0, ymin: 0, xmax: 22, ymax: 10 }]);

  const far = mergeBoxes(
    [
      { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
      { xmin: 13, ymin: 0, xmax: 22, ymax: 10 },
    ],
    2,
  );
  assert.equal(far.length, 2);

  const chain = mergeBoxes([
    { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    { xmin: 5, ymin: 5, xmax: 15, ymax: 15 },
    { xmin: 12, ymin: 12, xmax: 22, ymax: 22 },
  ]);
  assert.deepEqual(chain, [{ xmin: 0, ymin: 0, xmax: 22, ymax: 22 }]);
});

test('mergeBoxes は不正な入力を拒否する', () => {
  assert.throws(() => mergeBoxes('x'), /配列/);
  assert.throws(() => mergeBoxes([], -1), /ギャップ/);
});

test('toPixelRegion は整数の画素領域へ変換し、画像内に収める', () => {
  assert.deepEqual(toPixelRegion({ xmin: 10, ymin: 10, xmax: 20, ymax: 20 }, 100, 100), {
    x: 10,
    y: 10,
    w: 10,
    h: 10,
  });
  assert.deepEqual(toPixelRegion({ xmin: -5, ymin: -5, xmax: 200, ymax: 200 }, 100, 100), {
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  });
  assert.deepEqual(toPixelRegion({ xmin: 5, ymin: 5, xmax: 5, ymax: 5 }, 100, 100), {
    x: 5,
    y: 5,
    w: 0,
    h: 0,
  });
});

test('toPixelRegion は画像寸法を検証する', () => {
  assert.throws(() => toPixelRegion({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, 0, 10), /寸法/);
});

/* ==========================================================
   検出結果の正規化
   ========================================================== */

test('keypointsToPixels は正規化座標を画素へ変換し、不正を捨てる', () => {
  assert.deepEqual(
    keypointsToPixels([{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.75 }, { x: 'a', y: 1 }], 100, 40),
    [
      { x: 50, y: 20 },
      { x: 25, y: 30 },
    ],
  );
  assert.deepEqual(keypointsToPixels(null, 100, 100), []);
});

test('detectionToBox は boundingBox を矩形へ変換する', () => {
  const box = detectionToBox(
    { boundingBox: { originX: 10, originY: 20, width: 30, height: 40, angle: 0 } },
    100,
    100,
  );
  assert.deepEqual(box, { xmin: 10, ymin: 20, xmax: 40, ymax: 60 });
  assert.equal(detectionToBox({ keypoints: [] }, 100, 100), null);
  assert.equal(
    detectionToBox({ boundingBox: { originX: 'a', originY: 0, width: 1, height: 1 } }, 10, 10),
    null,
  );
});

test('parseDetections は MediaPipe 出力を正規化し、スコア降順で id を振る', () => {
  const parsed = parseDetections(
    {
      detections: [
        {
          categories: [{ score: 0.3 }],
          boundingBox: { originX: -5, originY: -5, width: 40, height: 40, angle: 0 },
          keypoints: [],
        },
        {
          categories: [{ score: 0.9 }],
          boundingBox: { originX: 0, originY: 0, width: 10, height: 10, angle: 0 },
          keypoints: [{ x: 0.5, y: 0.5 }],
        },
      ],
    },
    30,
    30,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].score, 0.9);
  assert.deepEqual(parsed[0].box, { xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
  assert.deepEqual(parsed[0].keypoints, [{ x: 15, y: 15 }]);
  assert.deepEqual(parsed[1].box, { xmin: 0, ymin: 0, xmax: 30, ymax: 30 });
  assert.equal(parsed[0].id, 0);
  assert.equal(parsed[1].id, 1);
});

test('parseDetections は不正な要素を捨て、非配列は空を返す', () => {
  const parsed = parseDetections(
    {
      detections: [
        null,
        { categories: [{ score: 0.5 }], keypoints: [] },
        { categories: [{ score: 0.5 }], boundingBox: { originX: 0, originY: 0, width: 5, height: 5 } },
      ],
    },
    100,
    100,
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].box, { xmin: 0, ymin: 0, xmax: 5, ymax: 5 });
  assert.deepEqual(parseDetections('x', 10, 10), []);
  assert.deepEqual(parseDetections(null, 10, 10), []);
});

/* ==========================================================
   匿名化領域の計画
   ========================================================== */

test('buildRegions は有効な矩形だけを拡張して画素領域にする', () => {
  const regions = buildRegions(
    [
      { box: { xmin: 10, ymin: 10, xmax: 20, ymax: 20 } },
      { box: { xmin: 80, ymin: 80, xmax: 90, ymax: 90 }, enabled: false },
    ],
    { width: 100, height: 100, margin: 0.5 },
  );
  assert.deepEqual(regions, [{ x: 5, y: 5, w: 20, h: 20 }]);
});

test('buildRegions は merge で重なり矩形を 1 つにまとめる', () => {
  const regions = buildRegions(
    [
      { box: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } },
      { box: { xmin: 5, ymin: 5, xmax: 15, ymax: 15 } },
    ],
    { width: 100, height: 100, margin: 0, merge: true },
  );
  assert.deepEqual(regions, [{ x: 0, y: 0, w: 15, h: 15 }]);
});

test('buildRegions は空・不正な矩形を無視する', () => {
  assert.deepEqual(buildRegions([], { width: 10, height: 10 }), []);
  assert.deepEqual(
    buildRegions([null, { box: null }, { box: { xmin: 'a', ymin: 0, xmax: 1, ymax: 1 } }], {
      width: 10,
      height: 10,
    }),
    [],
  );
});

/* ==========================================================
   ぼかし / モザイク のパラメータ
   ========================================================== */

test('computeBlurRadius は短辺と強度から半径を出し 1〜64 に制限する', () => {
  assert.equal(computeBlurRadius({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, 0.5), 6);
  assert.equal(computeBlurRadius({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, 1), 13);
  assert.equal(computeBlurRadius({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, 0), 1);
  assert.equal(computeBlurRadius({ xmin: 0, ymin: 0, xmax: 1000, ymax: 1000 }, 1), 64);
});

test('computeBlurKernel は常に奇数のサイズを返す', () => {
  assert.deepEqual(computeBlurKernel({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }, 0.5), {
    radius: 6,
    size: 13,
  });
  assert.equal(computeBlurKernel({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, 0.05).size % 2, 1);
});

test('computeMosaicTile は短辺とブロック数からタイルを出し 1〜64 に制限する', () => {
  assert.equal(computeMosaicTile({ xmin: 0, ymin: 0, xmax: 120, ymax: 60 }, 12), 5);
  assert.equal(computeMosaicTile({ xmin: 0, ymin: 0, xmax: 120, ymax: 60 }, 1), 60);
  assert.equal(computeMosaicTile({ xmin: 0, ymin: 0, xmax: 120, ymax: 60 }, 1000), 1);
});

test('emojiFontSize は短辺に対する文字サイズを返す', () => {
  assert.equal(emojiFontSize({ xmin: 0, ymin: 0, xmax: 100, ymax: 50 }), 43);
  assert.equal(emojiFontSize({ xmin: 0, ymin: 0, xmax: 2, ymax: 2 }), 8);
});

/* ==========================================================
   匿名化モード
   ========================================================== */

test('モードは 4 種で、既定は blur', () => {
  assert.deepEqual(MODE_KEYS, ['blur', 'mosaic', 'black', 'emoji']);
  assert.equal(DEFAULT_REDACTION, 'blur');
  assert.equal(getMode('black').label, '黒塗り');
  assert.throws(() => getMode('nope'), /匿名化モード/);
  assert.equal(REDACTION_MODES.length, 4);
  assert.ok(EMOJI_CHOICES.length >= 3);
});

/* ==========================================================
   画素加工
   ========================================================== */

test('fillRegion は指定領域だけを単色にする', () => {
  const image = makeImage(2, 2, [255, 255, 255, 255]);
  fillRegion(image, { x: 0, y: 0, w: 1, h: 1 }, [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, 1, 1), [255, 255, 255, 255]);
});

test('fillRegion は領域を画像内にクランプする', () => {
  const image = makeImage(2, 2, [255, 255, 255, 255]);
  fillRegion(image, { x: 1, y: 1, w: 99, h: 99 }, [10, 20, 30, 255]);
  assert.deepEqual(pixelAt(image, 1, 1), [10, 20, 30, 255]);
  assert.deepEqual(pixelAt(image, 0, 0), [255, 255, 255, 255]);
});

test('mosaicRegion はタイルごとの平均色で塗る', () => {
  const width = 4;
  const height = 4;
  const image = { data: new Uint8ClampedArray(width * height * 4), width, height };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      image.data[i] = x * 10;
      image.data[i + 1] = y * 10;
      image.data[i + 2] = 0;
      image.data[i + 3] = 255;
    }
  }
  mosaicRegion(image, { x: 0, y: 0, w: 4, h: 4 }, 2);
  // 左上ブロック: r=(0+10+0+10)/4=5, g=(0+0+10+10)/4=5
  assert.deepEqual(pixelAt(image, 0, 0), [5, 5, 0, 255]);
  assert.deepEqual(pixelAt(image, 1, 1), [5, 5, 0, 255]);
  // 右下ブロック: r=(20+30+20+30)/4=25, g=25
  assert.deepEqual(pixelAt(image, 3, 3), [25, 25, 0, 255]);
});

test('blurRegion は横→縦の box blur を適用する', () => {
  const image = {
    data: new Uint8ClampedArray(3 * 4),
    width: 3,
    height: 1,
  };
  const values = [10, 20, 30];
  for (let x = 0; x < 3; x += 1) {
    image.data[x * 4] = values[x];
    image.data[x * 4 + 3] = 255;
  }
  blurRegion(image, { x: 0, y: 0, w: 3, h: 1 }, 1);
  assert.deepEqual(pixelAt(image, 0, 0), [13, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, 1, 0), [20, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, 2, 0), [27, 0, 0, 255]);
});

test('blurRegion は領域外の画素を変更しない', () => {
  const image = { data: new Uint8ClampedArray(3 * 4), width: 3, height: 1 };
  const values = [10, 20, 30];
  for (let x = 0; x < 3; x += 1) {
    image.data[x * 4] = values[x];
    image.data[x * 4 + 3] = 255;
  }
  blurRegion(image, { x: 1, y: 0, w: 1, h: 1 }, 1);
  assert.equal(image.data[0], 10);
  assert.equal(image.data[4], 20);
  assert.equal(image.data[8], 30);
});

test('blurRegion は radius 0 で何もしない', () => {
  const image = makeImage(2, 1, [5, 6, 7, 255]);
  blurRegion(image, { x: 0, y: 0, w: 2, h: 1 }, 0);
  assert.deepEqual(pixelAt(image, 0, 0), [5, 6, 7, 255]);
});

test('applyRedaction はモードごとに処理を切り替える', () => {
  const black = makeImage(2, 2, [255, 255, 255, 255]);
  applyRedaction(black, { x: 0, y: 0, w: 1, h: 1 }, 'black');
  assert.deepEqual(pixelAt(black, 0, 0), [0, 0, 0, 255]);

  const emoji = makeImage(2, 2, [1, 2, 3, 255]);
  applyRedaction(emoji, { x: 0, y: 0, w: 1, h: 1 }, 'emoji');
  assert.deepEqual(pixelAt(emoji, 0, 0), [255, 255, 255, 255]);

  const blurred = makeImage(3, 1, [0, 0, 0, 255]);
  applyRedaction(blurred, { x: 0, y: 0, w: 3, h: 1 }, 'blur', { radius: 1 });
  assert.equal(blurred.data.length, 12);

  const mosaic = makeImage(2, 2, [10, 20, 30, 255]);
  applyRedaction(mosaic, { x: 0, y: 0, w: 2, h: 2 }, 'mosaic', { tile: 2 });
  assert.deepEqual(pixelAt(mosaic, 0, 0), [10, 20, 30, 255]);
});

test('applyRedaction は未知のモードで例外', () => {
  const image = makeImage(1, 1);
  assert.throws(() => applyRedaction(image, { x: 0, y: 0, w: 1, h: 1 }, 'nope'), /モード/);
});

test('applyRedactions は複数領域をまとめて処理し、配列を検証する', () => {
  const image = makeImage(3, 1, [255, 255, 255, 255]);
  applyRedactions(
    image,
    [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 2, y: 0, w: 1, h: 1 },
    ],
    'black',
  );
  assert.deepEqual(pixelAt(image, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(image, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(image, 2, 0), [0, 0, 0, 255]);
  assert.throws(() => applyRedactions(image, 'x', 'black'), /配列/);
});

/* ==========================================================
   表示 / ファイル名 / 入力判定
   ========================================================== */

test('formatBytes は 1024 基準で表記する', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(12465572), '11.9 MiB');
  assert.equal(formatBytes(NaN), '-');
});

test('formatScore は百分率に丸める', () => {
  assert.equal(formatScore(0.5), '50%');
  assert.equal(formatScore(0.999), '100%');
  assert.equal(formatScore(undefined), '-');
});

test('sanitizeBaseName はパス・拡張子・記号を除去する', () => {
  assert.equal(sanitizeBaseName('my photo.png'), 'my_photo');
  assert.equal(sanitizeBaseName('/a/b/c.jpg'), 'c');
  assert.equal(sanitizeBaseName('日本語.png'), 'image');
  assert.equal(sanitizeBaseName(undefined), 'image');
});

test('buildDownloadName / buildZipName は安全な名前を作る', () => {
  assert.equal(buildDownloadName('photo.jpg', 'blur'), 'photo-blur.png');
  assert.equal(buildDownloadName('photo.jpg'), 'photo-privacy.png');
  const fixed = new Date(2026, 9, 3, 5, 7).getTime();
  assert.equal(buildZipName(fixed), 'face-privacy-20261003-0507.zip');
});

test('画像形式の判定', () => {
  assert.equal(isSupportedImageType('image/png'), true);
  assert.equal(isSupportedImageType('IMAGE/JPEG'), true);
  assert.equal(isSupportedImageType('application/pdf'), false);
  assert.equal(isSupportedImageType(undefined), false);
  assert.equal(hasImageExtension('a.webp'), true);
  assert.equal(hasImageExtension('a.heic'), false);
  assert.equal(isSupportedImage({ type: '', name: 'x.png' }), true);
  assert.equal(isSupportedImage({ type: 'application/pdf', name: 'x.pdf' }), false);
  assert.equal(isSupportedImage(null), false);
});
