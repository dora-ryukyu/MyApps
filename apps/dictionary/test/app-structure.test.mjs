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
const dictJs = read('dictionary.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'book-open');
  assert.equal(meta.color, '#6366f1');
});

test('meta.json は「初回のみ取得、以後送信なし」を宣言している', () => {
  assert.ok(typeof meta.net === 'string' && meta.net.length > 0, 'net の宣言が無い');
  assert.match(meta.net, /送信なし/);
  assert.match(meta.net, /初回のみ取得/);
  assert.ok(typeof meta.storage === 'string' && meta.storage.length > 0, 'storage の宣言が無い');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 15, `DOM 参照が少なすぎる (${referenced.size})`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは shared/header.js と hub/script.js に登録されている', () => {
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
  assert.ok(indexHtml.includes('data-app-icon="book-open"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は dictionary.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './dictionary.mjs'"));
  for (const name of [
    'buildDataset',
    'buildIndex',
    'parseDictionaryArchive',
    'dataFileUrl',
    'searchJapanese',
    'searchEnglish',
    'searchByKanji',
    'lookupKanji',
    'migrateDataset',
    'buildStudyCard',
    'buildNote',
    'pushInbox',
    'INBOX_KEYS',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('dictionary.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'katakanaToHiragana',
    'hiraganaToKatakana',
    'romajiToHiragana',
    'japaneseQuery',
    'normalizeJapanese',
    'normalizeLatin',
    'normalizeJmdictWord',
    'normalizeKanjidicCharacter',
    'buildDataset',
    'migrateDataset',
    'buildIndex',
    'prefixRange',
    'searchJapanese',
    'searchEnglish',
    'searchByKanji',
    'search',
    'lookupKanji',
    'datasetStats',
    'extractTarMember',
    'gunzip',
    'parseDictionaryArchive',
    'dataFileUrl',
    'buildStudyCard',
    'buildNote',
    'pushInbox',
    'formatBytes',
  ];
  for (const name of required) {
    assert.match(dictJs, new RegExp(`export (async )?function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('検索語は送信されない (fetch は辞書データの取得のみ)', () => {
  // fetch は dataFileUrl が返す URL に対してのみ行う。
  assert.ok(scriptJs.includes('dataFileUrl('), 'dataFileUrl を使っていない');
  assert.ok(scriptJs.includes('fetchBytes('), 'fetchBytes を使っていない');
  assert.doesNotMatch(scriptJs, /fetch\([^)]*searchInput/, '検索入力を fetch に渡している');
  assert.doesNotMatch(scriptJs, /sendBeacon|XMLHttpRequest/);
  // dictionary.mjs はネットワークに触れない
  assert.doesNotMatch(dictJs, /\bfetch\s*\(/);
});

test('データは IndexedDB と Cache Storage に保存する', () => {
  assert.ok(scriptJs.includes('indexedDB.open'));
  assert.ok(scriptJs.includes('caches.open'));
  assert.ok(scriptJs.includes('idbPut('));
  assert.ok(scriptJs.includes('cache.put('));
});

test('受け渡しキーは study-cards / notes-vault を指す', () => {
  assert.ok(dictJs.includes('myapps:inbox:study-cards'));
  assert.ok(dictJs.includes('myapps:inbox:notes-vault'));
  assert.ok(scriptJs.includes('INBOX_KEYS.studyCards'));
  assert.ok(scriptJs.includes('INBOX_KEYS.notesVault'));
});

test('style.css はテーマトークンと主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.word-card'));
  assert.ok(styleCss.includes('.mode-tab'));
  assert.ok(styleCss.includes('.kanji-panel'));
  assert.ok(!/transition:\s*all/.test(styleCss), 'transition: all を使っている');
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
