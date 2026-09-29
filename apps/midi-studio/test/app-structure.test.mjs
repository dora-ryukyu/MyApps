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
const pipelineJs = read('pipeline.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'piano');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 15, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリスト 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'piano');
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
  assert.ok(indexHtml.includes('data-app-icon="piano"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  assert.ok(scriptJs.includes('parseMidi'));
  assert.ok(scriptJs.includes('writeMidi'));
  assert.ok(scriptJs.includes('createProject'));
  assert.ok(scriptJs.includes('toPlaybackNotes'));
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'parseMidi',
    'writeMidi',
    'encodeVlq',
    'decodeVlq',
    'midiToName',
    'nameToMidi',
    'isBlackKey',
    'midiToFrequency',
    'keyToMidi',
    'createProject',
    'createTrack',
    'createNote',
    'sortNotes',
    'addNote',
    'removeNoteAt',
    'updateNoteAt',
    'hitTestNote',
    'quantizeTick',
    'ticksToSeconds',
    'secondsToTicks',
    'toPlaybackNotes',
    'buildMidiEvents',
    'isSupportedMidiFile',
    'buildMidiFileName',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('MIDI の読み書きは MThd / MTrk を扱う', () => {
  assert.ok(pipelineJs.includes("'MThd'"));
  assert.ok(pipelineJs.includes("'MTrk'"));
  assert.ok(pipelineJs.includes('0x2f'), 'end of track が無い');
});

test('script.js は Web MIDI / Web Audio / Canvas を使う', () => {
  assert.ok(scriptJs.includes('requestMIDIAccess'), 'Web MIDI 入力が無い');
  assert.ok(scriptJs.includes('onmidimessage'), 'MIDI メッセージ処理が無い');
  assert.ok(scriptJs.includes('AudioContext'), 'Web Audio が無い');
  assert.ok(scriptJs.includes('createOscillator'), '簡易シンセが無い');
  assert.ok(scriptJs.includes("getContext('2d')"), 'Canvas 2D が無い');
});

test('script.js は .mid の入力と書き出しを持つ', () => {
  assert.ok(indexHtml.includes('id="file-input"'));
  assert.ok(indexHtml.includes('accept=".mid'));
  assert.ok(scriptJs.includes('arrayBuffer'));
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!fonts\.googleapis\.com)/, '外部 URL を参照している');
});

test('style.css はテーマトークンとキャンバスを定義する', () => {
  assert.ok(styleCss.includes('.roll-container'));
  assert.ok(styleCss.includes('#roll-canvas'));
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes(meta.color) || styleCss.includes('--app-color'));
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

test('registry.json (生成物) があれば midi-studio を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('midi-studio'), 'registry.json に midi-studio が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
