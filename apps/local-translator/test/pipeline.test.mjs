import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  MODEL_CATALOG,
  MODEL_KEYS,
  DEFAULT_MODE,
  DIRECTIONS,
  MAX_NEW_TOKENS,
  MAX_INPUT_CHARS,
  DEBOUNCE_MS,
  getModel,
  listModels,
  systemPrompt,
  buildMessages,
  cleanTranslation,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  formatBytes,
  formatSpeed,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 選択
   ========================================================== */

test('モデルカタログは fast / quality の 2 世代を持つ', () => {
  assert.deepEqual(MODEL_KEYS, ['fast', 'quality']);
  assert.equal(MODEL_CATALOG.fast.modelId, 'onnx-community/LFM2-350M-ENJP-MT-ONNX');
  assert.equal(MODEL_CATALOG.quality.modelId, 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX');
});

test('未知のモデルは例外、listModels は定義順に返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.deepEqual(
    listModels().map((m) => m.key),
    ['fast', 'quality'],
  );
});

test('ライセンスは両モデルとも LFM Open License 1.0 で非商用扱い', () => {
  for (const key of MODEL_KEYS) {
    assert.equal(MODEL_CATALOG[key].commercial, false);
    assert.match(MODEL_CATALOG[key].license, /LFM Open License/);
  }
});

test('dtype はデバイスごとに定義され、重みファイルが存在する', () => {
  for (const key of MODEL_KEYS) {
    const model = MODEL_CATALOG[key];
    for (const device of ['webgpu', 'wasm']) {
      const dtype = resolveDtype(key, device);
      assert.ok(model.files[dtype], `${key}/${device} の dtype ${dtype} が無い`);
    }
  }
  assert.equal(resolveDtype('fast', 'webgpu'), 'q4');
  assert.equal(resolveDtype('fast', 'wasm'), 'q4');
  assert.equal(resolveDtype('quality', 'webgpu'), 'q4f16');
  assert.equal(resolveDtype('quality', 'wasm'), 'q4');
});

test('detectDevice は WebGPU の有無で webgpu/wasm を返す', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');
});

test('estimateModelBytes は重み + 付属ファイルの実測値の合計を返す', () => {
  // fast q4 = 177196 + 481030144 + tokenizer/config 系 3391556
  assert.equal(estimateModelBytes('fast', 'wasm'), 484598896);
  // quality q4f16 = 129098 + 744091648 + 4736460
  assert.equal(estimateModelBytes('quality', 'webgpu'), 748957206);
  // quality q4 (WASM) = 173643 + 833871872 + 4736460
  assert.equal(estimateModelBytes('quality', 'wasm'), 838781975);
  assert.ok(estimateModelBytes('quality', 'wasm') > estimateModelBytes('fast', 'wasm'));
});

test('chooseModel はモードと WebGPU 有無からモデル・device・dtype を決める', () => {
  const fast = chooseModel('fast', true);
  assert.equal(fast.modeKey, 'fast');
  assert.equal(fast.device, 'webgpu');
  assert.equal(fast.dtype, 'q4');

  const quality = chooseModel('quality', false);
  assert.equal(quality.modeKey, 'quality');
  assert.equal(quality.device, 'wasm');
  assert.equal(quality.dtype, 'q4');
  assert.equal(quality.commercial, false);
  assert.ok(Object.isFrozen(quality));
});

/* ==========================================================
   プロンプト / 出力整形
   ========================================================== */

test('DIRECTIONS は 2 方向で、systemPrompt は未知を弾く', () => {
  assert.deepEqual(
    DIRECTIONS.map((d) => d.key),
    ['en-to-jp', 'jp-to-en'],
  );
  assert.equal(systemPrompt('en-to-jp'), 'Translate to Japanese.');
  assert.equal(systemPrompt('jp-to-en'), 'Translate to English.');
  assert.throws(() => systemPrompt('bogus'), /未知の翻訳方向/);
});

test('buildMessages は system + user を作り、空入力は例外', () => {
  const messages = buildMessages('en-to-jp', '  Hello  ');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'Translate to Japanese.');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, 'Hello');
  assert.throws(() => buildMessages('en-to-jp', '   '), /空/);
});

test('cleanTranslation は特殊トークンを取り除いて trim する', () => {
  assert.equal(cleanTranslation('<|im_end|> こんにちは <|startoftext|>'), 'こんにちは');
  assert.equal(cleanTranslation('  hello  '), 'hello');
  assert.equal(cleanTranslation(null), '');
});

/* ==========================================================
   表示ヘルパー
   ========================================================== */

test('formatBytes は 1024 基準で表記する', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(484598896), '462.1 MiB');
  assert.equal(formatBytes(748957206), '714.3 MiB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GiB');
  assert.equal(formatBytes(NaN), '-');
  assert.equal(formatBytes(-1), '-');
});

test('formatSpeed は tok/s を返し、不正値は —', () => {
  assert.equal(formatSpeed(100, 2000), '50.0');
  assert.equal(formatSpeed(0, 1000), '—');
  assert.equal(formatSpeed(10, 0), '—');
});

test('Transformers.js のバージョンとキャッシュ名が固定されている', () => {
  assert.equal(TRANSFORMERS_VERSION, '4.2.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.2.0'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
});

test('既定値 (モード / 上限) が固定されている', () => {
  assert.equal(DEFAULT_MODE, 'fast');
  assert.equal(MAX_NEW_TOKENS, 512);
  assert.equal(MAX_INPUT_CHARS, 6000);
  assert.equal(DEBOUNCE_MS, 400);
});
