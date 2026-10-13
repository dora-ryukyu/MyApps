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
  assert.equal(meta.icon, 'copy');
});

test('meta.json は送信なし (net) を宣言している', () => {
  assert.ok(typeof meta.net === 'string' && meta.net.length > 0, 'net の宣言がありません');
  assert.match(meta.net, /送信なし/);
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 20, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリストに沿って 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'copy');
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
  assert.ok(indexHtml.includes('data-app-icon="copy"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('フォルダ選択は webkitdirectory と File System Access の両方に対応する', () => {
  assert.match(indexHtml, /id="folder-input"[^>]*webkitdirectory/);
  assert.ok(scriptJs.includes('showDirectoryPicker'));
  assert.ok(scriptJs.includes('webkitRelativePath'));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'chunkRanges',
    'groupCandidates',
    'groupExact',
    'clusterBySimilarity',
    'sha256Hex',
    'dHash',
    'planMoves',
    'buildReport',
    'groupsToJSON',
    'groupsFromJSON',
    'rowsToCSV',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('画像は createImageBitmap + Canvas で dHash を計算する', () => {
  assert.ok(scriptJs.includes('createImageBitmap'));
  assert.ok(scriptJs.includes('getContext'));
  assert.ok(scriptJs.includes('getImageData'));
  assert.ok(scriptJs.includes('computeImageHash'));
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'isImageName',
    'isImageFile',
    'formatBytes',
    'shortenPath',
    'uniqueName',
    'hexEncode',
    'sha256Hex',
    'chunkRanges',
    'candidateKey',
    'groupCandidates',
    'groupExact',
    'grayFromRGBA',
    'resampleGray',
    'dHash',
    'hammingDistance',
    'similarityPercent',
    'isSimilar',
    'clusterBySimilarity',
    'defaultKeepId',
    'summarizeGroups',
    'planMoves',
    'buildReport',
    'groupsToJSON',
    'groupsFromJSON',
    'reportToRows',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export (async )?function ${name}\\b`), `${name} が未エクスポート`);
  }
  assert.ok(pipelineJs.includes("crypto.subtle.digest"), 'SubtleCrypto を使っていない');
  assert.ok(pipelineJs.includes("'SHA-256'"), 'SHA-256 を使っていない');
});

test('走査はチャンク絞り込み → 完全ハッシュ → 類似の順で行う', () => {
  assert.ok(scriptJs.indexOf('groupCandidates') < scriptJs.indexOf('groupExact'));
  assert.ok(scriptJs.includes('arrayBuffer'));
  assert.ok(scriptJs.includes('groupCandidates(chunked)'));
});

test('整理は非破壊で、削除機能を持たない', () => {
  assert.ok(scriptJs.includes('removeEntry'), '移動 (コピー後に元を除去) が無い');
  assert.ok(scriptJs.includes('createWritable'));
  assert.ok(!scriptJs.includes('deleteFile'), '削除 API を持っている');
  assert.match(indexHtml, /削除はしません/);
});

test('レポートは Blob / createObjectURL / download で書き出す', () => {
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
  assert.ok(indexHtml.includes('id="report-json-btn"'));
  assert.ok(indexHtml.includes('id="report-csv-btn"'));
  assert.ok(indexHtml.includes('id="restore-input"'));
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(pipelineJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!fonts\.googleapis\.com|www\.w3\.org)/, '外部 URL を参照している');
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.group-card'));
  assert.ok(styleCss.includes('.file-row'));
  assert.ok(styleCss.includes('.stats-grid'));
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

test('registry.json (生成物) があれば duplicate-finder を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('duplicate-finder'), 'registry.json に duplicate-finder が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
