/**
 * ローカル翻訳 — script.js
 *
 * LFM2-350M-ENJP-MT-ONNX を Transformers.js で推論し、
 * ブラウザ完結で日英翻訳を行う。
 */
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  StoppingCriteria,
  env,
} from '@huggingface/transformers';

env.allowLocalModels = false;

/* ==========================================================
   定数
   ========================================================== */
const MODEL_ID = 'onnx-community/LFM2-350M-ENJP-MT-ONNX';
const SYSTEM_EN_TO_JP = 'Translate to Japanese.';
const SYSTEM_JP_TO_EN = 'Translate to English.';
const DEBOUNCE_MS = 400;

/* ==========================================================
   DOM
   ========================================================== */
const $ = (id) => document.getElementById(id);

/* Loading */
const $loadingScreen = $('loading-screen');
const $consentState  = $('consent-state');
const $loadingState  = $('loading-state');
const $consentBtn    = $('consent-btn');
const $status        = $('loading-status');
const $progress      = $('progress-fill');
const $hint          = $('loading-hint');

/* App */
const $appMain       = $('app-main');
const $sourceText    = $('source-text');
const $outputText    = $('output-text');
const $translateBtn  = $('translate-btn');
const $swapBtn       = $('swap-btn');
const $clearBtn      = $('clear-btn');
const $copyBtn       = $('copy-btn');
const $charCount     = $('char-count');
const $realtimeToggle = $('realtime-toggle');
const $modeHint      = $('mode-hint');
const $metricsBar    = $('metrics-bar');
const $speedValue    = $('speed-value');
const $tokensValue   = $('tokens-value');
const $sourceLang    = $('source-lang-label');
const $targetLang    = $('target-lang-label');
const $outputLang    = $('output-lang-label');
const $aboutPanel    = $('about-panel');
const $aboutBtn      = $('about-btn');
const $aboutClose    = $('about-close');

/* ==========================================================
   State
   ========================================================== */
let tokenizer = null;
let model = null;
let direction = 'en-to-jp'; // or 'jp-to-en'
let isTranslating = false;
let abortController = null;
let debounceTimer = null;

/* ==========================================================
   Startup
   ========================================================== */
(function init() {
  $consentBtn.addEventListener('click', async () => {
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';

    try {
      await loadModel();
      showApp();
      setupInteractions();
    } catch (e) {
      console.error('Model loading failed:', e);
      $status.textContent = `エラー: ${e.message}`;
      $hint.textContent = 'ページをリロードしてください。';
      $progress.style.background = '#ef4444';
    }
  });
})();

/* ==========================================================
   Model Loading
   ========================================================== */
async function loadModel() {
  $status.textContent = 'トークナイザーを読み込み中…';
  $progress.style.width = '5%';

  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  $status.textContent = 'AIモデルを読み込み中…';
  $progress.style.width = '15%';

  const progressCb = (p) => {
    if (p.status === 'progress' && p.total) {
      const pct = Math.round((p.loaded / p.total) * 80) + 15;
      $progress.style.width = `${Math.min(pct, 95)}%`;
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      $status.textContent = `ダウンロード中… ${mb(p.loaded)} MB / ${mb(p.total)} MB`;
    } else if (p.status === 'done') {
      $progress.style.width = '95%';
      $status.textContent = 'モデルを初期化中…';
    }
  };

  // Try WebGPU + fp16 first (best performance), fall back to q4 on WASM
  // Note: q8 uses ConvInteger which is unsupported on WASM,
  //       and LFM2's hybrid conv+attention architecture requires this.
  let usedBackend = 'wasm';
  try {
    if (navigator.gpu) {
      $hint.textContent = 'WebGPU で高速モードを試行中…';
      model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
        dtype: 'q4',
        device: 'webgpu',
        progress_callback: progressCb,
      });
      usedBackend = 'webgpu';
    } else {
      throw new Error('WebGPU not available');
    }
  } catch (e) {
    console.warn('WebGPU failed, falling back to WASM + q4:', e.message);
    $progress.style.width = '15%';
    $hint.textContent = 'WASM モードで読み込み中…';
    model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      dtype: 'q4',
      device: 'wasm',
      progress_callback: progressCb,
    });
    usedBackend = 'wasm';
  }

  $progress.style.width = '100%';
  $status.textContent = '準備完了！';
  console.log(`Model loaded with backend: ${usedBackend}`);
}

/* ==========================================================
   Show App
   ========================================================== */
function showApp() {
  $loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    $loadingScreen.style.display = 'none';
    $appMain.style.display = 'block';
  }, 500);
}

/* ==========================================================
   Translation
   ========================================================== */
/**
 * Custom stopping criteria to stop when we encounter <|im_end|> token
 */
class EosStoppingCriteria extends StoppingCriteria {
  constructor(eosTokenId) {
    super();
    this.eosTokenId = eosTokenId;
  }

  _call(inputIds, scores) {
    const lastToken = inputIds[0].at(-1);
    return lastToken === this.eosTokenId;
  }
}

async function translate() {
  const text = $sourceText.value.trim();
  if (!text || !model || !tokenizer) return;
  if (isTranslating) {
    // Abort current + restart
    cancelTranslation();
    await new Promise(r => setTimeout(r, 50));
  }

  isTranslating = true;
  $translateBtn.disabled = true;
  $outputText.innerHTML = '<span class="streaming-cursor"></span>';
  $copyBtn.style.display = 'none';
  $metricsBar.style.display = 'none';

  const systemPrompt = direction === 'en-to-jp' ? SYSTEM_EN_TO_JP : SYSTEM_JP_TO_EN;

  // Build chat prompt with ChatML format
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ];

  const inputText = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  });

  const inputs = tokenizer(inputText, {
    return_tensors: 'pt',
  });

  // Track metrics
  let tokenCount = 0;
  const startTime = performance.now();
  let resultText = '';

  // Streaming callback
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => {
      resultText += text;
      tokenCount++;
      // Update output with cursor
      $outputText.innerHTML =
        escapeHtml(resultText) + '<span class="streaming-cursor"></span>';
      // Update metrics
      const elapsed = (performance.now() - startTime) / 1000;
      const speed = elapsed > 0 ? (tokenCount / elapsed).toFixed(1) : '—';
      $speedValue.textContent = `${speed} tok/s`;
      $tokensValue.textContent = `${tokenCount} tokens`;
      $metricsBar.style.display = 'flex';
    },
  });

  // Find im_end token id
  const imEndId = tokenizer.encode('<|im_end|>', { add_special_tokens: false }).at(-1);
  const stoppingCriteria = new EosStoppingCriteria(imEndId);

  try {
    await model.generate({
      ...inputs,
      max_new_tokens: 512,
      temperature: 0,
      do_sample: false,
      streamer,
      stopping_criteria: [stoppingCriteria],
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Translation error:', e);
      $outputText.innerHTML = `<span style="color:#ef4444">翻訳エラー: ${escapeHtml(e.message)}</span>`;
    }
  }

  // Remove cursor
  const cursor = $outputText.querySelector('.streaming-cursor');
  if (cursor) cursor.remove();

  // Clean up result (remove <|im_end|> if present)
  const cleanResult = resultText.replace(/<\|im_end\|>/g, '').trim();
  if (cleanResult) {
    $outputText.textContent = cleanResult;
    $copyBtn.style.display = 'flex';
  }

  isTranslating = false;
  $translateBtn.disabled = false;
}

function cancelTranslation() {
  // We can't easily abort generation in Transformers.js,
  // but we signal that a new translation should start
  isTranslating = false;
}

/* ==========================================================
   UI Helpers
   ========================================================== */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateDirection() {
  if (direction === 'en-to-jp') {
    $sourceLang.textContent = 'English';
    $targetLang.textContent = '日本語';
    $outputLang.textContent = '日本語';
    $sourceText.placeholder = 'Enter text to translate…';
  } else {
    $sourceLang.textContent = '日本語';
    $targetLang.textContent = 'English';
    $outputLang.textContent = 'English';
    $sourceText.placeholder = '翻訳するテキストを入力…';
  }
}

/* ==========================================================
   Interactions
   ========================================================== */
function setupInteractions() {
  // Translate button
  $translateBtn.addEventListener('click', translate);

  // Keyboard shortcut: Ctrl+Enter to translate
  $sourceText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translate();
    }
  });

  // Swap languages
  $swapBtn.addEventListener('click', () => {
    direction = direction === 'en-to-jp' ? 'jp-to-en' : 'en-to-jp';
    updateDirection();

    // If there's output text, swap it into input
    const outputContent = $outputText.textContent;
    const inputContent = $sourceText.value;
    if (outputContent && !outputContent.includes('翻訳結果がここに表示されます')) {
      $sourceText.value = outputContent;
      $outputText.innerHTML = '<span class="output-placeholder">翻訳結果がここに表示されます</span>';
      $copyBtn.style.display = 'none';
      $metricsBar.style.display = 'none';
      updateCharCount();
    }
  });

  // Clear button
  $clearBtn.addEventListener('click', () => {
    $sourceText.value = '';
    $outputText.innerHTML = '<span class="output-placeholder">翻訳結果がここに表示されます</span>';
    $clearBtn.style.display = 'none';
    $copyBtn.style.display = 'none';
    $metricsBar.style.display = 'none';
    updateCharCount();
    $sourceText.focus();
  });

  // Copy button
  $copyBtn.addEventListener('click', async () => {
    const text = $outputText.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      // Visual feedback
      const origSvg = $copyBtn.innerHTML;
      $copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => { $copyBtn.innerHTML = origSvg; }, 1500);
    } catch (e) {
      console.warn('Clipboard write failed:', e);
    }
  });

  // Char count
  $sourceText.addEventListener('input', () => {
    updateCharCount();
    $clearBtn.style.display = $sourceText.value ? 'flex' : 'none';

    // Realtime translation
    if ($realtimeToggle.checked && $sourceText.value.trim()) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        translate();
      }, DEBOUNCE_MS);
    }
  });

  // Realtime toggle
  $realtimeToggle.addEventListener('change', () => {
    if ($realtimeToggle.checked) {
      $translateBtn.classList.add('hidden');
      $modeHint.textContent = '入力するたびに自動翻訳されます';
      // Trigger immediate translation if there's text
      if ($sourceText.value.trim()) {
        translate();
      }
    } else {
      $translateBtn.classList.remove('hidden');
      $modeHint.textContent = 'タイピングしながらリアルタイムで翻訳';
    }
  });

  // About panel
  $aboutBtn.addEventListener('click', () => {
    $aboutPanel.style.display = $aboutPanel.style.display === 'none' ? 'block' : 'none';
  });
  $aboutClose.addEventListener('click', () => {
    $aboutPanel.style.display = 'none';
  });

  // Initial state
  updateCharCount();
  updateDirection();
}

function updateCharCount() {
  $charCount.textContent = $sourceText.value.length;
}
