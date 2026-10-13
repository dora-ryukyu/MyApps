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

test('meta.json はディレクトリ名と一致し、必須キーと net 宣言を持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.equal(meta.icon, 'file-pen');
  assert.match(meta.color, /^#[0-9a-f]{6}$/i);
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.ok(meta.net && meta.net.sendsData === false, 'net.sendsData が false でない');
  assert.ok(meta.net.hosts.includes('cdn.jsdelivr.net'));
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 30, `DOM 参照が少なすぎる (${referenced.size})`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し meta.json の color を使う', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
});

test('アイコンは 4 箇所 (meta / index.html / header.js / hub) に登録されている', () => {
  assert.equal(meta.icon, 'file-pen');
  assert.ok(indexHtml.includes('data-app-icon="file-pen"'), 'index.html に data-app-icon が無い');
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes("'file-pen'"), 'shared/header.js にアイコンが無い');
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes("'file-pen'"), 'hub/script.js にアイコンが無い');
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('外部ライブラリは版固定 + SRI で読み込む (pdf.js / pdf-lib)', () => {
  assert.match(indexHtml, /pdfjs-dist@3\.11\.174\/build\/pdf\.min\.js/);
  assert.match(indexHtml, /integrity="sha384-[A-Za-z0-9+/=]+"/);
  assert.match(indexHtml, /pdf-lib@1\.17\.1\/dist\/pdf-lib\.min\.js/);
  const integrityCount = (indexHtml.match(/integrity=/g) || []).length;
  assert.equal(integrityCount, 2, 'pdf.js と pdf-lib の 2 つに integrity が必要');
  assert.match(indexHtml, /crossorigin="anonymous"/);
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'screenToPageNorm',
    'pageNormToScreen',
    'rectToPdfPoints',
    'createAnnotation',
    'annotationBounds',
    'topAnnotationAt',
    'moveAnnotation',
    'createPageModel',
    'insertBlankPage',
    'pruneAnnotations',
    'serializeAnnotations',
    'parseAnnotations',
    'buildExportName',
    'uniqueFileName',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('pipeline.mjs は純ロジックの関数をエクスポートする', () => {
  const required = [
    'normalizeRotation',
    'clamp',
    'clamp01',
    'hexToRgb',
    'screenToPageNorm',
    'pageNormToScreen',
    'normRect',
    'rectContains',
    'rectsIntersect',
    'rectToPdfPoints',
    'createAnnotation',
    'annotationBounds',
    'hitTestAnnotation',
    'topAnnotationAt',
    'moveAnnotation',
    'normalizeLine',
    'lineFromRect',
    'lineBounds',
    'annotationsForPage',
    'summarizeAnnotations',
    'createPageModel',
    'activePages',
    'pageCount',
    'rotatePage',
    'setPageRotation',
    'deletePage',
    'restorePage',
    'movePage',
    'reorderPages',
    'insertBlankPage',
    'extractPages',
    'pruneAnnotations',
    'displayedAspect',
    'serializeAnnotations',
    'parseAnnotations',
    'sanitizeBaseName',
    'ensurePdfExtension',
    'buildExportName',
    'buildAnnotationsName',
    'uniqueFileName',
    'isSupportedPdfFile',
    'formatBytes',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('注釈・ページ操作・書き出しの UI が揃っている', () => {
  for (const id of [
    'toolbar', 'overlay-canvas', 'pdf-canvas', 'page-thumb-list',
    'signature-pad', 'signature-modal', 'text-modal',
    'export-flat', 'export-layer', 'export-json', 'export-extract',
    'rail-select-all', 'rail-select-none',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `${id} が無い`);
  }
  for (const tool of ['select', 'highlight', 'underline', 'strikeout', 'texthighlight', 'rect', 'ellipse', 'ink', 'text', 'note', 'signature', 'eraser']) {
    assert.ok(indexHtml.includes(`data-tool="${tool}"`), `ツール ${tool} が無い`);
  }
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
});

test('index.html の外部 URL は jsdelivr のみ', () => {
  const urls = [...indexHtml.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
  for (const url of urls) {
    assert.ok(url.includes('cdn.jsdelivr.net'), `想定外の外部 URL: ${url}`);
  }
});

test('書き出しは Blob / createObjectURL / download を使う', () => {
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
  assert.ok(scriptJs.includes('embedPng'), '署名を PDF に埋め込んでいない');
  assert.ok(scriptJs.includes('.attach('), '注釈データを PDF に添付していない');
});

test('style.css はテーマトークンを使い主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color') || styleCss.includes('--c-app'));
  for (const cls of ['.drop-zone', '.toolbar', '.page-rail', '.modal', '.signature-pad', '.text-layer', '.toast']) {
    assert.ok(styleCss.includes(cls), `${cls} が無い`);
  }
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

test('registry.json (生成物) があれば pdf-annotate を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('pdf-annotate'), 'registry.json に pdf-annotate が無い');
});
