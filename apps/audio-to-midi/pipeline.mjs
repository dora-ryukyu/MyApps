/**
 * pipeline.mjs — 音声→MIDI 採譜の純ロジック
 *
 * DOM / Web Audio / TensorFlow.js に依存しない。ブラウザでも Node でも同じように動く
 * 計算だけを置き、`node --test` で検証する。
 *
 * 推論そのものは script.js が担当する:
 *   - Spotify Basic Pitch (@spotify/basic-pitch, Apache-2.0)
 *
 * ここには次の純関数を置く:
 *   - モノラル化 / リサンプル (22050Hz)
 *   - 長い音源の窓分割 (overlap 付き) と進捗計算
 *   - Basic Pitch の音符列のクリーニング / 窓境界のマージ
 *   - 音符 → SMF (Standard MIDI File) バイナリ
 *   - midi-studio への受け渡し (sessionStorage 用の直列化)
 *
 * 出典:
 *   https://www.npmjs.com/package/@spotify/basic-pitch
 *   https://github.com/spotify/basic-pitch-ts
 *   https://github.com/spotify/basic-pitch
 *   MIDI 1.0 Specification (SMF)
 */

/* ==========================================================
   Basic Pitch のロード情報
   ========================================================== */

export const BASIC_PITCH_VERSION = '1.0.1';
/** jsDelivr が依存 (TensorFlow.js / @tonejs/midi) ごとバンドルした ES モジュール */
export const LIB_MODULE_URL = `https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@${BASIC_PITCH_VERSION}/+esm`;
/** パッケージ同梱の重み。モデル JSON からの相対で shard も取得される */
export const MODEL_URL = `https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@${BASIC_PITCH_VERSION}/model/model.json`;
/** model.json (174,537 B) + group1-shard1of1.bin (742,392 B) の実測値 */
export const MODEL_BYTES = 916929;
/** ES モジュール本体 + TensorFlow.js + @tonejs/midi の概算 (gzip 前) */
export const LIB_BYTES_ESTIMATE = 2600000;

/** 初回ダウンロード量の見積り (モデル + ライブラリ) */
export function estimateDownloadBytes() {
  return MODEL_BYTES + LIB_BYTES_ESTIMATE;
}

/* ==========================================================
   音声 / 窓分割
   ========================================================== */

export const SAMPLE_RATE = 22050;
export const DEFAULT_WINDOW_SECONDS = 60;
export const DEFAULT_OVERLAP_SECONDS = 2;
export const WINDOW_SAMPLES = DEFAULT_WINDOW_SECONDS * SAMPLE_RATE;
export const OVERLAP_SAMPLES = DEFAULT_OVERLAP_SECONDS * SAMPLE_RATE;
/** これ以上長い入力を拒否する (メモリ保護)。10 分。 */
export const MAX_INPUT_SECONDS = 600;

export const MIN_PITCH = 21;
export const MAX_PITCH = 108;

/** Basic Pitch の採譜パラメータ既定値 (README の例に準拠) */
export const DEFAULT_ONSET_THRESHOLD = 0.5;
export const DEFAULT_FRAME_THRESHOLD = 0.3;
export const DEFAULT_MIN_NOTE_LEN = 5;
export const ONSET_THRESHOLD_RANGE = Object.freeze([0.1, 0.9]);
export const FRAME_THRESHOLD_RANGE = Object.freeze([0.1, 0.9]);
export const MIN_NOTE_LEN_RANGE = Object.freeze([3, 30]);

export const MIDI_EXTENSION = '.mid';
export const AUDIO_EXTENSIONS = Object.freeze([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.webm',
]);

/* ==========================================================
   数値ユーティリティ
   ========================================================== */

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function clampMidi(value) {
  return clamp(Math.round(value), 0, 127);
}

export function clampVelocity(value) {
  return clamp(Math.round(Number.isFinite(value) ? value : 96), 1, 127);
}

export function clampProgram(value) {
  return clamp(Math.round(value), 0, 127);
}

export function clampChannel(value) {
  return clamp(Math.round(value), 0, 15);
}

/* ==========================================================
   音声: モノラル化 / リサンプル
   ========================================================== */

/**
 * 複数チャンネルを 1 本のモノラルに平均する。
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  const valid = channels.filter((c) => c && Number.isFinite(c.length));
  if (valid.length === 0) return new Float32Array(0);
  if (valid.length === 1) return Float32Array.from(valid[0]);
  const length = Math.min(...valid.map((c) => c.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of valid) sum += channel[i];
    out[i] = sum / valid.length;
  }
  return out;
}

/**
 * 線形補間でサンプルレートを変換するフォールバック実装。
 * ブラウザでは OfflineAudioContext による高品質な変換を優先し、
 * これが使えない環境のときだけ使う。
 * @param {Float32Array|number[]} input
 * @param {number} inRate
 * @param {number} outRate
 * @returns {Float32Array}
 */
export function resampleLinear(input, inRate, outRate) {
  const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
  if (!(inRate > 0) || !(outRate > 0)) throw new RangeError('サンプルレートは正の数です');
  if (src.length === 0) return new Float32Array(0);
  if (inRate === outRate) return Float32Array.from(src);
  const outLength = Math.max(1, Math.round((src.length * outRate) / inRate));
  const out = new Float32Array(outLength);
  if (outLength === 1) {
    out[0] = src[0];
    return out;
  }
  const ratio = (src.length - 1) / (outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

/* ==========================================================
   窓分割
   ========================================================== */

/**
 * 長い音源を overlap 付きの窓に分割する。
 * 末尾の窓は必ず残りの全長を含み、最後の窓の end は total に一致する。
 * @param {number} totalSamples
 * @param {number} windowSamples
 * @param {number} overlapSamples
 * @returns {{index:number,start:number,end:number,length:number}[]}
 */
export function planWindows(totalSamples, windowSamples = WINDOW_SAMPLES, overlapSamples = OVERLAP_SAMPLES) {
  const total = Math.floor(Number(totalSamples));
  if (!Number.isFinite(total) || total < 0) throw new RangeError('サンプル数が不正です');
  if (total === 0) return [];
  const win = Math.floor(Number(windowSamples));
  const overlap = Math.floor(Number(overlapSamples));
  if (!(win > 0)) throw new RangeError('窓長は正の数です');
  if (!(overlap >= 0) || overlap >= win) throw new RangeError('オーバーラップは 0 以上、窓長未満です');
  if (total <= win) return [{ index: 0, start: 0, end: total, length: total }];

  const hop = win - overlap;
  const windows = [];
  let start = 0;
  let index = 0;
  while (index < 100000) {
    const end = Math.min(total, start + win);
    windows.push({ index, start, end, length: end - start });
    if (end >= total) return windows;
    start += hop;
    index += 1;
  }
  throw new Error('窓分割が収束しません');
}

/** 窓 index × 窓内進捗 (0..1) から全体進捗 (0..1) を作る */
export function overallProgress(windowIndex, windowCount, innerProgress = 0) {
  const count = Math.max(1, Math.floor(windowCount));
  const idx = clamp(Math.floor(windowIndex), 0, count - 1);
  const inner = clamp(innerProgress, 0, 1);
  return clamp((idx + inner) / count, 0, 1);
}

/* ==========================================================
   音符のクリーニング / マージ
   ========================================================== */

/**
 * Basic Pitch の音符 (`{startTimeSeconds,durationSeconds,pitchMidi,amplitude,pitchBends?}`)
 * を検証・正規化する。不正なら null。
 */
export function cleanNote(note) {
  if (!note || typeof note !== 'object') return null;
  const start = Number(note.startTimeSeconds);
  const duration = Number(note.durationSeconds);
  const pitch = Math.round(Number(note.pitchMidi));
  if (!Number.isFinite(start) || !Number.isFinite(duration) || !Number.isFinite(pitch)) return null;
  if (duration <= 0) return null;
  if (pitch < 0 || pitch > 127) return null;
  const clean = {
    pitchMidi: pitch,
    amplitude: Number.isFinite(note.amplitude) ? note.amplitude : 0,
    startTimeSeconds: Math.max(0, start),
    durationSeconds: duration,
  };
  if (Array.isArray(note.pitchBends)) clean.pitchBends = note.pitchBends.map((v) => Number(v));
  return clean;
}

export function noteEnd(note) {
  return note.startTimeSeconds + note.durationSeconds;
}

/** 音符列の時刻を offset 秒だけ後ろへずらす (窓ごとの結果を全体時刻へ) */
export function offsetNotes(notes, offsetSeconds) {
  const offset = Number(offsetSeconds) || 0;
  return notes.map((n) => ({ ...n, startTimeSeconds: n.startTimeSeconds + offset }));
}

/**
 * 窓分割で生じた重複・分断をまとめる。
 * 同じ音高で時間が重なる / `gapTolerance` 秒以内に接する音符を 1 つに結合する。
 * @param {object[]} notes
 * @param {{gapTolerance?:number,minAmplitude?:number}} [options]
 */
export function mergeNotes(notes, { gapTolerance = 0.06, minAmplitude = 0 } = {}) {
  const cleaned = (Array.isArray(notes) ? notes : [])
    .map(cleanNote)
    .filter((n) => n && n.amplitude >= minAmplitude);

  const byPitch = new Map();
  for (const note of cleaned) {
    const list = byPitch.get(note.pitchMidi);
    if (list) list.push({ ...note });
    else byPitch.set(note.pitchMidi, [{ ...note }]);
  }

  const merged = [];
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    let current = null;
    for (const note of list) {
      if (!current) {
        current = note;
        continue;
      }
      if (note.startTimeSeconds <= noteEnd(current) + gapTolerance) {
        const end = Math.max(noteEnd(current), noteEnd(note));
        current.durationSeconds = end - current.startTimeSeconds;
        current.amplitude = Math.max(current.amplitude, note.amplitude);
      } else {
        merged.push(current);
        current = note;
      }
    }
    if (current) merged.push(current);
  }

  merged.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
  return merged;
}

/** 音符群の範囲 (piano roll の表示用)。空なら fallback。 */
export function notesExtent(notes, fallback = { minMidi: 48, maxMidi: 72, maxEnd: 1 }) {
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  if (list.length === 0) return { ...fallback };
  let minMidi = 127;
  let maxMidi = 0;
  let maxEnd = 0;
  for (const n of list) {
    minMidi = Math.min(minMidi, n.pitchMidi);
    maxMidi = Math.max(maxMidi, n.pitchMidi);
    maxEnd = Math.max(maxEnd, noteEnd(n));
  }
  return { minMidi, maxMidi, maxEnd: Math.max(maxEnd, 0.001) };
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI ノート番号 → 音名 (60 = C4) */
export function midiToName(midi) {
  const n = clampMidi(midi);
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

/* ==========================================================
   音符 → MIDI プロジェクト → SMF
   ========================================================== */

export const DEFAULT_PPQ = 480;
export const DEFAULT_BPM = 120;
export const DEFAULT_PROGRAM = 0; // Acoustic Grand Piano
export const MAX_NOTES = 20000;
/** 音量 (amplitude, 0..1) を velocity (1..127) に写す */
export function amplitudeToVelocity(amplitude) {
  if (!Number.isFinite(amplitude)) return 96;
  return clamp(Math.round(1 + clamp(amplitude, 0, 1) * 126), 1, 127);
}

/** 秒 → MIDI tick */
export function timeToTicks(seconds, ppq = DEFAULT_PPQ, bpm = DEFAULT_BPM) {
  const safePpq = ppq > 0 ? ppq : DEFAULT_PPQ;
  const safeBpm = bpm > 0 ? bpm : DEFAULT_BPM;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.max(0, Math.round((s * safePpq * safeBpm) / 60));
}

/**
 * 採譜した音符列を midi-studio 互換のプロジェクトへ変換する。
 * `{format, ppq, bpm, name, tracks:[{name,channel,program,notes:[{midi,ticks,duration,velocity}]}]}`
 */
export function notesToProject(
  notes,
  { name = 'Transcription', ppq = DEFAULT_PPQ, bpm = DEFAULT_BPM, program = DEFAULT_PROGRAM } = {},
) {
  const result = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    const clean = cleanNote(note);
    if (!clean) continue;
    if (clean.pitchMidi < MIN_PITCH || clean.pitchMidi > MAX_PITCH) continue;
    result.push({
      midi: clean.pitchMidi,
      ticks: timeToTicks(clean.startTimeSeconds, ppq, bpm),
      duration: Math.max(1, timeToTicks(clean.durationSeconds, ppq, bpm)),
      velocity: amplitudeToVelocity(clean.amplitude),
    });
    if (result.length >= MAX_NOTES) break;
  }
  result.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  return {
    format: 0,
    ppq,
    bpm,
    name,
    tracks: [
      {
        name,
        channel: 0,
        program: clampProgram(program),
        notes: result,
      },
    ],
  };
}

/** ノートオン/オフを時刻順に並べる (同 tick では note off が先) */
export function buildNoteEvents(notes) {
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

function asciiBytes(text) {
  return Array.from(String(text), (ch) => ch.charCodeAt(0) & 0xff);
}

function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

const TEMPO_US_PER_QUARTER = 60000000;

function trackBody(track, { includeTempo, bpm }) {
  const body = [];
  const name = asciiBytes(track.name || '');
  body.push(...encodeVlq(0), 0xff, 0x03, ...encodeVlq(name.length), ...name);
  if (includeTempo) {
    const us = Math.max(1, Math.round(TEMPO_US_PER_QUARTER / (bpm > 0 ? bpm : DEFAULT_BPM)));
    body.push(...encodeVlq(0), 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  }
  const channel = clampChannel(track.channel ?? 0);
  body.push(...encodeVlq(0), 0xc0 | channel, clampProgram(track.program ?? 0));

  let lastTick = 0;
  for (const ev of buildNoteEvents(track.notes || [])) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    if (ev.type === 'on') {
      body.push(...encodeVlq(delta), 0x90 | channel, clampMidi(ev.midi), clampVelocity(ev.velocity));
    } else {
      body.push(...encodeVlq(delta), 0x80 | channel, clampMidi(ev.midi), 0);
    }
  }
  body.push(...encodeVlq(0), 0xff, 0x2f, 0x00);
  return body;
}

/**
 * プロジェクトを SMF (Standard MIDI File) のバイト列にする。
 * midi-studio の `parseMidi` でそのまま読める形式 (format 0/1, PPQ)。
 */
export function writeSmf(project) {
  const safe = project && typeof project === 'object' ? project : {};
  const ppq = safe.ppq > 0 ? safe.ppq : DEFAULT_PPQ;
  const tracks =
    Array.isArray(safe.tracks) && safe.tracks.length
      ? safe.tracks
      : [{ name: '', channel: 0, program: 0, notes: [] }];
  const bpm = safe.bpm > 0 ? safe.bpm : DEFAULT_BPM;

  const parts = [[...asciiBytes('MThd'), ...u32(6), ...u16(tracks.length > 1 ? 1 : 0), ...u16(tracks.length), ...u16(ppq)]];
  tracks.forEach((track, index) => {
    const body = trackBody(track, { includeTempo: index === 0, bpm });
    parts.push([...asciiBytes('MTrk'), ...u32(body.length), ...body]);
  });

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ==========================================================
   midi-studio への受け渡し (sessionStorage)
   ========================================================== */

/** midi-studio と共有する sessionStorage キー。両アプリでこの文字列を一致させる。 */
export const MIDI_HANDOFF_KEY = 'myapps:midi-handoff';
/** 受け渡しを諦めて .mid 保存を促すしきい値 (sessionStorage は概ね 5MB) */
export const HANDOFF_MAX_BYTES = 2 * 1024 * 1024;

export function serializeHandoff(project) {
  return JSON.stringify(project);
}

/** sessionStorage の生文字列を検証してプロジェクトに戻す。不正なら null。 */
export function deserializeHandoff(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.tracks) || parsed.tracks.length === 0) return null;
  if (!(Number(parsed.ppq) > 0)) return null;
  for (const track of parsed.tracks) {
    if (!track || !Array.isArray(track.notes)) return null;
  }
  return parsed;
}

/** 受け渡しを試みてよいサイズか */
export function canHandoff(project) {
  try {
    return serializeHandoff(project).length <= HANDOFF_MAX_BYTES;
  } catch {
    return false;
  }
}

/* ==========================================================
   ファイル名 / 入力判定 / 表示
   ========================================================== */

export function isSupportedAudioFile(file) {
  if (!file) return false;
  const name = typeof file === 'string' ? file : file.name;
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function sanitizeBaseName(name) {
  if (typeof name !== 'string') return 'transcription';
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned || !/[A-Za-z]/.test(cleaned)) return 'transcription';
  return cleaned;
}

export function buildMidiFileName(name) {
  return `${sanitizeBaseName(name)}${MIDI_EXTENSION}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '0:00.0';
  const tenths = Math.floor(s * 10) % 10;
  const secs = Math.floor(s) % 60;
  const mins = Math.floor(s / 60);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}
