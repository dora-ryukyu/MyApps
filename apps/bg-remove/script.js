/**
 * script.js — 背景除去アプリのメインスレッド制御
 *
 * UI と画像のデコード・合成を担当し、推論は worker.js に投げる。
 * モデルのダウンロードも worker 側で完結する。
 */

import {
  SUBJECTS,
  BACKGROUND_MODES,
  chooseModel,
  getSubject,
  estimateModelBytes,
  formatBytes,
  compose,
  buildDownloadName,
  isSupportedImage,
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
const $imageDrop = $('image-drop');
const $fileInput = $('file-input');
const $sourceName = $('source-name');
const $sourcePreview = $('source-preview');
const $subjectSelect = $('subject-select');
const $licenseNote = $('license-note');
const $bgMode = $('bg-mode');
const $bgColor = $('bg-color');
const $bgColorRow = $('bg-color-row');
const $bgImageRow = $('bg-image-row');
const $bgImageInput = $('bg-image-input');
const $bgImageName = $('bg-image-name');
const $processBtn = $('process-btn');
const $clearBtn = $('clear-btn');
const $downloadBtn = $('download-btn');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $timeBadge = $('time-badge');
const $statusText = $('status-text');
const $resultCanvas = $('result-canvas');
const $resultEmpty = $('result-empty');
const $infoBtn = $('info-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

/* ==========================================================
   状態
   ========================================================== */
let worker = null;
let appReady = false; // 初回ロードが終わったか
let modelReady = false; // 現在のモデルが使えるか
let running = false;
let backend = '';
let hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

let source = null; // { name, width, height, data: Uint8ClampedArray }
let sourceUrl = null;
let cutout = null; // { width, height, data: Uint8ClampedArray }
let background = null; // { data: Uint8ClampedArray } 出力寸法に合わせた RGBA
let backgroundFile = null;
let elapsedMs = 0;
let pendingReprocess = false; // モデル切り替え後に自動で再推論するか

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
        backend = message.backend || '';
        updateBackendBadge(message.backend, message.fp16, message.fallback);
        break;
      case 'ready':
        handleReady(message);
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

/** 被写体の選択に応じて worker にモデルを読み込ませる */
function requestModelLoad() {
  if (!worker) return;
  modelReady = false;
  updateProcessEnabled();
  if (!appReady) return;
  setStatus('モデルを切り替え中…');
  worker.postMessage({ type: 'load', subjectKey: $subjectSelect.value });
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleStatus(message) {
  if (!appReady && message.stage !== 'process') {
    $loadingStatus.textContent = message.message || '準備中…';
  } else {
    setStatus(message.message || '');
  }
}

function handleProgress(message) {
  if (appReady || message.stage !== 'download') return;
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
  updateLicenseNote(message.modelKey);
  $timeBadge.textContent = '-';

  if (!appReady) {
    appReady = true;
    $loadingHint.textContent = '準備完了';
    $progressFill.style.width = '100%';
    showApp();
  } else {
    setStatus('モデルを切り替えました');
  }
  updateProcessEnabled();

  if (pendingReprocess && source) {
    pendingReprocess = false;
    startProcess();
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
      ? '推論エラー'
      : message.stage === 'cache'
        ? 'キャッシュ操作エラー'
        : '初期化エラー';
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    if (!appReady) {
      resetConsent('再試行する');
    } else {
      setStatus('モデルの読み込みに失敗しました');
    }
  } else if (message.stage === 'process') {
    running = false;
    updateProcessEnabled();
    setStatus('推論に失敗しました');
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
  $statusText.textContent = text;
}

/* ==========================================================
   画像の読み込み
   ========================================================== */
async function loadImageFile(file) {
  if (!file) return;
  if (!isSupportedImage(file)) {
    showError('対応していない画像形式です (PNG / JPEG / WebP / GIF / BMP / AVIF)。');
    return;
  }
  clearError();
  setStatus('画像を読み込み中…');
  try {
    const decoded = await decodeImage(file);
    source = { name: file.name || 'image', ...decoded };
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    $sourcePreview.src = sourceUrl;
    $sourceName.textContent = `${source.name} (${source.width}×${source.height})`;
    $imageDrop.classList.add('has-image');
    resetResult();
    setStatus('画像を読み込みました');
    updateProcessEnabled();
    // モデルが準備できていればそのまま処理する
    if (modelReady) startProcess();
  } catch (err) {
    console.error(err);
    showError(`画像を読み込めませんでした: ${err && err.message ? err.message : String(err)}`);
    setStatus('読み込みに失敗しました');
  }
}

/** File / Blob を RGBA のピクセルにデコードする */
async function decodeImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(data) };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function resetResult() {
  cutout = null;
  elapsedMs = 0;
  $resultCanvas.width = 0;
  $resultCanvas.height = 0;
  $resultCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  $downloadBtn.disabled = true;
  $timeBadge.textContent = '-';
}

/* ==========================================================
   推論
   ========================================================== */
function updateProcessEnabled() {
  $processBtn.disabled = !(modelReady && source && !running);
}

function startProcess() {
  if (!modelReady || !source || running) return;
  clearError();
  running = true;
  updateProcessEnabled();
  $resultEmpty.style.display = 'none';
  $downloadBtn.disabled = true;
  setStatus('背景を推定中…');

  // メイン側の画像は保持したまま、コピーをワーカーへ転送する
  const copy = source.data.slice();
  worker.postMessage(
    { type: 'process', width: source.width, height: source.height, data: copy.buffer },
    [copy.buffer],
  );
}

async function handleResult(message) {
  running = false;
  const width = message.width;
  const height = message.height;
  const data = new Uint8ClampedArray(message.data);
  cutout = { width, height, data };
  elapsedMs = Number(message.elapsedMs) || 0;
  if (currentMode() === 'image' && backgroundFile) {
    try {
      await rebuildBackground();
    } catch (err) {
      console.warn('背景画像の再構築に失敗:', err);
    }
  }
  renderResult();
  $downloadBtn.disabled = false;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(1)} 秒`;
  setStatus('完成');
  updateProcessEnabled();
}

/* ==========================================================
   合成・表示
   ========================================================== */
function currentMode() {
  return $bgMode.value || 'transparent';
}

function renderResult() {
  if (!cutout) return;
  const { width, height } = cutout;
  const mode = currentMode();
  let output;
  try {
    output = compose(cutout.data, mode, {
      color: $bgColor.value,
      background: background ? background.data : undefined,
    });
  } catch (err) {
    console.error(err);
    showError(`合成に失敗しました: ${err && err.message ? err.message : String(err)}`);
    return;
  }

  $resultCanvas.width = width;
  $resultCanvas.height = height;
  const ctx = $resultCanvas.getContext('2d');
  ctx.putImageData(new ImageData(output, width, height), 0, 0);
  $resultCanvas.style.display = 'block';
  $resultEmpty.style.display = 'none';
}

/** 背景画像を出力サイズに cover で合わせて RGBA を作る */
async function loadBackgroundFile(file) {
  if (!file) return;
  if (!isSupportedImage(file)) {
    showError('背景に使える画像形式ではありません。');
    return;
  }
  clearError();
  try {
    backgroundFile = file;
    $bgImageName.textContent = file.name || '背景画像';
    await rebuildBackground();
    renderResult();
  } catch (err) {
    console.error(err);
    showError(`背景画像を読み込めませんでした: ${err && err.message ? err.message : String(err)}`);
  }
}

async function rebuildBackground() {
  if (!backgroundFile || !cutout) {
    background = null;
    return;
  }
  const bitmap = await createImageBitmap(backgroundFile);
  try {
    const { width, height } = cutout;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    ctx.drawImage(bitmap, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
    background = { data: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data) };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function updateBackgroundControls() {
  const mode = currentMode();
  $bgColorRow.style.display = mode === 'color' ? 'flex' : 'none';
  $bgImageRow.style.display = mode === 'image' ? 'flex' : 'none';
}

/* ==========================================================
   ダウンロード / クリア
   ========================================================== */
function downloadResult() {
  if (!cutout) return;
  $resultCanvas.toBlob((blob) => {
    if (!blob) {
      showError('PNG の書き出しに失敗しました。');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildDownloadName(source ? source.name : 'image', currentMode());
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function clearAll() {
  source = null;
  cutout = null;
  background = null;
  backgroundFile = null;
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  $sourcePreview.removeAttribute('src');
  $sourceName.textContent = '';
  $imageDrop.classList.remove('has-image');
  $fileInput.value = '';
  $bgImageInput.value = '';
  $bgImageName.textContent = '';
  resetResult();
  updateProcessEnabled();
  setStatus('クリアしました');
}

/* ==========================================================
   バックエンド / モデル表示
   ========================================================== */
function updateBackendBadge(ep, supportsFp16, fallback) {
  if (!ep) {
    $backendBadge.textContent = 'バックエンド: 不明';
    return;
  }
  if (ep === 'webgpu') {
    $backendBadge.textContent = `バックエンド: WebGPU${supportsFp16 ? ' (fp16)' : ''}`;
    $backendBadge.classList.remove('badge-warning');
  } else {
    $backendBadge.textContent = fallback
      ? 'バックエンド: WASM (フォールバック)'
      : 'バックエンド: WASM (低速)';
    $backendBadge.classList.add('badge-warning');
  }
}

function updateModelBadge(message) {
  if (!message || !message.modelKey) return;
  const size = formatBytes(estimateModelBytes(message.modelKey, message.device || (hasWebGPU ? 'webgpu' : 'wasm')));
  $modelBadge.textContent = `モデル: ${message.modelKey === 'rmbg' ? 'RMBG-1.4' : 'MODNet'} (${message.dtype}, ${size})`;
}

function updateLicenseNote(modelKey) {
  const isRmbg = modelKey === 'rmbg';
  if (isRmbg) {
    $licenseNote.textContent = 'RMBG-1.4 は非商用ライセンスです。研究・個人利用の範囲でお使いください。';
    $licenseNote.style.display = 'block';
  } else {
    $licenseNote.style.display = 'none';
  }
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function populateSelectors() {
  for (const subject of SUBJECTS) {
    const option = document.createElement('option');
    option.value = subject.key;
    option.textContent = `${subject.label} — ${subject.description}`;
    $subjectSelect.appendChild(option);
  }
  $subjectSelect.value = SUBJECTS[0].key;

  for (const mode of BACKGROUND_MODES) {
    const option = document.createElement('option');
    option.value = mode.key;
    option.textContent = mode.label;
    $bgMode.appendChild(option);
  }
  $bgMode.value = 'transparent';
}

function currentChoice() {
  return chooseModel($subjectSelect.value, hasWebGPU);
}

function updateConsentInfo() {
  const choice = currentChoice();
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modelKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.label} / ライセンス: ${choice.license}`;
}

function setupUi() {
  populateSelectors();
  updateConsentInfo();
  updateBackgroundControls();
  updateLicenseNote(SUBJECTS[0].modelKey);

  $consentBtn.addEventListener('click', () => {
    clearError();
    $consentBtn.disabled = true;
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    $loadingHint.textContent = '初回はモデルのダウンロードが発生します';
    if (!worker) {
      setupWorker();
      requestModelLoad();
    }
  });

  $fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadImageFile(file);
  });

  $imageDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    $imageDrop.classList.add('drag-over');
  });
  $imageDrop.addEventListener('dragleave', () => $imageDrop.classList.remove('drag-over'));
  $imageDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    $imageDrop.classList.remove('drag-over');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadImageFile(file);
  });

  $subjectSelect.addEventListener('change', () => {
    updateConsentInfo();
    updateLicenseNote(currentChoice().modelKey);
    if (appReady) {
      requestModelLoad();
      if (source) pendingReprocess = true;
    }
  });

  $bgMode.addEventListener('change', () => {
    updateBackgroundControls();
    renderResult();
  });
  $bgColor.addEventListener('input', renderResult);
  $bgImageInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadBackgroundFile(file);
  });

  $processBtn.addEventListener('click', startProcess);
  $clearBtn.addEventListener('click', clearAll);
  $downloadBtn.addEventListener('click', downloadResult);

  $infoBtn.addEventListener('click', () => {
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

  updateProcessEnabled();
}

setupUi();
