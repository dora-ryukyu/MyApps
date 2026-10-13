import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_EXTENSIONS,
  DEFAULT_FILE_PATTERN,
  LIBRARY_SCHEMA_VERSION,
  TAG_FIELDS,
  WRITABLE_EXTENSIONS,
  addToPlaylist,
  baseFileName,
  buildId3FramePlan,
  buildPlaylistFileName,
  buildTrackFileName,
  clamp,
  compareTracks,
  createPlaylist,
  deserializeLibrary,
  deserializePlaylists,
  diffTags,
  extensionOf,
  fileStem,
  firstString,
  formatBitrate,
  formatBytes,
  formatDuration,
  formatM3U,
  formatPattern,
  formatSampleRate,
  formatTrackNo,
  groupTracks,
  isAudioFileName,
  isWritableFileName,
  makeTrackId,
  matchM3UEntries,
  matchesQuery,
  mergeTrack,
  moveInPlaylist,
  normalizeGenres,
  normalizeText,
  normalizeTrack,
  parseDuration,
  parseM3U,
  playlistFromTracks,
  playlistStats,
  removeFromPlaylist,
  resolvePlaylist,
  sanitizeFileName,
  searchTracks,
  serializeLibrary,
  serializePlaylists,
  serializeTrack,
  sortTracks,
  summarizeLibrary,
  toFiniteNumber,
  trackDisplayName,
  trackSearchText,
  uniqueStrings,
} from '../library.mjs';

/* ---------- 汎用ユーティリティ ---------- */

test('clamp / toFiniteNumber は数値と NaN を安全に扱う', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp('x', 2, 3), 2);
  assert.equal(toFiniteNumber('12'), 12);
  assert.equal(toFiniteNumber('nope', 7), 7);
  assert.equal(toFiniteNumber(null, null), null);
});

test('normalizeText は NFKC・小文字化・空白圧縮を行う', () => {
  assert.equal(normalizeText('  Ｈｅｌｌｏ   WORLD '), 'hello world');
  assert.equal(normalizeText(null), '');
});

test('uniqueStrings は空文字と重複を除く', () => {
  assert.deepEqual(uniqueStrings(['a', 'a', '', ' b ']), ['a', 'b']);
  assert.deepEqual(uniqueStrings(null), []);
});

test('firstString は配列/文字列の最初の非空を返す', () => {
  assert.equal(firstString(['', 'x', 'y']), 'x');
  assert.equal(firstString('  z '), 'z');
  assert.equal(firstString(['', '']), '');
  assert.equal(firstString(undefined), '');
});

/* ---------- ファイル名 / フォーマット ---------- */

test('extensionOf / baseFileName / fileStem はパスを分解する', () => {
  assert.equal(baseFileName('a/b/song.MP3'), 'song.MP3');
  assert.equal(baseFileName('a\\b\\song.mp3'), 'song.mp3');
  assert.equal(extensionOf('a/b/song.MP3'), '.mp3');
  assert.equal(extensionOf('noext'), '');
  assert.equal(fileStem('a/b/song.mp3'), 'song');
});

test('isAudioFileName / isWritableFileName は拡張子で判定する', () => {
  assert.ok(isAudioFileName('x.flac'));
  assert.ok(isAudioFileName('x.M4A'));
  assert.ok(!isAudioFileName('x.txt'));
  assert.deepEqual(WRITABLE_EXTENSIONS, ['.mp3']);
  assert.ok(isWritableFileName('a.mp3'));
  assert.ok(!isWritableFileName('a.flac'));
  assert.ok(AUDIO_EXTENSIONS.includes('.opus'));
});

test('formatBytes は桁に応じた単位を返す', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
  assert.equal(formatBytes(-1), '');
});

test('formatDuration は m:ss / h:mm:ss を返す', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(null), '--:--');
});

test('parseDuration は m:ss / 秒数文字列を秒に戻す', () => {
  assert.equal(parseDuration('210'), 210);
  assert.equal(parseDuration('3:30'), 210);
  assert.equal(parseDuration('1:00:00'), 3600);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('a:b'), null);
});

test('formatBitrate / formatSampleRate / formatTrackNo', () => {
  assert.equal(formatBitrate(320000), '320 kbps');
  assert.equal(formatBitrate(0), '');
  assert.equal(formatSampleRate(44100), '44.1 kHz');
  assert.equal(formatSampleRate(48000), '48 kHz');
  assert.equal(formatTrackNo(3, 12), '3/12');
  assert.equal(formatTrackNo(3, null), '3');
  assert.equal(formatTrackNo(null, null), '');
});

test('sanitizeFileName は禁止文字を置換する', () => {
  assert.equal(sanitizeFileName('a/b:c*d?.mp3'), 'a_b_c_d_.mp3');
  assert.equal(sanitizeFileName('  spaced   name '), 'spaced name');
});

/* ---------- タグ正規化 ---------- */

test('normalizeTrack はルーズな入力を canonical な形にする', () => {
  const track = normalizeTrack({
    path: 'album/01 Song.mp3',
    title: 'Song',
    artist: ['A', 'B'],
    genre: 'Rock; Pop',
    track: 1,
    totalTracks: 9,
    duration: 210.4,
    size: 1024,
  });
  assert.equal(track.name, '01 Song.mp3');
  assert.equal(track.ext, '.mp3');
  assert.deepEqual(track.artists, ['A', 'B']);
  assert.equal(track.artist, 'A; B');
  assert.deepEqual(track.genres, ['Rock', 'Pop']);
  assert.equal(track.trackNo, 1);
  assert.equal(track.trackTotal, 9);
  assert.equal(track.id, makeTrackId('album/01 Song.mp3', 1024));
});

test('normalizeGenres は区切り文字で分割し重複を除く', () => {
  assert.deepEqual(normalizeGenres(['Rock;Pop', 'Pop']), ['Rock', 'Pop']);
  assert.deepEqual(normalizeGenres('Jazz'), ['Jazz']);
  assert.deepEqual(normalizeGenres(undefined), []);
});

test('makeTrackId はパスとサイズで安定する', () => {
  assert.equal(makeTrackId('a.mp3', 10), makeTrackId('a.mp3', 10));
  assert.notEqual(makeTrackId('a.mp3', 10), makeTrackId('a.mp3', 11));
});

test('mergeTrack は patch を適用した新しい track を返す', () => {
  const base = normalizeTrack({ path: 'a.mp3', title: 'Old', size: 5 });
  const merged = mergeTrack(base, { title: 'New', artist: 'Someone' });
  assert.equal(merged.title, 'New');
  assert.equal(merged.artist, 'Someone');
  assert.equal(base.title, 'Old', '元を変更してはいけない');
});

test('mergeTrack は artist / genre 文字列で古い派生配列を上書きする', () => {
  const base = normalizeTrack({ path: 'a.mp3', artists: ['A', 'B'], genre: 'Rock', size: 1 });
  const merged = mergeTrack(base, { artist: 'C', genre: 'Jazz' });
  assert.deepEqual(merged.artists, ['C']);
  assert.deepEqual(merged.genres, ['Jazz']);
  assert.equal(merged.artist, 'C');
});

test('serializeTrack はカバー画像などの実行時データを落とす', () => {
  const track = { ...sample[0], coverData: new Uint8Array([1, 2, 3]), coverFormat: 'image/jpeg', coverUrl: 'blob:x', handle: {}, file: {} };
  const saved = serializeTrack(track);
  for (const key of ['coverData', 'coverFormat', 'coverUrl', 'handle', 'file']) {
    assert.ok(!(key in saved), `${key} を保存してはいけない`);
  }
  assert.equal(saved.title, 'Banana');
});

test('trackDisplayName / trackSearchText', () => {
  assert.equal(trackDisplayName({ title: 'T', artist: 'A', name: 'x.mp3' }), 'A - T');
  assert.equal(trackDisplayName({ title: '', artist: '', name: 'x.mp3' }), 'x');
  const text = trackSearchText({ title: 'Hello', artist: 'World', album: 'Z', name: 'a.mp3' });
  assert.ok(text.includes('hello'));
  assert.ok(text.includes('world'));
  assert.ok(text.includes('a.mp3'));
});

/* ---------- 検索 / 並べ替え / 集計 ---------- */

const sample = [
  normalizeTrack({ path: 'b.mp3', title: 'Banana', artist: 'Zoe', album: 'Fruit', year: 2019, track: 2, duration: 200, size: 300, genre: 'Pop' }),
  normalizeTrack({ path: 'a.mp3', title: 'Apple', artist: 'Ann', album: 'Fruit', year: 2021, track: 1, duration: 100, size: 100, genre: 'Rock' }),
  normalizeTrack({ path: 'c.flac', title: 'Cherry', artist: 'Bob', album: 'Berry', year: 2020, track: 3, duration: 300, size: 200, genre: 'Jazz' }),
];

test('matchesQuery は複数トークンの AND 検索を行う', () => {
  assert.ok(matchesQuery(sample[0], 'banana'));
  assert.ok(matchesQuery(sample[0], 'zoe fruit'));
  assert.ok(!matchesQuery(sample[0], 'apple'));
  assert.ok(matchesQuery(sample[0], ''));
});

test('searchTracks は一致する track を返す', () => {
  assert.deepEqual(searchTracks(sample, 'fruit').map((t) => t.title), ['Banana', 'Apple']);
  assert.equal(searchTracks(sample, '').length, 3);
});

test('sortTracks はキーと向きに従い新しい配列を返す', () => {
  assert.deepEqual(sortTracks(sample, 'title').map((t) => t.title), ['Apple', 'Banana', 'Cherry']);
  assert.deepEqual(sortTracks(sample, 'title', 'desc').map((t) => t.title), ['Cherry', 'Banana', 'Apple']);
  assert.deepEqual(sortTracks(sample, 'duration').map((t) => t.duration), [100, 200, 300]);
  assert.deepEqual(sortTracks(sample, 'size', 'desc').map((t) => t.size), [300, 200, 100]);
});

test('compareTracks は欠損数値を末尾へ送る', () => {
  const a = normalizeTrack({ path: 'a.mp3', duration: null });
  const b = normalizeTrack({ path: 'b.mp3', duration: 5 });
  assert.ok(compareTracks(a, b, 'duration') > 0);
  assert.ok(compareTracks(b, a, 'duration') < 0);
});

test('groupTracks はキーごとにまとめる', () => {
  const groups = groupTracks(sample, 'album');
  assert.deepEqual(groups.map((g) => g.key), ['Fruit', 'Berry']);
  assert.equal(groups[0].tracks.length, 2);
});

test('summarizeLibrary は件数・時間・サイズ・集合を集計する', () => {
  const stats = summarizeLibrary(sample);
  assert.equal(stats.count, 3);
  assert.equal(stats.duration, 600);
  assert.equal(stats.size, 600);
  assert.equal(stats.artists, 3);
  assert.equal(stats.albums, 2);
  assert.deepEqual(stats.genres, ['Jazz', 'Pop', 'Rock']);
  assert.deepEqual(stats.formats, ['.flac', '.mp3']);
});

/* ---------- タグ差分 / ID3 フレーム計画 ---------- */

test('diffTags は変更のあったフィールドだけを返す', () => {
  const before = normalizeTrack({ title: 'A', artist: 'X', year: 2020, track: 1 });
  const after = mergeTrack(before, { title: 'B', trackNo: 2 });
  const diff = diffTags(before, after);
  assert.deepEqual(diff.map((d) => d.field).sort(), ['title', 'trackNo']);
  const titleChange = diff.find((d) => d.field === 'title');
  assert.equal(titleChange.before, 'A');
  assert.equal(titleChange.after, 'B');
});

test('diffTags は TAG_FIELDS を対象にし、年を整数文字列にそろえる', () => {
  const before = normalizeTrack({ year: 2020 });
  const after = mergeTrack(before, { year: 2021.9 });
  const diff = diffTags(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].field, 'year');
  assert.equal(diff[0].after, '2021');
  assert.ok(TAG_FIELDS.includes('albumArtist'));
});

test('buildId3FramePlan は空値を除いたフレーム計画を作る', () => {
  const track = normalizeTrack({
    title: 'Song',
    artist: 'A',
    artists: ['A', 'B'],
    album: 'Album',
    track: 3,
    totalTracks: 12,
    disc: 1,
    totalDiscs: 2,
    year: 2021,
    genre: 'Rock',
  });
  const plan = buildId3FramePlan(track);
  const map = Object.fromEntries(plan.map((p) => [p.frame, p.value]));
  assert.deepEqual(map.TPE1, ['A', 'B']);
  assert.equal(map.TIT2, 'Song');
  assert.equal(map.TALB, 'Album');
  assert.equal(map.TRCK, '3/12');
  assert.equal(map.TPOS, '1/2');
  assert.equal(map.TYER, 2021);
  assert.deepEqual(map.TCON, ['Rock']);
  assert.ok(!('COMM' in map), '空コメントは含めない');
});

/* ---------- ファイル名パターン ---------- */

test('formatPattern はトークンを置換し未知トークンは残す', () => {
  const track = normalizeTrack({ title: 'Song', artist: 'Ann', album: 'LP', track: 3, year: 2020, name: 'x.mp3' });
  assert.equal(formatPattern('{track} - {title}', track), '03 - Song');
  assert.equal(formatPattern('{artist}/{album}/{num}', track), 'Ann/LP/3');
  assert.equal(formatPattern('{unknown}', track), '{unknown}');
});

test('formatPattern はタグが無いときフォールバックを使う', () => {
  const track = normalizeTrack({ name: 'my file.mp3' });
  assert.equal(formatPattern('{title}', track), 'my file');
  assert.equal(formatPattern('{artist}', track), 'unknown artist');
  assert.equal(formatPattern('{album}', track), 'unknown album');
});

test('buildTrackFileName は安全な名前と拡張子を作る', () => {
  const track = normalizeTrack({ title: 'A/B', artist: 'Ann', size: 1, name: 'x.mp3' });
  assert.equal(buildTrackFileName(track, '{artist} - {title}'), 'Ann - A_B.mp3');
  assert.equal(buildTrackFileName(track, '{album}/{track} - {title}', '.flac'), 'unknown album/- A_B.flac');
  assert.equal(DEFAULT_FILE_PATTERN, '{track} - {title}');
});

/* ---------- プレイリスト ---------- */

const t1 = normalizeTrack({ path: 'a.mp3', title: 'A', duration: 100, size: 1 });
const t2 = normalizeTrack({ path: 'b.mp3', title: 'B', duration: 200, size: 2 });
const library = [t1, t2];

test('createPlaylist / addToPlaylist / removeFromPlaylist', () => {
  let pl = createPlaylist('My List');
  assert.equal(pl.name, 'My List');
  pl = addToPlaylist(pl, t1.id);
  pl = addToPlaylist(pl, t1.id);
  pl = addToPlaylist(pl, t2.id);
  assert.deepEqual(pl.items, [t1.id, t2.id]);
  pl = removeFromPlaylist(pl, t1.id);
  assert.deepEqual(pl.items, [t2.id]);
});

test('moveInPlaylist は要素を並べ替える', () => {
  const pl = createPlaylist('x', [t1.id, t2.id]);
  const moved = moveInPlaylist(pl, 0, 1);
  assert.deepEqual(moved.items, [t2.id, t1.id]);
  assert.deepEqual(pl.items, [t1.id, t2.id], '元を変更してはいけない');
});

test('resolvePlaylist / playlistStats は存在しない id を飛ばす', () => {
  const pl = createPlaylist('x', [t1.id, 'missing', t2.id]);
  assert.deepEqual(resolvePlaylist(pl, library).map((t) => t.title), ['A', 'B']);
  const stats = playlistStats(pl, library);
  assert.equal(stats.total, 3);
  assert.equal(stats.missing, 1);
  assert.equal(stats.duration, 300);
});

test('playlistFromTracks は全曲を含む', () => {
  const pl = playlistFromTracks('All', library);
  assert.deepEqual(pl.items, [t1.id, t2.id]);
});

test('buildPlaylistFileName は安全なファイル名を作る', () => {
  assert.equal(buildPlaylistFileName('My List'), 'My_List.m3u');
  assert.equal(buildPlaylistFileName('a/b', 'm3u8'), 'a_b.m3u8');
});

/* ---------- M3U / M3U8 ---------- */

test('formatM3U は #EXTM3U / #EXTINF / パスを出力する', () => {
  const pl = createPlaylist('Favs', [t1.id, t2.id]);
  const text = formatM3U(pl, library);
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#PLAYLIST:Favs');
  assert.equal(lines[2], '#EXTINF:100,A');
  assert.equal(lines[3], 'a.mp3');
  assert.ok(text.endsWith('\n'));
});

test('formatM3U は pathOf でパスを差し替えられる', () => {
  const pl = createPlaylist('x', [t1.id]);
  const text = formatM3U(pl, library, { name: 'x', pathOf: () => 'music/a.mp3' });
  assert.ok(text.includes('music/a.mp3'));
});

test('parseM3U は EXTINF とパスを読み取る', () => {
  const text = [
    '#EXTM3U',
    '#PLAYLIST:My',
    '#EXTINF:210,Artist - Title',
    'dir/song.mp3',
    '# comment',
    'plain.flac',
  ].join('\n');
  const parsed = parseM3U(text);
  assert.equal(parsed.name, 'My');
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], { path: 'dir/song.mp3', title: 'Artist - Title', duration: 210 });
  assert.deepEqual(parsed.entries[1], { path: 'plain.flac', title: '', duration: null });
});

test('M3U は往復しても件数とパスが保たれる', () => {
  const pl = createPlaylist('x', [t1.id, t2.id]);
  const text = formatM3U(pl, library);
  const parsed = parseM3U(text);
  assert.deepEqual(parsed.entries.map((e) => e.path), ['a.mp3', 'b.mp3']);
});

test('matchM3UEntries はファイル名の完全一致/語幹一致で track を結ぶ', () => {
  const entries = [
    { path: 'some/dir/a.mp3', title: '', duration: null },
    { path: 'b.mp3', title: '', duration: null },
    { path: 'unknown.mp3', title: '', duration: null },
  ];
  const matched = matchM3UEntries(entries, library);
  assert.equal(matched[0].track?.title, 'A');
  assert.equal(matched[1].track?.title, 'B');
  assert.equal(matched[2].track, null);
});

/* ---------- シリアライズ ---------- */

test('serializeLibrary / deserializeLibrary は往復できる', () => {
  const withRuntime = { ...sample[0], file: {}, handle: {}, __searchText: 'x' };
  const payload = serializeLibrary([withRuntime], '2026-10-13T00:00:00.000Z');
  assert.equal(payload.version, LIBRARY_SCHEMA_VERSION);
  assert.equal(payload.savedAt, '2026-10-13T00:00:00.000Z');
  assert.ok(!('file' in payload.tracks[0]), '実行時フィールドを保存しない');
  assert.ok(!('__searchText' in payload.tracks[0]));
  const restored = deserializeLibrary(payload);
  assert.equal(restored.tracks[0].title, 'Banana');
  assert.equal(restored.tracks[0].path, 'b.mp3');
});

test('deserializeLibrary は不正な入力を空にする', () => {
  assert.deepEqual(deserializeLibrary(null).tracks, []);
  assert.deepEqual(deserializeLibrary({ tracks: 'nope' }).tracks, []);
});

test('serializePlaylists / deserializePlaylists は往復できる', () => {
  const pl = createPlaylist('Favs', [t1.id, t2.id]);
  const payload = serializePlaylists([pl]);
  assert.deepEqual(payload[0].items, [t1.id, t2.id]);
  const restored = deserializePlaylists(payload);
  assert.equal(restored[0].name, 'Favs');
  assert.deepEqual(restored[0].items, [t1.id, t2.id]);
  assert.deepEqual(deserializePlaylists(null), []);
});
