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
  assert.equal(meta.icon, 'images');
});

test('meta.json は送信なし (net) を宣言している', () => {
  assert.ok(meta.net, 'meta.json に net がありません');
  assert.equal(meta.net.sendsData, false);
  assert.ok(Array.isArray(meta.net.hosts), 'net.hosts が配列ではありません');
  assert.ok(meta.net.hosts.includes('cdnjs.cloudflare.com'));
  assert.ok(
    typeof meta.net.note === 'string' && meta.net.note.length > 0,
    'net.note がありません',
  );
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 20, `DOM 参照が少なすぎます: ${referenced.size}`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではありません`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではありません');
});

test('アイコンは DESIGN.md のチェックリストに沿って登録されている', () => {
  assert.equal(meta.icon, 'images');
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
  assert.ok(indexHtml.includes('data-app-icon="images"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('JSZip は SRI + 版固定で読み込む', () => {
  assert.ok(indexHtml.includes('jszip/3.10.1/jszip.min.js'), 'JSZip の版が固定されていない');
  assert.ok(indexHtml.includes('integrity="sha384-'), 'JSZip に SRI が無い');
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'MAX_FILES',
    'formatBytes',
    'formatFromName',
    'mimeFromName',
    'extensionFor',
    'stripExtension',
    'buildJobPlan',
    'clampQuality',
    'summarizeResults',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
  assert.ok(scriptJs.includes('new Worker(new URL('), 'Worker を生成していない');
  assert.ok(scriptJs.includes("compression: 'STORE'"), 'ZIP の圧縮指定が無い');
});

test('worker.js は pipeline.mjs を使い、OffscreenCanvas で再エンコードする', () => {
  assert.ok(workerJs.includes("from './pipeline.mjs'"));
  assert.ok(workerJs.includes('stripJpegMetadata'));
  assert.ok(workerJs.includes('computeWatermarkLayout'));
  assert.ok(workerJs.includes('OffscreenCanvas'));
  assert.ok(workerJs.includes('createImageBitmap'));
  assert.ok(workerJs.includes('convertToBlob'));
  assert.ok(workerJs.includes("'done'"));
  assert.ok(workerJs.includes("'error'"));
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'formatFromName',
    'resolveTargetFormat',
    'extensionFor',
    'mimeFor',
    'computeOutputSize',
    'buildSequentialName',
    'resolveOutputNames',
    'computeWatermarkLayout',
    'normalizeRotation',
    'buildJobPlan',
    'stripJpegMetadata',
    'summarizeResults',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(workerJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(workerJs, /XMLHttpRequest/);
  assert.doesNotMatch(workerJs, /sendBeacon/);
  assert.doesNotMatch(
    indexHtml,
    /https?:\/\/(?!www\.w3\.org|cdnjs\.cloudflare\.com|fonts\.googleapis\.com)/,
    '未許可の外部 URL を参照している',
  );
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.drop-zone'));
  assert.ok(styleCss.includes('.file-grid'));
  assert.ok(!/transition:\s*all/.test(styleCss), 'transition: all を使っている');
});

test('index.html が参照するローカル資産はすべて存在する', () => {
  const refs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:') && !u.startsWith('#'));
  assert.ok(refs.length >= 4, `ローカル参照が少なすぎます: ${refs.length}`);
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

test('registry.json (生成物) があれば image-batch を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('image-batch'), 'registry.json に image-batch が無い');
});
