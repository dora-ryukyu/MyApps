/**
 * script.js — アップスケールアプリのメインスレッド制御
 *
 * UI と画像のデコード・アルファ保持を担当し、推論は worker.js に投げる。
 * モデルのダウンロードも worker 側で完結する。
 */

import {
  listModels,
  chooseModel,
  estimateModelBytes,
  formatBytes,
  buildDownloadName,
  isSupportedImage,
  outputSize,
  assertOutputFits,
  MAX_OUTPUT_PIXELS,
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
const $modeSelect = $('mode-select');
const $modeNote = $('mode-note');
const $licenseNote = $('license-note');
const $processBtn = $('process-btn');
const $clearBtn = $('clear-btn');
const $processProgress = $('process-progress');
const $processProgressFill = $('process-progress-fill');
const $downloadBtn = $('download-btn');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $sizeBadge = $('size-badge');
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
let appReady = false;
let modelReady = false;
let running = false;
let backend = '';
let hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

let source = null; // { name, width, height, data: Uint8ClampedArray, hasAlpha }
let sourceUrl = null;
let result = null; // { width, height, data: Uint8ClampedArray }
let elapsedMs = 0;
let pendingReprocess = false;

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

/** 選択中のモードを worker に読み込ませる */
function requestModelLoad() {
  if (!worker) return;
  modelReady = false;
  updateProcessEnabled();
  if (!appReady) return;
  setStatus('モデルを切り替え中…');
  worker.postMessage({ type: 'load', modeKey: $modeSelect.value });
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
  if (message.stage === 'process') {
    $processProgress.style.display = 'block';
    const percent = message.total ? (message.done / message.total) * 100 : 0;
    $processProgressFill.style.width = `${Math.min(100, percent)}%`;
    return;
  }
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
  updateLicenseNote(message.modeKey);
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
  updateSizeBadge();

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
    $processProgress.style.display = 'none';
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
    source = {
      name: file.name || 'image',
      ...decoded,
      hasAlpha: detectAlpha(decoded.data),
    };
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    $sourcePreview.src = sourceUrl;
    $sourceName.textContent = `${source.name} (${source.width}×${source.height})`;
    $imageDrop.classList.add('has-image');
    resetResult();
    updateSizeBadge();
    setStatus('画像を読み込みました');
    updateProcessEnabled();
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

/** 透過画素が 1 つでもあるか */
function detectAlpha(data) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function resetResult() {
  result = null;
  elapsedMs = 0;
  $resultCanvas.width = 0;
  $resultCanvas.height = 0;
  $resultCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  $downloadBtn.disabled = true;
  $timeBadge.textContent = '-';
  $processProgress.style.display = 'none';
  $processProgressFill.style.width = '0%';
}

/* ==========================================================
   推論
   ========================================================== */
function currentScale() {
  return chooseModel($modeSelect.value, hasWebGPU).scale;
}

function updateProcessEnabled() {
  $processBtn.disabled = !(modelReady && source && !running);
}

function startProcess() {
  if (!modelReady || !source || running) return;
  clearError();
  try {
    assertOutputFits(source.width, source.height, currentScale());
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    setStatus('画像が大きすぎます');
    return;
  }
  running = true;
  updateProcessEnabled();
  $resultEmpty.style.display = 'none';
  $downloadBtn.disabled = true;
  $processProgress.style.display = 'block';
  $processProgressFill.style.width = '0%';
  setStatus('推論中…');

  // メイン側の画像は保持したまま、コピーをワーカーへ転送する
  const copy = source.data.slice();
  worker.postMessage(
    { type: 'process', width: source.width, height: source.height, data: copy.buffer },
    [copy.buffer],
  );
}

function handleResult(message) {
  running = false;
  const width = message.width;
  const height = message.height;
  let data = new Uint8ClampedArray(message.data);
  elapsedMs = Number(message.elapsedMs) || 0;

  if (source && source.hasAlpha) {
    try {
      data = applySourceAlpha(data, width, height);
    } catch (err) {
      console.warn('アルファチャンネルの反映に失敗:', err);
    }
  }

  result = { width, height, data };
  renderResult();
  $downloadBtn.disabled = false;
  $sizeBadge.textContent = `出力: ${width}×${height}`;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(1)} 秒`;
  $processProgress.style.display = 'none';
  $processProgressFill.style.width = '100%';
  setStatus(message.tiles > 1 ? `完成（タイル ${message.tiles} 枚）` : '完成');
  updateProcessEnabled();
}

/**
 * 元画像のアルファチャンネルを出力サイズに拡大して適用する。
 * モデルは RGB しか返さないため、透過 PNG の透明部分をここで復元する。
 */
function applySourceAlpha(upscaledData, outWidth, outHeight) {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = source.width;
  srcCanvas.height = source.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.putImageData(new ImageData(source.data, source.width, source.height), 0, 0);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = outWidth;
  maskCanvas.height = outHeight;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  maskCtx.imageSmoothingEnabled = true;
  maskCtx.drawImage(srcCanvas, 0, 0, outWidth, outHeight);
  const alpha = maskCtx.getImageData(0, 0, outWidth, outHeight).data;

  for (let i = 0; i < upscaledData.length; i += 4) {
    upscaledData[i + 3] = alpha[i + 3];
  }
  return upscaledData;
}

/* ==========================================================
   表示 / ダウンロード
   ========================================================== */
function renderResult() {
  if (!result) return;
  const { width, height, data } = result;
  $resultCanvas.width = width;
  $resultCanvas.height = height;
  const ctx = $resultCanvas.getContext('2d');
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  $resultCanvas.style.display = 'block';
  $resultEmpty.style.display = 'none';
}

function downloadResult() {
  if (!result) return;
  $resultCanvas.toBlob((blob) => {
    if (!blob) {
      showError('PNG の書き出しに失敗しました。');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildDownloadName(source ? source.name : 'image', currentScale());
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function clearAll() {
  source = null;
  result = null;
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  $sourcePreview.removeAttribute('src');
  $sourceName.textContent = '';
  $imageDrop.classList.remove('has-image');
  $fileInput.value = '';
  resetResult();
  updateSizeBadge();
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
  if (!message || !message.modeKey) return;
  const choice = chooseModel(message.modeKey, message.device === 'webgpu');
  const size = formatBytes(estimateModelBytes(message.modeKey, message.device || 'wasm'));
  $modelBadge.textContent = `モデル: ${choice.shortLabel} (${message.dtype}, ${size})`;
  $modelBadge.classList.toggle('badge-warning', !choice.commercial);
}

function updateLicenseNote(modeKey) {
  const model = listModels().find((m) => m.key === modeKey);
  if (!model || model.commercial) {
    $licenseNote.style.display = 'none';
    return;
  }
  $licenseNote.textContent = `${model.label} は非商用ライセンスです。研究・個人利用の範囲でお使いください。`;
  $licenseNote.style.display = 'block';
}

/** 出力予定サイズ (入力があれば) を表示する */
function updateSizeBadge() {
  if (!source) {
    $sizeBadge.textContent = '出力: -';
    $sizeBadge.classList.remove('badge-warning');
    updateProcessEnabled();
    return;
  }
  const scale = currentScale();
  const out = outputSize(source.width, source.height, scale);
  const tooLarge = out.width * out.height > MAX_OUTPUT_PIXELS;
  $sizeBadge.textContent = `出力: ${out.width}×${out.height}`;
  $sizeBadge.classList.toggle('badge-warning', tooLarge);
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
  $modeSelect.value = listModels()[0].key;
}

function updateModeNote() {
  const choice = chooseModel($modeSelect.value, hasWebGPU);
  const tileNote = `タイル ${choice.tile.size}px（大きい画像は自動で分割）`;
  const engineNote = choice.engine === 'ort' ? ' / 任意エンジン' : '';
  $modeNote.textContent = `${choice.scale}x に拡大 / ${tileNote}${engineNote}`;
}

function updateConsentInfo() {
  const choice = chooseModel($modeSelect.value, hasWebGPU);
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modeKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.shortLabel} / ライセンス: ${choice.license}`;
}

function setupUi() {
  populateModeSelect();
  updateModeNote();
  updateConsentInfo();
  updateSizeBadge();
  updateLicenseNote($modeSelect.value);

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

  $modeSelect.addEventListener('change', () => {
    updateModeNote();
    updateConsentInfo();
    updateLicenseNote($modeSelect.value);
    updateSizeBadge();
    if (appReady) {
      requestModelLoad();
      if (source) pendingReprocess = true;
    }
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
