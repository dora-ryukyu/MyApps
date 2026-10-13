/**
 * Book Reader — script.js
 *
 * EPUB は foliate-js (MIT) を動的 import して描画し、CBZ は
 * zip.js (BSD-3-Clause) でエントリを読み、`<img>` でページ送りする。
 * 読書位置・しおり・ハイライトは localStorage に保存し、
 * 同じファイルを選び直したときに続きから再開する。
 *
 * ファイルは一切送信しない (ネットワーク送信 API を使わない。外部への通信は
 * ライブラリの読み込み (CDN) とフォントだけ)。
 */

import {
  READER_THEMES,
  DEFAULT_SETTINGS,
  FONT_SCALE,
  MARGIN,
  isSupportedBookFile,
  detectFormat,
  sortCbzPages,
  clampIndex,
  nextIndex,
  prevIndex,
  progressPercent,
  buildCbzPageLabel,
  normalizeToc,
  buildBookKey,
  serializeReadingState,
  deserializeReadingState,
  normalizeReadingState,
  isSameReadingState,
  readingPositionLabel,
  normalizeSettings,
  buildReaderCss,
  formatBytes,
  formatPercent,
  buildHighlightsFileName,
} from './pipeline.mjs';

/* ==========================================================
   外部ライブラリ (版/コミットを固定して CDN から読む)
   foliate-js: MIT / https://github.com/johnfactotum/foliate-js
   zip.js:     BSD-3-Clause / https://github.com/gildas-lormeau/zip.js
   ========================================================== */
const FOLIATE_COMMIT = '78914aef4466eb960965702401634c2cb348e9b1';
const FOLIATE_VIEW_URL = `https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@${FOLIATE_COMMIT}/view.js`;
const FOLIATE_OVERLAYER_URL = `https://cdn.jsdelivr.net/gh/johnfactotum/foliate-js@${FOLIATE_COMMIT}/overlayer.js`;
const ZIP_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0/+esm';

/* ==========================================================
   保存キー
   ========================================================== */
const SETTINGS_KEY = 'book-reader:settings';
const LIBRARY_KEY = 'book-reader:library';
const BOOK_PREFIX = 'book-reader:book:';
const LIBRARY_LIMIT = 50;

/* ==========================================================
   DOM
   ========================================================== */
const $ = (id) => document.getElementById(id);

const libraryView = $('library-view');
const fileInput = $('file-input');
const dropZone = $('drop-zone');
const pickButton = $('pick-button');
const recentSection = $('recent-section');
const recentList = $('recent-list');
const clearRecent = $('clear-recent');

const readerView = $('reader-view');
const btnClose = $('btn-close');
const bookTitle = $('book-title');
const bookMeta = $('book-meta');
const btnToc = $('btn-toc');
const btnMarks = $('btn-marks');
const btnSettings = $('btn-settings');
const btnBookmark = $('btn-bookmark');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
const readerContent = $('reader-content');
const epubHost = $('epub-host');
const cbzHost = $('cbz-host');
const cbzImage = $('cbz-image');
const loadingOverlay = $('loading-overlay');
const loadingText = $('loading-text');
const tocPanel = $('toc-panel');
const tocList = $('toc-list');
const marksPanel = $('marks-panel');
const marksList = $('marks-list');
const highlightsList = $('highlights-list');
const btnExportHighlights = $('btn-export-highlights');
const btnPrev = $('btn-prev');
const btnNext = $('btn-next');
const pageLabel = $('page-label');
const settingsPopover = $('settings-popover');
const fontSizeRange = $('font-size-range');
const fontSizeLabel = $('font-size-label');
const marginRange = $('margin-range');
const marginLabel = $('margin-label');
const flowSelect = $('flow-select');
const toastEl = $('toast');

/* ==========================================================
   状態
   ========================================================== */
let settings = normalizeSettings(loadJson(SETTINGS_KEY, DEFAULT_SETTINGS));
let book = null; // { key, file, format, title, author, sectionCount }
let view = null; // foliate-view (EPUB)
let overlayerModule = null;
let zipReader = null; // zip.js ZipReader (CBZ)
let cbzEntries = [];
let cbzIndex = 0;
let cbzUrl = null;
let bookState = emptyBookState();
let saveTimer = null;
let currentPosition = { index: 0, fraction: 0, cfi: '', label: '' };
let currentSelection = null;

let foliateViewPromise = null;
let zipModulePromise = null;

function emptyBookState() {
  return { position: null, bookmarks: [], highlights: [] };
}

/* ==========================================================
   小さなヘルパー
   ========================================================== */
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function toast(message, kind = '') {
  toastEl.textContent = message;
  toastEl.className = `toast show${kind ? ` ${kind}` : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

function setLoading(show, text = '読み込み中…') {
  loadingOverlay.hidden = !show;
  loadingText.textContent = text;
}

function formatLanguageMap(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.length ? String(value[keys[0]] ?? '') : '';
  }
  return String(value);
}

function formatAuthor(author) {
  const one = (c) => (typeof c === 'string' ? c : formatLanguageMap(c?.name));
  if (Array.isArray(author)) return author.map(one).join(', ');
  return one(author);
}

async function loadFoliateView() {
  if (!foliateViewPromise) {
    foliateViewPromise = import(/* @vite-ignore */ FOLIATE_VIEW_URL);
  }
  return foliateViewPromise;
}

async function loadOverlayer() {
  if (!overlayerModule) overlayerModule = await import(/* @vite-ignore */ FOLIATE_OVERLAYER_URL);
  return overlayerModule;
}

async function loadZipModule() {
  if (!zipModulePromise) zipModulePromise = import(/* @vite-ignore */ ZIP_MODULE_URL);
  return zipModulePromise;
}

/* ==========================================================
   本棚
   ========================================================== */
function getLibrary() {
  const list = loadJson(LIBRARY_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveLibrary(list) {
  saveJson(LIBRARY_KEY, list.slice(0, LIBRARY_LIMIT));
}

function upsertLibraryRecord(record) {
  const list = getLibrary().filter((r) => r.key !== record.key);
  list.unshift(record);
  saveLibrary(list);
  renderLibrary();
}

function renderLibrary() {
  const list = getLibrary();
  recentSection.hidden = list.length === 0;
  recentList.replaceChildren();
  for (const rec of list) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'recent-open';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = rec.title || rec.name || '無題';
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const format = (rec.format || '').toUpperCase();
    meta.textContent = [format, formatBytes(rec.size), formatPercent(rec.fraction || 0)].filter(Boolean).join(' · ');
    main.append(title, meta);
    main.addEventListener('click', () => {
      toast('同じファイルを選ぶと続きから再開します');
      fileInput.click();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recent-remove';
    remove.setAttribute('aria-label', 'この本を履歴から消す');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      saveLibrary(getLibrary().filter((r) => r.key !== rec.key));
      try {
        localStorage.removeItem(BOOK_PREFIX + rec.key);
      } catch { /* ignore */ }
      renderLibrary();
    });

    li.append(main, remove);
    recentList.append(li);
  }
}

/* ==========================================================
   本を開く
   ========================================================== */
async function openFile(file) {
  if (!file) return;
  if (!isSupportedBookFile(file.name)) {
    toast('EPUB または CBZ を選んでください', 'error');
    return;
  }
  const format = detectFormat(file.name);
  resetReader();

  book = {
    key: buildBookKey(file),
    file,
    format,
    title: file.name.replace(/\.[^.]+$/, ''),
    author: '',
    sectionCount: 0,
  };
  bookState = loadJson(BOOK_PREFIX + book.key, null) || emptyBookState();
  bookState.bookmarks = Array.isArray(bookState.bookmarks) ? bookState.bookmarks : [];
  bookState.highlights = Array.isArray(bookState.highlights) ? bookState.highlights : [];

  libraryView.hidden = true;
  readerView.hidden = false;
  bookTitle.textContent = book.title;
  bookMeta.textContent = `${(format || '').toUpperCase()} · ${formatBytes(file.size)}`;
  setLoading(true, '本を読み込んでいます…');

  try {
    if (format === 'epub') await openEpub(file);
    else await openCbz(file);
    renderMarks();
    updateProgressUi();
    upsertLibraryRecord({
      key: book.key,
      name: file.name,
      size: file.size,
      format,
      title: book.title,
      author: book.author,
      fraction: currentPosition.fraction || 0,
      lastOpened: Date.now(),
    });
  } catch (err) {
    console.error(err);
    toast(`読み込みに失敗しました: ${err?.message ?? err}`, 'error');
    closeBook();
  } finally {
    setLoading(false);
  }
}

async function openEpub(file) {
  await loadFoliateView();
  view = document.createElement('foliate-view');
  epubHost.replaceChildren(view);
  await view.open(file);

  const foliateBook = view.book;
  book.title = formatLanguageMap(foliateBook.metadata?.title) || book.title;
  book.author = formatAuthor(foliateBook.metadata?.author);
  book.sectionCount = foliateBook.sections?.length ?? 0;
  bookTitle.textContent = book.title;
  bookMeta.textContent = [book.author, 'EPUB'].filter(Boolean).join(' · ');

  renderToc(normalizeToc(foliateBook.toc));

  view.addEventListener('load', onEpubLoad);
  view.addEventListener('relocate', onEpubRelocate);
  view.addEventListener('create-overlay', onEpubCreateOverlay);
  view.addEventListener('draw-annotation', onEpubDrawAnnotation);

  applyReaderSettings();

  // 保存済みの読書位置から再開 (fraction があればそれを優先)
  const saved = bookState.position ? normalizeReadingState(bookState.position) : null;
  if (saved && (saved.fraction > 0 || saved.cfi)) {
    try {
      await view.init({ lastLocation: { fraction: saved.fraction, cfi: saved.cfi } });
    } catch {
      await view.init({ showTextStart: true });
    }
  } else {
    await view.init({ showTextStart: true });
  }
  redrawHighlights();
}

async function openCbz(file) {
  const { configure, ZipReader, BlobReader, BlobWriter } = await loadZipModule();
  configure({ useWebWorkers: false });
  zipReader = new ZipReader(new BlobReader(file));
  const entries = await zipReader.getEntries();
  const byName = new Map(entries.map((e) => [e.filename, e]));
  const pages = sortCbzPages(entries.map((e) => e.filename));
  if (pages.length === 0) throw new Error('画像が見つかりませんでした');
  cbzEntries = pages.map((name) => byName.get(name));
  cbzIndex = 0;

  epubHost.hidden = true;
  cbzHost.hidden = false;
  renderToc([]);

  const saved = bookState.position ? normalizeReadingState(bookState.position) : null;
  if (saved && saved.index > 0) cbzIndex = clampIndex(saved.index, cbzEntries.length);
  await showCbzPage(cbzIndex);
}

function resetReader() {
  if (view) {
    try { view.close(); } catch { /* ignore */ }
    view = null;
  }
  if (zipReader) {
    try { zipReader.close(); } catch { /* ignore */ }
    zipReader = null;
  }
  if (cbzUrl) {
    URL.revokeObjectURL(cbzUrl);
    cbzUrl = null;
  }
  cbzEntries = [];
  epubHost.replaceChildren();
  epubHost.hidden = false;
  cbzHost.hidden = true;
  cbzImage.removeAttribute('src');
  tocList.replaceChildren();
  tocPanel.hidden = true;
  marksPanel.hidden = true;
  settingsPopover.hidden = true;
  currentSelection = null;
}

function closeBook() {
  resetReader();
  book = null;
  bookState = emptyBookState();
  currentPosition = { index: 0, fraction: 0, cfi: '', label: '' };
  readerView.hidden = true;
  libraryView.hidden = false;
  renderLibrary();
}

/* ==========================================================
   EPUB イベント
   ========================================================== */
function onEpubLoad({ detail }) {
  const { doc, index } = detail;
  doc.addEventListener('mouseup', () => captureSelection(index, doc));
  doc.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') captureSelection(index, doc);
  });
  doc.addEventListener('selectionchange', () => captureSelection(index, doc));
  doc.addEventListener('keydown', onKeyDown);
}

function onEpubRelocate({ detail }) {
  const { fraction, index, cfi, tocItem } = detail ?? {};
  currentPosition = {
    index: Number.isFinite(index) ? index : 0,
    fraction: Number.isFinite(fraction) ? fraction : 0,
    cfi: typeof cfi === 'string' ? cfi : '',
    label: tocItem?.label ? String(tocItem.label) : '',
  };
  if (tocItem?.href) highlightToc(tocItem.href);
  updateProgressUi();
  scheduleSave();
}

function onEpubCreateOverlay({ detail }) {
  const { index } = detail;
  for (const hl of bookState.highlights) {
    if (hl.index !== index || !hl.cfi) continue;
    view.addAnnotation({ value: hl.cfi, color: hl.color });
  }
}

async function onEpubDrawAnnotation({ detail }) {
  const { draw, annotation } = detail;
  const { Overlayer } = await loadOverlayer();
  draw(Overlayer.highlight, { color: annotation?.color || '#f6e05e' });
}

function captureSelection(index, doc) {
  const sel = doc.getSelection?.();
  const text = sel?.toString?.().trim?.() ?? '';
  if (!sel || sel.rangeCount === 0 || !text) {
    currentSelection = null;
    hideSelectionButton();
    return;
  }
  let cfi = '';
  try {
    cfi = view.getCFI(index, sel.getRangeAt(0));
  } catch {
    cfi = '';
  }
  currentSelection = { index, text, cfi };
  showSelectionButton();
}

async function redrawHighlights() {
  if (!view) return;
  for (const hl of bookState.highlights) {
    if (!hl.cfi) continue;
    try {
      await view.addAnnotation({ value: hl.cfi, color: hl.color });
    } catch { /* ページ外の注釈は無視 */ }
  }
}

/* ==========================================================
   CBZ
   ========================================================== */
async function showCbzPage(index) {
  const i = clampIndex(index, cbzEntries.length);
  if (i < 0) return;
  cbzIndex = i;
  const entry = cbzEntries[i];
  const { BlobWriter } = await loadZipModule();
  setLoading(true, `ページを読み込んでいます… (${i + 1}/${cbzEntries.length})`);
  try {
    const blob = await entry.getData(new BlobWriter());
    if (cbzUrl) URL.revokeObjectURL(cbzUrl);
    cbzUrl = URL.createObjectURL(blob);
    cbzImage.src = cbzUrl;
  } finally {
    setLoading(false);
  }
  currentPosition = {
    index: i,
    fraction: (i + 1) / cbzEntries.length,
    cfi: '',
    label: '',
  };
  updateProgressUi();
  scheduleSave();
}

/* ==========================================================
   ナビゲーション
   ========================================================== */
function goPrev() {
  if (!book) return;
  if (book.format === 'cbz') {
    if (cbzIndex > 0) showCbzPage(cbzIndex - 1);
  } else if (view) {
    view.goLeft();
  }
}

function goNext() {
  if (!book) return;
  if (book.format === 'cbz') {
    if (cbzIndex < cbzEntries.length - 1) showCbzPage(cbzIndex + 1);
  } else if (view) {
    view.goRight();
  }
}

function goToFraction(fraction) {
  if (view && Number.isFinite(fraction)) view.goToFraction(fraction);
}

function onKeyDown(e) {
  if (e.key === 'ArrowLeft') goPrev();
  else if (e.key === 'ArrowRight') goNext();
}

/* ==========================================================
   目次
   ========================================================== */
function renderToc(items) {
  const flat = Array.isArray(items) ? items : [];
  tocList.replaceChildren();
  btnToc.disabled = flat.length === 0;
  for (const item of flat) {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.style.setProperty('--depth', String(item.depth || 0));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toc-link';
    button.textContent = item.label || item.href || '(無題)';
    if (item.href) button.dataset.href = item.href;
    button.addEventListener('click', () => {
      if (!view || !item.href) return;
      view.goTo(item.href).catch(() => view.goTo(item.href.split('#')[0]).catch(() => {}));
      tocPanel.hidden = true;
    });
    li.append(button);
    tocList.append(li);
  }
}

function highlightToc(href) {
  const target = href.split('#')[0];
  for (const link of tocList.querySelectorAll('.toc-link')) {
    const active = link.dataset.href && link.dataset.href.split('#')[0] === target;
    link.classList.toggle('active', active);
  }
}

/* ==========================================================
   しおり・ハイライト
   ========================================================== */
function addBookmark() {
  if (!book) return;
  const entry = {
    index: currentPosition.index,
    fraction: currentPosition.fraction,
    cfi: currentPosition.cfi,
    label: currentPosition.label,
    createdAt: Date.now(),
  };
  const exists = bookState.bookmarks.some((b) =>
    isSameReadingState(
      { index: b.index, fraction: b.fraction, cfi: b.cfi },
      { index: entry.index, fraction: entry.fraction, cfi: entry.cfi },
    ));
  if (exists) {
    toast('この位置はすでにしおりがあります');
    return;
  }
  bookState.bookmarks.unshift(entry);
  persistBookState();
  renderMarks();
  toast('しおりを追加しました');
}

function addHighlight() {
  if (!currentSelection || !currentSelection.cfi) {
    toast('本文を選択してからハイライトを追加してください');
    return;
  }
  const entry = {
    cfi: currentSelection.cfi,
    index: currentSelection.index,
    text: currentSelection.text.slice(0, 500),
    color: '#f6e05e',
    createdAt: Date.now(),
  };
  if (bookState.highlights.some((h) => h.cfi === entry.cfi)) {
    toast('この範囲はすでにハイライトされています');
    hideSelectionButton();
    return;
  }
  bookState.highlights.push(entry);
  persistBookState();
  view?.addAnnotation({ value: entry.cfi, color: entry.color });
  renderMarks();
  hideSelectionButton();
  toast('ハイライトを追加しました');
}

function renderMarks() {
  marksList.replaceChildren();
  const bookmarks = [...bookState.bookmarks].sort((a, b) => a.fraction - b.fraction);
  if (bookmarks.length === 0) {
    marksList.append(emptyLi('しおりはまだありません'));
  }
  bookmarks.forEach((b) => {
    const li = document.createElement('li');
    li.className = 'mark-item';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'mark-go';
    go.textContent = readingPositionLabel({ fraction: b.fraction, label: b.label });
    go.addEventListener('click', () => {
      if (view) view.goTo({ fraction: b.fraction });
      else if (book?.format === 'cbz') showCbzPage(b.index);
      marksPanel.hidden = true;
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mark-remove';
    del.textContent = '×';
    del.setAttribute('aria-label', 'しおりを削除');
    del.addEventListener('click', () => {
      bookState.bookmarks = bookState.bookmarks.filter((x) => x !== b);
      persistBookState();
      renderMarks();
    });
    li.append(go, del);
    marksList.append(li);
  });

  highlightsList.replaceChildren();
  if (bookState.highlights.length === 0) {
    highlightsList.append(emptyLi('ハイライトはまだありません'));
  }
  bookState.highlights.forEach((h) => {
    const li = document.createElement('li');
    li.className = 'mark-item mark-highlight';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'mark-go';
    go.textContent = h.text || '(ハイライト)';
    go.addEventListener('click', () => {
      if (view && h.cfi) view.goTo(h.cfi).catch(() => {});
      marksPanel.hidden = true;
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mark-remove';
    del.textContent = '×';
    del.setAttribute('aria-label', 'ハイライトを削除');
    del.addEventListener('click', () => {
      bookState.highlights = bookState.highlights.filter((x) => x !== h);
      persistBookState();
      if (view && h.cfi) view.deleteAnnotation({ value: h.cfi });
      renderMarks();
    });
    li.append(go, del);
    highlightsList.append(li);
  });
}

function emptyLi(text) {
  const li = document.createElement('li');
  li.className = 'mark-empty';
  li.textContent = text;
  return li;
}

function exportHighlights() {
  if (!book) return;
  if (bookState.highlights.length === 0) {
    toast('書き出すハイライトがありません');
    return;
  }
  const lines = [`# ${book.title}`, '', `ハイライト ${bookState.highlights.length} 件`, ''];
  for (const h of bookState.highlights) {
    lines.push(`- ${h.text || '(本文なし)'}`);
    if (h.label) lines.push(`  - ${h.label}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildHighlightsFileName(book.file.name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('ハイライトを書き出しました');
}

/* ==========================================================
   選択時のフローティングボタン
   ========================================================== */
let selectionButton = null;

function ensureSelectionButton() {
  if (selectionButton) return selectionButton;
  selectionButton = document.createElement('button');
  selectionButton.type = 'button';
  selectionButton.className = 'selection-action';
  selectionButton.textContent = 'ハイライト';
  selectionButton.hidden = true;
  selectionButton.addEventListener('click', addHighlight);
  readerContent.append(selectionButton);
  return selectionButton;
}

function showSelectionButton() {
  ensureSelectionButton().hidden = false;
}

function hideSelectionButton() {
  if (selectionButton) selectionButton.hidden = true;
}

/* ==========================================================
   進捗・保存
   ========================================================== */
function updateProgressUi() {
  const percent = Math.round((currentPosition.fraction || 0) * 100);
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = `${percent}%`;
  if (book?.format === 'cbz') {
    pageLabel.textContent = buildCbzPageLabel(cbzIndex, cbzEntries.length);
  } else {
    pageLabel.textContent = readingPositionLabel(currentPosition);
  }
  const libraryRecord = getLibrary().find((r) => r.key === book?.key);
  if (libraryRecord && Math.abs((libraryRecord.fraction || 0) - (currentPosition.fraction || 0)) > 0.005) {
    libraryRecord.fraction = currentPosition.fraction;
    libraryRecord.lastOpened = Date.now();
    saveLibrary(getLibrary().map((r) => (r.key === libraryRecord.key ? libraryRecord : r)));
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    bookState.position = currentPosition;
    persistBookState();
  }, 400);
}

function persistBookState() {
  if (!book) return;
  const payload = {
    position: bookState.position ? normalizeReadingState(bookState.position) : null,
    bookmarks: bookState.bookmarks,
    highlights: bookState.highlights,
  };
  saveJson(BOOK_PREFIX + book.key, payload);
}

/* ==========================================================
   表示設定
   ========================================================== */
function applyReaderSettings() {
  settings = normalizeSettings(settings);
  saveJson(SETTINGS_KEY, settings);

  fontSizeRange.value = String(settings.fontScale);
  fontSizeLabel.textContent = `${Math.round(settings.fontScale * 100)}%`;
  marginRange.value = String(settings.margin);
  marginLabel.textContent = `${settings.margin}px`;
  flowSelect.value = settings.flow;
  for (const id of READER_THEMES) {
    const btn = document.getElementById(`theme-${id}`);
    if (btn) btn.classList.toggle('active', settings.readerTheme === id);
  }

  readerContent.dataset.readerTheme = settings.readerTheme;
  cbzHost.dataset.readerTheme = settings.readerTheme;

  if (view?.renderer) {
    view.renderer.setAttribute('flow', settings.flow);
    view.renderer.setAttribute('margin', `${settings.margin}px`);
    if (typeof view.renderer.setStyles === 'function') {
      view.renderer.setStyles(buildReaderCss(settings));
    }
  }
}

function bindSettingsControls() {
  fontSizeRange.min = String(FONT_SCALE.min);
  fontSizeRange.max = String(FONT_SCALE.max);
  fontSizeRange.step = String(FONT_SCALE.step);
  marginRange.min = String(MARGIN.min);
  marginRange.max = String(MARGIN.max);
  marginRange.step = String(MARGIN.step);

  fontSizeRange.addEventListener('input', () => {
    settings = normalizeSettings({ ...settings, fontScale: Number(fontSizeRange.value) });
    applyReaderSettings();
  });
  marginRange.addEventListener('input', () => {
    settings = normalizeSettings({ ...settings, margin: Number(marginRange.value) });
    applyReaderSettings();
  });
  flowSelect.addEventListener('change', () => {
    settings = normalizeSettings({ ...settings, flow: flowSelect.value });
    applyReaderSettings();
  });
  for (const id of READER_THEMES) {
    document.getElementById(`theme-${id}`)?.addEventListener('click', () => {
      settings = normalizeSettings({ ...settings, readerTheme: id });
      applyReaderSettings();
    });
  }
}

/* ==========================================================
   イベント登録
   ========================================================== */
function bindEvents() {
  pickButton.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', (e) => {
    if (e.target === pickButton) return;
    fileInput.click();
  });
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    openFile(file);
  });

  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
    });
  }
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });

  clearRecent.addEventListener('click', () => {
    saveJson(LIBRARY_KEY, []);
    renderLibrary();
    toast('本棚の履歴を消去しました');
  });

  btnClose.addEventListener('click', closeBook);
  btnPrev.addEventListener('click', goPrev);
  btnNext.addEventListener('click', goNext);
  btnBookmark.addEventListener('click', addBookmark);
  btnExportHighlights.addEventListener('click', exportHighlights);

  btnToc.addEventListener('click', () => {
    tocPanel.hidden = !tocPanel.hidden;
    if (!tocPanel.hidden) marksPanel.hidden = true;
  });
  btnMarks.addEventListener('click', () => {
    marksPanel.hidden = !marksPanel.hidden;
    if (!marksPanel.hidden) tocPanel.hidden = true;
  });
  btnSettings.addEventListener('click', () => {
    settingsPopover.hidden = !settingsPopover.hidden;
  });

  document.addEventListener('keydown', (e) => {
    if (readerView.hidden) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    onKeyDown(e);
  });
}

/* ==========================================================
   初期化
   ========================================================== */
function init() {
  bindEvents();
  bindSettingsControls();
  applyReaderSettings();
  renderLibrary();
}

init();
