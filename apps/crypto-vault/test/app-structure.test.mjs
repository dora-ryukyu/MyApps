import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
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
  assert.equal(meta.icon, 'lock');
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
  assert.equal(meta.icon, 'lock');
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
  assert.ok(indexHtml.includes('data-app-icon="lock"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  for (const name of [
    'generateKeyPair',
    'encryptBytes',
    'decryptBytes',
    'armorEncode',
    'resolveEncryptedInput',
    'validatePassphrase',
    'validateIdentity',
    'validateRecipient',
    'buildAgeFileName',
    'stripAgeExtension',
    'isProbablyText',
    'formatBytes',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('pipeline.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'clampScryptWorkFactor',
    'validatePassphrase',
    'validateIdentity',
    'validateRecipient',
    'classifyKeyValue',
    'looksLikeArmor',
    'formatBytes',
    'sanitizeBaseName',
    'buildAgeFileName',
    'stripAgeExtension',
    'toUint8Array',
    'isProbablyText',
    'generateKeyPair',
    'encryptBytes',
    'decryptBytes',
    'armorEncode',
    'armorDecode',
    'resolveEncryptedInput',
    'isAgeCiphertext',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export (?:async )?function ${name}\\b`), `${name} が未エクスポート`);
  }
  assert.ok(pipelineJs.includes('age-encryption.org/v1'), 'age ヘッダ定数が無い');
});

test('age ライブラリは同梱され、外部 CDN から読み込まない', () => {
  assert.ok(indexHtml.includes('src="vendor/age.js"'), 'vendor/age.js を読み込んでいない');
  assert.ok(existsSync(resolve(appDir, 'vendor', 'age.js')), 'vendor/age.js が存在しない');
  assert.ok(statSync(resolve(appDir, 'vendor', 'age.js')).size > 10000, 'vendor/age.js が小さすぎる');
  assert.ok(!/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(indexHtml), '外部 CDN を参照している');
});

test('script.js は window.age を使い、暗号化・復号・armor を呼ぶ', () => {
  assert.ok(scriptJs.includes('window.age'), 'window.age を参照していない');
  assert.ok(scriptJs.includes('encryptBytes'));
  assert.ok(scriptJs.includes('decryptBytes'));
  assert.ok(scriptJs.includes('armorEncode'));
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!age-encryption\.org|www\.w3\.org)/, '外部 URL を参照している');
});

test('identity は localStorage に保存しない', () => {
  assert.doesNotMatch(scriptJs, /localStorage\.setItem/);
  assert.doesNotMatch(scriptJs, /sessionStorage\.setItem/);
  assert.doesNotMatch(scriptJs, /indexedDB/);
});

test('鍵ペアはダウンロード導線を持つ', () => {
  assert.ok(indexHtml.includes('id="download-identity-btn"'));
  assert.ok(indexHtml.includes('id="download-recipient-btn"'));
  assert.ok(scriptJs.includes('buildIdentityFileName'));
  assert.ok(scriptJs.includes('downloadText'));
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.mode-tabs'));
  assert.ok(styleCss.includes('.drop-zone'));
  assert.ok(styleCss.includes('.key-textarea'));
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

test('registry.json (生成物) があれば crypto-vault を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('crypto-vault'), 'registry.json に crypto-vault が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
