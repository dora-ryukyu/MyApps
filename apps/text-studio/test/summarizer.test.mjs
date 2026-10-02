import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const rootDir = resolve(appDir, '..', '..');

function read(relative) {
  return readFileSync(resolve(appDir, relative), 'utf8');
}

const indexHtml = read('index.html');
const summarizerJs = read('summarizer.js');
const styleCss = read('style.css');

test('要約タブは既定で hidden、対応時のみ summarizer.js が表示する', () => {
  assert.ok(indexHtml.includes('id="tab-summarizer-btn"'), '要約タブのボタンが無い');
  assert.match(indexHtml, /id="tab-summarizer-btn"[^>]*hidden/, '要約タブが既定で hidden ではない');
  assert.ok(indexHtml.includes('id="tab-summarizer"'), '要約タブのコンテンツが無い');
  assert.ok(summarizerJs.includes('tabBtn.hidden = false'), '対応時にタブを表示していない');
});

test('summarizer.js は module として読み込まれる', () => {
  assert.ok(indexHtml.includes('type="module" src="summarizer.js"'), 'module 読み込みが無い');
  assert.ok(existsSync(resolve(appDir, 'summarizer.js')));
});

test('summarizer.js は共通ロジックを import し、Summarizer を feature detect する', () => {
  assert.ok(summarizerJs.includes("from '../../shared/builtin-ai.mjs'"), '共通ロジックを import していない');
  assert.ok(summarizerJs.includes('globalThis.Summarizer'), 'Summarizer の feature detect が無い');
  assert.ok(summarizerJs.includes('summarizerApi.availability'), 'availability() を確認していない');
  assert.ok(summarizerJs.includes('isSummarizerAllowed'), '対応可否の判定が無い');
  assert.ok(summarizerJs.includes('buildSummarizerOptions'), 'オプション組み立てが無い');
  assert.ok(summarizerJs.includes('summarizerButtonLabel'), 'ボタン文言の切替が無い');
});

test('対応外ブラウザでは UI を変えずに return する', () => {
  assert.match(
    summarizerJs,
    /if \(!summarizerApi \|\| typeof summarizerApi\.availability !== 'function'\) return;/,
    'API 不在時の早期 return が無い',
  );
  assert.match(summarizerJs, /if \(!isSummarizerAllowed\(availability\)\) return;/, '利用不可時の早期 return が無い');
});

test('summarizer.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...summarizerJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 8, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('要約タブのスタイルがある', () => {
  assert.ok(styleCss.includes('.summarizer-note'));
  assert.ok(styleCss.includes('.summarizer-status'));
});

test('summarizer.js の相対 import の参照先は存在する', () => {
  const imports = [...summarizerJs.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 1);
  for (const spec of imports) {
    assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
  }
  assert.ok(existsSync(resolve(rootDir, 'shared', 'builtin-ai.mjs')));
});