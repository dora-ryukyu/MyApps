/**
 * script.js — テキスト→画像生成アプリのメインスレッド制御
 *
 * UI と worker.js のブリッジだけを担当する。
 * 推論・ダウンロードは worker 側で完結する。
 */

import { MODEL_ID, MODEL_BASE_URL } from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');

const $appMain = $('app-main');
const $prompt = $('prompt-input');
const $seed = $('seed-input');
const $randomSeedBtn = $('random-seed-btn');
const $generateBtn = $('generate-btn');
const $clearBtn = $('clear-btn');
const $statusText = $('status-text');
const $errorBox = $('error-box');
const $backendBadge = $('backend-badge');
const $timeBadge = $('time-badge');
const $seedBadge = $('seed-badge');
const $canvas = $('output-canvas');
const $placeholder = $('canvas-placeholder');
const $downloadBtn = $('download-btn');
const $infoBtn = $('info-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

const DEFAULT_PROMPT =
  'vivid impressionist mountain landscape, crystalline turquoise lake, alpine wildflowers, ' +
  'distant snow mountains, dramatic clouds, loose painterly brushwork, impasto texture, ' +
  'expansive peaceful composition';

let worker = null;
let ready = false;
let generating = false;
let hasImage = false;
let backend = '';
let lastObjectUrl = null;

/* ==========================================================
   起動
   ========================================================== */
function createWorker() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function setupWorker() {
  worker = createWorker();

  worker.addEventListener('error', (event) => {
    console.error('worker error:', event);
    showError(`ワーカーでエラーが発生しました: ${event.message || '不明なエラー'}`);
    // ライブラリ読込などでワーカー自体が起動しない場合に再試行できるようにする
    if (!ready) {
      $loadingState.style.display = 'none';
      $consentState.style.display = 'block';
      $consentBtn.disabled = false;
      $consentBtn.textContent = '再試行する';
    }
  });

  worker.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'status':
        $loadingStatus.textContent = message.message || '準備中…';
        break;
      case 'progress':
        handleProgress(message);
        break;
      case 'backend':
        backend = message.backend || '';
        updateBackendBadge(message.backend, message.fp16);
        break;
      case 'ready':
        ready = true;
        $loadingHint.textContent = '準備完了';
        $progressFill.style.width = '100%';
        showApp();
        break;
      case 'result':
        handleResult(message);
        break;
      case 'error':
        handleWorkerError(message);
        break;
      case 'cache-cleared':
        setStatus(`モデルキャッシュを削除しました (${message.removed} 件)`);
        break;
      default:
        break;
    }
  });

  worker.postMessage({ type: 'init' });
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleProgress(message) {
  if (message.stage === 'download') {
    const { overallLoaded = 0, overallTotal = 0, file, fileIndex, fileCount } = message;
    if (overallTotal > 0) {
      const pct = Math.min(99, Math.round((overallLoaded / overallTotal) * 100));
      $progressFill.style.width = `${pct}%`;
    }
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    if (file) {
      $loadingStatus.textContent = `モデルをダウンロード中… (${fileIndex}/${fileCount}) ${file}`;
      if (overallTotal > 0) {
        $loadingHint.textContent = `${mb(overallLoaded)} MB / ${mb(overallTotal)} MB`;
      }
    }
    return;
  }
  if (message.stage === 'tokenizer' && message.total) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    $loadingStatus.textContent = 'トークナイザーを準備中…';
    $loadingHint.textContent = `${mb(message.loaded)} MB / ${mb(message.total)} MB`;
  }
}

function showApp() {
  $loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    $loadingScreen.style.display = 'none';
    $appMain.style.display = 'block';
  }, 400);
}

function handleWorkerError(message) {
  const prefix =
    message.stage === 'generate'
      ? '生成エラー'
      : message.stage === 'cache'
        ? 'キャッシュ操作エラー'
        : '初期化エラー';
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    // 同意画面に戻して再試行できるようにする
    $loadingState.style.display = 'none';
    $consentState.style.display = 'block';
    $consentBtn.disabled = false;
    $consentBtn.textContent = '再試行する';
  } else if (message.stage === 'generate') {
    generating = false;
    setGenerateEnabled(true);
    setStatus('生成に失敗しました');
  }
}

function showError(text) {
  $errorBox.textContent = text;
  $errorBox.style.display = 'block';
}

function clearError() {
  $errorBox.textContent = '';
  $errorBox.style.display = 'none';
}

/* ==========================================================
   生成
   ========================================================== */
function randomSeed() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % 2147483647;
}

function currentPrompt() {
  const value = $prompt.value.trim();
  return value || DEFAULT_PROMPT;
}

function currentSeed() {
  const parsed = Number.parseInt($seed.value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed >>> 0;
  const seed = randomSeed();
  $seed.value = String(seed);
  return seed;
}

function setGenerateEnabled(enabled) {
  $generateBtn.disabled = !enabled;
}

function setStatus(text) {
  $statusText.textContent = text;
}

async function generate() {
  if (!ready || generating) return;
  generating = true;
  clearError();
  setGenerateEnabled(false);
  $downloadBtn.disabled = true;
  setStatus('生成中…');

  const seed = currentSeed();
  worker.postMessage({ type: 'generate', prompt: currentPrompt(), seed });
}

function handleResult(message) {
  const { pixels, width, height, seed, elapsedMs } = message;
  const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
  $canvas.width = width;
  $canvas.height = height;
  const ctx = $canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);

  $placeholder.style.display = 'none';
  $canvas.style.display = 'block';
  hasImage = true;

  $seedBadge.textContent = `seed: ${seed}`;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(1)} 秒`;
  $seed.value = String(seed);

  generating = false;
  setGenerateEnabled(true);
  $downloadBtn.disabled = false;
  setStatus('完成');
}

/* ==========================================================
   ダウンロード / キャッシュ
   ========================================================== */
function downloadImage() {
  if (!hasImage) return;
  $canvas.toBlob((blob) => {
    if (!blob) return;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = lastObjectUrl;
    const seed = $seed.value || 'image';
    a.download = `text-to-image-${seed}-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, 'image/png');
}

function updateBackendBadge(ep, fp16) {
  if (!ep) {
    $backendBadge.textContent = 'バックエンド: 不明';
    return;
  }
  const label = ep === 'webgpu' ? (fp16 ? 'WebGPU (fp16)' : 'WebGPU') : 'WASM (低速)';
  $backendBadge.textContent = `バックエンド: ${label}`;
  if (ep !== 'webgpu') {
    $backendBadge.classList.add('badge-warning');
  }
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function setupUi() {
  $consentBtn.addEventListener('click', () => {
    clearError();
    $consentBtn.disabled = true;
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    $loadingHint.textContent = '初回は約 382 MiB のダウンロードが発生します';
    if (!worker) setupWorker();
  });

  $generateBtn.addEventListener('click', generate);
  $clearBtn.addEventListener('click', () => {
    $prompt.value = '';
    $prompt.focus();
  });

  $prompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      generate();
    }
  });

  $randomSeedBtn.addEventListener('click', () => {
    $seed.value = String(randomSeed());
    setStatus('シードを更新しました');
  });

  $downloadBtn.addEventListener('click', downloadImage);

  $infoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'flex';
  });
  $closeInfoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'none';
  });
  $infoModal.addEventListener('click', (event) => {
    if (event.target === $infoModal) $infoModal.style.display = 'none';
  });

  $clearCacheBtn.addEventListener('click', () => {
    if (!confirm('モデルのキャッシュを削除しますか？\n次回起動時に再ダウンロード（約382MiB）が必要になります。')) return;
    if (worker) worker.postMessage({ type: 'clear-cache' });
  });

  $prompt.value = DEFAULT_PROMPT;
  $seed.value = String(randomSeed());
  setGenerateEnabled(false);
}

setupUi();
