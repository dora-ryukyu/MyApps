/**
 * structured-output.mjs — JSON 出力を強制する「構造化デコード」の純粋ロジック
 *
 * Transformers.js v4.3.0 で追加された実験的パッケージ
 * `@huggingface/transformers-structured-output` を、ja-assistant の
 * 「構造化抽出」タスクだけに使う。生成時に `logits_processor` として
 * `StructuredOutputProcessor` を渡すと、出力が JSON Schema を満たすよう
 * トークン確率がマスクされる。
 *
 * このファイルは DOM / Worker / Transformers.js 本体に依存しない。
 * URL の組み立て・JSON Schema の生成・ResponseFormat の決定という純関数だけを置き、
 * 実際の import と `model.generate()` への受け渡しは worker.js が行う。
 * Node の node:test から直接 import して検証できる。
 *
 * なぜ `/+esm` なのか:
 *   配信元の dist は `@huggingface/transformers` をベア識別子で import している。
 *   import map は worker に適用されないため、そのままでは worker 内で解決できない。
 *   jsDelivr の `/+esm` は依存を絶対 URL に変換してくれるので、import map 無しで
 *   worker から動的 import できる。
 *
 * 出典:
 *   https://github.com/huggingface/transformers.js/releases/tag/4.3.0
 *   https://www.npmjs.com/package/@huggingface/transformers-structured-output
 */

/* ==========================================================
   Transformers.js structured output
   ========================================================== */

/** structured output パッケージの版 (Transformers.js 本体と揃える) */
export const STRUCTURED_OUTPUT_VERSION = '4.3.0';

/** ブラウザの worker から動的 import する URL (`/+esm` がベア import を解決する) */
export const STRUCTURED_OUTPUT_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers-structured-output@${STRUCTURED_OUTPUT_VERSION}/+esm`;

/** 構造化デコードを使うタスク。今は JSON を返す extract だけ。 */
export const STRUCTURED_TASKS = Object.freeze(['extract']);

/** このタスクで構造化デコードを使う対象かどうか */
export function supportsStructuredOutput(taskKey) {
  return STRUCTURED_TASKS.includes(taskKey);
}

/* ==========================================================
   JSON Schema
   ========================================================== */

/**
 * 抽出項目の一覧から JSON Schema を組み立てる。
 * 各項目を文字列型の必須プロパティにし、余計なキーを禁止する。
 * 有効な項目が 1 つも無ければ null。
 */
export function buildJsonSchema(fields) {
  const names = [];
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const name = String(field ?? '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  if (names.length === 0) return null;

  const properties = {};
  for (const name of names) {
    properties[name] = { type: 'string' };
  }
  return {
    type: 'object',
    properties,
    required: [...names],
    additionalProperties: false,
  };
}

/**
 * タスクと抽出項目からパッケージが受け取る ResponseFormat を作る。
 * 対象外タスク・項目なしなら null (= 制約なしで生成する)。
 */
export function resolveResponseFormat(taskKey, fields) {
  if (!supportsStructuredOutput(taskKey)) return null;
  const jsonSchema = buildJsonSchema(fields);
  if (!jsonSchema) return null;
  return { type: 'json_schema', json_schema: jsonSchema };
}

/* ==========================================================
   processor の生成
   ========================================================== */

/**
 * import 済みモジュールから StructuredOutputProcessor を生成する。
 * モジュールが読めなかった / クラスが無い / format が無い場合は null を返し、
 * 呼び出し側は「制約なし」にフォールバックできる。
 */
export function createStructuredProcessor(module, tokenizer, responseFormat) {
  const Ctor = module && module.StructuredOutputProcessor;
  if (typeof Ctor !== 'function') return null;
  if (!responseFormat) return null;
  return new Ctor(tokenizer, responseFormat);
}
