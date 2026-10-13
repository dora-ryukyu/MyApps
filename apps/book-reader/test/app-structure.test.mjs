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

test('meta.json はディレクトリ名と一致し、必須キーと net を持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags', 'net']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'book-open');
  assert.equal(meta.color, '#0d9488');
  assert.equal(meta.net, 'none');
  assert.match(meta.netDescription, /送信なし/);
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 30, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg は meta.json の color を使う', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコン book-open は DESIGN.md の 4 箇所すべてに登録されている', () => {
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes("'book-open'"), 'shared/header.js にアイコンが無い');
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes("'book-open'"), 'hub/script.js にアイコンが無い');
  assert.ok(read('favicon.svg').includes('M12 7v14'), 'favicon が book-open のパスを使っていない');
  assert.equal(meta.icon, 'book-open');
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes('data-app-icon="book-open"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'buildBookKey',
    'sortCbzPages',
    'normalizeToc',
    'serializeReadingState',
    'deserializeReadingState',
    'normalizeSettings',
    'buildReaderCss',
    'progressPercent',
    'buildCbzPageLabel',
  ]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(scriptJs), `${name} が使われていない`);
  }
});

test('pipeline.mjs は必要な純ロジックをエクスポートする', () => {
  const required = [
    'STATE_VERSION',
    'DEFAULT_SETTINGS',
    'isSupportedBookFile',
    'detectFormat',
    'isImageEntry',
    'naturalCompare',
    'sortCbzPages',
    'clampIndex',
    'nextIndex',
    'prevIndex',
    'progressPercent',
    'overallFraction',
    'buildCbzPageLabel',
    'normalizeToc',
    'resolveRelativePath',
    'findTocIndex',
    'buildBookKey',
    'normalizeReadingState',
    'serializeReadingState',
    'deserializeReadingState',
    'isSameReadingState',
    'readingPositionLabel',
    'normalizeSettings',
    'buildReaderCss',
    'formatBytes',
    'formatPercent',
    'buildHighlightsFileName',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export (function|const) ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('EPUB は foliate-js、CBZ は zip.js をコミット/版固定で読む', () => {
  assert.ok(scriptJs.includes('cdn.jsdelivr.net/gh/johnfactotum/foliate-js@'));
  assert.ok(scriptJs.includes('/view.js'));
  assert.ok(scriptJs.includes('/overlayer.js'));
  assert.ok(scriptJs.includes('cdn.jsdelivr.net/npm/@zip.js/zip.js@2.23.0'));
  assert.ok(scriptJs.includes('FOLIATE_COMMIT'));
  assert.match(scriptJs, /[0-9a-f]{40}/, 'foliate-js のコミットが固定されていない');
  assert.ok(scriptJs.includes("configure({ useWebWorkers: false })"));
});

test('ファイル・本文は送信しない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(scriptJs, /navigator\.geolocation/);
});

test('index.html はローカル資産だけを参照する', () => {
  const external = [...indexHtml.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, [], `外部 URL を直接参照している: ${external.join(', ')}`);
});

test('script.js / index.html は読書位置としおり・ハイライトを保存する', () => {
  assert.ok(scriptJs.includes('localStorage'));
  assert.ok(scriptJs.includes('bookState.bookmarks'));
  assert.ok(scriptJs.includes('bookState.highlights'));
  assert.ok(scriptJs.includes('create-overlay'));
  assert.ok(scriptJs.includes('draw-annotation'));
  assert.ok(scriptJs.includes('selectionchange'));
  assert.ok(indexHtml.includes('id="progress-bar"'));
  assert.ok(indexHtml.includes('id="marks-list"'));
});

test('style.css はアクセント色とテーマを持つ', () => {
  assert.ok(styleCss.includes(meta.color));
  assert.ok(styleCss.includes("data-reader-theme='sepia'"));
  assert.ok(styleCss.includes("data-reader-theme='dark'"));
  assert.ok(styleCss.includes('var(--c-'));
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

test('registry.json (生成物) があれば book-reader を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('book-reader'), 'registry.json に book-reader が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
