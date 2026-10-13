/**
 * apps/music-library/script.js — 音楽ライブラリの UI
 *
 * 純ロジックは ./library.mjs に置き、ここは DOM / IndexedDB /
 * File System Access API / Web Audio / CDN からのライブラリ読み込みだけを担当する。
 * 音源とタグは端末外へ送信しない。
 */
import {
  DEFAULT_FILE_PATTERN,
  FILE_PATTERN_PRESETS,
  SORT_OPTIONS,
  TAG_LABELS,
  addToPlaylist,
  baseFileName,
  buildId3FramePlan,
  buildPlaylistFileName,
  buildTrackFileName,
  createPlaylist,
  deserializeLibrary,
  deserializePlaylists,
  diffTags,
  extensionOf,
  formatBytes,
  formatDuration,
  formatM3U,
  formatPattern,
  formatTrackNo,
  isWritableFileName,
  matchesQuery,
  matchM3UEntries,
  mergeTrack,
  moveInPlaylist,
  normalizeTrack,
  parseM3U,
  playlistStats,
  removeFromPlaylist,
  resolvePlaylist,
  sanitizeFileName,
  searchTracks,
  serializeLibrary,
  serializePlaylists,
  sortTracks,
  summarizeLibrary,
  trackDisplayName,
  trackSearchText,
} from './library.mjs';

/* ==========================================================
   定数 / DOM
   ========================================================== */

const MM_CDN_URLS = [
  'https://esm.sh/music-metadata@12.2.0',
  'https://cdn.jsdelivr.net/npm/music-metadata@12.2.0/+esm',
];
const ID3_CDN_URL = 'https://cdn.jsdelivr.net/npm/browser-id3-writer@6.4.0/dist/browser-id3-writer.mjs';

const IDB_NAME = 'myapps-music-library';
const IDB_VERSION = 1;
const IDB_STORE = 'state';
const IDB_KEY = 'current';

const $ = (id) => document.getElementById(id);

const els = {
  // scan
  scanPanel: $('scan-panel'),
  scanDirBtn: $('scan-dir-btn'),
  scanFilesBtn: $('scan-files-btn'),
  dirInput: $('dir-input'),
  filesInput: $('files-input'),
  scanStatus: $('scan-status'),
  scanProgress: $('scan-progress'),
  progressFill: $('progress-fill'),
  scanError: $('scan-error'),
  clearLibraryBtn: $('clear-library-btn'),
  // library
  librarySection: $('library-section'),
  searchInput: $('search-input'),
  sortSelect: $('sort-select'),
  sortDirBtn: $('sort-dir-btn'),
  genreFilterSelect: $('genre-filter-select'),
  libraryStats: $('library-stats'),
  trackRows: $('track-rows'),
  trackCount: $('track-count'),
  // detail
  detailPane: $('detail-pane'),
  coverImg: $('cover-img'),
  coverPlaceholder: $('cover-placeholder'),
  detailTitle: $('detail-title'),
  detailMeta: $('detail-meta'),
  editTitle: $('edit-title'),
  editArtist: $('edit-artist'),
  editAlbum: $('edit-album'),
  editAlbumArtist: $('edit-album-artist'),
  editTrack: $('edit-track'),
  editTrackTotal: $('edit-track-total'),
  editDisc: $('edit-disc'),
  editDiscTotal: $('edit-disc-total'),
  editYear: $('edit-year'),
  editGenre: $('edit-genre'),
  editComposer: $('edit-composer'),
  editComment: $('edit-comment'),
  tagDiff: $('tag-diff'),
  writeStatus: $('write-status'),
  applyTagsBtn: $('apply-tags-btn'),
  revertTagsBtn: $('revert-tags-btn'),
  saveFileBtn: $('save-file-btn'),
  downloadTagsBtn: $('download-tags-btn'),
  // playlist
  playlistPanel: $('playlist-panel'),
  playlistSelect: $('playlist-select'),
  playlistNewBtn: $('playlist-new-btn'),
  playlistRenameBtn: $('playlist-rename-btn'),
  playlistDeleteBtn: $('playlist-delete-btn'),
  playlistAddSelectedBtn: $('playlist-add-selected-btn'),
  playlistAddAllBtn: $('playlist-add-all-btn'),
  playlistClearBtn: $('playlist-clear-btn'),
  m3uImportBtn: $('m3u-import-btn'),
  m3uExportBtn: $('m3u-export-btn'),
  m3u8ExportBtn: $('m3u8-export-btn'),
  patternPresetSelect: $('pattern-preset-select'),
  patternInput: $('pattern-input'),
  patternPreview: $('pattern-preview'),
  playlistItems: $('playlist-items'),
  playlistStats: $('playlist-stats'),
  m3uInput: $('m3u-input'),
  // player
  playerBar: $('player-bar'),
  nowCover: $('now-cover'),
  nowTitle: $('now-title'),
  nowArtist: $('now-artist'),
  prevBtn: $('prev-btn'),
  playPauseBtn: $('play-pause-btn'),
  nextBtn: $('next-btn'),
  seekRange: $('seek-range'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  shuffleBtn: $('shuffle-btn'),
  repeatSelect: $('repeat-select'),
  volumeRange: $('volume-range'),
  audio: $('audio'),
  // misc
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
  toast: $('toast'),
};

const playIcon = document.querySelector('[data-play-icon]');
const pauseIcon = document.querySelector('[data-pause-icon]');

/* ==========================================================
   State
   ========================================================== */

const state = {
  tracks: [],
  byId: new Map(),
  playlists: [],
  currentPlaylistId: null,
  selectedId: null,
  query: '',
  sortKey: 'file',
  sortDir: 'asc',
  genreFilter: '',
  scanning: false,
  cancelScan: false,
  pattern: DEFAULT_FILE_PATTERN,
  queue: [],
  currentIndex: -1,
  shuffle: false,
  audioGraph: null,
  loadingPlaybacks: new Map(),
};

/* ==========================================================
   小さなユーティリティ
   ========================================================== */

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function setError(message) {
  if (!message) {
    els.scanError.hidden = true;
    els.scanError.textContent = '';
    return;
  }
  els.scanError.hidden = false;
  els.scanError.textContent = message;
}

function numOrNull(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.slice().buffer;
}

function commentText(common) {
  const value = common?.comment;
  if (!value) return '';
  if (Array.isArray(value)) {
    const first = value.find((c) => c && (typeof c === 'string' ? c : c.text));
    if (!first) return '';
    return typeof first === 'string' ? first : String(first.text ?? '');
  }
  return typeof value === 'string' ? value : String(value.text ?? '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ==========================================================
   CDN ライブラリ（動的 import）
   ========================================================== */

let musicMetadataPromise = null;
let id3WriterPromise = null;

async function loadMusicMetadata() {
  if (!musicMetadataPromise) {
    musicMetadataPromise = (async () => {
      let lastError = null;
      for (const url of MM_CDN_URLS) {
        try {
          const mod = await import(/* @vite-ignore */ url);
          if (typeof mod.parseBlob === 'function') return mod;
          lastError = new Error('parseBlob が見つかりません');
        } catch (error) {
          lastError = error;
        }
      }
      musicMetadataPromise = null;
      throw lastError ?? new Error('music-metadata を読み込めませんでした');
    })();
  }
  return musicMetadataPromise;
}

async function loadId3Writer() {
  if (!id3WriterPromise) {
    id3WriterPromise = (async () => {
      const mod = await import(/* @vite-ignore */ ID3_CDN_URL);
      if (typeof mod.ID3Writer !== 'function') throw new Error('ID3Writer が見つかりません');
      return mod;
    })().catch((error) => {
      id3WriterPromise = null;
      throw error;
    });
  }
  return id3WriterPromise;
}

/* ==========================================================
   IndexedDB 永続化
   ========================================================== */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch(() => {});
  }, 500);
}

async function persist() {
  const payload = {
    library: serializeLibrary(state.tracks, new Date().toISOString()),
    playlists: serializePlaylists(state.playlists),
    settings: {
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      pattern: state.pattern,
      currentPlaylistId: state.currentPlaylistId,
      repeat: els.repeatSelect.value,
      volume: Number(els.volumeRange.value),
    },
  };
  await idbPut(IDB_KEY, payload);
}

async function restore() {
  let payload = null;
  try {
    payload = await idbGet(IDB_KEY);
  } catch {
    payload = null;
  }
  if (!payload) return;
  const library = deserializeLibrary(payload.library);
  setTracks(library.tracks);
  state.playlists = deserializePlaylists(payload.playlists).map((pl, i) => ({ ...pl, id: pl.id || `pl_${i}` }));
  state.currentPlaylistId = payload.settings?.currentPlaylistId ?? state.playlists[0]?.id ?? null;
  if (payload.settings?.sortKey) state.sortKey = payload.settings.sortKey;
  if (payload.settings?.sortDir) state.sortDir = payload.settings.sortDir;
  if (payload.settings?.pattern) state.pattern = payload.settings.pattern;
  if (payload.settings?.repeat) els.repeatSelect.value = payload.settings.repeat;
  if (Number.isFinite(payload.settings?.volume)) els.volumeRange.value = String(payload.settings.volume);
}

/* ==========================================================
   トラック生成 / 走査
   ========================================================== */

function makeCoverUrl(data, format) {
  try {
    return URL.createObjectURL(new Blob([toArrayBuffer(data)], { type: format || 'image/jpeg' }));
  } catch {
    return '';
  }
}

async function parseFileToTrack(file, path, handle) {
  const mm = await loadMusicMetadata();
  let meta = null;
  try {
    meta = await mm.parseBlob(file, { duration: true });
  } catch {
    meta = null;
  }
  const common = meta?.common ?? {};
  const fmt = meta?.format ?? {};
  const pictures = Array.isArray(common.picture) ? common.picture : [];
  const cover = (typeof mm.selectCover === 'function' ? mm.selectCover(pictures) : null) ?? pictures[0] ?? null;

  const track = normalizeTrack({
    path,
    name: baseFileName(file.name || path),
    title: common.title,
    artist: common.artist,
    artists: common.artists,
    albumArtist: common.albumartist,
    album: common.album,
    trackNo: common.track?.no,
    trackTotal: common.track?.of,
    discNo: common.disk?.no,
    discTotal: common.disk?.of,
    year: common.year,
    genre: common.genre,
    composer: Array.isArray(common.composer) ? common.composer.join('; ') : common.composer,
    comment: commentText(common),
    duration: fmt.duration,
    bitrate: fmt.bitrate,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    channels: fmt.numberOfChannels,
    codec: fmt.codec,
    lossless: fmt.lossless,
    size: file.size,
  });
  track.file = file;
  track.handle = handle ?? null;
  if (cover?.data) {
    track.coverData = cover.data;
    track.coverFormat = cover.format || 'image/jpeg';
    track.coverUrl = makeCoverUrl(cover.data, track.coverFormat);
  }
  track.__searchText = trackSearchText(track);
  return track;
}

async function parseEntries(entries) {
  state.scanning = true;
  state.cancelScan = false;
  els.scanProgress.hidden = false;
  setError('');
  let done = 0;
  for (const entry of entries) {
    if (state.cancelScan) break;
    done += 1;
    els.progressFill.style.width = `${Math.round((done / entries.length) * 100)}%`;
    els.scanStatus.textContent = `解析中… ${done} / ${entries.length}（${entry.path}）`;
    try {
      const track = await parseFileToTrack(entry.file, entry.path, entry.handle);
      upsertTrack(track);
    } catch (error) {
      // 解析できないファイルはファイル名だけで登録する
      const fallback = normalizeTrack({ path: entry.path, name: baseFileName(entry.path), size: entry.file.size, error: String(error?.message ?? error) });
      fallback.file = entry.file;
      fallback.handle = entry.handle ?? null;
      fallback.__searchText = trackSearchText(fallback);
      upsertTrack(fallback);
    }
  }
  state.scanning = false;
  els.scanProgress.hidden = true;
  els.progressFill.style.width = '0%';
  els.scanStatus.textContent = `読み込み完了: ${state.tracks.length} 曲（うち今回 ${done} 件を解析）`;
  rebuildAfterLibraryChange();
  scheduleSave();
}

function upsertTrack(track) {
  const existingIndex = state.tracks.findIndex((t) => t.path === track.path);
  if (existingIndex >= 0) {
    const previous = state.tracks[existingIndex];
    // 別 id になった場合は旧 id を置き換える
    state.byId.delete(previous.id);
    state.tracks[existingIndex] = track;
  } else {
    state.tracks.push(track);
  }
  state.byId.set(track.id, track);
}

function setTracks(tracks) {
  state.tracks = tracks;
  state.byId = new Map(tracks.map((t) => [t.id, t]));
  for (const track of state.tracks) {
    if (!track.__searchText) track.__searchText = trackSearchText(track);
  }
}

function collectAudioFilesFromFiles(fileList) {
  return [...fileList]
    .filter((file) => /\.(mp3|m4a|m4b|mp4|aac|flac|ogg|oga|opus|wav|aiff|aif|aifc|wma|asf|ape|wv|mpc|mp2|mka|webm|dsf|dff)$/i.test(file.name))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name, handle: null }));
}

async function collectAudioFilesFromHandle(dirHandle, prefix, out) {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === 'file') {
      if (!/\.(mp3|m4a|m4b|mp4|aac|flac|ogg|oga|opus|wav|aiff|aif|aifc|wma|asf|ape|wv|mpc|mp2|mka|webm|dsf|dff)$/i.test(name)) continue;
      const file = await handle.getFile();
      out.push({ file, path, handle });
    } else if (handle.kind === 'directory') {
      await collectAudioFilesFromHandle(handle, `${path}/`, out);
    }
  }
}

async function scanDirectory() {
  if (state.scanning) {
    state.cancelScan = true;
    return;
  }
  if (typeof window.showDirectoryPicker === 'function') {
    let dir;
    try {
      dir = await window.showDirectoryPicker();
    } catch {
      return; // キャンセル
    }
    const entries = [];
    els.scanStatus.textContent = 'フォルダを走査しています…';
    els.scanProgress.hidden = false;
    await collectAudioFilesFromHandle(dir, '', entries);
    if (!entries.length) {
      els.scanProgress.hidden = true;
      setError('このフォルダに音声ファイルが見つかりませんでした。');
      return;
    }
    await parseEntries(entries);
  } else {
    els.dirInput.click();
  }
}

/* ==========================================================
   表示
   ========================================================== */

function visibleTracks() {
  let list = state.tracks;
  if (state.genreFilter) list = list.filter((t) => (t.genres ?? []).includes(state.genreFilter));
  if (state.query) list = searchTracks(list, state.query);
  return sortTracks(list, state.sortKey, state.sortDir);
}

function currentPlaylist() {
  return state.playlists.find((pl) => pl.id === state.currentPlaylistId) ?? null;
}

function fillSortOptions() {
  els.sortSelect.innerHTML = '';
  for (const option of SORT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = option.key;
    opt.textContent = option.label;
    els.sortSelect.appendChild(opt);
  }
  els.sortSelect.value = state.sortKey;
}

function fillPatternPresets() {
  els.patternPresetSelect.innerHTML = '';
  for (const preset of FILE_PATTERN_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.pattern;
    opt.textContent = preset.label;
    els.patternPresetSelect.appendChild(opt);
  }
  els.patternInput.value = state.pattern;
}

function fillGenreFilter() {
  const stats = summarizeLibrary(state.tracks);
  const current = els.genreFilterSelect.value;
  els.genreFilterSelect.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'すべて';
  els.genreFilterSelect.appendChild(all);
  for (const genre of stats.genres) {
    const opt = document.createElement('option');
    opt.value = genre;
    opt.textContent = genre;
    els.genreFilterSelect.appendChild(opt);
  }
  els.genreFilterSelect.value = stats.genres.includes(current) ? current : '';
}

function renderRows() {
  const list = visibleTracks();
  const fragment = document.createDocumentFragment();
  for (const track of list) {
    const tr = document.createElement('tr');
    tr.dataset.id = track.id;
    if (track.id === state.selectedId) tr.classList.add('is-selected');
    if (track.modified) tr.classList.add('is-modified');

    const cells = [
      formatTrackNo(track.trackNo, track.trackTotal) || '',
      track.title || fileTitle(track),
      track.artist || '',
      track.album || '',
      track.genre || '',
      track.year == null ? '' : String(track.year),
      formatDuration(track.duration),
      extensionOf(track.name).replace('.', '').toUpperCase(),
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => selectTrack(track.id));
    tr.addEventListener('dblclick', () => playTrack(track.id, true));
    fragment.appendChild(tr);
  }
  els.trackRows.replaceChildren(fragment);

  const stats = summarizeLibrary(state.tracks);
  els.libraryStats.textContent = state.tracks.length
    ? `${stats.count} 曲 / ${formatDuration(stats.duration)}${stats.durationKnown < stats.count ? '（長さ不明あり）' : ''} / ${formatBytes(stats.size)} / アーティスト ${stats.artists} / アルバム ${stats.albums}`
    : 'まだ音源がありません。';
  els.trackCount.textContent = `表示中: ${list.length} 曲`;
}

function fileTitle(track) {
  return baseFileName(track.name || track.path).replace(/\.[^.]+$/, '');
}

function renderDetail() {
  const track = state.selectedId ? state.byId.get(state.selectedId) : null;
  if (!track) {
    els.detailPane.hidden = true;
    return;
  }
  els.detailPane.hidden = false;
  els.detailTitle.textContent = trackDisplayName(track);
  els.detailMeta.textContent = [
    baseFileName(track.name || track.path),
    extensionOf(track.name).replace('.', '').toUpperCase(),
    formatDuration(track.duration),
    track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '',
    track.sampleRate ? `${Math.round(track.sampleRate / 100) / 10} kHz` : '',
    formatBytes(track.size),
    isWritableFileName(track.name) ? '書き込み可' : '読み取り専用',
  ]
    .filter(Boolean)
    .join(' · ');

  els.editTitle.value = track.title ?? '';
  els.editArtist.value = track.artist ?? '';
  els.editAlbum.value = track.album ?? '';
  els.editAlbumArtist.value = track.albumArtist ?? '';
  els.editTrack.value = track.trackNo ?? '';
  els.editTrackTotal.value = track.trackTotal ?? '';
  els.editDisc.value = track.discNo ?? '';
  els.editDiscTotal.value = track.discTotal ?? '';
  els.editYear.value = track.year ?? '';
  els.editGenre.value = track.genre ?? '';
  els.editComposer.value = track.composer ?? '';
  els.editComment.value = track.comment ?? '';

  if (track.coverUrl) {
    els.coverImg.src = track.coverUrl;
    els.coverImg.hidden = false;
    els.coverPlaceholder.hidden = true;
  } else {
    els.coverImg.hidden = true;
    els.coverImg.removeAttribute('src');
    els.coverPlaceholder.hidden = false;
  }

  const diff = diffTags(track, readTagForm());
  renderDiff(diff);
  els.saveFileBtn.disabled = !isWritableFileName(track.name);
}

function renderDiff(diff) {
  if (!diff.length) {
    els.tagDiff.hidden = true;
    els.tagDiff.textContent = '';
    return;
  }
  els.tagDiff.hidden = false;
  els.tagDiff.textContent = diff
    .map((d) => `${TAG_LABELS[d.field] ?? d.field}: 「${d.before || '（空）'}」→「${d.after || '（空）'}」`)
    .join(' / ');
}

function readTagForm() {
  return {
    title: els.editTitle.value,
    artist: els.editArtist.value,
    album: els.editAlbum.value,
    albumArtist: els.editAlbumArtist.value,
    trackNo: numOrNull(els.editTrack.value),
    trackTotal: numOrNull(els.editTrackTotal.value),
    discNo: numOrNull(els.editDisc.value),
    discTotal: numOrNull(els.editDiscTotal.value),
    year: numOrNull(els.editYear.value),
    genre: els.editGenre.value,
    composer: els.editComposer.value,
    comment: els.editComment.value,
  };
}

function renderPlaylists() {
  const list = state.playlists;
  els.playlistSelect.innerHTML = '';
  for (const pl of list) {
    const opt = document.createElement('option');
    opt.value = pl.id;
    opt.textContent = `${pl.name}（${pl.items.length}）`;
    els.playlistSelect.appendChild(opt);
  }
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（プレイリストなし）';
    els.playlistSelect.appendChild(opt);
  }
  if (state.currentPlaylistId && list.some((pl) => pl.id === state.currentPlaylistId)) {
    els.playlistSelect.value = state.currentPlaylistId;
  } else {
    state.currentPlaylistId = list[0]?.id ?? null;
    els.playlistSelect.value = state.currentPlaylistId ?? '';
  }

  const pl = currentPlaylist();
  els.playlistItems.replaceChildren();
  if (!pl) {
    els.playlistStats.textContent = 'プレイリストがありません。「新規」で作成してください。';
    return;
  }
  const resolved = resolvePlaylist(pl, state.tracks);
  resolved.forEach((track, index) => {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.draggable = true;
    li.dataset.index = String(index);

    const label = document.createElement('span');
    label.className = 'playlist-item-label';
    label.textContent = `${index + 1}. ${trackDisplayName(track)}`;
    label.addEventListener('click', () => playTrack(track.id, true));

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'btn btn-ghost btn-sm';
    up.textContent = '↑';
    up.disabled = index === 0;
    up.addEventListener('click', () => reorderPlaylist(index, index - 1));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'btn btn-ghost btn-sm';
    down.textContent = '↓';
    down.disabled = index === resolved.length - 1;
    down.addEventListener('click', () => reorderPlaylist(index, index + 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-sm';
    remove.textContent = '削除';
    remove.addEventListener('click', () => {
      updateCurrentPlaylist((current) => removeFromPlaylist(current, track.id));
    });

    li.append(label, up, down, remove);
    els.playlistItems.appendChild(li);
  });

  const stats = playlistStats(pl, state.tracks);
  els.playlistStats.textContent = `${stats.total} 曲（再生可能 ${stats.total - stats.missing} / 未読込 ${stats.missing}） / 合計 ${formatDuration(stats.duration)}`;
}

function renderPatternPreview() {
  const track = state.selectedId ? state.byId.get(state.selectedId) : state.tracks[0];
  if (!track) {
    els.patternPreview.textContent = '例: （音源を読み込むと表示されます）';
    return;
  }
  els.patternPreview.textContent = `例: ${buildTrackFileName(track, state.pattern)}`;
}

function rebuildAfterLibraryChange() {
  fillGenreFilter();
  renderRows();
  renderDetail();
  renderPlaylists();
  renderPatternPreview();
  const hasTracks = state.tracks.length > 0;
  els.librarySection.hidden = !hasTracks;
  els.playlistPanel.hidden = !hasTracks;
  els.playerBar.hidden = !hasTracks;
}

function render() {
  renderRows();
  renderDetail();
  renderPatternPreview();
}

/* ==========================================================
   選択 / タグ編集
   ========================================================== */

function selectTrack(id) {
  state.selectedId = id;
  renderRows();
  renderDetail();
  renderPatternPreview();
}

function currentTrack() {
  return state.selectedId ? state.byId.get(state.selectedId) : null;
}

function applyTags() {
  const track = currentTrack();
  if (!track) return;
  const patch = readTagForm();
  const changes = diffTags(track, patch);
  if (!changes.length) {
    els.writeStatus.textContent = '変更はありません。';
    return;
  }
  const updated = mergeTrack(track, { ...patch, modified: true });
  // 実行時フィールドを引き継ぐ
  updated.file = track.file;
  updated.handle = track.handle;
  updated.coverData = track.coverData;
  updated.coverFormat = track.coverFormat;
  updated.coverUrl = track.coverUrl;
  updated.__searchText = trackSearchText(updated);

  const index = state.tracks.findIndex((t) => t.id === track.id);
  if (index >= 0) state.tracks[index] = updated;
  state.byId.delete(track.id);
  state.byId.set(updated.id, updated);
  state.selectedId = updated.id;

  els.writeStatus.textContent = `${changes.length} 件のタグを一覧に反映しました（ファイルには未保存）。`;
  rebuildAfterLibraryChange();
  scheduleSave();
}

function revertTags() {
  renderDetail();
  els.writeStatus.textContent = '編集内容を元に戻しました。';
}

async function buildTaggedBlob(track) {
  const { ID3Writer } = await loadId3Writer();
  const file = track.file ?? (track.handle ? await track.handle.getFile() : null);
  if (!file) throw new Error('元のファイルが読み込まれていません。フォルダを選び直してください。');
  const buffer = await file.arrayBuffer();
  const writer = new ID3Writer(buffer);
  for (const { frame, value } of buildId3FramePlan(track)) {
    try {
      writer.setFrame(frame, value);
    } catch {
      // 未対応フレームは無視する
    }
  }
  if (track.coverData) {
    try {
      writer.setFrame('APIC', { type: 3, data: toArrayBuffer(track.coverData), description: '' });
    } catch {
      // カバーが不正でもタグ本体は書く
    }
  }
  writer.addTag();
  return writer.getBlob();
}

async function saveTagsToFile() {
  const track = currentTrack();
  if (!track) return;
  if (!isWritableFileName(track.name)) {
    els.writeStatus.textContent = 'この形式は書き込みに対応していません（MP3 のみ）。ダウンロードを利用してください。';
    return;
  }
  els.saveFileBtn.disabled = true;
  els.writeStatus.textContent = 'タグを書き込んでいます…';
  try {
    const blob = await buildTaggedBlob(track);
    if (track.handle) {
      try {
        const writable = await track.handle.createWritable();
        await writable.write(blob);
        await writable.close();
        els.writeStatus.textContent = 'ファイルに保存しました。';
      } catch (error) {
        els.writeStatus.textContent = `保存に失敗したためダウンロードします: ${error?.message ?? error}`;
        downloadBlob(blob, track.name || 'tagged.mp3');
      }
    } else {
      downloadBlob(blob, track.name || 'tagged.mp3');
      els.writeStatus.textContent = 'タグ付きファイルをダウンロードしました（上書き保存はフォルダ選択時のみ）。';
    }
    const updated = { ...track, modified: false };
    const index = state.tracks.findIndex((t) => t.id === track.id);
    if (index >= 0) state.tracks[index] = updated;
    state.byId.set(updated.id, updated);
    scheduleSave();
  } catch (error) {
    els.writeStatus.textContent = `書き込みに失敗しました: ${error?.message ?? error}`;
  } finally {
    els.saveFileBtn.disabled = !isWritableFileName(track.name);
  }
}

async function downloadTagged() {
  const track = currentTrack();
  if (!track) return;
  try {
    const blob = await buildTaggedBlob(track);
    const name = buildTrackFileName(track, state.pattern, extensionOf(track.name) || '.mp3');
    downloadBlob(blob, sanitizeFileName(baseFileName(name)) || track.name);
  } catch (error) {
    els.writeStatus.textContent = `書き出しに失敗しました: ${error?.message ?? error}`;
  }
}

/* ==========================================================
   プレイリスト
   ========================================================== */

function updateCurrentPlaylist(updater) {
  const index = state.playlists.findIndex((pl) => pl.id === state.currentPlaylistId);
  if (index < 0) return;
  const next = updater({ ...state.playlists[index], items: [...state.playlists[index].items] });
  state.playlists[index] = next;
  renderPlaylists();
  renderPatternPreview();
  scheduleSave();
}

function newPlaylist() {
  const name = prompt('プレイリスト名', `プレイリスト ${state.playlists.length + 1}`);
  if (name == null) return;
  const pl = createPlaylist(name.trim() || `プレイリスト ${state.playlists.length + 1}`);
  pl.id = `pl_${Date.now().toString(36)}`;
  pl.createdAt = new Date().toISOString();
  state.playlists.push(pl);
  state.currentPlaylistId = pl.id;
  renderPlaylists();
  scheduleSave();
}

function renamePlaylist() {
  const pl = currentPlaylist();
  if (!pl) return;
  const name = prompt('新しい名前', pl.name);
  if (name == null) return;
  updateCurrentPlaylist((current) => ({ ...current, name: name.trim() || current.name }));
}

function deletePlaylist() {
  const pl = currentPlaylist();
  if (!pl) return;
  if (!confirm(`「${pl.name}」を削除しますか？`)) return;
  state.playlists = state.playlists.filter((p) => p.id !== pl.id);
  state.currentPlaylistId = state.playlists[0]?.id ?? null;
  renderPlaylists();
  scheduleSave();
}

function addSelectedToPlaylist() {
  const pl = currentPlaylist();
  if (!pl) {
    toast('先にプレイリストを作成してください。');
    return;
  }
  const track = currentTrack();
  if (!track) {
    toast('曲を選択してください。');
    return;
  }
  updateCurrentPlaylist((current) => addToPlaylist(current, track.id));
  scheduleSave();
}

function addAllVisibleToPlaylist() {
  const pl = currentPlaylist();
  if (!pl) {
    toast('先にプレイリストを作成してください。');
    return;
  }
  const list = visibleTracks();
  updateCurrentPlaylist((current) => list.reduce((acc, track) => addToPlaylist(acc, track.id), current));
  scheduleSave();
}

function reorderPlaylist(from, to) {
  updateCurrentPlaylist((current) => moveInPlaylist(current, from, to));
  scheduleSave();
}

function exportM3U(ext) {
  const pl = currentPlaylist();
  if (!pl || !pl.items.length) {
    toast('プレイリストが空です。');
    return;
  }
  const text = formatM3U(pl, state.tracks, {
    name: pl.name,
    pathOf: (track) => buildTrackFileName(track, state.pattern),
  });
  const blob = new Blob([text], { type: ext === 'm3u8' ? 'audio/x-mpegurl;charset=utf-8' : 'audio/x-mpegurl' });
  downloadBlob(blob, buildPlaylistFileName(pl.name, ext));
}

async function importM3U(file) {
  const text = await file.text();
  const parsed = parseM3U(text);
  if (!parsed.entries.length) {
    toast('M3U に曲が含まれていませんでした。');
    return;
  }
  const matched = matchM3UEntries(parsed.entries, state.tracks);
  const ids = matched.filter((m) => m.track).map((m) => m.track.id);
  const pl = createPlaylist(parsed.name || file.name.replace(/\.[^.]+$/, ''));
  pl.id = `pl_${Date.now().toString(36)}`;
  pl.createdAt = new Date().toISOString();
  pl.items = [...new Set(ids)];
  state.playlists.push(pl);
  state.currentPlaylistId = pl.id;
  renderPlaylists();
  scheduleSave();
  const missing = matched.length - ids.length;
  toast(`${pl.items.length} 曲を取り込みました${missing ? `（照合できず ${missing} 件）` : ''}。`);
}

/* ==========================================================
   再生
   ========================================================== */

function ensureAudioGraph() {
  if (state.audioGraph) return state.audioGraph;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(els.audio);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    state.audioGraph = { ctx, gain };
    applyVolume();
  } catch {
    state.audioGraph = null;
  }
  return state.audioGraph;
}

function applyVolume() {
  const value = Number(els.volumeRange.value) / 100;
  if (state.audioGraph) state.audioGraph.gain.gain.value = value;
  els.audio.volume = value;
}

function buildQueueFromVisible() {
  return visibleTracks().map((t) => t.id);
}

function playTrack(id, autoplay = true) {
  const track = state.byId.get(id);
  if (!track) return;
  const queue = buildQueueFromVisible();
  let index = queue.indexOf(id);
  if (index < 0) {
    queue.push(id);
    index = queue.length - 1;
  }
  state.queue = queue;
  state.currentIndex = index;
  loadCurrentTrack(autoplay);
}

async function loadCurrentTrack(autoplay) {
  const id = state.queue[state.currentIndex];
  const track = id ? state.byId.get(id) : null;
  if (!track) return;
  if (!track.file && track.handle) {
    try {
      track.file = await track.handle.getFile();
    } catch {
      track.file = null;
    }
  }
  if (!track.file) {
    els.nowTitle.textContent = trackDisplayName(track);
    els.nowArtist.textContent = '（音源を読み込めません。フォルダを選び直してください）';
    return;
  }
  revokePlaybackUrl();
  const url = URL.createObjectURL(track.file);
  state.loadingPlaybacks.set(track.id, url);
  els.audio.src = url;
  els.audio.currentTime = 0;
  els.nowTitle.textContent = trackDisplayName(track);
  els.nowArtist.textContent = track.album || extensionOf(track.name).replace('.', '').toUpperCase();
  if (track.coverUrl) {
    els.nowCover.src = track.coverUrl;
    els.nowCover.hidden = false;
  } else {
    els.nowCover.hidden = true;
    els.nowCover.removeAttribute('src');
  }
  if (autoplay) {
    ensureAudioGraph();
    state.audioGraph?.ctx.resume().catch(() => {});
    try {
      await els.audio.play();
    } catch {
      // 自動再生ブロック。ユーザー操作で再開される
    }
  }
}

function revokePlaybackUrl() {
  for (const [id, url] of state.loadingPlaybacks) {
    URL.revokeObjectURL(url);
    state.loadingPlaybacks.delete(id);
  }
  els.audio.removeAttribute('src');
}

function togglePlay() {
  if (els.audio.paused) {
    ensureAudioGraph();
    state.audioGraph?.ctx.resume().catch(() => {});
    els.audio.play().catch(() => {});
  } else {
    els.audio.pause();
  }
}

function playNext(step = 1) {
  if (!state.queue.length) return;
  const repeat = els.repeatSelect.value;
  let nextIndex = state.currentIndex + step;
  if (state.shuffle && step > 0) {
    nextIndex = Math.floor(Math.random() * state.queue.length);
  } else if (nextIndex >= state.queue.length) {
    if (repeat === 'all') nextIndex = 0;
    else return;
  } else if (nextIndex < 0) {
    nextIndex = state.queue.length - 1;
  }
  state.currentIndex = nextIndex;
  loadCurrentTrack(true);
}

function updatePlayButton() {
  const paused = els.audio.paused;
  if (playIcon) playIcon.hidden = !paused;
  if (pauseIcon) pauseIcon.hidden = paused;
}

/* ==========================================================
   イベント登録
   ========================================================== */

function bindEvents() {
  els.scanDirBtn.addEventListener('click', scanDirectory);
  els.scanFilesBtn.addEventListener('click', () => els.filesInput.click());
  els.dirInput.addEventListener('change', async () => {
    const entries = collectAudioFilesFromFiles(els.dirInput.files);
    els.dirInput.value = '';
    if (!entries.length) {
      setError('音声ファイルが見つかりませんでした。');
      return;
    }
    await parseEntries(entries);
  });
  els.filesInput.addEventListener('change', async () => {
    const entries = collectAudioFilesFromFiles(els.filesInput.files);
    els.filesInput.value = '';
    if (!entries.length) {
      setError('音声ファイルが見つかりませんでした。');
      return;
    }
    await parseEntries(entries);
  });
  els.clearLibraryBtn.addEventListener('click', () => {
    if (state.tracks.length && !confirm('読み込んだライブラリ情報を消しますか？（元ファイルは消えません）')) return;
    revokePlaybackUrl();
    setTracks([]);
    state.selectedId = null;
    rebuildAfterLibraryChange();
    scheduleSave();
  });

  els.searchInput.addEventListener('input', () => {
    state.query = els.searchInput.value;
    render();
  });
  els.sortSelect.addEventListener('change', () => {
    state.sortKey = els.sortSelect.value;
    render();
    scheduleSave();
  });
  els.sortDirBtn.addEventListener('click', () => {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    els.sortDirBtn.textContent = state.sortDir === 'asc' ? '昇順 ↑' : '降順 ↓';
    render();
    scheduleSave();
  });
  els.genreFilterSelect.addEventListener('change', () => {
    state.genreFilter = els.genreFilterSelect.value;
    render();
  });

  els.applyTagsBtn.addEventListener('click', applyTags);
  els.revertTagsBtn.addEventListener('click', revertTags);
  els.saveFileBtn.addEventListener('click', saveTagsToFile);
  els.downloadTagsBtn.addEventListener('click', downloadTagged);

  els.playlistSelect.addEventListener('change', () => {
    state.currentPlaylistId = els.playlistSelect.value || null;
    renderPlaylists();
    scheduleSave();
  });
  els.playlistNewBtn.addEventListener('click', newPlaylist);
  els.playlistRenameBtn.addEventListener('click', renamePlaylist);
  els.playlistDeleteBtn.addEventListener('click', deletePlaylist);
  els.playlistAddSelectedBtn.addEventListener('click', addSelectedToPlaylist);
  els.playlistAddAllBtn.addEventListener('click', addAllVisibleToPlaylist);
  els.playlistClearBtn.addEventListener('click', () => {
    const pl = currentPlaylist();
    if (!pl) return;
    updateCurrentPlaylist((current) => ({ ...current, items: [] }));
    scheduleSave();
  });
  els.m3uExportBtn.addEventListener('click', () => exportM3U('m3u'));
  els.m3u8ExportBtn.addEventListener('click', () => exportM3U('m3u8'));
  els.m3uImportBtn.addEventListener('click', () => els.m3uInput.click());
  els.m3uInput.addEventListener('change', async () => {
    const file = els.m3uInput.files?.[0];
    els.m3uInput.value = '';
    if (file) await importM3U(file);
  });
  els.patternPresetSelect.addEventListener('change', () => {
    state.pattern = els.patternPresetSelect.value;
    els.patternInput.value = state.pattern;
    renderPatternPreview();
    scheduleSave();
  });
  els.patternInput.addEventListener('input', () => {
    state.pattern = els.patternInput.value || DEFAULT_FILE_PATTERN;
    renderPatternPreview();
    scheduleSave();
  });

  els.playPauseBtn.addEventListener('click', togglePlay);
  els.prevBtn.addEventListener('click', () => playNext(-1));
  els.nextBtn.addEventListener('click', () => playNext(1));
  els.shuffleBtn.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    els.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    els.shuffleBtn.classList.toggle('is-active', state.shuffle);
  });
  els.repeatSelect.addEventListener('change', scheduleSave);
  els.volumeRange.addEventListener('input', applyVolume);
  els.seekRange.addEventListener('input', () => {
    const duration = els.audio.duration;
    if (Number.isFinite(duration)) els.audio.currentTime = (Number(els.seekRange.value) / 1000) * duration;
  });

  els.audio.addEventListener('play', updatePlayButton);
  els.audio.addEventListener('pause', updatePlayButton);
  els.audio.addEventListener('ended', () => {
    if (els.repeatSelect.value === 'one') {
      els.audio.currentTime = 0;
      els.audio.play().catch(() => {});
      return;
    }
    playNext(1);
  });
  els.audio.addEventListener('timeupdate', () => {
    const duration = els.audio.duration;
    els.timeCurrent.textContent = formatDuration(els.audio.currentTime);
    els.timeTotal.textContent = Number.isFinite(duration) ? formatDuration(duration) : '--:--';
    if (Number.isFinite(duration) && duration > 0) {
      els.seekRange.value = String(Math.round((els.audio.currentTime / duration) * 1000));
    }
  });
  els.audio.addEventListener('loadedmetadata', () => {
    els.timeTotal.textContent = formatDuration(els.audio.duration);
  });

  els.infoBtn.addEventListener('click', () => {
    els.infoModal.hidden = false;
  });
  els.closeInfoBtn.addEventListener('click', () => {
    els.infoModal.hidden = true;
  });
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) els.infoModal.hidden = true;
  });

  window.addEventListener('beforeunload', () => {
    try {
      persist();
    } catch {
      // ignore
    }
  });
}

/* ==========================================================
   初期化
   ========================================================== */

async function init() {
  fillSortOptions();
  fillPatternPresets();
  bindEvents();
  applyVolume();
  els.sortDirBtn.textContent = state.sortDir === 'asc' ? '昇順 ↑' : '降順 ↓';

  try {
    await restore();
  } catch {
    // 復元できなくても空で開始する
  }
  // 復元したトラックは検索テキストを張り直す
  for (const track of state.tracks) {
    track.__searchText = trackSearchText(track);
  }
  rebuildAfterLibraryChange();

  if (!('showDirectoryPicker' in window)) {
    els.scanStatus.textContent += '（このブラウザはフォルダ選択に未対応のため、ファイル選択を使います）';
  }
}

init();
