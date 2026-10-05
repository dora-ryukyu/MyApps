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
  assert.equal(meta.icon, 'scan-eye');
  assert.equal(meta.color, '#0f766e');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 10, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリスト 4 箇所に登録されている', () => {
  assert.equal(meta.icon, 'scan-eye');
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
  assert.ok(indexHtml.includes('data-app-icon="scan-eye"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('index.html は exifr と piexifjs を版固定で読み込む', () => {
  assert.ok(indexHtml.includes('exifr@7.1.3'), 'exifr の版が固定されていない');
  assert.ok(indexHtml.includes('piexifjs@1.0.6'), 'piexifjs の版が固定されていない');
  assert.ok(indexHtml.includes('window.exifr') || scriptJs.includes('window.exifr'));
  assert.ok(scriptJs.includes('window.piexif'));
});

test('UI は入力・プラン・一括操作・結果の要素を持つ', () => {
  for (const id of [
    'drop-zone',
    'file-input',
    'preset-row',
    'category-grid',
    'plan-summary',
    'process-btn',
    'clear-btn',
    'export-csv-btn',
    'export-json-btn',
    'empty-state',
    'file-list',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `id="${id}" が無い`);
  }
});

test('script.js は pipeline.mjs の純ロジックを使う', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const fn of [
    'detectFormat',
    'canWrite',
    'rewriteImage',
    'verifyRemoval',
    'buildReportRow',
    'toCsv',
    'toJson',
    'resolveCoordinates',
    'buildMapLinks',
    'summarizePlan',
  ]) {
    assert.ok(scriptJs.includes(fn), `${fn} を使っていない`);
  }
});

test('script.js は書き出し後に読み直して削除を確認する', () => {
  assert.ok(scriptJs.includes('verifyRemoval'), '削除確認をしていない');
  assert.ok(scriptJs.includes('window.exifr.parse'), '書き出し後の再解析をしていない');
  assert.ok(scriptJs.includes('window.piexif.load'), 'piexif オブジェクトを読んでいない');
});

test('ハーネス用の入口を公開し、確認を挟まずに処理できる', () => {
  assert.ok(scriptJs.includes('window.__photoMetadata'));
  for (const fn of ['addFiles', 'processAll', 'downloadAll', 'exportCsv', 'exportJson', 'setPlan', 'getItems']) {
    assert.ok(scriptJs.includes(fn), `${fn} が公開されていない`);
  }
});

test('pipeline.mjs は DOM に依存しない', () => {
  const code = pipelineJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/document\.|window\.|localStorage/.test(code), 'pipeline.mjs が DOM に依存している');
});

test('style.css は共通トークンとアプリ色を使う', () => {
  assert.ok(styleCss.includes('var(--c-text)'));
  assert.ok(styleCss.includes('var(--app-color)'));
  assert.ok(styleCss.includes('--app-color: #0f766e'));
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

test('registry.json (生成物) があれば photo-metadata を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('photo-metadata'), 'registry.json に photo-metadata が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
