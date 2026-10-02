import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  BASIC_PITCH_VERSION,
  LIB_MODULE_URL,
  MODEL_URL,
  MODEL_BYTES,
  LIB_BYTES_ESTIMATE,
  estimateDownloadBytes,
  SAMPLE_RATE,
  DEFAULT_WINDOW_SECONDS,
  DEFAULT_OVERLAP_SECONDS,
  WINDOW_SAMPLES,
  OVERLAP_SAMPLES,
  MAX_INPUT_SECONDS,
  MIN_PITCH,
  MAX_PITCH,
  DEFAULT_ONSET_THRESHOLD,
  DEFAULT_FRAME_THRESHOLD,
  DEFAULT_MIN_NOTE_LEN,
  AUDIO_EXTENSIONS,
  clamp,
  clampMidi,
  clampVelocity,
  clampProgram,
  clampChannel,
  mixToMono,
  resampleLinear,
  planWindows,
  overallProgress,
  cleanNote,
  noteEnd,
  offsetNotes,
  mergeNotes,
  notesExtent,
  midiToName,
  amplitudeToVelocity,
  timeToTicks,
  notesToProject,
  buildNoteEvents,
  encodeVlq,
  writeSmf,
  MIDI_HANDOFF_KEY,
  HANDOFF_MAX_BYTES,
  serializeHandoff,
  deserializeHandoff,
  canHandoff,
  isSupportedAudioFile,
  sanitizeBaseName,
  buildMidiFileName,
  formatBytes,
  formatSeconds,
  DEFAULT_PPQ,
  DEFAULT_BPM,
} from '../pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const midiStudioPipeline = resolve(appDir, '..', 'midi-studio', 'pipeline.mjs');
const midiStudioScript = resolve(appDir, '..', 'midi-studio', 'script.js');

/* ==========================================================
   カタログ / 定数
   ========================================================== */

test('モデル URL は Basic Pitch 1.0.1 の同梱モデルを指す', () => {
  assert.equal(BASIC_PITCH_VERSION, '1.0.1');
  assert.ok(MODEL_URL.includes('@spotify/basic-pitch@1.0.1/model/model.json'));
  assert.ok(LIB_MODULE_URL.includes('@spotify/basic-pitch@1.0.1/+esm'));
  assert.equal(SAMPLE_RATE, 22050);
});

test('ダウンロード見積りはモデル + ライブラリ', () => {
  assert.equal(estimateDownloadBytes(), MODEL_BYTES + LIB_BYTES_ESTIMATE);
  assert.ok(estimateDownloadBytes() > MODEL_BYTES);
  assert.equal(MODEL_BYTES, 742392 + 174537);
});

test('既定の窓は 60 秒 / 2 秒 overlap でサンプル数が整合する', () => {
  assert.equal(WINDOW_SAMPLES, DEFAULT_WINDOW_SECONDS * SAMPLE_RATE);
  assert.equal(OVERLAP_SAMPLES, DEFAULT_OVERLAP_SECONDS * SAMPLE_RATE);
  assert.equal(MAX_INPUT_SECONDS, 600);
  assert.ok(DEFAULT_OVERLAP_SECONDS < DEFAULT_WINDOW_SECONDS);
  assert.ok(MIN_PITCH < MAX_PITCH);
});

test('採譜パラメータの既定値は Basic Pitch の例に一致する', () => {
  assert.equal(DEFAULT_ONSET_THRESHOLD, 0.5);
  assert.equal(DEFAULT_FRAME_THRESHOLD, 0.3);
  assert.equal(DEFAULT_MIN_NOTE_LEN, 5);
  assert.equal(DEFAULT_PPQ, 480);
  assert.equal(DEFAULT_BPM, 120);
});

/* ==========================================================
   数値
   ========================================================== */

test('clamp 系は範囲外と非数値を丸める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp('x', 3, 10), 3);
  assert.equal(clampMidi(200), 127);
  assert.equal(clampMidi(-5), 0);
  assert.equal(clampVelocity(0), 1);
  assert.equal(clampVelocity(300), 127);
  assert.equal(clampProgram(-1), 0);
  assert.equal(clampChannel(20), 15);
});

/* ==========================================================
   モノラル化
   ========================================================== */

test('mixToMono はチャンネルを平均し、元配列を破壊しない', () => {
  const left = Float32Array.from([1, 0, -1]);
  const right = Float32Array.from([1, 1, 1]);
  const mono = mixToMono([left, right]);
  assert.deepEqual(Array.from(mono).map((v) => +v.toFixed(4)), [1, 0.5, 0]);
  assert.deepEqual(Array.from(left), [1, 0, -1]);
});

test('mixToMono は 1 チャンネルをコピーし、空入力で空を返す', () => {
  const one = mixToMono([Float32Array.from([0.5, -0.5])]);
  assert.deepEqual(Array.from(one), [0.5, -0.5]);
  one[0] = 9;
  assert.notEqual(one[0], 0.5);
  assert.equal(mixToMono([]).length, 0);
  assert.equal(mixToMono([new Float32Array(0)]).length, 0);
});

/* ==========================================================
   リサンプル
   ========================================================== */

test('resampleLinear は同一レートでコピーを返す', () => {
  const input = Float32Array.from([0, 1, 2]);
  const out = resampleLinear(input, 22050, 22050);
  assert.deepEqual(Array.from(out), [0, 1, 2]);
  assert.notEqual(out, input);
});

test('resampleLinear は長さをレート比で変え、端点を保つ', () => {
  const out = resampleLinear(Float32Array.from([0, 10]), 1, 2);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
  assert.equal(out[3], 10);
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i] >= out[i - 1]);
});

test('resampleLinear は単一サンプルと不正レートを扱う', () => {
  assert.deepEqual(Array.from(resampleLinear(Float32Array.from([7]), 48000, 22050)), [7]);
  assert.throws(() => resampleLinear([1, 2], 0, 22050), /正の数/);
  assert.throws(() => resampleLinear([1, 2], 48000, -1), /正の数/);
  assert.equal(resampleLinear([], 48000, 22050).length, 0);
});

/* ==========================================================
   窓分割
   ========================================================== */

test('planWindows は窓長以下なら 1 窓にする', () => {
  assert.deepEqual(planWindows(0), []);
  assert.deepEqual(planWindows(100, 200, 10), [{ index: 0, start: 0, end: 100, length: 100 }]);
  assert.deepEqual(planWindows(200, 200, 10), [{ index: 0, start: 0, end: 200, length: 200 }]);
});

test('planWindows は overlap 付きで分割し、最後の窓が末尾に届く', () => {
  const windows = planWindows(10, 4, 1);
  assert.deepEqual(windows, [
    { index: 0, start: 0, end: 4, length: 4 },
    { index: 1, start: 3, end: 7, length: 4 },
    { index: 2, start: 6, end: 10, length: 4 },
  ]);
});

test('planWindows は端数が残る場合も末尾まで覆う', () => {
  const windows = planWindows(8, 4, 0);
  assert.deepEqual(windows, [
    { index: 0, start: 0, end: 4, length: 4 },
    { index: 1, start: 4, end: 8, length: 4 },
  ]);
  const ragged = planWindows(9, 4, 0);
  assert.equal(ragged[ragged.length - 1].end, 9);
  assert.equal(ragged[ragged.length - 1].length, 1);
});

test('planWindows は不正な引数を拒否する', () => {
  assert.throws(() => planWindows(-1), /不正/);
  assert.throws(() => planWindows(10, 0, 0), /窓長/);
  assert.throws(() => planWindows(10, 4, 4), /オーバーラップ/);
  assert.throws(() => planWindows(10, 4, -1), /オーバーラップ/);
});

test('overallProgress は窓 index と内訳から全体進捗を作る', () => {
  assert.equal(overallProgress(0, 4, 0), 0);
  assert.equal(overallProgress(0, 4, 0.5), 0.125);
  assert.equal(overallProgress(3, 4, 1), 1);
  assert.equal(overallProgress(9, 4, 0), 0.75, '範囲外 index は末尾の窓へ丸める');
  assert.equal(overallProgress(-1, 4, 0), 0);
});

/* ==========================================================
   音符のクリーニング / マージ
   ========================================================== */

test('cleanNote は正常値を正規化し、不正値を null にする', () => {
  const note = cleanNote({ pitchMidi: 60.4, startTimeSeconds: -1, durationSeconds: 0.5, amplitude: 2 });
  assert.equal(note.pitchMidi, 60);
  assert.equal(note.startTimeSeconds, 0);
  assert.equal(note.durationSeconds, 0.5);
  assert.equal(note.amplitude, 2);
  assert.equal(cleanNote({ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0 }), null);
  assert.equal(cleanNote({ pitchMidi: 200, startTimeSeconds: 0, durationSeconds: 1 }), null);
  assert.equal(cleanNote(null), null);
  assert.deepEqual(cleanNote({ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 1, pitchBends: [0, 1] }).pitchBends, [0, 1]);
});

test('noteEnd と offsetNotes は時刻をずらす', () => {
  const note = { pitchMidi: 60, startTimeSeconds: 1, durationSeconds: 0.5, amplitude: 1 };
  assert.equal(noteEnd(note), 1.5);
  const shifted = offsetNotes([note], 2);
  assert.equal(shifted[0].startTimeSeconds, 3);
  assert.equal(shifted[0].durationSeconds, 0.5);
  assert.equal(note.startTimeSeconds, 1, '元は破壊しない');
});

test('mergeNotes は同じ音高で連続する断片を 1 つに結合する', () => {
  const merged = mergeNotes([
    { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 0.4 },
    { pitchMidi: 60, startTimeSeconds: 0.51, durationSeconds: 0.5, amplitude: 0.8 },
    { pitchMidi: 64, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 0.6 },
  ]);
  assert.equal(merged.length, 2);
  const c60 = merged.find((n) => n.pitchMidi === 60);
  assert.equal(c60.startTimeSeconds, 0);
  assert.equal(+c60.durationSeconds.toFixed(2), 1.01);
  assert.equal(c60.amplitude, 0.8, '大きい amplitude を残す');
});

test('mergeNotes は tolerance を超えて離れた同音を結合しない', () => {
  const merged = mergeNotes([
    { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.2, amplitude: 0.5 },
    { pitchMidi: 60, startTimeSeconds: 1, durationSeconds: 0.2, amplitude: 0.5 },
  ]);
  assert.equal(merged.length, 2);
});

test('mergeNotes は小さい amplitude を除外し音符順を整える', () => {
  const merged = mergeNotes(
    [
      { pitchMidi: 61, startTimeSeconds: 1, durationSeconds: 0.3, amplitude: 0.02 },
      { pitchMidi: 60, startTimeSeconds: 0.5, durationSeconds: 0.3, amplitude: 0.5 },
      { pitchMidi: 59, startTimeSeconds: 0.5, durationSeconds: 0.3, amplitude: 0.5 },
    ],
    { minAmplitude: 0.1 },
  );
  assert.deepEqual(merged.map((n) => n.pitchMidi), [59, 60]);
});

test('notesExtent は範囲と終端を返し、空なら既定', () => {
  const extent = notesExtent([
    { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 1, amplitude: 1 },
    { pitchMidi: 72, startTimeSeconds: 1, durationSeconds: 2, amplitude: 1 },
  ]);
  assert.deepEqual(extent, { minMidi: 60, maxMidi: 72, maxEnd: 3 });
  assert.deepEqual(notesExtent([], { minMidi: 1, maxMidi: 2, maxEnd: 3 }), { minMidi: 1, maxMidi: 2, maxEnd: 3 });
});

test('midiToName は 60 を C4 にする', () => {
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(69), 'A4');
  assert.equal(midiToName(61), 'C#4');
});

/* ==========================================================
   音符 → プロジェクト → SMF
   ========================================================== */

test('amplitudeToVelocity は 0..1 を 1..127 に写す', () => {
  assert.equal(amplitudeToVelocity(0), 1);
  assert.equal(amplitudeToVelocity(1), 127);
  assert.equal(amplitudeToVelocity(0.5), 64);
  assert.equal(amplitudeToVelocity(NaN), 96);
  assert.equal(amplitudeToVelocity(2), 127);
});

test('timeToTicks は 120BPM / 480PPQ で 1 秒 = 960 tick', () => {
  assert.equal(timeToTicks(1), 960);
  assert.equal(timeToTicks(0.5), 480);
  assert.equal(timeToTicks(0), 0);
  assert.equal(timeToTicks(-1), 0);
});

test('notesToProject は midi-studio 互換のプロジェクトを作る', () => {
  const project = notesToProject(
    [
      { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 1 },
      { pitchMidi: 64, startTimeSeconds: 1, durationSeconds: 0.25, amplitude: 0.5 },
    ],
    { name: 'Take' },
  );
  assert.equal(project.ppq, 480);
  assert.equal(project.bpm, 120);
  assert.equal(project.name, 'Take');
  assert.equal(project.tracks.length, 1);
  const notes = project.tracks[0].notes;
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.midi), [60, 64]);
  assert.deepEqual(notes.map((n) => n.ticks), [0, 960]);
  assert.equal(notes[0].duration, 480);
  assert.equal(notes[0].velocity, 127);
  assert.equal(notes[1].velocity, 64);
});

test('notesToProject は範囲外の音高を落とし、最短 duration を 1 にする', () => {
  const project = notesToProject([
    { pitchMidi: 20, startTimeSeconds: 0, durationSeconds: 1, amplitude: 1 },
    { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.0000001, amplitude: 1 },
    { pitchMidi: 109, startTimeSeconds: 0, durationSeconds: 1, amplitude: 1 },
  ]);
  const notes = project.tracks[0].notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].midi, 60);
  assert.equal(notes[0].duration, 1);
});

test('buildNoteEvents は同 tick で note off を先にする', () => {
  const events = buildNoteEvents([
    { midi: 60, ticks: 0, duration: 480, velocity: 100 },
    { midi: 62, ticks: 0, duration: 240, velocity: 100 },
  ]);
  assert.equal(events[0].type, 'on');
  const offAt0 = events.filter((e) => e.tick === 0);
  assert.deepEqual(offAt0.map((e) => e.type), ['on', 'on']);
  const at240 = events.filter((e) => e.tick === 240);
  assert.deepEqual(at240.map((e) => e.type), ['off']);
});

test('encodeVlq は境界値を正しくエンコードする', () => {
  assert.deepEqual(encodeVlq(0), [0x00]);
  assert.deepEqual(encodeVlq(0x7f), [0x7f]);
  assert.deepEqual(encodeVlq(0x80), [0x81, 0x00]);
  assert.deepEqual(encodeVlq(0x3fff), [0xff, 0x7f]);
  assert.deepEqual(encodeVlq(0x4000), [0x81, 0x80, 0x00]);
  assert.throws(() => encodeVlq(-1), /0 以上/);
  assert.throws(() => encodeVlq(1.5), /0 以上/);
});

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

test('writeSmf は MThd から始まり MTrk と end-of-track を含む', () => {
  const project = notesToProject([
    { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 1 },
  ]);
  const bytes = writeSmf(project);
  assert.equal(ascii(bytes, 0, 4), 'MThd');
  assert.equal(ascii(bytes, 14, 4), 'MTrk');
  // 末尾は end of track メタ (00 FF 2F 00)
  assert.deepEqual(Array.from(bytes.slice(-4)), [0x00, 0xff, 0x2f, 0x00]);
});

test('writeSmf は空プロジェクトでも有効なバイト列を返す', () => {
  const bytes = writeSmf({ ppq: 480, bpm: 120, tracks: [{ name: '', channel: 0, program: 0, notes: [] }] });
  assert.equal(ascii(bytes, 0, 4), 'MThd');
  assert.deepEqual(Array.from(bytes.slice(-4)), [0x00, 0xff, 0x2f, 0x00]);
});

/* ==========================================================
   midi-studio との互換
   ========================================================== */

test('writeSmf の出力は midi-studio の parseMidi で読める', async (t) => {
  if (!existsSync(midiStudioPipeline)) {
    t.skip('midi-studio が同じツリーに無い');
    return;
  }
  const { parseMidi } = await import(pathToFileURL(midiStudioPipeline).href);
  const project = notesToProject(
    [
      { pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.5, amplitude: 1 },
      { pitchMidi: 67, startTimeSeconds: 1, durationSeconds: 1, amplitude: 0.5 },
    ],
    { name: 'Transcription' },
  );
  const parsed = parseMidi(writeSmf(project));
  assert.equal(parsed.ppq, 480);
  assert.equal(parsed.bpm, 120);
  assert.equal(parsed.tracks.length, 1);
  const notes = parsed.tracks[0].notes;
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.midi), [60, 67]);
  assert.deepEqual(notes.map((n) => n.ticks), [0, 960]);
  assert.equal(notes[0].duration, 480);
  assert.equal(notes[1].duration, 960);
});

test('handoff のキーは midi-studio と一致する', (t) => {
  if (!existsSync(midiStudioScript)) {
    t.skip('midi-studio が同じツリーに無い');
    return;
  }
  const source = readFileSync(midiStudioScript, 'utf8');
  assert.equal(MIDI_HANDOFF_KEY, 'myapps:midi-handoff');
  assert.ok(source.includes("'myapps:midi-handoff'"), 'midi-studio が handoff キーを読んでいない');
});

/* ==========================================================
   handoff の直列化
   ========================================================== */

test('handoff は往復して同じプロジェクトになる', () => {
  const project = notesToProject([{ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 1, amplitude: 1 }]);
  const raw = serializeHandoff(project);
  assert.equal(typeof raw, 'string');
  const restored = deserializeHandoff(raw);
  assert.equal(restored.ppq, project.ppq);
  assert.equal(restored.tracks[0].notes.length, 1);
});

test('deserializeHandoff は不正入力を null にする', () => {
  assert.equal(deserializeHandoff(''), null);
  assert.equal(deserializeHandoff('{'), null);
  assert.equal(deserializeHandoff('null'), null);
  assert.equal(deserializeHandoff(JSON.stringify({ ppq: 480, tracks: [] })), null);
  assert.equal(deserializeHandoff(JSON.stringify({ tracks: [{ notes: [] }] })), null);
  assert.equal(deserializeHandoff(JSON.stringify({ ppq: 480, tracks: [{ notes: 'x' }] })), null);
});

test('canHandoff は小さいプロジェクトを許可し、巨大なものを拒否する', () => {
  const project = notesToProject([{ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 1, amplitude: 1 }]);
  assert.equal(canHandoff(project), true);
  const huge = {
    ppq: 480,
    bpm: 120,
    name: 'huge',
    tracks: [
      {
        name: 'huge',
        channel: 0,
        program: 0,
        notes: Array.from({ length: 40000 }, (_, i) => ({
          midi: 60,
          ticks: i * 10,
          duration: 5,
          velocity: 100,
        })),
      },
    ],
  };
  assert.ok(serializeHandoff(huge).length > HANDOFF_MAX_BYTES);
  assert.equal(canHandoff(huge), false);
});

/* ==========================================================
   ファイル / 表示
   ========================================================== */

test('isSupportedAudioFile は拡張子で判定する', () => {
  assert.equal(isSupportedAudioFile('take.m4a'), true);
  assert.equal(isSupportedAudioFile('take.WAV'), true);
  assert.equal(isSupportedAudioFile({ name: 'song.mp3' }), true);
  assert.equal(isSupportedAudioFile('song.txt'), false);
  assert.equal(isSupportedAudioFile(null), false);
  assert.equal(AUDIO_EXTENSIONS.includes('.wav'), true);
});

test('sanitizeBaseName / buildMidiFileName は安全な名前を作る', () => {
  assert.equal(sanitizeBaseName('My Song!.m4a'), 'My_Song');
  assert.equal(sanitizeBaseName('鼻歌'), 'transcription');
  assert.equal(buildMidiFileName('take.wav'), 'take.mid');
  assert.equal(buildMidiFileName(''), 'transcription.mid');
});

test('formatBytes / formatSeconds は読みやすい表示にする', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB');
  assert.equal(formatBytes(-1), '-');
  assert.equal(formatSeconds(0), '0:00.0');
  assert.equal(formatSeconds(61.5), '1:01.5');
  assert.equal(formatSeconds(NaN), '0:00.0');
});
