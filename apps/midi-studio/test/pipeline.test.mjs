import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTE_NAMES,
  DEFAULT_PPQ,
  DEFAULT_BPM,
  DEFAULT_VELOCITY,
  MIN_NOTE_TICKS,
  MAX_MIDI,
  PIANO_LOW_MIDI,
  PIANO_HIGH_MIDI,
  PIANO_KEY_COUNT,
  SNAP_OPTIONS,
  KEYBOARD_MAP,
  clamp,
  clampMidi,
  clampVelocity,
  clampChannel,
  clampProgram,
  midiToName,
  nameToMidi,
  isBlackKey,
  midiToFrequency,
  keyToMidi,
  createNote,
  createTrack,
  createProject,
  cloneProject,
  countNotes,
  projectEndTick,
  sortNotes,
  addNote,
  removeNoteAt,
  updateNoteAt,
  moveNoteAt,
  resizeNoteAt,
  transposeNotes,
  hitTestNote,
  notesExtent,
  quantizeTick,
  ticksToSeconds,
  secondsToTicks,
  buildMidiEvents,
  toPlaybackNotes,
  formatTime,
  rowYForMidi,
  midiRowAt,
  tickX,
  tickAtX,
  encodeVlq,
  decodeVlq,
  parseMidi,
  writeMidi,
  isSupportedMidiFile,
  sanitizeBaseName,
  buildMidiFileName,
  formatBytes,
} from '../pipeline.mjs';

/* ==========================================================
   定数
   ========================================================== */

test('定数が仕様どおり', () => {
  assert.equal(NOTE_NAMES.length, 12);
  assert.equal(DEFAULT_PPQ, 480);
  assert.equal(DEFAULT_BPM, 120);
  assert.equal(DEFAULT_VELOCITY, 96);
  assert.equal(PIANO_LOW_MIDI, 21);
  assert.equal(PIANO_HIGH_MIDI, 108);
  assert.equal(PIANO_KEY_COUNT, 88);
  assert.ok(SNAP_OPTIONS.some((o) => o.id === '1/16' && o.ratio === 1 / 16));
  assert.equal(KEYBOARD_MAP.a, 0);
  assert.equal(KEYBOARD_MAP.w, 1);
  assert.equal(KEYBOARD_MAP.j, 11);
});

/* ==========================================================
   クランプ
   ========================================================== */

test('clamp / clampMidi / clampVelocity は範囲内に丸める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(NaN, 3, 10), 3);
  assert.equal(clampMidi(-5), 0);
  assert.equal(clampMidi(200), 127);
  assert.equal(clampMidi(60.4), 60);
  assert.equal(clampVelocity(0), 1);
  assert.equal(clampVelocity(300), 127);
  assert.equal(clampVelocity(NaN), DEFAULT_VELOCITY);
  assert.equal(clampChannel(20), 15);
  assert.equal(clampChannel(-1), 0);
  assert.equal(clampProgram(200), 127);
});

/* ==========================================================
   音名 / 周波数
   ========================================================== */

test('midiToName は 60 を C4 として表記する', () => {
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(61), 'C#4');
  assert.equal(midiToName(69), 'A4');
  assert.equal(midiToName(21), 'A0');
  assert.equal(midiToName(108), 'C8');
  assert.equal(midiToName(-1), 'C-1');
});

test('nameToMidi は midiToName の逆変換になる', () => {
  for (let midi = PIANO_LOW_MIDI; midi <= PIANO_HIGH_MIDI; midi += 1) {
    assert.equal(nameToMidi(midiToName(midi)), midi);
  }
  assert.equal(nameToMidi('Db4'), 61);
  assert.equal(nameToMidi('C4'), 60);
  assert.equal(nameToMidi('c4'), 60);
  assert.equal(nameToMidi('H4'), null);
  assert.equal(nameToMidi('C#'), null);
  assert.equal(nameToMidi(60), null);
});

test('isBlackKey は黒鍵だけ true', () => {
  const black = [1, 3, 6, 8, 10];
  for (let pc = 0; pc < 12; pc += 1) {
    assert.equal(isBlackKey(60 + pc), black.includes(pc), `pc=${pc}`);
  }
});

test('midiToFrequency は A4 = 440Hz、1 オクターブで倍', () => {
  assert.equal(midiToFrequency(69), 440);
  assert.ok(Math.abs(midiToFrequency(81) - 880) < 1e-9);
  assert.ok(Math.abs(midiToFrequency(57) - 220) < 1e-9);
});

/* ==========================================================
   QWERTY
   ========================================================== */

test('keyToMidi は基準オクターブから半音を積む', () => {
  assert.equal(keyToMidi('a', 4), 60);
  assert.equal(keyToMidi('A', 4), 60);
  assert.equal(keyToMidi('w', 4), 61);
  assert.equal(keyToMidi('j', 4), 71);
  assert.equal(keyToMidi('a', 3), 48);
  assert.equal(keyToMidi(';', 4), 76);
  assert.equal(keyToMidi('z', 4), null);
  assert.equal(keyToMidi(null), null);
});

/* ==========================================================
   データモデル / 編集
   ========================================================== */

test('createNote は値をクランプし、最小長を保証する', () => {
  const note = createNote(60.6, -10, 0, 0);
  assert.deepEqual(note, { midi: 61, ticks: 0, duration: MIN_NOTE_TICKS, velocity: 1 });
});

test('createProject / createTrack は既定値を持つ', () => {
  const project = createProject();
  assert.equal(project.ppq, DEFAULT_PPQ);
  assert.equal(project.bpm, DEFAULT_BPM);
  assert.equal(project.tracks.length, 1);
  assert.equal(project.tracks[0].name, 'Piano');
  const track = createTrack({ name: 'Bass', channel: 2 });
  assert.equal(track.name, 'Bass');
  assert.equal(track.channel, 2);
  assert.deepEqual(track.notes, []);
});

test('cloneProject は深いコピーを作る', () => {
  const project = createProject();
  project.tracks[0].notes.push(createNote(60, 0, 480));
  const copy = cloneProject(project);
  copy.tracks[0].notes[0].midi = 72;
  assert.equal(project.tracks[0].notes[0].midi, 60);
});

test('countNotes / projectEndTick は全トラックを横断する', () => {
  const project = createProject({
    tracks: [
      createTrack({ notes: [createNote(60, 0, 480), createNote(62, 480, 240)] }),
      createTrack({ notes: [createNote(48, 960, 480)] }),
    ],
  });
  assert.equal(countNotes(project), 3);
  assert.equal(projectEndTick(project), 1440);
});

test('sortNotes / addNote は ticks → midi の順に整列する', () => {
  const a = createNote(64, 480, 120);
  const b = createNote(60, 0, 120);
  const c = createNote(61, 0, 120);
  const sorted = sortNotes([a, b, c]);
  assert.deepEqual(sorted.map((n) => [n.ticks, n.midi]), [[0, 60], [0, 61], [480, 64]]);
  const added = addNote([b], a);
  assert.equal(added.length, 2);
  assert.equal(added[1].midi, 64);
});

test('removeNoteAt / updateNoteAt は index で操作する', () => {
  const notes = [createNote(60, 0, 480), createNote(62, 480, 480)];
  assert.equal(removeNoteAt(notes, 0).length, 1);
  assert.equal(removeNoteAt(notes, 0)[0].midi, 62);
  assert.deepEqual(removeNoteAt(notes, 5), notes);
  const updated = updateNoteAt(notes, 0, { midi: 72, duration: 960 });
  assert.equal(updated[0].midi, 72);
  assert.equal(updated[0].duration, 960);
  assert.equal(updated[0].ticks, 0);
});

test('moveNoteAt / resizeNoteAt はクランプする', () => {
  const notes = [createNote(60, 480, 240)];
  const moved = moveNoteAt(notes, 0, -1000, 100);
  assert.equal(moved[0].ticks, 0);
  assert.equal(moved[0].midi, MAX_MIDI);
  const resized = resizeNoteAt(notes, 0, -9999);
  assert.equal(resized[0].duration, MIN_NOTE_TICKS);
});

test('transposeNotes は範囲内にクランプする', () => {
  const notes = [createNote(60, 0, 480), createNote(125, 0, 480)];
  const up = transposeNotes(notes, 12);
  assert.equal(up[0].midi, 72);
  assert.equal(up[1].midi, 127);
  assert.equal(notes[0].midi, 60);
});

test('hitTestNote は同じ音高の時刻を含む音符を返す', () => {
  const notes = [createNote(60, 0, 480), createNote(60, 480, 480)];
  assert.equal(hitTestNote(notes, 60, 100), 0);
  assert.equal(hitTestNote(notes, 60, 480), 1);
  assert.equal(hitTestNote(notes, 60, 960), -1);
  assert.equal(hitTestNote(notes, 62, 100), -1);
});

test('notesExtent は空なら fallback を返す', () => {
  const fallback = { minMidi: 48, maxMidi: 72, maxTick: 1920 };
  assert.deepEqual(notesExtent([], fallback), fallback);
  const extent = notesExtent([createNote(40, 0, 100), createNote(80, 200, 300)]);
  assert.deepEqual(extent, { minMidi: 40, maxMidi: 80, maxTick: 500 });
});

test('quantizeTick は最寄りのグリッドへ丸める', () => {
  assert.equal(quantizeTick(100, 120), 120);
  assert.equal(quantizeTick(100, 60), 120);
  assert.equal(quantizeTick(100, 0), 100);
  assert.equal(quantizeTick(-5, 120), 0);
});

/* ==========================================================
   時間 / 再生
   ========================================================== */

test('ticksToSeconds / secondsToTicks は bpm を反映する', () => {
  assert.equal(ticksToSeconds(480, 480, 120), 0.5);
  assert.equal(ticksToSeconds(480, 480, 60), 1);
  assert.equal(secondsToTicks(0.5, 480, 120), 480);
  assert.equal(ticksToSeconds(480, 0, 120), 0.5);
  assert.equal(secondsToTicks(1, 480, 0), 960);
});

test('buildMidiEvents は同時刻の note off を先に置く', () => {
  const events = buildMidiEvents([createNote(60, 0, 480), createNote(62, 480, 480)]);
  assert.deepEqual(
    events.map((e) => [e.tick, e.type, e.midi]),
    [
      [0, 'on', 60],
      [480, 'off', 60],
      [480, 'on', 62],
      [960, 'off', 62],
    ],
  );
});

test('toPlaybackNotes は秒単位の start / duration を持つ', () => {
  const notes = [createNote(60, 480, 480, 100)];
  const [p] = toPlaybackNotes(notes, 480, 120);
  assert.equal(p.midi, 60);
  assert.equal(p.velocity, 100);
  assert.equal(p.start, 0.5);
  assert.equal(p.duration, 0.5);
});

test('formatTime は m:ss.t 表記', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(61.25), '1:01.2');
  assert.equal(formatTime(-1), '0:00.0');
  assert.equal(formatTime(NaN), '0:00.0');
});

/* ==========================================================
   ピアノロール座標
   ========================================================== */

test('rowYForMidi / midiRowAt は逆変換になる', () => {
  const view = { topMidi: 84, rowHeight: 14, offsetY: 24 };
  assert.equal(rowYForMidi(84, view), 24);
  assert.equal(rowYForMidi(83, view), 38);
  assert.equal(midiRowAt(24, view), 84);
  assert.equal(midiRowAt(37, view), 84);
  assert.equal(midiRowAt(38, view), 83);
});

test('tickX / tickAtX は逆変換になる', () => {
  const view = { pxPerTick: 0.15, offsetX: 56 };
  assert.equal(tickX(0, view), 56);
  assert.ok(Math.abs(tickAtX(tickX(960, view), view) - 960) < 1e-9);
});

/* ==========================================================
   VLQ
   ========================================================== */

test('encodeVlq は仕様どおりのバイト列を返す', () => {
  assert.deepEqual(encodeVlq(0), [0x00]);
  assert.deepEqual(encodeVlq(0x7f), [0x7f]);
  assert.deepEqual(encodeVlq(0x80), [0x81, 0x00]);
  assert.deepEqual(encodeVlq(0x2000), [0xc0, 0x00]);
  assert.deepEqual(encodeVlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
  assert.throws(() => encodeVlq(-1), /0 以上/);
  assert.throws(() => encodeVlq(1.5), /0 以上/);
});

test('decodeVlq は encodeVlq の逆変換になる', () => {
  for (const value of [0, 1, 127, 128, 480, 1000, 0x1fffff, 0x0fffffff]) {
    const bytes = new Uint8Array(encodeVlq(value));
    const out = decodeVlq(bytes, 0);
    assert.equal(out.value, value);
    assert.equal(out.offset, bytes.length);
  }
  assert.throws(() => decodeVlq(new Uint8Array([0x81]), 0), /途中で終了/);
});

/* ==========================================================
   MIDI 入出力
   ========================================================== */

function sampleProject() {
  return createProject({
    name: 'Demo',
    ppq: 480,
    bpm: 100,
    tracks: [
      createTrack({
        name: 'Piano',
        channel: 0,
        program: 5,
        notes: [createNote(60, 0, 480, 100), createNote(64, 480, 240, 90)],
      }),
      createTrack({
        name: 'Bass',
        channel: 1,
        program: 33,
        notes: [createNote(36, 0, 960, 80)],
      }),
    ],
  });
}

test('writeMidi は MThd で始まり SMF のヘッダを持つ', () => {
  const bytes = writeMidi(sampleProject());
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'MThd');
  assert.equal(bytes[4], 0x00);
  assert.equal(bytes[5], 0x00);
  assert.equal(bytes[6], 0x00);
  assert.equal(bytes[7], 0x06);
  // format = 1（複数トラック）
  assert.equal(bytes[8], 0x00);
  assert.equal(bytes[9], 0x01);
  // ntracks = 2
  assert.equal(bytes[10], 0x00);
  assert.equal(bytes[11], 0x02);
  // division = 480
  assert.equal((bytes[12] << 8) | bytes[13], 480);
  // 各トラックチャンク
  assert.equal(String.fromCharCode(...bytes.subarray(14, 18)), 'MTrk');
});

test('parseMidi は writeMidi の出力を往復できる', () => {
  const project = sampleProject();
  const parsed = parseMidi(writeMidi(project));
  assert.equal(parsed.ppq, 480);
  assert.equal(parsed.bpm, 100);
  assert.equal(parsed.name, 'Piano');
  assert.equal(parsed.tracks.length, 2);
  assert.equal(parsed.tracks[0].name, 'Piano');
  assert.equal(parsed.tracks[0].channel, 0);
  assert.equal(parsed.tracks[0].program, 5);
  assert.equal(parsed.tracks[1].channel, 1);
  assert.equal(parsed.tracks[1].program, 33);
  assert.deepEqual(
    parsed.tracks[0].notes.map((n) => [n.midi, n.ticks, n.duration, n.velocity]),
    [
      [60, 0, 480, 100],
      [64, 480, 240, 90],
    ],
  );
  assert.deepEqual(parsed.tracks[1].notes.map((n) => [n.midi, n.ticks, n.duration]), [[36, 0, 960]]);
});

test('parseMidi は手組みの note on/off と running status を読む', () => {
  // MThd (format 0, 1 track, ppq 96)
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
  ];
  // track: [delta, event] ...
  const body = [
    0x00, 0xb0, 0x07, 0x64, // CC7 volume 100
    0x00, 0x90, 0x3c, 0x50, // note on C4 vel 80
    0x60, 0x3c, 0x00, // running status note on vel 0 (off) delta 96
    0x00, 0xff, 0x2f, 0x00, // end of track
  ];
  const track = [0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, body.length, ...body];
  const parsed = parseMidi(new Uint8Array([...header, ...track]));
  assert.equal(parsed.ppq, 96);
  assert.equal(parsed.tracks.length, 1);
  assert.deepEqual(parsed.tracks[0].notes.map((n) => [n.midi, n.ticks, n.duration, n.velocity]), [
    [60, 0, 96, 80],
  ]);
});

test('parseMidi は壊れた入力で例外を投げる', () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3])), /MThd/);
  assert.throws(() => parseMidi(new Uint8Array([])), /MThd/);
  assert.throws(() => parseMidi('not bytes'), /Uint8Array/);
  // SMPTE division
  const smpte = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe2, 0x50,
  ]);
  assert.throws(() => parseMidi(smpte), /SMPTE/);
});

test('writeMidi はノート 0 個でもトラックを書く', () => {
  const bytes = writeMidi(createProject({ name: 'Empty' }));
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'MThd');
  const parsed = parseMidi(bytes);
  assert.equal(parsed.tracks.length, 1);
  assert.deepEqual(parsed.tracks[0].notes, []);
  // project.name は最初のトラック名から復元される
  assert.equal(parsed.name, 'Piano');
});

test('parseMidi は閉じられない note on を最小長で確定する', () => {
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
  ];
  const body = [0x00, 0x90, 0x3c, 0x50, 0x00, 0xff, 0x2f, 0x00];
  const track = [0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, body.length, ...body];
  const parsed = parseMidi(new Uint8Array([...header, ...track]));
  assert.equal(parsed.tracks[0].notes[0].midi, 60);
  assert.equal(parsed.tracks[0].notes[0].duration, MIN_NOTE_TICKS);
});

/* ==========================================================
   ファイル名 / 表示
   ========================================================== */

test('isSupportedMidiFile は拡張子で判定する', () => {
  assert.equal(isSupportedMidiFile({ name: 'song.mid' }), true);
  assert.equal(isSupportedMidiFile({ name: 'SONG.MIDI' }), true);
  assert.equal(isSupportedMidiFile('a/b/take.mid'), true);
  assert.equal(isSupportedMidiFile({ name: 'song.mp3' }), false);
  assert.equal(isSupportedMidiFile(null), false);
});

test('sanitizeBaseName / buildMidiFileName', () => {
  assert.equal(sanitizeBaseName('/a/b/my song.mid'), 'my_song');
  assert.equal(sanitizeBaseName('テイク1.midi'), 'midi');
  assert.equal(sanitizeBaseName(''), 'midi');
  assert.equal(sanitizeBaseName(undefined), 'midi');
  assert.equal(buildMidiFileName('my song.mid'), 'my_song.mid');
  assert.equal(buildMidiFileName('demo'), 'demo.mid');
});

test('formatBytes は 1024 基準', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
  assert.equal(formatBytes(NaN), '-');
});
