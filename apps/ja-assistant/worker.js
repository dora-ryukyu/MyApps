/**
 * worker.js — 日本語アシスタントの推論ワーカー
 *
 * メインスレッドを止めないよう、モデルのダウンロードと推論はすべて
 * この Web Worker 内で実行する。
 *
 * 実行基盤: Transformers.js v4 (AutoTokenizer + AutoModelForCausalLM)
 * モデル: LiquidAI/LFM2.5-1.2B-JP-202606-ONNX
 *
 * 生成は TextStreamer で 1 トークンずつ main スレッドへ送る。
 * モデルは Transformers.js の Cache Storage に保存され、2 回目以降は
 * 再ダウンロードしない。
 */

import {
  TRANSFORMERS_MODULE_URL,
  CACHE_PREFIX,
  DEFAULT_MODEL_KEY,
  DEFAULT_MAX_NEW_TOKENS,
  chooseModel,
  buildMessages,
  cleanOutput,
  getTask,
} from './pipeline.mjs';

/* ==========================================================
   状態
   ========================================================== */
let tf = null;
let tokenizer = null;
let model = null;
let active = null; // { modeKey, modelId, device, dtype, bytes, license }
let backend = 'wasm';
let fp16 = false;
let backendDetected = false;
let busy = false;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function status(stage, message) {
  post('status', { stage, message });
}

/* ==========================================================
   バックエンド判定 (bg-remove / upscale-studio と同じ方式)
   ========================================================== */
async function detectBackend() {
  if (backendDetected) return { device: backend, fp16 };
  backendDetected = true;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        backend = 'webgpu';
        fp16 =
          adapter.features && typeof adapter.features.has === 'function'
            ? adapter.features.has('shader-f16')
            : false;
        return { device: backend, fp16 };
      }
    } catch (err) {
      console.warn('WebGPU アダプタの取得に失敗:', err);
    }
  }
  backend = 'wasm';
  fp16 = false;
  return { device: backend, fp16 };
}

/* ==========================================================
   ライブラリ / モデル読み込み
   ========================================================== */
async function loadLibraries() {
  if (tf) return tf;
  status('library', 'Transformers.js を読み込み中…');
  tf = await import(/* @vite-ignore */ TRANSFORMERS_MODULE_URL);
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true;
  try {
    if (tf.env.backends && tf.env.backends.onnx && tf.env.backends.onnx.wasm) {
      // GitHub Pages は COOP/COEP を返さないためマルチスレッド WASM を無効化する
      tf.env.backends.onnx.wasm.numThreads = 1;
    }
  } catch {
    /* 環境によっては存在しない */
  }
  return tf;
}

function makeProgressCallback() {
  let lastUpdate = 0;
  return (info) => {
    if (!info) return;
    if (info.status === 'progress_total') {
      post('progress', {
        stage: 'download',
        progress: info.progress,
        loaded: info.loaded,
        total: info.total,
      });
      return;
    }
    if (info.status === 'progress' && info.total) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      post('progress', {
        stage: 'download',
        file: info.file || info.name || 'model',
        loaded: info.loaded,
        total: info.total,
      });
    }
  };
}

async function loadModel(modelKey) {
  if (busy) return;
  busy = true;
  try {
    await loadLibraries();
    await detectBackend();
    post('backend', { backend, fp16 });

    const choice = chooseModel(modelKey || DEFAULT_MODEL_KEY, backend === 'webgpu');
    if (active && active.modeKey === choice.modeKey && active.dtype === choice.dtype && model) {
      post('ready', readyPayload(choice));
      return;
    }

    status('tokenizer', 'トークナイザーを読み込み中…');
    tokenizer = await tf.AutoTokenizer.from_pretrained(choice.modelId, {
      progress_callback: makeProgressCallback(),
    });

    status('model', 'AI モデルを読み込み中…');
    model = await tf.AutoModelForCausalLM.from_pretrained(choice.modelId, {
      device: choice.device,
      dtype: choice.dtype,
      progress_callback: makeProgressCallback(),
    });

    active = { ...choice };
    post('ready', readyPayload(choice));
  } catch (err) {
    console.error(err);
    active = null;
    model = null;
    tokenizer = null;
    post('error', { stage: 'init', error: err && err.message ? err.message : String(err) });
  } finally {
    busy = false;
  }
}

function readyPayload(choice) {
  return {
    modeKey: choice.modeKey,
    modelId: choice.modelId,
    label: choice.label,
    shortLabel: choice.shortLabel,
    device: choice.device,
    dtype: choice.dtype,
    backend,
    fp16,
    license: choice.license,
    commercial: choice.commercial,
    bytes: choice.bytes,
    contextTokens: choice.contextTokens,
  };
}

/* ==========================================================
   生成
   ========================================================== */
class EosStoppingCriteria extends tf.StoppingCriteria {
  constructor(eosTokenId) {
    super();
    this.eosTokenId = eosTokenId;
  }

  _call(inputIds) {
    // v4 の StoppingCriteria はバッチごとの boolean 配列を返す契約。
    // トークンは bigint で来るため == で比較する。
    return inputIds.map((ids) => ids.at(-1) == this.eosTokenId);
  }
}

async function run({ taskKey, input, question, fields, requestId }) {
  if (busy) {
    post('error', { stage: 'process', requestId, error: '別の生成を処理中です。' });
    return;
  }
  if (!model || !tokenizer) {
    post('error', { stage: 'process', requestId, error: 'モデルがまだ準備できていません。' });
    return;
  }
  busy = true;
  try {
    const messages = buildMessages(taskKey, { input, question, fields });
    const task = getTask(taskKey);
    const inputText = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      tokenize: false,
    });
    const inputs = tokenizer(inputText, { return_tensors: 'pt' });

    let tokenCount = 0;
    let resultText = '';
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const streamer = new tf.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        resultText += chunk;
        tokenCount++;
        post('token', { requestId, text: chunk });
      },
    });

    const imEndId = tokenizer.encode('<|im_end|>', { add_special_tokens: false }).at(-1);
    const stopping = typeof imEndId === 'number' ? [new EosStoppingCriteria(imEndId)] : undefined;

    await model.generate({
      ...inputs,
      max_new_tokens: task.maxNewTokens || DEFAULT_MAX_NEW_TOKENS,
      temperature: 0,
      do_sample: false,
      streamer,
      stopping_criteria: stopping,
    });

    const elapsedMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    status('process', '完了');
    post('result', {
      requestId,
      taskKey,
      text: cleanOutput(resultText),
      tokens: tokenCount,
      elapsedMs: Math.round(elapsedMs),
    });
  } catch (err) {
    console.error(err);
    post('error', {
      stage: 'process',
      requestId,
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    busy = false;
  }
}

/* ==========================================================
   キャッシュ
   ========================================================== */
async function clearCache() {
  try {
    if (typeof caches === 'undefined') {
      post('cache-cleared', { removed: 0 });
      return;
    }
    const keys = await caches.keys();
    const targets = keys.filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(targets.map((key) => caches.delete(key)));
    post('cache-cleared', { removed: targets.length });
  } catch (err) {
    post('error', { stage: 'cache', error: String(err) });
  }
}

/* ==========================================================
   メッセージ処理
   ========================================================== */
self.addEventListener('message', async (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'load':
      await loadModel(message.modelKey);
      break;
    case 'run':
      await run(message);
      break;
    case 'clear-cache':
      await clearCache();
      break;
    default:
      break;
  }
});
