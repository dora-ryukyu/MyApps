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
  assert.equal(meta.icon, 'rss');
  assert.equal(meta.color, '#ea580c');
});

test('meta.json の net は取得先を宣言している', () => {
  assert.ok(meta.net && typeof meta.net === 'object', 'net 宣言が無い');
  assert.ok(Array.isArray(meta.net.hosts) && meta.net.hosts.length > 0);
  assert.ok(meta.net.hosts.includes('cdn.jsdelivr.net'));
  assert.ok(Array.isArray(meta.net.userSupplied));
  assert.ok(meta.net.userSupplied.includes('feedUrl'));
  assert.ok(meta.net.userSupplied.includes('articleUrl'));
  assert.ok(typeof meta.net.note === 'string' && meta.net.note.length > 0);
});

test('pipeline の CDN 定数は meta.net.hosts と一致する', () => {
  assert.match(pipelineJs, /export const LIBRARY_CDN_HOST = 'cdn\.jsdelivr\.net'/);
  assert.match(pipelineJs, /@mozilla\/readability@0\.6\.0\/\+esm/);
  assert.match(pipelineJs, /turndown@7\.2\.4\/\+esm/);
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

test('アイコンは DESIGN.md のチェックリスト 4 箇所に登録されている', () => {
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes(`'${meta.icon}'`), 'shared/header.js にアイコンが無い');
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes(`'${meta.icon}'`), 'hub/script.js にアイコンが無い');
  assert.ok(indexHtml.includes(`data-app-icon="${meta.icon}"`));
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'parseFeed',
    'applyFeedResult',
    'addFeed',
    'removeFeed',
    'selectItems',
    'buildOpml',
    'parseOpml',
    'extractArticle',
    'htmlToMarkdown',
    'buildClipMarkdown',
    'buildNoteClip',
  ]) {
    assert.ok(scriptJs.includes(name), `script.js が ${name} を使っていない`);
  }
});

test('script.js は readability / turndown を動的 import し、失敗に備える', () => {
  assert.ok(scriptJs.includes('READABILITY_MODULE_URL'));
  assert.ok(scriptJs.includes('TURNDOWN_MODULE_URL'));
  assert.ok(scriptJs.includes('import('), '動的 import が無い');
  assert.ok(scriptJs.includes('extractArticle'), 'フォールバック抽出が無い');
  assert.ok(scriptJs.includes('htmlToMarkdown'), 'フォールバック Markdown が無い');
});

test('script.js は XMLHttpRequest / sendBeacon を使わない', () => {
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
});

test('script.js の fetch はユーザー提供 URL に限定される', () => {
  const calls = [...scriptJs.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1, 'fetch が無い');
  for (const call of calls) {
    assert.match(call, /\burl\b/, `想定外の fetch 引数: ${call}`);
  }
  // 固定の外部 URL を直書きしていない (定数は pipeline.mjs 側にある)
  assert.doesNotMatch(scriptJs, /https?:\/\//, 'script.js に外部 URL の直書きがある');
});

test('notes-vault への受け渡しは sessionStorage の固定キーを使う', () => {
  assert.ok(scriptJs.includes('CLIP_HANDOFF_KEY'));
  assert.ok(scriptJs.includes('CLIP_HANDOFF_URL'));
  assert.ok(scriptJs.includes('sessionStorage'));
  assert.match(pipelineJs, /export const CLIP_HANDOFF_KEY = 'myapps:note-clip'/);
});

test('pipeline.mjs は純ロジックをエクスポートする', () => {
  const required = [
    'decodeEntities',
    'escapeXml',
    'htmlToText',
    'cleanText',
    'stableHash',
    'localName',
    'parseXml',
    'detectFeedFormat',
    'parseFeed',
    'normalizeRawItem',
    'normalizeUrl',
    'sameUrl',
    'isLikelyFeedUrl',
    'discoverFeedLinks',
    'parseDate',
    'itemKey',
    'feedId',
    'toItem',
    'dedupeByKey',
    'diffNewItems',
    'mergeFeedItems',
    'estimateReadMinutes',
    'buildOpml',
    'parseOpml',
    'stripUnwantedHtml',
    'extractArticle',
    'htmlToMarkdown',
    'slugify',
    'buildClipFileName',
    'buildOpmlFileName',
    'formatDate',
    'formatRelativeDate',
    'formatBytes',
    'buildClipMarkdown',
    'buildNoteClip',
    'createState',
    'addFeed',
    'updateFeed',
    'removeFeed',
    'applyFeedResult',
    'markRead',
    'toggleReadLater',
    'setReadRatio',
    'getStatus',
    'unreadCount',
    'readLaterCount',
    'selectItems',
    'serializeState',
    'normalizeState',
    'deserializeState',
    'stateByteSize',
    'pruneArticlesToBudget',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('元記事リンクは新しいタブで安全に開く', () => {
  assert.ok(indexHtml.includes('id="open-original-btn"'));
  assert.ok(indexHtml.includes('rel="noopener noreferrer"'));
  assert.ok(scriptJs.includes('noopener noreferrer'));
});

test('style.css はアプリ色とテーマ変数を使う', () => {
  assert.ok(styleCss.includes(meta.color));
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('.reader-body'));
  assert.ok(styleCss.includes('.article-list'));
});

test('index.html が参照するローカル資産はすべて存在する', () => {
  const refs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//.test(u) && !u.startsWith('data:') && !u.startsWith('#'));
  assert.ok(refs.length >= 5);
  for (const ref of refs) {
    assert.ok(existsSync(resolve(appDir, ref)), `存在しない参照: ${ref}`);
  }
});

test('JS の相対 import の参照先は存在する', () => {
  for (const spec of [...scriptJs.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
    assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
  }
});

test('registry.json (生成物) があれば feed-reader を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('feed-reader'), 'registry.json に feed-reader が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
