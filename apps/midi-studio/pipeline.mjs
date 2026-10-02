/**
 * MIDI Studio — 純ロジック
 *
 * ブラウザでも Node でも動く依存ゼロのモジュール。
 * ここには DOM や Web API を一切書かない（`node --test` で検証する）。
 *
 *  - SMF (Standard MIDI File) の読み書き
 *  - 音符データモデルと編集操作
 *  - 再生スケジューリング / ピアノロール座標の計算
 *
 * 参考: MIDI 1.0 Specification (SMF), @tonejs/midi (MIT)
 */

/* ==========================================================
   定数
   ========================================================== */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const DEFAULT_PPQ = 480;
export const DEFAULT_BPM = 120;
export const DEFAULT_VELOCITY = 96;
export const MIN_NOTE_TICKS = 1;
export const MIN_MIDI = 0;
export const MAX_MIDI = 127;
export const MIDI_FILE_EXTENSIONS = ['.mid', '.midi'];
export const MAX_NOTES = 20000;

/** 88 鍵の範囲（A0〜C8 = MIDI 21〜108） */
export const PIANO_LOW_MIDI = 21;
export const PIANO_HIGH_MIDI = 108;
export const PIANO_KEY_COUNT = PIANO_HIGH_MIDI - PIANO_LOW_MIDI + 1;

/** ピアノロールの表示既定値 */
export const ROW_HEIGHT = 14;
export const KEYBOARD_WIDTH = 56;
export const RULER_HEIGHT = 24;
export const DEFAULT_PX_PER_QUARTER = 72;
export const MIN_PX_PER_QUARTER = 12;
export const MAX_PX_PER_QUARTER = 480;
/** スナップ候補（全音符に対する比率） */
export const SNAP_OPTIONS = [
  { id: '1/1', label: '1/1 (全)', ratio: 1 },
  { id: '1/2', label: '1/2 (2分)', ratio: 1 / 2 },
  { id: '1/4', label: '1/4 (4分)', ratio: 1 / 4 },
  { id: '1/8', label: '1/8 (8分)', ratio: 1 / 8 },
  { id: '1/16', label: '1/16 (16分)', ratio: 1 / 16 },
  { id: '1/4T', label: '1/4T (3連)', ratio: 1 / 6 },
];
export const DEFAULT_SNAP = '1/16';

/** QWERTY フォールバック: ピアノ配列（基準オクターブからの半音数） */
export const KEYBOARD_MAP = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
};

const TEMPO_US_PER_QUARTER = 60000000;

/* ==========================================================
   数値ユーティリティ
   ========================================================== */

export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampMidi(midi) {
  return clamp(Math.round(midi), MIN_MIDI, MAX_MIDI);
}

export function clampVelocity(velocity) {
  return clamp(Math.round(Number.isFinite(velocity) ? velocity : DEFAULT_VELOCITY), 1, 127);
}

export function clampChannel(channel) {
  return clamp(Math.round(channel), 0, 15);
}

export function clampProgram(program) {
  return clamp(Math.round(program), 0, 127);
}

/* ==========================================================
   音名 / 周波数
   ========================================================== */

/** MIDI ノート番号 → 音名（60 = C4） */
export function midiToName(midi) {
  const n = clampMidi(midi);
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

/** 音名（C4 / C#4 / Db4） → MIDI ノート番号。不正なら null */
export function nameToMidi(name) {
  if (typeof name !== 'string') return null;
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const letterIndex = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const base = letterIndex[m[1].toUpperCase()];
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  const midi = (octave + 1) * 12 + base + accidental;
  if (midi < MIN_MIDI || midi > MAX_MIDI) return null;
  return midi;
}

/** 黒鍵かどうか */
export function isBlackKey(midi) {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/** MIDI ノート番号 → 周波数 (Hz, A4 = 440Hz = 69) */
export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/* ==========================================================
   QWERTY キーボード
   ========================================================== */

/** `event.key` と基準オクターブから MIDI 番号を返す。未割り当てなら null */
export function keyToMidi(key, baseOctave = 4) {
  if (typeof key !== 'string') return null;
  const offset = KEYBOARD_MAP[key.toLowerCase()];
  if (offset === undefined) return null;
  const midi = (baseOctave + 1) * 12 + offset;
  if (midi < MIN_MIDI || midi > MAX_MIDI) return null;
  return midi;
}

/* ==========================================================
   データモデル
   ========================================================== */

export function createNote(midi, ticks, duration, velocity = DEFAULT_VELOCITY) {
  return {
    midi: clampMidi(midi),
    ticks: Math.max(0, Math.round(ticks)),
    duration: Math.max(MIN_NOTE_TICKS, Math.round(duration)),
    velocity: clampVelocity(velocity),
  };
}

export function createTrack(overrides = {}) {
  return {
    name: 'Track 1',
    channel: 0,
    program: 0,
    notes: [],
    ...overrides,
  };
}

export function createProject(overrides = {}) {
  return {
    format: 1,
    ppq: DEFAULT_PPQ,
    bpm: DEFAULT_BPM,
    name: 'Untitled',
    tracks: [createTrack({ name: 'Piano' })],
    ...overrides,
  };
}

export function cloneProject(project) {
  return {
    format: project.format,
    ppq: project.ppq,
    bpm: project.bpm,
    name: project.name,
    tracks: project.tracks.map((t) => ({
      name: t.name,
      channel: t.channel,
      program: t.program,
      notes: t.notes.map((n) => ({ ...n })),
    })),
  };
}

export function countNotes(project) {
  return project.tracks.reduce((sum, t) => sum + t.notes.length, 0);
}

/** 全トラック中の最後のノート終端 (ticks) */
export function projectEndTick(project) {
  let end = 0;
  for (const track of project.tracks) {
    for (const n of track.notes) end = Math.max(end, n.ticks + n.duration);
  }
  return end;
}

/* ==========================================================
   音符の並び替え / 編集
   ========================================================== */

export function sortNotes(notes) {
  return [...notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
}

export function addNote(notes, note) {
  return sortNotes([...notes, { ...note }]);
}

export function removeNoteAt(notes, index) {
  if (index < 0 || index >= notes.length) return [...notes];
  return notes.filter((_, i) => i !== index);
}

export function updateNoteAt(notes, index, patch) {
  if (index < 0 || index >= notes.length) return [...notes];
  return sortNotes(
    notes.map((n, i) => {
      if (i !== index) return n;
      return createNote(
        patch.midi !== undefined ? patch.midi : n.midi,
        patch.ticks !== undefined ? patch.ticks : n.ticks,
        patch.duration !== undefined ? patch.duration : n.duration,
        patch.velocity !== undefined ? patch.velocity : n.velocity,
      );
    }),
  );
}

export function moveNoteAt(notes, index, dTicks, dMidi) {
  const note = notes[index];
  if (!note) return [...notes];
  return updateNoteAt(notes, index, {
    ticks: Math.max(0, note.ticks + Math.round(dTicks)),
    midi: clampMidi(note.midi + Math.round(dMidi)),
  });
}

export function resizeNoteAt(notes, index, dDuration) {
  const note = notes[index];
  if (!note) return [...notes];
  return updateNoteAt(notes, index, { duration: note.duration + Math.round(dDuration) });
}

export function transposeNotes(notes, semitones) {
  const shift = Math.round(semitones);
  return notes.map((n) => ({ ...n, midi: clampMidi(n.midi + shift) }));
}

/** 与えられた音高・時刻に重なる音符の index（なければ -1） */
export function hitTestNote(notes, midi, ticks) {
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i];
    if (n.midi !== Math.round(midi)) continue;
    if (ticks >= n.ticks && ticks < n.ticks + n.duration) return i;
  }
  return -1;
}

/** 音符群の範囲。空なら fallback を返す */
export function notesExtent(notes, fallback = { minMidi: 48, maxMidi: 72, maxTick: DEFAULT_PPQ * 4 }) {
  if (!notes.length) return { ...fallback };
  let minMidi = MAX_MIDI;
  let maxMidi = MIN_MIDI;
  let maxTick = 0;
  for (const n of notes) {
    minMidi = Math.min(minMidi, n.midi);
    maxMidi = Math.max(maxMidi, n.midi);
    maxTick = Math.max(maxTick, n.ticks + n.duration);
  }
  return { minMidi, maxMidi, maxTick };
}

export function quantizeTick(ticks, gridTicks) {
  const grid = Math.max(1, Math.round(gridTicks));
  return Math.max(0, Math.round(ticks / grid) * grid);
}

/* ==========================================================
   時間 / 再生
   ========================================================== */

export function ticksToSeconds(ticks, ppq, bpm) {
  const safePpq = ppq > 0 ? ppq : DEFAULT_PPQ;
  const safeBpm = bpm > 0 ? bpm : DEFAULT_BPM;
  return (ticks / safePpq) * (60 / safeBpm);
}

export function secondsToTicks(seconds, ppq, bpm) {
  const safePpq = ppq > 0 ? ppq : DEFAULT_PPQ;
  const safeBpm = bpm > 0 ? bpm : DEFAULT_BPM;
  return Math.round((seconds / (60 / safeBpm)) * safePpq);
}

/** ノートオン/オフを時刻順に並べる（同 tick では note off が先） */
export function buildMidiEvents(notes) {
  const events = [];
  for (const n of notes) {
    events.push({ tick: n.ticks, type: 'on', midi: n.midi, velocity: n.velocity });
    events.push({ tick: n.ticks + n.duration, type: 'off', midi: n.midi, velocity: 0 });
  }
  events.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type !== b.type) return a.type === 'off' ? -1 : 1;
    return a.midi - b.midi;
  });
  return events;
}

/** 再生用に秒単位へ変換したノート一覧 */
export function toPlaybackNotes(notes, ppq, bpm) {
  return sortNotes(notes).map((n) => ({
    midi: n.midi,
    velocity: n.velocity,
    start: ticksToSeconds(n.ticks, ppq, bpm),
    duration: Math.max(0.01, ticksToSeconds(n.duration, ppq, bpm)),
  }));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const total = Math.floor(seconds * 10);
  const tenths = total % 10;
  const secs = Math.floor(seconds) % 60;
  const mins = Math.floor(seconds / 60);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/* ==========================================================
   ピアノロール座標（純関数）
   ========================================================== */

export function rowYForMidi(midi, { topMidi, rowHeight = ROW_HEIGHT, offsetY = 0 }) {
  return offsetY + (topMidi - midi) * rowHeight;
}

export function midiRowAt(y, { topMidi, rowHeight = ROW_HEIGHT, offsetY = 0 }) {
  return topMidi - Math.floor((y - offsetY) / rowHeight);
}

export function tickX(tick, { pxPerTick, offsetX = 0 }) {
  return offsetX + tick * pxPerTick;
}

export function tickAtX(x, { pxPerTick, offsetX = 0 }) {
  return (x - offsetX) / pxPerTick;
}

/* ==========================================================
   MIDI ファイル入出力
   ========================================================== */

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Uint8Array / ArrayBuffer を渡してください');
}

function readAscii(bytes, start, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[start + i]);
  return out;
}

function writeAscii(target, start, text) {
  for (let i = 0; i < text.length; i += 1) target[start + i] = text.charCodeAt(i) & 0xff;
}

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function writeU16(target, offset, value) {
  target[offset] = (value >> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeU32(target, offset, value) {
  target[offset] = (value >> 24) & 0xff;
  target[offset + 1] = (value >> 16) & 0xff;
  target[offset + 2] = (value >> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function decodeText(bytes) {
  try {
    return textDecoder.decode(bytes);
  } catch {
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
}

/** 可変長数値 (VLQ) をエンコード */
export function encodeVlq(value) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('VLQ は 0 以上の整数です');
  if (value > 0x0fffffff) throw new RangeError('VLQ が大きすぎます');
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/** 可変長数値 (VLQ) をデコード */
export function decodeVlq(bytes, offset = 0) {
  let value = 0;
  let i = offset;
  let count = 0;
  while (true) {
    if (i >= bytes.length) throw new Error('VLQ が途中で終了しました');
    const b = bytes[i];
    i += 1;
    value = (value << 7) | (b & 0x7f);
    count += 1;
    if ((b & 0x80) === 0) break;
    if (count > 4) throw new Error('VLQ が長すぎます');
  }
  return { value, offset: i };
}

function parseTrack(bytes, start, end) {
  const track = createTrack({ name: '' });
  let offset = start;
  let absTick = 0;
  let runningStatus = 0;
  let sawChannel = false;
  const pending = new Map();
  const closeNote = (channel, midi, velocity, ticks) => {
    const key = `${channel}:${midi}`;
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    track.notes.push(
      createNote(p.midi, p.ticks, Math.max(MIN_NOTE_TICKS, ticks - p.ticks), p.velocity),
    );
  };

  while (offset < end) {
    const delta = decodeVlq(bytes, offset);
    offset = delta.offset;
    absTick += delta.value;
    if (offset >= end) break;

    let status = bytes[offset];
    if (status < 0x80) {
      if (!runningStatus) throw new Error('ランニングステータスが不正です');
      status = runningStatus;
    } else {
      offset += 1;
      if (status < 0xf0) runningStatus = status;
    }

    // メタイベント
    if (status === 0xff) {
      const metaType = bytes[offset];
      offset += 1;
      const len = decodeVlq(bytes, offset);
      offset = len.offset;
      const dataStart = offset;
      offset += len.value;
      if (metaType === 0x03) {
        track.name = decodeText(bytes.subarray(dataStart, dataStart + len.value));
      } else if (metaType === 0x51 && len.value >= 3) {
        track.tempo = (bytes[dataStart] << 16) | (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
      } else if (metaType === 0x2f) {
        break;
      }
      continue;
    }

    // SysEx
    if (status === 0xf0 || status === 0xf7) {
      const len = decodeVlq(bytes, offset);
      offset = len.offset + len.value;
      continue;
    }

    const type = status & 0xf0;
    const channel = status & 0x0f;
    if (!sawChannel) {
      track.channel = channel;
      sawChannel = true;
    }
    switch (type) {
      case 0x80:
      case 0x90: {
        const midi = bytes[offset];
        const velocity = bytes[offset + 1];
        offset += 2;
        if (type === 0x90 && velocity > 0) {
          const key = `${channel}:${midi}`;
          if (!pending.has(key)) pending.set(key, { midi, ticks: absTick, velocity });
        } else {
          closeNote(channel, midi, velocity, absTick);
        }
        break;
      }
      case 0xa0:
      case 0xb0:
      case 0xe0:
        offset += 2;
        break;
      case 0xc0:
        track.program = clampProgram(bytes[offset]);
        offset += 1;
        break;
      case 0xd0:
        offset += 1;
        break;
      default:
        throw new Error(`未対応のステータス: 0x${status.toString(16)}`);
    }
  }

  // 閉じられなかったノートは最小長で確定する
  for (const p of pending.values()) {
    track.notes.push(createNote(p.midi, p.ticks, MIN_NOTE_TICKS, p.velocity));
  }
  track.notes = sortNotes(track.notes);
  return track;
}

/** SMF バイナリを解析してプロジェクトを返す */
export function parseMidi(input) {
  const bytes = toBytes(input);
  if (bytes.length < 14 || readAscii(bytes, 0, 4) !== 'MThd') {
    throw new Error('MThd が見つかりません（SMF ではない可能性があります）');
  }
  const headerLength = readU32(bytes, 4);
  if (headerLength < 6) throw new Error('ヘッダ長が不正です');
  const format = readU16(bytes, 8);
  const division = readU16(bytes, 12);
  if (division & 0x8000) throw new Error('SMPTE 形式には未対応です');
  const ppq = division & 0x7fff;
  if (!ppq) throw new Error('解像度 (PPQ) が 0 です');

  const project = createProject({ format, ppq, name: '', tracks: [] });
  let offset = 8 + headerLength;
  let firstTempo = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkLength = readU32(bytes, offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.length) throw new Error('チャンク長がファイルサイズを超えています');
    if (chunkId === 'MTrk') {
      const track = parseTrack(bytes, chunkStart, chunkEnd);
      if (!project.name && track.name) project.name = track.name;
      if (firstTempo === null && track.tempo) firstTempo = track.tempo;
      project.tracks.push(track);
    }
    offset = chunkEnd;
  }
  if (!project.tracks.length) throw new Error('トラックがありません');
  if (firstTempo) project.bpm = Math.round(TEMPO_US_PER_QUARTER / firstTempo);
  return project;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function writeTrackChunk(track, { includeTempo, bpm }) {
  const body = [];
  const nameBytes = textEncoder.encode(track.name || '');
  body.push(...encodeVlq(0), 0xff, 0x03, ...encodeVlq(nameBytes.length), ...nameBytes);
  if (includeTempo) {
    const us = Math.max(1, Math.round(TEMPO_US_PER_QUARTER / (bpm > 0 ? bpm : DEFAULT_BPM)));
    body.push(...encodeVlq(0), 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  }
  const channel = clampChannel(track.channel ?? 0);
  const program = clampProgram(track.program ?? 0);
  body.push(...encodeVlq(0), 0xc0 | channel, program);

  let lastTick = 0;
  for (const ev of buildMidiEvents(track.notes || [])) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    if (ev.type === 'on') {
      body.push(...encodeVlq(delta), 0x90 | channel, clampMidi(ev.midi), clampVelocity(ev.velocity));
    } else {
      body.push(...encodeVlq(delta), 0x80 | channel, clampMidi(ev.midi), 0);
    }
  }
  body.push(...encodeVlq(0), 0xff, 0x2f, 0x00);

  const out = new Uint8Array(8 + body.length);
  writeAscii(out, 0, 'MTrk');
  writeU32(out, 4, body.length);
  out.set(body, 8);
  return out;
}

/** プロジェクトを SMF バイナリへ書き出す */
export function writeMidi(project) {
  const ppq = project.ppq > 0 ? project.ppq : DEFAULT_PPQ;
  const tracks = project.tracks && project.tracks.length ? project.tracks : [createTrack()];
  const chunks = tracks.map((t, i) =>
    writeTrackChunk(t, { includeTempo: i === 0, bpm: project.bpm }),
  );
  const format = tracks.length > 1 ? 1 : 0;

  const header = new Uint8Array(14);
  writeAscii(header, 0, 'MThd');
  writeU32(header, 4, 6);
  writeU16(header, 8, format);
  writeU16(header, 10, tracks.length);
  writeU16(header, 12, ppq);

  return concatBytes([header, ...chunks]);
}

/* ==========================================================
   ファイル名 / 入力判定
   ========================================================== */

export function isSupportedMidiFile(file) {
  if (!file) return false;
  const name = typeof file === 'string' ? file : file.name;
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return MIDI_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function sanitizeBaseName(name) {
  if (typeof name !== 'string') return 'midi';
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  // 日本語など ASCII 文字を含まない名前は既定値にフォールバックする
  if (!cleaned || !/[A-Za-z]/.test(cleaned)) return 'midi';
  return cleaned;
}

export function buildMidiFileName(name) {
  return `${sanitizeBaseName(name)}.mid`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
