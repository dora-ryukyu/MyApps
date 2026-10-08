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
const svgJs = read('svg.mjs');
const styleCss = read('style.css');
const meta = JSON.parse(read('meta.json'));

test('meta.json の id はディレクトリ名と一致し、必須キーを持つ', () => {
  assert.equal(meta.id, basename(appDir));
  for (const key of ['id', 'name', 'description', 'icon', 'color', 'tags']) {
    assert.ok(meta[key], `meta.json に ${key} がありません`);
  }
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
  assert.equal(meta.icon, 'chart-column');
});

test('meta.json の net は取得元ホストと送信の有無を宣言する', () => {
  assert.ok(meta.net, 'meta.json に net がありません');
  assert.ok(Array.isArray(meta.net.externalHosts));
  assert.equal(meta.net.sendsData, false);
});

test('index.html が読み込む外部ホストはすべて meta.net.externalHosts に含まれる', () => {
  const hosts = new Set(
    [...indexHtml.matchAll(/https?:\/\/([^/"']+)/g)].map((m) => m[1]),
  );
  for (const host of hosts) {
    assert.ok(meta.net.externalHosts.includes(host), `宣言されていない外部ホスト: ${host}`);
  }
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 25, `DOM 参照が少なすぎる (${referenced.size})`);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリストに沿って header.js / hub に登録されている', () => {
  assert.equal(meta.icon, 'chart-column');
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
  assert.ok(indexHtml.includes('data-app-icon="chart-column"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('Chart.js はバージョン固定 + SRI で読み込む', () => {
  assert.ok(/chart\.js@\d+\.\d+\.\d+\//.test(indexHtml), 'Chart.js のバージョンが固定されていない');
  assert.ok(indexHtml.includes('integrity="sha384-'), 'SRI (integrity) が無い');
  assert.ok(indexHtml.includes('crossorigin="anonymous"'));
});

test('script.js は Chart.js を CDN から読む前提で、入力データを送信しない', () => {
  assert.doesNotMatch(scriptJs, /\bfetch\s*\(/);
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  assert.ok(scriptJs.includes('window.Chart'), 'Chart.js の利用が無い');
});

test('script.js は pipeline.mjs / svg.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  assert.ok(scriptJs.includes("from './svg.mjs'"));
  for (const name of ['parseTable', 'seriesColors', 'normalize', 'heatmapGrid', 'boxStats', 'chartToSvg']) {
    assert.ok(scriptJs.includes(name), `${name} を使っていない`);
  }
});

test('pipeline.mjs は必須の純ロジックをエクスポートする', () => {
  const required = [
    'parseTable',
    'detectDelimiter',
    'inferColumnType',
    'boxStats',
    'niceTicks',
    'logTicks',
    'linearScale',
    'logScale',
    'histogram',
    'heatmapGrid',
    'normalize',
    'seriesColors',
    'colorScale',
    'formatNumber',
    'buildCsv',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
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
  for (const source of [scriptJs, svgJs]) {
    for (const spec of [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
      assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
    }
  }
});

test('style.css はテーマトークンを使い、主要コンポーネントを定義する', () => {
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes('--app-color'));
  assert.ok(styleCss.includes('.chart-stage'));
  assert.ok(styleCss.includes('.drop-zone'));
  assert.ok(!/transition:\s*all/.test(styleCss), 'transition: all を使っている');
});

test('registry.json (生成物) があれば chart-studio を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('chart-studio'), 'registry.json に chart-studio が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
