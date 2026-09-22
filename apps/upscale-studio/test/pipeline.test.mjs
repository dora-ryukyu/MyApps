import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CATALOG,
  MODEL_KEYS,
  DEFAULT_MODE,
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  ONNXRUNTIME_VERSION,
  ONNXRUNTIME_MODULE_URL,
  ONNXRUNTIME_WASM_PATH,
  CACHE_PREFIX,
  MAX_OUTPUT_PIXELS,
  getModel,
  listModels,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  outputSize,
  assertOutputFits,
  axisStarts,
  computeTiles,
  blendTiles,
  toRgba,
  needsTiling,
  formatBytes,
  sanitizeBaseName,
  buildDownloadName,
  isSupportedImageType,
  hasImageExtension,
  isSupportedImage,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは 3 モードを持ち、既定は Swin2SR x2', () => {
  assert.deepEqual(MODEL_KEYS, ['swin2sr-x2', 'swin2sr-x4', 'realesrgan-anime-x4']);
  assert.equal(DEFAULT_MODE, 'swin2sr-x2');
  assert.equal(MODEL_CATALOG['swin2sr-x2'].engine, 'transformers');
  assert.equal(MODEL_CATALOG['swin2sr-x2'].modelId, 'Xenova/swin2SR-classical-sr-x2-64');
  assert.equal(MODEL_CATALOG['swin2sr-x4'].scale, 4);
  assert.equal(MODEL_CATALOG['realesrgan-anime-x4'].engine, 'ort');
  assert.equal(listModels().length, MODEL_KEYS.length);
});

test('未知のモデルは例外、listModels はカタログの値を返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.equal(listModels()[0], MODEL_CATALOG[DEFAULT_MODE]);
});

test('ライセンス: Swin2SR は Apache-2.0、Real-ESRGAN は BSD-3-Clause で商用可', () => {
  for (const key of MODEL_KEYS) {
    assert.equal(MODEL_CATALOG[key].commercial, true);
  }
  assert.match(MODEL_CATALOG['swin2sr-x2'].license, /Apache-2\.0/);
  assert.match(MODEL_CATALOG['realesrgan-anime-x4'].license, /BSD-3-Clause/);
});

test('dtype はデバイスごとに定義され、重みファイルが存在する', () => {
  for (const key of MODEL_KEYS) {
    const model = MODEL_CATALOG[key];
    for (const device of ['webgpu', 'wasm']) {
      const dtype = resolveDtype(key, device);
      assert.ok(model.files[dtype], `${key}/${device} の dtype ${dtype} が無い`);
    }
  }
  assert.equal(resolveDtype('swin2sr-x2', 'webgpu'), 'fp16');
  assert.equal(resolveDtype('swin2sr-x2', 'wasm'), 'q8');
  assert.equal(resolveDtype('realesrgan-anime-x4', 'webgpu'), 'fp32');
});

test('detectDevice は WebGPU の有無で webgpu/wasm を返す', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');
});

test('estimateModelBytes は重み + config の実測値の合計を返す', () => {
  assert.equal(estimateModelBytes('swin2sr-x2', 'wasm'), 21471413 + 825 + 152);
  assert.equal(estimateModelBytes('swin2sr-x2', 'webgpu'), 32428109 + 825 + 152);
  assert.equal(estimateModelBytes('swin2sr-x4', 'wasm'), 21438622 + 837 + 152);
  assert.equal(estimateModelBytes('realesrgan-anime-x4', 'webgpu'), 2495473);
});

test('chooseModel はモードと WebGPU 有無からモデル・device・dtype を決める', () => {
  const x2Wasm = chooseModel('swin2sr-x2', false);
  assert.equal(x2Wasm.engine, 'transformers');
  assert.equal(x2Wasm.scale, 2);
  assert.equal(x2Wasm.device, 'wasm');
  assert.equal(x2Wasm.dtype, 'q8');
  assert.equal(x2Wasm.modelId, 'Xenova/swin2SR-classical-sr-x2-64');

  const x2Gpu = chooseModel('swin2sr-x2', true);
  assert.equal(x2Gpu.device, 'webgpu');
  assert.equal(x2Gpu.dtype, 'fp16');
  assert.equal(x2Gpu.bytes, 32429086);

  const anime = chooseModel('realesrgan-anime-x4', false);
  assert.equal(anime.engine, 'ort');
  assert.equal(anime.scale, 4);
  assert.equal(anime.modelId, null);
  assert.match(anime.modelUrl, /tidus2102\/Real-ESRGAN/);
  assert.equal(anime.bytes, 2495473);
  assert.ok(Object.isFrozen(anime));
});

/* ==========================================================
   出力サイズ
   ========================================================== */

test('outputSize は倍率を掛けて丸める', () => {
  assert.deepEqual(outputSize(100, 50, 2), { width: 200, height: 100 });
  assert.deepEqual(outputSize(333, 111, 4), { width: 1332, height: 444 });
  assert.throws(() => outputSize(0, 10, 2), /寸法が不正/);
  assert.throws(() => outputSize(10, 10, 0), /不正な倍率/);
});

test('assertOutputFits は上限を超えると例外、収まれば寸法を返す', () => {
  assert.deepEqual(assertOutputFits(100, 100, 2), { width: 200, height: 200 });
  assert.throws(() => assertOutputFits(10000, 10000, 1), /大きすぎ/);
  assert.equal(MAX_OUTPUT_PIXELS, 40000000);
});

/* ==========================================================
   タイル分割
   ========================================================== */

test('axisStarts は重複なく画像全体を覆う開始位置を返す', () => {
  assert.deepEqual(axisStarts(5, 8, 2), [0]);
  assert.deepEqual(axisStarts(8, 5, 2), [0, 3]);
  assert.deepEqual(axisStarts(10, 4, 2), [0, 2, 4, 6]);
  assert.deepEqual(axisStarts(4, 4, 0), [0]);
  assert.throws(() => axisStarts(10, 4, 4), /オーバーラップ/);
});

test('computeTiles は画像に収まる 1 枚ならタイル 1 つ、倍率を反映する', () => {
  const tiles = computeTiles(100, 80, { tileSize: 512, overlap: 32, scale: 2 });
  assert.equal(tiles.length, 1);
  const [t] = tiles;
  assert.deepEqual([t.x, t.y, t.w, t.h], [0, 0, 100, 80]);
  assert.deepEqual([t.outX, t.outY, t.outW, t.outH], [0, 0, 200, 160]);
  assert.equal(t.feather, 64);
  assert.equal(t.hasLeft || t.hasRight || t.hasTop || t.hasBottom, false);
});

test('computeTiles は大きい画像を分割し、全画素をちょうど 1 回以上覆う', () => {
  const width = 20;
  const height = 15;
  const tiles = computeTiles(width, height, { tileSize: 8, overlap: 2, scale: 1 });
  assert.ok(tiles.length > 1);
  const cover = new Array(width * height).fill(0);
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.y >= 0);
    assert.ok(t.x + t.w <= width && t.y + t.h <= height, `タイルが画像外: ${JSON.stringify(t)}`);
    for (let y = t.y; y < t.y + t.h; y += 1) {
      for (let x = t.x; x < t.x + t.w; x += 1) cover[y * width + x] += 1;
    }
  }
  assert.ok(cover.every((c) => c >= 1), '覆われていない画素がある');
  assert.ok(cover.some((c) => c > 1), 'オーバーラップが無い');
});

test('needsTiling はタイルサイズを超えるときだけ true', () => {
  const tile = { size: 10, overlap: 2 };
  assert.equal(needsTiling(10, 10, tile), false);
  assert.equal(needsTiling(11, 10, tile), true);
  assert.equal(needsTiling(10, 100, tile), true);
  assert.equal(needsTiling(100, 100, null), false);
});

/* ==========================================================
   重ね合わせ
   ========================================================== */

test('toRgba は 4ch を複製し、3ch にアルファを足し、不一致は例外', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 4]);
  const copy = toRgba(rgba, 1, 1);
  assert.notEqual(copy, rgba);
  assert.deepEqual(Array.from(copy), [1, 2, 3, 4]);

  assert.deepEqual(Array.from(toRgba(new Uint8ClampedArray([9, 8, 7]), 1, 1)), [9, 8, 7, 255]);
  assert.throws(() => toRgba(new Uint8ClampedArray([1, 2]), 1, 1), /画素数/);
});

test('blendTiles は 1 枚ならそのまま RGBA で返す', () => {
  const tiles = computeTiles(2, 1, { tileSize: 4, overlap: 1, scale: 1 });
  const outputs = [{ data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), width: 2, height: 1 }];
  const out = blendTiles(tiles, outputs, 2, 1);
  assert.deepEqual(Array.from(out), [10, 20, 30, 255, 40, 50, 60, 255]);
});

test('blendTiles はオーバーラップを線形に混ぜ、外側は元の色を保つ', () => {
  // 横 8px、タイル 5px、オーバーラップ 2px → タイルは x=0 (5px) と x=3 (5px)
  const tiles = computeTiles(8, 1, { tileSize: 5, overlap: 2, scale: 1 });
  assert.equal(tiles.length, 2);
  const A = new Uint8ClampedArray(5 * 4);
  const B = new Uint8ClampedArray(5 * 4);
  for (let i = 0; i < 5; i += 1) {
    A.set([100, 0, 0, 255], i * 4);
    B.set([200, 0, 0, 255], i * 4);
  }
  const out = blendTiles(
    tiles,
    [
      { data: A, width: 5, height: 1 },
      { data: B, width: 5, height: 1 },
    ],
    8,
    1,
  );
  assert.equal(out[0 * 4], 100); // タイル A のみ
  assert.equal(out[1 * 4], 100);
  assert.equal(out[2 * 4], 100);
  assert.equal(out[3 * 4], 125); // 0.75 A + 0.25 B
  assert.equal(out[4 * 4], 175); // 0.25 A + 0.75 B
  assert.equal(out[5 * 4], 200); // タイル B のみ
  assert.equal(out[6 * 4], 200);
  assert.equal(out[7 * 4], 200);
  for (let i = 0; i < 8; i += 1) assert.equal(out[i * 4 + 3], 255);
});

test('blendTiles は同じ色のタイルなら継ぎ目が出ない', () => {
  const tiles = computeTiles(9, 5, { tileSize: 4, overlap: 2, scale: 1 });
  const outputs = tiles.map(() => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([77, 88, 99, 255], i);
    return { data, width: 4, height: 4 };
  });
  const out = blendTiles(tiles, outputs, 9, 5);
  for (let i = 0; i < out.length; i += 4) {
    assert.deepEqual([out[i], out[i + 1], out[i + 2], out[i + 3]], [77, 88, 99, 255]);
  }
});

test('blendTiles はタイル数と結果数が違うと例外', () => {
  const tiles = computeTiles(4, 1, { tileSize: 2, overlap: 0, scale: 1 });
  assert.throws(() => blendTiles(tiles, [], 4, 1), /一致しません/);
  assert.throws(() => blendTiles([], [], 4, 1), /タイルがありません/);
});

/* ==========================================================
   表示 / ファイル名 / 入力判定
   ========================================================== */

test('formatBytes は 1024 基準で表記する', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(32429086), '30.9 MiB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GiB');
  assert.equal(formatBytes(NaN), '-');
  assert.equal(formatBytes(-1), '-');
});

test('sanitizeBaseName はパス・拡張子・記号を除去する', () => {
  assert.equal(sanitizeBaseName('my photo.png'), 'my_photo');
  assert.equal(sanitizeBaseName('/a/b/c.jpg'), 'c');
  assert.equal(sanitizeBaseName('日本語.png'), 'image');
  assert.equal(sanitizeBaseName(''), 'image');
  assert.equal(sanitizeBaseName(undefined), 'image');
});

test('buildDownloadName は倍率に応じた PNG 名を返す', () => {
  assert.equal(buildDownloadName('photo.png', 2), 'photo-2x.png');
  assert.equal(buildDownloadName('photo.jpg', 4), 'photo-4x.png');
  assert.equal(buildDownloadName('photo.jpg', undefined), 'photo-upscaled.png');
});

test('画像形式の判定', () => {
  assert.equal(isSupportedImageType('image/png'), true);
  assert.equal(isSupportedImageType('IMAGE/JPEG'), true);
  assert.equal(isSupportedImageType('application/pdf'), false);
  assert.equal(isSupportedImageType(undefined), false);
  assert.equal(hasImageExtension('a.HEIC'), false);
  assert.equal(hasImageExtension('a.webp'), true);
  assert.equal(isSupportedImage({ type: '', name: 'x.png' }), true);
  assert.equal(isSupportedImage({ type: 'application/pdf', name: 'x.pdf' }), false);
  assert.equal(isSupportedImage(null), false);
});

test('依存のバージョンとキャッシュ名が固定されている', () => {
  assert.equal(TRANSFORMERS_VERSION, '4.2.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.2.0'));
  assert.equal(ONNXRUNTIME_VERSION, '1.22.0');
  assert.ok(ONNXRUNTIME_MODULE_URL.includes('onnxruntime-web@1.22.0'));
  assert.ok(ONNXRUNTIME_WASM_PATH.endsWith('/dist/'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
});
