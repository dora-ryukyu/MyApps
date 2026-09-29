import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STRUCTURED_OUTPUT_VERSION,
  STRUCTURED_OUTPUT_MODULE_URL,
  STRUCTURED_TASKS,
  supportsStructuredOutput,
  buildJsonSchema,
  resolveResponseFormat,
  createStructuredProcessor,
} from '../structured-output.mjs';

/* ==========================================================
   定数
   ========================================================== */

test('structured output の版と URL が固定されている', () => {
  assert.equal(STRUCTURED_OUTPUT_VERSION, '4.3.0');
  assert.ok(STRUCTURED_OUTPUT_MODULE_URL.includes(
    '@huggingface/transformers-structured-output@4.3.0',
  ));
  // worker から import map 無しで読めるよう `/+esm` を使う
  assert.ok(STRUCTURED_OUTPUT_MODULE_URL.endsWith('/+esm'));
  assert.deepEqual([...STRUCTURED_TASKS], ['extract']);
});

test('supportsStructuredOutput は extract だけ true', () => {
  assert.equal(supportsStructuredOutput('extract'), true);
  assert.equal(supportsStructuredOutput('summarize'), false);
  assert.equal(supportsStructuredOutput('qa'), false);
  assert.equal(supportsStructuredOutput(''), false);
  assert.equal(supportsStructuredOutput(undefined), false);
});

/* ==========================================================
   JSON Schema
   ========================================================== */

test('buildJsonSchema は各項目を必須の string プロパティにする', () => {
  const schema = buildJsonSchema(['氏名', '会社名']);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['氏名', '会社名']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties['氏名'], { type: 'string' });
  assert.deepEqual(schema.properties['会社名'], { type: 'string' });
});

test('buildJsonSchema は空白を除去し、重複を除き、空を落とす', () => {
  const schema = buildJsonSchema(['  氏名 ', '氏名', '', '   ', '会社名']);
  assert.deepEqual(schema.required, ['氏名', '会社名']);
  assert.deepEqual(Object.keys(schema.properties), ['氏名', '会社名']);
});

test('buildJsonSchema は有効な項目が無ければ null', () => {
  assert.equal(buildJsonSchema([]), null);
  assert.equal(buildJsonSchema(['', '   ']), null);
  assert.equal(buildJsonSchema(null), null);
  assert.equal(buildJsonSchema(undefined), null);
  assert.equal(buildJsonSchema('氏名'), null);
});

/* ==========================================================
   ResponseFormat
   ========================================================== */

test('resolveResponseFormat は extract で json_schema を返す', () => {
  const format = resolveResponseFormat('extract', ['氏名', '住所']);
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.type, 'object');
  assert.deepEqual(format.json_schema.required, ['氏名', '住所']);
});

test('resolveResponseFormat は対象外タスク / 項目なしで null', () => {
  assert.equal(resolveResponseFormat('summarize', ['氏名']), null);
  assert.equal(resolveResponseFormat('qa', ['氏名']), null);
  assert.equal(resolveResponseFormat('extract', []), null);
  assert.equal(resolveResponseFormat('extract', undefined), null);
});

/* ==========================================================
   processor 生成
   ========================================================== */

test('createStructuredProcessor はモジュールからインスタンスを作る', () => {
  const calls = [];
  class FakeProcessor {
    constructor(tokenizer, responseFormat) {
      calls.push({ tokenizer, responseFormat });
    }
  }
  const tokenizer = { name: 'tokenizer' };
  const format = resolveResponseFormat('extract', ['氏名']);
  const processor = createStructuredProcessor(
    { StructuredOutputProcessor: FakeProcessor },
    tokenizer,
    format,
  );
  assert.ok(processor instanceof FakeProcessor);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokenizer, tokenizer);
  assert.equal(calls[0].responseFormat, format);
});

test('createStructuredProcessor はモジュール欠落 / format 無しで null', () => {
  const format = resolveResponseFormat('extract', ['氏名']);
  assert.equal(createStructuredProcessor(null, {}, format), null);
  assert.equal(createStructuredProcessor({}, {}, format), null);
  assert.equal(createStructuredProcessor({ StructuredOutputProcessor: 'x' }, {}, format), null);
  assert.equal(createStructuredProcessor({ StructuredOutputProcessor: class {} }, {}, null), null);
});
