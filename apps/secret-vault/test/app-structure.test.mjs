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
const vaultJs = read('vault.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'key-round');
  assert.equal(meta.color, '#14b8a6');
});

test('meta.json は送信なしを宣言している', () => {
  assert.ok(typeof meta.net === 'string' && meta.net.length > 0, 'net の宣言が無い');
  assert.match(meta.net, /送信なし/);
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

test('アイコンは DESIGN.md のチェックリストに沿って登録されている', () => {
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
  assert.ok(indexHtml.includes('data-app-icon="key-round"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('otplib は固定版 + SRI で読み込む', () => {
  const match = indexHtml.match(
    /<script[^>]+src="https:\/\/cdn\.jsdelivr\.net\/npm\/otplib@([^/"]+)\/[^"]+"[^>]*integrity="(sha384-[^"]+)"[^>]*>/,
  );
  assert.ok(match, 'otplib の CDN script が SRI 付きで無い');
  assert.equal(match[1], '13.5.0', 'otplib の版が固定されていない');
  assert.match(match[2], /^sha384-/);
  assert.ok(indexHtml.includes('crossorigin="anonymous"'), 'crossorigin が無い');
});

test('age はローカル vendor から読み込み、送信経路を持たない', () => {
  assert.ok(indexHtml.includes('vendor/age.js'), 'age を vendor から読んでいない');
  assert.ok(existsSync(resolve(appDir, 'vendor', 'age.js')), 'vendor/age.js が無い');
  const vendorReadme = read('vendor/README.md');
  assert.ok(vendorReadme.includes('BSD-3-Clause'), 'vendor README にライセンス表記が無い');
});

test('script.js は vault.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './vault.mjs'"));
  for (const name of [
    'createEmptyVault',
    'addEntry',
    'updateEntry',
    'removeEntry',
    'searchEntries',
    'generatePassword',
    'generateTotp',
    'isLocked',
    'shouldClearClipboard',
    'openVaultContainer',
  ]) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('vault.mjs は必要な関数をエクスポートする', () => {
  const required = [
    'deriveKeyFromPassphrase',
    'encryptVaultWithKey',
    'decryptVaultWithKey',
    'createVaultContainer',
    'openVaultContainer',
    'serializeVault',
    'deserializeVault',
    'migrateVault',
    'addEntry',
    'updateEntry',
    'removeEntry',
    'searchEntries',
    'collectTags',
    'generatePassword',
    'computeEntropyBits',
    'generateTotp',
    'verifyTotp',
    'parseOtpauthUri',
    'isLocked',
    'shouldClearClipboard',
    'encryptVaultWithAge',
    'decryptVaultWithAge',
  ];
  for (const name of required) {
    assert.match(vaultJs, new RegExp(`export (async )?function ${name}\\b`), `${name} が未エクスポート`);
  }
  assert.ok(vaultJs.includes('AES-GCM'), 'AES-GCM を使っていない');
  assert.ok(vaultJs.includes('PBKDF2'), 'PBKDF2 を使っていない');
});

test('ファイルは送信されない (fetch / XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.doesNotMatch(vaultJs, /\bfetch\s*\(/);
});

test('script.js は localStorage へ暗号文コンテナのみ保存する', () => {
  assert.ok(scriptJs.includes('localStorage.setItem(STORAGE_KEY'));
  assert.ok(scriptJs.includes('encryptVaultWithKey'));
  assert.ok(!/localStorage\.setItem\([^)]*JSON\.stringify\(state\.vault/.test(scriptJs), '平文 vault を保存している');
});

test('自動ロックとクリップボード自動クリアのタイマーを持つ', () => {
  assert.ok(scriptJs.includes('isLocked('));
  assert.ok(scriptJs.includes('shouldClearClipboard('));
  assert.ok(scriptJs.includes('navigator.clipboard.writeText'));
  assert.ok(scriptJs.includes('setInterval'));
});

test('style.css はテーマトークンと主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.lock-card'));
  assert.ok(styleCss.includes('.vault-grid'));
  assert.ok(styleCss.includes('.totp-code'));
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
  for (const source of [scriptJs]) {
    for (const spec of [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
      assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
    }
  }
});
