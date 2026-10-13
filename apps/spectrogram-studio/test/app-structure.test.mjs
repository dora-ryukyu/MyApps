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
  assert.equal(meta.icon, 'audio-waveform');
  assert.equal(meta.color, '#0891b2');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 30, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリストに沿って 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'audio-waveform');
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
  assert.ok(indexHtml.includes('data-app-icon="audio-waveform"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'mixToMono',
    'spectrumSlice',
    'findPeaks',
    'buildSpectrogramImage',
    'sliceToCsv',
    'peaksToCsv',
    'binToHz',
    'formatHz',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('worker.js は pipeline.mjs の computeStft を呼ぶ', () => {
  assert.ok(workerJs.includes("from './pipeline.mjs'"));
  assert.ok(workerJs.includes('computeStft'));
  assert.ok(workerJs.includes("message.type !== 'analyze'"));
  assert.ok(workerJs.includes("'done'"));
  assert.ok(workerJs.includes('result.db.buffer'));
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'clamp',
    'clamp01',
    'nextPowerOfTwo',
    'isPowerOfTwo',
    'formatHz',
    'formatDb',
    'formatSeconds',
    'formatBytes',
    'mixToMono',
    'trimToSeconds',
    'buildWindow',
    'windowSum',
    'fft',
    'magnitudeSpectrum',
    'amplitudeToDb',
    'powerToDb',
    'dbToAmplitude',
    'binToHz',
    'hzToBin',
    'frequencyTable',
    'freqToNormalized',
    'normalizedToFreq',
    'planStft',
    'computeStft',
    'spectrumSlice',
    'averageSpectrum',
    'findPeaks',
    'sampleColormap',
    'dbToColor',
    'buildSpectrogramImage',
    'sliceToCsv',
    'peaksToCsv',
    'estimateMemoryBytes',
    'buildFileName',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('script.js は音声入力 (decodeAudioData / getUserMedia / AnalyserNode) を使う', () => {
  assert.match(indexHtml, /accept="audio\/\*/, '音声の accept が無い');
  assert.ok(scriptJs.includes('AudioContext'));
  assert.ok(scriptJs.includes('decodeAudioData'));
  assert.ok(scriptJs.includes('getUserMedia'));
  assert.ok(scriptJs.includes('createAnalyser'));
  assert.ok(scriptJs.includes('getFloatFrequencyData'));
  assert.ok(scriptJs.includes('new Worker(new URL(\'./worker.js\', import.meta.url)'));
});

test('script.js はスペクトログラムと断面を Canvas に描く', () => {
  assert.ok(indexHtml.includes('<canvas id="spectrogram-canvas"'));
  assert.ok(indexHtml.includes('<canvas id="slice-canvas"'));
  assert.ok(scriptJs.includes("getContext('2d')"));
  assert.ok(scriptJs.includes('putImageData'));
  assert.ok(scriptJs.includes('createImageData'));
  assert.ok(scriptJs.includes('requestAnimationFrame'));
});

test('書き出しは Blob / createObjectURL / download / toBlob を使う', () => {
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
  assert.ok(scriptJs.includes('toBlob'));
});

test('音声は送信されない (fetch / XHR / sendBeacon を使わない)', () => {
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
  assert.ok(styleCss.includes('.spectrogram-wrap'));
  assert.ok(styleCss.includes('#spectrogram-canvas'));
  assert.ok(styleCss.includes('.slice-wrap'));
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

test('registry.json (生成物) があれば spectrogram-studio を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('spectrogram-studio'), 'registry.json に spectrogram-studio が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
