/**
 * script.js — ローカル翻訳のメインスレッド制御
 *
 * UI を担当し、モデルのダウンロードと推論は worker.js に投げる。
 * 「高速（350M）」と「高品質（1.2B）」を切り替えられる。
 *
 * さらに Chrome 138 stable の内蔵 AI API (Translator / LanguageDetector)
 * が使えるときは「ブラウザ内蔵翻訳」を第一候補にする。モデルはブラウザが
 * 管理するためアプリ側のダウンロードは不要。対応外ブラウザでは
 * 従来どおり Transformers.js のローカルモデルを使う。
 */

import {
  listModels,
  chooseModel,
  estimateModelBytes,
  formatBytes,
  formatSpeed,
  cleanTranslation,
  DEFAULT_MODE,
  MAX_INPUT_CHARS,
  DEBOUNCE_MS,
} from './pipeline.mjs';

import {
  BUILTIN_BACKEND,
  TRANSFORMERS_BACKEND,
  AVAILABILITY,
  normalizeAvailability,
  isBuiltinUsable,
  directionToLanguages,
  detectDirection,
  builtinTranslationInfo,
} from '../../shared/builtin-ai.mjs';

const $ = (id) => document.getElementById(id);

/* Loading */
const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $consentLead = $('consent-lead');
const $builtinNote = $('builtin-note');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');
const $modelSize = $('model-size');
const $modelLicense = $('model-license');

/* App */
const $appMain = $('app-main');
const $errorBox = $('error-box');
const $sourceText = $('source-text');
const $outputText = $('output-text');
const $translateBtn = $('translate-btn');
const $swapBtn = $('swap-btn');
const $clearBtn = $('clear-btn');
const $copyBtn = $('copy-btn');
const $charCount = $('char-count');
const $realtimeToggle = $('realtime-toggle');
const $modeHint = $('mode-hint');
const $modeSelect = $('mode-select');
const $metricsBar = $('metrics-bar');
const $speedValue = $('speed-value');
const $tokensValue = $('tokens-value');
const $sourceLang = $('source-lang-label');
const $targetLang = $('target-lang-label');
const $outputLang = $('output-lang-label');
const $backendBadge = $('backend-badge');
const $aboutPanel = $('about-panel');
const $aboutBtn = $('about-btn');
const $aboutClose = $('about-close');
const $clearCacheBtn = $('clear-cache-btn');

const OUTPUT_PLACEHOLDER = '翻訳結果がここに表示されます';

/* ==========================================================
   状態
   ========================================================== */
let worker = null;
let appReady = false;
let modelReady = false;
let generating = false;
let direction = 'en-to-jp';
let debounceTimer = null;
let requestSeq = 0;
let activeRequest = 0;
let resultText = '';
let queued = null; // 生成中に来た最新リクエスト (リアルタイム入力用)
let hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

/* Chrome 内蔵 AI API の状態 */
let translatorApi = null;
let languageDetectorApi = null;
let builtinDetector = null;
let builtinAvailability = AVAILABILITY.UNKNOWN;
let builtinReady = false;
let activeBackend = TRANSFORMERS_BACKEND;
const builtinTranslators = new Map(); // direction -> Translator

/* ==========================================================
   内蔵 AI API の feature detect
   ========================================================== */
function detectBuiltinApis() {
  translatorApi = typeof globalThis.Translator !== 'undefined' ? globalThis.Translator : null;
  languageDetectorApi =
    typeof globalThis.LanguageDetector !== 'undefined' ? globalThis.LanguageDetector : null;
}

/**
 * 現在の翻訳方向について内蔵翻訳が使えるかを問い合わせ、モデル選択へ反映する。
 * 失敗しても既存の Transformers.js 経路はそのまま使えるようにする。
 */
async function refreshBuiltinAvailability() {
  if (!translatorApi || typeof translatorApi.availability !== 'function') {
    builtinAvailability = AVAILABILITY.UNKNOWN;
    syncBuiltinOption();
    return;
  }
  try {
    const value = await translatorApi.availability(directionToLanguages(direction));
    builtinAvailability = normalizeAvailability(value);
  } catch (error) {
    console.warn('Translator.availability failed:', error);
    builtinAvailability = AVAILABILITY.UNKNOWN;
  }
  syncBuiltinOption();
}

/** 使えるときだけモデル選択の先頭に「ブラウザ内蔵翻訳」を足す */
function syncBuiltinOption() {
  const usable = isBuiltinUsable(builtinAvailability);
  const existing = $modeSelect.querySelector(`option[value="${BUILTIN_BACKEND}"]`);
  if (usable && !existing) {
    const option = document.createElement('option');
    option.value = BUILTIN_BACKEND;
    option.textContent = 'ブラウザ内蔵翻訳 — モデルのダウンロード不要';
    $modeSelect.prepend(option);
    if (!appReady) $modeSelect.value = BUILTIN_BACKEND;
  } else if (!usable && existing) {
    if ($modeSelect.value === existing.value) $modeSelect.value = DEFAULT_MODE;
    existing.remove();
  }
  updateConsentInfo();
}

/* ==========================================================
   起動
   ========================================================== */
function createWorker() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function setupWorker() {
  worker = createWorker();

  worker.addEventListener('error', (event) => {
    console.error('worker error:', event);
    showError(`ワーカーでエラーが発生しました: ${event.message || '不明なエラー'}`);
    if (!appReady) resetConsent('再試行する');
  });

  worker.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'status':
        handleStatus(message);
        break;
      case 'progress':
        handleProgress(message);
        break;
      case 'backend':
        updateBackendBadge(message.backend, message.fp16);
        break;
      case 'ready':
        handleReady(message);
        break;
      case 'token':
        handleToken(message);
        break;
      case 'result':
        handleResult(message);
        break;
      case 'error':
        handleWorkerError(message);
        break;
      case 'cache-cleared':
        handleCacheCleared(message);
        break;
      default:
        break;
    }
  });
}

function requestModelLoad() {
  if (!worker) return;
  modelReady = false;
  updateTranslateEnabled();
  if (appReady) setStatus('モデルを切り替え中…');
  worker.postMessage({ type: 'load', modeKey: $modeSelect.value });
}

/* ==========================================================
   ブラウザ内蔵翻訳 (Chrome 138+)
   ========================================================== */

/**
 * 指定方向の Translator を取得する。初回は downloadprogress を拾って
 * ローディング表示に反映する。生成済みならキャッシュを返す。
 */
async function ensureBuiltinTranslator(dir) {
  if (builtinTranslators.has(dir)) return builtinTranslators.get(dir);
  if (!translatorApi) throw new Error('このブラウザは内蔵翻訳に対応していません');

  const translator = await translatorApi.create({
    ...directionToLanguages(dir),
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const loaded = Number(event.loaded) || 0;
        const total = Number(event.total) || 0;
        if (appReady) return;
        $loadingStatus.textContent = 'ブラウザ内蔵翻訳モデルを取得中…';
        if (total > 0) {
          $progressFill.style.width = `${Math.min(99, Math.round((loaded / total) * 100))}%`;
          $loadingHint.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
        }
      });
    },
  });
  builtinTranslators.set(dir, translator);
  return translator;
}

/** 同意ボタンから内蔵翻訳を開始する (ユーザー操作の中で create する) */
async function startBuiltin() {
  activeBackend = BUILTIN_BACKEND;
  $loadingStatus.textContent = 'ブラウザ内蔵翻訳を準備しています…';
  $loadingHint.textContent = '初回のみ Chrome がモデルを取得する場合があります';
  try {
    await ensureBuiltinTranslator(direction);
    // LanguageDetector もここで作っておく (入力言語の自動判定用)
    if (languageDetectorApi && !builtinDetector) {
      try {
        builtinDetector = await languageDetectorApi.create();
      } catch (detectorError) {
        console.warn('LanguageDetector.create failed:', detectorError);
      }
    }
    modelReady = true;
    builtinReady = true;
    appReady = true;
    $loadingHint.textContent = '準備完了';
    $progressFill.style.width = '100%';
    updateBuiltinBadge();
    updateTranslateEnabled();
    showApp();
  } catch (error) {
    console.error('builtin translator create failed:', error);
    showError(`ブラウザ内蔵翻訳を開始できませんでした: ${error?.message || error}`);
    $modeSelect.value = DEFAULT_MODE;
    resetConsent('再試行する');
    updateConsentInfo();
  }
}

/** 入力テキストの言語を検出し、対応言語なら翻訳方向を返す */
async function detectLanguageDirection(text, fallback) {
  if (!languageDetectorApi) return fallback;
  try {
    if (!builtinDetector) {
      const availability =
        typeof languageDetectorApi.availability === 'function'
          ? await languageDetectorApi.availability()
          : AVAILABILITY.AVAILABLE;
      if (!isBuiltinUsable(availability)) return fallback;
      builtinDetector = await languageDetectorApi.create();
    }
    const results = await builtinDetector.detect(text);
    return detectDirection(results, fallback);
  } catch (error) {
    console.warn('language detection failed:', error);
    return fallback;
  }
}

/** 内蔵翻訳で 1 件翻訳する (ストリーミング無し) */
async function runBuiltinTranslation({ text, direction: dir }) {
  generating = true;
  resultText = '';
  const requestId = ++requestSeq;
  activeRequest = requestId;
  updateTranslateEnabled();
  $outputText.innerHTML = '<span class="streaming-cursor"></span>';
  $copyBtn.style.display = 'none';
  $metricsBar.style.display = 'none';

  try {
    // 入力言語を自動判定し、対応言語なら翻訳方向を切り替える
    const detected = await detectLanguageDirection(text, dir);
    const targetDir = detected || dir;
    if (targetDir !== direction) {
      direction = targetDir;
      updateDirection();
    }
    const translator = await ensureBuiltinTranslator(targetDir);
    const output = await translator.translate(text);
    if (requestId !== activeRequest) return;

    const clean = cleanTranslation(output);
    generating = false;
    $outputText.textContent = clean || '(出力なし)';
    if (clean) $copyBtn.style.display = 'flex';
    updateStreamingCursor();
    updateBuiltinBadge();
    updateTranslateEnabled();

    if (queued) {
      const next = queued;
      queued = null;
      runTranslation(next);
    }
  } catch (error) {
    if (requestId !== activeRequest) return;
    console.error('builtin translation failed:', error);
    generating = false;
    updateStreamingCursor();
    updateTranslateEnabled();
    showError(`翻訳エラー: ${error?.message || error}`);
    setStatus('翻訳に失敗しました');
  }
}

function updateBuiltinBadge() {
  $backendBadge.textContent = 'バックエンド: ブラウザ内蔵翻訳 (Chrome)';
  $backendBadge.classList.remove('badge-warning');
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleStatus(message) {
  if (!appReady && message.stage !== 'process') {
    $loadingStatus.textContent = message.message || '準備中…';
  } else if (message.stage !== 'process') {
    setStatus(message.message || '');
  }
}

function handleProgress(message) {
  if (appReady) return;
  const percent = Number(message.progress) || 0;
  if (percent > 0) $progressFill.style.width = `${Math.min(99, percent)}%`;
  $loadingStatus.textContent = 'モデルをダウンロード中…';
  if (message.total) {
    $loadingHint.textContent = `${formatBytes(message.loaded)} / ${formatBytes(message.total)}`;
  }
}

function handleReady(message) {
  modelReady = true;
  updateModelBadge(message);

  if (!appReady) {
    appReady = true;
    $loadingHint.textContent = '準備完了';
    $progressFill.style.width = '100%';
    showApp();
  } else {
    setStatus('モデルを切り替えました');
  }
  updateTranslateEnabled();

  if (queued) {
    const next = queued;
    queued = null;
    runTranslation(next);
  }
}

function showApp() {
  $loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    $loadingScreen.style.display = 'none';
    $appMain.style.display = 'block';
  }, 400);
}

function resetConsent(buttonLabel) {
  $loadingState.style.display = 'none';
  $consentState.style.display = 'block';
  $consentBtn.disabled = false;
  $consentBtn.textContent = buttonLabel;
  appReady = false;
  modelReady = false;
}

function handleWorkerError(message) {
  const prefix =
    message.stage === 'process'
      ? '翻訳エラー'
      : message.stage === 'cache'
        ? 'キャッシュ操作エラー'
        : '初期化エラー';
  if (message.stage === 'process' && message.requestId !== activeRequest) {
    // 古いリクエストのエラーは無視する
    return;
  }
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    if (!appReady) resetConsent('再試行する');
    else setStatus('モデルの読み込みに失敗しました');
  } else if (message.stage === 'process') {
    generating = false;
    updateStreamingCursor();
    updateTranslateEnabled();
    setStatus('翻訳に失敗しました');
  }
}

function handleCacheCleared(message) {
  setStatus(`モデルキャッシュを削除しました (${message.removed} 件)`);
}

function showError(text) {
  $errorBox.textContent = text;
  $errorBox.style.display = 'block';
}

function clearError() {
  $errorBox.textContent = '';
  $errorBox.style.display = 'none';
}

function setStatus(text) {
  $modeHint.textContent = text || '';
}

/* ==========================================================
   翻訳
   ========================================================== */
function translate() {
  if (!modelReady) return;
  const text = $sourceText.value.trim();
  if (!text) return;
  if (text.length > MAX_INPUT_CHARS) {
    showError(`入力が長すぎます (最大 ${MAX_INPUT_CHARS} 文字)。分割してください。`);
    return;
  }
  clearError();

  const request = { text, direction };
  if (generating) {
    // 生成中なら最新のリクエストだけを覚えて、完了後に流す
    queued = request;
    return;
  }
  runTranslation(request);
}

function runTranslation({ text, direction: dir }) {
  if (!modelReady) return;
  if (activeBackend === BUILTIN_BACKEND) {
    runBuiltinTranslation({ text, direction: dir });
    return;
  }
  if (!worker) return;
  generating = true;
  resultText = '';
  activeRequest = ++requestSeq;
  updateTranslateEnabled();
  $outputText.innerHTML = '<span class="streaming-cursor"></span>';
  $copyBtn.style.display = 'none';
  $metricsBar.style.display = 'none';
  $tokensValue.textContent = '— tokens';
  $speedValue.textContent = '— tok/s';

  worker.postMessage({
    type: 'translate',
    requestId: activeRequest,
    text,
    direction: dir,
  });
}

function handleToken(message) {
  if (message.requestId !== activeRequest) return;
  resultText += message.text || '';
  $outputText.innerHTML = `${escapeHtml(resultText)}<span class="streaming-cursor"></span>`;
}

function handleResult(message) {
  if (message.requestId !== activeRequest) return;
  generating = false;
  const text = cleanTranslation(message.text ?? resultText);
  $outputText.textContent = text || '(出力なし)';
  if (text) $copyBtn.style.display = 'flex';
  updateStreamingCursor();

  const tokens = Number(message.tokens) || 0;
  const elapsedMs = Number(message.elapsedMs) || 0;
  $tokensValue.textContent = `${tokens} tokens`;
  $speedValue.textContent = `${formatSpeed(tokens, elapsedMs)} tok/s`;
  $metricsBar.style.display = 'flex';

  updateTranslateEnabled();

  if (queued) {
    const next = queued;
    queued = null;
    runTranslation(next);
  }
}

function updateStreamingCursor() {
  const cursor = $outputText.querySelector('.streaming-cursor');
  if (cursor && !generating) cursor.remove();
}

function cancelPending() {
  queued = null;
}

/* ==========================================================
   UI ヘルパー
   ========================================================== */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateDirection() {
  if (direction === 'en-to-jp') {
    $sourceLang.textContent = 'English';
    $targetLang.textContent = '日本語';
    $outputLang.textContent = '日本語';
    $sourceText.placeholder = 'Enter text to translate…';
  } else {
    $sourceLang.textContent = '日本語';
    $targetLang.textContent = 'English';
    $outputLang.textContent = 'English';
    $sourceText.placeholder = '翻訳するテキストを入力…';
  }
}

function updateTranslateEnabled() {
  $translateBtn.disabled = !(modelReady && !generating);
}

function updateCharCount() {
  $charCount.textContent = $sourceText.value.length;
}

function updateBackendBadge(ep, supportsFp16) {
  if (!ep) {
    $backendBadge.textContent = 'バックエンド: 不明';
    return;
  }
  if (ep === 'webgpu') {
    $backendBadge.textContent = `バックエンド: WebGPU${supportsFp16 ? ' (fp16)' : ''}`;
    $backendBadge.classList.remove('badge-warning');
  } else {
    $backendBadge.textContent = 'バックエンド: WASM (低速)';
    $backendBadge.classList.add('badge-warning');
  }
}

function updateModelBadge(message) {
  const size = formatBytes(
    Number(message.bytes) || estimateModelBytes(message.modeKey, message.device || 'wasm'),
  );
  $backendBadge.textContent = `${
    message.device === 'webgpu' ? 'WebGPU' : 'WASM'
  } / ${message.shortLabel} (${message.dtype}, ${size})`;
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function populateModeSelect() {
  for (const model of listModels()) {
    const option = document.createElement('option');
    option.value = model.key;
    option.textContent = `${model.label} — ${model.description}`;
    $modeSelect.appendChild(option);
  }
  $modeSelect.value = DEFAULT_MODE;
}

function updateConsentInfo() {
  const isBuiltin = $modeSelect.value === BUILTIN_BACKEND;
  if (isBuiltin) {
    const info = builtinTranslationInfo(builtinAvailability) || builtinTranslationInfo('downloadable');
    $consentLead.style.display = 'none';
    if ($builtinNote) $builtinNote.style.display = 'block';
    $modelSize.textContent = '0';
    $modelLicense.textContent = `使用モデル: ${info.modelLabel} / ライセンス: ブラウザ提供`;
    $consentBtn.textContent = info.button;
    return;
  }
  const choice = chooseModel($modeSelect.value, hasWebGPU);
  $consentLead.style.display = 'block';
  if ($builtinNote) $builtinNote.style.display = 'none';
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modeKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.shortLabel} / ライセンス: ${choice.license}`;
  $consentBtn.textContent = 'モデルをダウンロードして開始';
}

function setupInteractions() {
  $translateBtn.addEventListener('click', translate);

  $sourceText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translate();
    }
  });

  $swapBtn.addEventListener('click', () => {
    direction = direction === 'en-to-jp' ? 'jp-to-en' : 'en-to-jp';
    updateDirection();

    const outputContent = $outputText.textContent;
    if (outputContent && outputContent !== OUTPUT_PLACEHOLDER) {
      $sourceText.value = outputContent;
      $outputText.innerHTML = `<span class="output-placeholder">${OUTPUT_PLACEHOLDER}</span>`;
      $copyBtn.style.display = 'none';
      $metricsBar.style.display = 'none';
      updateCharCount();
    }
  });

  $clearBtn.addEventListener('click', () => {
    cancelPending();
    $sourceText.value = '';
    $outputText.innerHTML = `<span class="output-placeholder">${OUTPUT_PLACEHOLDER}</span>`;
    $clearBtn.style.display = 'none';
    $copyBtn.style.display = 'none';
    $metricsBar.style.display = 'none';
    updateCharCount();
    $sourceText.focus();
  });

  $copyBtn.addEventListener('click', async () => {
    const text = $outputText.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const orig = $copyBtn.innerHTML;
      $copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        $copyBtn.innerHTML = orig;
      }, 1500);
    } catch (e) {
      console.warn('Clipboard write failed:', e);
    }
  });

  $sourceText.addEventListener('input', () => {
    updateCharCount();
    $clearBtn.style.display = $sourceText.value ? 'flex' : 'none';

    if ($realtimeToggle.checked && $sourceText.value.trim()) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(translate, DEBOUNCE_MS);
    }
  });

  $realtimeToggle.addEventListener('change', () => {
    if ($realtimeToggle.checked) {
      $translateBtn.classList.add('hidden');
      $modeHint.textContent = '入力するたびに自動翻訳されます';
      if ($sourceText.value.trim()) translate();
    } else {
      $translateBtn.classList.remove('hidden');
      $modeHint.textContent = 'タイピングしながらリアルタイムで翻訳';
    }
  });

  $modeSelect.addEventListener('change', () => {
    updateConsentInfo();
    if ($modeSelect.value === BUILTIN_BACKEND) {
      activeBackend = BUILTIN_BACKEND;
      if (builtinReady) {
        modelReady = true;
        if (appReady) {
          setStatus('ブラウザ内蔵翻訳に切り替えました');
          updateBuiltinBadge();
          updateTranslateEnabled();
        }
        return;
      }
      // 初めて内蔵翻訳を選んだ場合はここで準備する (change もユーザー操作)
      modelReady = false;
      updateTranslateEnabled();
      setStatus('ブラウザ内蔵翻訳を準備しています…');
      ensureBuiltinTranslator(direction)
        .then(() => {
          builtinReady = true;
          modelReady = true;
          updateBuiltinBadge();
          updateTranslateEnabled();
          setStatus('ブラウザ内蔵翻訳に切り替えました');
        })
        .catch((error) => {
          console.error('builtin translator create failed:', error);
          showError(`ブラウザ内蔵翻訳を準備できませんでした: ${error?.message || error}`);
          $modeSelect.value = DEFAULT_MODE;
          updateConsentInfo();
        });
      return;
    }
    activeBackend = TRANSFORMERS_BACKEND;
    if (!appReady) return;
    if (!worker) setupWorker();
    requestModelLoad();
  });

  $aboutBtn.addEventListener('click', () => {
    $aboutPanel.style.display = $aboutPanel.style.display === 'none' ? 'block' : 'none';
  });
  $aboutClose.addEventListener('click', () => {
    $aboutPanel.style.display = 'none';
  });
  $clearCacheBtn.addEventListener('click', () => {
    if (
      !confirm(
        'モデルのキャッシュを削除しますか？\n次回起動時にモデルの再ダウンロードが必要になります。',
      )
    ) {
      return;
    }
    if (worker) worker.postMessage({ type: 'clear-cache' });
  });

  updateCharCount();
  updateDirection();
  updateTranslateEnabled();
}

/* ==========================================================
   起動
   ========================================================== */
detectBuiltinApis();
populateModeSelect();
updateConsentInfo();
// 内蔵翻訳が使えるなら選択肢の先頭に足す (対応外なら何もしない)
refreshBuiltinAvailability();

$consentBtn.addEventListener('click', () => {
  clearError();
  $consentBtn.disabled = true;
  $consentState.style.display = 'none';
  $loadingState.style.display = 'block';
  if ($modeSelect.value === BUILTIN_BACKEND) {
    startBuiltin();
    return;
  }
  activeBackend = TRANSFORMERS_BACKEND;
  $loadingHint.textContent = '初回はモデルのダウンロードに時間がかかります';
  if (!worker) setupWorker();
  requestModelLoad();
});

setupInteractions();
