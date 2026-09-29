/**
 * MIDI スタジオ — UI / 音声 / 入力
 *
 * すべてブラウザ内で完結する。ファイルはどこにも送信しない。
 * 純ロジック（SMF 入出力・座標・編集）は pipeline.mjs に分離している。
 */

import {
  createProject,
  createTrack,
  createNote,
  parseMidi,
  writeMidi,
  sortNotes,
  removeNoteAt,
  updateNoteAt,
  transposeNotes,
  hitTestNote,
  quantizeTick,
  midiToName,
  isBlackKey,
  midiToFrequency,
  keyToMidi,
  secondsToTicks,
  ticksToSeconds,
  toPlaybackNotes,
  formatTime,
  buildMidiFileName,
  isSupportedMidiFile,
  countNotes,
  projectEndTick,
  clamp,
  clampMidi,
  clampVelocity,
  PIANO_LOW_MIDI,
  PIANO_HIGH_MIDI,
  ROW_HEIGHT,
  KEYBOARD_WIDTH,
  RULER_HEIGHT,
  DEFAULT_PX_PER_QUARTER,
  MIN_PX_PER_QUARTER,
  MAX_PX_PER_QUARTER,
  SNAP_OPTIONS,
  DEFAULT_SNAP,
  MAX_NOTES,
} from './pipeline.mjs';

/* ==========================================================
   定数 / DOM
   ========================================================== */

const $ = (id) => document.getElementById(id);

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const PITCH_ROWS = PIANO_HIGH_MIDI - PIANO_LOW_MIDI + 1;
const CONTENT_HEIGHT = RULER_HEIGHT + PITCH_ROWS * ROW_HEIGHT;
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const canvas = $('roll-canvas');
const container = $('roll-container');
const ctx = canvas.getContext('2d');

/* ==========================================================
   状態
   ========================================================== */

const state = {
  project: createProject(),
  trackIndex: 0,
  selectedNote: -1,
  snap: DEFAULT_SNAP,
  waveform: 'triangle',
  baseOctave: 4,
  pxPerQuarter: DEFAULT_PX_PER_QUARTER,
  drag: null,
  inputTick: 0,
  pointerAudition: null,
  qwertyHeld: new Set(),
  playing: false,
  playToken: 0,
  playStartedAt: 0,
  playDuration: 0,
  playheadSeconds: -1,
  scheduledVoices: [],
  master: null,
};

let audioCtx = null;
const liveVoices = new Map();

/* ==========================================================
   ユーティリティ
   ========================================================== */

function currentTrack() {
  return state.project.tracks[state.trackIndex] || state.project.tracks[0];
}

function pxPerTick() {
  return state.pxPerQuarter / state.project.ppq;
}

function snapTicks() {
  const option = SNAP_OPTIONS.find((o) => o.id === state.snap) || SNAP_OPTIONS[3];
  return Math.max(1, Math.round(state.project.ppq * 4 * option.ratio));
}

function defaultDuration() {
  return snapTicks();
}

function totalTicks() {
  return Math.max(projectEndTick(state.project) + state.project.ppq, state.project.ppq * 8);
}

function tickToX(tick) {
  return KEYBOARD_WIDTH + tick * pxPerTick();
}

function xToTick(x) {
  return (x - KEYBOARD_WIDTH) / pxPerTick();
}

function midiToY(midi) {
  return RULER_HEIGHT + (PIANO_HIGH_MIDI - midi) * ROW_HEIGHT;
}

function yToMidi(y) {
  return clamp(PIANO_HIGH_MIDI - Math.floor((y - RULER_HEIGHT) / ROW_HEIGHT), PIANO_LOW_MIDI, PIANO_HIGH_MIDI);
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function setStatus(message) {
  $('status').textContent = message;
}

function setMidiStatus(message) {
  $('midi-status').textContent = message;
}

function updateFooter() {
  $('note-count').textContent = `${countNotes(state.project)} 音符`;
  $('time-info').textContent = formatTime(ticksToSeconds(projectEndTick(state.project), state.project.ppq, state.project.bpm));
}

function setCursorInfo(tick, midi) {
  const seconds = ticksToSeconds(tick, state.project.ppq, state.project.bpm);
  $('cursor-info').textContent = `${midiToName(midi)} (${midi}) · ${Math.round(tick)} ticks · ${formatTime(seconds)}`;
}

/* ==========================================================
   音声 (Web Audio の簡易シンセ)
   ========================================================== */

function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function auditionOn(midi, velocity) {
  const audio = ensureAudio();
  if (liveVoices.has(midi)) return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = state.waveform;
  osc.frequency.setValueAtTime(midiToFrequency(midi), now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(Math.max(0.02, 0.25 * (velocity / 127)), now + 0.012);
  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  liveVoices.set(midi, { osc, gain });
}

function auditionOff(midi) {
  const voice = liveVoices.get(midi);
  if (!voice || !audioCtx) return;
  liveVoices.delete(midi);
  const now = audioCtx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.linearRampToValueAtTime(0, now + 0.08);
  try {
    voice.osc.stop(now + 0.1);
  } catch {
    /* already stopped */
  }
}

function stopPlayback() {
  state.playing = false;
  state.playToken += 1;
  state.playheadSeconds = -1;
  for (const osc of state.scheduledVoices) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      /* ignore */
    }
  }
  state.scheduledVoices = [];
  if (state.master) {
    try {
      state.master.disconnect();
    } catch {
      /* ignore */
    }
    state.master = null;
  }
  for (const voice of liveVoices.values()) {
    try {
      voice.osc.stop();
    } catch {
      /* ignore */
    }
  }
  liveVoices.clear();
  updatePlayButton();
  draw();
}

function play() {
  if (state.playing) {
    stopPlayback();
    return;
  }
  const audio = ensureAudio();
  const notes = toPlaybackNotes(currentTrack().notes, state.project.ppq, state.project.bpm);
  if (!notes.length) {
    setStatus('このトラックに音符がありません');
    return;
  }
  stopPlayback();
  const master = audio.createGain();
  master.gain.value = 0.6;
  master.connect(audio.destination);
  state.master = master;

  const startAt = audio.currentTime + 0.06;
  const voices = [];
  for (const note of notes.slice(0, MAX_NOTES)) {
    const t0 = startAt + note.start;
    const t1 = t0 + note.duration;
    const peak = Math.max(0.02, 0.22 * (note.velocity / 127));
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = state.waveform;
    osc.frequency.setValueAtTime(midiToFrequency(note.midi), t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, Math.min(t0 + 0.015, t1));
    gain.gain.setValueAtTime(peak, Math.max(t0 + 0.015, t1 - 0.06));
    gain.gain.linearRampToValueAtTime(0, t1);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t1 + 0.03);
    voices.push(osc);
  }
  state.scheduledVoices = voices;
  state.playing = true;
  state.playStartedAt = startAt;
  state.playDuration = Math.max(...notes.map((n) => n.start + n.duration));
  state.playToken += 1;
  const token = state.playToken;
  updatePlayButton();

  const loop = () => {
    if (!state.playing || token !== state.playToken) return;
    state.playheadSeconds = Math.max(0, audio.currentTime - startAt);
    draw();
    if (state.playheadSeconds > state.playDuration + 0.1) {
      stopPlayback();
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function updatePlayButton() {
  $('btn-play').textContent = state.playing ? '❚❚ 一時停止' : '▶ 再生';
}

/* ==========================================================
   描画
   ========================================================== */

function roundRect(context, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** テーマが変わったときだけ computed style を読み直す */
const themeCache = { key: null, colors: null };
function themeColors() {
  const attr = document.documentElement.getAttribute('data-theme') || 'system';
  const dark = attr === 'dark' || (attr === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const key = `${attr}:${dark}`;
  if (themeCache.key !== key) {
    themeCache.key = key;
    themeCache.colors = {
      grid: cssVar('--roll-grid', 'rgba(148,163,184,0.22)'),
      beat: cssVar('--roll-beat', 'rgba(148,163,184,0.42)'),
      bar: cssVar('--roll-bar', 'rgba(148,163,184,0.7)'),
      blackRow: cssVar('--roll-black-row', 'rgba(15,23,42,0.05)'),
      surface: cssVar('--c-surface-solid', '#ffffff'),
      noteFill: cssVar('--note-fill', 'rgba(225,29,72,0.85)'),
      noteSelected: cssVar('--note-selected', '#f59e0b'),
    };
  }
  return themeCache.colors;
}

function resizeCanvas() {
  const width = Math.max(KEYBOARD_WIDTH + totalTicks() * pxPerTick() + 24, container.clientWidth);
  canvas.width = Math.round(width * DPR);
  canvas.height = Math.round(CONTENT_HEIGHT * DPR);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${CONTENT_HEIGHT}px`;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function draw() {
  const width = canvas.width / DPR;
  const height = canvas.height / DPR;
  ctx.clearRect(0, 0, width, height);

  const {
    grid,
    beat,
    bar,
    blackRow,
    surface,
    noteFill,
    noteSelected,
  } = themeColors();
  const barTicks = state.project.ppq * 4;
  const step = snapTicks() * pxPerTick() >= 7 ? snapTicks() : state.project.ppq;
  const total = totalTicks();

  // 行の背景
  for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi += 1) {
    const y = midiToY(midi);
    if (isBlackKey(midi)) {
      ctx.fillStyle = blackRow;
      ctx.fillRect(KEYBOARD_WIDTH, y, width - KEYBOARD_WIDTH, ROW_HEIGHT);
    }
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(KEYBOARD_WIDTH, y + ROW_HEIGHT + 0.5);
    ctx.lineTo(width, y + ROW_HEIGHT + 0.5);
    ctx.stroke();
  }

  // 縦グリッド
  for (let tick = 0; tick <= total; tick += step) {
    const x = tickToX(tick);
    ctx.strokeStyle = tick % barTicks === 0 ? bar : tick % state.project.ppq === 0 ? beat : grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }

  // 音符
  for (let ti = 0; ti < state.project.tracks.length; ti += 1) {
    const selectedTrack = ti === state.trackIndex;
    const notes = state.project.tracks[ti].notes;
    for (let i = 0; i < notes.length; i += 1) {
      const note = notes[i];
      const x = tickToX(note.ticks);
      const y = midiToY(note.midi) + 1;
      const w = Math.max(3, note.duration * pxPerTick() - 1);
      const h = ROW_HEIGHT - 2;
      ctx.globalAlpha = selectedTrack ? 1 : 0.25;
      ctx.fillStyle = noteFill;
      roundRect(ctx, x, y, w, h, 2);
      ctx.fill();
      if (selectedTrack && i === state.selectedNote) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = noteSelected;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, w, h, 2);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  // 鍵盤
  for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi += 1) {
    const y = midiToY(midi);
    ctx.fillStyle = isBlackKey(midi) ? '#1f2937' : '#f8fafc';
    ctx.fillRect(0, y, KEYBOARD_WIDTH, ROW_HEIGHT);
    ctx.strokeStyle = grid;
    ctx.strokeRect(0.5, y + 0.5, KEYBOARD_WIDTH - 1, ROW_HEIGHT - 1);
    if (midi % 12 === 0) {
      ctx.fillStyle = '#334155';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(midiToName(midi), 5, y + ROW_HEIGHT / 2);
    }
  }
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, KEYBOARD_WIDTH, RULER_HEIGHT);

  // ルーラー
  for (let tick = 0; tick <= total; tick += state.project.ppq) {
    const x = tickToX(tick);
    const isBar = tick % barTicks === 0;
    ctx.strokeStyle = isBar ? bar : grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, isBar ? 4 : RULER_HEIGHT * 0.45);
    ctx.lineTo(x + 0.5, RULER_HEIGHT);
    ctx.stroke();
    if (isBar) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(tick / barTicks + 1), x + 3, 4);
    }
  }

  // 再生ヘッド
  if (state.playheadSeconds >= 0) {
    const x = tickToX(secondsToTicks(state.playheadSeconds, state.project.ppq, state.project.bpm));
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, RULER_HEIGHT);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function resizeAndDraw() {
  resizeCanvas();
  draw();
}

/* ==========================================================
   トラック UI
   ========================================================== */

function updateTrackList() {
  const list = $('track-list');
  list.innerHTML = '';
  state.project.tracks.forEach((track, index) => {
    const li = document.createElement('li');
    li.className = `track-item${index === state.trackIndex ? ' active' : ''}`;
    const name = document.createElement('span');
    name.textContent = track.name || `Track ${index + 1}`;
    const count = document.createElement('span');
    count.className = 'track-count';
    count.textContent = `${track.notes.length}`;
    li.append(name, count);
    li.addEventListener('click', () => selectTrack(index));
    list.append(li);
  });
}

function selectTrack(index) {
  if (index < 0 || index >= state.project.tracks.length) return;
  state.trackIndex = index;
  state.selectedNote = -1;
  updateTrackList();
  syncTrackInputs();
  draw();
}

function syncTrackInputs() {
  const track = currentTrack();
  $('track-name').value = track.name || '';
  $('track-channel').value = String((track.channel ?? 0) + 1);
  $('track-program').value = String((track.program ?? 0) + 1);
}

function addTrack() {
  state.project.tracks.push(createTrack({ name: `Track ${state.project.tracks.length + 1}` }));
  selectTrack(state.project.tracks.length - 1);
  resizeAndDraw();
  setStatus(`トラックを追加 (${state.project.tracks.length} トラック)`);
}

/* ==========================================================
   編集操作
   ========================================================== */

function patchNoteInPlace(track, index, patch) {
  const note = track.notes[index];
  if (!note) return;
  track.notes[index] = createNote(
    patch.midi !== undefined ? patch.midi : note.midi,
    patch.ticks !== undefined ? patch.ticks : note.ticks,
    patch.duration !== undefined ? patch.duration : note.duration,
    patch.velocity !== undefined ? patch.velocity : note.velocity,
  );
}

function recordIncoming(midi, velocity) {
  const track = currentTrack();
  let tick;
  if (state.playing && audioCtx) {
    tick = quantizeTick(
      secondsToTicks(Math.max(0, audioCtx.currentTime - state.playStartedAt), state.project.ppq, state.project.bpm),
      snapTicks(),
    );
  } else {
    tick = state.inputTick;
  }
  track.notes = sortNotes([...track.notes, createNote(midi, tick, defaultDuration(), clampVelocity(velocity))]);
  if (!state.playing) state.inputTick = tick + snapTicks();
  updateTrackList();
  resizeAndDraw();
  updateFooter();
  setCursorInfo(tick, midi);
}

function finalizeDrag() {
  if (!state.drag) return;
  const track = currentTrack();
  const note = track.notes[state.drag.index];
  track.notes = sortNotes(track.notes);
  state.selectedNote = note ? track.notes.indexOf(note) : -1;
  state.drag = null;
  updateTrackList();
  resizeAndDraw();
  updateFooter();
}

/* ==========================================================
   ポインタ操作
   ========================================================== */

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  const track = currentTrack();

  // 鍵盤クリック
  if (point.x < KEYBOARD_WIDTH) {
    if (point.y >= RULER_HEIGHT) {
      const midi = yToMidi(point.y);
      state.pointerAudition = midi;
      auditionOn(midi, 100);
      recordIncoming(midi, 100);
    }
    return;
  }

  const tick = xToTick(point.x);
  const midi = yToMidi(point.y);

  // ルーラークリック → ステップ入力位置を移動
  if (point.y < RULER_HEIGHT) {
    state.inputTick = quantizeTick(tick, snapTicks());
    setStatus(`入力位置: ${formatTime(ticksToSeconds(state.inputTick, state.project.ppq, state.project.bpm))}`);
    return;
  }

  const index = hitTestNote(track.notes, midi, tick);
  if (index >= 0) {
    const note = track.notes[index];
    const rightX = tickToX(note.ticks + note.duration);
    state.selectedNote = index;
    if (point.x >= rightX - 6) {
      state.drag = { type: 'resize', index, startTick: tick, origDuration: note.duration };
    } else {
      state.drag = { type: 'move', index, startTick: tick, startMidi: midi, origTicks: note.ticks, origMidi: note.midi };
    }
  } else {
    const start = quantizeTick(tick, snapTicks());
    const note = createNote(midi, start, defaultDuration(), 96);
    track.notes = sortNotes([...track.notes, note]);
    state.selectedNote = track.notes.indexOf(note);
    state.drag = { type: 'move', index: state.selectedNote, startTick: tick, startMidi: midi, origTicks: start, origMidi: midi };
    updateTrackList();
  }
  resizeAndDraw();
});

canvas.addEventListener('pointermove', (event) => {
  const point = canvasPoint(event);
  const tick = Math.max(0, xToTick(point.x));
  const midi = yToMidi(point.y);
  if (point.x >= KEYBOARD_WIDTH) setCursorInfo(tick, midi);

  if (!state.drag) return;
  const track = currentTrack();
  if (state.drag.type === 'move') {
    const dTicks = quantizeTick(tick - state.drag.startTick, snapTicks());
    const dMidi = midi - state.drag.startMidi;
    patchNoteInPlace(track, state.drag.index, {
      ticks: Math.max(0, quantizeTick(state.drag.origTicks + dTicks, snapTicks())),
      midi: clampMidi(state.drag.origMidi + dMidi),
    });
  } else {
    const delta = tick - state.drag.startTick;
    patchNoteInPlace(track, state.drag.index, {
      duration: quantizeTick(state.drag.origDuration + delta, snapTicks()),
    });
  }
  draw();
});

function endPointer(event) {
  if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (state.pointerAudition !== null) {
    auditionOff(state.pointerAudition);
    state.pointerAudition = null;
  }
  finalizeDrag();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

container.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const next = clamp(
      state.pxPerQuarter * (event.deltaY < 0 ? 1.12 : 0.89),
      MIN_PX_PER_QUARTER,
      MAX_PX_PER_QUARTER,
    );
    state.pxPerQuarter = Math.round(next);
    $('zoom-range').value = String(state.pxPerQuarter);
    resizeAndDraw();
  },
  { passive: false },
);

/* ==========================================================
   Web MIDI 入力
   ========================================================== */

function handleMidiMessage(data) {
  const status = data[0] & 0xf0;
  const midi = data[1];
  const velocity = data[2];
  if (status === 0x90 && velocity > 0) {
    auditionOn(midi, velocity);
    recordIncoming(midi, velocity);
  } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
    auditionOff(midi);
  }
}

function bindMidiInput(input) {
  if (input.__midiStudioBound) return;
  input.__midiStudioBound = true;
  input.onmidimessage = (event) => handleMidiMessage(event.data);
}

function refreshMidiStatus(access) {
  const names = [...access.inputs.values()].map((input) => input.name);
  if (!names.length) {
    setMidiStatus('Web MIDI: デバイス未接続');
  } else {
    setMidiStatus(`Web MIDI: ${names.join(', ')}`);
  }
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('Web MIDI: 非対応 (QWERTY を使用)');
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    access.inputs.forEach(bindMidiInput);
    access.onstatechange = () => {
      access.inputs.forEach(bindMidiInput);
      refreshMidiStatus(access);
    };
    refreshMidiStatus(access);
  } catch {
    setMidiStatus('Web MIDI: 許可されませんでした');
  }
}

/* ==========================================================
   QWERTY 入力
   ========================================================== */

function isTypingTarget(target) {
  return !!target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable);
}

window.addEventListener('keydown', (event) => {
  if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Space') {
    event.preventDefault();
    play();
    return;
  }
  const midi = keyToMidi(event.key, state.baseOctave);
  if (midi === null) return;
  event.preventDefault();
  if (event.repeat || state.qwertyHeld.has(midi)) return;
  state.qwertyHeld.add(midi);
  auditionOn(midi, 100);
  recordIncoming(midi, 100);
});

window.addEventListener('keyup', (event) => {
  const midi = keyToMidi(event.key, state.baseOctave);
  if (midi === null) return;
  state.qwertyHeld.delete(midi);
  auditionOff(midi);
});

/* ==========================================================
   ファイル入出力
   ========================================================== */

function setProject(project) {
  state.project = project;
  state.trackIndex = 0;
  state.selectedNote = -1;
  state.inputTick = 0;
  state.playheadSeconds = -1;
  updateTrackList();
  syncTrackInputs();
  resizeAndDraw();
  updateFooter();
}

function loadBytes(bytes, fileName) {
  const project = parseMidi(bytes);
  setProject(project);
  setStatus(`読み込み完了: ${fileName || 'MIDI'} (${countNotes(project)} 音符 / ${project.tracks.length} トラック)`);
}

async function openFile(file) {
  if (!isSupportedMidiFile(file)) {
    setStatus(`未対応のファイル形式: ${file.name}`);
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    loadBytes(new Uint8Array(buffer), file.name);
  } catch (error) {
    setStatus(`読み込みに失敗: ${error.message}`);
  }
}

function saveFile() {
  const bytes = writeMidi(state.project);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildMidiFileName(state.project.name || currentTrack().name || 'midi');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`書き出し: ${anchor.download} (${bytes.length} バイト)`);
}

$('btn-open').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) openFile(file);
  event.target.value = '';
});
$('btn-save').addEventListener('click', saveFile);

container.addEventListener('dragover', (event) => {
  event.preventDefault();
  container.classList.add('dragover');
});
container.addEventListener('dragleave', () => container.classList.remove('dragover'));
container.addEventListener('drop', (event) => {
  event.preventDefault();
  container.classList.remove('dragover');
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) openFile(file);
});

/* ==========================================================
   ツールバー
   ========================================================== */

$('btn-new').addEventListener('click', () => {
  if (!window.confirm('現在の内容を破棄して新規プロジェクトを作成しますか？')) return;
  stopPlayback();
  setProject(createProject());
  setStatus('新規プロジェクトを作成しました');
});

$('btn-play').addEventListener('click', play);
$('btn-stop').addEventListener('click', stopPlayback);

$('btn-quantize').addEventListener('click', () => {
  const track = currentTrack();
  const grid = snapTicks();
  track.notes = track.notes.map((note) =>
    createNote(note.midi, quantizeTick(note.ticks, grid), quantizeTick(note.duration, grid) || grid, note.velocity),
  );
  updateTrackList();
  resizeAndDraw();
  setStatus(`クオンタイズ: ${state.snap}`);
});

$('btn-transpose-down').addEventListener('click', () => transposeSelection(-1));
$('btn-transpose-up').addEventListener('click', () => transposeSelection(1));

function transposeSelection(semitones) {
  const track = currentTrack();
  if (state.selectedNote >= 0) {
    const note = track.notes[state.selectedNote];
    track.notes = updateNoteAt(track.notes, state.selectedNote, { midi: clampMidi(note.midi + semitones) });
  } else {
    track.notes = transposeNotes(track.notes, semitones);
  }
  resizeAndDraw();
  setStatus(`移調: ${semitones > 0 ? '+' : ''}${semitones} 半音`);
}

$('btn-delete-note').addEventListener('click', () => {
  const track = currentTrack();
  if (state.selectedNote < 0) {
    setStatus('削除する音符を選択してください');
    return;
  }
  track.notes = removeNoteAt(track.notes, state.selectedNote);
  state.selectedNote = -1;
  updateTrackList();
  resizeAndDraw();
  updateFooter();
  setStatus('音符を削除しました');
});

$('btn-clear-track').addEventListener('click', () => {
  if (!window.confirm('このトラックの音符をすべて削除しますか？')) return;
  currentTrack().notes = [];
  state.selectedNote = -1;
  updateTrackList();
  resizeAndDraw();
  updateFooter();
  setStatus('トラックを空にしました');
});

$('btn-add-track').addEventListener('click', addTrack);

/* ==========================================================
   設定 UI
   ========================================================== */

for (const option of SNAP_OPTIONS) {
  const el = document.createElement('option');
  el.value = option.id;
  el.textContent = option.label;
  if (option.id === DEFAULT_SNAP) el.selected = true;
  $('snap-select').append(el);
}
$('snap-select').addEventListener('change', (event) => {
  state.snap = event.target.value;
  setStatus(`スナップ: ${state.snap}`);
});
$('waveform-select').addEventListener('change', (event) => {
  state.waveform = event.target.value;
});
$('octave-select').addEventListener('change', (event) => {
  state.baseOctave = Number(event.target.value);
  setStatus(`QWERTY 基準: C${state.baseOctave}`);
});
$('zoom-range').addEventListener('input', (event) => {
  state.pxPerQuarter = Number(event.target.value);
  resizeAndDraw();
});

/* ==========================================================
   トラック設定
   ========================================================== */

$('track-name').addEventListener('input', (event) => {
  currentTrack().name = event.target.value;
  updateTrackList();
});
$('track-channel').addEventListener('change', (event) => {
  currentTrack().channel = clamp(Number(event.target.value) - 1, 0, 15);
});
$('track-program').addEventListener('change', (event) => {
  currentTrack().program = clamp(Number(event.target.value) - 1, 0, 127);
});

/* ==========================================================
   初期化
   ========================================================== */

$('zoom-range').value = String(state.pxPerQuarter);
updateTrackList();
syncTrackInputs();
updateFooter();
resizeAndDraw();

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resizeAndDraw()).observe(container);
}
window.addEventListener('resize', resizeAndDraw);

initMidi();
setStatus('準備完了 — 空のプロジェクトから始められます (Web MIDI / QWERTY で入力できます)');
