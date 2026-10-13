/**
 * PDF Annotate — 純ロジック (DOM / pdf.js / pdf-lib 非依存)
 *
 * ブラウザ・Node の両方から import できる ESM。座標変換、注釈モデル、
 * ページ操作の正規化、書き出しファイル名の衝突回避だけをここに置き、
 * 描画・PDF 入出力は script.js 側で行う。`node --test` で検証する。
 */

/* ============================================================
   汎用
   ============================================================ */

export const ROTATIONS = [0, 90, 180, 270];

/** 角度を 0/90/180/270 に正規化する (負値・360 超も可)。 */
export function normalizeRotation(deg) {
  const rounded = Math.round(Number(deg) / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

/** `#rrggbb` / `#rgb` を 0..1 の RGB に変換する (pdf-lib 用)。 */
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/* ============================================================
   座標変換 (表示座標 ⇄ ページ正規化座標)
   ------------------------------------------------------------
   注釈は「回転前のページ」に対する正規化座標 (nx: 左→右 0..1,
   ny: 下→上 0..1) で保持する。表示は page.rotation の分だけ回転して
   描くため、ポインタ位置 (u: 左→右, v: 上→下, 0..1) と相互変換する。
   ============================================================ */

/** 表示座標 (u,v) → 回転前ページ正規化座標 (nx,ny)。 */
export function screenToPageNorm(u, v, rotation) {
  const r = normalizeRotation(rotation);
  switch (r) {
    case 90: return { nx: v, ny: u };
    case 180: return { nx: 1 - u, ny: v };
    case 270: return { nx: 1 - v, ny: 1 - u };
    case 0:
    default: return { nx: u, ny: 1 - v };
  }
}

/** 回転前ページ正規化座標 (nx,ny) → 表示座標 (u,v)。 */
export function pageNormToScreen(nx, ny, rotation) {
  const r = normalizeRotation(rotation);
  switch (r) {
    case 90: return { u: ny, v: nx };
    case 180: return { u: 1 - nx, v: ny };
    case 270: return { u: 1 - ny, v: 1 - nx };
    case 0:
    default: return { u: nx, v: 1 - ny };
  }
}

/** 2 点 (ページ正規化座標, y 上向き) から正の幅・高さの矩形を作る。 */
export function normRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

export function rectContains(rect, pt) {
  return pt.x >= rect.x && pt.x <= rect.x + rect.w
    && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** ページ正規化矩形 → PDF ポイント (回転前ページ基準)。 */
export function rectToPdfPoints(rect, pageWidthPt, pageHeightPt) {
  return {
    x: rect.x * pageWidthPt,
    y: rect.y * pageHeightPt,
    width: rect.w * pageWidthPt,
    height: rect.h * pageHeightPt,
  };
}

/* ============================================================
   注釈モデル
   ============================================================ */

export const ANNOTATION_TYPES = [
  'highlight', 'underline', 'strikeout',
  'rect', 'ellipse', 'ink', 'text', 'note', 'signature',
];

export const ANNOTATION_LABELS = {
  highlight: 'ハイライト',
  underline: '下線',
  strikeout: '取り消し線',
  rect: '矩形',
  ellipse: '楕円',
  ink: '手書き',
  text: 'テキスト',
  note: '付箋',
  signature: '署名',
};

export function annotationLabel(type) {
  return ANNOTATION_LABELS[type] || type;
}

export function isAnnotationType(type) {
  return ANNOTATION_TYPES.includes(type);
}

let annotationSeq = 0;

export function nextAnnotationId(prefix = 'a') {
  annotationSeq += 1;
  return `${prefix}${annotationSeq.toString(36)}`;
}

/**
 * 注釈を生成する。type ごとに既定プロパティを補う。
 * geometry はページ正規化座標の {x,y,w,h} (y 上向き)。
 */
export function createAnnotation(type, pageId, props = {}) {
  if (!isAnnotationType(type)) throw new Error(`unknown annotation type: ${type}`);
  const base = {
    id: props.id || nextAnnotationId('a'),
    type,
    pageId,
    color: props.color || '#facc15',
    opacity: props.opacity == null ? 1 : clamp01(props.opacity),
    createdAt: props.createdAt || null,
  };
  if (type === 'ink') {
    return { ...base, strokes: normalizeInkStrokes(props.strokes || []), strokeWidth: props.strokeWidth || 0.004 };
  }
  if (type === 'underline' || type === 'strikeout') {
    const line = props.line || lineFromRect(props.rect, type === 'strikeout');
    return { ...base, line: normalizeLine(line), strokeWidth: props.strokeWidth || 0.003 };
  }
  if (type === 'text' || type === 'note') {
    return { ...base, rect: normalizeRect(props.rect), text: String(props.text ?? ''), fontSize: props.fontSize || 0.03 };
  }
  if (type === 'signature') {
    return { ...base, rect: normalizeRect(props.rect), dataUrl: props.dataUrl || '' };
  }
  return { ...base, rect: normalizeRect(props.rect), strokeWidth: props.strokeWidth || 0.003 };
}

function normalizeRect(rect) {
  const r = rect || {};
  return {
    x: clamp01(r.x || 0),
    y: clamp01(r.y || 0),
    w: clamp(r.w || 0, 0, 1),
    h: clamp(r.h || 0, 0, 1),
  };
}

/** 2 点を 0..1 にクランプした線分にする。 */
export function normalizeLine(line) {
  const l = line || {};
  return {
    x1: clamp01(l.x1 || 0),
    y1: clamp01(l.y1 || 0),
    x2: clamp01(l.x2 || 0),
    y2: clamp01(l.y2 || 0),
  };
}

/** 矩形から下線/取り消し線の線分を作る (y 上向き)。 */
export function lineFromRect(rect, middle = false) {
  const r = normalizeRect(rect);
  const y = middle ? r.y + r.h / 2 : r.y;
  return { x1: r.x, y1: y, x2: r.x + r.w, y2: y };
}

/** 線分の外接矩形。 */
export function lineBounds(line) {
  const l = normalizeLine(line);
  return normRect(l.x1, l.y1, l.x2, l.y2);
}

/** ink の点列 (ページ正規化座標) を検証・クランプする。 */
export function normalizeInkStrokes(strokes) {
  return (strokes || []).map((stroke) => (stroke || [])
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })));
}

/** 近すぎる点を間引く (手書きの点数を減らす)。 */
export function simplifyStroke(points, minDistance = 0.002) {
  const out = [];
  for (const p of points || []) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) out.push(p);
  }
  return out;
}

/** 署名パッドの点列 (px, y 下向き) を正規化座標 (y 上向き) にする。 */
export function padStrokesToNorm(strokes, width, height) {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  return (strokes || []).map((stroke) => (stroke || []).map((p) => ({
    x: clamp01(p.x / w),
    y: clamp01(1 - p.y / h),
  })));
}

/** 注釈の外接矩形 (ページ正規化座標)。 */
export function annotationBounds(ann) {
  if (ann.type === 'ink') {
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    let found = false;
    for (const stroke of ann.strokes || []) {
      for (const p of stroke) {
        found = true;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!found) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (ann.type === 'underline' || ann.type === 'strikeout') return lineBounds(ann.line);
  return { ...normalizeRect(ann.rect) };
}

/** 点と線分の距離。 */
export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 注釈が点に当たるか。tolerance はページ正規化単位。 */
export function hitTestAnnotation(ann, pt, tolerance = 0.01) {
  if (ann.type === 'ink') {
    for (const stroke of ann.strokes || []) {
      for (let i = 1; i < stroke.length; i += 1) {
        if (pointSegmentDistance(pt, stroke[i - 1], stroke[i]) <= tolerance) return true;
      }
      if (stroke.length === 1 && pointSegmentDistance(pt, stroke[0], stroke[0]) <= tolerance) return true;
    }
    return false;
  }
  if (ann.type === 'underline' || ann.type === 'strikeout') {
    const l = normalizeLine(ann.line);
    return pointSegmentDistance(pt, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }) <= tolerance;
  }
  const r = annotationBounds(ann);
  return pt.x >= r.x - tolerance && pt.x <= r.x + r.w + tolerance
    && pt.y >= r.y - tolerance && pt.y <= r.y + r.h + tolerance;
}

/** 最前面 (配列の後ろ) にある当たり注釈を返す。 */
export function topAnnotationAt(annotations, pt, tolerance = 0.01) {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    if (hitTestAnnotation(annotations[i], pt, tolerance)) return annotations[i];
  }
  return null;
}

/** 平行移動した注釈を返す。bounds を与えると全体を内側に収める。 */
export function moveAnnotation(ann, dx, dy, bounds = null) {
  if (ann.type === 'ink') {
    let strokes = ann.strokes.map((s) => s.map((p) => ({ x: p.x + dx, y: p.y + dy })));
    if (bounds) strokes = strokes.map((s) => s.map((p) => ({
      x: clamp(p.x, bounds.x, bounds.x + bounds.w),
      y: clamp(p.y, bounds.y, bounds.y + bounds.h),
    })));
    return { ...ann, strokes };
  }
  if (ann.type === 'underline' || ann.type === 'strikeout') {
    const l = normalizeLine(ann.line);
    const lo = bounds ? { x: bounds.x, y: bounds.y } : { x: 0, y: 0 };
    const hi = bounds ? { x: bounds.x + bounds.w, y: bounds.y + bounds.h } : { x: 1, y: 1 };
    return { ...ann, line: {
      x1: clamp(l.x1 + dx, lo.x, hi.x), y1: clamp(l.y1 + dy, lo.y, hi.y),
      x2: clamp(l.x2 + dx, lo.x, hi.x), y2: clamp(l.y2 + dy, lo.y, hi.y),
    } };
  }
  let { x, y, w, h } = normalizeRect(ann.rect);
  x += dx;
  y += dy;
  if (bounds) {
    x = clamp(x, bounds.x, Math.max(bounds.x, bounds.x + bounds.w - w));
    y = clamp(y, bounds.y, Math.max(bounds.y, bounds.y + bounds.h - h));
  }
  return { ...ann, rect: { x, y, w, h } };
}

export function annotationsForPage(annotations, pageId) {
  return annotations.filter((a) => a.pageId === pageId);
}

export function summarizeAnnotations(annotations) {
  const byType = {};
  for (const a of annotations || []) byType[a.type] = (byType[a.type] || 0) + 1;
  return { total: (annotations || []).length, byType };
}

/* ============================================================
   ページ操作の正規化
   ------------------------------------------------------------
   ページは {id, sourceIndex, rotation, deleted, blank, blankSize} の配列。
   削除は deleted フラグ (復元可能)、並べ替えは配列順で表現する。
   ============================================================ */

export const A4 = { width: 595.28, height: 841.89 };

export function createPageModel(pageCount, opts = {}) {
  const prefix = opts.idPrefix || 'pg';
  const pages = [];
  for (let i = 0; i < pageCount; i += 1) {
    pages.push({
      id: `${prefix}${i + 1}`,
      sourceIndex: i,
      rotation: 0,
      deleted: false,
      blank: false,
      blankSize: null,
    });
  }
  return pages;
}

export function activePages(model) {
  return (model || []).filter((p) => !p.deleted);
}

export function pageCount(model) {
  return activePages(model).length;
}

export function findPage(model, id) {
  return (model || []).find((p) => p.id === id) || null;
}

export function rotatePage(model, id, delta) {
  return model.map((p) => (p.id === id ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p));
}

export function setPageRotation(model, id, deg) {
  return model.map((p) => (p.id === id ? { ...p, rotation: normalizeRotation(deg) } : p));
}

export function deletePage(model, id) {
  return model.map((p) => (p.id === id ? { ...p, deleted: true } : p));
}

export function restorePage(model, id) {
  return model.map((p) => (p.id === id ? { ...p, deleted: false } : p));
}

/** アクティブページの中で id を delta 個移動する (端は維持)。 */
export function movePage(model, id, delta) {
  const active = activePages(model);
  const at = active.findIndex((p) => p.id === id);
  if (at < 0) return model;
  const target = clamp(at + delta, 0, active.length - 1);
  if (target === at) return model;
  const fromIndex = model.indexOf(active[at]);
  const toIndex = model.indexOf(active[target]);
  return reorderPages(model, fromIndex, toIndex);
}

/** 配列の from 番目を to 番目へ動かす (挿入)。 */
export function reorderPages(model, from, to) {
  if (from === to || from < 0 || from >= model.length) return model;
  const next = model.slice();
  const [item] = next.splice(from, 1);
  const dest = clamp(to, 0, next.length);
  next.splice(dest, 0, item);
  return next;
}

let blankSeq = 0;

/** index の位置に白紙ページを挿入する。 */
export function insertBlankPage(model, index, opts = {}) {
  blankSeq += 1;
  const blank = {
    id: opts.id || `blank${blankSeq}`,
    sourceIndex: null,
    rotation: 0,
    deleted: false,
    blank: true,
    blankSize: opts.size || A4,
  };
  const next = model.slice();
  next.splice(clamp(index, 0, next.length), 0, blank);
  return next;
}

/** 指定 id だけを残した新モデルを作る (抽出)。 */
export function extractPages(model, ids) {
  const wanted = new Set(ids);
  return model.filter((p) => wanted.has(p.id)).map((p) => ({ ...p, deleted: false }));
}

/** 削除されたページに属する注釈を取り除く。 */
export function pruneAnnotations(annotations, model) {
  const live = new Set((model || []).filter((p) => !p.deleted).map((p) => p.id));
  return (annotations || []).filter((a) => live.has(a.pageId));
}

/** 回転後ページの表示幅・高さの比 (幅, 高さ) を返す。 */
export function displayedAspect(pageWidthPt, pageHeightPt, rotation) {
  const r = normalizeRotation(rotation);
  return (r === 90 || r === 270)
    ? { width: pageHeightPt, height: pageWidthPt }
    : { width: pageWidthPt, height: pageHeightPt };
}

/* ============================================================
   シリアライズ (別レイヤとしての注釈データ)
   ============================================================ */

export const ANNOTATION_VERSION = 1;

export function serializeAnnotations(annotations, meta = {}) {
  return JSON.stringify({
    version: ANNOTATION_VERSION,
    generator: 'pdf-annotate',
    savedAt: meta.savedAt || null,
    source: meta.source || null,
    annotations: annotations || [],
  }, null, 2);
}

export function parseAnnotations(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('注釈データを JSON として解釈できません');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.annotations)) {
    throw new Error('注釈データの形式が不正です');
  }
  const annotations = data.annotations.filter((a) => a && isAnnotationType(a.type) && a.pageId);
  return { version: data.version || 1, source: data.source || null, annotations };
}

/* ============================================================
   ファイル名
   ============================================================ */

export function sanitizeBaseName(name, fallback = 'document') {
  const withoutExt = String(name || '').replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExt
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || fallback;
}

export function ensurePdfExtension(name) {
  return /\.pdf$/i.test(name || '') ? name : `${name}.pdf`;
}

/** 書き出し名を作る。variant: 'flat' (焼き込み) / 'layer' (注釈データ付き)。 */
export function buildExportName(sourceName, variant = 'flat') {
  const base = sanitizeBaseName(sourceName, 'document');
  const suffix = variant === 'layer' ? '-annotated-layered' : '-annotated';
  return `${base}${suffix}.pdf`;
}

export function buildAnnotationsName(sourceName) {
  return `${sanitizeBaseName(sourceName, 'document')}-annotations.json`;
}

/** 既存名と衝突しないよう (1), (2) … を付ける。 */
export function uniqueFileName(existingNames, name) {
  const set = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  if (!set.has(name)) return name;
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(name);
  const stem = m[1];
  const ext = m[2] || '';
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (set.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

export function isSupportedPdfFile(name, size = 0) {
  return /\.pdf$/i.test(String(name || '')) && size >= 0;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
