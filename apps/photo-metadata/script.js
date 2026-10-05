/**
 * 写真メタデータ — ブラウザ内で EXIF/GPS を確認し、項目ごとに削除して書き出す
 *
 * 読み取りは exifr (window.exifr)、書き込み/削除は piexifjs (window.piexif)。
 * 画像は一切送信しない。純ロジックは ./pipeline.mjs に置き、ここでは
 * File / Blob / DOM をつなぐ。
 *
 * テスト用の入口として `window.__photoMetadata` を公開する
 * (ヘッドレス検証で confirm を挟まずに処理を実行するため)。UI のボタンは
 * 書き出し前に必ず確認を挟む。
 */

import {
  detectFormat,
  canWrite,
  supportsSelective,
  formatBytes,
  bytesToBinaryString,
  normalizePlan,
  presetPlan,
  summarizePlan,
  CATEGORIES,
  resolveCoordinates,
  formatCoordinate,
  buildMapLinks,
  groupExifRows,
  verifyRemoval,
  rewriteImage,
  buildReportRow,
  toCsv,
  toJson,
  FORMAT_LABELS,
  EXIFR_VERSION,
  PIEXIF_VERSION,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */

let plan = presetPlan('keep-all');
let items = []; // { id, file, bytes, format, parsed, coords, rows, output, leaks, error, status }
let nextId = 1;

const $ = (id) => document.getElementById(id);

const UI = {
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  status: $('status'),
  presetRow: $('preset-row'),
  categoryGrid: $('category-grid'),
  planSummary: $('plan-summary'),
  processBtn: $('process-btn'),
  clearBtn: $('clear-btn'),
  exportCsvBtn: $('export-csv-btn'),
  exportJsonBtn: $('export-json-btn'),
  empty: $('empty-state'),
  list: $('file-list'),
};

/* ==========================================================
   ユーティリティ
   ========================================================== */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function setStatus(message) {
  if (UI.status) UI.status.textContent = message || '';
}

function hasLibs() {
  return typeof window.exifr !== 'undefined' && typeof window.piexif !== 'undefined';
}

function baseName(name) {
  return String(name || 'image').replace(/\.[^.]+$/, '');
}

function extensionFor(format) {
  if (format === 'png') return 'png';
  return 'jpg';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ==========================================================
   プラン UI
   ========================================================== */

function renderCategories() {
  if (!UI.categoryGrid) return;
  UI.categoryGrid.innerHTML = CATEGORIES.map((c) => (
    `<label class="category-item" data-category="${esc(c.key)}">` +
      `<input type="checkbox" data-category-input="${esc(c.key)}"${plan[c.key] ? ' checked' : ''} />` +
      '<span class="category-text">' +
        `<span class="category-label">${esc(c.label)}</span>` +
        `<span class="category-hint">${esc(c.hint)}</span>` +
      '</span>' +
    '</label>'
  )).join('');
}

function syncCategoryInputs() {
  for (const c of CATEGORIES) {
    const input = document.querySelector(`[data-category-input="${c.key}"]`);
    if (input) input.checked = plan[c.key];
  }
}

function renderPlanSummary() {
  if (UI.planSummary) UI.planSummary.textContent = `書き出し: ${summarizePlan(plan)}`;
}

function setPlan(next) {
  plan = normalizePlan(next);
  syncCategoryInputs();
  renderPlanSummary();
}

/* ==========================================================
   読み取り
   ========================================================== */

async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectFormat(bytes);
  let parsed = null;
  let error = null;
  try {
    parsed = await window.exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      interop: true,
      xmp: true,
      iptc: true,
      jfif: true,
      ihdr: true,
      reviveValues: false,
    });
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  const coords = resolveCoordinates(parsed);
  const { groups, hasExif } = groupExifRows(parsed);
  return {
    id: nextId++,
    file,
    bytes,
    format,
    parsed: parsed || null,
    coords,
    groups,
    hasExif,
    error,
    output: null,
    leaks: null,
    status: error ? 'error' : 'read',
  };
}

async function addFiles(fileList) {
  if (!hasLibs()) {
    setStatus('exifr / piexifjs の読み込みに失敗しました。ネットワークを確認してください。');
    return;
  }
  const files = [...fileList].filter((f) => f && f.size > 0);
  if (files.length === 0) return;
  setStatus(`${files.length} 件を読み取り中…`);
  for (const file of files) {
    try {
      items.push(await readFile(file));
    } catch (e) {
      items.push({
        id: nextId++,
        file,
        bytes: null,
        format: 'unknown',
        parsed: null,
        coords: null,
        groups: { gps: [], datetime: [], camera: [], author: [], other: [] },
        hasExif: false,
        error: e && e.message ? e.message : String(e),
        output: null,
        leaks: null,
        status: 'error',
      });
    }
  }
  render();
  setStatus(`${items.length} 件を読み取りました。`);
}

/* ==========================================================
   書き出し
   ========================================================== */

async function processAll() {
  if (items.length === 0) return;
  setStatus('書き出し中…');
  for (const item of items) {
    if (!item.bytes) continue;
    if (!canWrite(item.format)) {
      item.status = 'unsupported';
      item.output = null;
      continue;
    }
    try {
      const exifObject = item.format === 'jpeg' ? window.piexif.load(bytesToBinaryString(item.bytes)) : null;
      const result = rewriteImage(item.bytes, { plan, exifObject, piexif: window.piexif });
      if (!result) {
        item.status = 'unsupported';
        continue;
      }
      item.output = result.bytes;
      // 書き出したものを読み直して、消すはずの情報が残っていないか確認する
      let reparsed = null;
      try {
        reparsed = await window.exifr.parse(result.bytes, {
          tiff: true,
          exif: true,
          gps: true,
          interop: true,
          xmp: true,
          iptc: true,
          reviveValues: false,
        });
      } catch {
        reparsed = null;
      }
      item.leaks = verifyRemoval(reparsed, plan);
      item.status = item.leaks.length ? 'leak' : 'done';
    } catch (e) {
      item.error = e && e.message ? e.message : String(e);
      item.status = 'error';
    }
  }
  render();
  const done = items.filter((i) => i.status === 'done').length;
  const leaks = items.filter((i) => i.status === 'leak').length;
  setStatus(`書き出し完了: ${done} 件${leaks ? ` / 要確認 ${leaks} 件` : ''}。`);
}

function downloadItem(item) {
  if (!item.output) return;
  const name = `${baseName(item.file.name)}.clean.${extensionFor(item.format)}`;
  downloadBlob(new Blob([item.output], { type: item.format === 'png' ? 'image/png' : 'image/jpeg' }), name);
}

function downloadAll() {
  const ready = items.filter((i) => i.output);
  if (ready.length === 0) return;
  ready.forEach((item, index) => setTimeout(() => downloadItem(item), index * 250));
}

/* ==========================================================
   レポート
   ========================================================== */

function reportRows() {
  return items.map((item) => buildReportRow({
    file: item.file.name,
    format: item.format,
    sizeBytes: item.bytes ? item.bytes.length : '',
    parsed: item.parsed,
    plan,
    outputBytes: item.output ? item.output.length : '',
    leaks: item.leaks,
    error: item.error,
    status: item.status,
  }));
}

function exportCsv() {
  downloadBlob(new Blob([toCsv(reportRows())], { type: 'text/csv;charset=utf-8' }), 'photo-metadata.csv');
}

function exportJson() {
  downloadBlob(new Blob([toJson(reportRows())], { type: 'application/json' }), 'photo-metadata.json');
}

/* ==========================================================
   描画
   ========================================================== */

function statusBadge(item) {
  const map = {
    read: ['未処理', 'badge-read'],
    done: ['削除済み', 'badge-done'],
    leak: ['要確認', 'badge-leak'],
    unsupported: ['非対応', 'badge-unsupported'],
    error: ['エラー', 'badge-error'],
  };
  const [label, cls] = map[item.status] || ['—', 'badge-read'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function rowsHtml(rows) {
  if (!rows || rows.length === 0) return '<p class="meta-empty">情報なし</p>';
  return (
    '<dl class="meta-rows">' +
    rows.map((r) => `<div class="meta-row"><dt>${esc(r.key)}</dt><dd>${esc(r.value)}</dd></div>`).join('') +
    '</dl>'
  );
}

function gpsHtml(item) {
  if (!item.coords) return '';
  const links = buildMapLinks(item.coords.latitude, item.coords.longitude);
  return (
    '<div class="gps-box">' +
      `<span class="gps-coord">${esc(formatCoordinate(item.coords.latitude))}, ${esc(formatCoordinate(item.coords.longitude))}</span>` +
      links.map((l) => `<a class="gps-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join('') +
    '</div>'
  );
}

function fileCard(item) {
  const formatLabel = FORMAT_LABELS[item.format] || item.format;
  const writable = canWrite(item.format);
  const selective = supportsSelective(item.format);
  const size = item.bytes ? formatBytes(item.bytes.length) : '—';
  const outSize = item.output ? formatBytes(item.output.length) : null;

  const notes = [];
  if (!writable) notes.push('この形式はブラウザ内で書き戻せません (読み取りのみ)。');
  if (writable && !selective) notes.push('PNG は項目ごとの選択ができず、1 つでも外すとメタデータ全体を削除します。');
  if (item.status === 'leak') notes.push(`削除しきれなかった項目: ${item.leaks.join(', ')}`);
  if (item.error) notes.push(`エラー: ${item.error}`);

  const downloadBtn = item.output
    ? `<button class="btn btn-small btn-primary" type="button" data-action="download" data-id="${item.id}">この写真を保存</button>`
    : '';

  return (
    `<article class="file-card" data-id="${item.id}">` +
      '<div class="file-head">' +
        `<span class="file-name" title="${esc(item.file.name)}">${esc(item.file.name)}</span>` +
        statusBadge(item) +
      '</div>' +
      '<div class="file-meta">' +
        `<span>${esc(formatLabel)}</span><span>${esc(size)}</span>` +
        (outSize ? `<span>→ ${esc(outSize)}</span>` : '') +
        (item.hasExif ? '<span class="has-exif">EXIF あり</span>' : '<span>EXIF なし</span>') +
      '</div>' +
      gpsHtml(item) +
      '<div class="meta-groups">' +
        '<details open><summary>位置情報 (GPS)</summary>' + rowsHtml(item.groups.gps) + '</details>' +
        '<details><summary>撮影日時</summary>' + rowsHtml(item.groups.datetime) + '</details>' +
        '<details><summary>機材・設定</summary>' + rowsHtml(item.groups.camera) + '</details>' +
        '<details><summary>作者・著作権</summary>' + rowsHtml(item.groups.author) + '</details>' +
        (item.groups.other.length ? '<details><summary>その他</summary>' + rowsHtml(item.groups.other) + '</details>' : '') +
      '</div>' +
      (notes.length ? `<ul class="file-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '') +
      (downloadBtn ? `<div class="file-actions">${downloadBtn}</div>` : '') +
    '</article>'
  );
}

function render() {
  if (!UI.list) return;
  const hasItems = items.length > 0;
  if (UI.empty) UI.empty.classList.toggle('hidden', hasItems);
  UI.list.innerHTML = items.map(fileCard).join('');

  const anyWritable = items.some((i) => canWrite(i.format));
  const anyOutput = items.some((i) => i.output);
  if (UI.processBtn) UI.processBtn.disabled = !anyWritable;
  if (UI.clearBtn) UI.clearBtn.disabled = !hasItems;
  if (UI.exportCsvBtn) UI.exportCsvBtn.disabled = !hasItems;
  if (UI.exportJsonBtn) UI.exportJsonBtn.disabled = !hasItems;
}

/* ==========================================================
   イベント
   ========================================================== */

function bindEvents() {
  if (UI.dropZone) {
    UI.dropZone.addEventListener('click', () => UI.fileInput && UI.fileInput.click());
    UI.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        UI.fileInput && UI.fileInput.click();
      }
    });
    for (const type of ['dragenter', 'dragover']) {
      UI.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        UI.dropZone.classList.add('is-dragover');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      UI.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        UI.dropZone.classList.remove('is-dragover');
      });
    }
    UI.dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
  }

  if (UI.fileInput) {
    UI.fileInput.addEventListener('change', () => {
      addFiles(UI.fileInput.files);
      UI.fileInput.value = '';
    });
  }

  if (UI.presetRow) {
    UI.presetRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;
      setPlan(presetPlan(btn.dataset.preset));
    });
  }

  if (UI.categoryGrid) {
    UI.categoryGrid.addEventListener('change', (e) => {
      const input = e.target.closest('[data-category-input]');
      if (!input) return;
      plan = normalizePlan({ ...plan, [input.dataset.categoryInput]: input.checked });
      renderPlanSummary();
    });
  }

  if (UI.processBtn) {
    UI.processBtn.addEventListener('click', async () => {
      if (!window.confirm(`「${summarizePlan(plan)}」で書き出します。よろしいですか？`)) return;
      await processAll();
    });
  }

  if (UI.clearBtn) {
    UI.clearBtn.addEventListener('click', () => {
      items = [];
      render();
      setStatus('');
    });
  }

  if (UI.exportCsvBtn) UI.exportCsvBtn.addEventListener('click', exportCsv);
  if (UI.exportJsonBtn) UI.exportJsonBtn.addEventListener('click', exportJson);

  if (UI.list) {
    UI.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="download"]');
      if (!btn) return;
      const item = items.find((i) => i.id === Number(btn.dataset.id));
      if (item) downloadItem(item);
    });
  }
}

/* ==========================================================
   初期化
   ========================================================== */

function init() {
  renderCategories();
  renderPlanSummary();
  bindEvents();
  render();
  if (!hasLibs()) {
    setStatus('exifr / piexifjs の読み込みに失敗しました。ネットワークを確認してください。');
  }
}

init();

/* ヘッドレス検証用の入口 (UI のボタンは確認を挟む) */
window.__photoMetadata = {
  addFiles,
  processAll,
  downloadAll,
  exportCsv,
  exportJson,
  setPlan,
  getPlan: () => ({ ...plan }),
  getItems: () => items,
  reportRows,
  summarizePlan: () => summarizePlan(plan),
  versions: { exifr: EXIFR_VERSION, piexif: PIEXIF_VERSION },
};
