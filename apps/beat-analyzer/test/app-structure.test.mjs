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
  assert.equal(meta.icon, 'activity');
  assert.equal(meta.color, '#0d9488');
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
  assert.equal(meta.icon, 'activity');
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
  assert.ok(indexHtml.includes('data-app-icon="activity"'));
  assert.ok(indexHtml.includes(`data-app-color="${meta.color}"`));
});

test('同意画面はモデルサイズとライセンスを明示する', () => {
  assert.ok(indexHtml.includes('id="consent-btn"'));
  assert.ok(indexHtml.includes('id="model-size"'));
  assert.ok(indexHtml.includes('id="model-license"'));
  assert.ok(indexHtml.includes('loading-screen'));
  assert.ok(scriptJs.includes('estimateDownloadBytes'));
  assert.ok(scriptJs.includes('formatBytes'));
  assert.ok(indexHtml.includes('MIT'));
});

test('script.js は pipeline.mjs から純ロジックを取り込む', () => {
  assert.ok(scriptJs.includes("from './pipeline.mjs'"));
  assert.ok(scriptJs.includes('planSpectChunks'));
  assert.ok(scriptJs.includes('buildChunkInput'));
  assert.ok(scriptJs.includes('aggregateChunkPredictions'));
  assert.ok(scriptJs.includes('pickPeaks'));
  assert.ok(scriptJs.includes('buildBeatGrid'));
  assert.ok(scriptJs.includes('gridToCsv'));
});

test('script.js は onnxruntime-web を動的 import し、2 つのモデルを読み込む', () => {
  assert.ok(scriptJs.includes('ORT_MODULE_URL'));
  assert.ok(scriptJs.includes('import('));
  assert.ok(scriptJs.includes('InferenceSession.create'));
  assert.ok(scriptJs.includes('MEL_MODEL_FILE'));
  assert.ok(scriptJs.includes('BEAT_MODEL_FILE'));
  assert.ok(scriptJs.includes('mel_spectrogram'));
  assert.ok(scriptJs.includes('downbeat'));
});

test('script.js は音声入力をデコードして 22050Hz モノラルにする', () => {
  assert.ok(scriptJs.includes('AudioContext'));
  assert.ok(scriptJs.includes('OfflineAudioContext'));
  assert.ok(scriptJs.includes('decodeAudioData'));
  assert.ok(scriptJs.includes('getUserMedia'));
  assert.ok(scriptJs.includes('MediaRecorder'));
  assert.ok(scriptJs.includes('arrayBuffer'));
  assert.ok(scriptJs.includes('MAX_INPUT_SECONDS'));
});

test('script.js はビート格子を描画し、クリック音を鳴らし、書き出す', () => {
  assert.ok(indexHtml.includes('id="timeline-canvas"'));
  assert.ok(scriptJs.includes("getContext('2d')"));
  assert.ok(scriptJs.includes('createOscillator'));
  assert.ok(scriptJs.includes('new Blob('));
  assert.ok(scriptJs.includes('URL.createObjectURL'));
  assert.ok(scriptJs.includes('download'));
  assert.ok(scriptJs.includes('buildFileName'));
});

test('script.js はビート格子を midi-studio へ受け渡す', () => {
  assert.ok(scriptJs.includes('sessionStorage'));
  assert.ok(scriptJs.includes('BEAT_HANDOFF_KEY'));
  assert.ok(scriptJs.includes('serializeBeatHandoff'));
  assert.ok(scriptJs.includes('canHandoffBeat'));
  assert.ok(indexHtml.includes('id="open-studio-btn"'));
});

test('音声は送信されない (fetch はモデル取得のみ、XHR / sendBeacon を使わない)', () => {
  assert.doesNotMatch(scriptJs, /XMLHttpRequest/);
  assert.doesNotMatch(scriptJs, /sendBeacon/);
  // fetch は SONGBIRD_MODEL_BASE からのモデル取得に限定する
  const fetchCalls = [...scriptJs.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(fetchCalls.length >= 1, 'モデル取得の fetch が無い');
  for (const call of fetchCalls) {
    assert.ok(call.includes('url') || call.includes('SONGBIRD'), `想定外の fetch: ${call}`);
  }
  assert.doesNotMatch(indexHtml, /https?:\/\/(?!fonts\.googleapis\.com)(?!www\.w3\.org)/, '外部 URL を参照している');
});

test('pipeline.mjs は純ロジックをエクスポートする', () => {
  const required = [
    'estimateDownloadBytes',
    'mixToMono',
    'resampleLinear',
    'melFrameCount',
    'planSpectChunks',
    'buildChunkInput',
    'aggregateChunkPredictions',
    'deduplicatePeaks',
    'pickPeaks',
    'snapToBeats',
    'estimateTempo',
    'inferMeter',
    'buildBeatGrid',
    'gridToJson',
    'gridToCsv',
    'serializeBeatHandoff',
    'deserializeBeatHandoff',
    'canHandoffBeat',
    'isSupportedAudioFile',
    'buildFileName',
    'formatBytes',
    'formatSeconds',
    'formatMeter',
  ];
  for (const name of required) {
    assert.match(pipelineJs, new RegExp(`export function ${name}\\b`), `${name} が未エクスポート`);
  }
});

test('pipeline.mjs は公式の前処理・チャンク定数を持つ', () => {
  assert.ok(pipelineJs.includes('22050'));
  assert.ok(pipelineJs.includes('441'));
  assert.ok(pipelineJs.includes('128'));
  assert.ok(pipelineJs.includes('1500'));
  assert.ok(pipelineJs.includes('keep_first') || pipelineJs.includes('keep_first'.replace('_', '_')));
});

test('style.css はタイムラインと統計とアクセント色を持つ', () => {
  assert.ok(styleCss.includes('.timeline-canvas'));
  assert.ok(styleCss.includes('.timeline-wrap'));
  assert.ok(styleCss.includes('.stat-grid'));
  assert.ok(styleCss.includes('var(--c-'));
  assert.ok(styleCss.includes(meta.color));
});

test('midi-studio 側にビート格子の受け口がある', (t) => {
  const midiStudioScript = resolve(rootDir, 'apps', 'midi-studio', 'script.js');
  const midiStudioHtml = resolve(rootDir, 'apps', 'midi-studio', 'index.html');
  if (!existsSync(midiStudioScript) || !existsSync(midiStudioHtml)) {
    t.skip('midi-studio が同じツリーに無い');
    return;
  }
  assert.ok(readFileSync(midiStudioScript, 'utf8').includes("'myapps:beat-grid'"));
  assert.ok(readFileSync(midiStudioHtml, 'utf8').includes('href="../beat-analyzer/index.html"'));
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

test('registry.json (生成物) があれば beat-analyzer を含む', (t) => {
  const registryPath = resolve(rootDir, 'registry.json');
  if (!existsSync(registryPath)) {
    t.skip('registry.json が未生成 (npm run registry で生成)');
    return;
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(registry.apps.includes('beat-analyzer'), 'registry.json に beat-analyzer が無い');
  assert.deepEqual(registry.apps, [...registry.apps].sort(), 'registry.json がソートされていない');
});
