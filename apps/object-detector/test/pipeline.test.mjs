import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CATALOG,
  MODEL_KEYS,
  DEFAULT_MODE,
  DEFAULT_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  COCO_CLASSES,
  CLASS_LABELS_JA,
  getModel,
  listModels,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  labelJa,
  classColor,
  clampBox,
  boxArea,
  intersectionArea,
  iou,
  nms,
  unionBox,
  computeCropRegion,
  parseDetections,
  formatBytes,
  formatScore,
  sanitizeBaseName,
  buildDownloadName,
  buildCropName,
  isSupportedImageType,
  hasImageExtension,
  isSupportedImage,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは D-FINE nano 1 件で、既定と一致する', () => {
  assert.deepEqual(MODEL_KEYS, ['dfine-nano']);
  assert.equal(DEFAULT_MODE, 'dfine-nano');
  assert.equal(MODEL_CATALOG['dfine-nano'].task, 'object-detection');
  assert.equal(
    MODEL_CATALOG['dfine-nano'].modelId,
    'onnx-community/dfine-nano-coco-ONNX',
  );
  assert.equal(listModels().length, 1);
});

test('未知のモデルは例外、listModels はカタログの値を返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.equal(listModels()[0], MODEL_CATALOG[DEFAULT_MODE]);
});

test('ライセンスは Apache-2.0 で商用可', () => {
  assert.equal(MODEL_CATALOG['dfine-nano'].license, 'Apache-2.0');
  assert.equal(MODEL_CATALOG['dfine-nano'].commercial, true);
});

test('dtype はデバイスごとに定義され、重みファイルが存在する', () => {
  const model = MODEL_CATALOG['dfine-nano'];
  for (const device of ['webgpu', 'wasm']) {
    const dtype = resolveDtype('dfine-nano', device);
    assert.ok(model.files[dtype], `dfine-nano/${device} の dtype ${dtype} が無い`);
  }
  assert.equal(resolveDtype('dfine-nano', 'webgpu'), 'fp32');
  assert.equal(resolveDtype('dfine-nano', 'wasm'), 'q8');
});

test('detectDevice は WebGPU の有無で webgpu/wasm を返す', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');
});

test('estimateModelBytes は重み + config の実測値の合計を返す', () => {
  assert.equal(estimateModelBytes('dfine-nano', 'wasm'), 4807354 + 6570 + 444);
  assert.equal(estimateModelBytes('dfine-nano', 'webgpu'), 15434994 + 6570 + 444);
});

test('chooseModel はデバイスと dtype を決め、凍結した設定を返す', () => {
  const wasm = chooseModel('dfine-nano', false);
  assert.equal(wasm.device, 'wasm');
  assert.equal(wasm.dtype, 'q8');
  assert.equal(wasm.task, 'object-detection');
  assert.equal(wasm.bytes, 4814368);
  assert.ok(Object.isFrozen(wasm));

  const gpu = chooseModel('dfine-nano', true);
  assert.equal(gpu.device, 'webgpu');
  assert.equal(gpu.dtype, 'fp32');
  assert.equal(gpu.bytes, 15442008);
});

/* ==========================================================
   クラス
   ========================================================== */

test('COCO_CLASSES は 80 クラスで、主要クラスを含む', () => {
  assert.equal(COCO_CLASSES.length, 80);
  assert.equal(COCO_CLASSES[0], 'person');
  assert.equal(COCO_CLASSES[79], 'toothbrush');
  assert.ok(COCO_CLASSES.includes('car'));
  assert.ok(COCO_CLASSES.includes('dog'));
});

test('labelJa は既知クラスを日本語化し、未知はそのまま返す', () => {
  assert.equal(labelJa('person'), '人');
  assert.equal(labelJa('car'), '車');
  assert.equal(labelJa('nope'), 'nope');
  assert.equal(labelJa(undefined), 'unknown');
  assert.equal(CLASS_LABELS_JA.person, '人');
});

test('classColor は同じ入力なら同じ色、形式は hsl', () => {
  assert.equal(classColor('person'), classColor('person'));
  assert.match(classColor('person'), /^hsl\(\d+, \d+%, \d+%\)$/);
  assert.notEqual(classColor('person'), classColor('dog'));
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
  assert.equal(boxArea({ xmin: 0, ymin: 0, xmax: 10, ymax: 5 }), 50);
  assert.equal(intersectionArea(a, b), 25);
  assert.equal(intersectionArea(a, { xmin: 20, ymin: 20, xmax: 30, ymax: 30 }), 0);
  assert.equal(iou(a, b), 25 / 175);
  assert.equal(iou(a, a), 1);
});

test('nms は同クラスの重複を除き、別クラスは残す', () => {
  const a = { label: 'person', score: 0.9, box: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } };
  const b = { label: 'person', score: 0.8, box: { xmin: 1, ymin: 1, xmax: 11, ymax: 11 } };
  const c = { label: 'dog', score: 0.7, box: { xmin: 1, ymin: 1, xmax: 11, ymax: 11 } };

  const kept = nms([b, c, a], 0.5);
  assert.deepEqual(
    kept.map((d) => d.label),
    ['person', 'dog'],
  );
  assert.equal(kept[0], a, 'スコアの高い方が残る');

  const both = nms([a, b], 0.7);
  assert.equal(both.length, 2, 'しきい値を超えなければ残す');
});

test('nms は入力としきい値を検証する', () => {
  assert.throws(() => nms('x'), /配列/);
  assert.throws(() => nms([], 1.5), /IoU/);
  assert.throws(() => nms([], -0.1), /IoU/);
});

test('unionBox は全矩形を覆い、空なら null', () => {
  assert.equal(unionBox([]), null);
  const box = unionBox([
    { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    { xmin: 5, ymin: -5, xmax: 20, ymax: 8 },
  ]);
  // 負の座標は画像座標として 0 に丸められる
  assert.deepEqual(box, { xmin: 0, ymin: 0, xmax: 20, ymax: 10 });
});

test('computeCropRegion は余白を足して画像内に収める', () => {
  assert.deepEqual(computeCropRegion({ xmin: 10, ymin: 10, xmax: 20, ymax: 20 }, 100, 100, 5), {
    x: 5,
    y: 5,
    w: 20,
    h: 20,
  });
  assert.deepEqual(computeCropRegion({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 }, 100, 100, 5), {
    x: 0,
    y: 0,
    w: 15,
    h: 15,
  });
  assert.deepEqual(computeCropRegion({ xmin: 90, ymin: 90, xmax: 200, ymax: 200 }, 100, 100, 0), {
    x: 90,
    y: 90,
    w: 10,
    h: 10,
  });
});

test('computeCropRegion は寸法 0 や負の余白を拒否し、最小 1px を保証する', () => {
  assert.throws(() => computeCropRegion({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, 0, 10, 0), /寸法/);
  assert.throws(() => computeCropRegion({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, 10, 10, -1), /余白/);
  const region = computeCropRegion({ xmin: 5, ymin: 5, xmax: 5, ymax: 5 }, 10, 10, 0);
  assert.equal(region.w, 1);
  assert.equal(region.h, 1);
});

/* ==========================================================
   検出結果の正規化
   ========================================================== */

test('parseDetections は正規化し、スコア降順で id を振る', () => {
  const parsed = parseDetections(
    [
      { score: 0.2, label: 'cat', box: { xmin: 0, ymin: 0, xmax: 5, ymax: 5 } },
      { score: 0.9, label: 'dog', box: { xmin: -5, ymin: 0, xmax: 50, ymax: 50 } },
    ],
    40,
    40,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].label, 'dog');
  assert.deepEqual(parsed[0].box, { xmin: 0, ymin: 0, xmax: 40, ymax: 40 });
  assert.equal(parsed[0].id, 0);
  assert.equal(parsed[1].id, 1);
});

test('parseDetections は不正な要素を捨て、非配列は空を返す', () => {
  const parsed = parseDetections(
    [
      null,
      { score: NaN, label: 'x', box: {} },
      { score: 0.5, label: '', box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
      { score: 0.5, label: 'ok', box: null },
    ],
    10,
    10,
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].label, 'unknown');
  assert.deepEqual(parseDetections('x'), []);
});

/* ==========================================================
   表示 / ファイル名 / 入力判定
   ========================================================== */

test('formatBytes は 1024 基準で表記する', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(4814368), '4.6 MiB');
  assert.equal(formatBytes(NaN), '-');
  assert.equal(formatBytes(-1), '-');
});

test('formatScore は百分率に丸める', () => {
  assert.equal(formatScore(0.5), '50%');
  assert.equal(formatScore(0.999), '100%');
  assert.equal(formatScore(1.5), '100%');
  assert.equal(formatScore(undefined), '-');
});

test('sanitizeBaseName はパス・拡張子・記号を除去する', () => {
  assert.equal(sanitizeBaseName('my photo.png'), 'my_photo');
  assert.equal(sanitizeBaseName('/a/b/c.jpg'), 'c');
  assert.equal(sanitizeBaseName('日本語.png'), 'image');
  assert.equal(sanitizeBaseName(undefined), 'image');
});

test('buildDownloadName / buildCropName は拡張子とラベルから名前を作る', () => {
  assert.equal(buildDownloadName('photo.jpg', 'detected'), 'photo-detected.png');
  assert.equal(buildDownloadName('photo.jpg'), 'photo-detect.png');
  assert.equal(buildCropName('photo.jpg', 'traffic light', 0), 'photo-traffic_light-1.png');
  assert.equal(buildCropName('photo.jpg', 'person', 2), 'photo-person-3.png');
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

test('既定のしきい値と依存バージョンが固定されている', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.5);
  assert.equal(DEFAULT_IOU_THRESHOLD, 0.6);
  assert.equal(TRANSFORMERS_VERSION, '4.3.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.3.0'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
});
