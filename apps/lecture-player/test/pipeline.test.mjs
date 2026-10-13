import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_PRESETS,
  RATE_MIN,
  RATE_MAX,
  parseTimestamp,
  toSrtTimestamp,
  toVttTimestamp,
  formatClock,
  formatChapterTime,
  formatRate,
  formatBytes,
  computeProgress,
  seekBy,
  nextRate,
  clamp,
  clampTime,
  clampRate,
  fileExtension,
  fileBaseName,
  isSubtitleFile,
  isMediaFile,
  partitionFiles,
  subtitleMatchesMedia,
  findMatchingSubtitle,
  buildExportName,
  detectSubtitleFormat,
  parseSubtitle,
  cuesToVtt,
  srtToVtt,
  findActiveCueIndex,
  findActiveCue,
  normalizeLoop,
  shouldLoopBack,
  normalizeMarker,
  sortMarkers,
  addMarker,
  removeMarker,
  updateMarkerNote,
  serializeMarkers,
  parseMarkers,
  buildNotesMarkdown,
  buildChapters,
  buildChaptersText,
} from '../pipeline.mjs';

/* ==========================================================
   時刻
   ========================================================== */

test('clamp / clampTime / clampRate は範囲に収める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);

  assert.equal(clampTime(-3, 60), 0);
  assert.equal(clampTime(30, 60), 30);
  assert.equal(clampTime(999, 60), 60);
  assert.equal(clampTime(5, Number.NaN), 0);
  assert.equal(clampTime(Number.NaN, 60), 0);

  assert.equal(clampRate(1.5), 1.5);
  assert.equal(clampRate(0.1), RATE_MIN);
  assert.equal(clampRate(9), RATE_MAX);
  assert.equal(clampRate(Number.NaN), 1);
});

test('parseTimestamp は SRT / VTT / 秒の各表記を解釈する', () => {
  assert.equal(parseTimestamp('00:00:05,000'), 5);
  assert.equal(parseTimestamp('00:01:23,456'), 83.456);
  assert.ok(Math.abs(parseTimestamp('01:02:03.500') - 3723.5) < 1e-9);
  assert.equal(parseTimestamp('01:23'), 83);
  assert.ok(Math.abs(parseTimestamp('01:23.456') - 83.456) < 1e-9);
  assert.ok(Math.abs(parseTimestamp('83.25') - 83.25) < 1e-9);
  assert.ok(Math.abs(parseTimestamp('1:02:03,4') - (3723 + 0.4)) < 1e-9);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);
});

test('toSrtTimestamp / toVttTimestamp はミリ秒を丸めて整形する', () => {
  assert.equal(toSrtTimestamp(0), '00:00:00,000');
  assert.equal(toSrtTimestamp(83.456), '00:01:23,456');
  assert.equal(toSrtTimestamp(3661.5), '01:01:01,500');
  assert.equal(toVttTimestamp(83.456), '00:01:23.456');
  assert.equal(toVttTimestamp(-5), '00:00:00.000');
});

test('formatClock / formatChapterTime は用途別に整形する', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(89), '1:29');
  assert.equal(formatClock(3661), '1:01:01');
  assert.equal(formatClock(-4), '0:00');

  assert.equal(formatChapterTime(0), '00:00');
  assert.equal(formatChapterTime(89), '01:29');
  assert.equal(formatChapterTime(3661), '1:01:01');
});

test('formatRate は余分なゼロを落とす', () => {
  assert.equal(formatRate(1), '1x');
  assert.equal(formatRate(1.25), '1.25x');
  assert.equal(formatRate(1.5), '1.5x');
  assert.equal(formatRate(2), '2x');
  assert.equal(formatRate(0), '0.5x');
});

test('formatBytes は単位を切り替える', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
});

test('computeProgress / seekBy / nextRate', () => {
  assert.equal(computeProgress(5, 10), 0.5);
  assert.equal(computeProgress(5, 0), 0);
  assert.equal(computeProgress(20, 10), 1);
  assert.equal(computeProgress(Number.NaN, 10), 0);

  assert.equal(seekBy(10, 5, 100), 15);
  assert.equal(seekBy(10, -20, 100), 0);
  assert.equal(seekBy(98, 5, 100), 100);

  assert.equal(nextRate(1, 1), 1.25);
  assert.equal(nextRate(1, -1), 0.75);
  assert.equal(nextRate(RATE_MAX, 1), RATE_MAX);
  assert.equal(nextRate(RATE_MIN, -1), RATE_MIN);
  assert.equal(nextRate(1.6, 1), 1.75);
  assert.equal(nextRate(1.6, -1), 1.5);
  assert.deepEqual(RATE_PRESETS.slice(0, 2), [0.5, 0.75]);
});

/* ==========================================================
   ファイル
   ========================================================== */

test('fileExtension / fileBaseName', () => {
  assert.equal(fileExtension('lecture.mp4'), '.mp4');
  assert.equal(fileExtension('LECTURE.MKV'), '.mkv');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileExtension('.gitignore'), '');
  assert.equal(fileBaseName('lecture.mp4'), 'lecture');
  assert.equal(fileBaseName('a/b/c/lecture.en.vtt'), 'lecture.en');
  assert.equal(fileBaseName('c:\\videos\\week1.mp4'), 'week1');
  assert.equal(fileBaseName('noext'), 'noext');
});

test('isSubtitleFile / isMediaFile は拡張子で判定する', () => {
  assert.ok(isSubtitleFile('a.vtt'));
  assert.ok(isSubtitleFile('a.SRT'));
  assert.ok(!isSubtitleFile('a.mp4'));
  assert.ok(isMediaFile('a.mp4'));
  assert.ok(isMediaFile('a.mp3'));
  assert.ok(!isMediaFile('a.vtt'));
  assert.ok(!isMediaFile('a.png'));
});

test('partitionFiles はメディアと字幕へ順序を保って振り分ける', () => {
  const { media, subtitles } = partitionFiles([
    'b.mp4',
    'b.vtt',
    'a.mp3',
    'a.srt',
    'cover.png',
  ]);
  assert.deepEqual(media, ['b.mp4', 'a.mp3']);
  assert.deepEqual(subtitles, ['b.vtt', 'a.srt']);
});

test('subtitleMatchesMedia は基底名の一致と接尾辞を受け入れる', () => {
  assert.ok(subtitleMatchesMedia('lecture.mp4', 'lecture.vtt'));
  assert.ok(subtitleMatchesMedia('lecture.mp4', 'lecture.en.vtt'));
  assert.ok(subtitleMatchesMedia('week1.mp4', 'week1.srt'));
  assert.ok(!subtitleMatchesMedia('lecture.mp4', 'other.vtt'));
  assert.ok(!subtitleMatchesMedia('lecture.mp4', 'lecture2.vtt'));
});

test('findMatchingSubtitle は完全一致 → .vtt の順で選ぶ', () => {
  assert.equal(
    findMatchingSubtitle('lecture.mp4', ['lecture.srt', 'lecture.en.vtt']),
    'lecture.srt',
  );
  assert.equal(
    findMatchingSubtitle('lecture.mp4', ['lecture.srt', 'lecture.vtt']),
    'lecture.vtt',
  );
  assert.equal(findMatchingSubtitle('lecture.mp4', ['other.vtt']), null);
  assert.equal(findMatchingSubtitle('lecture.mp4', []), null);
});

test('buildExportName は安全なファイル名を作る', () => {
  assert.equal(buildExportName('lecture.mp4'), 'lecture-notes.md');
  assert.equal(buildExportName('week 1.mp4', 'json', 'markers'), 'week 1-markers.json');
  assert.equal(buildExportName('a/b:c.mp4'), 'b_c-notes.md');
  assert.equal(buildExportName(''), 'lecture-notes.md');
});

/* ==========================================================
   字幕
   ========================================================== */

const SRT_SAMPLE = `1
00:00:01,000 --> 00:00:03,500
こんにちは

2
00:00:03,500 --> 00:00:06,000
これは
テストです
`;

const VTT_SAMPLE = `WEBVTT

NOTE これはコメント

intro
00:00:01.000 --> 00:00:03.500 align:start
こんにちは

00:00:03.500 --> 00:00:06.000
これは
テストです
`;

test('detectSubtitleFormat はヘッダで判定する', () => {
  assert.equal(detectSubtitleFormat(VTT_SAMPLE), 'vtt');
  assert.equal(detectSubtitleFormat(SRT_SAMPLE), 'srt');
  assert.equal(detectSubtitleFormat('\uFEFFWEBVTT\n\n'), 'vtt');
});

test('parseSubtitle は SRT を cue 配列へ変換する', () => {
  const cues = parseSubtitle(SRT_SAMPLE);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, '1');
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[0].text, 'こんにちは');
  assert.equal(cues[1].text, 'これは\nテストです');
});

test('parseSubtitle は VTT のヘッダ・NOTE・設定を読み飛ばす / 保持する', () => {
  const cues = parseSubtitle(VTT_SAMPLE);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, 'intro');
  assert.equal(cues[0].settings, 'align:start');
  assert.equal(cues[1].settings, '');
  assert.equal(cues[1].start, 3.5);
});

test('parseSubtitle は壊れたブロックを無視する', () => {
  const cues = parseSubtitle('1\nnot a timing line\nhello\n\n\n');
  assert.deepEqual(cues, []);
  assert.deepEqual(parseSubtitle(''), []);
});

test('cuesToVtt / srtToVtt は WebVTT を生成する', () => {
  const vtt = srtToVtt(SRT_SAMPLE);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'));
  assert.ok(!vtt.includes(','), 'VTT にカンマが残っている');
  assert.ok(vtt.endsWith('\n'));

  const roundTrip = parseSubtitle(vtt);
  assert.equal(roundTrip.length, 2);
  assert.equal(roundTrip[1].end, 6);

  const fromCues = cuesToVtt([{ start: 0, end: 1, text: 'a', settings: 'line:90%' }]);
  assert.ok(fromCues.includes('00:00:00.000 --> 00:00:01.000 line:90%'));
});

test('findActiveCue は時刻に応じた cue を返す', () => {
  const cues = parseSubtitle(SRT_SAMPLE);
  assert.equal(findActiveCueIndex(cues, 0.5), -1);
  assert.equal(findActiveCueIndex(cues, 2), 0);
  assert.equal(findActiveCueIndex(cues, 3.5), 1);
  assert.equal(findActiveCueIndex(cues, 10), -1);
  assert.equal(findActiveCue(cues, 2).text, 'こんにちは');
  assert.equal(findActiveCue(cues, 0.5), null);
});

/* ==========================================================
   A-B ループ
   ========================================================== */

test('normalizeLoop は有効な区間を返し、短すぎる区間は null', () => {
  assert.deepEqual(normalizeLoop(10, 20, 60), { start: 10, end: 20 });
  assert.equal(normalizeLoop(200, 300, 60), null);
  assert.deepEqual(normalizeLoop(-5, 20, 60), { start: 0, end: 20 });
  assert.equal(normalizeLoop(10, 10.05, 60), null);
  assert.equal(normalizeLoop(0, 0, 0), null);
});

test('shouldLoopBack は B を越えたら true', () => {
  const loop = { start: 10, end: 20 };
  assert.equal(shouldLoopBack(15, loop), false);
  assert.equal(shouldLoopBack(20, loop), true);
  assert.equal(shouldLoopBack(25, loop), true);
  assert.equal(shouldLoopBack(15, null), false);
  assert.equal(shouldLoopBack(Number.NaN, loop), false);
});

/* ==========================================================
   マーカー
   ========================================================== */

test('normalizeMarker は不正な入力を弾く', () => {
  assert.deepEqual(normalizeMarker({ time: 3, note: 'a ' }), { id: '', time: 3, note: 'a' });
  assert.equal(normalizeMarker({ time: -1 }), null);
  assert.equal(normalizeMarker({ time: Number.NaN }), null);
  assert.equal(normalizeMarker(null), null);
});

test('sortMarkers / addMarker / removeMarker / updateMarkerNote', () => {
  let markers = [];
  markers = addMarker(markers, { id: 'b', time: 90, note: 'B' });
  markers = addMarker(markers, { id: 'a', time: 10, note: 'A' });
  markers = addMarker(markers, { id: 'x', time: Number.NaN, note: 'X' });
  assert.deepEqual(markers.map((m) => m.id), ['a', 'b']);

  markers = updateMarkerNote(markers, 'a', 'A!');
  assert.equal(markers[0].note, 'A!');

  markers = removeMarker(markers, 'a');
  assert.deepEqual(markers.map((m) => m.id), ['b']);

  assert.deepEqual(sortMarkers([{ time: 2 }, { time: 1 }]).map((m) => m.time), [1, 2]);
});

test('serializeMarkers / parseMarkers は往復できる', () => {
  const markers = [
    { id: 'z', time: 5.1234, note: 'b' },
    { id: 'y', time: 1, note: 'a' },
  ];
  const json = serializeMarkers(markers);
  const parsed = parseMarkers(json);
  assert.deepEqual(parsed.map((m) => m.time), [1, 5.123]);
  assert.deepEqual(parsed.map((m) => m.note), ['a', 'b']);
  assert.deepEqual(parseMarkers('not json'), []);
  assert.deepEqual(parseMarkers('{"a":1}'), []);
});

test('buildNotesMarkdown は講義ノートを組み立てる', () => {
  const md = buildNotesMarkdown({
    title: '線形代数 第3回',
    source: 'week3.mp4',
    duration: 3661,
    markers: [
      { id: 'a', time: 125, note: '固有値の定義' },
      { id: 'b', time: 30, note: '' },
    ],
  });
  assert.ok(md.startsWith('# 線形代数 第3回'));
  assert.ok(md.includes('`week3.mp4`'));
  assert.ok(md.includes('長さ: 1:01:01'));
  assert.ok(md.includes('マーカー: 2 件'));
  const firstIndex = md.indexOf('**0:30**');
  const secondIndex = md.indexOf('**2:05**');
  assert.ok(firstIndex > -1 && secondIndex > firstIndex, '時刻順に並んでいない');

  const empty = buildNotesMarkdown({ title: 'x' });
  assert.ok(empty.includes('(マーカーはまだありません)'));
});

test('buildChapters / buildChaptersText は先頭の導入を補い整形する', () => {
  const chapters = buildChapters(
    [
      { id: 'a', time: 30, note: '定義' },
      { id: 'b', time: 95, note: '例題' },
    ],
    { intro: 'はじめに' },
  );
  assert.equal(chapters[0].time, 0);
  assert.equal(chapters[0].line, '00:00 はじめに');
  assert.equal(chapters[1].line, '00:30 定義');

  const text = buildChaptersText([{ id: 'a', time: 65, note: 'まとめ' }]);
  assert.ok(text.includes('01:05 まとめ'));

  const noMarkers = buildChapters([]);
  assert.equal(noMarkers.length, 1);
  assert.equal(noMarkers[0].time, 0);
});
