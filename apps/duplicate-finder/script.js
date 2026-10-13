/**
 * script.js — 重複ファイル整理の UI
 *
 * 走査・ハッシュ計算・グループ化はすべて端末内で行う。
 * 純ロジックは pipeline.mjs に分離し、ここでは DOM と File API を扱う。
 */

import {
  CHUNK_SIZE,
  DEFAULT_SIMILAR_THRESHOLD,
  MAX_SIMILAR_ITEMS,
  chunkRanges,
  groupCandidates,
  groupExact,
  clusterBySimilarity,
  sha256Hex,
  grayFromRGBA,
  dHash,
  similarityPercent,
  isImageFile,
  defaultKeepId,
  summarizeGroups,
  planMoves,
  buildReport,
  groupsToJSON,
  groupsFromJSON,
  reportToRows,
  rowsToCSV,
  formatBytes,
  shortenPath,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),

  pickFolderBtn: $('pick-folder-btn'),
  folderInput: $('folder-input'),
  restoreInput: $('restore-input'),

  scanRoot: $('scan-root'),
  minSizeSelect: $('min-size-select'),
  similarToggle: $('similar-toggle'),
  similarThreshold: $('similar-threshold'),
  thresholdValue: $('threshold-value'),

  scanBtn: $('scan-btn'),
  cancelScanBtn: $('cancel-scan-btn'),
  scanProgressWrap: $('scan-progress-wrap'),
  scanProgressBar: $('scan-progress-bar'),
  scanProgressLabel: $('scan-progress-label'),

  resultsSection: $('results-section'),
  sortSelect: $('sort-select'),
  summaryStats: $('summary-stats'),
  groupsList: $('groups-list'),
  emptyResult: $('empty-result'),

  reportJsonBtn: $('report-json-btn'),
  reportCsvBtn: $('report-csv-btn'),
  moveBtn: $('move-btn'),
  moveHint: $('move-hint'),
  moveProgressWrap: $('move-progress-wrap'),
  moveProgressBar: $('move-progress-bar'),
  moveProgressLabel: $('move-progress-label'),
};

const state = {
  rootHandle: null,
  rootName: '',
  entries: [],
  byId: new Map(),
  groups: [],
  sortMode: 'size',
  scanning: false,
  cancelled: false,
  objectUrls: [],
};

/* ==========================================================
   ユーティリティ
   ========================================================== */

const idle = () => new Promise((resolve) => setTimeout(resolve, 0));

function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function setScanProgress(ratio, label) {
  const percent = Math.max(0, Math.min(1, ratio)) * 100;
  els.scanProgressBar.style.width = `${percent}%`;
  if (label != null) els.scanProgressLabel.textContent = label;
}

function setMoveProgress(ratio, label) {
  const percent = Math.max(0, Math.min(1, ratio)) * 100;
  els.moveProgressBar.style.width = `${percent}%`;
  if (label != null) els.moveProgressLabel.textContent = label;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function keepMap() {
  return new Map(state.groups.map((group) => [group.id, group.keepId]));
}

/* ==========================================================
   フォルダ選択
   ========================================================== */

async function walkDirectory(dirHandle, prefix, out, signal) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (signal.cancelled) return;
    if (handle.kind === 'directory') {
      await walkDirectory(handle, [...prefix, name], out, signal);
    } else {
      const file = await handle.getFile();
      out.push({
        name,
        path: [...prefix, name].join('/'),
        dirSegments: prefix.slice(),
        fileHandle: handle,
        file,
      });
    }
  }
}

async function selectWithHandle() {
  clearError();
  if (typeof window.showDirectoryPicker !== 'function') {
    showError('このブラウザはフォルダの読み書き API に対応していません。「フォルダを選ぶ（読み取りのみ）」を使ってください。');
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'duplicate-finder-source', mode: 'read' });
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    showError(`フォルダを開けませんでした: ${error.message}`);
    return;
  }
  state.rootHandle = handle;
  state.rootName = handle.name;
  const out = [];
  els.scanRoot.textContent = `読み取り中: ${state.rootName} …`;
  await walkDirectory(handle, [], out, { cancelled: false });
  finishSelection(out, handle.name);
}

function selectWithInput(fileList) {
  clearError();
  const out = [];
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    const segments = rel.split('/');
    const name = segments.pop();
    // webkitRelativePath の先頭は選択フォルダ名なので、ルート配下の相対に直す
    const dirSegments = segments.slice(1);
    out.push({
      name,
      path: segments.concat(name).join('/'),
      dirSegments,
      fileHandle: null,
      file,
    });
  }
  const rootName = out[0] ? out[0].path.split('/')[0] : '選択フォルダ';
  state.rootHandle = null;
  finishSelection(out, rootName);
}

function finishSelection(entries, rootName) {
  state.rootName = rootName;
  state.entries = entries;
  state.cancelled = false;
  els.scanRoot.textContent = `${state.rootName} — ${entries.length} ファイル`;
  els.scanBtn.disabled = entries.length === 0;
  if (!entries.length) {
    showError('選択したフォルダにファイルがありませんでした。');
    return;
  }
  // 前回の結果をクリア
  state.groups = [];
  els.resultsSection.hidden = true;
}

/* ==========================================================
   走査
   ========================================================== */

async function hashChunkRange(file, range) {
  const buffer = await file.slice(range.offset, range.offset + range.length).arrayBuffer();
  return sha256Hex(buffer);
}

async function hashFileChunks(file) {
  const ranges = chunkRanges(file.size, CHUNK_SIZE);
  if (!ranges.length) return { headHash: '', tailHash: '' };
  const hashes = [];
  for (const range of ranges) {
    hashes.push(await hashChunkRange(file, range));
  }
  if (hashes.length === 1) return { headHash: hashes[0], tailHash: hashes[0] };
  return { headHash: hashes[0], tailHash: hashes[hashes.length - 1] };
}

async function computeImageHash(file) {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const maxSide = 64;
    const scale = Math.min(maxSide / bitmap.width, maxSide / bitmap.height, 1);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const gray = grayFromRGBA(data, width, height);
    return dHash(gray, width, height);
  } catch {
    return null;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function buildExactGroups(scanned, fullHashById) {
  const candidateEntries = scanned
    .filter((entry) => fullHashById.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      size: entry.size,
      fullHash: fullHashById.get(entry.id),
    }));
  const exact = groupExact(candidateEntries);
  return exact.map((group) => ({
    id: `exact:${group.key}`,
    kind: 'exact',
    key: group.key,
    files: group.files.map((file) => {
      const entry = state.byId.get(file.id);
      return {
        id: file.id,
        path: entry.path,
        name: entry.name,
        size: file.size,
        hash: file.fullHash,
        file: entry.file,
        fileHandle: entry.fileHandle,
      };
    }),
  }));
}

async function buildSimilarGroups(scanned, exactIds, threshold) {
  const images = scanned
    .filter((entry) => isImageFile(entry) && !exactIds.has(entry.id))
    .slice(0, MAX_SIMILAR_ITEMS);
  const items = [];
  for (let i = 0; i < images.length; i += 1) {
    if (state.cancelled) break;
    const entry = images[i];
    const hash = await computeImageHash(entry.file);
    if (hash) items.push({ id: entry.id, dhash: hash });
    if (i % 8 === 0) {
      setScanProgress(0.85 + (0.15 * i) / Math.max(1, images.length), `類似画像を解析中… ${i + 1} / ${images.length}`);
      await idle();
    }
  }
  const clusters = clusterBySimilarity(items, { threshold, maxItems: MAX_SIMILAR_ITEMS });
  return clusters.map((cluster) => {
    const files = cluster.map((item) => {
      const entry = state.byId.get(item.id);
      return {
        id: item.id,
        path: entry.path,
        name: entry.name,
        size: entry.size,
        dhash: item.dhash,
        similarity: 100,
        file: entry.file,
        fileHandle: entry.fileHandle,
      };
    });
    const group = { id: `similar:${files[0].id}`, kind: 'similar', key: '', distance: threshold, files };
    const keepId = defaultKeepId(group);
    const representative = files.find((file) => file.id === keepId) || files[0];
    for (const file of files) {
      file.similarity = similarityPercent(representative.dhash, file.dhash);
    }
    return group;
  });
}

async function runScan() {
  clearError();
  if (state.scanning) return;
  if (!state.entries.length) {
    showError('先にフォルダを選択してください。');
    return;
  }

  state.scanning = true;
  state.cancelled = false;
  els.scanBtn.disabled = true;
  els.cancelScanBtn.hidden = false;
  els.scanProgressWrap.hidden = false;
  els.resultsSection.hidden = true;
  setScanProgress(0, 'ファイル一覧を確認中…');

  const minSize = Number(els.minSizeSelect.value) || 1;
  const scanned = [];
  state.byId = new Map();
  for (const entry of state.entries) {
    if (entry.file.size < minSize) continue;
    const item = {
      id: entry.path,
      path: entry.path,
      name: entry.name,
      size: entry.file.size,
      type: entry.file.type || '',
      file: entry.file,
      fileHandle: entry.fileHandle,
    };
    scanned.push(item);
    state.byId.set(item.id, { ...item, dirSegments: entry.dirSegments });
  }

  if (!scanned.length) {
    finishScan([]);
    return;
  }

  // 1) サイズ + 先頭/末尾チャンクで候補を絞る
  const chunked = [];
  for (let i = 0; i < scanned.length; i += 1) {
    if (state.cancelled) break;
    const entry = scanned[i];
    const { headHash, tailHash } = await hashFileChunks(entry.file);
    chunked.push({ id: entry.id, size: entry.size, headHash, tailHash });
    if (i % 16 === 0) {
      setScanProgress((0.45 * i) / scanned.length, `候補を絞り込み中… ${i + 1} / ${scanned.length}`);
      await idle();
    }
  }

  const fullHashById = new Map();
  if (!state.cancelled) {
    const candidates = groupCandidates(chunked).flatMap((group) => group.files);
    for (let i = 0; i < candidates.length; i += 1) {
      if (state.cancelled) break;
      const candidate = candidates[i];
      if (fullHashById.has(candidate.id)) continue;
      const entry = state.byId.get(candidate.id);
      const buffer = await entry.file.arrayBuffer();
      fullHashById.set(candidate.id, await sha256Hex(buffer));
      if (i % 8 === 0) {
        setScanProgress(
          0.45 + (0.4 * i) / Math.max(1, candidates.length),
          `完全一致を確認中… ${i + 1} / ${candidates.length}`,
        );
        await idle();
      }
    }
  }

  const exactGroups = buildExactGroups(scanned, fullHashById);
  const exactIds = new Set(exactGroups.flatMap((group) => group.files.map((file) => file.id)));

  let similarGroups = [];
  if (!state.cancelled && els.similarToggle.checked) {
    const threshold = Number(els.similarThreshold.value) || DEFAULT_SIMILAR_THRESHOLD;
    similarGroups = await buildSimilarGroups(scanned, exactIds, threshold);
  }

  const groups = state.cancelled ? [] : [...exactGroups, ...similarGroups];
  finishScan(groups);
}

function finishScan(groups) {
  state.scanning = false;
  els.cancelScanBtn.hidden = true;
  els.scanProgressWrap.hidden = true;
  state.groups = groups.map((group) => ({ ...group, keepId: group.keepId || defaultKeepId(group) }));
  els.resultsSection.hidden = false;
  renderAll();
  if (state.cancelled) {
    showError('走査を中断しました。');
  }
}

/* ==========================================================
   描画
   ========================================================== */

function releaseObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

function sortedGroups() {
  const list = state.groups.slice();
  const total = (group) => group.files.reduce((sum, file) => sum + file.size, 0);
  if (state.sortMode === 'count') {
    list.sort((a, b) => b.files.length - a.files.length || total(b) - total(a));
  } else if (state.sortMode === 'name') {
    list.sort((a, b) => String(a.files[0]?.name).localeCompare(String(b.files[0]?.name)));
  } else {
    list.sort((a, b) => total(b) - total(a));
  }
  return list;
}

function renderSummary() {
  const summary = summarizeGroups(state.groups, { keepIds: keepMap() });
  const cards = [
    ['グループ', String(summary.groupCount)],
    ['重複ファイル', String(summary.duplicateCount)],
    ['合計サイズ', formatBytes(summary.totalBytes)],
    ['削減見込み', formatBytes(summary.reclaimableBytes), true],
  ];
  els.summaryStats.innerHTML = '';
  for (const [label, value, accent] of cards) {
    const el = document.createElement('div');
    el.className = 'stat';
    const labelEl = document.createElement('div');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = `stat-value${accent ? ' accent' : ''}`;
    valueEl.textContent = value;
    el.append(labelEl, valueEl);
    els.summaryStats.appendChild(el);
  }
}

function makeThumb(file) {
  const thumb = document.createElement('img');
  thumb.className = 'file-thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  if (file && isImageFile(file)) {
    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);
    thumb.src = url;
  } else {
    thumb.classList.add('placeholder');
    thumb.removeAttribute('src');
  }
  return thumb;
}

function renderFileRow(group, file) {
  const row = document.createElement('div');
  row.className = `file-row${file.id === group.keepId ? ' is-keep' : ''}`;
  row.dataset.fileId = file.id;

  row.appendChild(makeThumb(file.file));

  const info = document.createElement('div');
  info.className = 'file-info';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.path;
  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const bits = [formatBytes(file.size), shortenPath(file.path, 72)];
  if (file.hash) bits.push(`sha256:${file.hash.slice(0, 10)}…`);
  if (file.dhash) bits.push(`類似度 ${file.similarity}%`);
  meta.textContent = bits.join(' · ');
  info.append(name, meta);
  row.appendChild(info);

  const keep = document.createElement('label');
  keep.className = 'keep-radio';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `keep-${group.id}`;
  radio.checked = file.id === group.keepId;
  radio.addEventListener('change', () => {
    group.keepId = file.id;
    refreshKeepState(group);
    renderSummary();
    updateMoveHint();
  });
  keep.append(radio, document.createTextNode('残す'));
  row.appendChild(keep);

  return row;
}

function refreshKeepState(group) {
  const card = els.groupsList.querySelector(`[data-group-id="${CSS.escape(group.id)}"]`);
  if (!card) return;
  for (const row of card.querySelectorAll('.file-row')) {
    row.classList.toggle('is-keep', row.dataset.fileId === group.keepId);
  }
  const size = card.querySelector('.group-size');
  if (size) size.textContent = groupSizeText(group);
}

function groupSizeText(group) {
  const total = group.files.reduce((sum, file) => sum + file.size, 0);
  const keep = group.files.find((file) => file.id === group.keepId);
  const reclaim = total - (keep ? keep.size : 0);
  return `${group.files.length} 件 · ${formatBytes(total)} · 削減 ${formatBytes(reclaim)}`;
}

function renderGroup(group) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupId = group.id;
  card.setAttribute('role', 'listitem');

  const head = document.createElement('div');
  head.className = 'group-head';

  const badge = document.createElement('span');
  badge.className = `group-badge ${group.kind}`;
  badge.textContent = group.kind === 'exact' ? '完全一致' : '類似画像';

  const title = document.createElement('span');
  title.className = 'group-title';
  title.textContent = group.files[0] ? group.files[0].name : '';

  const size = document.createElement('span');
  size.className = 'group-size';
  size.textContent = groupSizeText(group);

  head.append(badge, title, size);
  card.appendChild(head);

  for (const file of group.files) {
    card.appendChild(renderFileRow(group, file));
  }
  return card;
}

function renderGroups() {
  releaseObjectUrls();
  els.groupsList.innerHTML = '';
  const groups = sortedGroups();
  els.emptyResult.hidden = groups.length > 0;
  for (const group of groups) {
    els.groupsList.appendChild(renderGroup(group));
  }
}

function updateMoveHint() {
  if (!state.groups.length) {
    els.moveHint.textContent = '重複が見つかると、ここから整理できます。';
    return;
  }
  const moves = planMoves(state.groups, { keepIds: keepMap() }).moves;
  if (!state.rootHandle) {
    els.moveHint.textContent =
      '移動を使うには、Chromium 系ブラウザで「フォルダを開く（移動に対応）」から選んでください。レポート出力はいつでも使えます。';
  } else {
    els.moveHint.textContent = `${moves.length} 件を退避フォルダへ移動できます（削除はしません）。`;
  }
  els.moveBtn.disabled = !state.rootHandle || moves.length === 0;
}

function renderAll() {
  renderSummary();
  renderGroups();
  const hasGroups = state.groups.length > 0;
  els.reportJsonBtn.disabled = !hasGroups;
  els.reportCsvBtn.disabled = !hasGroups;
  updateMoveHint();
}

/* ==========================================================
   レポート出力
   ========================================================== */

function currentReport() {
  return buildReport(state.groups, { root: state.rootName, keepIds: keepMap() });
}

function exportJSON() {
  const report = currentReport();
  downloadText(`duplicate-report-${timestamp()}.json`, groupsToJSON(report), 'application/json');
}

function exportCSV() {
  const report = currentReport();
  const rows = reportToRows(report);
  const columns = ['kind', 'group', 'status', 'name', 'path', 'size', 'sizeText', 'hash', 'dhash', 'similarity'];
  downloadText(`duplicate-report-${timestamp()}.csv`, `\uFEFF${rowsToCSV(rows, columns)}`, 'text/csv');
}

async function restoreReport(file) {
  clearError();
  try {
    const text = await file.text();
    const restored = groupsFromJSON(text);
    state.rootHandle = null;
    state.rootName = restored.root || 'レポート';
    state.entries = [];
    state.byId = new Map();
    state.groups = restored.groups.map((group) => ({ ...group, keepId: group.keepId || defaultKeepId(group) }));
    els.scanRoot.textContent = `${state.rootName} — レポートから復元（${state.groups.length} グループ）`;
    els.resultsSection.hidden = false;
    renderAll();
    if (restored.warnings.length) {
      showError(restored.warnings.join(' / '));
    }
  } catch (error) {
    showError(`レポートを開けませんでした: ${error.message}`);
  }
}

/* ==========================================================
   非破壊の移動
   ========================================================== */

async function getDirBySegments(root, segments) {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: false });
  }
  return dir;
}

async function performMove() {
  clearError();
  if (!state.rootHandle) {
    updateMoveHint();
    return;
  }
  const { moves } = planMoves(state.groups, { keepIds: keepMap() });
  if (!moves.length) return;

  let destHandle;
  try {
    destHandle = await window.showDirectoryPicker({ id: 'duplicate-finder-dest', mode: 'readwrite' });
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    showError(`退避先を開けませんでした: ${error.message}`);
    return;
  }

  const ok = window.confirm(
    `${moves.length} 件を「${destHandle.name}」へ移動します。\n` +
      'コピー後に元の場所から取り除く「移動」です。退避先に残るので、あとで戻せます。\n続けますか？',
  );
  if (!ok) return;

  els.moveBtn.disabled = true;
  els.moveProgressWrap.hidden = false;
  setMoveProgress(0, '移動中…');

  let done = 0;
  let skipped = 0;
  for (const move of moves) {
    const entry = state.byId.get(move.fileId);
    if (!entry || !entry.dirSegments) {
      skipped += 1;
      continue;
    }
    try {
      const parent = await getDirBySegments(state.rootHandle, entry.dirSegments);
      const srcHandle = await parent.getFileHandle(entry.name);
      const source = await srcHandle.getFile();
      const destFile = await destHandle.getFileHandle(move.name, { create: true });
      const writable = await destFile.createWritable();
      await writable.write(source);
      await writable.close();
      await parent.removeEntry(entry.name);
      done += 1;
    } catch (error) {
      skipped += 1;
      showError(`一部を移動できませんでした (${move.from}): ${error.message}`);
    }
    setMoveProgress(done / moves.length, `移動中… ${done} / ${moves.length}`);
    await idle();
  }

  els.moveProgressWrap.hidden = true;
  els.moveBtn.disabled = false;
  els.moveHint.textContent =
    `${done} 件を「${destHandle.name}」へ移動しました` +
    (skipped ? `（${skipped} 件はスキップ）` : '') +
    '。再走査すると結果が更新されます。';
}

/* ==========================================================
   イベント登録
   ========================================================== */

function bindEvents() {
  els.infoBtn?.addEventListener('click', () => {
    els.infoModal.hidden = false;
  });
  els.closeInfoBtn?.addEventListener('click', () => {
    els.infoModal.hidden = true;
  });
  els.infoModal?.addEventListener('click', (event) => {
    if (event.target === els.infoModal) els.infoModal.hidden = true;
  });

  els.pickFolderBtn?.addEventListener('click', selectWithHandle);
  els.folderInput?.addEventListener('change', (event) => {
    if (event.target.files && event.target.files.length) selectWithInput(event.target.files);
  });
  els.restoreInput?.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) restoreReport(file);
    event.target.value = '';
  });

  els.scanBtn?.addEventListener('click', runScan);
  els.cancelScanBtn?.addEventListener('click', () => {
    state.cancelled = true;
  });

  els.similarThreshold?.addEventListener('input', () => {
    els.thresholdValue.textContent = `距離 ${els.similarThreshold.value} / 64`;
  });

  els.sortSelect?.addEventListener('change', () => {
    state.sortMode = els.sortSelect.value;
    renderGroups();
  });

  els.reportJsonBtn?.addEventListener('click', exportJSON);
  els.reportCsvBtn?.addEventListener('click', exportCSV);
  els.moveBtn?.addEventListener('click', performMove);
}

function init() {
  if (typeof window.showDirectoryPicker !== 'function') {
    els.pickFolderBtn.disabled = true;
    els.pickFolderBtn.title = 'このブラウザは非対応です（読み取りのみの選択を使ってください）';
  }
  els.thresholdValue.textContent = `距離 ${els.similarThreshold.value} / 64`;
  bindEvents();
}

init();
