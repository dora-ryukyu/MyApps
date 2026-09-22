/**
 * pipeline.mjs — ローカル翻訳の純粋ロジック
 *
 * このファイルは DOM / WebGPU / Worker に依存しない。
 * ブラウザでも Node でも同じように動く計算だけを置き、
 * worker.js からも script.js からも test/ からも import される。
 *
 * 推論そのものは worker.js が Transformers.js v4 の
 * AutoTokenizer + AutoModelForCausalLM で行う。ここには
 * モデル選択・プロンプト組み立て・サイズ見積りなどの純関数を置く。
 *
 * モデルは 2 世代を切り替えられる:
 *   - fast    … LFM2-350M-ENJP-MT (日英翻訳特化・軽量)
 *   - quality … LFM2.5-1.2B-JP (日本語 + 英語の汎用モデル)
 *
 * 出典:
 *   https://huggingface.co/onnx-community/LFM2-350M-ENJP-MT-ONNX
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
   モデルカタログ
   ==========================================================
   ファイルサイズは 2026-09-23 時点の HuggingFace API (blobs=true) の
   実測値。同意画面のダウンロード量表示とテストにだけ使う。
   ========================================================== */

export const MODEL_CATALOG = Object.freeze({
  fast: Object.freeze({
    key: 'fast',
    modelId: 'onnx-community/LFM2-350M-ENJP-MT-ONNX',
    label: '高速（350M）',
    shortLabel: 'LFM2-350M',
    description: '日英翻訳に特化した軽量モデル。速く、低メモリ。',
    license: 'LFM Open License 1.0（非 OSI）',
    commercial: false,
    homepage: 'https://huggingface.co/onnx-community/LFM2-350M-ENJP-MT-ONNX',
    /** dtype ごとの重みファイルと実バイト数 */
    files: Object.freeze({
      q4: Object.freeze({
        'onnx/model_q4.onnx': 177196,
        'onnx/model_q4.onnx_data': 481030144,
      }),
      q4f16: Object.freeze({
        'onnx/model_q4f16.onnx': 176487,
        'onnx/model_q4f16.onnx_data': 312342528,
      }),
      fp16: Object.freeze({
        'onnx/model_fp16.onnx': 142736,
        'onnx/model_fp16.onnx_data': 725350400,
      }),
      q8: Object.freeze({
        'onnx/model_quantized.onnx': 1397193,
        'onnx/model_quantized.onnx_data': 387352576,
      }),
    }),
    extraFiles: Object.freeze({
      'tokenizer.json': 3296918,
      'config.json': 1566,
      'tokenizer_config.json': 92935,
      'generation_config.json': 137,
    }),
    /**
     * LFM2 は conv + attention のハイブリッドで、q8 は WASM で
     * ConvInteger を使うため動かない (2026-09-17 実機確認)。そのため
     * 既存実績のある q4 を両バックエンドで使う。
     */
    dtype: Object.freeze({ webgpu: 'q4', wasm: 'q4' }),
  }),

  quality: Object.freeze({
    key: 'quality',
    modelId: 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX',
    label: '高品質（1.2B）',
    shortLabel: 'LFM2.5-1.2B-JP',
    description: '日本語と英語に対応した汎用モデル。文脈を踏まえた訳になる。',
    license: 'LFM Open License 1.0（非 OSI）',
    commercial: false,
    homepage: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-JP-202606-ONNX',
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
      q8: Object.freeze({
        'onnx/model_q8.onnx': 188702,
        'onnx/model_q8.onnx_data': 1768022016,
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
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODEL_CATALOG));
export const DEFAULT_MODE = 'fast';

/** 未知のキーは例外にする (無言のフォールバックを避ける) */
export function getModel(modeKey) {
  const model = MODEL_CATALOG[modeKey];
  if (!model) throw new Error(`未知のモデルです: ${modeKey}`);
  return model;
}

/** UI の選択肢を配列で返す */
export function listModels() {
  return MODEL_KEYS.map((key) => MODEL_CATALOG[key]);
}

/* ==========================================================
   翻訳方向とプロンプト
   ========================================================== */

export const DIRECTIONS = Object.freeze([
  Object.freeze({ key: 'en-to-jp', label: '英語 → 日本語', system: 'Translate to Japanese.' }),
  Object.freeze({ key: 'jp-to-en', label: '日本語 → 英語', system: 'Translate to English.' }),
]);

export const SYSTEM_EN_TO_JP = 'Translate to Japanese.';
export const SYSTEM_JP_TO_EN = 'Translate to English.';

/** 翻訳方向から system プロンプトを返す。未知なら例外。 */
export function systemPrompt(direction) {
  const found = DIRECTIONS.find((d) => d.key === direction);
  if (!found) throw new Error(`未知の翻訳方向です: ${direction}`);
  return found.system;
}

/**
 * チャットテンプレートに渡すメッセージ配列を組み立てる。
 * worker.js とテストの両方が同じ形を使う。
 */
export function buildMessages(direction, text) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('翻訳するテキストが空です');
  return [
    { role: 'system', content: systemPrompt(direction) },
    { role: 'user', content },
  ];
}

/** モデル出力から特殊トークン・余分な空白を取り除く */
export function cleanTranslation(text) {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
}

/** 生成の上限トークン数 */
export const MAX_NEW_TOKENS = 512;

/** 入力の最大文字数 (モデルのコンテキストを超えないための目安) */
export const MAX_INPUT_CHARS = 6000;

/** リアルタイム翻訳のデバウンス (ms) */
export const DEBOUNCE_MS = 400;

/* ==========================================================
   バックエンド / dtype の決定
   ========================================================== */

/** WebGPU が使えるかどうかから実行デバイスを選ぶ */
export function detectDevice(hasWebGPU) {
  return hasWebGPU ? 'webgpu' : 'wasm';
}

/** モデル × デバイスで使う dtype を返す */
export function resolveDtype(modeKey, device) {
  const model = getModel(modeKey);
  const dtype = model.dtype[device] || model.dtype.wasm || model.dtype.fp32;
  if (!model.files[dtype]) {
    throw new Error(`${modeKey} には dtype "${dtype}" の重みがありません`);
  }
  return dtype;
}

/** 初回ダウンロード量 (重み + トークナイザ等) をバイトで見積もる */
export function estimateModelBytes(modeKey, device) {
  const model = getModel(modeKey);
  const dtype = resolveDtype(modeKey, device);
  let total = 0;
  for (const size of Object.values(model.files[dtype])) total += size;
  for (const size of Object.values(model.extraFiles)) total += size;
  return total;
}

/**
 * モード × 実行環境から、実際に使うモデル・デバイス・dtype を決める。
 * worker.js と script.js の両方がこれを使い、表示と実推論を一致させる。
 */
export function chooseModel(modeKey, hasWebGPU) {
  const model = getModel(modeKey);
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
