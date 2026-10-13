/**
 * apps/dictionary/script.js — オフライン辞書の UI
 *
 * 純ロジックは ./dictionary.mjs に置き、ここは DOM / fetch / IndexedDB /
 * Cache Storage の配線だけを担当する。検索語は外部へ送信しない。
 */
import {
  DATA_PACKS,
  INBOX_KEYS,
  buildDataset,
  buildIndex,
  buildNote,
  buildStudyCard,
  dataFileUrl,
  datasetStats,
  glossLine,
  japaneseQuery,
  lookupKanji,
  migrateDataset,
  parseDictionaryArchive,
  posLabel,
  pushInbox,
  readingLine,
  searchByKanji,
  searchEnglish,
  searchJapanese,
} from './dictionary.mjs';

/* ==========================================================
   定数 / DOM
   ========================================================== */

const CACHE_NAME = 'dictionary-data-v1';
const IDB_NAME = 'myapps-dictionary';
const IDB_VERSION = 1;
const IDB_STORE = 'datasets';

const $ = (id) => document.getElementById(id);

const els = {
  dataPanel: $('data-panel'),
  dataStatus: $('data-status'),
  dataBadge: $('data-badge'),
  downloadBtn: $('download-btn'),
  importBtn: $('import-btn'),
  clearBtn: $('clear-btn'),
  fileInput: $('file-input'),
  dataProgress: $('data-progress'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  dataError: $('data-error'),
  searchPanel: $('search-panel'),
  searchInput: $('search-input'),
  romajiHint: $('romaji-hint'),
  resultCount: $('result-count'),
  copyAllBtn: $('copy-all-btn'),
  kanjiPanel: $('kanji-panel'),
  results: $('results'),
  modeHint: $('mode-hint'),
  toast: $('toast'),
};

const state = {
  pack: 'standard',
  dataset: null,
  index: null,
  mode: 'ja',
  results: [],
};

let toastTimer = null;

/* ==========================================================
   小物
   ========================================================== */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function showError(message) {
  els.dataError.textContent = message;
  els.dataError.hidden = !message;
}

function setProgress(ratio, text) {
  els.dataProgress.hidden = ratio === null;
  if (ratio === null) return;
  els.progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  els.progressText.textContent = text || '';
}

function selectedPack() {
  const checked = document.querySelector('input[name="pack"]:checked');
  return checked ? checked.value : 'standard';
}

/* ==========================================================
   IndexedDB
   ========================================================== */

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('この環境では IndexedDB を利用できません。'));
      return;
    }
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB を開けませんでした。'));
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const request = tx.objectStore(IDB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const request = tx.objectStore(IDB_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/* ==========================================================
   データ取得 (Cache Storage -> IndexedDB)
   ========================================================== */

async function fetchBytes(url) {
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(bytes.slice(), { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      /* Cache Storage が使えなくても続行する */
    }
    return bytes;
  } catch (error) {
    // オフライン / CORS 失敗時は Cache Storage を試す
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) return new Uint8Array(await cached.arrayBuffer());
    } catch {
      /* fallthrough */
    }
    throw error;
  }
}

async function downloadPack(pack) {
  showError('');
  els.downloadBtn.disabled = true;
  els.importBtn.disabled = true;
  try {
    const files = [
      { kind: 'jmdict', url: dataFileUrl('jmdict', pack) },
      { kind: 'kanjidic', url: dataFileUrl('kanjidic', pack) },
    ];
    const parsed = { jmdict: null, kanjidic: null };
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setProgress(i / (files.length + 1), `${file.kind} を取得中…`);
      const bytes = await fetchBytes(file.url);
      setProgress((i + 0.5) / (files.length + 1), `${file.kind} を展開中…`);
      const { data } = await parseDictionaryArchive(bytes);
      parsed[file.kind] = data;
    }
    setProgress(1, '索引を構築中…');
    await activate(buildDataset({ jmdict: parsed.jmdict, kanjidic: parsed.kanjidic, pack, now: new Date().toISOString() }));
    showToast('辞書データを取得しました。');
  } catch (error) {
    showError(
      `自動取得に失敗しました（${error.message}）。ネットワークまたは CORS が原因の可能性があります。` +
        '配布ページから .json.tgz を保存し、「ファイルを取り込む」から選んでください。',
    );
  } finally {
    setProgress(null);
    els.downloadBtn.disabled = false;
    els.importBtn.disabled = false;
  }
}

async function importFiles(fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;
  showError('');
  setProgress(0.1, 'ファイルを読み込み中…');
  try {
    const parsed = { jmdict: null, kanjidic: null };
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setProgress((i + 0.3) / (files.length + 1), `${file.name} を展開中…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { data } = await parseDictionaryArchive(bytes);
      if (Array.isArray(data?.characters)) parsed.kanjidic = data;
      else if (Array.isArray(data?.words)) parsed.jmdict = data;
    }
    if (!parsed.jmdict && !parsed.kanjidic) {
      throw new Error('辞書データを認識できませんでした (jmdict-*.json.tgz / kanjidic2-en-*.json.tgz)。');
    }
    // 片方だけでも取り込み、保存済みのもう片方と合成する。
    const previous = (await idbGet(state.pack)) || (await idbGet('standard')) || (await idbGet('full'));
    const jmdict = parsed.jmdict || null;
    const kanjidic = parsed.kanjidic || null;
    const dataset = buildDataset({ jmdict, kanjidic, pack: state.pack, now: new Date().toISOString() });
    if (previous && (!parsed.jmdict || !parsed.kanjidic)) {
      // 既存データを保持して不足分だけ差し替える
      if (!parsed.jmdict) dataset.words = previous.words;
      if (!parsed.kanjidic) dataset.kanji = previous.kanji;
    }
    setProgress(0.9, '索引を構築中…');
    await activate(migrateDataset(dataset));
    showToast('辞書データを取り込みました。');
  } catch (error) {
    showError(`取り込みに失敗しました（${error.message}）。`);
  } finally {
    setProgress(null);
    els.fileInput.value = '';
  }
}

async function activate(dataset) {
  const migrated = migrateDataset(dataset);
  state.pack = migrated.pack;
  state.dataset = migrated;
  state.index = buildIndex(migrated);
  await idbPut(migrated.pack, migrated);
  renderDataState(true);
  runSearch();
  els.searchInput.focus();
}

async function clearData() {
  const keys = await idbKeys();
  for (const key of keys) await idbDelete(key);
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
  state.dataset = null;
  state.index = null;
  state.results = [];
  renderDataState(false);
  els.results.innerHTML = '';
  els.kanjiPanel.hidden = true;
  els.resultCount.textContent = '';
  showToast('保存済みデータを削除しました。');
}

/* ==========================================================
   表示
   ========================================================== */

function renderDataState(ready) {
  const stats = ready ? datasetStats(state.dataset) : { words: 0, kanji: 0 };
  if (ready) {
    els.dataStatus.textContent =
      `${DATA_PACKS[state.pack]?.label || state.pack} / 語 ${stats.words.toLocaleString('ja-JP')} 件・漢字 ${stats.kanji.toLocaleString('ja-JP')} 字。オフラインで引けます。`;
    els.dataBadge.textContent = '取得済み';
    els.dataBadge.className = 'badge badge-cached';
    els.clearBtn.hidden = false;
    els.downloadBtn.hidden = true;
    els.importBtn.hidden = true;
    els.searchPanel.hidden = false;
  } else {
    els.dataStatus.textContent = '未取得です。下のボタンで取得するか、ファイルを取り込んでください。';
    els.dataBadge.textContent = '未取得';
    els.dataBadge.className = 'badge badge-missing';
    els.clearBtn.hidden = true;
    els.downloadBtn.hidden = false;
    els.importBtn.hidden = false;
    els.searchPanel.hidden = true;
  }
}

const MODE_HINTS = {
  ja: '見出し・読み・ローマ字で引きます（国語＝読みと品詞、和英＝語義は英語）。',
  en: '英語の語義から日本語の語を探します（英和）。',
  kanji: '漢字 1 字の読み・意味（Kanjidic）と、その字を使う語を表示します。',
};

function renderKanjiPanel(query) {
  const first = String(query ?? '').trim()[0];
  const char = first ? lookupKanji(state.index, first) : null;
  if (!char) {
    els.kanjiPanel.hidden = true;
    els.kanjiPanel.innerHTML = '';
    return;
  }
  const rows = [];
  rows.push(`<div class="kanji-literal">${escapeHtml(char.literal)}</div>`);
  const meta = [];
  if (char.on.length) meta.push(`音: ${char.on.map(escapeHtml).join('・')}`);
  if (char.kun.length) meta.push(`訓: ${char.kun.map(escapeHtml).join('・')}`);
  if (char.strokes) meta.push(`画数: ${char.strokes}`);
  if (char.grade) meta.push(`学年: ${char.grade}`);
  if (char.jlpt) meta.push(`JLPT: N${char.jlpt}`);
  if (char.freq) meta.push(`頻度: ${char.freq} 位`);
  if (meta.length) rows.push(`<p class="kanji-meta">${meta.join(' / ')}</p>`);
  if (char.meanings.length) rows.push(`<p class="kanji-meaning">${char.meanings.map(escapeHtml).join('; ')}</p>`);
  els.kanjiPanel.innerHTML = rows.join('');
  els.kanjiPanel.hidden = false;
}

function renderResults() {
  const results = state.results;
  if (!state.query) {
    els.results.innerHTML = '<p class="empty">語を入力してください。</p>';
    els.resultCount.textContent = '';
    els.copyAllBtn.hidden = true;
    return;
  }
  els.resultCount.textContent = results.length ? `${results.length} 件` : '見つかりませんでした';
  els.copyAllBtn.hidden = results.length === 0;
  if (results.length === 0) {
    els.results.innerHTML = '<p class="empty">該当する語がありません。別の表記や読みで試してください。</p>';
    return;
  }
  els.results.innerHTML = results
    .map((word, index) => {
      const pos = [...new Set((word.senses || []).flatMap((s) => s.pos || []))]
        .slice(0, 4)
        .map((tag) => `<span class="pos-chip">${escapeHtml(posLabel(tag))}</span>`)
        .join('');
      const senses = (word.senses || [])
        .slice(0, 3)
        .map((sense) => {
          const gloss = (sense.gloss || []).map(escapeHtml).join('; ');
          if (!gloss) return '';
          return `<li>${gloss}</li>`;
        })
        .filter(Boolean)
        .join('');
      const reading = readingLine(word);
      const tags = (word.kanji || []).slice(0, 3).map((k) => `<span class="kanji-chip">${escapeHtml(k.text)}</span>`).join('');
      return `
        <article class="word-card" data-index="${index}">
          <div class="word-main">
            <div class="word-title">
              <span class="word-head">${escapeHtml(word.head)}</span>
              ${word.common ? '<span class="badge badge-common">常用</span>' : ''}
            </div>
            ${reading ? `<div class="word-reading">${escapeHtml(reading)}</div>` : ''}
            ${tags ? `<div class="word-kanji">${tags}</div>` : ''}
            ${pos ? `<div class="word-pos">${pos}</div>` : ''}
            ${senses ? `<ul class="word-senses">${senses}</ul>` : ''}
          </div>
          <div class="word-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="card" title="study-cards のデッキへ送る">カードへ</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="note" title="notes-vault へ送る">ノートへ</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="copy" title="語義をコピー">コピー</button>
          </div>
        </article>`;
    })
    .join('');
}

/* ==========================================================
   受け渡し (study-cards / notes-vault)
   ========================================================== */

function readInbox(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeInbox(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function sendToStudyCards(word) {
  const card = buildStudyCard(word);
  const next = pushInbox(readInbox(INBOX_KEYS.studyCards), card, { key: 'front' });
  writeInbox(INBOX_KEYS.studyCards, next);
  showToast(`「${word.head}」を単語帳に送りました（${next.length} 件待ち）。`);
}

function sendToNotes(word) {
  const memo = window.prompt('メモ（任意）', '') ?? '';
  const note = buildNote(word, memo);
  const next = pushInbox(readInbox(INBOX_KEYS.notesVault), note, { key: 'title' });
  writeInbox(INBOX_KEYS.notesVault, next);
  showToast(`「${word.head}」をノートへ送りました（${next.length} 件待ち）。`);
}

async function copyText(text, label = 'コピーしました。') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    showToast('コピーできませんでした。');
  }
}

/* ==========================================================
   検索
   ========================================================== */

function runSearch() {
  if (!state.index) return;
  const query = els.searchInput.value;
  state.query = query;
  if (state.mode === 'en') {
    state.results = searchEnglish(state.index, query, { limit: 80 });
    els.kanjiPanel.hidden = true;
  } else if (state.mode === 'kanji') {
    state.results = searchByKanji(state.index, query, { limit: 80 });
    renderKanjiPanel(query);
  } else {
    state.results = searchJapanese(state.index, query, { limit: 80 });
    els.kanjiPanel.hidden = true;
  }
  updateRomajiHint(query);
  renderResults();
}

function updateRomajiHint(query) {
  const raw = String(query ?? '').trim();
  if (state.mode === 'ja' && /^[a-z'\- ]+$/i.test(raw) && raw) {
    const kana = japaneseQuery(raw);
    els.romajiHint.textContent = `→ ${kana}`;
    els.romajiHint.hidden = false;
  } else {
    els.romajiHint.hidden = true;
  }
}

let searchTimer = null;

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  els.modeHint.textContent = MODE_HINTS[mode] || '';
  els.searchInput.placeholder =
    mode === 'en' ? '例: school / give up' : mode === 'kanji' ? '例: 日 / 日本語' : '例: nihon / にほん / 日本';
  runSearch();
}

/* ==========================================================
   イベント
   ========================================================== */

els.downloadBtn.addEventListener('click', () => downloadPack(selectedPack()));
els.importBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => importFiles(els.fileInput.files));
els.clearBtn.addEventListener('click', () => {
  if (window.confirm('保存済みの辞書データを削除しますか？次回また取得が必要になります。')) clearData();
});
els.searchInput.addEventListener('input', scheduleSearch);
document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
});

els.results.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('.word-card');
  const word = state.results[Number(card?.dataset.index)];
  if (!word) return;
  const action = button.dataset.action;
  if (action === 'card') sendToStudyCards(word);
  else if (action === 'note') sendToNotes(word);
  else if (action === 'copy') copyText(glossLine(word, { max: 6 }) || word.head);
});

els.copyAllBtn.addEventListener('click', () => {
  const text = state.results.map((word) => `${word.head}\t${readingLine(word)}\t${glossLine(word)}`).join('\n');
  copyText(text, `${state.results.length} 件をコピーしました。`);
});

/* ==========================================================
   初期化
   ========================================================== */

async function init() {
  els.modeHint.textContent = MODE_HINTS.ja;
  try {
    const keys = await idbKeys();
    const key = keys.includes('standard') ? 'standard' : keys.includes('full') ? 'full' : keys[0];
    if (key) {
      const stored = await idbGet(key);
      if (stored) {
        await activate(stored);
        return;
      }
    }
  } catch {
    /* IndexedDB が使えない環境でも動くようにする */
  }
  renderDataState(false);
}

init();
