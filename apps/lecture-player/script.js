/**
 * script.js — 講義プレイヤーの UI ロジック
 *
 * 中核はブラウザ標準 API だけで完結する:
 *   - <video> / <audio> の再生と playbackRate (倍速)
 *   - <track> へ WebVTT を登録 (SRT は自前で変換) + 独自オーバーレイ描画
 *   - URL.createObjectURL でファイルをストリーム再生 (メモリに載せない)
 *   - requestVideoFrameCallback で現在フレームを書き出す (対応環境のみ)
 *   - タイムスタンプ付きマーカーを Markdown / JSON へ書き出す
 *
 * 純ロジックは pipeline.mjs に分離し、node --test で検証する。
 */

import {
  RATE_PRESETS,
  SEEK_STEP,
  SEEK_STEP_LARGE,
  NOTES_MIME,
  MARKERS_MIME,
  clampRate,
  seekBy,
  nextRate,
  formatClock,
  formatRate,
  fileBaseName,
  partitionFiles,
  findMatchingSubtitle,
  buildExportName,
  detectSubtitleFormat,
  parseSubtitle,
  srtToVtt,
  findActiveCue,
  normalizeLoop,
  shouldLoopBack,
  addMarker,
  removeMarker,
  updateMarkerNote,
  serializeMarkers,
  buildNotesMarkdown,
} from './pipeline.mjs';

const RATE_STORAGE_KEY = 'lecture-player-rate';
const CAN_CAPTURE_FRAME =
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  playerSection: $('player-section'),
  video: $('video'),
  videoStage: document.querySelector('.video-stage'),
  subtitleOverlay: $('subtitle-overlay'),
  audioPlaceholder: $('audio-placeholder'),
  prevBtn: $('prev-btn'),
  backBtn: $('back-btn'),
  playBtn: $('play-btn'),
  fwdBtn: $('fwd-btn'),
  nextBtn: $('next-btn'),
  timeLabel: $('time-label'),
  seekRange: $('seek-range'),
  durationLabel: $('duration-label'),
  rateRange: $('rate-range'),
  rateValue: $('rate-value'),
  rateResetBtn: $('rate-reset-btn'),
  ratePresets: $('rate-presets'),
  setABtn: $('set-a-btn'),
  setBBtn: $('set-b-btn'),
  loopToggleBtn: $('loop-toggle-btn'),
  clearLoopBtn: $('clear-loop-btn'),
  loopInfo: $('loop-info'),
  playlist: $('playlist'),
  playlistCount: $('playlist-count'),
  playlistEmpty: $('playlist-empty'),
  clearAllBtn: $('clear-all-btn'),
  subtitleStatus: $('subtitle-status'),
  subtitleFileInput: $('subtitle-file-input'),
  subtitlePaste: $('subtitle-paste'),
  applySubtitleBtn: $('apply-subtitle-btn'),
  clearSubtitleBtn: $('clear-subtitle-btn'),
  markerNote: $('marker-note'),
  addMarkerBtn: $('add-marker-btn'),
  markerList: $('marker-list'),
  markerCount: $('marker-count'),
  markerEmpty: $('marker-empty'),
  exportNotesBtn: $('export-notes-btn'),
  copyNotesBtn: $('copy-notes-btn'),
  exportMarkersBtn: $('export-markers-btn'),
  clearMarkersBtn: $('clear-markers-btn'),
  screenshotBtn: $('screenshot-btn'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
};

/* ---------- State ---------- */

const state = {
  /** [{ id, name, url, markers: [] }] */
  playlist: [],
  current: -1,
  /** 選択された字幕 File (自動照合に使う) */
  subtitleFiles: [],
  cues: [],
  subtitleUrl: null,
  subtitleName: '',
  rate: 1,
  loopA: null,
  loopB: null,
  loop: null,
  loopEnabled: false,
  scrubbing: false,
};

/* ---------- ユーティリティ ---------- */

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function clearError() {
  els.errorBox.textContent = '';
  els.errorBox.hidden = true;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentTrack() {
  return state.current >= 0 ? state.playlist[state.current] : null;
}

function getMarkers() {
  const track = currentTrack();
  return track ? track.markers : [];
}

function setMarkers(markers) {
  const track = currentTrack();
  if (track) track.markers = markers;
}

function isInteractiveTarget(target) {
  if (!target || !target.tagName) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}

/* ---------- ファイルの読み込み ---------- */

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  clearError();

  const { media, subtitles } = partitionFiles(files.map((file) => file.name));
  if (media.length === 0 && subtitles.length === 0) {
    showError('対応しているのは動画・音声 (mp4 / webm / mp3 / m4a など) と字幕 (.vtt / .srt) です。');
    return;
  }

  for (const name of subtitles) {
    if (state.subtitleFiles.some((file) => file.name === name)) continue;
    const file = files.find((candidate) => candidate.name === name);
    if (file) state.subtitleFiles.push(file);
  }

  const hadTracks = state.playlist.length > 0;
  for (const name of media) {
    const file = files.find((candidate) => candidate.name === name);
    if (!file) continue;
    if (state.playlist.some((track) => track.name === name)) continue;
    state.playlist.push({ id: makeId(), name, url: URL.createObjectURL(file), markers: [] });
  }

  renderPlaylist();
  if (!hadTracks && state.playlist.length > 0) {
    loadTrack(0);
  } else if (state.current < 0 && state.playlist.length > 0) {
    loadTrack(0);
  }
}

function loadTrack(index) {
  if (index < 0 || index >= state.playlist.length) return;
  const track = state.playlist[index];
  state.current = index;

  els.playerSection.hidden = false;
  clearSubtitleTrack();
  els.subtitlePaste.value = '';
  els.markerNote.value = '';

  els.video.src = track.url;
  els.video.load();

  renderPlaylist();
  renderMarkers();
  resetLoop();
  updateSubtitleStatus('字幕は未読み込みです。');

  const subtitleName = findMatchingSubtitle(
    track.name,
    state.subtitleFiles.map((file) => file.name),
  );
  if (subtitleName) {
    const file = state.subtitleFiles.find((candidate) => candidate.name === subtitleName);
    if (file) {
      file
        .text()
        .then((text) => attachSubtitle(subtitleName, text))
        .catch(() => showError('字幕ファイルを読み込めませんでした。'));
    }
  }
}

function selectTrack(index) {
  const count = state.playlist.length;
  if (count === 0) return;
  const next = ((index % count) + count) % count;
  loadTrack(next);
}

function removeTrack(index) {
  if (index < 0 || index >= state.playlist.length) return;
  const [removed] = state.playlist.splice(index, 1);
  URL.revokeObjectURL(removed.url);

  if (state.playlist.length === 0) {
    resetPlayer();
  } else if (index === state.current) {
    state.current = -1;
    loadTrack(Math.min(index, state.playlist.length - 1));
  } else if (index < state.current) {
    state.current -= 1;
  }
  renderPlaylist();
}

function clearAll() {
  for (const track of state.playlist) URL.revokeObjectURL(track.url);
  state.playlist = [];
  resetPlayer();
  renderPlaylist();
}

function resetPlayer() {
  state.current = -1;
  els.video.removeAttribute('src');
  els.video.load();
  els.playerSection.hidden = true;
  els.videoStage.classList.remove('is-audio');
  els.audioPlaceholder.hidden = true;
  clearSubtitleTrack();
  renderMarkers();
}

/* ---------- プレイリスト ---------- */

function renderPlaylist() {
  els.playlist.innerHTML = '';
  els.playlistCount.textContent = state.playlist.length
    ? `${state.playlist.length} 件`
    : '';
  els.playlistEmpty.hidden = state.playlist.length > 0;
  els.clearAllBtn.disabled = state.playlist.length === 0;

  state.playlist.forEach((track, index) => {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.dataset.index = String(index);
    if (index === state.current) li.classList.add('is-current');

    const number = document.createElement('span');
    number.className = 'playlist-index';
    number.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'playlist-name';
    name.textContent = track.name;
    name.title = track.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'playlist-remove';
    remove.dataset.index = String(index);
    remove.setAttribute('aria-label', `${track.name} を取り除く`);
    remove.textContent = '×';

    li.append(number, name, remove);
    els.playlist.appendChild(li);
  });
}

/* ---------- 再生 ---------- */

function togglePlay() {
  if (!currentTrack()) return;
  if (els.video.paused) {
    els.video.play().catch(() => {
      /* autoplay 制限などは無視 */
    });
  } else {
    els.video.pause();
  }
}

function nudge(delta) {
  if (!currentTrack()) return;
  els.video.currentTime = seekBy(els.video.currentTime, delta, els.video.duration || 0);
  updateOverlay();
}

function applyRate(rate) {
  const value = clampRate(rate);
  state.rate = value;
  els.video.playbackRate = value;
  els.rateRange.value = String(value);
  els.rateValue.textContent = formatRate(value);
  for (const button of els.ratePresets.querySelectorAll('.rate-preset')) {
    button.classList.toggle('is-active', Number(button.dataset.rate) === value);
  }
  try {
    localStorage.setItem(RATE_STORAGE_KEY, String(value));
  } catch {
    /* ストレージ不可でも続行 */
  }
}

function onLoadedMetadata() {
  const duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
  els.durationLabel.textContent = formatClock(duration);
  els.seekRange.max = String(duration);
  els.seekRange.value = '0';
  els.timeLabel.textContent = '0:00';

  const isAudio = els.video.videoWidth === 0;
  els.videoStage.classList.toggle('is-audio', isAudio);
  els.audioPlaceholder.hidden = !isAudio;
  els.screenshotBtn.disabled = isAudio || !CAN_CAPTURE_FRAME;
}

function onTimeUpdate() {
  const time = els.video.currentTime;
  if (!state.scrubbing) els.seekRange.value = String(time);
  els.timeLabel.textContent = formatClock(time);
  updateOverlay();

  if (state.loopEnabled && shouldLoopBack(time, state.loop)) {
    els.video.currentTime = state.loop.start;
  }
}

function setPlayIcon(playing) {
  const playIcon = els.playBtn.querySelector('[data-play-icon]');
  const pauseIcon = els.playBtn.querySelector('[data-pause-icon]');
  if (playIcon) playIcon.hidden = playing;
  if (pauseIcon) pauseIcon.hidden = !playing;
}

/* ---------- 字幕 ---------- */

function attachTrackElement(url) {
  for (const track of els.video.querySelectorAll('track')) track.remove();
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = '字幕';
  track.srclang = 'ja';
  track.src = url;
  track.default = true;
  track.addEventListener('load', () => {
    for (const textTrack of els.video.textTracks) textTrack.mode = 'hidden';
  });
  els.video.appendChild(track);
}

function attachSubtitle(name, rawText) {
  const text = String(rawText || '');
  if (!text.trim()) {
    showError('字幕が空でした。');
    return;
  }
  const cues = parseSubtitle(text);
  if (cues.length === 0) {
    showError('字幕を解釈できませんでした。SRT または VTT を選んでください。');
    return;
  }

  state.cues = cues;
  state.subtitleName = name;
  const vtt = detectSubtitleFormat(text) === 'vtt' ? text : srtToVtt(text);
  if (state.subtitleUrl) URL.revokeObjectURL(state.subtitleUrl);
  state.subtitleUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  attachTrackElement(state.subtitleUrl);
  updateSubtitleStatus(`「${name}」を読み込みました (${cues.length} 行)。`);
}

function clearSubtitleTrack() {
  for (const track of els.video.querySelectorAll('track')) track.remove();
  if (state.subtitleUrl) URL.revokeObjectURL(state.subtitleUrl);
  state.subtitleUrl = null;
  state.cues = [];
  state.subtitleName = '';
  els.subtitleOverlay.hidden = true;
  els.subtitleOverlay.textContent = '';
}

function clearSubtitle() {
  clearSubtitleTrack();
  updateSubtitleStatus('字幕は未読み込みです。');
}

function updateSubtitleStatus(message) {
  els.subtitleStatus.textContent = message;
}

function updateOverlay() {
  const cue = findActiveCue(state.cues, els.video.currentTime);
  if (cue && cue.text) {
    els.subtitleOverlay.textContent = cue.text;
    els.subtitleOverlay.hidden = false;
  } else {
    els.subtitleOverlay.hidden = true;
    els.subtitleOverlay.textContent = '';
  }
}

/* ---------- A-B ループ ---------- */

function recomputeLoop() {
  const duration = els.video.duration || 0;
  state.loop = normalizeLoop(state.loopA, state.loopB, duration);
  const valid = Boolean(state.loop);
  els.loopToggleBtn.disabled = !valid;
  if (!valid) {
    state.loopEnabled = false;
    els.loopToggleBtn.classList.remove('is-active');
    els.loopToggleBtn.setAttribute('aria-pressed', 'false');
  }
  updateLoopInfo();
}

function updateLoopInfo() {
  if (state.loopA == null && state.loopB == null) {
    els.loopInfo.textContent = 'A / B 未設定';
    return;
  }
  const a = state.loopA == null ? '—' : formatClock(state.loopA);
  const b = state.loopB == null ? '—' : formatClock(state.loopB);
  const mode = state.loopEnabled ? 'ループ中' : state.loop ? '待機' : '（B は A より後に）';
  els.loopInfo.textContent = `A ${a} → B ${b} ${mode}`;
}

function setLoopA() {
  if (!currentTrack()) return;
  state.loopA = els.video.currentTime;
  recomputeLoop();
}

function setLoopB() {
  if (!currentTrack()) return;
  state.loopB = els.video.currentTime;
  recomputeLoop();
}

function toggleLoop() {
  if (!state.loop) return;
  state.loopEnabled = !state.loopEnabled;
  els.loopToggleBtn.classList.toggle('is-active', state.loopEnabled);
  els.loopToggleBtn.setAttribute('aria-pressed', String(state.loopEnabled));
  updateLoopInfo();
}

function resetLoop() {
  state.loopA = null;
  state.loopB = null;
  state.loop = null;
  state.loopEnabled = false;
  els.loopToggleBtn.disabled = true;
  els.loopToggleBtn.classList.remove('is-active');
  els.loopToggleBtn.setAttribute('aria-pressed', 'false');
  updateLoopInfo();
}

/* ---------- マーカー ---------- */

function addMarkerAtCurrent() {
  if (!currentTrack()) return;
  const marker = { id: makeId(), time: els.video.currentTime, note: els.markerNote.value };
  setMarkers(addMarker(getMarkers(), marker));
  els.markerNote.value = '';
  renderMarkers();
}

function renderMarkers() {
  const markers = getMarkers();
  els.markerList.innerHTML = '';
  els.markerCount.textContent = `${markers.length} 件`;
  els.markerEmpty.hidden = markers.length > 0;

  for (const marker of markers) {
    const li = document.createElement('li');
    li.className = 'marker-item';

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'marker-jump';
    jump.dataset.id = marker.id;
    jump.dataset.time = String(marker.time);
    jump.title = 'この位置へ移動';
    jump.textContent = formatClock(marker.time);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'marker-note-input';
    input.dataset.id = marker.id;
    input.value = marker.note;
    input.placeholder = 'メモ';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'marker-remove';
    remove.dataset.id = marker.id;
    remove.setAttribute('aria-label', 'この印を削除');
    remove.textContent = '×';

    li.append(jump, input, remove);
    els.markerList.appendChild(li);
  }
}

/* ---------- 書き出し ---------- */

function notesMarkdown() {
  const track = currentTrack();
  return buildNotesMarkdown({
    title: track ? fileBaseName(track.name) : '講義ノート',
    source: track ? track.name : '',
    duration: els.video.duration || 0,
    markers: getMarkers(),
  });
}

function exportNotes() {
  const track = currentTrack();
  const markdown = notesMarkdown();
  download(new Blob([markdown], { type: NOTES_MIME }), buildExportName(track?.name, 'md', 'notes'));
}

function copyNotes() {
  const markdown = notesMarkdown();
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    showError('この環境ではクリップボードへコピーできません。ダウンロードしてください。');
    return;
  }
  navigator.clipboard
    .writeText(markdown)
    .then(() => {
      els.copyNotesBtn.textContent = 'コピーしました';
      setTimeout(() => {
        els.copyNotesBtn.textContent = 'Markdown をコピー';
      }, 1500);
    })
    .catch(() => showError('クリップボードへコピーできませんでした。'));
}

function exportMarkers() {
  const track = currentTrack();
  const json = serializeMarkers(getMarkers());
  download(new Blob([json], { type: MARKERS_MIME }), buildExportName(track?.name, 'json', 'markers'));
}

function captureFrame() {
  if (!currentTrack() || !CAN_CAPTURE_FRAME) return;
  const video = els.video;
  if (video.videoWidth === 0) return;

  const draw = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      download(
        blob,
        buildExportName(currentTrack()?.name, 'png', `t${Math.round(video.currentTime)}`),
      );
    }, 'image/png');
  };

  if (typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback(draw);
  } else {
    requestAnimationFrame(draw);
  }
}

/* ---------- イベント購読 ---------- */

function buildRatePresets() {
  for (const preset of RATE_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rate-preset';
    button.dataset.rate = String(preset);
    button.textContent = formatRate(preset);
    els.ratePresets.appendChild(button);
  }
}

function bindEvents() {
  // ファイル選択 / ドロップ
  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  els.dropZone.addEventListener('click', (event) => {
    if (event.target.closest('label')) return;
    els.fileInput.click();
  });
  els.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.dropZone.classList.add('is-dragover');
  });
  els.dropZone.addEventListener('dragleave', () => {
    els.dropZone.classList.remove('is-dragover');
  });
  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('is-dragover');
    if (event.dataTransfer) addFiles(event.dataTransfer.files);
  });

  // プレイヤー
  els.playBtn.addEventListener('click', togglePlay);
  els.backBtn.addEventListener('click', () => nudge(-SEEK_STEP));
  els.fwdBtn.addEventListener('click', () => nudge(SEEK_STEP));
  els.prevBtn.addEventListener('click', () => selectTrack(state.current - 1));
  els.nextBtn.addEventListener('click', () => selectTrack(state.current + 1));

  els.seekRange.addEventListener('input', () => {
    state.scrubbing = true;
    els.video.currentTime = Number(els.seekRange.value);
    els.timeLabel.textContent = formatClock(els.video.currentTime);
    updateOverlay();
  });
  els.seekRange.addEventListener('change', () => {
    state.scrubbing = false;
  });

  els.rateRange.addEventListener('input', () => applyRate(Number(els.rateRange.value)));
  els.rateResetBtn.addEventListener('click', () => applyRate(1));
  els.ratePresets.addEventListener('click', (event) => {
    const button = event.target.closest('.rate-preset');
    if (button) applyRate(Number(button.dataset.rate));
  });

  // ループ
  els.setABtn.addEventListener('click', setLoopA);
  els.setBBtn.addEventListener('click', setLoopB);
  els.loopToggleBtn.addEventListener('click', toggleLoop);
  els.clearLoopBtn.addEventListener('click', resetLoop);

  // プレイリスト
  els.playlist.addEventListener('click', (event) => {
    const remove = event.target.closest('.playlist-remove');
    if (remove) {
      removeTrack(Number(remove.dataset.index));
      return;
    }
    const item = event.target.closest('.playlist-item');
    if (item) selectTrack(Number(item.dataset.index));
  });
  els.clearAllBtn.addEventListener('click', clearAll);

  // 字幕
  els.subtitleFileInput.addEventListener('change', () => {
    const file = els.subtitleFileInput.files?.[0];
    els.subtitleFileInput.value = '';
    if (!file) return;
    file
      .text()
      .then((text) => attachSubtitle(file.name, text))
      .catch(() => showError('字幕ファイルを読み込めませんでした。'));
  });
  els.applySubtitleBtn.addEventListener('click', () => {
    if (!els.subtitlePaste.value.trim()) {
      showError('字幕テキストが空です。');
      return;
    }
    attachSubtitle('貼り付けた字幕', els.subtitlePaste.value);
  });
  els.clearSubtitleBtn.addEventListener('click', clearSubtitle);

  // マーカー
  els.addMarkerBtn.addEventListener('click', addMarkerAtCurrent);
  els.markerNote.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addMarkerAtCurrent();
    }
  });
  els.markerList.addEventListener('click', (event) => {
    const jump = event.target.closest('.marker-jump');
    if (jump) {
      els.video.currentTime = Number(jump.dataset.time);
      updateOverlay();
      return;
    }
    const remove = event.target.closest('.marker-remove');
    if (remove) {
      setMarkers(removeMarker(getMarkers(), remove.dataset.id));
      renderMarkers();
    }
  });
  els.markerList.addEventListener('change', (event) => {
    const input = event.target.closest('.marker-note-input');
    if (!input) return;
    setMarkers(updateMarkerNote(getMarkers(), input.dataset.id, input.value));
  });
  els.clearMarkersBtn.addEventListener('click', () => {
    if (getMarkers().length === 0) return;
    setMarkers([]);
    renderMarkers();
  });

  // 書き出し
  els.exportNotesBtn.addEventListener('click', exportNotes);
  els.copyNotesBtn.addEventListener('click', copyNotes);
  els.exportMarkersBtn.addEventListener('click', exportMarkers);
  els.screenshotBtn.addEventListener('click', captureFrame);

  // モーダル
  els.infoBtn.addEventListener('click', () => {
    els.infoModal.style.display = 'flex';
  });
  els.closeInfoBtn.addEventListener('click', () => {
    els.infoModal.style.display = 'none';
  });
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) els.infoModal.style.display = 'none';
  });

  // video イベント
  els.video.addEventListener('loadedmetadata', onLoadedMetadata);
  els.video.addEventListener('timeupdate', onTimeUpdate);
  els.video.addEventListener('play', () => setPlayIcon(true));
  els.video.addEventListener('pause', () => setPlayIcon(false));
  els.video.addEventListener('ended', () => {
    if (state.playlist.length > 1) selectTrack(state.current + 1);
  });

  // キーボードショートカット
  window.addEventListener('keydown', (event) => {
    if (isInteractiveTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        nudge(-SEEK_STEP);
        break;
      case 'ArrowRight':
        event.preventDefault();
        nudge(SEEK_STEP);
        break;
      case 'j':
      case 'J':
        nudge(-SEEK_STEP_LARGE);
        break;
      case 'l':
      case 'L':
        nudge(SEEK_STEP_LARGE);
        break;
      case 'ArrowUp':
        event.preventDefault();
        applyRate(nextRate(state.rate, 1));
        break;
      case 'ArrowDown':
        event.preventDefault();
        applyRate(nextRate(state.rate, -1));
        break;
      case 'm':
      case 'M':
        addMarkerAtCurrent();
        break;
      case '[':
        setLoopA();
        break;
      case ']':
        setLoopB();
        break;
      case '\\':
        resetLoop();
        break;
      case 'p':
      case 'P':
        selectTrack(state.current - 1);
        break;
      case 'n':
      case 'N':
        selectTrack(state.current + 1);
        break;
      default:
        break;
    }
  });
}

/* ---------- 初期化 ---------- */

function init() {
  buildRatePresets();
  bindEvents();
  els.screenshotBtn.disabled = !CAN_CAPTURE_FRAME;
  if (!CAN_CAPTURE_FRAME) {
    els.screenshotBtn.title = 'このブラウザは現在フレームの書き出しに対応していません';
  }

  let saved = Number.NaN;
  try {
    saved = Number(localStorage.getItem(RATE_STORAGE_KEY));
  } catch {
    saved = Number.NaN;
  }
  applyRate(Number.isFinite(saved) && saved > 0 ? saved : 1);

  renderPlaylist();
  renderMarkers();
  resetLoop();
}

init();
