import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_BACKEND,
  TRANSFORMERS_BACKEND,
  AVAILABILITY,
  normalizeAvailability,
  isBuiltinUsable,
  chooseBackend,
  SUPPORTED_LANGUAGE_TAGS,
  normalizeLanguageTag,
  isSupportedLanguage,
  directionToLanguages,
  pickDetectedLanguage,
  directionFromLanguageTag,
  detectDirection,
  builtinTranslationInfo,
  SUMMARIZER_TYPES,
  SUMMARIZER_FORMATS,
  SUMMARIZER_LENGTHS,
  normalizeSummaryType,
  normalizeSummaryFormat,
  normalizeSummaryLength,
  isSummarizerAllowed,
  summarizerButtonLabel,
  buildSummarizerOptions,
} from '../builtin-ai.mjs';

/* ==========================================================
   availability / バックエンド
   ========================================================== */

test('normalizeAvailability は新旧の語彙を 5 語彙へ正規化する', () => {
  assert.equal(normalizeAvailability('available'), 'available');
  assert.equal(normalizeAvailability('readily'), 'available');
  assert.equal(normalizeAvailability('downloadable'), 'downloadable');
  assert.equal(normalizeAvailability('after-download'), 'downloadable');
  assert.equal(normalizeAvailability('downloading'), 'downloading');
  assert.equal(normalizeAvailability('unavailable'), 'unavailable');
  assert.equal(normalizeAvailability('no'), 'unavailable');
  assert.equal(normalizeAvailability(''), 'unknown');
  assert.equal(normalizeAvailability(undefined), 'unknown');
  assert.equal(normalizeAvailability('  AVAILABLE  '), 'available');
});

test('isBuiltinUsable は available/downloadable/downloading のみ true', () => {
  assert.equal(isBuiltinUsable('available'), true);
  assert.equal(isBuiltinUsable('downloadable'), true);
  assert.equal(isBuiltinUsable('downloading'), true);
  assert.equal(isBuiltinUsable('unavailable'), false);
  assert.equal(isBuiltinUsable('unknown'), false);
  assert.equal(isBuiltinUsable(undefined), false);
});

test('chooseBackend は使えるなら builtin、対応外なら transformers', () => {
  assert.equal(chooseBackend('available'), BUILTIN_BACKEND);
  assert.equal(chooseBackend('after-download'), BUILTIN_BACKEND);
  assert.equal(chooseBackend('unavailable'), TRANSFORMERS_BACKEND);
  assert.equal(chooseBackend(undefined), TRANSFORMERS_BACKEND);
});

/* ==========================================================
   言語タグ / 翻訳方向
   ========================================================== */

test('normalizeLanguageTag は主言語だけを小文字で取り出す', () => {
  assert.equal(normalizeLanguageTag('ja-JP'), 'ja');
  assert.equal(normalizeLanguageTag('EN_us'), 'en');
  assert.equal(normalizeLanguageTag('  Ja  '), 'ja');
  assert.equal(normalizeLanguageTag(null), '');
});

test('isSupportedLanguage は en / ja のみ true', () => {
  assert.deepEqual(SUPPORTED_LANGUAGE_TAGS, ['en', 'ja']);
  assert.equal(isSupportedLanguage('en'), true);
  assert.equal(isSupportedLanguage('ja-JP'), true);
  assert.equal(isSupportedLanguage('fr'), false);
});

test('directionToLanguages は 2 方向を返し、未知は例外', () => {
  assert.deepEqual(directionToLanguages('en-to-jp'), { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.deepEqual(directionToLanguages('jp-to-en'), { sourceLanguage: 'ja', targetLanguage: 'en' });
  assert.throws(() => directionToLanguages('bogus'), /未知の翻訳方向/);
});

test('pickDetectedLanguage は確度最大の対応言語を返す', () => {
  assert.equal(
    pickDetectedLanguage([
      { detectedLanguage: 'en', confidence: 0.4 },
      { detectedLanguage: 'ja', confidence: 0.9 },
    ]),
    'ja',
  );
  assert.equal(pickDetectedLanguage([{ detectedLanguage: 'ja-JP', confidence: 0.5 }]), 'ja');
  assert.equal(pickDetectedLanguage([{ detectedLanguage: 'fr', confidence: 0.9 }]), null);
  assert.equal(pickDetectedLanguage([]), null);
  assert.equal(pickDetectedLanguage(null), null);
  // confidence が無い場合は最初の対応言語を採用する
  assert.equal(pickDetectedLanguage([{ detectedLanguage: 'en' }]), 'en');
});

test('directionFromLanguageTag は en/ja を方向へ、それ以外は fallback', () => {
  assert.equal(directionFromLanguageTag('en'), 'en-to-jp');
  assert.equal(directionFromLanguageTag('ja'), 'jp-to-en');
  assert.equal(directionFromLanguageTag('fr'), 'en-to-jp');
  assert.equal(directionFromLanguageTag('fr', 'jp-to-en'), 'jp-to-en');
  assert.equal(directionFromLanguageTag(null, 'jp-to-en'), 'jp-to-en');
});

test('detectDirection は検出結果から方向を決める', () => {
  assert.equal(detectDirection([{ detectedLanguage: 'ja', confidence: 0.8 }]), 'jp-to-en');
  assert.equal(detectDirection([{ detectedLanguage: 'en', confidence: 0.8 }]), 'en-to-jp');
  assert.equal(detectDirection([{ detectedLanguage: 'fr', confidence: 0.8 }]), 'en-to-jp');
  assert.equal(detectDirection(null, 'jp-to-en'), 'jp-to-en');
});

/* ==========================================================
   同意画面の説明
   ========================================================== */

test('builtinTranslationInfo は availability ごとに説明を返す', () => {
  const available = builtinTranslationInfo('available');
  assert.equal(available.needsDownload, false);
  assert.match(available.button, /内蔵翻訳で開始/);
  assert.match(available.modelLabel, /内蔵翻訳/);

  const downloadable = builtinTranslationInfo('downloadable');
  assert.equal(downloadable.needsDownload, true);
  assert.match(downloadable.button, /有効化/);
  assert.match(downloadable.note, /初回/);

  assert.equal(builtinTranslationInfo('unavailable'), null);
  assert.equal(builtinTranslationInfo(undefined), null);
});

/* ==========================================================
   Summarizer
   ========================================================== */

test('Summarizer の選択肢と正規化', () => {
  assert.deepEqual(SUMMARIZER_TYPES, ['key-points', 'tldr', 'teaser', 'headline']);
  assert.deepEqual(SUMMARIZER_FORMATS, ['markdown', 'plain-text']);
  assert.deepEqual(SUMMARIZER_LENGTHS, ['short', 'medium', 'long']);
  assert.equal(normalizeSummaryType('tldr'), 'tldr');
  assert.equal(normalizeSummaryType('bogus'), 'key-points');
  assert.equal(normalizeSummaryFormat('plain-text'), 'plain-text');
  assert.equal(normalizeSummaryFormat('html'), 'markdown');
  assert.equal(normalizeSummaryLength('long'), 'long');
  assert.equal(normalizeSummaryLength('huge'), 'short');
});

test('isSummarizerAllowed は対応外で false (UI を変えない)', () => {
  assert.equal(isSummarizerAllowed('available'), true);
  assert.equal(isSummarizerAllowed('after-download'), true);
  assert.equal(isSummarizerAllowed('unavailable'), false);
  assert.equal(isSummarizerAllowed(undefined), false);
});

test('summarizerButtonLabel は downloadable だけ有効化文言', () => {
  assert.equal(summarizerButtonLabel('available'), '要約する');
  assert.equal(summarizerButtonLabel('downloadable'), '要約を有効化して開始');
  assert.equal(summarizerButtonLabel('unavailable'), '要約する');
});

test('buildSummarizerOptions は既定へ寄せて不要なキーを落とす', () => {
  assert.deepEqual(buildSummarizerOptions(), {
    type: 'key-points',
    format: 'markdown',
    length: 'short',
  });
  assert.deepEqual(
    buildSummarizerOptions({
      type: 'tldr',
      format: 'plain-text',
      length: 'medium',
      sharedContext: '  CSS の記事  ',
      expectedInputLanguages: ['ja'],
    }),
    {
      type: 'tldr',
      format: 'plain-text',
      length: 'medium',
      sharedContext: 'CSS の記事',
      expectedInputLanguages: ['ja'],
    },
  );
  assert.deepEqual(buildSummarizerOptions({ type: 'bogus', sharedContext: '   ', expectedInputLanguages: [] }), {
    type: 'key-points',
    format: 'markdown',
    length: 'short',
  });
});

test('AVAILABILITY の語彙は 5 種で固定', () => {
  assert.deepEqual(Object.keys(AVAILABILITY).sort(), [
    'AVAILABLE',
    'DOWNLOADABLE',
    'DOWNLOADING',
    'UNAVAILABLE',
    'UNKNOWN',
  ]);
});
