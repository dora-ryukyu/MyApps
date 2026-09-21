import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CATALOG,
  MODEL_KEYS,
  SUBJECTS,
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  getModel,
  getSubject,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  formatBytes,
  hexToRgb,
  normalizeRgb,
  composeOnColor,
  composeOnBackground,
  keepTransparent,
  compose,
  sanitizeBaseName,
  buildDownloadName,
  isSupportedImageType,
  hasImageExtension,
  isSupportedImage,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは modnet と rmbg を持つ', () => {
  assert.deepEqual(MODEL_KEYS, ['modnet', 'rmbg']);
  assert.equal(MODEL_CATALOG.modnet.modelId, 'Xenova/modnet');
  assert.equal(MODEL_CATALOG.rmbg.modelId, 'briaai/RMBG-1.4');
});

test('未知のモデルは例外、getSubject は人物にフォールバックする', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.equal(getSubject('general').modelKey, 'rmbg');
  assert.equal(getSubject('nope').key, 'person');
  assert.equal(getSubject(undefined).key, 'person');
});

test('すべての被写体のモデルキーはカタログに存在する', () => {
  for (const subject of SUBJECTS) {
    assert.ok(MODEL_CATALOG[subject.modelKey], `${subject.key} のモデルが無い`);
  }
});

test('ライセンス情報: MODNet は Apache-2.0、RMBG-1.4 は非商用', () => {
  assert.equal(MODEL_CATALOG.modnet.commercial, true);
  assert.match(MODEL_CATALOG.modnet.license, /Apache-2\.0/);
  assert.equal(MODEL_CATALOG.rmbg.commercial, false);
  assert.match(MODEL_CATALOG.rmbg.license, /非商用/);
});

test('dtype はデバイスごとに定義され、重みファイルが存在する', () => {
  for (const key of MODEL_KEYS) {
    const model = MODEL_CATALOG[key];
    for (const device of ['webgpu', 'wasm']) {
      const dtype = resolveDtype(key, device);
      assert.ok(model.files[dtype], `${key}/${device} の dtype ${dtype} が無い`);
    }
  }
  assert.equal(resolveDtype('modnet', 'webgpu'), 'fp32');
  assert.equal(resolveDtype('modnet', 'wasm'), 'fp32');
  assert.equal(resolveDtype('rmbg', 'webgpu'), 'q8');
  assert.equal(resolveDtype('rmbg', 'wasm'), 'q8');
});

test('detectDevice は WebGPU の有無で webgpu/wasm を返す', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');
});

test('estimateModelBytes は重み + config の実測値の合計を返す', () => {
  assert.equal(estimateModelBytes('modnet', 'wasm'), 25888640 + 83 + 365);
  assert.equal(estimateModelBytes('rmbg', 'webgpu'), 44403226 + 548 + 345);
  assert.ok(estimateModelBytes('rmbg', 'wasm') > estimateModelBytes('modnet', 'wasm'));
});

test('chooseModel は被写体と WebGPU 有無からモデル・device・dtype を決める', () => {
  const personWasm = chooseModel('person', false);
  assert.equal(personWasm.modelKey, 'modnet');
  assert.equal(personWasm.device, 'wasm');
  assert.equal(personWasm.dtype, 'fp32');

  const personGpu = chooseModel('person', true);
  assert.equal(personGpu.modelKey, 'modnet');
  assert.equal(personGpu.device, 'webgpu');
  assert.equal(personGpu.dtype, 'fp32');

  const general = chooseModel('general', false);
  assert.equal(general.modelKey, 'rmbg');
  assert.equal(general.dtype, 'q8');
  assert.equal(general.commercial, false);
  assert.equal(general.bytes, 44404119);

  assert.ok(Object.isFrozen(general));
});

/* ==========================================================
   表示
   ========================================================== */

test('formatBytes は 1024 基準で表記する', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(25889088), '24.7 MiB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GiB');
  assert.equal(formatBytes(NaN), '-');
  assert.equal(formatBytes(-1), '-');
});

test('hexToRgb / normalizeRgb は色を正規化する', () => {
  assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb('db2777'), { r: 219, g: 39, b: 119 });
  assert.throws(() => hexToRgb('#xyzxyz'), /不正な色指定/);
  assert.throws(() => hexToRgb(123), TypeError);
  assert.deepEqual(normalizeRgb({ r: 300, g: -5, b: 12.6 }), { r: 255, g: 0, b: 13 });
});

/* ==========================================================
   合成
   ========================================================== */

test('composeOnColor: 不透明は前景、透明は背景色になる', () => {
  const fg = new Uint8ClampedArray([
    255, 0, 0, 255, // 不透明の赤
    10, 20, 30, 0, // 完全透過
  ]);
  const out = composeOnColor(fg, '#ffffff');
  assert.deepEqual(Array.from(out.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(out.slice(4, 8)), [255, 255, 255, 255]);
});

test('composeOnColor: 半透明は背景と線形に混ざる', () => {
  const fg = new Uint8ClampedArray([0, 0, 0, 128]);
  const out = composeOnColor(fg, '#ffffff');
  // 255 * (1 - 128/255) = 127
  assert.deepEqual(Array.from(out), [127, 127, 127, 255]);
});

test('composeOnBackground: サイズ不一致は例外、同寸法は合成する', () => {
  const fg = new Uint8ClampedArray([255, 0, 0, 128]);
  const bg = new Uint8ClampedArray([0, 0, 255, 255]);
  assert.throws(() => composeOnBackground(fg, new Uint8ClampedArray(8)), /一致しません/);

  const out = composeOnBackground(fg, bg);
  // r = 255*0.50196 + 0 = 128, b = 0 + 255*0.49804 = 127
  assert.equal(out[0], 128);
  assert.equal(out[1], 0);
  assert.equal(out[2], 127);
  assert.equal(out[3], 255);
});

test('keepTransparent は複製を返す (元を変更しない)', () => {
  const fg = new Uint8ClampedArray([1, 2, 3, 4]);
  const out = keepTransparent(fg);
  assert.notEqual(out, fg);
  out[0] = 99;
  assert.equal(fg[0], 1);
  assert.deepEqual(Array.from(keepTransparent(fg)), [1, 2, 3, 4]);
});

test('compose はモードで分岐し、未知のモードは例外', () => {
  const fg = new Uint8ClampedArray([0, 0, 0, 0]);
  const bg = new Uint8ClampedArray([9, 9, 9, 255]);
  assert.deepEqual(Array.from(compose(fg, 'transparent')), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(compose(fg, 'color', { color: '#000000' })), [0, 0, 0, 255]);
  assert.deepEqual(Array.from(compose(fg, 'image', { background: bg })), [9, 9, 9, 255]);
  assert.throws(() => compose(fg, 'bogus'), /未知の合成モード/);
});

/* ==========================================================
   ファイル名 / 入力判定
   ========================================================== */

test('sanitizeBaseName はパス・拡張子・記号を除去する', () => {
  assert.equal(sanitizeBaseName('my photo.png'), 'my_photo');
  assert.equal(sanitizeBaseName('/a/b/c.jpg'), 'c');
  assert.equal(sanitizeBaseName('日本語.png'), 'image');
  assert.equal(sanitizeBaseName(''), 'image');
  assert.equal(sanitizeBaseName(undefined), 'image');
});

test('buildDownloadName はモードに応じた PNG 名を返す', () => {
  assert.equal(buildDownloadName('photo.png', 'transparent'), 'photo-nobg.png');
  assert.equal(buildDownloadName('photo.jpg', 'color'), 'photo-composite.png');
  assert.equal(buildDownloadName('photo.jpg', 'image'), 'photo-composite.png');
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

test('Transformers.js のバージョンとキャッシュ名が固定されている', () => {
  assert.equal(TRANSFORMERS_VERSION, '4.2.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.2.0'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
});
