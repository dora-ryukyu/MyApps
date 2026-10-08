import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PALETTE,
  PALETTES,
  countFields,
  detectDelimiter,
  parseDelimited,
  normalizeRows,
  normalizeHeaders,
  toNumber,
  inferColumnType,
  parseTable,
  columnValues,
  pairedValues,
  categorySeries,
  mean,
  stdev,
  quantile,
  median,
  boxStats,
  niceTicks,
  logTicks,
  linearScale,
  logScale,
  histogram,
  heatmapGrid,
  normalize,
  seriesColors,
  colorScale,
  hexToRgb,
  formatNumber,
  buildCsv,
  densityMatrix,
} from '../pipeline.mjs';

/* ---------------- 解析 ---------------- */

test('countFields は引用符内の区切り文字を数えない', () => {
  assert.equal(countFields('a,b,c', ','), 3);
  assert.equal(countFields('"a,b",c', ','), 2);
  assert.equal(countFields('a;b;c', ';'), 3);
});

test('detectDelimiter はタブ/カンマ/パイプを推定する', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
});

test('parseDelimited は引用符・改行・CRLF を扱う', () => {
  const rows = parseDelimited('name,note\n"a,1","line1\nline2"\r\nb,"say ""hi"""', ',');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['a,1', 'line1\nline2'],
    ['b', 'say "hi"'],
  ]);
});

test('parseDelimited は末尾の空行を落とす', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2\n\n', ','), [['a', 'b'], ['1', '2']]);
});

test('normalizeRows は最大列数に揃える', () => {
  assert.deepEqual(normalizeRows([['a'], ['b', 'c', 'd']]), [['a', '', ''], ['b', 'c', 'd']]);
});

test('normalizeHeaders は空欄と重複を一意化する', () => {
  assert.deepEqual(normalizeHeaders(['name', '', 'name', 'name']), ['name', 'Column 2', 'name_2', 'name_3']);
});

test('toNumber は数値のみ受け付ける', () => {
  assert.equal(toNumber(' 3.5 '), 3.5);
  assert.equal(toNumber('-2e3'), -2000);
  assert.equal(toNumber('.5'), 0.5);
  assert.ok(Number.isNaN(toNumber('abc')));
  assert.ok(Number.isNaN(toNumber('')));
  assert.ok(Number.isNaN(toNumber('12px')));
});

test('inferColumnType は number/boolean/date/text/empty を返す', () => {
  assert.equal(inferColumnType(['1', '2.5', '-3']), 'number');
  assert.equal(inferColumnType(['true', 'FALSE']), 'boolean');
  assert.equal(inferColumnType(['2026-01-02', '2026/03/04']), 'date');
  assert.equal(inferColumnType(['a', '1']), 'text');
  assert.equal(inferColumnType(['', '']), 'empty');
});

test('parseTable はヘッダー・型・区切り文字を解決する', () => {
  const table = parseTable('name,score\nAlice,82\nBob,91', {});
  assert.deepEqual(table.headers, ['name', 'score']);
  assert.deepEqual(table.rows, [['Alice', '82'], ['Bob', '91']]);
  assert.deepEqual(table.types, ['text', 'number']);
  assert.equal(table.delimiter, ',');
});

test('parseTable は header=false で連番ヘッダーを振る', () => {
  const table = parseTable('1,2\n3,4', { header: false });
  assert.deepEqual(table.headers, ['Column 1', 'Column 2']);
  assert.equal(table.rows.length, 2);
});

/* ---------------- 列 ---------------- */

test('columnValues は numeric 指定で数値のみ返す', () => {
  const rows = [['1'], ['x'], [''], ['3']];
  assert.deepEqual(columnValues(rows, 0), ['1', 'x', '3']);
  assert.deepEqual(columnValues(rows, 0, { numeric: true }), [1, 3]);
});

test('pairedValues は両軸が数値の点だけ返す', () => {
  const rows = [['1', '2'], ['x', '3'], ['4', 'y']];
  assert.deepEqual(pairedValues(rows, 0, 1), [{ x: 1, y: 2 }]);
});

test('categorySeries はラベルと値を平行に返す', () => {
  const rows = [['a', '10'], ['b', '20'], ['', '30']];
  assert.deepEqual(categorySeries(rows, 0, 1), { labels: ['a', 'b'], values: [10, 20] });
});

/* ---------------- 統計 ---------------- */

test('mean / median / stdev が既知の値と一致する', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(stdev([2, 4, 6]), 2);
});

test('quantile は線形補間する', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(quantile(sorted, 0), 1);
  assert.equal(quantile(sorted, 0.5), 3);
  assert.equal(quantile(sorted, 1), 5);
  assert.equal(quantile(sorted, 0.25), 2);
});

test('boxStats は Tukey の 1.5*IQR で外れ値を分離する', () => {
  const plain = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(plain.q1, 3.25);
  assert.equal(plain.median, 5.5);
  assert.equal(plain.q3, 7.75);
  assert.equal(plain.whiskerLow, 1);
  assert.equal(plain.whiskerHigh, 10);
  assert.deepEqual(plain.outliers, []);

  const withOutlier = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
  assert.deepEqual(withOutlier.outliers, [100]);
  assert.equal(withOutlier.whiskerHigh, 9);
});

test('boxStats は空配列で count=0 を返す', () => {
  const s = boxStats([]);
  assert.equal(s.count, 0);
  assert.deepEqual(s.outliers, []);
});

/* ---------------- 目盛り ---------------- */

test('niceTicks は 1/2/5 の見やすい刻みになる', () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
});

test('niceTicks は範囲が同一でも 2 点以上返す', () => {
  const ticks = niceTicks(5, 5);
  assert.ok(ticks.length >= 2);
  assert.ok(ticks[0] < 5 && ticks[ticks.length - 1] > 5);
});

test('logTicks は 10 の冪を返し、非正では空', () => {
  assert.deepEqual(logTicks(1, 1000), [1, 10, 100, 1000]);
  assert.deepEqual(logTicks(-5, 10), []);
});

test('linearScale / logScale が端点を写像する', () => {
  const lin = linearScale([0, 10], [0, 100]);
  assert.equal(lin(0), 0);
  assert.equal(lin(10), 100);
  assert.equal(lin(5), 50);

  const log = logScale([1, 100], [0, 100]);
  assert.equal(log(1), 0);
  assert.equal(log(100), 100);
  assert.equal(log(10), 50);
});

test('linearScale は縮退 domain でも例外にならない', () => {
  const scale = linearScale([5, 5], [0, 100]);
  assert.equal(scale(5), 50);
});

/* ---------------- ビニング ---------------- */

test('histogram は件数とエッジを返し、合計が入力数と一致する', () => {
  const h = histogram([1, 2, 2, 3], 2);
  assert.deepEqual(h.edges, [1, 2, 3]);
  assert.deepEqual(h.counts, [1, 3]);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 4);
  assert.equal(h.max, 3);
});

test('histogram は domain を明示できる', () => {
  const h = histogram([0, 5, 10], 5, [0, 10]);
  assert.equal(h.edges.length, 6);
  assert.equal(h.counts.reduce((a, b) => a + b, 0), 3);
});

test('heatmapGrid は行×列の件数行列を返す', () => {
  const g = heatmapGrid([0, 1, 2], [0, 1, 2], 2, 2);
  assert.equal(g.rows, 2);
  assert.equal(g.cols, 2);
  assert.equal(g.counts.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0), 3);
  assert.deepEqual(g.counts, [[1, 0], [0, 2]]);
  assert.equal(g.max, 2);
});

/* ---------------- 正規化・色 ---------------- */

test('normalize は minmax で [0,1] に、zscore で平均 0 標準偏差 1 にする', () => {
  assert.deepEqual(normalize([0, 5, 10], 'minmax'), [0, 0.5, 1]);
  const z = normalize([2, 4, 6], 'zscore');
  assert.deepEqual(z, [-1, 0, 1]);
  assert.deepEqual(normalize([1, 2, 3], 'none'), [1, 2, 3]);
});

test('normalize はゼロ幅でも 0 を返す (NaN にしない)', () => {
  assert.deepEqual(normalize([7, 7, 7], 'minmax'), [0, 0, 0]);
  assert.deepEqual(normalize([7, 7, 7], 'zscore'), [0, 0, 0]);
});

test('seriesColors はパレットを循環して割り当てる', () => {
  const colors = seriesColors(PALETTE.length + 2);
  assert.equal(colors.length, PALETTE.length + 2);
  assert.equal(colors[0], PALETTE[0]);
  assert.equal(colors[PALETTE.length], PALETTE[0]);
  assert.ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
});

test('seriesColors は系列色プリセットを切り替えられる', () => {
  const cb = seriesColors(3, 'colorblind');
  assert.deepEqual(cb, PALETTES.colorblind.slice(0, 3));
  assert.notEqual(cb[0], seriesColors(3, 'default')[0]);
  assert.deepEqual(seriesColors(2, 'unknown'), PALETTE.slice(0, 2));
});

test('colorScale は端点で stops に一致し、中間も 16 進カラー', () => {
  const stops = ['#000000', '#ffffff'];
  assert.equal(colorScale(0, stops), '#000000');
  assert.equal(colorScale(1, stops), '#ffffff');
  assert.match(colorScale(0.5, stops), /^#[0-9a-f]{6}$/i);
  assert.equal(colorScale(-5, stops), '#000000');
  assert.equal(colorScale(5, stops), '#ffffff');
});

test('hexToRgb は 3/6 桁を解釈する', () => {
  assert.deepEqual(hexToRgb('#ff0000'), [255, 0, 0]);
  assert.deepEqual(hexToRgb('#0f0'), [0, 255, 0]);
});

test('densityMatrix は合計 1 に正規化する', () => {
  const d = densityMatrix([[1, 1], [2, 0]]);
  const sum = d.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

/* ---------------- フォーマット・書き出し ---------------- */

test('formatNumber は桁数と指数表記を切り替える', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1234.5678, 2), '1234.57');
  assert.equal(formatNumber(1234567), '1.23e+6');
});

test('buildCsv はカンマ・引用符・改行をエスケープする', () => {
  const csv = buildCsv(['a', 'b'], [['x,1', 'y"z'], ['line\nbreak', '']]);
  assert.equal(csv, 'a,b\n"x,1","y""z"\n"line\nbreak",');
});
