/**
 * builtin-ai.mjs — Chrome 組み込み AI API の共通ロジック
 *
 * Translator / LanguageDetector / Summarizer は Chrome 138 stable の
 * デスクトップ Chrome に内蔵されており、モデルはブラウザが管理する。
 * アプリ側で数百 MB の ONNX 重みをダウンロードしなくても翻訳・要約ができる。
 *
 * このファイルは DOM にも Chrome にも依存しない純粋ロジックだけを置く。
 * API の存在確認や create() の呼び出しは各アプリの script.js が行い、
 * ここには「与えられた availability をどう解釈するか」だけを書く。
 * Node の node:test から直接 import して検証できる。
 *
 * 出典:
 *   https://developer.chrome.com/docs/ai/built-in-apis
 *   https://developer.chrome.com/docs/ai/translator-api
 *   https://developer.chrome.com/docs/ai/summarizer-api
 */

/* ==========================================================
   バックエンド
   ========================================================== */

/** ブラウザ内蔵 API を使うバックエンド */
export const BUILTIN_BACKEND = 'builtin';
/** Transformers.js + ONNX モデルを使う従来バックエンド */
export const TRANSFORMERS_BACKEND = 'transformers';

/* ==========================================================
   availability
   ==========================================================
   Chrome の availability() は現行で 'available' | 'downloadable' |
   'downloading' | 'unavailable' を返す。旧仕様の 'readily' |
   'after-download' | 'no' も受け入れて同じ語彙に正規化する。
   ========================================================== */

export const AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  DOWNLOADABLE: 'downloadable',
  DOWNLOADING: 'downloading',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

/** availability の生値を 5 語彙のいずれかに正規化する */
export function normalizeAvailability(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  switch (raw) {
    case 'available':
    case 'readily':
      return AVAILABILITY.AVAILABLE;
    case 'downloadable':
    case 'after-download':
      return AVAILABILITY.DOWNLOADABLE;
    case 'downloading':
      return AVAILABILITY.DOWNLOADING;
    case 'unavailable':
    case 'no':
      return AVAILABILITY.UNAVAILABLE;
    default:
      return AVAILABILITY.UNKNOWN;
  }
}

/** 内蔵 API が使える (または使えるようになる) かどうか */
export function isBuiltinUsable(availability) {
  const normalized = normalizeAvailability(availability);
  return (
    normalized === AVAILABILITY.AVAILABLE ||
    normalized === AVAILABILITY.DOWNLOADABLE ||
    normalized === AVAILABILITY.DOWNLOADING
  );
}

/**
 * 内蔵 API が使えるなら builtin、そうでなければ transformers を選ぶ。
 * 対応外ブラウザでは常に transformers を返し、現行動作を変えない。
 */
export function chooseBackend(builtinAvailability) {
  return isBuiltinUsable(builtinAvailability) ? BUILTIN_BACKEND : TRANSFORMERS_BACKEND;
}

/* ==========================================================
   Translator / LanguageDetector
   ========================================================== */

/** アプリが扱う言語 (主言語タグ) */
export const SUPPORTED_LANGUAGE_TAGS = Object.freeze(['en', 'ja']);

/** BCP-47 タグの主言語部分だけを取り出す ('ja-JP' -> 'ja') */
export function normalizeLanguageTag(tag) {
  return String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** アプリが扱える言語かどうか */
export function isSupportedLanguage(tag) {
  return SUPPORTED_LANGUAGE_TAGS.includes(normalizeLanguageTag(tag));
}

/**
 * 翻訳方向から Translator に渡す言語ペアを返す。
 * 未知の方向は例外 (無言のフォールバックを避ける)。
 */
export function directionToLanguages(direction) {
  switch (direction) {
    case 'en-to-jp':
      return Object.freeze({ sourceLanguage: 'en', targetLanguage: 'ja' });
    case 'jp-to-en':
      return Object.freeze({ sourceLanguage: 'ja', targetLanguage: 'en' });
    default:
      throw new Error(`未知の翻訳方向です: ${direction}`);
  }
}

/**
 * LanguageDetector の結果から最も確度の高い言語タグを返す。
 * 空配列・不正値なら null。
 */
export function pickDetectedLanguage(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  let best = null;
  for (const result of results) {
    const tag = normalizeLanguageTag(result?.detectedLanguage);
    if (!isSupportedLanguage(tag)) continue;
    const confidence = Number.isFinite(Number(result?.confidence))
      ? Number(result.confidence)
      : 0;
    if (!best || confidence > best.confidence) best = { tag, confidence };
  }
  return best ? best.tag : null;
}

/**
 * 検出言語タグから翻訳方向を決める。en / ja 以外や判定不能なら fallback。
 * 入力言語を自動判定して翻訳方向を決める用途を想定する。
 */
export function directionFromLanguageTag(tag, fallback = 'en-to-jp') {
  switch (normalizeLanguageTag(tag)) {
    case 'en':
      return 'en-to-jp';
    case 'ja':
      return 'jp-to-en';
    default:
      return fallback;
  }
}

/** LanguageDetector の結果から翻訳方向を決める純関数版 */
export function detectDirection(results, fallback = 'en-to-jp') {
  const tag = pickDetectedLanguage(results);
  if (!tag) return fallback;
  return directionFromLanguageTag(tag, fallback);
}

/** 同意画面に出す内蔵翻訳の説明。使えないときは null。 */
export function builtinTranslationInfo(availability) {
  switch (normalizeAvailability(availability)) {
    case AVAILABILITY.AVAILABLE:
      return Object.freeze({
        needsDownload: false,
        button: 'ブラウザ内蔵翻訳で開始',
        modelLabel: 'ブラウザ内蔵翻訳 (Chrome)',
        note: 'モデルのダウンロードは不要です。Chrome に内蔵された翻訳をそのまま使います。',
      });
    case AVAILABILITY.DOWNLOADABLE:
      return Object.freeze({
        needsDownload: true,
        button: 'ブラウザ内蔵翻訳を有効化して開始',
        modelLabel: 'ブラウザ内蔵翻訳 (Chrome)',
        note: '初回のみ Chrome が内蔵翻訳モデルを取得します。アプリ側のダウンロードはありません。',
      });
    case AVAILABILITY.DOWNLOADING:
      return Object.freeze({
        needsDownload: true,
        button: 'ブラウザ内蔵翻訳で開始',
        modelLabel: 'ブラウザ内蔵翻訳 (Chrome)',
        note: 'Chrome が内蔵翻訳モデルを準備中です。',
      });
    default:
      return null;
  }
}

/* ==========================================================
   Summarizer
   ========================================================== */

export const SUMMARIZER_TYPES = Object.freeze(['key-points', 'tldr', 'teaser', 'headline']);
export const SUMMARIZER_FORMATS = Object.freeze(['markdown', 'plain-text']);
export const SUMMARIZER_LENGTHS = Object.freeze(['short', 'medium', 'long']);

export function normalizeSummaryType(type) {
  return SUMMARIZER_TYPES.includes(type) ? type : 'key-points';
}

export function normalizeSummaryFormat(format) {
  return SUMMARIZER_FORMATS.includes(format) ? format : 'markdown';
}

export function normalizeSummaryLength(length) {
  return SUMMARIZER_LENGTHS.includes(length) ? length : 'short';
}

/**
 * 要約ボタンを出してよいか。downloadable は「押すと取得して使う」ので含める。
 * 対応外ブラウザ (unavailable / unknown) では false になり、UI を変えない。
 */
export function isSummarizerAllowed(availability) {
  return isBuiltinUsable(availability);
}

/** 要約ボタンのラベル */
export function summarizerButtonLabel(availability) {
  return normalizeAvailability(availability) === AVAILABILITY.DOWNLOADABLE
    ? '要約を有効化して開始'
    : '要約する';
}

/**
 * Summarizer に渡すオプションを UI の選択値から組み立てる。
 * 未知の値は既定へ寄せる (Chrome 側で例外にしない)。
 */
export function buildSummarizerOptions({ type, format, length, sharedContext, expectedInputLanguages } = {}) {
  const options = {
    type: normalizeSummaryType(type),
    format: normalizeSummaryFormat(format),
    length: normalizeSummaryLength(length),
  };
  if (typeof sharedContext === 'string' && sharedContext.trim()) {
    options.sharedContext = sharedContext.trim();
  }
  if (Array.isArray(expectedInputLanguages) && expectedInputLanguages.length > 0) {
    options.expectedInputLanguages = expectedInputLanguages;
  }
  return options;
}
