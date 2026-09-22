/**
 * script.js — 日本語アシスタントのメインスレッド制御
 *
 * UI を担当し、モデルのダウンロードと推論は worker.js に投げる。
 * 要約 / Q&A / 構造化抽出の 3 タスクを切り替えて使う。
 */

import {
  TASKS,
  DEFAULT_TASK,
  getTask,
  buildMessages,
  formatResult,
  chooseModel,
  estimateModelBytes,
  formatBytes,
  formatSpeed,
  normalizeFields,
  DEFAULT_FIELDS,
  MAX_INPUT_CHARS,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

/* Loading */
const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');
const $modelSize = $('model-size');
const $modelLicense = $('model-license');

/* App */
const $appMain = $('app-main');
const $errorBox = $('error-box');
const $taskTabs = $('task-tabs');
const $taskNote = $('task-note');
const $inputText = $('input-text');
const $charCount = $('char-count');
const $questionField = $('question-field');
const $questionInput = $('question-input');
const $fieldsField = $('fields-field');
const $fieldsInput = $('fields-input');
const $runBtn = $('run-btn');
const $clearBtn = $('clear-btn');
const $copyBtn = $('copy-btn');
const $outputText = $('output-text');
const $metricsBar = $('metrics-bar');
const $speedValue = $('speed-value');
const $tokensValue = $('tokens-value');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $aboutBtn = $('about-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

const OUTPUT_PLACEHOLDER = '結果がここに表示されます';

/* ==========================================================
   状態
   ========================================================== */
let worker = null;
let appReady = false;
let modelReady = false;
let generating = false;
let taskKey = DEFAULT_TASK;
let requestSeq = 0;
let activeRequest = 0;
let resultText = '';
let lastResult = '';
let hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

/* ==========================================================
   起動
   ========================================================== */
function setupWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

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
        setStatus(`モデルキャッシュを削除しました (${message.removed} 件)`);
        break;
      default:
        break;
    }
  });
}

function requestModelLoad() {
  if (!worker) return;
  modelReady = false;
  updateRunEnabled();
  worker.postMessage({ type: 'load' });
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleStatus(message) {
  if (!appReady && message.stage !== 'process') {
    $loadingStatus.textContent = message.message || '準備中…';
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
  }
  updateRunEnabled();
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
  if (message.stage === 'process' && message.requestId !== activeRequest) return;
  const prefix =
    message.stage === 'process'
      ? '生成エラー'
      : message.stage === 'cache'
        ? 'キャッシュ操作エラー'
        : '初期化エラー';
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    if (!appReady) resetConsent('再試行する');
  } else if (message.stage === 'process') {
    generating = false;
    removeCursor();
    updateRunEnabled();
    setStatus('生成に失敗しました');
  }
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
  $taskNote.textContent = text || '';
}

/* ==========================================================
   生成
   ========================================================== */
function runTask() {
  if (!modelReady || generating) return;
  clearError();

  const input = $inputText.value.trim();
  const payload = {
    taskKey,
    input,
    question: $questionInput.value.trim(),
    fields: normalizeFields($fieldsInput.value),
  };

  try {
    buildMessages(taskKey, payload); // 事前検証 (例外ならエラー表示)
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    return;
  }

  generating = true;
  resultText = '';
  lastResult = '';
  activeRequest = ++requestSeq;
  updateRunEnabled();
  $outputText.innerHTML = '<span class="streaming-cursor"></span>';
  $copyBtn.style.display = 'none';
  $metricsBar.style.display = 'none';
  $tokensValue.textContent = '— tokens';
  $speedValue.textContent = '— tok/s';

  worker.postMessage({
    type: 'run',
    requestId: activeRequest,
    taskKey,
    input,
    question: payload.question,
    fields: payload.fields,
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

  lastResult = formatResult(message.text ?? resultText, message.taskKey || taskKey);
  $outputText.textContent = lastResult || '(出力なし)';
  if (lastResult) $copyBtn.style.display = 'flex';
  removeCursor();

  const tokens = Number(message.tokens) || 0;
  const elapsedMs = Number(message.elapsedMs) || 0;
  $tokensValue.textContent = `${tokens} tokens`;
  $speedValue.textContent = `${formatSpeed(tokens, elapsedMs)} tok/s`;
  $metricsBar.style.display = 'flex';

  updateRunEnabled();
}

function removeCursor() {
  const cursor = $outputText.querySelector('.streaming-cursor');
  if (cursor) cursor.remove();
}

/* ==========================================================
   UI ヘルパー
   ========================================================== */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateCharCount() {
  const length = $inputText.value.length;
  $charCount.textContent = `${length} / ${MAX_INPUT_CHARS}`;
  $charCount.classList.toggle('over-limit', length > MAX_INPUT_CHARS);
}

function updateRunEnabled() {
  $runBtn.disabled = !(modelReady && !generating);
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
    Number(message.bytes) || estimateModelBytes('lfm25-1.2b-jp', message.device || 'wasm'),
  );
  $modelBadge.textContent = `モデル: ${message.shortLabel || 'LFM2.5 1.2B JP'} (${message.dtype}, ${size})`;
}

/* ==========================================================
   タスク切替
   ========================================================== */
function populateTaskTabs() {
  for (const task of TASKS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-tab';
    button.dataset.task = task.key;
    button.textContent = task.label;
    button.addEventListener('click', () => selectTask(task.key));
    $taskTabs.appendChild(button);
  }
}

function selectTask(key) {
  taskKey = key;
  const task = getTask(key);
  for (const button of $taskTabs.querySelectorAll('.task-tab')) {
    button.classList.toggle('active', button.dataset.task === key);
    button.setAttribute('aria-selected', button.dataset.task === key ? 'true' : 'false');
  }
  $questionField.style.display = key === 'qa' ? 'block' : 'none';
  $fieldsField.style.display = key === 'extract' ? 'block' : 'none';
  setStatus(task.description);
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function updateConsentInfo() {
  const choice = chooseModel('lfm25-1.2b-jp', hasWebGPU);
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modeKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.shortLabel} / ライセンス: ${choice.license}`;
}

function setupInteractions() {
  $runBtn.addEventListener('click', runTask);

  $inputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runTask();
    }
  });

  $inputText.addEventListener('input', () => {
    updateCharCount();
    $clearBtn.style.display = $inputText.value ? 'flex' : 'none';
  });

  $clearBtn.addEventListener('click', () => {
    $inputText.value = '';
    $questionInput.value = '';
    $fieldsInput.value = DEFAULT_FIELDS.join(', ');
    lastResult = '';
    $outputText.innerHTML = `<span class="output-placeholder">${OUTPUT_PLACEHOLDER}</span>`;
    $copyBtn.style.display = 'none';
    $metricsBar.style.display = 'none';
    $clearBtn.style.display = 'none';
    updateCharCount();
    $inputText.focus();
  });

  $copyBtn.addEventListener('click', async () => {
    const text = lastResult || $outputText.textContent;
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

  $aboutBtn.addEventListener('click', () => {
    $infoModal.style.display = 'flex';
  });
  $closeInfoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'none';
  });
  $infoModal.addEventListener('click', (event) => {
    if (event.target === $infoModal) $infoModal.style.display = 'none';
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
}

/* ==========================================================
   起動
   ========================================================== */
populateTaskTabs();
selectTask(DEFAULT_TASK);
$fieldsInput.value = DEFAULT_FIELDS.join(', ');
updateConsentInfo();
updateCharCount();
updateRunEnabled();

$consentBtn.addEventListener('click', () => {
  clearError();
  $consentBtn.disabled = true;
  $consentState.style.display = 'none';
  $loadingState.style.display = 'block';
  $loadingHint.textContent = '初回はモデルのダウンロードに時間がかかります';
  if (!worker) {
    setupWorker();
    requestModelLoad();
  }
});

setupInteractions();
