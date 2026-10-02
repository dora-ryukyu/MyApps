/**
 * script.js — インタラクティブ画像セグメンテーション (SAM) のメインスレッド制御
 *
 * UI と画像のデコード・マスクの描画・切り抜き・他アプリへの受け渡しを担当し、
 * 推論は worker.js に投げる。モデルのダウンロードも worker 側で完結する。
 */

import {
  listModels,
  chooseModel,
  estimateModelBytes,
  formatBytes,
  formatScore,
  compositePixels,
  maskPlaneToRGBA,
  computeMaskCrop,
  buildCutoutName,
  buildMaskName,
  buildHandoff,
  serializeHandoff,
  SEGMENT_HANDOFF_KEY,
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
const $modePoint = $('mode-point');
const $modeBox = $('mode-box');
const $promptSummary = $('prompt-summary');
const $clearPromptsBtn = $('clear-prompts-btn');
const $segmentBtn = $('segment-btn');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $timeBadge = $('time-badge');
const $statusText = $('status-text');
const $segmentProgress = $('segment-progress');
const $segmentProgressFill = $('segment-progress-fill');
const $resultEmpty = $('result-empty');
const $resultCanvas = $('result-canvas');
const $maskCandidates = $('mask-candidates');
const $maskEmpty = $('mask-empty');
const $selectionSummary = $('selection-summary');
const $downloadMaskBtn = $('download-mask-btn');
const $downloadCutoutBtn = $('download-cutout-btn');
const $showCutoutBtn = $('show-cutout-btn');
const $showMaskBtn = $('show-mask-btn');
const $sendStudioBtn = $('send-studio-btn');
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
let encoding = false;
let running = false;
let backend = '';
const hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);

let source = null; // { name, width, height, data: Uint8ClampedArray }
let sourceUrl = null;
let baseCanvas = null;
let reshapedReady = false;

let mode = 'point'; // 'point' | 'box'
let points = []; // { x, y, label }  正規化座標 (label 1=前景, 0=背景)
let box = null; // { xmin, ymin, xmax, ymax } 正規化
let drawBox = null; // ドラッグ中の矩形 (正規化)

let maskResult = null; // { width, height, planes, scores, index, score, elapsedMs }
let selectedIndex = 0;
let view = 'overlay'; // 'overlay' | 'cutout' | 'mask'
let pointerDown = null;

/* ==========================================================
   起動 / worker
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
      case 'encoded':
        handleEncoded(message);
        break;
      case 'mask':
        handleMask(message);
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
  updateSegmentEnabled();
  if (appReady) setStatus('モデルを切り替え中…');
  worker.postMessage({ type: 'load', modeKey: listModels()[0].key });
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleStatus(message) {
  if (!appReady && message.stage !== 'process' && message.stage !== 'encode') {
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
  updateSegmentEnabled();
  if (source) requestEncode();
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
      ? 'セグメンテーションエラー'
      : message.stage === 'encode'
        ? '画像解析エラー'
        : message.stage === 'cache'
          ? 'キャッシュ操作エラー'
          : '初期化エラー';
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    if (!appReady) resetConsent('再試行する');
    else setStatus('モデルの読み込みに失敗しました');
  } else if (message.stage === 'process' || message.stage === 'encode') {
    running = false;
    encoding = false;
    stopSegmentProgress();
    updateSegmentEnabled();
    setStatus('処理に失敗しました');
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
    resetPrompts();
    resetResult();
    $resultEmpty.style.display = 'none';
    setStatus('画像を読み込みました。点または矩形を置いてください。');
    updateSegmentEnabled();
    if (modelReady) requestEncode();
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

function buildBaseCanvas() {
  baseCanvas = document.createElement('canvas');
  baseCanvas.width = source.width;
  baseCanvas.height = source.height;
  const ctx = baseCanvas.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(new ImageData(source.data, source.width, source.height), 0, 0);
}

/* ==========================================================
   画像の埋め込み要求
   ========================================================== */
function requestEncode() {
  if (!worker || !modelReady || !source || encoding) return;
  encoding = true;
  reshapedReady = false;
  updateSegmentEnabled();
  startSegmentProgress();
  setStatus('画像を解析中…');
  const copy = source.data.slice();
  worker.postMessage(
    {
      type: 'encode',
      width: source.width,
      height: source.height,
      data: copy.buffer,
    },
    [copy.buffer],
  );
}

function handleEncoded(message) {
  encoding = false;
  reshapedReady = true;
  stopSegmentProgress();
  $timeBadge.textContent = `${(Number(message.elapsedMs) || 0) / 1000}秒`;
  setStatus('解析が完了しました。切り抜く対象を指定してください。');
  updateSegmentEnabled();
  if (points.length || box) requestSegment();
}

/* ==========================================================
   セグメンテーション
   ========================================================== */
function updateSegmentEnabled() {
  const hasPrompt = points.length > 0 || Boolean(box);
  $segmentBtn.disabled = !(modelReady && source && reshapedReady && hasPrompt && !running && !encoding);
}

function startSegmentProgress() {
  $segmentProgress.style.display = 'block';
  $segmentProgress.classList.add('indeterminate');
}

function stopSegmentProgress() {
  $segmentProgress.style.display = 'none';
  $segmentProgress.classList.remove('indeterminate');
}

function requestSegment() {
  if (!worker || !modelReady || !source || !reshapedReady || running) return;
  if (!points.length && !box) return;
  clearError();
  running = true;
  updateSegmentEnabled();
  startSegmentProgress();
  setStatus('セグメンテーション中…');
  worker.postMessage({
    type: 'segment',
    points: points.map((p) => ({ x: p.x, y: p.y, label: p.label })),
    boxes: box ? [{ ...box }] : [],
  });
}

function handleMask(message) {
  running = false;
  stopSegmentProgress();
  maskResult = {
    width: Number(message.width),
    height: Number(message.height),
    planes: (message.planes || []).map((plane) => {
      if (plane instanceof Uint8Array) return plane;
      if (plane instanceof Uint8ClampedArray) return new Uint8Array(plane.buffer, plane.byteOffset, plane.length);
      return new Uint8Array(plane);
    }),
    scores: Array.isArray(message.scores) ? message.scores : [],
    index: Number(message.index) || 0,
    score: message.score,
    elapsedMs: Number(message.elapsedMs) || 0,
  };
  selectedIndex = maskResult.index;
  view = 'overlay';
  renderMaskCandidates();
  renderOverlay();
  $timeBadge.textContent = `${(maskResult.elapsedMs / 1000).toFixed(2)}秒`;
  const candidate = maskResult.planes[selectedIndex];
  const crop = candidate ? computeMaskCrop(candidate, maskResult.width, maskResult.height, 4) : null;
  setStatus(
    crop
      ? `マスクを生成しました (切り抜き ${crop.w}×${crop.h})`
      : 'マスクを生成しました (領域が見つかりません)',
  );
  updateSegmentEnabled();
  updateSelectionUi();
}

/* ==========================================================
   マスク候補
   ========================================================== */
function renderMaskCandidates() {
  $maskCandidates.textContent = '';
  if (!maskResult) {
    $maskEmpty.style.display = 'block';
    return;
  }
  $maskEmpty.style.display = 'none';
  maskResult.planes.forEach((plane, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'candidate-btn';
    btn.classList.toggle('active', index === selectedIndex);
    const score = maskResult.scores[index];
    btn.textContent = `候補 ${index + 1}${Number.isFinite(score) ? ` / ${formatScore(score)}` : ''}`;
    btn.addEventListener('click', () => {
      selectedIndex = index;
      view = 'overlay';
      renderMaskCandidates();
      renderOverlay();
      updateSelectionUi();
    });
    $maskCandidates.appendChild(btn);
  });
}

function currentPlane() {
  if (!maskResult) return null;
  return maskResult.planes[selectedIndex] || null;
}

/* ==========================================================
   描画
   ========================================================== */
function prepareResultCanvas(width, height) {
  $resultCanvas.width = width;
  $resultCanvas.height = height;
  $resultCanvas.style.display = 'block';
  $resultEmpty.style.display = 'none';
  return $resultCanvas.getContext('2d');
}

function renderOverlay() {
  view = 'overlay';
  if (!source) return;
  const ctx = prepareResultCanvas(source.width, source.height);
  ctx.drawImage(baseCanvas, 0, 0);

  const plane = currentPlane();
  if (plane) {
    const rgba = maskPlaneToRGBA(plane, source.width, source.height, { color: [124, 58, 237] });
    const imageData = new ImageData(rgba, source.width, source.height);
    const overlay = document.createElement('canvas');
    overlay.width = source.width;
    overlay.height = source.height;
    overlay.getContext('2d').putImageData(imageData, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.drawImage(overlay, 0, 0);
    ctx.restore();
  }

  // ドラッグ中の矩形
  const activeBox = drawBox || box;
  if (activeBox) {
    const x = activeBox.xmin * source.width;
    const y = activeBox.ymin * source.height;
    const w = (activeBox.xmax - activeBox.xmin) * source.width;
    const h = (activeBox.ymax - activeBox.ymin) * source.height;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#7c3aed';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // 点マーカー
  for (const point of points) {
    const cx = point.x * source.width;
    const cy = point.y * source.height;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = point.label === 0 ? '#ef4444' : '#22c55e';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  updateSelectionUi();
}

function renderCutout() {
  const plane = currentPlane();
  if (!plane || !source) return;
  const crop = computeMaskCrop(plane, source.width, source.height, 4);
  if (!crop) {
    showError('マスクの領域が見つかりませんでした。');
    return;
  }
  const composed = compositePixels(source.data, source.width, source.height, plane);
  const full = document.createElement('canvas');
  full.width = source.width;
  full.height = source.height;
  full.getContext('2d').putImageData(new ImageData(composed, source.width, source.height), 0, 0);

  const ctx = prepareResultCanvas(crop.w, crop.h);
  ctx.clearRect(0, 0, crop.w, crop.h);
  ctx.drawImage(full, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  view = 'cutout';
  setStatus(`切り抜きを表示中 (${crop.w}×${crop.h})`);
  updateSelectionUi();
}

function renderMaskView() {
  const plane = currentPlane();
  if (!plane || !source) return;
  const rgba = maskPlaneToRGBA(plane, source.width, source.height, { color: [124, 58, 237] });
  const ctx = prepareResultCanvas(source.width, source.height);
  ctx.clearRect(0, 0, source.width, source.height);
  ctx.putImageData(new ImageData(rgba, source.width, source.height), 0, 0);
  view = 'mask';
  setStatus('マスクを表示中');
  updateSelectionUi();
}

function updateSelectionUi() {
  const has = Boolean(currentPlane());
  $downloadCutoutBtn.disabled = !has;
  $downloadMaskBtn.disabled = !has;
  $showCutoutBtn.disabled = !has;
  $showMaskBtn.disabled = !has;
  $sendStudioBtn.disabled = !has;
  $resetViewBtn.disabled = view === 'overlay';
  if (!source) {
    $selectionSummary.textContent = '画像を読み込むとここに結果が出ます';
  } else if (!has) {
    $selectionSummary.textContent = '点または矩形を置いて切り抜いてください';
  } else {
    $selectionSummary.textContent = `候補 ${selectedIndex + 1} を選択中（切り抜き / PNG 書き出しに適用）`;
  }
}

/* ==========================================================
   ダウンロード / 受け渡し
   ========================================================== */
function canvasToDataUrl(width, height, pixels) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** 切り抜き全体 (透過 PNG) の data URL。crop 済みでない元サイズ。 */
function buildCutoutDataUrl() {
  const plane = currentPlane();
  if (!plane || !source) return null;
  const composed = compositePixels(source.data, source.width, source.height, plane);
  return canvasToDataUrl(source.width, source.height, composed);
}

function buildMaskDataUrl() {
  const plane = currentPlane();
  if (!plane || !source) return null;
  const rgba = maskPlaneToRGBA(plane, source.width, source.height, { color: [255, 255, 255] });
  return canvasToDataUrl(source.width, source.height, rgba);
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadCutout() {
  const dataUrl = buildCutoutDataUrl();
  if (!dataUrl) return;
  downloadDataUrl(dataUrl, buildCutoutName(source.name));
  setStatus('切り抜き PNG を書き出しました');
}

function downloadMask() {
  const dataUrl = buildMaskDataUrl();
  if (!dataUrl) return;
  downloadDataUrl(dataUrl, buildMaskName(source.name));
  setStatus('マスク PNG を書き出しました');
}

/**
 * 切り抜きとマスクを sessionStorage に置いて image-studio へ移動する。
 * bg-remove / inpainting も同じキー (SEGMENT_HANDOFF_KEY) を読める。
 */
function sendToStudio() {
  const cutoutDataUrl = buildCutoutDataUrl();
  if (!cutoutDataUrl || !source) return;
  try {
    const handoff = buildHandoff({
      cutoutDataUrl,
      maskDataUrl: buildMaskDataUrl(),
      width: source.width,
      height: source.height,
      sourceName: source.name,
    });
    sessionStorage.setItem(SEGMENT_HANDOFF_KEY, serializeHandoff(handoff));
  } catch (err) {
    console.error(err);
    showError(`受け渡しに失敗しました: ${err && err.message ? err.message : String(err)}`);
    return;
  }
  window.location.href = '../image-studio/index.html';
}

/* ==========================================================
   ポインタ操作
   ========================================================== */
function canvasPoint(event) {
  const rect = $resultCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function handlePointerDown(event) {
  if (!source || !reshapedReady) return;
  if (event.button === 2 && mode !== 'point') return;
  event.preventDefault();
  const point = canvasPoint(event);
  if (mode === 'box') {
    drawBox = { xmin: point.x, ymin: point.y, xmax: point.x, ymax: point.y };
    pointerDown = point;
    renderOverlay();
    return;
  }
  points.push({ x: point.x, y: point.y, label: event.button === 2 ? 0 : 1 });
  updatePromptSummary();
  renderOverlay();
  updateSegmentEnabled();
  requestSegment();
}

function handlePointerMove(event) {
  if (mode !== 'box' || !pointerDown) return;
  const point = canvasPoint(event);
  drawBox = {
    xmin: Math.min(pointerDown.x, point.x),
    ymin: Math.min(pointerDown.y, point.y),
    xmax: Math.max(pointerDown.x, point.x),
    ymax: Math.max(pointerDown.y, point.y),
  };
  renderOverlay();
}

function handlePointerUp() {
  if (mode !== 'box' || !pointerDown) return;
  pointerDown = null;
  if (drawBox && drawBox.xmax - drawBox.xmin > 0.005 && drawBox.ymax - drawBox.ymin > 0.005) {
    box = drawBox;
  }
  drawBox = null;
  updatePromptSummary();
  renderOverlay();
  updateSegmentEnabled();
  requestSegment();
}

function updatePromptSummary() {
  const parts = [];
  if (points.length) parts.push(`点 ${points.length} 個`);
  if (box) parts.push('矩形 1 個');
  $promptSummary.textContent = parts.length ? parts.join(' / ') : 'プロンプト未設定';
}

/* ==========================================================
   リセット
   ========================================================== */
function resetPrompts() {
  points = [];
  box = null;
  drawBox = null;
  pointerDown = null;
  updatePromptSummary();
  updateSegmentEnabled();
}

function resetResult() {
  maskResult = null;
  selectedIndex = 0;
  $maskCandidates.textContent = '';
  $maskEmpty.style.display = 'block';
  if (source) {
    const ctx = prepareResultCanvas(source.width, source.height);
    ctx.drawImage(baseCanvas, 0, 0);
  }
  $timeBadge.textContent = '-';
  updateSelectionUi();
}

function clearAll() {
  source = null;
  baseCanvas = null;
  reshapedReady = false;
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  $sourcePreview.removeAttribute('src');
  $sourceName.textContent = '';
  $imageDrop.classList.remove('has-image');
  $fileInput.value = '';
  resetPrompts();
  resetResult();
  $resultCanvas.width = 0;
  $resultCanvas.height = 0;
  $resultCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  stopSegmentProgress();
  updateSegmentEnabled();
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
   初期化
   ========================================================== */
function setMode(next) {
  mode = next === 'box' ? 'box' : 'point';
  $modePoint.classList.toggle('active', mode === 'point');
  $modeBox.classList.toggle('active', mode === 'box');
  $resultCanvas.classList.toggle('mode-box', mode === 'box');
  drawBox = null;
  pointerDown = null;
  if (source) renderOverlay();
}

function updateConsentInfo() {
  const choice = chooseModel(listModels()[0].key, hasWebGPU);
  $modelSize.textContent = formatBytes(estimateModelBytes(choice.modeKey, choice.device));
  $modelLicense.textContent = `使用モデル: ${choice.shortLabel} / ライセンス: ${choice.license}`;
}

function setupUi() {
  updateConsentInfo();
  updatePromptSummary();
  updateSelectionUi();
  updateSegmentEnabled();
  setMode('point');

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

  $modePoint.addEventListener('click', () => setMode('point'));
  $modeBox.addEventListener('click', () => setMode('box'));
  $clearPromptsBtn.addEventListener('click', () => {
    resetPrompts();
    if (source) renderOverlay();
  });
  $segmentBtn.addEventListener('click', () => {
    if (!reshapedReady && source) requestEncode();
    else requestSegment();
  });

  $downloadCutoutBtn.addEventListener('click', downloadCutout);
  $downloadMaskBtn.addEventListener('click', downloadMask);
  $showCutoutBtn.addEventListener('click', renderCutout);
  $showMaskBtn.addEventListener('click', renderMaskView);
  $sendStudioBtn.addEventListener('click', sendToStudio);
  $resetViewBtn.addEventListener('click', renderOverlay);

  $resultCanvas.addEventListener('pointerdown', handlePointerDown);
  $resultCanvas.addEventListener('pointermove', handlePointerMove);
  $resultCanvas.addEventListener('pointerup', handlePointerUp);
  $resultCanvas.addEventListener('pointerleave', handlePointerUp);
  $resultCanvas.addEventListener('contextmenu', (event) => event.preventDefault());

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
