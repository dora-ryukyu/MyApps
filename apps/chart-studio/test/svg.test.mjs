import test from 'node:test';
import assert from 'node:assert/strict';

import { chartToSvg } from '../svg.mjs';

const lineSeries = [
  { name: 'revenue', color: '#2563eb', points: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }] },
  { name: 'cost', color: '#dc2626', points: [{ x: 0, y: 5 }, { x: 1, y: 9 }, { x: 2, y: 7 }] },
];

test('line: polyline と凡例を含む SVG を返す', () => {
  const svg = chartToSvg({ type: 'line', title: 'Sales', xLabel: 'month', yLabel: 'JPY', series: lineSeries });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(svg.includes('<polyline'));
  assert.ok(svg.includes('Sales'));
  assert.ok(svg.includes('revenue'));
  assert.ok(svg.includes('cost'));
});

test('line: カテゴリ軸はインデックスにラベルを割り当てる', () => {
  const svg = chartToSvg({
    type: 'line',
    categories: ['Jan', 'Feb', 'Mar'],
    series: [{ name: 'a', color: '#2563eb', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] }],
  });
  assert.ok(svg.includes('Jan'));
  assert.ok(svg.includes('Mar'));
  assert.ok(svg.includes('polyline'));
});

test('bar: カテゴリごとの rect を描く', () => {
  const svg = chartToSvg({
    type: 'bar',
    categories: ['A', 'B'],
    series: [{ name: 'v', color: '#16a34a', values: [3, 6], points: [] }],
  });
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('A'));
});

test('scatter: circle を描く', () => {
  const svg = chartToSvg({ type: 'scatter', series: lineSeries });
  assert.ok(svg.includes('<circle'));
});

test('box: 箱・ひげ・外れ値を描く', () => {
  const svg = chartToSvg({
    type: 'box',
    boxes: [
      {
        name: 'score',
        color: '#d97706',
        stats: { count: 9, min: 1, max: 100, q1: 3, median: 5, q3: 8, iqr: 5, whiskerLow: 1, whiskerHigh: 9, outliers: [100] },
      },
    ],
    yLabel: 'value',
  });
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('score'));
});

test('heatmap: 件数セルとカラーバーを描く', () => {
  const svg = chartToSvg({
    type: 'heatmap',
    heatmap: {
      counts: [[1, 0], [0, 2]],
      xEdges: [0, 1, 2],
      yEdges: [0, 1, 2],
      max: 2,
      rows: 2,
      cols: 2,
    },
    xLabel: 'x',
    yLabel: 'y',
  });
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('x'));
});

test('タイトル・ラベルの特殊文字をエスケープする', () => {
  const svg = chartToSvg({ type: 'line', title: '<script>&"', series: lineSeries });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('&amp;'));
});

test('空の系列でも例外にならない', () => {
  const svg = chartToSvg({ type: 'line', series: [] });
  assert.ok(svg.startsWith('<svg'));
});
