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
  assert.equal(meta.icon, 'sparkles');
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

test('アイコンは shared/header.js と hub/script.js に登録されている', () => {
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes(`'${meta.icon}'`), 'shared/header.js にアイコンが無い');
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes(`'${meta.icon}'`), 'hub/script.js にアイコンが無い');
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/loader.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes('data-app-icon="sparkles"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('同意画面はモデルサイズとライセンスを動的に明示する', () => {
  assert.ok(indexHtml.includes('id="consent-btn"'));
  assert.ok(indexHtml.includes('id="model-size"'));
  assert.ok(indexHtml.includes('id="model-license"'));
  assert.ok(indexHtml.includes('loading-screen'));
  assert.ok(scriptJs.includes('estimateModelBytes'));
  assert.ok(scriptJs.includes('formatBytes'));
});

test('script.js は module worker として worker.js を起動する', () => {
  assert.ok(scriptJs.includes("new URL('./worker.js', import.meta.url)"));
  assert.ok(scriptJs.includes("type: 'module'"));
  assert.ok(existsSync(resolve(appDir, 'worker.js')));
});

test('pipeline.mjs は LFM2.5 モデルと 3 タスクを定義する', () => {
  assert.ok(pipelineJs.includes("'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX'"));
  assert.ok(pipelineJs.includes("key: 'summarize'"));
  assert.ok(pipelineJs.includes("key: 'qa'"));
  assert.ok(pipelineJs.includes("key: 'extract'"));
  assert.ok(pipelineJs.includes('parseJsonLoose'));
});

test('worker.js は Transformers.js v4 の AutoModel でストリーミング生成する', () => {
  assert.ok(workerJs.includes("from './pipeline.mjs'"));
  assert.ok(workerJs.includes('AutoTokenizer'));
  assert.ok(workerJs.includes('AutoModelForCausalLM'));
  assert.ok(workerJs.includes('TextStreamer'));
  assert.ok(workerJs.includes('StoppingCriteria'));
  assert.ok(workerJs.includes('apply_chat_template'));
  assert.ok(workerJs.includes('CACHE_PREFIX'));
  assert.ok(workerJs.includes('detectBackend'), 'WebGPU 判定が無い');
  assert.ok(workerJs.includes('navigator.gpu'), 'WebGPU の存在確認が無い');
});

test('worker.js の postMessage 型は script.js 側で処理される', () => {
  const posted = new Set([...workerJs.matchAll(/post\(\s*'([a-z-]+)'/g)].map((m) => m[1]));
  for (const type of [
    'status',
    'progress',
    'backend',
    'ready',
    'token',
    'result',
    'error',
    'cache-cleared',
  ]) {
    assert.ok(posted.has(type), `worker.js が ${type} を post していない`);
    assert.ok(scriptJs.includes(`case '${type}'`), `script.js が ${type} を処理していない`);
  }
});

test('script.js は load / run / clear-cache を worker に送る', () => {
  for (const type of ['load', 'run', 'clear-cache']) {
    assert.ok(scriptJs.includes(`type: '${type}'`), `${type} を送っていない`);
  }
});

test('script.js はタスク選択と純関数を使う', () => {
  assert.ok(scriptJs.includes('TASKS'));
  assert.ok(scriptJs.includes('buildMessages'));
  assert.ok(scriptJs.includes('formatResult'));
  assert.ok(scriptJs.includes('normalizeFields'));
  assert.ok(scriptJs.includes('getTask'));
  assert.ok(scriptJs.includes('char-count'));
  assert.ok(scriptJs.includes("addEventListener('click'"));
});

test('タスクタブと結果表示のスタイルがある', () => {
  assert.ok(styleCss.includes('.task-tab'));
  assert.ok(styleCss.includes('.output-text'));
  assert.ok(styleCss.includes('.streaming-cursor'));
  assert.ok(styleCss.includes(meta.color));
});

test('registry.json (生成物) があれば ja-assistant を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('ja-assistant'), 'registry.json に ja-assistant が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
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

test('JS の相対 import / worker URL の参照先は存在する', () => {
  for (const code of [scriptJs, workerJs]) {
    const imports = [...code.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(existsSync(resolve(appDir, spec)), `存在しない import: ${spec}`);
    }
  }
  const workerUrls = [...scriptJs.matchAll(/new URL\('(\.[^']+)'/g)].map((m) => m[1]);
  assert.ok(workerUrls.includes('./worker.js'));
  for (const spec of workerUrls) {
    assert.ok(existsSync(resolve(appDir, spec)), `存在しない worker: ${spec}`);
  }
});
