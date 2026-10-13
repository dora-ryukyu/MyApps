import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROTATIONS,
  normalizeRotation,
  clamp,
  clamp01,
  hexToRgb,
  screenToPageNorm,
  pageNormToScreen,
  normRect,
  rectContains,
  rectsIntersect,
  rectToPdfPoints,
  ANNOTATION_TYPES,
  ANNOTATION_VERSION,
  annotationLabel,
  isAnnotationType,
  createAnnotation,
  normalizeInkStrokes,
  simplifyStroke,
  padStrokesToNorm,
  normalizeLine,
  lineFromRect,
  lineBounds,
  annotationBounds,
  pointSegmentDistance,
  hitTestAnnotation,
  topAnnotationAt,
  moveAnnotation,
  annotationsForPage,
  summarizeAnnotations,
  A4,
  createPageModel,
  activePages,
  pageCount,
  findPage,
  rotatePage,
  setPageRotation,
  deletePage,
  restorePage,
  movePage,
  reorderPages,
  insertBlankPage,
  extractPages,
  pruneAnnotations,
  displayedAspect,
  serializeAnnotations,
  parseAnnotations,
  sanitizeBaseName,
  ensurePdfExtension,
  buildExportName,
  buildAnnotationsName,
  uniqueFileName,
  isSupportedPdfFile,
  formatBytes,
} from '../pipeline.mjs';

/* ---------- 汎用 ---------- */

test('normalizeRotation は 0/90/180/270 に丸める', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(359), 0); // 90 単位に丸め
  assert.deepEqual(ROTATIONS, [0, 90, 180, 270]);
});

test('clamp / clamp01', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(Number.NaN, 2, 3), 2);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-0.1), 0);
});

test('hexToRgb は 0..1 に正規化する', () => {
  assert.deepEqual(hexToRgb('#ff0000'), { r: 1, g: 0, b: 0 });
  const c = hexToRgb('#f00');
  assert.ok(Math.abs(c.r - 1) < 1e-9 && c.g === 0 && c.b === 0);
  assert.deepEqual(hexToRgb('zzz'), { r: 0, g: 0, b: 0 });
});

/* ---------- 座標変換 ---------- */

test('screenToPageNorm / pageNormToScreen は全回転で往復する', () => {
  const samples = [
    { u: 0.25, v: 0.75 },
    { u: 0, v: 0 },
    { u: 1, v: 1 },
    { u: 0.5, v: 0.5 },
  ];
  for (const r of ROTATIONS) {
    for (const s of samples) {
      const { nx, ny } = screenToPageNorm(s.u, s.v, r);
      const back = pageNormToScreen(nx, ny, r);
      assert.ok(Math.abs(back.u - s.u) < 1e-9, `u r=${r}`);
      assert.ok(Math.abs(back.v - s.v) < 1e-9, `v r=${r}`);
    }
  }
});

test('回転 90° では表示の上辺がページ左辺に対応する', () => {
  // 表示左上 (0,0) → r=90 で nx=0, ny=0 (ページ左下)
  assert.deepEqual(screenToPageNorm(0, 0, 90), { nx: 0, ny: 0 });
  // 表示右上 (1,0) → ページ右下 (nx=0, ny=1)
  assert.deepEqual(screenToPageNorm(1, 0, 90), { nx: 0, ny: 1 });
});

test('normRect は負の幅でも正規化する', () => {
  const r = normRect(0.8, 0.2, 0.3, 0.7);
  assert.equal(r.x, 0.3);
  assert.equal(r.y, 0.2);
  assert.ok(Math.abs(r.w - 0.5) < 1e-9);
  assert.ok(Math.abs(r.h - 0.5) < 1e-9);
});

test('rectContains / rectsIntersect', () => {
  const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  assert.ok(rectContains(a, { x: 0.2, y: 0.2 }));
  assert.ok(!rectContains(a, { x: 0.4, y: 0.2 }));
  assert.ok(rectsIntersect(a, { x: 0.25, y: 0.25, w: 0.2, h: 0.2 }));
  assert.ok(!rectsIntersect(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }));
});

test('rectToPdfPoints はページポイントに拡大する', () => {
  const r = { x: 0.5, y: 0.25, w: 0.1, h: 0.2 };
  const p = rectToPdfPoints(r, 600, 800);
  assert.deepEqual(p, { x: 300, y: 200, width: 60, height: 160 });
});

/* ---------- 注釈モデル ---------- */

test('createAnnotation は型ごとの既定を補う', () => {
  const h = createAnnotation('highlight', 'pg1', { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } });
  assert.equal(h.type, 'highlight');
  assert.equal(h.pageId, 'pg1');
  assert.ok(h.id.startsWith('a'));
  assert.deepEqual(h.rect, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });

  const ink = createAnnotation('ink', 'pg1', { strokes: [[{ x: 0.1, y: 0.1 }]] });
  assert.equal(ink.strokes.length, 1);

  const note = createAnnotation('note', 'pg2', { rect: {}, text: ' メモ ' });
  assert.equal(note.text, ' メモ ');

  assert.throws(() => createAnnotation('nope', 'pg1'), /unknown annotation/);
  assert.ok(ANNOTATION_TYPES.every(isAnnotationType));
  assert.equal(annotationLabel('strikeout'), '取り消し線');
});

test('createAnnotation の rect は 0..1 にクランプされる', () => {
  const a = createAnnotation('rect', 'pg1', { rect: { x: -1, y: 2, w: 3, h: -0.5 } });
  assert.deepEqual(a.rect, { x: 0, y: 1, w: 1, h: 0 });
});

test('normalizeInkStrokes / padStrokesToNorm / simplifyStroke', () => {
  const strokes = normalizeInkStrokes([[{ x: 1.5, y: -0.5 }]]);
  assert.deepEqual(strokes[0][0], { x: 1, y: 0 });

  const norm = padStrokesToNorm([[{ x: 50, y: 25 }]], 100, 100);
  assert.deepEqual(norm[0][0], { x: 0.5, y: 0.75 });

  const simplified = simplifyStroke([
    { x: 0, y: 0 }, { x: 0.0001, y: 0 }, { x: 0.5, y: 0.5 },
  ], 0.002);
  assert.equal(simplified.length, 2);
});

test('underline / strikeout は線分として保持し、移動・当たり判定できる', () => {
  const u = createAnnotation('underline', 'pg1', { rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 } });
  assert.deepEqual(u.line, { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.2 });
  assert.ok(Math.abs(createAnnotation('strikeout', 'pg1', { rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.2 } }).line.y1 - 0.3) < 1e-9);
  assert.deepEqual(normalizeLine({ x1: 2, y1: -1, x2: 0.5, y2: 0.5 }), { x1: 1, y1: 0, x2: 0.5, y2: 0.5 });
  assert.ok(Math.abs(lineBounds({ x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 }).w - 0.3) < 1e-9);

  assert.ok(hitTestAnnotation(u, { x: 0.3, y: 0.205 }, 0.02));
  assert.ok(!hitTestAnnotation(u, { x: 0.3, y: 0.5 }));
  const moved = moveAnnotation(u, 0.05, 0);
  assert.ok(Math.abs(moved.line.x1 - 0.15) < 1e-9);
  const clamped = moveAnnotation(u, 5, 5, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(clamped.line.x2, 1);
  assert.equal(lineFromRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, true).y1, 0.2);
});

test('annotationBounds は ink の外接矩形を返す', () => {
  const ink = createAnnotation('ink', 'pg1', {
    strokes: [[{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }]],
  });
  const b = annotationBounds(ink);
  assert.ok(Math.abs(b.x - 0.1) < 1e-9 && Math.abs(b.y - 0.2) < 1e-9);
  assert.ok(Math.abs(b.w - 0.3) < 1e-9 && Math.abs(b.h - 0.4) < 1e-9);
  const empty = createAnnotation('ink', 'pg1', { strokes: [] });
  assert.deepEqual(annotationBounds(empty), { x: 0, y: 0, w: 0, h: 0 });
});

test('pointSegmentDistance', () => {
  assert.equal(pointSegmentDistance({ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 0.5);
  assert.equal(pointSegmentDistance({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 0);
});

test('hitTestAnnotation / topAnnotationAt', () => {
  const rectAnn = createAnnotation('highlight', 'pg1', { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  assert.ok(hitTestAnnotation(rectAnn, { x: 0.15, y: 0.15 }));
  assert.ok(!hitTestAnnotation(rectAnn, { x: 0.5, y: 0.5 }));

  const ink = createAnnotation('ink', 'pg1', { strokes: [[{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }]] });
  assert.ok(hitTestAnnotation(ink, { x: 0.3, y: 0.105 }, 0.02));
  assert.ok(!hitTestAnnotation(ink, { x: 0.3, y: 0.5 }));

  const top = topAnnotationAt([rectAnn, ink], { x: 0.3, y: 0.105 }, 0.02);
  assert.equal(top, ink);
  assert.equal(topAnnotationAt([rectAnn], { x: 0.9, y: 0.9 }), null);
});

test('moveAnnotation は矩形と ink の両方を動かし境界でクランプする', () => {
  const rectAnn = createAnnotation('rect', 'pg1', { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  const moved = moveAnnotation(rectAnn, 0.5, 0.5, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(moved.rect, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 });

  const clamped = moveAnnotation(rectAnn, 5, 5, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(clamped.rect, { x: 0.8, y: 0.8, w: 0.2, h: 0.2 });

  const ink = createAnnotation('ink', 'pg1', { strokes: [[{ x: 0.1, y: 0.1 }]] });
  const inkMoved = moveAnnotation(ink, 0.2, 0.3);
  assert.deepEqual(inkMoved.strokes[0][0], { x: 0.30000000000000004, y: 0.4 });
});

test('annotationsForPage / summarizeAnnotations', () => {
  const list = [
    createAnnotation('highlight', 'pg1', { rect: {} }),
    createAnnotation('ink', 'pg1', { strokes: [] }),
    createAnnotation('note', 'pg2', { rect: {} }),
  ];
  assert.equal(annotationsForPage(list, 'pg1').length, 2);
  assert.deepEqual(summarizeAnnotations(list), { total: 3, byType: { highlight: 1, ink: 1, note: 1 } });
});

/* ---------- ページ操作 ---------- */

test('createPageModel / activePages / pageCount / findPage', () => {
  const model = createPageModel(3);
  assert.equal(model.length, 3);
  assert.equal(model[0].id, 'pg1');
  assert.equal(model[2].sourceIndex, 2);
  assert.equal(pageCount(model), 3);
  assert.equal(findPage(model, 'pg2').id, 'pg2');
  assert.equal(findPage(model, 'x'), null);
});

test('rotatePage / setPageRotation は 90 単位で正規化する', () => {
  let model = createPageModel(1);
  model = rotatePage(model, 'pg1', 90);
  model = rotatePage(model, 'pg1', 90);
  assert.equal(findPage(model, 'pg1').rotation, 180);
  model = rotatePage(model, 'pg1', -90);
  assert.equal(findPage(model, 'pg1').rotation, 90);
  model = setPageRotation(model, 'pg1', 720);
  assert.equal(findPage(model, 'pg1').rotation, 0);
});

test('deletePage / restorePage / pruneAnnotations', () => {
  let model = createPageModel(2);
  model = deletePage(model, 'pg1');
  assert.equal(pageCount(model), 1);
  const anns = [
    createAnnotation('highlight', 'pg1', { rect: {} }),
    createAnnotation('highlight', 'pg2', { rect: {} }),
  ];
  assert.equal(pruneAnnotations(anns, model).length, 1);
  model = restorePage(model, 'pg1');
  assert.equal(pageCount(model), 2);
  assert.equal(pruneAnnotations(anns, model).length, 2);
});

test('movePage はアクティブページ内で並べ替える', () => {
  let model = createPageModel(3);
  model = movePage(model, 'pg3', -1);
  assert.deepEqual(model.map((p) => p.id), ['pg1', 'pg3', 'pg2']);
  model = movePage(model, 'pg1', -1); // 端は維持
  assert.deepEqual(model.map((p) => p.id), ['pg1', 'pg3', 'pg2']);
});

test('reorderPages は挿入移動する', () => {
  const model = createPageModel(3);
  assert.deepEqual(reorderPages(model, 0, 2).map((p) => p.id), ['pg2', 'pg3', 'pg1']);
  assert.equal(reorderPages(model, 1, 1), model); // 変化なしは同一参照
  assert.deepEqual(reorderPages(model, 2, 0).map((p) => p.id), ['pg3', 'pg1', 'pg2']);
});

test('insertBlankPage はサイズ既定 A4 で挿入する', () => {
  const model = createPageModel(2);
  const next = insertBlankPage(model, 1, { id: 'blankX' });
  assert.equal(next.length, 3);
  assert.equal(next[1].blank, true);
  assert.deepEqual(next[1].blankSize, A4);
  assert.equal(next[1].sourceIndex, null);
});

test('extractPages は指定 id だけを並び順どおりに残す', () => {
  const model = createPageModel(4);
  const extracted = extractPages(model, ['pg3', 'pg1']);
  assert.deepEqual(extracted.map((p) => p.id), ['pg1', 'pg3']);
  assert.ok(extracted.every((p) => !p.deleted));
});

test('displayedAspect は 90/270 で縦横を入れ替える', () => {
  assert.deepEqual(displayedAspect(600, 800, 0), { width: 600, height: 800 });
  assert.deepEqual(displayedAspect(600, 800, 90), { width: 800, height: 600 });
  assert.deepEqual(displayedAspect(600, 800, 180), { width: 600, height: 800 });
  assert.deepEqual(displayedAspect(600, 800, 270), { width: 800, height: 600 });
});

/* ---------- シリアライズ ---------- */

test('serializeAnnotations / parseAnnotations は往復する', () => {
  const anns = [
    createAnnotation('highlight', 'pg1', { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
    createAnnotation('ink', 'pg2', { strokes: [[{ x: 0.1, y: 0.1 }]] }),
  ];
  const json = serializeAnnotations(anns, { source: 'report.pdf' });
  const parsed = parseAnnotations(json);
  assert.equal(parsed.version, ANNOTATION_VERSION);
  assert.equal(parsed.source, 'report.pdf');
  assert.equal(parsed.annotations.length, 2);
  assert.equal(parsed.annotations[0].type, 'highlight');
});

test('parseAnnotations は不正なデータでは例外を投げ、未知の型は除く', () => {
  assert.throws(() => parseAnnotations('{bad json'), /JSON/);
  assert.throws(() => parseAnnotations('{"foo":1}'), /形式/);
  const parsed = parseAnnotations(JSON.stringify({
    annotations: [{ type: 'unknown', pageId: 'pg1' }, { type: 'rect', pageId: 'pg1', rect: {} }],
  }));
  assert.equal(parsed.annotations.length, 1);
});

/* ---------- ファイル名 ---------- */

test('sanitizeBaseName は拡張子と禁止文字を除去する', () => {
  assert.equal(sanitizeBaseName('report.pdf'), 'report');
  assert.equal(sanitizeBaseName('a/b:c*.pdf'), 'a_b_c_');
  assert.equal(sanitizeBaseName('  .hidden. '), 'hidden');
  assert.equal(sanitizeBaseName('', 'x'), 'x');
});

test('ensurePdfExtension / buildExportName / buildAnnotationsName', () => {
  assert.equal(ensurePdfExtension('a'), 'a.pdf');
  assert.equal(ensurePdfExtension('a.PDF'), 'a.PDF');
  assert.equal(buildExportName('report.pdf', 'flat'), 'report-annotated.pdf');
  assert.equal(buildExportName('report.pdf', 'layer'), 'report-annotated-layered.pdf');
  assert.equal(buildAnnotationsName('report.pdf'), 'report-annotations.json');
});

test('uniqueFileName は衝突を回避する', () => {
  const existing = ['a-annotated.pdf', 'a-annotated (1).pdf'];
  assert.equal(uniqueFileName(existing, 'a-annotated.pdf'), 'a-annotated (2).pdf');
  assert.equal(uniqueFileName(existing, 'new.pdf'), 'new.pdf');
});

test('isSupportedPdfFile / formatBytes', () => {
  assert.ok(isSupportedPdfFile('x.pdf', 10));
  assert.ok(!isSupportedPdfFile('x.txt', 10));
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
