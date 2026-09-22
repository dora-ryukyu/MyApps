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
  assert.equal(meta.icon, 'expand');
});

test('script.js が参照する DOM id はすべて index.html に存在する', () => {
  const htmlIds = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...scriptJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 15, 'DOM 参照が少なすぎる');
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html に存在しない id: ${missing.join(', ')}`);
});

test('favicon.svg が存在し、meta.json の color を使っている', () => {
  const favicon = read('favicon.svg');
  assert.ok(favicon.includes(meta.color), `favicon の色が ${meta.color} ではない`);
  assert.ok(favicon.includes('<svg'), 'favicon.svg が SVG ではない');
});

test('アイコンは DESIGN.md のチェックリスト 4 箇所に登録されている', () => {
  // 1. meta.json
  assert.equal(meta.icon, 'expand');
  // 3. shared/header.js
  const headerJs = readFileSync(resolve(rootDir, 'shared', 'header.js'), 'utf8');
  assert.ok(headerJs.includes(`'${meta.icon}'`), 'shared/header.js にアイコンが無い');
  // 4. hub/script.js
  const hubJs = readFileSync(resolve(rootDir, 'hub', 'script.js'), 'utf8');
  assert.ok(hubJs.includes(`'${meta.icon}'`), 'hub/script.js にアイコンが無い');
  // 2. favicon.svg は上のテストで確認済み
});

test('index.html は共通 CSS / 共通ヘッダー / モジュール script を読み込む', () => {
  assert.ok(indexHtml.includes('../../shared/base.css'));
  assert.ok(indexHtml.includes('../../shared/header.css'));
  assert.ok(indexHtml.includes('../../shared/loader.css'));
  assert.ok(indexHtml.includes('../../shared/header.js'));
  assert.ok(indexHtml.includes('type="module" src="script.js"'));
  assert.ok(indexHtml.includes('data-app-icon="expand"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('同意画面はモデルサイズとライセンスを明示する', () => {
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

test('pipeline.mjs は Swin2SR と Real-ESRGAN の両エンジンを定義する', () => {
  assert.ok(pipelineJs.includes("modelId: 'Xenova/swin2SR-classical-sr-x2-64'"));
  assert.ok(pipelineJs.includes("modelId: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr'"));
  assert.ok(pipelineJs.includes('tidus2102/Real-ESRGAN'));
  assert.ok(pipelineJs.includes("engine: 'ort'"));
  assert.ok(pipelineJs.includes("engine: 'transformers'"));
  assert.ok(pipelineJs.includes('computeTiles'));
  assert.ok(pipelineJs.includes('blendTiles'));
});

test('worker.js は Transformers.js の image-to-image と onnxruntime-web を使う', () => {
  assert.ok(workerJs.includes("from './pipeline.mjs'"));
  assert.ok(workerJs.includes('tf.pipeline'));
  assert.ok(workerJs.includes('RawImage'));
  assert.ok(workerJs.includes('InferenceSession'));
  assert.ok(workerJs.includes('Tensor'));
  assert.ok(workerJs.includes('ONNXRUNTIME_MODULE_URL'));
  assert.ok(workerJs.includes('CACHE_PREFIX'));
  assert.ok(workerJs.includes('detectBackend'), 'WebGPU 判定が無い');
  assert.ok(workerJs.includes('navigator.gpu'), 'WebGPU の存在確認が無い');
  assert.ok(workerJs.includes('computeTiles'), 'タイル分割が無い');
  assert.ok(workerJs.includes('blendTiles'), '重ね合わせが無い');
});

test('worker.js の postMessage 型は script.js 側で処理される', () => {
  const posted = new Set([...workerJs.matchAll(/post\(\s*'([a-z-]+)'/g)].map((m) => m[1]));
  for (const type of ['status', 'progress', 'backend', 'ready', 'result', 'error', 'cache-cleared']) {
    assert.ok(posted.has(type), `worker.js が ${type} を post していない`);
    assert.ok(scriptJs.includes(`case '${type}'`), `script.js が ${type} を処理していない`);
  }
});

test('script.js は load / process / clear-cache を worker に送る', () => {
  for (const type of ['load', 'process', 'clear-cache']) {
    assert.ok(scriptJs.includes(`type: '${type}'`), `${type} を送っていない`);
  }
});

test('script.js は画像入力・出力サイズ確認・保存の純関数を使う', () => {
  assert.ok(scriptJs.includes('createImageBitmap'));
  assert.ok(scriptJs.includes("addEventListener('drop'"));
  assert.ok(scriptJs.includes('isSupportedImage'));
  assert.ok(scriptJs.includes('buildDownloadName'));
  assert.ok(scriptJs.includes('chooseModel'));
  assert.ok(scriptJs.includes('assertOutputFits'));
  assert.ok(scriptJs.includes('ImageData'));
});

test('透過を保つためアルファチャンネルを別途適用する', () => {
  assert.ok(scriptJs.includes('applySourceAlpha'));
  assert.ok(scriptJs.includes('detectAlpha'));
  assert.ok(scriptJs.includes('hasAlpha'));
});

test('結果キャンバスは透過が見えるチェッカー柄を持つ', () => {
  assert.ok(styleCss.includes('.result-canvas'));
  assert.ok(styleCss.includes('linear-gradient'));
  assert.ok(styleCss.includes(meta.color));
});

test('registry.json (生成物) があれば upscale-studio を含む', (t) => {
  // registry.json は .gitignore された生成物 (scripts/generate-registry.js)。
  // 未生成のクローンでは存在しないため skip する。
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('upscale-studio'), 'registry.json に upscale-studio が無い');
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
