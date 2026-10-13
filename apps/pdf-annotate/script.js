/**
 * PDF 注釈スタジオ — アプリ本体
 *
 * pdf.js でページを描画し、上に重ねた overlay canvas で注釈を扱う。
 * 注釈は「回転前ページの正規化座標 (x右, y上, 0..1)」で保持し、
 * 書き出し時に pdf-lib で座標変換する。純ロジックは pipeline.mjs。
 */

import {
  A4,
  screenToPageNorm,
  pageNormToScreen,
  normRect,
  rectToPdfPoints,
  hexToRgb,
  createAnnotation,
  annotationBounds,
  annotationsForPage,
  topAnnotationAt,
  moveAnnotation,
  summarizeAnnotations,
  createPageModel,
  activePages,
  pageCount,
  findPage,
  rotatePage,
  deletePage,
  restorePage,
  movePage,
  insertBlankPage,
  pruneAnnotations,
  normalizeRotation,
  clamp,
  clamp01,
  serializeAnnotations,
  parseAnnotations,
  buildExportName,
  buildAnnotationsName,
  uniqueFileName,
  sanitizeBaseName,
  formatBytes,
  isSupportedPdfFile,
} from './pipeline.mjs';

/* ============================================================
   設定
   ============================================================ */

const PDFJS_VERSION = '3.11.174';
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
const DEFAULT_SCALE = 1.2;
const DRAG_THRESHOLD = 0.004;

const TOOL_HINTS = {
  select: '注釈をクリックして選択、ドラッグで移動できます。Delete で削除。',
  highlight: 'ドラッグで矩形ハイライト。',
  underline: 'ドラッグした範囲に下線を引きます。',
  strikeout: 'ドラッグした範囲に取り消し線を引きます。',
  texthighlight: '本文の文字を選択するとハイライトになります (文字選択を有効化)。',
  rect: 'ドラッグで矩形を描きます。',
  ellipse: 'ドラッグで楕円を描きます。',
  ink: 'ドラッグで手書きします。',
  text: 'クリックした位置にテキストを置きます。',
  note: 'クリックした位置に付箋を置きます。',
  signature: 'クリックした位置に署名を配置します (未作成なら署名パッドが開きます)。',
  eraser: 'クリックした注釈を消します。',
};

/* ============================================================
   DOM ヘルパー
   ============================================================ */

const $ = (id) => document.getElementById(id);
const dpr = () => window.devicePixelRatio || 1;

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const downloadedNames = new Set();

/* ============================================================
   状態
   ============================================================ */

const state = {
  pdf: null,
  sourceBytes: null,
  fileName: 'document.pdf',
  fileSize: 0,
  numPages: 0,
  pageModel: [],
  annotations: [],
  currentPageId: null,
  pageSelection: new Set(),
  scale: DEFAULT_SCALE,
  tool: 'select',
  color: '#facc15',
  selectedId: null,
  draft: null,
  dragging: null,
  signature: null,
  signaturePos: null,
  pendingText: null,
  viewportInfo: null,
  renderToken: 0,
  history: [],
};

function currentPageEntry() {
  return findPage(state.pageModel, state.currentPageId);
}

function displayRotationFor(entry) {
  if (!entry) return 0;
  const base = entry.blank ? 0 : (entry._baseRotation || 0);
  return normalizeRotation(base + entry.rotation);
}

/* ============================================================
   履歴
   ============================================================ */

function pushHistory() {
  state.history.push(JSON.stringify(state.annotations));
  if (state.history.length > 60) state.history.shift();
}

function undo() {
  const prev = state.history.pop();
  if (!prev) {
    toast('戻せる操作がありません');
    return;
  }
  state.annotations = JSON.parse(prev);
  state.selectedId = null;
  redrawOverlay();
  renderRail();
  updateExportSummary();
}

/* ============================================================
   ファイル読み込み
   ============================================================ */

async function handleFile(file) {
  if (!isSupportedPdfFile(file.name, file.size)) {
    toast('PDF ファイルを選択してください');
    return;
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    state.sourceBytes = buf;
    state.fileName = file.name;
    state.fileSize = file.size;
    const doc = await window.pdfjsLib.getDocument({ data: buf.slice() }).promise;
    if (doc.numPages < 1) throw new Error('ページがありません');
    state.pdf = doc;
    state.numPages = doc.numPages;
    state.pageModel = createPageModel(doc.numPages);
    state.annotations = [];
    state.history = [];
    state.pageSelection = new Set();
    state.selectedId = null;
    state.currentPageId = state.pageModel[0].id;
    state.scale = DEFAULT_SCALE;

    await cacheBaseRotations();
    const embedded = await tryLoadEmbeddedAnnotations(doc);
    showWorkspace();
    renderRail();
    await render();
    if (embedded) toast('PDF に埋め込まれた注釈を読み込みました');
    else toast(`${doc.numPages} ページを読み込みました`);
  } catch (error) {
    console.error(error);
    toast(`読み込みに失敗しました: ${error.message}`);
  }
}

/** pdf.js から各ページの元の /Rotate を取得して保持する。 */
async function cacheBaseRotations() {
  for (const entry of state.pageModel) {
    try {
      const page = await state.pdf.getPage(entry.sourceIndex + 1);
      entry._baseRotation = normalizeRotation(page.rotate || 0);
    } catch {
      entry._baseRotation = 0;
    }
  }
}

async function tryLoadEmbeddedAnnotations(doc) {
  try {
    const attachments = await doc.getAttachments();
    if (!attachments || !attachments['annotations.json']) return false;
    const info = attachments['annotations.json'];
    const raw = await doc.getAttachmentContent(info.id || 'annotations.json');
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = parseAnnotations(text);
    if (!parsed.annotations.length) return false;
    state.annotations = parsed.annotations.filter((a) => findPage(state.pageModel, a.pageId));
    return state.annotations.length > 0;
  } catch {
    return false;
  }
}

function showWorkspace() {
  $('intro').hidden = true;
  $('workspace').hidden = false;
  $('file-name').textContent = state.fileName;
  $('file-meta').textContent = `${formatBytes(state.fileSize)} / ${state.numPages} ページ`;
}

function closeFile() {
  state.pdf = null;
  state.sourceBytes = null;
  state.pageModel = [];
  state.annotations = [];
  state.history = [];
  state.selectedId = null;
  state.currentPageId = null;
  state.viewportInfo = null;
  $('intro').hidden = false;
  $('workspace').hidden = true;
  $('file-input').value = '';
}

/* ============================================================
   描画
   ============================================================ */

async function render() {
  const entry = currentPageEntry();
  if (!entry) return;
  const token = ++state.renderToken;
  const pdfCanvas = $('pdf-canvas');
  const overlay = $('overlay-canvas');
  const textLayer = $('text-layer');
  textLayer.innerHTML = '';
  textLayer.style.width = '0px';
  textLayer.style.height = '0px';

  let width;
  let height;
  let rotation;

  if (entry.blank) {
    rotation = displayRotationFor(entry);
    const size = entry.blankSize || A4;
    const swap = rotation === 90 || rotation === 270;
    width = (swap ? size.height : size.width) * state.scale;
    height = (swap ? size.width : size.height) * state.scale;
    pdfCanvas.width = Math.max(1, Math.floor(width * dpr()));
    pdfCanvas.height = Math.max(1, Math.floor(height * dpr()));
    pdfCanvas.style.width = `${width}px`;
    pdfCanvas.style.height = `${height}px`;
    const ctx = pdfCanvas.getContext('2d');
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  } else {
    const page = await state.pdf.getPage(entry.sourceIndex + 1);
    if (token !== state.renderToken) return;
    rotation = normalizeRotation((page.rotate || 0) + entry.rotation);
    const viewport = page.getViewport({ scale: state.scale, rotation });
    width = viewport.width;
    height = viewport.height;
    pdfCanvas.width = Math.max(1, Math.floor(width * dpr()));
    pdfCanvas.height = Math.max(1, Math.floor(height * dpr()));
    pdfCanvas.style.width = `${width}px`;
    pdfCanvas.style.height = `${height}px`;
    const ctx = pdfCanvas.getContext('2d');
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (token !== state.renderToken) return;
    if ($('text-layer-toggle').checked) {
      await renderTextLayer(page, viewport, textLayer, width, height);
    }
  }

  overlay.width = pdfCanvas.width;
  overlay.height = pdfCanvas.height;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;

  state.viewportInfo = { width, height, rotation };
  applyToolPointerMode();
  redrawOverlay();
  updateStageIndicators();
}

async function renderTextLayer(page, viewport, container, width, height) {
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  try {
    const textContent = await page.getTextContent();
    const task = window.pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      textContent,
      container,
      viewport,
      textDivs: [],
    });
    await task.promise;
  } catch (error) {
    container.innerHTML = '';
  }
}

/* ============================================================
   オーバーレイ描画
   ============================================================ */

function annToDisplayRect(rect, info) {
  const a = pageNormToScreen(rect.x, rect.y, info.rotation);
  const b = pageNormToScreen(rect.x + rect.w, rect.y + rect.h, info.rotation);
  const x1 = a.u * info.width;
  const y1 = a.v * info.height;
  const x2 = b.u * info.width;
  const y2 = b.v * info.height;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function pointToDisplay(p, info) {
  const s = pageNormToScreen(p.x, p.y, info.rotation);
  return { x: s.u * info.width, y: s.v * info.height };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

function redrawOverlay() {
  const overlay = $('overlay-canvas');
  const info = state.viewportInfo;
  if (!overlay || !info) return;
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, info.width, info.height);
  const list = state.draft
    ? [...annotationsForPage(state.annotations, state.currentPageId), state.draft]
    : annotationsForPage(state.annotations, state.currentPageId);
  for (const ann of list) drawAnnotation(ctx, ann, info);
  const selected = list.find((a) => a.id === state.selectedId);
  if (selected) drawSelection(ctx, selected, info);
}

function drawAnnotation(ctx, ann, info) {
  if (ann.type === 'ink') {
    ctx.strokeStyle = rgba(ann.color, ann.opacity ?? 1);
    ctx.lineWidth = Math.max(1, (ann.strokeWidth || 0.004) * info.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of ann.strokes || []) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      stroke.forEach((p, i) => {
        const d = pointToDisplay(p, info);
        if (i === 0) ctx.moveTo(d.x, d.y);
        else ctx.lineTo(d.x, d.y);
      });
      ctx.stroke();
    }
    return;
  }
  if (ann.type === 'underline' || ann.type === 'strikeout') {
    const a = pointToDisplay({ x: ann.line.x1, y: ann.line.y1 }, info);
    const b = pointToDisplay({ x: ann.line.x2, y: ann.line.y2 }, info);
    ctx.strokeStyle = rgba(ann.color, ann.opacity ?? 1);
    ctx.lineWidth = Math.max(1, (ann.strokeWidth || 0.003) * info.width);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    return;
  }

  const r = annToDisplayRect(annotationBounds(ann), info);
  switch (ann.type) {
    case 'highlight':
      ctx.fillStyle = rgba(ann.color, ann.opacity ?? 0.35);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      break;
    case 'rect':
      ctx.strokeStyle = rgba(ann.color, 1);
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    case 'ellipse':
      ctx.strokeStyle = rgba(ann.color, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'note':
      ctx.fillStyle = rgba('#fde68a', 0.95);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = rgba('#f59e0b', 1);
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      drawWrappedText(ctx, ann.text, r, ann.color, true);
      break;
    case 'text':
      drawWrappedText(ctx, ann.text, r, ann.color, false);
      break;
    case 'signature':
      drawSignaturePreview(ctx, ann, r);
      break;
    default:
      break;
  }
}

function drawWrappedText(ctx, text, rect, color, framed) {
  const fontSize = Math.max(9, Math.min(rect.h * 0.6, 18));
  ctx.fillStyle = rgba(color, 1);
  ctx.font = `${fontSize}px 'Noto Sans JP', 'DM Sans', system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const lines = wrapLines(ctx, text || '', rect.w - 6);
  lines.forEach((line, i) => {
    const y = rect.y + 3 + i * fontSize * 1.25;
    if (y + fontSize <= rect.y + rect.h + fontSize) ctx.fillText(line, rect.x + 3, y);
  });
  if (!framed) {
    ctx.strokeStyle = rgba(color, 0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = '';
    for (const ch of raw) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out.slice(0, 20);
}

const signatureImageCache = new Map();
function drawSignaturePreview(ctx, ann, rect) {
  if (!ann.dataUrl) return;
  let img = signatureImageCache.get(ann.dataUrl);
  if (!img) {
    img = new Image();
    img.onload = () => redrawOverlay();
    img.src = ann.dataUrl;
    signatureImageCache.set(ann.dataUrl, img);
  }
  ctx.strokeStyle = rgba('#7c3aed', 0.35);
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([]);
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  }
}

function drawSelection(ctx, ann, info) {
  const r = annToDisplayRect(annotationBounds(ann), info);
  const pad = 4;
  ctx.strokeStyle = rgba('#7c3aed', 0.9);
  ctx.setLineDash([5, 3]);
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  ctx.setLineDash([]);
}

function updateStageIndicators() {
  const pages = activePages(state.pageModel);
  const index = pages.findIndex((p) => p.id === state.currentPageId);
  $('page-indicator').textContent = `${index + 1} / ${pages.length}`;
  $('zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
}

/* ============================================================
   ポインタ操作
   ============================================================ */

function eventToPageNorm(event) {
  const overlay = $('overlay-canvas');
  const rect = overlay.getBoundingClientRect();
  if (!rect.width || !rect.height || !state.viewportInfo) return null;
  const u = clamp01((event.clientX - rect.left) / rect.width);
  const v = clamp01((event.clientY - rect.top) / rect.height);
  return screenToPageNorm(u, v, state.viewportInfo.rotation);
}

function onOverlayPointerDown(event) {
  const info = state.viewportInfo;
  const entry = currentPageEntry();
  if (!info || !entry) return;
  const pt = eventToPageNorm(event);
  if (!pt) return;
  event.preventDefault();
  $('overlay-canvas').setPointerCapture?.(event.pointerId);

  if (state.tool === 'select') {
    const hit = topAnnotationAt(annotationsForPage(state.annotations, state.currentPageId), pt, 0.012);
    state.selectedId = hit ? hit.id : null;
    if (hit) {
      pushHistory();
      state.dragging = { id: hit.id, start: pt, original: hit };
    }
    redrawOverlay();
    return;
  }

  if (state.tool === 'eraser') {
    const hit = topAnnotationAt(annotationsForPage(state.annotations, state.currentPageId), pt, 0.012);
    if (hit) {
      pushHistory();
      state.annotations = state.annotations.filter((a) => a.id !== hit.id);
      state.selectedId = null;
      redrawOverlay();
      renderRail();
      updateExportSummary();
    }
    return;
  }

  if (state.tool === 'text' || state.tool === 'note') {
    state.pendingText = { pageId: state.currentPageId, pt };
    openTextModal(state.tool);
    return;
  }

  if (state.tool === 'signature') {
    if (!state.signature) {
      state.signaturePos = pt;
      openSignatureModal();
    } else {
      placeSignature(pt);
    }
    return;
  }

  if (state.tool === 'ink') {
    state.draft = createAnnotation('ink', state.currentPageId, {
      color: state.color,
      strokes: [[pt]],
    });
    redrawOverlay();
    return;
  }

  // 矩形系ツール
  const type = state.tool === 'underline' || state.tool === 'strikeout'
    ? state.tool
    : (['highlight', 'rect', 'ellipse'].includes(state.tool) ? state.tool : null);
  if (!type) return;
  state.draft = { type, pageId: state.currentPageId, color: state.color, start: pt, current: pt };
  redrawOverlay();
}

function onOverlayPointerMove(event) {
  const entry = currentPageEntry();
  if (!entry) return;
  const pt = eventToPageNorm(event);
  if (!pt) return;

  if (state.dragging) {
    const dx = pt.x - state.dragging.start.x;
    const dy = pt.y - state.dragging.start.y;
    const moved = moveAnnotation(state.dragging.original, dx, dy, { x: 0, y: 0, w: 1, h: 1 });
    state.annotations = state.annotations.map((a) => (a.id === moved.id ? moved : a));
    redrawOverlay();
    return;
  }

  if (!state.draft) return;
  if (state.draft.type === 'ink') {
    const stroke = state.draft.strokes[0];
    stroke.push(pt);
    redrawOverlay();
    return;
  }
  state.draft.current = pt;
  updateDraftShape();
  redrawOverlay();
}

function updateDraftShape() {
  const d = state.draft;
  if (!d || d.type === 'ink') return;
  const rect = normRect(d.start.x, d.start.y, d.current.x, d.current.y);
  if (d.type === 'underline' || d.type === 'strikeout') {
    const y = d.type === 'strikeout' ? rect.y + rect.h / 2 : rect.y;
    d.line = { x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y };
    d.rect = rect;
  } else {
    d.rect = rect;
  }
}

function onOverlayPointerUp() {
  if (state.dragging) {
    state.dragging = null;
    renderRail();
    updateExportSummary();
    return;
  }
  const d = state.draft;
  if (!d) return;
  state.draft = null;
  const entry = currentPageEntry();
  if (!entry) return;

  if (d.type === 'ink') {
    const stroke = (d.strokes[0] || []);
    if (stroke.length < 2) {
      redrawOverlay();
      return;
    }
    pushHistory();
    state.annotations.push(createAnnotation('ink', state.currentPageId, {
      color: d.color,
      strokes: d.strokes,
    }));
    redrawOverlay();
    renderRail();
    updateExportSummary();
    return;
  }

  const rect = d.rect || { x: 0, y: 0, w: 0, h: 0 };
  const tooSmall = rect.w < DRAG_THRESHOLD && rect.h < DRAG_THRESHOLD;
  if (tooSmall) {
    redrawOverlay();
    return;
  }
  pushHistory();
  if (d.type === 'underline' || d.type === 'strikeout') {
    state.annotations.push(createAnnotation(d.type, state.currentPageId, {
      color: d.color,
      line: d.line,
      opacity: 1,
    }));
  } else {
    const opacity = d.type === 'highlight' ? 0.35 : 1;
    state.annotations.push(createAnnotation(d.type, state.currentPageId, {
      color: d.color,
      rect,
      opacity,
    }));
  }
  redrawOverlay();
  renderRail();
  updateExportSummary();
}

/* ============================================================
   テキスト / 署名
   ============================================================ */

function openTextModal(mode) {
  $('text-title').textContent = mode === 'note' ? '付箋' : 'テキスト';
  $('text-input').value = '';
  $('text-modal').hidden = false;
  $('text-input').focus();
}

function applyText() {
  const text = $('text-input').value.trim();
  $('text-modal').hidden = true;
  const pending = state.pendingText;
  state.pendingText = null;
  if (!pending || !text) return;
  const isNote = state.tool === 'note';
  const w = isNote ? 0.22 : 0.32;
  const h = isNote ? 0.09 : 0.05;
  const rect = {
    x: clamp(pending.pt.x, 0, 1 - w),
    y: clamp(pending.pt.y, 0, 1 - h),
    w,
    h,
  };
  pushHistory();
  state.annotations.push(createAnnotation(isNote ? 'note' : 'text', pending.pageId, {
    rect,
    text,
    color: state.color,
    opacity: 1,
  }));
  redrawOverlay();
  renderRail();
  updateExportSummary();
}

/* --- 署名パッド --- */
const padState = { drawing: false, strokes: [], current: null };

function openSignatureModal() {
  $('signature-modal').hidden = false;
  clearSignaturePad();
  setTimeout(clearSignaturePad, 0);
}

function clearSignaturePad() {
  const canvas = $('signature-pad');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  padState.strokes = [];
  padState.current = null;
}

function padPoint(event) {
  const canvas = $('signature-pad');
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function onPadDown(event) {
  event.preventDefault();
  padState.drawing = true;
  padState.current = [padPoint(event)];
  padState.strokes.push(padState.current);
  drawPad();
}

function onPadMove(event) {
  if (!padState.drawing) return;
  event.preventDefault();
  padState.current.push(padPoint(event));
  drawPad();
}

function onPadUp() {
  padState.drawing = false;
  padState.current = null;
}

function drawPad() {
  const canvas = $('signature-pad');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of padState.strokes) {
    if (stroke.length < 2) continue;
    ctx.beginPath();
    stroke.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }
}

function applySignature() {
  const hasInk = padState.strokes.some((s) => s.length > 1);
  if (!hasInk) {
    toast('署名を描いてください');
    return;
  }
  const canvas = $('signature-pad');
  state.signature = { dataUrl: canvas.toDataURL('image/png') };
  $('signature-modal').hidden = true;
  const pos = state.signaturePos || { x: 0.35, y: 0.12 };
  state.signaturePos = null;
  placeSignature(pos);
}

function placeSignature(pt) {
  if (!state.signature) return;
  const w = 0.28;
  const h = 0.1;
  const rect = { x: clamp(pt.x - w / 2, 0, 1 - w), y: clamp(pt.y - h / 2, 0, 1 - h), w, h };
  pushHistory();
  state.annotations.push(createAnnotation('signature', state.currentPageId, {
    rect,
    dataUrl: state.signature.dataUrl,
    color: state.color,
  }));
  redrawOverlay();
  renderRail();
  updateExportSummary();
  toast('署名を配置しました。選択ツールで移動できます');
}

/* ============================================================
   文字選択ハイライト
   ============================================================ */

function onSelectionMouseUp() {
  if (state.tool !== 'texthighlight' || !state.viewportInfo) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const shell = $('page-shell');
  const shellRect = shell.getBoundingClientRect();
  if (!shellRect.width || !shellRect.height) return;
  const range = selection.getRangeAt(0);
  const created = [];
  for (const r of range.getClientRects()) {
    if (r.width < 2 || r.height < 2) continue;
    const a = screenToPageNorm(
      clamp01((r.left - shellRect.left) / shellRect.width),
      clamp01((r.top - shellRect.top) / shellRect.height),
      state.viewportInfo.rotation,
    );
    const b = screenToPageNorm(
      clamp01((r.right - shellRect.left) / shellRect.width),
      clamp01((r.bottom - shellRect.top) / shellRect.height),
      state.viewportInfo.rotation,
    );
    const rect = normRect(a.nx, a.ny, b.nx, b.ny);
    if (rect.w > 0.002 && rect.h > 0.002) {
      created.push(createAnnotation('highlight', state.currentPageId, {
        rect,
        color: state.color,
        opacity: 0.35,
      }));
    }
  }
  selection.removeAllRanges();
  if (!created.length) return;
  pushHistory();
  state.annotations.push(...created);
  redrawOverlay();
  renderRail();
  updateExportSummary();
  toast(`${created.length} 行をハイライトしました`);
}

/* ============================================================
   ページ一覧
   ============================================================ */

function renderRail() {
  const list = $('page-thumb-list');
  if (!list) return;
  const pages = activePages(state.pageModel);
  list.innerHTML = '';
  pages.forEach((entry, index) => {
    const card = document.createElement('div');
    card.className = 'page-thumb';
    if (entry.id === state.currentPageId) card.classList.add('active');
    if (entry.deleted) card.classList.add('deleted');

    const label = entry.blank ? '白紙' : `p.${entry.sourceIndex + 1}`;
    const selected = state.pageSelection.has(entry.id);
    card.innerHTML = `
      <div class="page-thumb-top">
        <span class="page-thumb-num">${selected ? '☑ ' : ''}${index + 1}</span>
        <span class="page-thumb-badge">${label}${entry.rotation ? ` · ${entry.rotation}°` : ''}</span>
      </div>
      <div class="page-thumb-actions">
        <button class="thumb-btn" data-act="up" title="前へ" type="button">↑</button>
        <button class="thumb-btn" data-act="down" title="次へ" type="button">↓</button>
        <button class="thumb-btn" data-act="rotate" title="90°回転" type="button">⟳</button>
        <button class="thumb-btn" data-act="blank" title="下に白紙挿入" type="button">＋</button>
        <button class="thumb-btn danger" data-act="delete" title="削除" type="button">✕</button>
      </div>`;

    card.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (btn) {
        event.stopPropagation();
        handlePageAction(entry.id, btn.dataset.act);
        return;
      }
      if (state.currentPageId !== entry.id) {
        state.currentPageId = entry.id;
        renderRail();
        render();
      }
    });
    list.appendChild(card);
  });

  const removed = state.pageModel.filter((p) => p.deleted);
  for (const entry of removed) {
    const card = document.createElement('div');
    card.className = 'page-thumb deleted';
    card.innerHTML = `<div class="page-thumb-top"><span class="page-thumb-num">削除済み</span>
      <button class="thumb-btn" data-act="restore" title="復元" type="button">↺</button></div>`;
    card.addEventListener('click', (event) => {
      if (event.target.closest('button[data-act="restore"]')) handlePageAction(entry.id, 'restore');
    });
    list.appendChild(card);
  }
}

async function handlePageAction(id, action) {
  const pages = activePages(state.pageModel);
  const index = pages.findIndex((p) => p.id === id);
  switch (action) {
    case 'up':
      state.pageModel = movePage(state.pageModel, id, -1);
      break;
    case 'down':
      state.pageModel = movePage(state.pageModel, id, 1);
      break;
    case 'rotate':
      state.pageModel = rotatePage(state.pageModel, id, 90);
      break;
    case 'blank':
      state.pageModel = insertBlankPage(state.pageModel, currentArrayIndex(id) + 1);
      break;
    case 'delete':
      if (pageCount(state.pageModel) <= 1) {
        toast('最後の 1 ページは削除できません');
        return;
      }
      state.pageModel = deletePage(state.pageModel, id);
      state.annotations = pruneAnnotations(state.annotations, state.pageModel);
      if (state.currentPageId === id) {
        state.currentPageId = activePages(state.pageModel)[0]?.id || null;
      }
      break;
    case 'restore':
      state.pageModel = restorePage(state.pageModel, id);
      break;
    default:
      break;
  }
  state.pageSelection.delete(id);
  renderRail();
  await render();
  updateExportSummary();
}

function currentArrayIndex(id) {
  const pages = activePages(state.pageModel);
  const activeIdx = pages.findIndex((p) => p.id === id);
  const target = pages[activeIdx];
  return state.pageModel.indexOf(target);
}

/* ============================================================
   書き出し
   ============================================================ */

function updateExportSummary() {
  const el = $('export-summary');
  if (!el) return;
  const active = pageCount(state.pageModel);
  const { total, byType } = summarizeAnnotations(state.annotations);
  const parts = Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' / ');
  el.textContent = `全 ${active} ページ（書き出し対象） / 注釈 ${total} 件${parts ? `（${parts}）` : ''}`;
}

function selectedPageIdsOrNull() {
  return state.pageSelection.size ? new Set(state.pageSelection) : null;
}

async function exportAnnotationsJson() {
  if (!state.sourceBytes) return;
  const json = serializeAnnotations(state.annotations, { source: state.fileName, savedAt: new Date().toISOString() });
  const name = uniqueFileName(downloadedNames, buildAnnotationsName(state.fileName));
  downloadedNames.add(name);
  downloadBlob(new Blob([json], { type: 'application/json' }), name);
  toast('注釈データを書き出しました');
}

async function exportPdf(flatten) {
  if (!state.sourceBytes) return;
  const { PDFDocument, degrees } = window.PDFLib;
  const pageFilter = selectedPageIdsOrNull();
  const pages = activePages(state.pageModel).filter((p) => !pageFilter || pageFilter.has(p.id));
  if (!pages.length) {
    toast('書き出すページがありません');
    return;
  }
  toast(flatten ? '注釈を焼き込んでいます…' : '注釈データ付き PDF を作成しています…');

  try {
    const srcDoc = await PDFDocument.load(state.sourceBytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();

    for (const entry of pages) {
      let outPage;
      let baseRotation = 0;
      let widthPt;
      let heightPt;
      if (entry.blank) {
        const size = entry.blankSize || A4;
        outPage = out.addPage([size.width, size.height]);
        widthPt = size.width;
        heightPt = size.height;
      } else {
        const [copied] = await out.copyPages(srcDoc, [entry.sourceIndex]);
        outPage = out.addPage(copied);
        const media = outPage.getMediaBox();
        widthPt = media.width;
        heightPt = media.height;
        baseRotation = normalizeRotation(outPage.getRotation().angle);
      }
      const totalRotation = normalizeRotation(baseRotation + entry.rotation);
      outPage.setRotation(degrees(totalRotation));

      if (flatten) {
        for (const ann of annotationsForPage(state.annotations, entry.id)) {
          // eslint-disable-next-line no-await-in-loop
          await drawAnnotationToPdf(out, outPage, ann, widthPt, heightPt, totalRotation);
        }
      }
    }

    if (!flatten) {
      const json = serializeAnnotations(state.annotations, { source: state.fileName, savedAt: new Date().toISOString() });
      await out.attach(new TextEncoder().encode(json), 'annotations.json', {
        mimeType: 'application/json',
        description: 'pdf-annotate annotations',
      });
    }

    const bytes = await out.save();
    const name = uniqueFileName(downloadedNames, buildExportName(state.fileName, flatten ? 'flat' : 'layer'));
    downloadedNames.add(name);
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    toast(`${name} を書き出しました`);
  } catch (error) {
    console.error(error);
    toast(`書き出しに失敗しました: ${error.message}`);
  }
}

/** 指定ページだけを抽出して書き出す。 */
async function exportExtract() {
  if (!state.sourceBytes) return;
  if (!state.pageSelection.size) {
    toast('抽出するページをページ一覧で選んでください');
    return;
  }
  const pageFilter = new Set(state.pageSelection);
  const pages = activePages(state.pageModel).filter((p) => pageFilter.has(p.id));
  if (!pages.length) return;
  const { PDFDocument, degrees } = window.PDFLib;
  try {
    const srcDoc = await PDFDocument.load(state.sourceBytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    for (const entry of pages) {
      let outPage;
      if (entry.blank) {
        const size = entry.blankSize || A4;
        outPage = out.addPage([size.width, size.height]);
      } else {
        const [copied] = await out.copyPages(srcDoc, [entry.sourceIndex]);
        outPage = out.addPage(copied);
      }
      const base = entry.blank ? 0 : normalizeRotation(outPage.getRotation().angle);
      outPage.setRotation(degrees(normalizeRotation(base + entry.rotation)));
    }
    const bytes = await out.save();
    const base = sanitizeBaseName(state.fileName, 'document');
    const name = uniqueFileName(downloadedNames, `${base}-extract.pdf`);
    downloadedNames.add(name);
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    toast(`${pages.length} ページを抽出して書き出しました`);
  } catch (error) {
    console.error(error);
    toast(`抽出に失敗しました: ${error.message}`);
  }
}

/* --- PDF へ注釈を描く --- */

async function drawAnnotationToPdf(doc, page, ann, W, H, displayRotation) {
  const { rgb, degrees, LineCapStyle } = window.PDFLib;
  const { r, g, b } = hexToRgb(ann.color);
  const color = rgb(r, g, b);

  if (ann.type === 'highlight') {
    const rect = rectToPdfPoints(annotationBounds(ann), W, H);
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color, opacity: ann.opacity ?? 0.35 });
    return;
  }
  if (ann.type === 'rect') {
    const rect = rectToPdfPoints(annotationBounds(ann), W, H);
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, borderColor: color, borderWidth: 2 });
    return;
  }
  if (ann.type === 'ellipse') {
    const rect = rectToPdfPoints(annotationBounds(ann), W, H);
    page.drawEllipse({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      xScale: rect.width / 2,
      yScale: rect.height / 2,
      borderColor: color,
      borderWidth: 2,
    });
    return;
  }
  if (ann.type === 'underline' || ann.type === 'strikeout') {
    page.drawLine({
      start: { x: ann.line.x1 * W, y: ann.line.y1 * H },
      end: { x: ann.line.x2 * W, y: ann.line.y2 * H },
      thickness: 2,
      color,
      lineCap: LineCapStyle.Round,
    });
    return;
  }
  if (ann.type === 'ink') {
    for (const stroke of ann.strokes || []) {
      for (let i = 1; i < stroke.length; i += 1) {
        page.drawLine({
          start: { x: stroke[i - 1].x * W, y: stroke[i - 1].y * H },
          end: { x: stroke[i].x * W, y: stroke[i].y * H },
          thickness: Math.max(1, (ann.strokeWidth || 0.004) * W),
          color,
          lineCap: LineCapStyle.Round,
        });
      }
    }
    return;
  }
  if (ann.type === 'signature') {
    if (!ann.dataUrl) return;
    const png = await doc.embedPng(ann.dataUrl);
    drawImageInRect(page, png, rectToPdfPoints(annotationBounds(ann), W, H), displayRotation);
    return;
  }
  if (ann.type === 'text' || ann.type === 'note') {
    const raster = rasterizeAnnotationText(ann);
    if (!raster) return;
    const png = await doc.embedPng(raster.dataUrl);
    drawImageInRect(page, png, rectToPdfPoints(annotationBounds(ann), W, H), displayRotation);
  }
}

/** 画像を矩形に収め、ページ回転後も正立するよう逆回転して描く。 */
function drawImageInRect(page, image, rect, rotation) {
  const { degrees } = window.PDFLib;
  const a = normalizeRotation(rotation);
  if (a === 0) {
    page.drawImage(image, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    return;
  }
  const swap = a === 90 || a === 270;
  const W0 = swap ? rect.height : rect.width;
  const H0 = swap ? rect.width : rect.height;
  const rad = (a * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [[0, 0], [W0, 0], [0, H0], [W0, H0]]
    .map(([lx, ly]) => [lx * cos - ly * sin, lx * sin + ly * cos]);
  const minX = Math.min(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  page.drawImage(image, {
    x: rect.x - minX,
    y: rect.y - minY,
    width: W0,
    height: H0,
    rotate: degrees(a),
  });
}

function rasterizeAnnotationText(ann) {
  const bounds = annotationBounds(ann);
  if (bounds.w <= 0 || bounds.h <= 0) return null;
  const pxPerUnit = 1200;
  const canvasW = Math.max(80, Math.round(bounds.w * pxPerUnit));
  const canvasH = Math.max(40, Math.round(bounds.h * pxPerUnit));
  const fontSize = Math.max(14, canvasH * 0.5);
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  const fontFamily = "'Noto Sans JP', 'DM Sans', system-ui, sans-serif";
  ctx.font = `${fontSize}px ${fontFamily}`;
  if (ann.type === 'note') {
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(0, 0, canvasW, canvasH);
  }
  ctx.fillStyle = ann.color || '#1e293b';
  ctx.textBaseline = 'top';
  const lines = wrapLines(ctx, ann.text || '', canvasW - 16);
  const lineHeight = fontSize * 1.25;
  lines.forEach((line, i) => ctx.fillText(line, 8, 6 + i * lineHeight));
  return { dataUrl: canvas.toDataURL('image/png') };
}

/* ============================================================
   ツール / UI イベント
   ============================================================ */

function setTool(tool) {
  state.tool = tool;
  state.draft = null;
  document.querySelectorAll('.tool').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  const hint = $('stage-hint');
  if (hint) hint.textContent = TOOL_HINTS[tool] || '';
  applyToolPointerMode();
  redrawOverlay();
}

function applyToolPointerMode() {
  const overlay = $('overlay-canvas');
  const textLayer = $('text-layer');
  const selecting = state.tool === 'texthighlight';
  if (overlay) overlay.style.pointerEvents = selecting ? 'none' : 'auto';
  if (textLayer) {
    textLayer.style.pointerEvents = selecting ? 'auto' : 'none';
    textLayer.classList.toggle('selection-active', selecting);
  }
}

function changeScale(delta) {
  const next = clamp(state.scale + delta, MIN_SCALE, MAX_SCALE);
  if (next === state.scale) return;
  state.scale = next;
  render();
}

function stepPage(delta) {
  const pages = activePages(state.pageModel);
  const index = pages.findIndex((p) => p.id === state.currentPageId);
  const target = clamp(index + delta, 0, pages.length - 1);
  if (pages[target] && pages[target].id !== state.currentPageId) {
    state.currentPageId = pages[target].id;
    renderRail();
    render();
  }
}

function deleteSelectedAnnotation() {
  if (!state.selectedId) {
    toast('注釈が選択されていません');
    return;
  }
  pushHistory();
  state.annotations = state.annotations.filter((a) => a.id !== state.selectedId);
  state.selectedId = null;
  redrawOverlay();
  renderRail();
  updateExportSummary();
}

function loadAnnotationsFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseAnnotations(String(reader.result));
      pushHistory();
      const known = new Set(state.pageModel.map((p) => p.id));
      const kept = parsed.annotations.filter((a) => known.has(a.pageId));
      state.annotations = kept;
      redrawOverlay();
      renderRail();
      updateExportSummary();
      toast(`${kept.length} 件の注釈を読み込みました`);
    } catch (error) {
      toast(`読み込みに失敗しました: ${error.message}`);
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   初期化
   ============================================================ */

function bindDropZone(zone, input) {
  zone.addEventListener('click', (event) => {
    if (event.target.closest('#pick-btn') || event.target === zone) input.click();
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
  }));
  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

function init() {
  if (!window.pdfjsLib || !window.PDFLib) {
    toast('PDF ライブラリの読み込みに失敗しました');
    return;
  }

  bindDropZone($('drop-zone'), $('file-input'));
  $('pick-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
  });

  $('annotations-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) loadAnnotationsFromFile(file);
    event.target.value = '';
  });
  $('load-annotations-intro').addEventListener('click', () => $('annotations-input').click());
  $('open-annotations').addEventListener('click', () => $('annotations-input').click());
  $('save-annotations').addEventListener('click', exportAnnotationsJson);
  $('close-file').addEventListener('click', closeFile);

  document.querySelectorAll('.tool').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  $('color-input').addEventListener('input', (event) => {
    state.color = event.target.value;
  });
  $('undo-btn').addEventListener('click', undo);
  $('delete-annotation').addEventListener('click', deleteSelectedAnnotation);
  $('export-flat').addEventListener('click', () => exportPdf(true));
  $('export-layer').addEventListener('click', () => exportPdf(false));
  $('export-json').addEventListener('click', exportAnnotationsJson);
  $('export-extract').addEventListener('click', exportExtract);

  $('zoom-in').addEventListener('click', () => changeScale(0.15));
  $('zoom-out').addEventListener('click', () => changeScale(-0.15));
  $('prev-page').addEventListener('click', () => stepPage(-1));
  $('next-page').addEventListener('click', () => stepPage(1));
  $('text-layer-toggle').addEventListener('change', () => render());

  $('rail-select-all').addEventListener('click', () => {
    state.pageSelection = new Set(activePages(state.pageModel).map((p) => p.id));
    renderRail();
  });
  $('rail-select-none').addEventListener('click', () => {
    state.pageSelection.clear();
    renderRail();
  });

  const overlay = $('overlay-canvas');
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  overlay.addEventListener('pointermove', onOverlayPointerMove);
  overlay.addEventListener('pointerup', onOverlayPointerUp);
  overlay.addEventListener('pointercancel', onOverlayPointerUp);
  overlay.addEventListener('pointerleave', onOverlayPointerUp);
  window.addEventListener('mouseup', onSelectionMouseUp);

  $('text-apply').addEventListener('click', applyText);
  $('text-cancel').addEventListener('click', () => {
    $('text-modal').hidden = true;
    state.pendingText = null;
  });

  const pad = $('signature-pad');
  pad.addEventListener('pointerdown', onPadDown);
  pad.addEventListener('pointermove', onPadMove);
  pad.addEventListener('pointerup', onPadUp);
  pad.addEventListener('pointerleave', onPadUp);
  $('signature-clear').addEventListener('click', clearSignaturePad);
  $('signature-cancel').addEventListener('click', () => {
    $('signature-modal').hidden = true;
    state.signaturePos = null;
  });
  $('signature-apply').addEventListener('click', applySignature);

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    const map = { v: 'select', h: 'highlight', u: 'underline', s: 'strikeout', t: 'texthighlight', p: 'ink', e: 'eraser' };
    if (map[event.key.toLowerCase()]) {
      setTool(map[event.key.toLowerCase()]);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      deleteSelectedAnnotation();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    }
  });

  setTool('select');
  updateExportSummary();
}

document.addEventListener('DOMContentLoaded', init);
