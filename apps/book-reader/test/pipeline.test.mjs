import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_VERSION,
  BOOK_EXTENSIONS,
  IMAGE_EXTENSIONS,
  READER_THEMES,
  FLOWS,
  FONT_SCALE,
  MARGIN,
  DEFAULT_SETTINGS,
  READER_THEME_PALETTE,
  clamp01,
  fileExtension,
  isSupportedBookFile,
  detectFormat,
  isImageEntry,
  naturalCompare,
  sortCbzPages,
  clampIndex,
  nextIndex,
  prevIndex,
  progressPercent,
  overallFraction,
  buildCbzPageLabel,
  normalizeToc,
  stripHref,
  hrefFragment,
  resolveRelativePath,
  findTocIndex,
  buildBookKey,
  normalizeReadingState,
  serializeReadingState,
  deserializeReadingState,
  isSameReadingState,
  readingPositionLabel,
  normalizeSettings,
  buildReaderCss,
  formatBytes,
  formatPercent,
  buildHighlightsFileName,
} from '../pipeline.mjs';

/* ==========================================================
   拡張子・形式判定
   ========================================================== */

test('fileExtension は小文字の拡張子を返し、ドットファイルは空にする', () => {
  assert.equal(fileExtension('Book.EPUB'), '.epub');
  assert.equal(fileExtension('/a/b/scan.CbZ'), '.cbz');
  assert.equal(fileExtension('page2.jpg'), '.jpg');
  assert.equal(fileExtension('.gitignore'), '');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileExtension(''), '');
});

test('isSupportedBookFile / detectFormat は epub と cbz だけを受け付ける', () => {
  assert.equal(isSupportedBookFile('a.epub'), true);
  assert.equal(isSupportedBookFile('a.CBZ'), true);
  assert.equal(isSupportedBookFile('a.pdf'), false);
  assert.equal(isSupportedBookFile('a.mobi'), false);
  assert.deepEqual(BOOK_EXTENSIONS, ['.epub', '.cbz']);
  assert.equal(detectFormat('a.epub'), 'epub');
  assert.equal(detectFormat('x/y/b.cbz'), 'cbz');
  assert.equal(detectFormat('a.zip'), null);
});

/* ==========================================================
   CBZ ページ
   ========================================================== */

test('isImageEntry は画像だけを許可し、隠しファイルと __MACOSX を除く', () => {
  assert.equal(isImageEntry('page1.jpg'), true);
  assert.equal(isImageEntry('dir/Page-2.PNG'), true);
  assert.equal(isImageEntry('dir/'), false);
  assert.equal(isImageEntry('__MACOSX/page1.jpg'), false);
  assert.equal(isImageEntry('dir/__MACOSX/p.jpg'), false);
  assert.equal(isImageEntry('.hidden.png'), false);
  assert.equal(isImageEntry('cover.txt'), false);
  assert.equal(isImageEntry('notes.md'), false);
  assert.ok(IMAGE_EXTENSIONS.includes('.webp'));
});

test('naturalCompare は数字を数値として比較する', () => {
  assert.ok(naturalCompare('page2.jpg', 'page10.jpg') < 0);
  assert.ok(naturalCompare('page10.jpg', 'page2.jpg') > 0);
  assert.ok(naturalCompare('a9', 'a10') < 0);
  assert.equal(naturalCompare('same', 'same'), 0);
  assert.ok(naturalCompare('ch1', 'ch2') < 0);
});

test('sortCbzPages は画像だけを自然順に並べる', () => {
  const entries = [
    'comic/page10.png',
    'comic/page2.png',
    '__MACOSX/._page1.png',
    'comic/cover.jpg',
    'comic/Readme.txt',
    'comic/.hidden.png',
  ];
  assert.deepEqual(sortCbzPages(entries), [
    'comic/cover.jpg',
    'comic/page2.png',
    'comic/page10.png',
  ]);
  assert.deepEqual(sortCbzPages(null), []);
});

/* ==========================================================
   ページ進行
   ========================================================== */

test('clampIndex は範囲に丸め、空なら -1 を返す', () => {
  assert.equal(clampIndex(0, 5), 0);
  assert.equal(clampIndex(4, 5), 4);
  assert.equal(clampIndex(99, 5), 4);
  assert.equal(clampIndex(-3, 5), 0);
  assert.equal(clampIndex(2, 0), -1);
  assert.equal(clampIndex(NaN, 5), 0);
});

test('nextIndex / prevIndex は端で止まる', () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 2);
  assert.equal(prevIndex(0, 3), 0);
  assert.equal(prevIndex(2, 3), 1);
  assert.equal(nextIndex(0, 0), -1);
  assert.equal(prevIndex(0, 0), -1);
});

test('progressPercent は 1 始まりで 0..100 を返す', () => {
  assert.equal(progressPercent(0, 4), 25);
  assert.equal(progressPercent(3, 4), 100);
  assert.equal(progressPercent(99, 4), 100);
  assert.equal(progressPercent(0, 0), 0);
});

test('overallFraction はセクション位置と fraction を合成する', () => {
  assert.equal(overallFraction(0, 0, 4), 0);
  assert.equal(overallFraction(2, 0, 4), 0.5);
  assert.equal(overallFraction(1, 0.5, 4), 0.375);
  assert.equal(overallFraction(3, 1, 4), 1);
  assert.equal(overallFraction(0, 0, 0), 0);
});

test('buildCbzPageLabel は "現在 / 全体" を返す', () => {
  assert.equal(buildCbzPageLabel(0, 10), '1 / 10');
  assert.equal(buildCbzPageLabel(9, 10), '10 / 10');
  assert.equal(buildCbzPageLabel(5, 0), '0 / 0');
});

/* ==========================================================
   目次
   ========================================================== */

test('normalizeToc はネストした目次を深さ付きで平坦化する', () => {
  const toc = [
    { label: '第一章', href: 'ch1.xhtml', subitems: [
      { label: { ja: '節A' }, href: 'ch1.xhtml#a' },
    ] },
    { label: '第二章', href: 'ch2.xhtml' },
    null,
  ];
  const flat = normalizeToc(toc);
  assert.deepEqual(flat, [
    { label: '第一章', href: 'ch1.xhtml', depth: 0 },
    { label: '節A', href: 'ch1.xhtml#a', depth: 1 },
    { label: '第二章', href: 'ch2.xhtml', depth: 0 },
  ]);
  assert.deepEqual(normalizeToc(null), []);
});

test('stripHref / hrefFragment はクエリと断片を分ける', () => {
  assert.equal(stripHref('a/b.xhtml?x=1#frag'), 'a/b.xhtml');
  assert.equal(hrefFragment('a/b.xhtml?x=1#frag'), 'frag');
  assert.equal(hrefFragment('a/b.xhtml'), '');
});

test('resolveRelativePath は EPUB の相対パスを解決する', () => {
  assert.equal(resolveRelativePath('OEBPS/content.opf', 'Text/ch1.xhtml'), 'OEBPS/Text/ch1.xhtml');
  assert.equal(resolveRelativePath('OEBPS/Text/a.xhtml', '../Images/x.png'), 'OEBPS/Images/x.png');
  assert.equal(resolveRelativePath('a/b/c.xhtml', './d.xhtml'), 'a/b/d.xhtml');
  assert.equal(resolveRelativePath('a/b.xhtml', 'https://example.com/x'), 'https://example.com/x');
  assert.equal(resolveRelativePath('a/b.xhtml', '#frag'), '');
});

test('findTocIndex は断片を無視して一致を探す', () => {
  const flat = normalizeToc([
    { label: 'A', href: 'ch1.xhtml' },
    { label: 'B', href: 'ch2.xhtml#top' },
  ]);
  assert.equal(findTocIndex(flat, 'ch2.xhtml#other'), 1);
  assert.equal(findTocIndex(flat, 'missing.xhtml'), -1);
});

/* ==========================================================
   読書位置の保存
   ========================================================== */

test('buildBookKey は同じ入力で安定し、サイズで変わる', () => {
  const a = buildBookKey({ name: 'book.epub', size: 1000, lastModified: 42 });
  const b = buildBookKey({ name: 'book.epub', size: 1000, lastModified: 42 });
  const c = buildBookKey({ name: 'book.epub', size: 2000, lastModified: 42 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^book:book\.epub:1000:42$/);
});

test('normalizeReadingState は欠損を補い、範囲を丸める', () => {
  const s = normalizeReadingState({ index: -5, fraction: 2, sectionCount: 3 });
  assert.equal(s.v, STATE_VERSION);
  assert.equal(s.index, 0);
  assert.equal(s.fraction, 1);
  assert.equal(s.cfi, '');
  assert.equal(s.label, '');
});

test('serialize/deserialize は往復し、壊れた入力は null を返す', () => {
  const json = serializeReadingState({
    index: 4, fraction: 0.25, cfi: 'epubcfi(/6/8!/4/2)', label: '第三章', sectionCount: 10,
  });
  const restored = deserializeReadingState(json);
  assert.deepEqual(restored, {
    v: STATE_VERSION,
    index: 4,
    fraction: 0.25,
    cfi: 'epubcfi(/6/8!/4/2)',
    label: '第三章',
  });
  assert.equal(deserializeReadingState('not json'), null);
  assert.equal(deserializeReadingState('{"v":99}'), null);
  assert.equal(deserializeReadingState('null'), null);
  // 再シリアライズしても同じ (正規化が冪等)
  assert.equal(serializeReadingState(restored), json);
});

test('isSameReadingState は CFI か (index, fraction) で同一判定する', () => {
  const a = { index: 2, fraction: 0.5, cfi: 'x' };
  assert.equal(isSameReadingState(a, { index: 2, fraction: 0.5, cfi: 'x' }), true);
  assert.equal(isSameReadingState(a, { index: 2, fraction: 0.9, cfi: 'x' }), true); // CFI 優先
  assert.equal(isSameReadingState({ index: 2, fraction: 0.5 }, { index: 2, fraction: 0.5 }), true);
  assert.equal(isSameReadingState({ index: 2, fraction: 0.5 }, { index: 2, fraction: 0.8 }), false);
  assert.equal(isSameReadingState({ index: 1 }, { index: 2 }), false);
});

test('readingPositionLabel は % と章名を返す', () => {
  assert.equal(readingPositionLabel({ fraction: 0.42 }), '42%');
  assert.equal(readingPositionLabel({ fraction: 0.42, label: '第3章' }), '42% · 第3章');
});

/* ==========================================================
   設定
   ========================================================== */

test('normalizeSettings は既定値で埋め、範囲外を丸める', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  const s = normalizeSettings({ readerTheme: 'neon', fontScale: 9, margin: -1, flow: 'weird' });
  assert.equal(s.readerTheme, 'light');
  assert.equal(s.fontScale, FONT_SCALE.max);
  assert.equal(s.margin, MARGIN.min);
  assert.equal(s.flow, 'paginated');
  assert.ok(READER_THEMES.includes(s.readerTheme));
  assert.ok(FLOWS.includes(s.flow));
});

test('buildReaderCss はテーマ色と文字サイズを反映する', () => {
  const css = buildReaderCss({ readerTheme: 'sepia', fontScale: 1.5, margin: 64 });
  assert.ok(css.includes(READER_THEME_PALETTE.sepia.background));
  assert.ok(css.includes('font-size: 24px'));
  assert.ok(css.includes('color-scheme: light'));
  const dark = buildReaderCss({ readerTheme: 'dark', fontScale: 1 });
  assert.ok(dark.includes('font-size: 16px'));
  assert.ok(dark.includes('color-scheme: dark'));
});

/* ==========================================================
   表示ヘルパー
   ========================================================== */

test('formatBytes は単位を切り替える', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3.5 * 1024 * 1024 * 1024), '3.5 GB');
});

test('formatPercent は 0..1 を % にする', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.5), '50%');
  assert.equal(formatPercent(1.5), '100%');
  assert.equal(formatPercent(0.1234, 1), '12.3%');
});

test('buildHighlightsFileName は拡張子を落として md を付ける', () => {
  assert.equal(buildHighlightsFileName('my book.epub'), 'my book-highlights.md');
  assert.equal(buildHighlightsFileName('a/b:c.epub'), 'a_b_c-highlights.md');
  assert.equal(buildHighlightsFileName(''), 'book-highlights.md');
});

test('clamp01 は範囲外を丸める', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(7), 1);
  assert.equal(clamp01(NaN), 0);
});
