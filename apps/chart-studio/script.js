/**
 * script.js — Chart Studio のメインスレッド
 *
 * 表データを読み、Chart.js (折れ線/棒/散布) または Canvas (箱ひげ/ヒートマップ) で
 * 描画し、SVG / PNG / 設定 JSON に書き出す。入力データはどこにも送信しない。
 * 解析・統計・目盛り・正規化・ビニング・色割当の純ロジックは pipeline.mjs にある。
 */

import {
  HANDOFF_KEY,
  MAX_PREVIEW_ROWS,
  parseTable,
  columnValues,
  pairedValues,
  boxStats,
  niceTicks,
  linearScale,
  heatmapGrid,
  normalize,
  seriesColors,
  colorScale,
  formatNumber,
} from './pipeline.mjs';
import { chartToSvg } from './svg.mjs';

const $ = (id) => document.getElementById(id);

/* ==========================================================
   DOM
   ========================================================== */

const inputData = $('input-data');
const delimiterEl = $('delimiter-select');
const optHeaderEl = $('opt-header');
const optTrimEl = $('opt-trim');
const inputInfo = $('input-info');
const dropZone = $('drop-zone');
const fileInput = $('file-input');
const btnSample = $('btn-sample');
const btnPaste = $('btn-paste');
const btnClear = $('btn-clear');
const statRows = $('stat-rows');
const statCols = $('stat-cols');
const previewTable = $('preview-table');

const chartType = $('chart-type-select');
const xColumn = $('x-column-select');
const yColumns = $('y-columns');
const groupColumn = $('group-column-select');
const optLogX = $('opt-log-x');
const optLogY = $('opt-log-y');
const optLegend = $('opt-legend');
const normalizeSelect = $('normalize-select');
const paletteSelect = $('palette-select');
const binRange = $('bin-count-range');
const binValue = $('bin-count-value');
const titleInput = $('chart-title-input');
const xLabelInput = $('x-label-input');
const yLabelInput = $('y-label-input');

const canvas = $('chart-canvas');
const chartEmpty = $('chart-empty');
const chartError = $('chart-error');
const chartStatus = $('chart-status');
const btnExportPng = $('btn-export-png');
const btnExportSvg = $('btn-export-svg');
const btnCopyConfig = $('btn-copy-config');
const exportJson = $('export-json');

/* ==========================================================
   状態
   ========================================================== */

const state = {
  headers: [],
  rows: [],
  types: [],
  delimiter: ',',
  chart: null,
  lastSpec: null,
  signature: '',
};

const SAMPLE = `month,revenue,cost,users
2026-01,120,80,210
2026-02,132,85,224
2026-03,128,90,231
2026-04,151,96,248
2026-05,167,101,260
2026-06,159,99,255
2026-07,178,110,279
2026-08,186,112,288
2026-09,201,120,301
2026-10,214,126,317`;

/* ==========================================================
   ユーティリティ
   ========================================================== */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDark() {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function setStatus(text) {
  chartStatus.textContent = text;
}

function showError(message) {
  chartError.textContent = message;
  chartError.hidden = false;
}

function clearError() {
  chartError.textContent = '';
  chartError.hidden = true;
}

/* ==========================================================
   入力の読み取り
   ========================================================== */

function readInput() {
  const text = inputData.value;
  if (!text.trim()) {
    state.headers = [];
    state.rows = [];
    state.types = [];
    state.signature = '';
    inputInfo.textContent = 'まだデータがありません。';
    statRows.textContent = '0';
    statCols.textContent = '0';
    previewTable.innerHTML = '';
    syncSelectors(true);
    clearChart('データを入力してください。');
    updateConfigJson();
    return;
  }

  const table = parseTable(text, {
    delimiter: delimiterEl.value,
    header: optHeaderEl.checked,
    trim: optTrimEl.checked,
  });

  state.headers = table.headers;
  state.rows = table.rows;
  state.types = table.types;
  state.delimiter = table.delimiter;

  const label = table.delimiter === '\t' ? 'タブ' : table.delimiter;
  inputInfo.textContent = `区切り: ${label} ｜ ${table.rows.length} 行 × ${table.headers.length} 列`;
  statRows.textContent = String(table.rows.length);
  statCols.textContent = String(table.headers.length);

  syncSelectors();
  updatePreview();
  render();
}

function setInputText(text) {
  inputData.value = text;
  readInput();
}

/* ==========================================================
   列セレクタの同期
   ========================================================== */

function syncSelectors(force = false) {
  const signature = `${state.headers.join('\u0001')}|${state.types.join(',')}`;
  if (!force && signature === state.signature) return;
  state.signature = signature;

  const headers = state.headers;
  const numericIdx = headers.map((_, i) => i).filter((i) => state.types[i] === 'number');
  const catIdx = headers.map((_, i) => i).filter((i) => state.types[i] !== 'number');

  xColumn.innerHTML = headers.length
    ? headers.map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`).join('')
    : '<option value="0">—</option>';

  const defaultY = numericIdx.slice(0, 2);
  yColumns.innerHTML = numericIdx.length
    ? numericIdx
        .map((i) => {
          const checked = defaultY.includes(i) ? 'checked' : '';
          return `<label><input type="checkbox" data-index="${i}" data-name="${escapeHtml(headers[i])}" ${checked}> ${escapeHtml(headers[i])}</label>`;
        })
        .join('')
    : '<span class="hint">数値列がありません</span>';

  groupColumn.innerHTML = ['<option value="-1">（なし）</option>']
    .concat(catIdx.map((i) => `<option value="${i}">${escapeHtml(headers[i])}</option>`))
    .join('');
}

function selectedYIndices() {
  return [...yColumns.querySelectorAll('input:checked')].map((el) => Number(el.dataset.index));
}

/* ==========================================================
   プレビュー
   ========================================================== */

function updatePreview() {
  if (!state.rows.length) {
    previewTable.innerHTML = '';
    return;
  }
  const head = state.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = state.rows
    .slice(0, MAX_PREVIEW_ROWS)
    .map((row) => `<tr>${state.headers.map((_, i) => `<td>${escapeHtml(row[i] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  previewTable.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ==========================================================
   仕様の構築
   ========================================================== */

function parseError(message) {
  showError(message);
  return null;
}

function allFinitePositive(values) {
  return values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0);
}

function normalizePoints(points, method) {
  if (method === 'none') return points;
  const ys = normalize(points.map((p) => p.y), method);
  return points.map((p, i) => ({ x: p.x, y: ys[i] })).filter((p) => Number.isFinite(p.y));
}

function buildSpec() {
  clearError();

  if (!state.rows.length) {
    clearChart('データを入力してください。');
    return null;
  }

  const type = chartType.value;
  const xIndex = Number(xColumn.value);
  const yIndices = selectedYIndices();
  const groupIndex = Number(groupColumn.value);
  const method = normalizeSelect.value;
  const palette = paletteSelect.value;
  const logX = optLogX.checked;
  const logY = optLogY.checked;
  const showLegend = optLegend.checked;
  const title = titleInput.value.trim();
  const xLabel = xLabelInput.value.trim();
  const yLabel = yLabelInput.value.trim();
  const headers = state.headers;

  if (!yIndices.length) return parseError('Y 軸の数値列を 1 つ以上選んでください。');

  if (type === 'heatmap') {
    if (state.types[xIndex] !== 'number') return parseError('ヒートマップの X 軸には数値列を選んでください。');
    const yAxisIndex = yIndices[0];
    if (state.types[yAxisIndex] !== 'number') return parseError('ヒートマップの Y 軸には数値列を選んでください。');
    const pairs = pairedValues(state.rows, xIndex, yAxisIndex);
    if (!pairs.length) return parseError('数値の組がありません。');
    const bins = Number(binRange.value);
    const grid = heatmapGrid(
      pairs.map((p) => p.x),
      pairs.map((p) => p.y),
      bins,
      bins,
    );
    return {
      type: 'heatmap',
      title,
      xLabel: xLabel || headers[xIndex],
      yLabel: yLabel || headers[yAxisIndex],
      logX: false,
      logY: false,
      showLegend,
      categories: [],
      series: [],
      boxes: [],
      heatmap: grid,
    };
  }

  if (type === 'box') {
    const colors = seriesColors(yIndices.length, palette);
    const boxes = yIndices.map((yi, k) => {
      const raw = columnValues(state.rows, yi, { numeric: true });
      const values = method === 'none' ? raw : normalize(raw, method);
      return { name: headers[yi], color: colors[k], stats: boxStats(values) };
    });
    return {
      type: 'box',
      title,
      xLabel: '',
      yLabel: yLabel || (method === 'none' ? '値' : method === 'minmax' ? '正規化 (0–1)' : 'z-score'),
      logX: false,
      logY: false,
      showLegend,
      categories: [],
      series: [],
      boxes,
      heatmap: null,
    };
  }

  if (type === 'bar') {
    const rowsIdx = state.rows.map((r, i) => i).filter((i) => String(state.rows[i][xIndex] ?? '') !== '');
    const categories = rowsIdx.map((i) => String(state.rows[i][xIndex]));
    const colors = seriesColors(yIndices.length, palette);
    const series = yIndices.map((yi, k) => ({
      name: headers[yi],
      color: colors[k],
      values: rowsIdx.map((i) => toNumberSafe(state.rows[i][yi])),
      points: [],
    }));
    if (method !== 'none') {
      for (const s of series) s.values = normalize(s.values, method);
    }
    return {
      type: 'bar',
      title,
      xLabel: xLabel || headers[xIndex],
      yLabel: yLabel,
      logX: false,
      logY,
      showLegend,
      categories,
      series,
      boxes: [],
      heatmap: null,
    };
  }

  if (type === 'scatter') {
    if (state.types[xIndex] !== 'number') return parseError('散布図の X 軸には数値列を選んでください。');
    const colors = seriesColors(groupIndex >= 0 ? 8 : yIndices.length, palette);
    let series;
    if (groupIndex >= 0 && yIndices.length) {
      const yIdx = yIndices[0];
      const groups = new Map();
      for (const row of state.rows) {
        const g = String(row[groupIndex] ?? '');
        if (g === '') continue;
        const x = Number(row[xIndex]);
        const y = Number(row[yIdx]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ x, y });
      }
      series = [...groups.entries()].map(([name, points], k) => ({
        name,
        color: colors[k % colors.length],
        points: normalizePoints(points, method),
      }));
    } else {
      series = yIndices.map((yi, k) => ({
        name: headers[yi],
        color: colors[k],
        points: normalizePoints(pairedValues(state.rows, xIndex, yi), method),
      }));
    }
    return {
      type: 'scatter',
      title,
      xLabel: xLabel || headers[xIndex],
      yLabel: yLabel,
      logX,
      logY,
      showLegend,
      categories: [],
      series,
      boxes: [],
      heatmap: null,
    };
  }

  // line (既定)
  const isCategoryX = state.types[xIndex] !== 'number';
  const colors = seriesColors(yIndices.length, palette);
  let series;
  let categories = [];
  if (isCategoryX) {
    const rowsIdx = state.rows.map((r, i) => i).filter((i) => String(state.rows[i][xIndex] ?? '') !== '');
    categories = rowsIdx.map((i) => String(state.rows[i][xIndex]));
    series = yIndices.map((yi, k) => {
      const aligned = rowsIdx.map((i) => toNumberSafe(state.rows[i][yi]));
      const values = method === 'none' ? aligned : normalize(aligned, method);
      return {
        name: headers[yi],
        color: colors[k],
        values,
        points: values
          .map((y, pos) => ({ x: pos, y }))
          .filter((p) => Number.isFinite(p.y)),
      };
    });
  } else {
    series = yIndices.map((yi, k) => ({
      name: headers[yi],
      color: colors[k],
      points: normalizePoints(pairedValues(state.rows, xIndex, yi), method),
    }));
  }

  return {
    type: 'line',
    title,
    xLabel: xLabel || headers[xIndex],
    yLabel: yLabel,
    logX: isCategoryX ? false : logX,
    logY,
    showLegend,
    categories,
    series,
    boxes: [],
    heatmap: null,
  };
}

function toNumberSafe(value) {
  const n = Number(value);
  return value === '' || value === null || value === undefined ? NaN : n;
}

/* ==========================================================
   描画: Chart.js
   ========================================================== */

const bgPlugin = {
  id: 'chartStudioBg',
  beforeDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = isDark() ? '#19191d' : '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
}

function renderChartJs(spec) {
  if (typeof window.Chart === 'undefined') {
    showError('グラフライブラリ (Chart.js) を読み込めませんでした。ネットワーク接続を確認してください。');
    return;
  }
  destroyChart();
  resetCanvasSize();

  const dark = isDark();
  const gridColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)';
  const tickColor = dark ? '#cbd5e1' : '#475569';

  // 対数軸の妥当性チェック
  let logY = spec.logY;
  const yValues = spec.series.flatMap((s) => (s.points.length ? s.points.map((p) => p.y) : s.values));
  if (logY && !allFinitePositive(yValues)) {
    logY = false;
    setStatus('Y 対数軸には正の値のみ使えるため、線形軸で表示しました。');
  } else {
    setStatus(statusText(spec));
  }
  let logX = spec.logX;
  if (logX) {
    const xValues = spec.series.flatMap((s) => s.points.map((p) => p.x));
    if (!allFinitePositive(xValues)) {
      logX = false;
      setStatus('X 対数軸には正の値のみ使えるため、線形軸で表示しました。');
    }
  }

  const xScale = {
    type: logX ? 'logarithmic' : 'linear',
    ticks: { color: tickColor },
    grid: { color: gridColor },
    title: { display: !!spec.xLabel, text: spec.xLabel, color: tickColor },
  };
  const yScale = {
    type: logY ? 'logarithmic' : 'linear',
    ticks: { color: tickColor },
    grid: { color: gridColor },
    title: { display: !!spec.yLabel, text: spec.yLabel, color: tickColor },
  };

  let chartJsType = 'line';
  let labels;
  let datasets;

  if (spec.type === 'bar') {
    chartJsType = 'bar';
    labels = spec.categories;
    xScale.type = 'category';
    datasets = spec.series.map((s) => ({
      label: s.name,
      data: s.values,
      backgroundColor: s.color,
      borderColor: s.color,
      borderWidth: 0,
    }));
  } else if (spec.type === 'scatter') {
    chartJsType = 'scatter';
    datasets = spec.series.map((s) => ({
      label: s.name,
      data: s.points,
      backgroundColor: s.color,
      borderColor: s.color,
      pointRadius: 3,
      showLine: false,
    }));
  } else if (spec.categories.length) {
    chartJsType = 'line';
    labels = spec.categories;
    xScale.type = 'category';
    datasets = spec.series.map((s) => ({
      label: s.name,
      data: s.values && s.values.length ? s.values : s.points.map((p) => p.y),
      borderColor: s.color,
      backgroundColor: s.color,
      tension: 0.25,
      pointRadius: 2,
      spanGaps: true,
    }));
  } else {
    chartJsType = 'line';
    datasets = spec.series.map((s) => ({
      label: s.name,
      data: s.points,
      borderColor: s.color,
      backgroundColor: s.color,
      tension: 0.25,
      pointRadius: 2,
      spanGaps: true,
    }));
  }

  state.chart = new window.Chart(canvas.getContext('2d'), {
    type: chartJsType,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: spec.showLegend, labels: { color: tickColor } },
        title: { display: !!spec.title, text: spec.title, color: tickColor, font: { size: 16 } },
      },
      scales: { x: xScale, y: yScale },
    },
    plugins: [bgPlugin],
  });

  chartEmpty.style.display = 'none';
}

/* ==========================================================
   描画: Canvas (箱ひげ・ヒートマップ)
   ========================================================== */

function resetCanvasSize() {
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}

function prepareCustomCanvas() {
  destroyChart();
  const stage = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = stage.clientWidth || 960;
  const height = stage.clientHeight || 520;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = isDark();
  ctx.fillStyle = dark ? '#19191d' : '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height, dark };
}

function colorsForCanvas(dark) {
  return {
    text: dark ? '#f1f5f9' : '#1e293b',
    text2: dark ? '#cbd5e1' : '#475569',
    grid: dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)',
    axis: dark ? '#94a3b8' : '#64748b',
  };
}

function drawTitle(ctx, width, title, color) {
  if (!title) return 34;
  ctx.fillStyle = color;
  ctx.font = '700 16px "DM Sans","Noto Sans JP",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 26);
  ctx.textAlign = 'left';
  return 44;
}

function drawAxisLabels(ctx, plot, xLabel, yLabel, color) {
  ctx.fillStyle = color;
  ctx.font = '12px "DM Sans","Noto Sans JP",sans-serif';
  if (xLabel) {
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, (plot[0] + plot[1]) / 2, plot[3] + 44);
  }
  if (yLabel) {
    ctx.save();
    ctx.translate(18, (plot[2] + plot[3]) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }
  ctx.textAlign = 'left';
}

function renderBoxCanvas(spec) {
  const { ctx, width, height, dark } = prepareCustomCanvas();
  const c = colorsForCanvas(dark);
  const top = drawTitle(ctx, width, spec.title, c.text);
  const plot = [72, width - 28, top + 12, height - 60];

  const all = [];
  for (const b of spec.boxes) all.push(b.stats.whiskerLow, b.stats.whiskerHigh, ...(b.stats.outliers ?? []));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const ticks = niceTicks(lo, hi, 6);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const ys = linearScale([lo, hi], [plot[3], plot[2]]);

  // グリッド + Y 目盛り
  ctx.font = '12px "DM Sans","Noto Sans JP",sans-serif';
  for (const t of ticks) {
    const y = ys(t);
    ctx.strokeStyle = c.grid;
    ctx.beginPath(); ctx.moveTo(plot[0], y); ctx.lineTo(plot[1], y); ctx.stroke();
    ctx.fillStyle = c.text2;
    ctx.textAlign = 'right';
    ctx.fillText(formatNumber(t), plot[0] - 8, y + 4);
  }
  ctx.textAlign = 'left';

  const n = Math.max(1, spec.boxes.length);
  const band = (plot[1] - plot[0]) / n;
  const boxW = Math.min(72, band * 0.5);

  spec.boxes.forEach((b, i) => {
    const cx = plot[0] + band * (i + 0.5);
    const s = b.stats;
    if (!Number.isFinite(s.median)) return;
    const q1y = ys(s.q1);
    const q3y = ys(s.q3);
    const medY = ys(s.median);
    const wloY = ys(s.whiskerLow);
    const whiY = ys(s.whiskerHigh);

    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, whiY); ctx.lineTo(cx, q3y);
    ctx.moveTo(cx, q1y); ctx.lineTo(cx, wloY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - boxW / 4, whiY); ctx.lineTo(cx + boxW / 4, whiY);
    ctx.moveTo(cx - boxW / 4, wloY); ctx.lineTo(cx + boxW / 4, wloY);
    ctx.stroke();

    ctx.fillStyle = b.color;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(cx - boxW / 2, Math.min(q1y, q3y), boxW, Math.abs(q1y - q3y));
    ctx.globalAlpha = 1;
    ctx.strokeRect(cx - boxW / 2, Math.min(q1y, q3y), boxW, Math.abs(q1y - q3y));

    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - boxW / 2, medY); ctx.lineTo(cx + boxW / 2, medY);
    ctx.stroke();

    for (const o of s.outliers ?? []) {
      ctx.beginPath();
      ctx.arc(cx, ys(o), 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = c.text2;
    ctx.font = '12px "DM Sans","Noto Sans JP",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(shortenText(b.name, 12), cx, plot[3] + 18);
    ctx.textAlign = 'left';
  });

  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot[0], plot[2], plot[1] - plot[0], plot[3] - plot[2]);
  drawAxisLabels(ctx, plot, spec.xLabel, spec.yLabel, c.text2);
  chartEmpty.style.display = 'none';
  setStatus(`${spec.boxes.length} 系列 × ${spec.boxes[0]?.stats.count ?? 0} 値`);
}

function renderHeatmapCanvas(spec) {
  const { ctx, width, height, dark } = prepareCustomCanvas();
  const c = colorsForCanvas(dark);
  const top = drawTitle(ctx, width, spec.title, c.text);
  const hm = spec.heatmap;
  const plot = [72, width - 96, top + 12, height - 60];

  if (!hm || !hm.counts.length) {
    clearChart('ヒートマップに使える数値の組がありません。');
    return;
  }

  const x0 = hm.xEdges[0];
  const x1 = hm.xEdges[hm.xEdges.length - 1];
  const y0 = hm.yEdges[0];
  const y1 = hm.yEdges[hm.yEdges.length - 1];
  const xs = linearScale([x0, x1], [plot[0], plot[1]]);
  const ys = linearScale([y0, y1], [plot[3], plot[2]]);
  const xTicks = niceTicks(x0, x1, 6);
  const yTicks = niceTicks(y0, y1, 6);

  ctx.font = '12px "DM Sans","Noto Sans JP",sans-serif';
  for (const t of yTicks) {
    const y = ys(t);
    ctx.strokeStyle = c.grid;
    ctx.beginPath(); ctx.moveTo(plot[0], y); ctx.lineTo(plot[1], y); ctx.stroke();
    ctx.fillStyle = c.text2;
    ctx.textAlign = 'right';
    ctx.fillText(formatNumber(t), plot[0] - 8, y + 4);
  }
  for (const t of xTicks) {
    const x = xs(t);
    ctx.strokeStyle = c.grid;
    ctx.beginPath(); ctx.moveTo(x, plot[2]); ctx.lineTo(x, plot[3]); ctx.stroke();
    ctx.fillStyle = c.text2;
    ctx.textAlign = 'center';
    ctx.fillText(formatNumber(t), x, plot[3] + 18);
  }
  ctx.textAlign = 'left';

  for (let r = 0; r < hm.rows; r += 1) {
    for (let col = 0; col < hm.cols; col += 1) {
      const v = hm.counts[r][col];
      if (v === 0) continue;
      const rx = xs(hm.xEdges[col]);
      const rw = xs(hm.xEdges[col + 1]) - rx;
      const ry = ys(hm.yEdges[r + 1]);
      const rh = ys(hm.yEdges[r]) - ry;
      ctx.fillStyle = colorScale(hm.max ? v / hm.max : 0);
      ctx.fillRect(rx, ry, Math.max(0, rw), Math.max(0, rh));
    }
  }

  // カラーバー
  const barX = plot[1] + 14;
  const barW = 14;
  const steps = 48;
  for (let s = 0; s < steps; s += 1) {
    const tt = s / (steps - 1);
    ctx.fillStyle = colorScale(tt);
    ctx.fillRect(barX, plot[2] + (1 - tt) * (plot[3] - plot[2]), barW, (plot[3] - plot[2]) / steps + 0.6);
  }
  ctx.fillStyle = c.text2;
  ctx.fillText(String(hm.max), barX + barW + 6, plot[2] + 6);
  ctx.fillText('0', barX + barW + 6, plot[3]);

  ctx.strokeStyle = c.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot[0], plot[2], plot[1] - plot[0], plot[3] - plot[2]);
  drawAxisLabels(ctx, plot, spec.xLabel, spec.yLabel, c.text2);
  chartEmpty.style.display = 'none';
  setStatus(`ヒートマップ ${hm.cols}×${hm.rows} ビン / 最大 ${hm.max}`);
}

function shortenText(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ==========================================================
   メイン描画
   ========================================================== */

function statusText(spec) {
  if (spec.type === 'bar') return `${spec.series.length} 系列 × ${spec.categories.length} カテゴリ`;
  if (spec.type === 'scatter') return `散布図 ${spec.series.length} 系列`;
  return `${spec.series.length} 系列 / ${spec.series.reduce((n, s) => n + s.points.length, 0)} 点`;
}

function render() {
  const spec = buildSpec();
  state.lastSpec = spec;
  if (!spec) {
    if (!chartError.hidden) {
      destroyChart();
      resetCanvasSize();
      chartEmpty.textContent = 'グラフを表示できません。設定を見直してください。';
      chartEmpty.style.display = 'flex';
    }
    updateConfigJson();
    return;
  }
  if (spec.type === 'box') renderBoxCanvas(spec);
  else if (spec.type === 'heatmap') renderHeatmapCanvas(spec);
  else renderChartJs(spec);
  updateConfigJson();
}

function clearChart(message) {
  destroyChart();
  resetCanvasSize();
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  chartEmpty.textContent = message || 'グラフがここに表示されます。';
  chartEmpty.style.display = 'flex';
  setStatus(message || 'データを入力してください。');
}

/* ==========================================================
   書き出し
   ========================================================== */

function fileBaseName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `chart-studio-${state.lastSpec?.type ?? 'chart'}-${stamp}`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPng() {
  if (!state.lastSpec) return;
  canvas.toBlob((blob) => {
    if (blob) download(blob, `${fileBaseName()}.png`);
  }, 'image/png');
}

function exportSvg() {
  if (!state.lastSpec) return;
  const svg = chartToSvg({
    ...state.lastSpec,
    width: 960,
    height: 560,
    theme: isDark() ? 'dark' : 'light',
  });
  download(new Blob([svg], { type: 'image/svg+xml' }), `${fileBaseName()}.svg`);
}

function buildConfig() {
  const spec = state.lastSpec;
  return {
    app: 'chart-studio',
    version: 1,
    generatedAt: new Date().toISOString(),
    net: {
      externalHosts: ['cdn.jsdelivr.net'],
      sendsData: false,
    },
    source: {
      delimiter: state.delimiter,
      hasHeader: optHeaderEl.checked,
      rowCount: state.rows.length,
      columns: state.headers,
      types: state.types,
    },
    chart: spec
      ? {
          type: spec.type,
          title: spec.title,
          xLabel: spec.xLabel,
          yLabel: spec.yLabel,
          logX: spec.logX,
          logY: spec.logY,
          legend: spec.showLegend,
          normalize: normalizeSelect.value,
          palette: paletteSelect.value,
          bins: Number(binRange.value),
        }
      : null,
    sampleRows: state.rows.slice(0, 10),
  };
}

function updateConfigJson() {
  exportJson.value = JSON.stringify(buildConfig(), null, 2);
}

async function copyConfig() {
  updateConfigJson();
  try {
    await navigator.clipboard.writeText(exportJson.value);
    setStatus('設定 JSON をコピーしました。');
  } catch {
    exportJson.select();
    document.execCommand('copy');
    setStatus('設定 JSON をコピーしました。');
  }
}

/* ==========================================================
   ファイル・貼り付け・ハンドオフ
   ========================================================== */

function readFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') setInputText(reader.result);
  };
  reader.readAsText(file);
}

function applyHandoff(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  setInputText(text);
  return true;
}

function setupHandoff() {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (raw) {
      localStorage.removeItem(HANDOFF_KEY);
      const parsed = JSON.parse(raw);
      applyHandoff(parsed?.data ?? raw);
    }
  } catch {
    /* 壊れた値は無視 */
  }

  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (payload && payload.type === 'myapps:load-data') applyHandoff(payload.data);
  });

  window.MyAppsChartStudio = {
    loadData(text) {
      applyHandoff(text);
    },
    getConfig() {
      return buildConfig();
    },
  };
}

/* ==========================================================
   イベント
   ========================================================== */

inputData.addEventListener('input', debounce(readInput, 150));
[delimiterEl, optHeaderEl, optTrimEl].forEach((el) => el.addEventListener('change', readInput));

[
  chartType,
  xColumn,
  groupColumn,
  optLogX,
  optLogY,
  optLegend,
  normalizeSelect,
  paletteSelect,
  titleInput,
  xLabelInput,
  yLabelInput,
].forEach((el) => el.addEventListener('input', render));
yColumns.addEventListener('change', render);

binRange.addEventListener('input', () => {
  binValue.textContent = binRange.value;
  render();
});

btnSample.addEventListener('click', () => setInputText(SAMPLE));
btnClear.addEventListener('click', () => {
  inputData.value = '';
  readInput();
});
btnPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) setInputText(text);
    else setStatus('クリップボードが空です。');
  } catch {
    setStatus('クリップボードを読み取れませんでした。テキストエリアに直接貼り付けてください。');
  }
});

fileInput.addEventListener('change', () => {
  readFile(fileInput.files?.[0]);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  readFile(e.dataTransfer?.files?.[0]);
});

btnExportPng.addEventListener('click', exportPng);
btnExportSvg.addEventListener('click', exportSvg);
btnCopyConfig.addEventListener('click', copyConfig);

window.addEventListener('resize', debounce(() => {
  const spec = state.lastSpec;
  if (!spec) return;
  if (spec.type === 'box') renderBoxCanvas(spec);
  else if (spec.type === 'heatmap') renderHeatmapCanvas(spec);
}, 200));

/* ==========================================================
   初期化
   ========================================================== */

setupHandoff();
setInputText(SAMPLE);
