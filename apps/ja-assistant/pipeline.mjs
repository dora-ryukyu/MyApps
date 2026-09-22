/**
 * pipeline.mjs — 日本語アシスタントの純粋ロジック
 *
 * このファイルは DOM / WebGPU / Worker に依存しない。
 * ブラウザでも Node でも同じように動く計算だけを置き、
 * worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは worker.js が Transformers.js v4 の
 * AutoTokenizer + AutoModelForCausalLM で行う。ここには
 * モデル定義・タスク定義・プロンプト組み立て・出力整形などの純関数を置く。
 *
 * モデル: LiquidAI/LFM2.5-1.2B-JP-202606-ONNX
 *   Translators.js + WebGPU 用の q4f16 を含む ONNX が同梱され、
 *   日本語 + 英語、32,768 token のコンテキストを持つ。
 *
 * 出典:
 *   https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-202606-ONNX
 */

/* ==========================================================
   Transformers.js
   ========================================================== */

export const TRANSFORMERS_VERSION = '4.2.0';
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/** Transformers.js がモデルを保存する Cache Storage の既定プレフィックス */
export const CACHE_PREFIX = 'transformers-cache';

/* ==========================================================
   モデル定義
   ==========================================================
   ファイルサイズは 2026-09-23 時点の HuggingFace API (blobs=true) の
   実測値。同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

export const MODEL = Object.freeze({
  key: 'lfm25-1.2b-jp',
  modelId: 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX',
  label: 'LFM2.5 1.2B JP',
  shortLabel: 'LFM2.5-1.2B-JP',
  description: '日本語と英語に対応した汎用のオンデバイスモデル。',
  license: 'LFM Open License 1.0（非 OSI）',
  commercial: false,
  homepage: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-202606-ONNX',
  contextTokens: 32768,
  /** dtype ごとの重みファイルと実バイト数 */
  files: Object.freeze({
    q4f16: Object.freeze({
      'onnx/model_q4f16.onnx': 129098,
      'onnx/model_q4f16.onnx_data': 744091648,
    }),
    q4: Object.freeze({
      'onnx/model_q4.onnx': 173643,
      'onnx/model_q4.onnx_data': 833871872,
    }),
    fp16: Object.freeze({
      'onnx/model_fp16.onnx': 151225,
      'onnx/model_fp16.onnx_data': 2134740992,
      'onnx/model_fp16.onnx_data_1': 222322688,
    }),
  }),
  extraFiles: Object.freeze({
    'tokenizer.json': 4733020,
    'config.json': 1412,
    'tokenizer_config.json': 1897,
    'generation_config.json': 131,
  }),
  /** WebGPU は q4f16 (モデルカード推奨)、WASM は conv の都合で q4。 */
  dtype: Object.freeze({ webgpu: 'q4f16', wasm: 'q4' }),
});

export const MODEL_KEYS = Object.freeze([MODEL.key]);
export const DEFAULT_MODEL_KEY = MODEL.key;

/** 未知のキーは例外にする (無言のフォールバックを避ける) */
export function getModel(modelKey) {
  if (modelKey !== MODEL.key) throw new Error(`未知のモデルです: ${modelKey}`);
  return MODEL;
}

export function listModels() {
  return [MODEL];
}

/* ==========================================================
   タスク定義
   ========================================================== */

export const TASKS = Object.freeze([
  Object.freeze({
    key: 'summarize',
    label: '要約',
    description: '長い文章を 3〜5 文の日本語にまとめる。',
    system:
      'あなたは与えられた日本語の文章を、要点を落とさず簡潔に要約するアシスタントです。' +
      '箇条書きは使わず、3〜5 文の日本語でまとめてください。',
    maxNewTokens: 512,
  }),
  Object.freeze({
    key: 'qa',
    label: 'Q&A',
    description: '文章についての質問に、文章中の情報だけから答える。',
    system:
      'あなたは与えられた文章について質問に答えるアシスタントです。' +
      '回答は必ず文章中の情報だけに基づき、推測で補わないでください。' +
      '文章に情報が無い場合は「文章中に情報がありません」とだけ答えてください。',
    maxNewTokens: 512,
  }),
  Object.freeze({
    key: 'extract',
    label: '構造化抽出',
    description: '指定した項目を抜き出して JSON で返す。',
    system:
      'あなたは日本語の文章から指定された項目を抽出し、JSON だけを出力するアシスタントです。' +
      '説明や前置き、コードフェンスは書かず、JSON オブジェクトのみを返してください。' +
      '値が見つからない項目は null にしてください。',
    maxNewTokens: 512,
  }),
]);

export const TASK_KEYS = Object.freeze(TASKS.map((t) => t.key));
export const DEFAULT_TASK = 'summarize';

/** 未知のタスクキーは例外にする */
export function getTask(taskKey) {
  const task = TASKS.find((t) => t.key === taskKey);
  if (!task) throw new Error(`未知のタスクです: ${taskKey}`);
  return task;
}

/* ==========================================================
   入力の制約
   ========================================================== */

/** 入力の最大文字数 (コンテキストを超えないための目安) */
export const MAX_INPUT_CHARS = 12000;

/** 生成の上限トークン数 (タスク未指定時のフォールバック) */
export const DEFAULT_MAX_NEW_TOKENS = 512;

/** 抽出で既定で使う項目 */
export const DEFAULT_FIELDS = Object.freeze(['日付', '人名', '組織', '場所', '金額', '要点']);

/**
 * UI のテキスト (カンマ・読点・改行区切り) を項目配列へ正規化する。
 * 空なら既定項目を返す。
 */
export function normalizeFields(raw) {
  const source = raw == null ? '' : String(raw);
  const parts = source
    .split(/[\n,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [...DEFAULT_FIELDS];
}

/* ==========================================================
   プロンプト組み立て
   ========================================================== */

/**
 * タスクと入力からチャットメッセージを組み立てる。
 * 必須項目が欠けていれば例外を投げる。
 */
export function buildMessages(taskKey, { input, question, fields } = {}) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('テキストを入力してください');
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`入力が長すぎます (最大 ${MAX_INPUT_CHARS} 文字)`);
  }
  const task = getTask(taskKey);

  let user;
  if (task.key === 'summarize') {
    user = `次の文章を要約してください。\n\n---\n${text}\n---`;
  } else if (task.key === 'qa') {
    const q = String(question ?? '').trim();
    if (!q) throw new Error('質問を入力してください');
    user = `# 文章\n${text}\n\n# 質問\n${q}`;
  } else {
    const items = Array.isArray(fields) ? fields : normalizeFields(fields);
    if (items.length === 0) throw new Error('抽出する項目を 1 つ以上指定してください');
    user = `次の項目を JSON のキーとして抽出してください。\n項目: ${items.join(', ')}\n\n# 文章\n${text}`;
  }

  return [
    { role: 'system', content: task.system },
    { role: 'user', content: user },
  ];
}

/* ==========================================================
   出力の整形
   ========================================================== */

/** モデル出力から特殊トークン・コードフェンスを取り除く */
export function cleanOutput(text) {
  let out = String(text ?? '').replace(/<\|[^|]*\|>/g, '');
  // ```json ... ``` のフェンスを外す
  out = out.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  return out.trim();
}

/**
 * モデル出力から最初の JSON オブジェクトを取り出してパースする。
 * 失敗したら null を返す (例外にしない)。
 */
export function parseJsonLoose(text) {
  const cleaned = cleanOutput(text);
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  // 最後の } までを候補にする
  const end = cleaned.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** JSON を整形して表示用の文字列にする。失敗時は元の文字列。 */
export function formatResult(text, taskKey) {
  const cleaned = cleanOutput(text);
  if (taskKey !== 'extract') return cleaned;
  const parsed = parseJsonLoose(cleaned);
  return parsed === null ? cleaned : JSON.stringify(parsed, null, 2);
}

/* ==========================================================
   バックエンド / dtype の決定
   ========================================================== */

/** WebGPU が使えるかどうかから実行デバイスを選ぶ */
export function detectDevice(hasWebGPU) {
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** モデル × デバイスで使う dtype を返す */
export function resolveDtype(modelKey, device) {
  const model = getModel(modelKey);
  const dtype = model.dtype[device] || model.dtype.wasm || model.dtype.fp32;
  if (!model.files[dtype]) {
    throw new Error(`${modelKey} には dtype "${dtype}" の重みがありません`);
  }
  return dtype;
}

/** 初回ダウンロード量 (重み + トークナイザ等) をバイトで見積もる */
export function estimateModelBytes(modelKey, device) {
  const model = getModel(modelKey);
  const dtype = resolveDtype(modelKey, device);
  let total = 0;
  for (const size of Object.values(model.files[dtype])) total += size;
  for (const size of Object.values(model.extraFiles)) total += size;
  return total;
}

/**
 * モデル × 実行環境から、実際に使うデバイス・dtype を決める。
 * worker.js と script.js の両方がこれを使い、表示と実推論を一致させる。
 */
export function chooseModel(modelKey, hasWebGPU) {
  const model = getModel(modelKey);
  const device = detectDevice(Boolean(hasWebGPU));
  const dtype = resolveDtype(model.key, device);
  return Object.freeze({
    modeKey: model.key,
    modelId: model.modelId,
    label: model.label,
    shortLabel: model.shortLabel,
    description: model.description,
    device,
    dtype,
    license: model.license,
    commercial: model.commercial,
    homepage: model.homepage,
    contextTokens: model.contextTokens,
    bytes: estimateModelBytes(model.key, device),
  });
}

/* ==========================================================
   表示ヘルパー
   ========================================================== */

/** バイト数を人が読める表記にする (1024 基準) */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const kib = bytes / 1024;
  if (kib < 1) return `${bytes} B`;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

/** 生成速度 (tok/s) を表示用に丸める。elapsed<=0 は '—'。 */
export function formatSpeed(tokens, elapsedMs) {
  if (!(elapsedMs > 0) || !(tokens > 0)) return '—';
  return (tokens / (elapsedMs / 1000)).toFixed(1);
}
