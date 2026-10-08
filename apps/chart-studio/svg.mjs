/**
 * svg.mjs — チャートをベクター SVG に書き出す純関数
 *
 * 画面表示は Chart.js / Canvas が担当し、書き出しはこのモジュールが
 * 同じデータから独立に SVG を組み立てる (ベクターなので拡大しても劣化しない)。
 * DOM に依存しないため node --test で検証できる。
 */

import { linearScale, logScale, niceTicks, logTicks, colorScale, formatNumber, HEATMAP_STOPS } from './pipeline.mjs';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DEFAULT_SIZE = { width: 960, height: 560 };
const MARGIN = { top: 56, right: 28, bottom: 64, left: 72 };

function themeOf(theme) {
  const dark = theme === 'dark';
  return {
    background: dark ? '#19191d' : '#ffffff',
    text: dark ? '#f1f5f9' : '#1e293b',
    text2: dark ? '#cbd5e1' : '#475569',
    grid: dark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.12)',
    axis: dark ? '#94a3b8' : '#64748b',
  };
}

function extent(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 0.5, hi + 0.5];
  return [lo, hi];
}

function axesFor(kind, domain, log, plot, ticks, fmt) {
  const scale = log ? logScale(domain, plot) : linearScale(domain, plot);
  const parts = [];
  for (const t of ticks) {
    if (log && t <= 0) continue;
    const p = kind === 'y' ? scale(t) : scale(t);
    if (!Number.isFinite(p)) continue;
    if (kind === 'y') {
      parts.push(`<line x1="${plot[0]}" y1="${p}" x2="${plot[1]}" y2="${p}" stroke="#cbd5e1" stroke-width="1" />`);
      parts.push(`<text x="${plot[0] - 8}" y="${p + 4}" text-anchor="end" font-size="12">${escapeXml(fmt(t))}</text>`);
    } else {
      parts.push(`<line x1="${p}" y1="${plot[2]}" x2="${p}" y2="${plot[3]}" stroke="#cbd5e1" stroke-width="1" />`);
      parts.push(`<text x="${p}" y="${plot[3] + 18}" text-anchor="middle" font-size="12">${escapeXml(fmt(t))}</text>`);
    }
  }
  return parts.join('');
}

/**
 * チャートを SVG 文字列にする。
 * @param {object} spec
 * @param {string} spec.type  line | bar | scatter | box | heatmap
 */
export function chartToSvg(spec) {
  const {
    type = 'line',
    title = '',
    xLabel = '',
    yLabel = '',
    logX = false,
    logY = false,
    showLegend = true,
    categories = [],
    series = [],
    boxes = [],
    heatmap = null,
    width = DEFAULT_SIZE.width,
    height = DEFAULT_SIZE.height,
    theme = 'light',
  } = spec;

  const t = themeOf(theme);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'DM Sans','Noto Sans JP',sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${t.background}" />`);

  if (title) {
    parts.push(`<text x="${width / 2}" y="30" text-anchor="middle" font-size="18" font-weight="700" fill="${t.text}">${escapeXml(title)}</text>`);
  }

  const plot = [MARGIN.left, width - MARGIN.right, MARGIN.top, height - MARGIN.bottom];

  if (type === 'heatmap' && heatmap) {
    drawHeatmap(parts, heatmap, plot, t, xLabel, yLabel);
  } else if (type === 'box') {
    drawBoxes(parts, boxes, plot, t, yLabel, logY);
  } else if (type === 'bar') {
    drawBars(parts, categories, series, plot, t, xLabel, yLabel, logY);
  } else {
    drawPoints(parts, type, series, logX, logY, plot, t, xLabel, yLabel, categories);
  }

  if (showLegend && series.length > 1 && type !== 'box' && type !== 'heatmap') {
    drawLegend(parts, series, width, t);
  }
  if (showLegend && type === 'box' && boxes.length > 1) {
    drawLegend(parts, boxes.map((b) => ({ name: b.name, color: b.color })), width, t);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function drawAxesLabels(parts, plot, t, xLabel, yLabel) {
  if (xLabel) {
    parts.push(`<text x="${(plot[0] + plot[1]) / 2}" y="${plot[3] + 48}" text-anchor="middle" font-size="13" fill="${t.text2}">${escapeXml(xLabel)}</text>`);
  }
  if (yLabel) {
    const cx = 20;
    const cy = (plot[2] + plot[3]) / 2;
    parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="13" fill="${t.text2}" transform="rotate(-90 ${cx} ${cy})">${escapeXml(yLabel)}</text>`);
  }
}

function drawPoints(parts, type, series, logX, logY, plot, t, xLabel, yLabel, categories = []) {
  const hasCats = categories.length > 0;
  const allX = [];
  const allY = [];
  for (const s of series) for (const p of s.points) { allX.push(p.x); allY.push(p.y); }
  let xDomain = hasCats ? [-0.5, categories.length - 0.5] : extent(allX);
  let yDomain = extent(allY);
  if (!hasCats && logX) xDomain = [Math.max(1e-9, xDomain[0]), xDomain[1]];
  if (logY) yDomain = [Math.max(1e-9, yDomain[0]), yDomain[1]];

  const xTicks = hasCats
    ? categories.map((_, i) => i)
    : logX ? logTicks(xDomain[0], xDomain[1]) : niceTicks(xDomain[0], xDomain[1], 6);
  const yTicks = logY ? logTicks(yDomain[0], yDomain[1]) : niceTicks(yDomain[0], yDomain[1], 6);
  const xs = hasCats || !logX
    ? linearScale(xDomain, [plot[0], plot[1]])
    : logScale(xDomain, [plot[0], plot[1]]);
  const ys = logY ? logScale(yDomain, [plot[3], plot[2]]) : linearScale(yDomain, [plot[3], plot[2]]);

  parts.push(axesFor('y', yDomain, logY, plot, yTicks, (v) => formatNumber(v, 2)));
  const xFmt = hasCats ? (v) => shorten(categories[Math.round(v)] ?? '', 10) : (v) => formatNumber(v, 2);
  parts.push(axesFor('x', xDomain, !hasCats && logX, plot, xTicks, xFmt));

  // 枠
  parts.push(`<rect x="${plot[0]}" y="${plot[2]}" width="${plot[1] - plot[0]}" height="${plot[3] - plot[2]}" fill="none" stroke="${t.axis}" stroke-width="1" />`);

  for (const s of series) {
    const pts = s.points
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => `${xs(p.x).toFixed(2)},${ys(p.y).toFixed(2)}`);
    if (!pts.length) continue;
    if (type === 'line') {
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" />`);
    }
    if (type === 'scatter' || type === 'line') {
      const r = type === 'scatter' ? 3 : 2.5;
      for (const p of s.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        parts.push(`<circle cx="${xs(p.x).toFixed(2)}" cy="${ys(p.y).toFixed(2)}" r="${r}" fill="${s.color}" />`);
      }
    }
  }
  drawAxesLabels(parts, plot, t, xLabel, yLabel);
}

function drawBars(parts, categories, series, plot, t, xLabel, yLabel, logY) {
  const values = [];
  for (const s of series) for (const v of s.values) values.push(v);
  let yDomain = extent(values);
  yDomain = [Math.min(0, yDomain[0]), Math.max(0, yDomain[1])];
  const yTicks = niceTicks(yDomain[0], yDomain[1], 6);
  const ys = linearScale(yDomain, [plot[3], plot[2]]);

  parts.push(axesFor('y', yDomain, false, plot, yTicks, (v) => formatNumber(v, 2)));

  const n = Math.max(1, categories.length);
  const band = (plot[1] - plot[0]) / n;
  const groupPad = 0.18;
  const groupWidth = band * (1 - groupPad);
  const barWidth = groupWidth / Math.max(1, series.length);

  const zeroY = ys(0);
  categories.forEach((cat, ci) => {
    const cx = plot[0] + band * ci;
    parts.push(`<text x="${(cx + band / 2).toFixed(2)}" y="${plot[3] + 18}" text-anchor="middle" font-size="11" fill="${t.text2}">${escapeXml(shorten(cat, 10))}</text>`);
  });

  series.forEach((s, si) => {
    s.values.forEach((v, ci) => {
      if (!Number.isFinite(v)) return;
      const x = plot[0] + band * ci + groupPad * band * 0.5 + barWidth * si;
      const y = ys(v);
      const top = Math.min(y, zeroY);
      const h = Math.abs(y - zeroY);
      parts.push(`<rect x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" fill="${s.color}" />`);
    });
  });

  parts.push(`<line x1="${plot[0]}" y1="${zeroY.toFixed(2)}" x2="${plot[1]}" y2="${zeroY.toFixed(2)}" stroke="${t.axis}" stroke-width="1" />`);
  drawAxesLabels(parts, plot, t, xLabel, yLabel);
}

function drawBoxes(parts, boxes, plot, t, yLabel, logY) {
  const all = [];
  for (const b of boxes) {
    all.push(b.stats.whiskerLow, b.stats.whiskerHigh, ...(b.stats.outliers ?? []));
  }
  const yDomain = extent(all);
  const yTicks = niceTicks(yDomain[0], yDomain[1], 6);
  const ys = linearScale(yDomain, [plot[3], plot[2]]);
  parts.push(axesFor('y', yDomain, false, plot, yTicks, (v) => formatNumber(v, 2)));

  const n = Math.max(1, boxes.length);
  const band = (plot[1] - plot[0]) / n;
  const boxW = Math.min(72, band * 0.5);

  boxes.forEach((b, i) => {
    const cx = plot[0] + band * (i + 0.5);
    const s = b.stats;
    const x0 = cx - boxW / 2;
    const q1y = ys(s.q1);
    const q3y = ys(s.q3);
    const medY = ys(s.median);
    const wloY = ys(s.whiskerLow);
    const whiY = ys(s.whiskerHigh);
    parts.push(`<line x1="${cx}" y1="${whiY.toFixed(2)}" x2="${cx}" y2="${q3y.toFixed(2)}" stroke="${b.color}" stroke-width="2" />`);
    parts.push(`<line x1="${cx}" y1="${q1y.toFixed(2)}" x2="${cx}" y2="${wloY.toFixed(2)}" stroke="${b.color}" stroke-width="2" />`);
    parts.push(`<line x1="${cx - boxW / 4}" y1="${whiY.toFixed(2)}" x2="${cx + boxW / 4}" y2="${whiY.toFixed(2)}" stroke="${b.color}" stroke-width="2" />`);
    parts.push(`<line x1="${cx - boxW / 4}" y1="${wloY.toFixed(2)}" x2="${cx + boxW / 4}" y2="${wloY.toFixed(2)}" stroke="${b.color}" stroke-width="2" />`);
    parts.push(`<rect x="${x0.toFixed(2)}" y="${q3y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${Math.abs(q1y - q3y).toFixed(2)}" fill="${b.color}" fill-opacity="0.25" stroke="${b.color}" stroke-width="2" />`);
    parts.push(`<line x1="${x0.toFixed(2)}" y1="${medY.toFixed(2)}" x2="${(x0 + boxW).toFixed(2)}" y2="${medY.toFixed(2)}" stroke="${b.color}" stroke-width="3" />`);
    for (const o of s.outliers ?? []) {
      parts.push(`<circle cx="${cx.toFixed(2)}" cy="${ys(o).toFixed(2)}" r="2.5" fill="none" stroke="${b.color}" stroke-width="1.5" />`);
    }
    parts.push(`<text x="${cx.toFixed(2)}" y="${plot[3] + 18}" text-anchor="middle" font-size="11" fill="${t.text2}">${escapeXml(shorten(b.name, 12))}</text>`);
  });

  parts.push(`<rect x="${plot[0]}" y="${plot[2]}" width="${plot[1] - plot[0]}" height="${plot[3] - plot[2]}" fill="none" stroke="${t.axis}" stroke-width="1" />`);
  drawAxesLabels(parts, plot, t, '', yLabel);
}

function drawHeatmap(parts, hm, plot, t, xLabel, yLabel) {
  const { counts, xEdges, yEdges, max, rows, cols } = hm;
  if (!counts.length) return;
  const xs = linearScale([xEdges[0], xEdges[xEdges.length - 1]], [plot[0], plot[1]]);
  const ys = linearScale([yEdges[0], yEdges[yEdges.length - 1]], [plot[3], plot[2]]);

  const xTicks = niceTicks(xEdges[0], xEdges[xEdges.length - 1], 6);
  const yTicks = niceTicks(yEdges[0], yEdges[yEdges.length - 1], 6);
  parts.push(axesFor('y', [yEdges[0], yEdges[yEdges.length - 1]], false, plot, yTicks, (v) => formatNumber(v, 2)));
  parts.push(axesFor('x', [xEdges[0], xEdges[xEdges.length - 1]], false, plot, xTicks, (v) => formatNumber(v, 2)));

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = counts[r][c];
      const x0 = xs(xEdges[c]);
      const x1 = xs(xEdges[c + 1]);
      const y0 = ys(yEdges[r + 1]);
      const y1 = ys(yEdges[r]);
      const fill = v === 0 ? 'transparent' : colorScale(max ? v / max : 0, HEATMAP_STOPS);
      parts.push(`<rect x="${x0.toFixed(2)}" y="${y0.toFixed(2)}" width="${Math.max(0, x1 - x0).toFixed(2)}" height="${Math.max(0, y1 - y0).toFixed(2)}" fill="${fill}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5" />`);
    }
  }

  // カラーバー
  const barW = 14;
  const barX = plot[1] + 10;
  for (let s = 0; s < 60; s += 1) {
    const tt = s / 59;
    parts.push(`<rect x="${barX}" y="${plot[2] + (1 - tt) * (plot[3] - plot[2])}" width="${barW}" height="${(plot[3] - plot[2]) / 60 + 0.5}" fill="${colorScale(tt, HEATMAP_STOPS)}" />`);
  }
  parts.push(`<text x="${barX + barW + 6}" y="${plot[2] + 6}" font-size="11" fill="${t.text2}">${max}</text>`);
  parts.push(`<text x="${barX + barW + 6}" y="${plot[3]}" font-size="11" fill="${t.text2}">0</text>`);

  parts.push(`<rect x="${plot[0]}" y="${plot[2]}" width="${plot[1] - plot[0]}" height="${plot[3] - plot[2]}" fill="none" stroke="${t.axis}" stroke-width="1" />`);
  drawAxesLabels(parts, plot, t, xLabel, yLabel);
}

function drawLegend(parts, series, width, t) {
  let x = MARGIN.left;
  const y = 48;
  for (const s of series) {
    parts.push(`<rect x="${x}" y="${y - 9}" width="12" height="12" fill="${s.color}" rx="2" />`);
    parts.push(`<text x="${x + 18}" y="${y + 1}" font-size="12" fill="${t.text2}">${escapeXml(s.name)}</text>`);
    x += 24 + String(s.name).length * 8;
    if (x > width - 120) break;
  }
}

function shorten(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
