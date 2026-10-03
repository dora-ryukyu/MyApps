/**
 * script.js — 顔の匿名化アプリのメインロジック
 *
 * 役割:
 *   - 画像の読み込み / ギャラリー / 選択
 *   - worker.js への検出依頼と結果の反映
 *   - 検出矩形の表示・手動追加・有効/無効の切替
 *   - ぼかし / モザイク / 黒塗り / 絵文字のプレビューと書き出し
 *
 * 純ロジック (矩形計算・画素加工) は pipeline.mjs に置き、ここは DOM を触る。
 */

import {
  MODEL_CATALOG,
  DEFAULT_MODE,
  DEFAULT_CONFIDENCE,
  DEFAULT_SUPPRESSION,
  REDACTION_MODES,
  EMOJI_CHOICES,
  DEFAULT_REDACTION,
  getMode,
  chooseModel,
  estimateDownloadBytes,
  buildRegions,
  applyRedactions,
  emojiFontSize,
  formatBytes,
  formatScore,
  isSupportedImage,
  sanitizeBaseName,
  buildDownloadName,
  buildZipName,
} from './pipeline.mjs';

/* ==========================================================
   DOM
   ========================================================== */
const $ = (id) => document.getElementById(id);

const els = {
  loadingScreen: $('loading-screen'),
  consentState: $('consent-state'),
  consentBtn: $('consent-btn'),
  loadingState: $('loading-state'),
  loadingStatus: $('loading-status'),
  progressFill: $('progress-fill'),
  loadingHint: $('loading-hint'),
  modelSize: $('model-size'),
  modelLicense: $('model-license'),
  appMain: $('app-main'),
  errorBox: $('error-box'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
  clearCacheBtn: $('clear-cache-btn'),
  imageDrop: $('image-drop'),
  fileInput: $('file-input'),
  imageList: $('image-list'),
  imageEmpty: $('image-empty'),
  modeSelect: $('mode-select'),
  modeNote: $('mode-note'),
  emojiRow: $('emoji-row'),
  emojiSelect: $('emoji-select'),
  marginInput: $('margin-input'),
  marginValue: $('margin-value'),
  strengthRow: $('strength-row'),
  strengthInput: $('strength-input'),
  strengthValue: $('strength-value'),
  confidenceInput: $('confidence-input'),
  confidenceValue: $('confidence-value'),
  mergeInput: $('merge-input'),
  detectBtn: $('detect-btn'),
  detectAllBtn: $('detect-all-btn'),
  addBoxBtn: $('add-box-btn'),
  clearDetectionsBtn: $('clear-detections-btn'),
  sourceName: $('source-name'),
  detectProgress: $('detect-progress'),
  detectProgressFill: $('detect-progress-fill'),
  backendBadge: $('backend-badge'),
  modelBadge: $('model-badge'),
  countBadge: $('count-badge'),
  timeBadge: $('time-badge'),
  statusText: $('status-text'),
  showPreviewBtn: $('show-preview-btn'),
  showResultBtn: $('show-result-btn'),
  resultEmpty: $('result-empty'),
  previewCanvas: $('preview-canvas'),
  resultCanvas: $('result-canvas'),
  selectionSummary: $('selection-summary'),
  detectionList: $('detection-list'),
  detectionEmpty: $('detection-empty'),
  downloadBtn: $('download-btn'),
  downloadAllBtn: $('download-all-btn'),
};

/* ==========================================================
   状態
   ========================================================== */
const state = {
  images: [],
  currentId: null,
  mode: DEFAULT_REDACTION,
  emoji: EMOJI_CHOICES[0],
  margin: 0.25,
  strength: 0.6,
  confidence: DEFAULT_CONFIDENCE,
  suppression: DEFAULT_SUPPRESSION,
  merge: false,
  addMode: false,
  view: 'preview', // 'preview' | 'result'
  drag: null,
  modelReady: false,
  busy: false,
  detectingId: null,
  queue: [],
};

let nextImageId = 1;
const MAX_PREVIEW_SIDE = 1600;

/* ==========================================================
   worker
   ========================================================== */
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

worker.addEventListener('message', (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'status':
      setStatus(message.message || '');
      break;
    case 'progress':
      updateDownloadProgress(message);
      break;
    case 'ready':
      onReady(message);
      break;
    case 'detections':
      onDetections(message);
      break;
    case 'error':
      onWorkerError(message);
      break;
    case 'cache-cleared':
      setStatus(
        message.removed > 0
          ? `モデルキャッシュを削除しました (${message.removed} 件)`
          : '削除するキャッシュはありませんでした',
      );
      break;
    default:
      break;
  }
});

/* ==========================================================
   起動 / 同意
   ========================================================== */
function initConsent() {
  const choice = chooseModel(DEFAULT_MODE, false);
  els.modelSize.textContent = formatBytes(estimateDownloadBytes(DEFAULT_MODE));
  const model = MODEL_CATALOG[DEFAULT_MODE];
  els.modelLicense.textContent = `使用モデル: ${model.label} / ライセンス: ${model.license}`;
  els.modelBadge.textContent = `モデル: ${choice.shortLabel}`;
}

els.consentBtn.addEventListener('click', () => {
  els.consentState.style.display = 'none';
  els.loadingState.style.display = '';
  try {
    worker.postMessage({ type: 'load', modeKey: DEFAULT_MODE });
  } catch (err) {
    showError(`モデルの読み込みを開始できませんでした: ${err.message}`);
  }
});

function updateDownloadProgress(message) {
  const total = Number(message.total) || estimateDownloadBytes(DEFAULT_MODE);
  const loaded = Number(message.loaded) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 40;
  els.progressFill.style.width = `${percent}%`;
  els.loadingStatus.textContent = `モデルをダウンロード中… ${formatBytes(loaded)} / ${formatBytes(total)}`;
}

function onReady(message) {
  state.modelReady = true;
  els.loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    els.loadingScreen.style.display = 'none';
  }, 300);
  els.appMain.style.display = '';
  els.backendBadge.textContent = `実行: ${message.delegate || '-'}`;
  setStatus('準備完了。画像を追加してください。');
  updateControls();
}

function onWorkerError(message) {
  state.busy = false;
  state.detectingId = null;
  state.queue = [];
  hideProgress();
  showError(message.error || '処理に失敗しました');
  updateControls();
}

function showError(text) {
  els.errorBox.textContent = text;
  els.errorBox.style.display = 'block';
}

function clearError() {
  els.errorBox.textContent = '';
  els.errorBox.style.display = 'none';
}

function setStatus(text) {
  els.statusText.textContent = text;
}

/* ==========================================================
   画像の読み込み
   ========================================================== */
async function addFiles(fileList) {
  clearError();
  const files = [...fileList].filter(isSupportedImage);
  if (files.length === 0) {
    showError('対応していないファイルです (PNG / JPEG / WebP / GIF / BMP / AVIF)。');
    return;
  }

  let added = [];
  for (const file of files) {
    try {
      const bitmap = await createImageBitmap(file);
      const image = {
        id: nextImageId,
        name: file.name || `image-${nextImageId}.png`,
        file,
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        detections: [],
        elapsedMs: null,
      };
      nextImageId += 1;
      state.images.push(image);
      added.push(image.id);
    } catch (err) {
      console.warn('画像を読み込めませんでした:', file.name, err);
    }
  }

  if (added.length === 0) {
    showError('画像の読み込みに失敗しました。');
    return;
  }

  renderGallery();
  selectImage(added[0]);
  updateControls();
}

function currentImage() {
  return state.images.find((image) => image.id === state.currentId) || null;
}

function selectImage(id) {
  state.currentId = id;
  state.addMode = false;
  state.drag = null;
  const image = currentImage();
  if (image) {
    els.sourceName.textContent = `${image.name} (${image.width}×${image.height})`;
  }
  renderGallery();
  renderPreview();
  renderDetectionList();
  renderResult();
  updateControls();
}

function renderGallery() {
  els.imageList.innerHTML = '';
  els.imageEmpty.style.display = state.images.length ? 'none' : 'block';

  for (const image of state.images) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-item';
    if (image.id === state.currentId) button.classList.add('active');

    const canvas = document.createElement('canvas');
    canvas.className = 'gallery-thumb';
    const side = 72;
    const scale = Math.min(side / image.width, side / image.height, 1);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);
    button.appendChild(canvas);

    const count = image.detections.filter((det) => det.enabled).length;
    const label = document.createElement('span');
    label.className = 'gallery-label';
    label.textContent = `${count} 顔`;
    button.appendChild(label);

    button.addEventListener('click', () => selectImage(image.id));
    els.imageList.appendChild(button);
  }
}

/* ==========================================================
   プレビュー (検出矩形)
   ========================================================== */
function fitCanvas(canvas, image, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  return scale;
}

function renderPreview() {
  const image = currentImage();
  const canvas = els.previewCanvas;

  if (!image) {
    els.resultEmpty.style.display = 'block';
    canvas.style.display = 'none';
    els.resultCanvas.style.display = 'none';
    return;
  }
  els.resultEmpty.style.display = 'none';
  if (state.view === 'preview') {
    canvas.style.display = '';
    els.resultCanvas.style.display = 'none';
  } else {
    canvas.style.display = 'none';
    els.resultCanvas.style.display = '';
    return;
  }

  fitCanvas(canvas, image, MAX_PREVIEW_SIDE);
  const ctx = canvas.getContext('2d');
  const sx = canvas.width / image.width;
  const sy = canvas.height / image.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);

  image.detections.forEach((det, index) => {
    const { box } = det;
    const x = box.xmin * sx;
    const y = box.ymin * sy;
    const w = (box.xmax - box.xmin) * sx;
    const h = (box.ymax - box.ymin) * sy;
    ctx.lineWidth = 2;
    ctx.strokeStyle = det.enabled ? '#dc2626' : '#94a3b8';
    ctx.setLineDash(det.source === 'manual' ? [6, 4] : []);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    ctx.fillStyle = det.source === 'manual' ? 'rgba(148,163,184,0.85)' : 'rgba(220,38,38,0.85)';
    const label = `${index + 1}${det.score != null ? ` ${formatScore(det.score)}` : ' 手動'}`;
    ctx.font = '12px sans-serif';
    const textWidth = ctx.measureText(label).width + 8;
    ctx.fillRect(x, Math.max(0, y - 18), textWidth, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 4, Math.max(12, y - 5));
  });

  if (state.drag) {
    const { x0, y0, x1, y1 } = state.drag;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
    ctx.setLineDash([]);
  }
}

/* ==========================================================
   匿名化結果
   ========================================================== */
function mosaicBlocks(strength) {
  // 強度が高いほどブロックを減らして粗くする
  return Math.max(2, Math.round(30 - Math.min(1, Math.max(0, strength)) * 26));
}

function renderFullResult(image) {
  const off = document.createElement('canvas');
  off.width = image.width;
  off.height = image.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(image.bitmap, 0, 0, image.width, image.height);

  const regions = buildRegions(image.detections, {
    width: image.width,
    height: image.height,
    margin: state.margin,
    merge: state.merge,
  });
  if (regions.length === 0) return { canvas: off, regions };

  const imageData = ctx.getImageData(0, 0, image.width, image.height);
  applyRedactions(imageData, regions, state.mode, {
    strength: state.strength,
    blocks: mosaicBlocks(state.strength),
  });
  ctx.putImageData(imageData, 0, 0);

  if (state.mode === 'emoji') {
    for (const region of regions) {
      const size = emojiFontSize({
        xmin: region.x,
        ymin: region.y,
        xmax: region.x + region.w,
        ymax: region.y + region.h,
      });
      ctx.font = `${size}px "Noto Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.emoji, region.x + region.w / 2, region.y + region.h / 2);
    }
  }
  return { canvas: off, regions };
}

function renderResult() {
  const image = currentImage();
  if (!image) return;
  if (state.view !== 'result') return;
  const { canvas: full } = renderFullResult(image);
  const canvas = els.resultCanvas;
  fitCanvas(canvas, image, MAX_PREVIEW_SIDE);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
}

function setView(view) {
  state.view = view;
  els.showPreviewBtn.classList.toggle('active', view === 'preview');
  els.showResultBtn.classList.toggle('active', view === 'result');
  renderPreview();
  renderResult();
}

/* ==========================================================
   検出矩形リスト
   ========================================================== */
function renderDetectionList() {
  const image = currentImage();
  els.detectionList.innerHTML = '';

  if (!image || image.detections.length === 0) {
    els.detectionEmpty.style.display = 'block';
    els.selectionSummary.textContent = '矩形はまだありません';
    return;
  }
  els.detectionEmpty.style.display = 'none';
  const enabled = image.detections.filter((det) => det.enabled).length;
  els.selectionSummary.textContent = `${image.detections.length} 個の矩形 / 有効 ${enabled} 個`;

  image.detections.forEach((det, index) => {
    const row = document.createElement('div');
    row.className = 'detection-item';
    if (!det.enabled) row.classList.add('disabled');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = det.enabled;
    check.title = 'この矩形を匿名化に使う';
    check.addEventListener('change', () => {
      det.enabled = check.checked;
      afterDetectionChange(image);
    });

    const swatch = document.createElement('span');
    swatch.className = 'detection-swatch';
    swatch.style.background = det.source === 'manual' ? '#94a3b8' : '#dc2626';

    const text = document.createElement('span');
    text.className = 'detection-text';
    text.textContent = `顔 ${index + 1}${det.score != null ? ` (${formatScore(det.score)})` : '（手動）'}`;

    const size = document.createElement('span');
    size.className = 'detection-size';
    size.textContent = `${det.box.xmax - det.box.xmin}×${det.box.ymax - det.box.ymin}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'detection-remove';
    remove.textContent = '×';
    remove.title = 'この矩形を削除';
    remove.addEventListener('click', () => {
      image.detections = image.detections.filter((entry) => entry !== det);
      afterDetectionChange(image);
    });

    row.append(check, swatch, text, size, remove);
    els.detectionList.appendChild(row);
  });
}

function afterDetectionChange(image) {
  renderGallery();
  if (image.id === state.currentId) {
    renderPreview();
    renderDetectionList();
    renderResult();
  }
  updateControls();
}

/* ==========================================================
   検出の実行
   ========================================================== */
function startDetection(ids) {
  if (!state.modelReady) {
    showError('モデルの準備がまだ完了していません。');
    return;
  }
  if (state.busy) return;
  state.queue = [...ids];
  state.busy = true;
  els.detectProgress.style.display = 'block';
  els.detectProgressFill.style.width = '10%';
  clearError();
  processQueue();
}

async function processQueue() {
  const id = state.queue.shift();
  if (id == null) {
    state.busy = false;
    state.detectingId = null;
    hideProgress();
    updateControls();
    renderGallery();
    return;
  }
  const image = state.images.find((entry) => entry.id === id);
  if (!image) {
    processQueue();
    return;
  }
  state.detectingId = id;
  els.detectProgressFill.style.width = `${Math.round((1 - state.queue.length / Math.max(1, state.images.length)) * 80 + 10)}%`;
  setStatus(`顔を検出中… ${image.name}`);
  try {
    const bitmap = await createImageBitmap(image.file);
    worker.postMessage(
      {
        type: 'detect',
        bitmap,
        width: image.width,
        height: image.height,
        confidence: state.confidence,
        suppression: state.suppression,
      },
      [bitmap],
    );
  } catch (err) {
    onWorkerError({ error: `画像を準備できませんでした: ${err.message}` });
  }
}

function onDetections(message) {
  const image = state.images.find((entry) => entry.id === state.detectingId);
  if (image) {
    image.detections = message.detections.map((det, index) => ({
      ...det,
      id: index,
      enabled: true,
      source: 'auto',
    }));
    image.elapsedMs = message.elapsedMs;
  }
  state.detectingId = null;

  if (image && image.id === state.currentId) {
    renderPreview();
    renderDetectionList();
    renderResult();
  }
  renderGallery();

  if (state.queue.length > 0) {
    processQueue();
  } else {
    state.busy = false;
    hideProgress();
    updateControls();
    const total = state.images.reduce((sum, entry) => sum + entry.detections.length, 0);
    els.countBadge.textContent = `検出: ${total}`;
    if (image) els.timeBadge.textContent = `${image.elapsedMs ?? '-'} ms`;
    setStatus('検出が完了しました。');
  }
}

function hideProgress() {
  els.detectProgress.style.display = 'none';
}

/* ==========================================================
   手動の矩形追加 / プレビューの操作
   ========================================================== */
function eventToImage(event) {
  const image = currentImage();
  const canvas = els.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * image.width;
  const y = ((event.clientY - rect.top) / rect.height) * image.height;
  return {
    x: Math.max(0, Math.min(image.width, x)),
    y: Math.max(0, Math.min(image.height, y)),
  };
}

function hitTest(image, point) {
  for (let i = image.detections.length - 1; i >= 0; i -= 1) {
    const { box } = image.detections[i];
    if (point.x >= box.xmin && point.x <= box.xmax && point.y >= box.ymin && point.y <= box.ymax) {
      return image.detections[i];
    }
  }
  return null;
}

let pointerStart = null;

els.previewCanvas.addEventListener('pointerdown', (event) => {
  const image = currentImage();
  if (!image) return;
  const point = eventToImage(event);
  pointerStart = { point, clientX: event.clientX, clientY: event.clientY, time: Date.now() };
  if (state.addMode) {
    els.previewCanvas.setPointerCapture(event.pointerId);
    state.drag = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
    renderPreview();
  }
});

els.previewCanvas.addEventListener('pointermove', (event) => {
  if (!state.drag) return;
  const point = eventToImage(event);
  state.drag.x1 = point.x;
  state.drag.y1 = point.y;
  renderPreview();
});

els.previewCanvas.addEventListener('pointerup', (event) => {
  const image = currentImage();
  if (!image || !pointerStart) return;

  if (state.addMode && state.drag) {
    const { x0, y0, x1, y1 } = state.drag;
    const box = {
      xmin: Math.min(x0, x1),
      ymin: Math.min(y0, y1),
      xmax: Math.max(x0, x1),
      ymax: Math.max(y0, y1),
    };
    const moved = Math.hypot(x1 - x0, y1 - y0);
    if (moved > 8) {
      const nextId = image.detections.length
        ? Math.max(...image.detections.map((det) => det.id)) + 1
        : 0;
      image.detections.push({
        id: nextId,
        score: null,
        box: {
          xmin: Math.round(box.xmin),
          ymin: Math.round(box.ymin),
          xmax: Math.round(box.xmax),
          ymax: Math.round(box.ymax),
        },
        keypoints: [],
        enabled: true,
        source: 'manual',
      });
      state.addMode = false;
      state.drag = null;
      afterDetectionChange(image);
      return;
    }
    state.drag = null;
    renderPreview();
    return;
  }

  // ただのクリック: 矩形の有効/無効を切り替える
  const moved =
    Math.hypot(event.clientX - pointerStart.clientX, event.clientY - pointerStart.clientY) < 6;
  if (moved) {
    const hit = hitTest(image, eventToImage(event));
    if (hit) {
      hit.enabled = !hit.enabled;
      afterDetectionChange(image);
    }
  }
});

els.previewCanvas.addEventListener('pointercancel', () => {
  state.drag = null;
  renderPreview();
});

/* ==========================================================
   ダウンロード
   ========================================================== */
function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadCurrent() {
  const image = currentImage();
  if (!image) return;
  try {
    const { canvas } = renderFullResult(image);
    const blob = await canvasToBlob(canvas);
    triggerDownload(blob, buildDownloadName(image.name, state.mode));
  } catch (err) {
    showError(`保存に失敗しました: ${err.message}`);
  }
}

async function downloadAll() {
  if (state.images.length === 0) return;
  const button = els.downloadAllBtn;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'ZIP を作成中…';
  try {
    const zip = new JSZip();
    const used = new Set();
    for (const image of state.images) {
      const { canvas } = renderFullResult(image);
      const blob = await canvasToBlob(canvas);
      let name = buildDownloadName(image.name, state.mode);
      if (used.has(name)) {
        name = `${sanitizeBaseName(image.name)}-${used.size + 1}-${state.mode}.png`;
      }
      used.add(name);
      zip.file(name, blob);
    }
    const archive = await zip.generateAsync({ type: 'blob' });
    triggerDownload(archive, buildZipName());
    setStatus(`${state.images.length} 枚を ZIP にまとめました。`);
  } catch (err) {
    showError(`一括保存に失敗しました: ${err.message}`);
  } finally {
    button.textContent = original;
    button.disabled = false;
    updateControls();
  }
}

/* ==========================================================
   UI 制御
   ========================================================== */
function updateControls() {
  const image = currentImage();
  const hasImages = state.images.length > 0;
  els.detectBtn.disabled = !state.modelReady || !image || state.busy;
  els.detectAllBtn.disabled = !state.modelReady || !hasImages || state.busy;
  els.addBoxBtn.disabled = !image || state.addMode || state.busy;
  els.clearDetectionsBtn.disabled = !image || image.detections.length === 0 || state.busy;
  els.downloadBtn.disabled = !image;
  els.downloadAllBtn.disabled = !hasImages;
  els.addBoxBtn.classList.toggle('active', state.addMode);
  els.countBadge.textContent = hasImages
    ? `検出: ${state.images.reduce((sum, entry) => sum + entry.detections.length, 0)}`
    : '検出: -';
}

function populateModeSelect() {
  els.modeSelect.innerHTML = '';
  for (const mode of REDACTION_MODES) {
    const option = document.createElement('option');
    option.value = mode.key;
    option.textContent = mode.label;
    els.modeSelect.appendChild(option);
  }
  els.modeSelect.value = state.mode;

  els.emojiSelect.innerHTML = '';
  for (const emoji of EMOJI_CHOICES) {
    const option = document.createElement('option');
    option.value = emoji;
    option.textContent = emoji;
    els.emojiSelect.appendChild(option);
  }
  els.emojiSelect.value = state.emoji;
}

function syncModeUi() {
  const mode = getMode(state.mode);
  els.modeNote.textContent = mode.description;
  els.emojiRow.style.display = state.mode === 'emoji' ? '' : 'none';
  els.strengthRow.style.display = state.mode === 'blur' || state.mode === 'mosaic' ? '' : 'none';
}

/* ==========================================================
   イベント登録
   ========================================================== */
els.imageDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.imageDrop.classList.add('dragover');
});
els.imageDrop.addEventListener('dragleave', () => els.imageDrop.classList.remove('dragover'));
els.imageDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  els.imageDrop.classList.remove('dragover');
  if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) addFiles(els.fileInput.files);
  els.fileInput.value = '';
});

els.modeSelect.addEventListener('change', () => {
  state.mode = els.modeSelect.value;
  syncModeUi();
  renderResult();
});
els.emojiSelect.addEventListener('change', () => {
  state.emoji = els.emojiSelect.value;
  renderResult();
});
els.marginInput.addEventListener('input', () => {
  state.margin = Number(els.marginInput.value);
  els.marginValue.textContent = `${Math.round(state.margin * 100)}%`;
  renderResult();
});
els.strengthInput.addEventListener('input', () => {
  state.strength = Number(els.strengthInput.value);
  els.strengthValue.textContent = `${Math.round(state.strength * 100)}%`;
  renderResult();
});
els.confidenceInput.addEventListener('input', () => {
  state.confidence = Number(els.confidenceInput.value);
  els.confidenceValue.textContent = `${Math.round(state.confidence * 100)}%`;
});
els.mergeInput.addEventListener('change', () => {
  state.merge = els.mergeInput.checked;
  renderResult();
});

els.detectBtn.addEventListener('click', () => {
  const image = currentImage();
  if (image) startDetection([image.id]);
});
els.detectAllBtn.addEventListener('click', () => startDetection(state.images.map((image) => image.id)));
els.addBoxBtn.addEventListener('click', () => {
  state.addMode = !state.addMode;
  setStatus(state.addMode ? 'ドラッグで矩形を追加してください。' : '準備完了。');
  updateControls();
});
els.clearDetectionsBtn.addEventListener('click', () => {
  const image = currentImage();
  if (!image) return;
  image.detections = [];
  afterDetectionChange(image);
});

els.showPreviewBtn.addEventListener('click', () => setView('preview'));
els.showResultBtn.addEventListener('click', () => setView('result'));
els.downloadBtn.addEventListener('click', downloadCurrent);
els.downloadAllBtn.addEventListener('click', downloadAll);

els.infoBtn.addEventListener('click', () => {
  els.infoModal.style.display = 'flex';
});
els.closeInfoBtn.addEventListener('click', () => {
  els.infoModal.style.display = 'none';
});
els.infoModal.addEventListener('click', (event) => {
  if (event.target === els.infoModal) els.infoModal.style.display = 'none';
});
els.clearCacheBtn.addEventListener('click', () => {
  worker.postMessage({ type: 'clear-cache' });
});

/* ==========================================================
   初期化
   ========================================================== */
function init() {
  initConsent();
  populateModeSelect();
  syncModeUi();
  els.marginValue.textContent = `${Math.round(state.margin * 100)}%`;
  els.strengthValue.textContent = `${Math.round(state.strength * 100)}%`;
  els.confidenceValue.textContent = `${Math.round(state.confidence * 100)}%`;
  setView('preview');
  updateControls();
  // 同意画面の裏で読み込みを始めない (データ通信はユーザーの明示操作後)。
}

init();
