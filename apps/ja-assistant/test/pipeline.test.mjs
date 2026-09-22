import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSFORMERS_VERSION,
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  MODEL,
  MODEL_KEYS,
  DEFAULT_MODEL_KEY,
  TASKS,
  TASK_KEYS,
  DEFAULT_TASK,
  DEFAULT_FIELDS,
  MAX_INPUT_CHARS,
  DEFAULT_MAX_NEW_TOKENS,
  getModel,
  listModels,
  getTask,
  normalizeFields,
  buildMessages,
  cleanOutput,
  parseJsonLoose,
  formatResult,
  detectDevice,
  resolveDtype,
  estimateModelBytes,
  chooseModel,
  formatBytes,
  formatSpeed,
} from '../pipeline.mjs';

/* ==========================================================
   モデル
   ========================================================== */

test('モデルは LFM2.5-1.2B-JP 1 件で、id とライセンスが正しい', () => {
  assert.deepEqual(MODEL_KEYS, ['lfm25-1.2b-jp']);
  assert.equal(MODEL.modelId, 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX');
  assert.equal(MODEL.commercial, false);
  assert.match(MODEL.license, /LFM Open License/);
  assert.equal(MODEL.contextTokens, 32768);
  assert.equal(DEFAULT_MODEL_KEY, MODEL.key);
});

test('未知のモデルは例外、listModels は 1 件を返す', () => {
  assert.throws(() => getModel('nope'), /未知のモデル/);
  assert.deepEqual(
    listModels().map((m) => m.key),
    ['lfm25-1.2b-jp'],
  );
});

test('dtype は WebGPU=q4f16 / WASM=q4 で、重みが存在する', () => {
  assert.equal(resolveDtype(MODEL.key, 'webgpu'), 'q4f16');
  assert.equal(resolveDtype(MODEL.key, 'wasm'), 'q4');
  for (const dtype of ['q4f16', 'q4', 'fp16']) {
    assert.ok(MODEL.files[dtype], `${dtype} の重みが無い`);
  }
});

test('estimateModelBytes は重み + 付属ファイルの実測値の合計を返す', () => {
  // q4f16 = 129098 + 744091648 + 4736460
  assert.equal(estimateModelBytes(MODEL.key, 'webgpu'), 748957206);
  // q4 (WASM) = 173643 + 833871872 + 4736460
  assert.equal(estimateModelBytes(MODEL.key, 'wasm'), 838781975);
  assert.ok(estimateModelBytes(MODEL.key, 'wasm') > estimateModelBytes(MODEL.key, 'webgpu'));
});

test('detectDevice / chooseModel', () => {
  assert.equal(detectDevice(true), 'webgpu');
  assert.equal(detectDevice(false), 'wasm');
  assert.equal(detectDevice(undefined), 'wasm');

  const gpu = chooseModel(MODEL.key, true);
  assert.equal(gpu.device, 'webgpu');
  assert.equal(gpu.dtype, 'q4f16');
  assert.equal(gpu.commercial, false);
  assert.ok(Object.isFrozen(gpu));
});

/* ==========================================================
   タスク
   ========================================================== */

test('TASKS は summarize / qa / extract の 3 つ', () => {
  assert.deepEqual(TASK_KEYS, ['summarize', 'qa', 'extract']);
  assert.equal(DEFAULT_TASK, 'summarize');
  for (const task of TASKS) {
    assert.ok(task.system && task.system.length > 0, `${task.key} に system が無い`);
    assert.ok(task.maxNewTokens > 0);
  }
  assert.throws(() => getTask('bogus'), /未知のタスク/);
  assert.equal(getTask('qa').label, 'Q&A');
});

/* ==========================================================
   入力の正規化
   ========================================================== */

test('normalizeFields はカンマ・読点・改行で分割し、空なら既定を返す', () => {
  assert.deepEqual(normalizeFields('日付, 人名、組織\n場所'), ['日付', '人名', '組織', '場所']);
  assert.deepEqual(normalizeFields('  '), [...DEFAULT_FIELDS]);
  assert.deepEqual(normalizeFields(null), [...DEFAULT_FIELDS]);
});

/* ==========================================================
   プロンプト組み立て
   ========================================================== */

test('buildMessages: 要約は system + user の 2 メッセージ', () => {
  const messages = buildMessages('summarize', { input: '  本文です。  ' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, getTask('summarize').system);
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('本文です。'));
});

test('buildMessages: Q&A は質問が必須', () => {
  assert.throws(() => buildMessages('qa', { input: '本文', question: '  ' }), /質問を入力/);
  const messages = buildMessages('qa', { input: '本文', question: '結論は？' });
  assert.ok(messages[1].content.includes('結論は？'));
  assert.ok(messages[1].content.includes('本文'));
});

test('buildMessages: 抽出は項目を JSON キーとして指示する', () => {
  const messages = buildMessages('extract', { input: '本文', fields: ['日付', '金額'] });
  assert.ok(messages[1].content.includes('日付, 金額'));
  const withDefault = buildMessages('extract', { input: '本文' });
  assert.ok(withDefault[1].content.includes(DEFAULT_FIELDS[0]));
});

test('buildMessages は空入力と長すぎる入力を弾く', () => {
  assert.throws(() => buildMessages('summarize', { input: '   ' }), /入力/);
  assert.throws(
    () => buildMessages('summarize', { input: 'あ'.repeat(MAX_INPUT_CHARS + 1) }),
    /長すぎ/,
  );
});

/* ==========================================================
   出力の整形
   ========================================================== */

test('cleanOutput は特殊トークンとコードフェンスを外す', () => {
  assert.equal(cleanOutput('<|im_end|> 要約です <|startoftext|>'), '要約です');
  assert.equal(cleanOutput('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(cleanOutput(null), '');
});

test('parseJsonLoose は最初の JSON オブジェクトを取り出す', () => {
  assert.deepEqual(parseJsonLoose('前置き {"a":1,"b":"x"} 後書き'), { a: 1, b: 'x' });
  assert.deepEqual(parseJsonLoose('```json\n{"ok":true}\n```'), { ok: true });
  assert.equal(parseJsonLoose('JSON ではありません'), null);
  assert.equal(parseJsonLoose('{壊れた}'), null);
});

test('formatResult は extract のときだけ JSON を整形する', () => {
  assert.equal(formatResult('こんにちは', 'summarize'), 'こんにちは');
  assert.equal(formatResult('{"a":1}', 'extract'), '{\n  "a": 1\n}');
  assert.equal(formatResult('JSON ではない', 'extract'), 'JSON ではない');
});

/* ==========================================================
   表示ヘルパー / 定数
   ========================================================== */

test('formatBytes は 1024 基準、formatSpeed は tok/s', () => {
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(748957206), '714.3 MiB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '-');
  assert.equal(formatSpeed(200, 4000), '50.0');
  assert.equal(formatSpeed(0, 1000), '—');
});

test('Transformers.js / キャッシュ / 上限が固定されている', () => {
  assert.equal(TRANSFORMERS_VERSION, '4.2.0');
  assert.ok(TRANSFORMERS_MODULE_URL.includes('@huggingface/transformers@4.2.0'));
  assert.equal(CACHE_PREFIX, 'transformers-cache');
  assert.equal(MAX_INPUT_CHARS, 12000);
  assert.equal(DEFAULT_MAX_NEW_TOKENS, 512);
});
