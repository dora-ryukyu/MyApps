import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const rootDir = resolve(appDir, '..', '..');

function read(relative) {
  return readFileSync(resolve(appDir, relative), 'utf8');
}

const indexHtml = read('index.html');
const scriptJs = read('script.js');
const libraryJs = read('library.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'music');
});

test('meta.json は「送信なし」を宣言している', () => {
  assert.match(meta.net, /送信なし/);
  assert.match(meta.net, /音源/);
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 40, `DOM 参照が少なすぎる (${referenced.size})`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリスト 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'music');
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes(`'${meta.icon}'`), 'shared/header.js にアイコンが無い');
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes(`'${meta.icon}'`), 'hub/script.js にアイコンが無い');
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes('data-app-icon="music"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は library.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './library.mjs'"));
  for (const name of [
    'normalizeTrack',
    'searchTracks',
    'sortTracks',
    'summarizeLibrary',
    'diffTags',
    'buildId3FramePlan',
    'formatM3U',
    'parseM3U',
    'matchM3UEntries',
    'buildTrackFileName',
    'serializeLibrary',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('library.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'clamp',
    'toFiniteNumber',
    'normalizeText',
    'uniqueStrings',
    'firstString',
    'extensionOf',
    'baseFileName',
    'fileStem',
    'isAudioFileName',
    'isWritableFileName',
    'formatBytes',
    'formatDuration',
    'parseDuration',
    'formatBitrate',
    'formatSampleRate',
    'formatTrackNo',
    'sanitizeFileName',
    'normalizeGenres',
    'normalizeArtists',
    'normalizeTrack',
    'makeTrackId',
    'mergeTrack',
    'trackDisplayName',
    'trackSearchText',
    'matchesQuery',
    'searchTracks',
    'compareTracks',
    'sortTracks',
    'groupTracks',
    'summarizeLibrary',
    'diffTags',
    'buildId3FramePlan',
    'formatPattern',
    'buildTrackFileName',
    'createPlaylist',
    'addToPlaylist',
    'removeFromPlaylist',
    'moveInPlaylist',
    'resolvePlaylist',
    'playlistStats',
    'playlistFromTracks',
    'buildPlaylistFileName',
    'formatM3U',
    'formatM3UFromTracks',
    'parseM3U',
    'matchM3UEntries',
    'serializeTrack',
    'deserializeTrack',
    'serializeLibrary',
    'deserializeLibrary',
    'serializePlaylists',
    'deserializePlaylists',
  ];
  for (const name of required) {
    assert.match(libraryJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
  assert.ok(libraryJs.includes('AUDIO_EXTENSIONS'), 'AUDIO_EXTENSIONS が無い');
  assert.ok(libraryJs.includes('WRITABLE_EXTENSIONS'), 'WRITABLE_EXTENSIONS が無い');
  assert.ok(libraryJs.includes('TAG_FIELDS'), 'TAG_FIELDS が無い');
  assert.ok(libraryJs.includes('#EXTM3U'), 'M3U ヘッダが無い');
});

test('script.js は music-metadata と browser-id3-writer を動的 import する', () => {
  assert.ok(scriptJs.includes('music-metadata@12.2.0'), 'music-metadata の CDN が無い');
  assert.ok(scriptJs.includes('browser-id3-writer@6.4.0'), 'browser-id3-writer の CDN が無い');
  assert.ok(scriptJs.includes('await import('), '動的 import が無い');
  assert.ok(scriptJs.includes('parseBlob'), 'parseBlob を使っていない');
  assert.ok(scriptJs.includes('ID3Writer'), 'ID3Writer を使っていない');
  assert.ok(scriptJs.includes('setFrame'), 'setFrame を使っていない');
  assert.ok(scriptJs.includes('addTag'), 'addTag を使っていない');
  assert.ok(scriptJs.includes('getBlob'), 'getBlob を使っていない');
});

test('script.js はフォルダ走査 (File System Access / webkitdirectory) を持つ', () => {
  assert.ok(scriptJs.includes('showDirectoryPicker'), 'showDirectoryPicker が無い');
  assert.ok(scriptJs.includes('createWritable'), 'createWritable が無い (上書き保存)');
  assert.ok(scriptJs.includes('getFile'), 'getFile が無い');
  assert.ok(scriptJs.includes('handle.kind'), '再帰走査が無い');
  assert.ok(indexHtml.includes('webkitdirectory'), 'webkitdirectory フォールバックが無い');
  assert.ok(indexHtml.includes('id="files-input"'));
});

test('script.js は Web Audio と連続再生・シークを持つ', () => {
  assert.ok(scriptJs.includes('AudioContext'), 'Web Audio が無い');
  assert.ok(scriptJs.includes('createMediaElementSource'), 'MediaElementSource が無い');
  assert.ok(scriptJs.includes('createGain'), 'GainNode が無い');
  assert.ok(scriptJs.includes("addEventListener('ended'"), '連続再生が無い');
  assert.ok(scriptJs.includes('currentTime'), 'シークが無い');
  assert.ok(indexHtml.includes('<audio id="audio"'));
  assert.ok(indexHtml.includes('id="seek-range"'));
});

test('script.js は IndexedDB にライブラリとプレイリストを保存する', () => {
  assert.ok(scriptJs.includes('indexedDB.open'), 'IndexedDB を開いていない');
  assert.ok(scriptJs.includes('serializeLibrary'), 'ライブラリを保存していない');
  assert.ok(scriptJs.includes('serializePlaylists'), 'プレイリストを保存していない');
});

test('M3U / M3U8 の入出力がある', () => {
  assert.ok(indexHtml.includes('id="m3u-export-btn"'));
  assert.ok(indexHtml.includes('id="m3u8-export-btn"'));
  assert.ok(indexHtml.includes('id="m3u-input"'));
  assert.ok(scriptJs.includes('formatM3U'));
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  // HTML から外部 URL を読み込まない（CDN の import は module JS 内でのみ行う）
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!fonts\.googleapis\.com|www\.w3\.org)/, 'index.html が外部 URL を参照している');
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.track-table'));
  assert.ok(styleCss.includes('.player-bar'));
  assert.ok(styleCss.includes('.playlist-item'));
  assert.ok(!/transition:\s*all/.test(styleCss), 'transition: all を使っている');
});

test('index.html が参照するローカル資産はすべて存在する', () => {
  const refs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:') && !u.startsWith('#'));
  assert.ok(refs.length >= 4);
  for (const ref of refs) {
    assert.ok(existsSync(resolve(appDir, ref)), `存在しない参照: ${ref}`);
  }
});

test('JS の相対 import の参照先は存在する', () => {
  for (const spec of [...scriptJs.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
    assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
  }
});

test('registry.json (生成物) があれば music-library を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('music-library'), 'registry.json に music-library が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
