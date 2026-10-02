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
const workerJs = read('worker.js');
const pipelineJs = read('pipeline.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'film');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 25, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリストに沿って 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'film');
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
  assert.ok(indexHtml.includes('data-app-icon="film"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'normalizeTrim',
    'sampleFrameTimes',
    'estimateFrameCount',
    'computeOutputSize',
    'formatBytes',
    'buildGifFileName',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('worker.js は pipeline.mjs の encodeGif を呼ぶ', () => {
  assert.ok(workerJs.includes("from './pipeline.mjs'"));
  assert.ok(workerJs.includes('encodeGif'));
  assert.ok(workerJs.includes("message.type !== 'encode'"));
  assert.ok(workerJs.includes("'done'"));
  assert.ok(workerJs.includes('result.bytes.buffer'));
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'clampTime',
    'normalizeTrim',
    'formatTimecode',
    'estimateFrameCount',
    'sampleFrameTimes',
    'computeDelays',
    'maxFramesForMemory',
    'computeOutputSize',
    'formatBytes',
    'buildGifFileName',
    'buildPalette',
    'buildPaletteLut',
    'mapFrameToIndices',
    'diffFrames',
    'lzwEncode',
    'lzwDecode',
    'encodeGif',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
  assert.ok(pipelineJs.includes('GIF89a'), 'GIF ヘッダが無い');
  assert.ok(pipelineJs.includes('NETSCAPE2.0'), 'ループ拡張が無い');
});

test('script.js は動画デコードと Worker を使う', () => {
  assert.ok(indexHtml.includes('<video id="video"'));
  assert.match(indexHtml, /accept="video\/\*/, '動画の accept が無い');
  assert.ok(scriptJs.includes('drawImage'), 'Canvas への描画が無い');
  assert.ok(scriptJs.includes('getImageData'), 'フレーム取得が無い');
  assert.ok(scriptJs.includes('requestVideoFrameCallback'));
  assert.ok(scriptJs.includes('currentTime'), 'シークが無い');
  assert.ok(scriptJs.includes("new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })"));
});

test('script.js は上部にタイムライン Canvas とカット操作を持つ', () => {
  assert.ok(indexHtml.includes('<canvas id="timeline-canvas"'));
  assert.ok(scriptJs.includes('pointerdown'));
  assert.ok(scriptJs.includes('setIn'));
  assert.ok(scriptJs.includes('setOut'));
  assert.ok(indexHtml.includes('id="set-in-btn"'));
  assert.ok(indexHtml.includes('id="set-out-btn"'));
  assert.ok(indexHtml.includes('id="fps-range"'));
  assert.ok(indexHtml.includes('id="size-select"'));
});

test('GIF の書き出しは Blob / createObjectURL / download を使う', () => {
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(workerJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!fonts\.googleapis\.com|www\.w3\.org)/, '外部 URL を参照している');
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.drop-zone'));
  assert.ok(styleCss.includes('.timeline-wrap'));
  assert.ok(styleCss.includes('#timeline-canvas'));
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
  for (const source of [scriptJs, workerJs]) {
    for (const spec of [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
      assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
    }
  }
});

test('registry.json (生成物) があれば video-to-gif を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('video-to-gif'), 'registry.json に video-to-gif が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
