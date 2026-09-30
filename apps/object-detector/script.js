/**
 * script.js — 物体検出アプリのメインスレッド制御
 *
 * UI と画像のデコード・矩形の描画・切り出し・ぼかしを担当し、
 * 推論は worker.js に投げる。モデルのダウンロードも worker 側で完結する。
 */

import {
  listModels,
  chooseModel,
  estimateModelBytes,
  formatBytes,
  formatScore,
  labelJa,
  classColor,
  unionBox,
  computeCropRegion,
  buildDownloadName,
  buildCropName,
  isSupportedImage,
  DEFAULT_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
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
const $thresholdInput = $('threshold-input');
const $thresholdValue = $('threshold-value');
const $iouInput = $('iou-input');
const $iouValue = $('iou-value');
const $detectBtn = $('detect-btn');
const $clearBtn = $('clear-btn');
const $detectProgress = $('detect-progress');
const $detectProgressFill = $('detect-progress-fill');
const $downloadBtn = $('download-btn');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $countBadge = $('count-badge');
const $timeBadge = $('time-badge');
const $statusText = $('status-text');
const $resultCanvas = $('result-canvas');
const $resultEmpty = $('result-empty');
const $detectionList = $('detection-list');
const $detectionEmpty = $('detection-empty');
const $selectionSummary = $('selection-summary');
const $cropBtn = $('crop-btn');
const $blurBtn = $('blur-btn');
const $resetViewBtn = $('reset-view-btn');
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
const hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

let source = null; // { name, width, height, data: Uint8ClampedArray }
let sourceUrl = null;
let baseCanvas = null; // 元画像を描いたオフスクリーン canvas
let detections = [];
let selected = new Set();
let view = 'overlay'; // 'overlay' | 'crop' | 'blur'
let elapsedMs = 0;

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
      case 'detections':
        handleDetections(message);
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

/** 選択中のモデルを worker に読み込ませる */
function requestModelLoad() {
  if (!worker) return;
  modelReady = false;
  updateDetectEnabled();
  if (appReady) setStatus('モデルを切り替え中…');
  worker.postMessage({ type: 'load', modeKey: listModels()[0].key });
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
  if (message.stage !== 'download' || appReady) return;
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
    setStatus('モデルを準備しました');
  }
  updateDetectEnabled();
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
      ? '検出エラー'
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
    stopDetectProgress();
    updateDetectEnabled();
    setStatus('検出に失敗しました');
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
    buildBaseCanvas();
    resetDetections();
    renderOverlay();
    $resultEmpty.style.display = 'none';
    setStatus('画像を読み込みました');
    updateDetectEnabled();
    if (modelReady) startDetect();
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

/** 元画像を描いたオフスクリーン canvas を作る */
function buildBaseCanvas() {
  baseCanvas = document.createElement('canvas');
  baseCanvas.width = source.width;
  baseCanvas.height = source.height;
  const ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(new ImageData(source.data, source.width, source.height), 0, 0);
}

function resetDetections() {
  detections = [];
  selected = new Set();
  view = 'overlay';
  elapsedMs = 0;
  $detectionList.textContent = '';
  $detectionEmpty.style.display = 'block';
  $countBadge.textContent = '検出: -';
  $timeBadge.textContent = '-';
  updateSelectionUi();
}

/* ==========================================================
   検出
   ========================================================== */
function updateDetectEnabled() {
  $detectBtn.disabled = !(modelReady && source && !running);
}

function startDetectProgress() {
  $detectProgress.style.display = 'block';
  $detectProgress.classList.add('indeterminate');
}

function stopDetectProgress() {
  $detectProgress.style.display = 'none';
  $detectProgress.classList.remove('indeterminate');
}

function startDetect() {
  if (!modelReady || !source || running) return;
  clearError();
  running = true;
  updateDetectEnabled();
  startDetectProgress();
  setStatus('検出中…');

  // メイン側の画像は保持したまま、コピーをワーカーへ転送する
  const copy = source.data.slice();
  worker.postMessage(
    {
      type: 'detect',
      width: source.width,
      height: source.height,
      data: copy.buffer,
      threshold: Number($thresholdInput.value),
      iouThreshold: Number($iouInput.value),
    },
    [copy.buffer],
  );
}

function handleDetections(message) {
  running = false;
  stopDetectProgress();
  elapsedMs = Number(message.elapsedMs) || 0;
  detections = Array.isArray(message.detections) ? message.detections : [];
  selected = new Set(detections.map((det) => det.id));
  view = 'overlay';
  renderDetectionList();
  renderOverlay();
  $countBadge.textContent = `検出: ${detections.length} 件`;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(2)} 秒`;
  setStatus(detections.length ? `${detections.length} 件の物体を検出しました` : '物体は見つかりませんでした');
  updateDetectEnabled();
  updateSelectionUi();
}

/* ==========================================================
   検出一覧
   ========================================================== */
function renderDetectionList() {
  $detectionList.textContent = '';
  $detectionEmpty.style.display = detections.length ? 'none' : 'block';

  for (const det of detections) {
    const row = document.createElement('label');
    row.className = 'detection-item';
    row.dataset.id = String(det.id);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(det.id);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(det.id);
      else selected.delete(det.id);
      updateSelectionUi();
      if (view === 'overlay') renderOverlay();
    });

    const swatch = document.createElement('span');
    swatch.className = 'detection-swatch';
    swatch.style.background = classColor(det.label);

    const body = document.createElement('span');
    body.className = 'detection-body';
    const name = document.createElement('span');
    name.className = 'detection-label';
    name.textContent = `${labelJa(det.label)} (${det.label})`;
    const meta = document.createElement('span');
    meta.className = 'detection-meta';
    meta.textContent = `${formatScore(det.score)} / ${det.box.xmax - det.box.xmin}×${det.box.ymax - det.box.ymin}px`;
    body.append(name, meta);

    row.append(check, swatch, body);
    $detectionList.appendChild(row);
  }
}

function selectedDetections() {
  return detections.filter((det) => selected.has(det.id));
}

function updateSelectionUi() {
  const count = selected.size;
  $selectionSummary.textContent = count
    ? `${count} 件を選択中（切り出し / ぼかしに適用）`
    : detections.length
      ? '物体を選んでください'
      : '検出結果はまだありません';
  const enabled = count > 0;
  $cropBtn.disabled = !enabled;
  $blurBtn.disabled = !enabled;
  $resetViewBtn.disabled = view === 'overlay' || detections.length === 0;
}

/* ==========================================================
   描画
   ========================================================== */
function renderOverlay() {
  view = 'overlay';
  if (!source) return;
  const ctx = prepareResultCanvas(source.width, source.height);
  ctx.drawImage(baseCanvas, 0, 0);
  if (!detections.length) {
    $resultEmpty.style.display = source ? 'none' : 'block';
    updateSelectionUi();
    return;
  }

  ctx.lineJoin = 'round';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  for (const det of detections) {
    const isSelected = selected.has(det.id);
    const color = classColor(det.label);
    const { xmin, ymin, xmax, ymax } = det.box;
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.strokeStyle = isSelected ? color : 'rgba(148, 163, 184, 0.9)';
    ctx.strokeRect(xmin, ymin, Math.max(1, xmax - xmin), Math.max(1, ymax - ymin));

    if (isSelected) {
      const text = `${labelJa(det.label)} ${formatScore(det.score)}`;
      const width = ctx.measureText(text).width + 10;
      const ty = Math.max(18, ymin);
      ctx.fillStyle = color;
      ctx.fillRect(xmin, ty - 18, width, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, xmin + 5, ty - 4);
    }
  }
  updateSelectionUi();
}

function renderCrop() {
  const chosen = selectedDetections();
  if (!chosen.length) return;
  const box = chosen.length === 1 ? chosen[0].box : unionBox(chosen.map((det) => det.box));
  const region = computeCropRegion(box, source.width, source.height, 8);
  const ctx = prepareResultCanvas(region.w, region.h);
  ctx.drawImage(baseCanvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  view = 'crop';
  updateSelectionUi();
  setStatus(`切り出しました (${region.w}×${region.h})`);
}

function renderBlur() {
  const chosen = selectedDetections();
  if (!chosen.length) return;
  const ctx = prepareResultCanvas(source.width, source.height);
  ctx.drawImage(baseCanvas, 0, 0);
  const strength = Math.max(8, Math.round(Math.min(source.width, source.height) * 0.02));

  for (const det of chosen) {
    const region = computeCropRegion(det.box, source.width, source.height, 0);
    const pad = strength * 2;
    const rx = Math.max(0, region.x - pad);
    const ry = Math.max(0, region.y - pad);
    const rw = Math.min(source.width - rx, region.w + pad * 2);
    const rh = Math.min(source.height - ry, region.h + pad * 2);

    const tmp = document.createElement('canvas');
    tmp.width = rw;
    tmp.height = rh;
    tmp.getContext('2d').drawImage(baseCanvas, rx, ry, rw, rh, 0, 0, rw, rh);

    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.w, region.h);
    ctx.clip();
    ctx.filter = `blur(${strength}px)`;
    ctx.drawImage(tmp, rx, ry, rw, rh, rx, ry, rw, rh);
    ctx.restore();
  }
  ctx.filter = 'none';
  view = 'blur';
  updateSelectionUi();
  setStatus(`選択した ${chosen.length} 件をぼかしました`);
}

function prepareResultCanvas(width, height) {
  $resultCanvas.width = width;
  $resultCanvas.height = height;
  $resultCanvas.style.display = 'block';
  $resultEmpty.style.display = 'none';
  $downloadBtn.disabled = false;
  return $resultCanvas.getContext('2d');
}

/* ==========================================================
   ダウンロード
   ========================================================== */
function downloadResult() {
  if (!source) return;
  $resultCanvas.toBlob((blob) => {
    if (!blob) {
      showError('PNG の書き出しに失敗しました。');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    if (view === 'crop') {
      const chosen = selectedDetections();
      const label = chosen.length === 1 ? chosen[0].label : 'objects';
      a.download = buildCropName(source.name, label, 0);
    } else if (view === 'blur') {
      a.download = buildDownloadName(source.name, 'blurred');
    } else {
      a.download = buildDownloadName(source.name, 'detected');
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function clearAll() {
  source = null;
  baseCanvas = null;
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  $sourcePreview.removeAttribute('src');
  $sourceName.textContent = '';
  $imageDrop.classList.remove('has-image');
  $fileInput.value = '';
  resetDetections();
  $resultCanvas.width = 0;
  $resultCanvas.height = 0;
  $resultCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  $downloadBtn.disabled = true;
  stopDetectProgress();
  updateDetectEnabled();
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

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function updateThresholdLabel() {
  $thresholdValue.textContent = formatScore($thresholdInput.value);
  $iouValue.textContent = Number($iouInput.value).toFixed(2);
}

function updateConsentInfo() {
  const choice = chooseModel(listModels()[0].key, hasWebGPU);
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modeKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.shortLabel} / ライセンス: ${choice.license}`;
}

function setupUi() {
  $thresholdInput.value = String(DEFAULT_THRESHOLD);
  $iouInput.value = String(DEFAULT_IOU_THRESHOLD);
  updateThresholdLabel();
  updateConsentInfo();
  updateSelectionUi();
  updateDetectEnabled();

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

  $thresholdInput.addEventListener('input', updateThresholdLabel);
  $iouInput.addEventListener('input', updateThresholdLabel);

  $detectBtn.addEventListener('click', startDetect);
  $clearBtn.addEventListener('click', clearAll);
  $downloadBtn.addEventListener('click', downloadResult);
  $cropBtn.addEventListener('click', renderCrop);
  $blurBtn.addEventListener('click', renderBlur);
  $resetViewBtn.addEventListener('click', renderOverlay);

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
}

setupUi();
