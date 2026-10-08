/**
 * pipeline.mjs — chart-studio の純ロジック
 *
 * 表データの解析、統計、軸目盛り、正規化、ビニング、色割当、書き出し。
 * DOM に依存しないので `node --test` で直接検証できる。
 * 描画そのものは script.js / svg.mjs が担当する。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 系列色パレット (既定)。 */
export const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#0d9488', '#9333ea',
];

/** 選択できる系列色プリセット。 */
export const PALETTES = {
  default: PALETTE,
  // Okabe–Ito (色覚多様性対応)
  colorblind: ['#0072b2', '#e69f00', '#009e73', '#d55e00', '#cc79a7', '#56b4e9', '#f0e442', '#000000'],
  warm: ['#dc2626', '#ea580c', '#d97706', '#ca8a04', '#b45309', '#9a3412'],
  cool: ['#0ea5e9', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#0d9488'],
  mono: ['#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#1e293b'],
};

/** ヒートマップの連続カラースケール (薄→濃)。 */
export const HEATMAP_STOPS = ['#eff6ff', '#60a5fa', '#1d4ed8'];

/** アプリ間ハンドオフ用の localStorage キー。 */
export const HANDOFF_KEY = 'myapps.chartStudio.handoff';

/** プレビューに出す最大行数。 */
export const MAX_PREVIEW_ROWS = 50;

/* ==========================================================
   CSV / TSV 解析
   ========================================================== */

/** 1 行のフィールド数を数える (引用符内の区切り文字は無視)。 */
export function countFields(line, delimiter) {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/** 最初の数行から区切り文字を推定する。 */
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).slice(0, 6).filter((l) => l.length > 0);
  const candidates = [',', '\t', ';', '|'];
  let best = { delimiter: ',', score: -Infinity };
  for (const delim of candidates) {
    const counts = lines.map((line) => countFields(line, delim));
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const variance = counts.reduce((a, b) => a + Math.abs(b - avg), 0);
    const score = avg - variance * 0.25;
    if (avg > 1 && score > best.score) best = { delimiter: delim, score };
  }
  return best.delimiter;
}

/** 引用符・改行に対応した区切り文字パーサ。 */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);

  // 末尾の空行を落とす
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  return rows;
}

/** 行の長さを最大列数に揃える。 */
export function normalizeRows(rows) {
  const max = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((row) => (row.length === max ? row : row.concat(Array(max - row.length).fill(''))));
}

/** 重複・空のヘッダーを一意な名前にする。 */
export function normalizeHeaders(rawHeaders) {
  const used = new Map();
  return rawHeaders.map((name, idx) => {
    let clean = String(name ?? '').trim();
    if (!clean) clean = `Column ${idx + 1}`;
    const count = used.get(clean) ?? 0;
    used.set(clean, count + 1);
    return count === 0 ? clean : `${clean}_${count + 1}`;
  });
}

/** 数値として解釈できる値を number にする (不可なら NaN)。 */
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return NaN;
  const s = String(value).trim();
  if (s === '') return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

function isBooleanToken(value) {
  return /^(true|false)$/i.test(String(value).trim());
}

function isDateToken(value) {
  const s = String(value).trim();
  if (!/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

/** 列の型を推定する: number | boolean | date | text | empty。 */
export function inferColumnType(values) {
  const nonEmpty = values.filter((v) => v !== '' && v !== null && v !== undefined);
  if (!nonEmpty.length) return 'empty';
  if (nonEmpty.every((v) => Number.isFinite(toNumber(v)))) return 'number';
  if (nonEmpty.every(isBooleanToken)) return 'boolean';
  if (nonEmpty.every(isDateToken)) return 'date';
  return 'text';
}

/**
 * テキストを表に変換する。
 * @returns {{ headers: string[], rows: string[][], types: string[], delimiter: string }}
 */
export function parseTable(text, { delimiter = 'auto', header = true, trim = true } = {}) {
  const delim = delimiter === 'auto' ? detectDelimiter(text) : delimiter;
  const parsed = normalizeRows(parseDelimited(text, delim)).map((row) =>
    trim ? row.map((cell) => cell.trim()) : row,
  );

  if (!parsed.length) return { headers: [], rows: [], types: [], delimiter: delim };

  let headers;
  let rows;
  if (header) {
    headers = normalizeHeaders(parsed[0]);
    rows = parsed.slice(1);
  } else {
    const colCount = parsed[0].length;
    headers = normalizeHeaders(Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`));
    rows = parsed;
  }

  const types = headers.map((_, idx) => inferColumnType(rows.map((r) => r[idx] ?? '')));
  return { headers, rows, types, delimiter: delim };
}

/* ==========================================================
   列の取り出し
   ========================================================== */

/** 指定列の値を取り出す。numeric=true なら数値化できる値だけを返す。 */
export function columnValues(rows, index, { numeric = false } = {}) {
  const out = [];
  for (const row of rows) {
    const raw = row[index];
    if (numeric) {
      const n = toNumber(raw);
      if (Number.isFinite(n)) out.push(n);
    } else if (raw !== undefined && raw !== null && raw !== '') {
      out.push(String(raw));
    }
  }
  return out;
}

/** 数値の組 (x, y) を返す。どちらかが数値でなければ除外。 */
export function pairedValues(rows, xIndex, yIndex) {
  const out = [];
  for (const row of rows) {
    const x = toNumber(row[xIndex]);
    const y = toNumber(row[yIndex]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

/** text/boolean/date 列のカテゴリと数値の対応を返す (棒グラフ・カテゴリ折れ線)。 */
export function categorySeries(rows, labelIndex, valueIndex) {
  const labels = [];
  const values = [];
  for (const row of rows) {
    const label = String(row[labelIndex] ?? '');
    if (label === '') continue;
    labels.push(label);
    values.push(toNumber(row[valueIndex]));
  }
  return { labels, values };
}

/* ==========================================================
   統計
   ========================================================== */

export function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 標本標準偏差 (n-1)。n<2 のときは 0 を返す。 */
export function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** ソート済み配列の分位点 (線形補間)。 */
export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function median(values) {
  if (!values.length) return NaN;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/** 箱ひげ図の統計量。Tukey の 1.5*IQR ルール。 */
export function boxStats(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) {
    return { count: 0, min: NaN, max: NaN, q1: NaN, median: NaN, q3: NaN, iqr: NaN, whiskerLow: NaN, whiskerHigh: NaN, outliers: [] };
  }
  const q1 = quantile(nums, 0.25);
  const med = quantile(nums, 0.5);
  const q3 = quantile(nums, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const inside = nums.filter((v) => v >= lowerFence && v <= upperFence);
  const outliers = nums.filter((v) => v < lowerFence || v > upperFence);
  return {
    count: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    q1,
    median: med,
    q3,
    iqr,
    whiskerLow: inside.length ? inside[0] : nums[0],
    whiskerHigh: inside.length ? inside[inside.length - 1] : nums[nums.length - 1],
    outliers,
  };
}

/* ==========================================================
   スケール・目盛り
   ========================================================== */

/** 見やすい目盛り (1/2/5 × 10^k) を返す。 */
export function niceTicks(min, max, target = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.5;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  step *= mag;

  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 1e-9; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

/** 対数軸の目盛り (10 の冪)。min<=0 の場合は空。 */
export function logTicks(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return [];
  if (min > max) [min, max] = [max, min];
  const start = Math.floor(Math.log10(min));
  const end = Math.ceil(Math.log10(max));
  const ticks = [];
  for (let e = start; e <= end; e += 1) ticks.push(Number((10 ** e).toPrecision(12)));
  return ticks;
}

/** 線形スケール関数 domain -> range。 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (v) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** 対数スケール関数 domain -> range (domain は正の値)。 */
export function logScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const l0 = Math.log10(d0);
  const l1 = Math.log10(d1);
  const span = l1 - l0;
  return (v) => (span === 0 ? (r0 + r1) / 2 : r0 + ((Math.log10(v) - l0) / span) * (r1 - r0));
}

/* ==========================================================
   ビニング・正規化・色
   ========================================================== */

/**
 * 1 次元ヒストグラム。
 * @returns {{ edges: number[], counts: number[], max: number }}
 */
export function histogram(values, binCount = 10, domain) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { edges: [], counts: [], max: 0 };
  const bins = Math.max(1, Math.floor(binCount));
  let lo = domain ? domain[0] : Math.min(...nums);
  let hi = domain ? domain[1] : Math.max(...nums);
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  const step = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + step * i);
  const counts = new Array(bins).fill(0);
  for (const v of nums) {
    if (v < lo || v > hi) continue;
    let idx = Math.floor((v - lo) / step);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return { edges, counts, max: Math.max(...counts) };
}

/**
 * 2 次元ビニング (ヒートマップ)。
 * @returns {{ counts: number[][], xEdges: number[], yEdges: number[], max: number, rows: number, cols: number }}
 */
export function heatmapGrid(xs, ys, cols = 10, rows = 10, domain) {
  const points = [];
  for (let i = 0; i < xs.length && i < ys.length; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) points.push([xs[i], ys[i]]);
  }
  if (!points.length) return { counts: [], xEdges: [], yEdges: [], max: 0, rows: 0, cols: 0 };

  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));

  const allX = points.map((p) => p[0]);
  const allY = points.map((p) => p[1]);
  let [x0, x1] = domain?.x ?? [Math.min(...allX), Math.max(...allX)];
  let [y0, y1] = domain?.y ?? [Math.min(...allY), Math.max(...allY)];
  if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
  if (y0 === y1) { y0 -= 0.5; y1 += 0.5; }

  const dx = (x1 - x0) / c;
  const dy = (y1 - y0) / r;
  const xEdges = Array.from({ length: c + 1 }, (_, i) => x0 + dx * i);
  const yEdges = Array.from({ length: r + 1 }, (_, i) => y0 + dy * i);
  const counts = Array.from({ length: r }, () => new Array(c).fill(0));

  for (const [px, py] of points) {
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    let ci = Math.floor((px - x0) / dx);
    let ri = Math.floor((py - y0) / dy);
    if (ci >= c) ci = c - 1;
    if (ri >= r) ri = r - 1;
    if (ci < 0) ci = 0;
    if (ri < 0) ri = 0;
    counts[ri][ci] += 1;
  }

  const max = counts.reduce((m, row) => Math.max(m, ...row), 0);
  return { counts, xEdges, yEdges, max, rows: r, cols: c };
}

/**
 * 値の正規化。
 * @param {'none'|'minmax'|'zscore'} method
 */
export function normalize(values, method = 'none') {
  const nums = values.map((v) => (Number.isFinite(v) ? v : NaN));
  if (method === 'minmax') {
    const valid = nums.filter(Number.isFinite);
    if (!valid.length) return nums.slice();
    const lo = Math.min(...valid);
    const hi = Math.max(...valid);
    const span = hi - lo;
    return nums.map((v) => (!Number.isFinite(v) ? NaN : span === 0 ? 0 : (v - lo) / span));
  }
  if (method === 'zscore') {
    const valid = nums.filter(Number.isFinite);
    if (!valid.length) return nums.slice();
    const m = mean(valid);
    const s = stdev(valid);
    return nums.map((v) => (!Number.isFinite(v) ? NaN : s === 0 ? 0 : (v - m) / s));
  }
  return nums.slice();
}

/** n 系列分の色をパレットから割り当てる (循環)。 */
export function seriesColors(n, name = 'default') {
  const palette = PALETTES[name] ?? PALETTE;
  const count = Math.max(0, Math.floor(n));
  return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
}

/** 16 進カラーを [r,g,b] に変換。 */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  const to2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * 連続カラースケール。t=0 で stops[0]、t=1 で stops[last]。
 * @param {number} t
 * @param {string[]} stops
 */
export function colorScale(t, stops = HEATMAP_STOPS) {
  if (!stops.length) return '#000000';
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const seg = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

/* ==========================================================
   フォーマット・書き出し
   ========================================================== */

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(2);
  return Number(value.toFixed(digits)).toString();
}

/** CSV へ書き戻す (ハンドオフや設定のダンプ用)。 */
export function buildCsv(headers, rows) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\n');
}

/** 確率密度の合計が 1 になるよう重み付けする (色の濃さの補助)。 */
export function densityMatrix(counts) {
  const total = counts.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  if (!total) return counts.map((row) => row.map(() => 0));
  return counts.map((row) => row.map((v) => v / total));
}
