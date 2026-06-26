/**
 * Word2Vec3D — マルチモーダル3D可視化
 *
 * 2つのエンベディングエンジンを切替可能:
 *   ローカル: Transformers.js (Ruri v3 ONNX) — テキストのみ
 *   Gemini:   gemini-embedding-2 REST API   — テキスト+画像+PDF
 *
 * PCA → Three.js で3D空間にプロット。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pipeline, env } from '@huggingface/transformers';

// HuggingFace のモデルキャッシュを IndexedDB に保存
env.cacheDir = undefined;
env.allowLocalModels = false;

/* ==========================================================
   定数
   ========================================================== */
const LOCAL_MODEL_ID = 'keisuke-miyako/ruri-v3-130m-onnx-int8';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2';
const EMBEDDING_DIM = 768;
const BATCH_SIZE = 10;  // Gemini バッチリクエストのサイズ
const IMAGE_MAX_SIZE = 512;  // リサイズ後の長辺px

const WORD_CATEGORIES = {
  '果物':     ['りんご', 'バナナ', 'ぶどう', 'いちご', 'みかん', '梨', 'メロン'],
  '動物':     ['犬', '猫', 'ライオン', '象', 'うさぎ', 'パンダ', 'イルカ'],
  '乗り物':   ['車', '電車', '飛行機', '船', '自転車', 'ロケット'],
  '感情':     ['嬉しい', '悲しい', '怒り', '驚き', '不安', '穏やか'],
  '自然':     ['山', '海', '空', '太陽', '月', '星', '森'],
  '職業':     ['医者', '教師', 'エンジニア', '警察官', '料理人', '芸術家'],
  '文房具':   ['鉛筆', '消しゴム', 'ノート', 'ハサミ', 'ペン', '絵の具'],
  '抽象概念': ['愛', '自由', '時間', '夢', '正義', '勇気'],
};

const CATEGORY_COLORS = {
  '果物':     '#ef4444',
  '動物':     '#f97316',
  '乗り物':   '#eab308',
  '感情':     '#22c55e',
  '自然':     '#06b6d4',
  '職業':     '#3b82f6',
  '文房具':   '#8b5cf6',
  '抽象概念': '#ec4899',
  '入力':     '#ffffff',
  '画像':     '#f472b6',
  'PDF':      '#fb923c',
};

const PLACEHOLDER_TEXTS = [
  '単語を入力… 例: 宇宙、幸せ、コーヒー',
  '単語を入力… 例: 猫、春、音楽',
  '単語を入力… 例: 海、冒険、やさしさ',
  '単語を入力… 例: チョコレート、雨、笑顔',
];

/* ==========================================================
   ベクトルキャッシュ (localStorage)
   同じプリセット単語は決定的に同じベクトルを返すため、
   キャッシュすることで2回目以降のAPI呼び出しをゼロにする。
   ========================================================== */
const CACHE_VERSION = 1;  // プリセット変更時にインクリメント
const CACHE_KEY_LOCAL  = 'w2v3d-cache-local';
const CACHE_KEY_GEMINI = 'w2v3d-cache-gemini';

function getCacheKey() {
  return currentMode === 'local' ? CACHE_KEY_LOCAL : CACHE_KEY_GEMINI;
}

/** キャッシュからプリセットベクトルを読み込む */
function loadPresetCache() {
  try {
    const raw = localStorage.getItem(getCacheKey());
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (cache.version !== CACHE_VERSION || cache.dim !== EMBEDDING_DIM) return null;
    return cache.presets;  // { 'りんご': [...], 'バナナ': [...], ... }
  } catch {
    return null;
  }
}

/** プリセットベクトルをキャッシュに保存 */
function savePresetCache(presetMap) {
  try {
    // 精度を6桁に丸めてサイズ削減 (~40%圧縮)
    const compressed = {};
    for (const [key, vec] of Object.entries(presetMap)) {
      compressed[key] = vec.map(v => Math.round(v * 1e6) / 1e6);
    }
    const cache = {
      version: CACHE_VERSION,
      dim: EMBEDDING_DIM,
      presets: compressed,
    };
    localStorage.setItem(getCacheKey(), JSON.stringify(cache));
  } catch (e) {
    console.warn('Vector cache save failed:', e);
  }
}

/** サーバー（静的ファイル）からプリセットベクトルを読み込む */
async function loadServerPresetCache() {
  const url = currentMode === 'local' ? './data/presets_local.json' : './data/presets_gemini.json';
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const cache = await res.json();
    if (cache.version !== CACHE_VERSION || cache.dim !== EMBEDDING_DIM) return null;
    return cache.presets;
  } catch {
    return null;
  }
}

/** [開発用] 現在のプリセットベクトルをJSONとしてダウンロード */
window.exportPresets = function() {
  const presetWords = new Set();
  for (const list of Object.values(WORD_CATEGORIES)) {
    for (const w of list) presetWords.add(w);
  }

  const presets = {};
  for (const item of allItems) {
    if (item.type === 'text' && item.vector && presetWords.has(item.text)) {
      presets[item.text] = item.vector.map(v => Math.round(v * 1e6) / 1e6);
    }
  }

  const data = {
    version: CACHE_VERSION,
    dim: EMBEDDING_DIM,
    presets
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentMode === 'local' ? 'presets_local.json' : 'presets_gemini.json';
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[Export] ${Object.keys(presets).length} 語のプリセットをエクスポートしました`);
};

/* ==========================================================
   DOM
   ========================================================== */
const $ = (id) => document.getElementById(id);

// ローディング画面
const $loadingScreen   = $('loading-screen');
const $consentState    = $('consent-state');
const $loadingState    = $('loading-state');
const $status          = $('loading-status');
const $progress        = $('progress-fill');
const $hint            = $('loading-hint');

// ローディング画面 — モード選択
const $initModeLocal   = $('init-mode-local');
const $initModeGemini  = $('init-mode-gemini');
const $consentLocal    = $('consent-local');
const $consentGemini   = $('consent-gemini');
const $consentBtnLocal = $('consent-btn-local');
const $consentBtnGemini= $('consent-btn-gemini');
const $initApiKey      = $('init-api-key');
const $initApiKeyToggle= $('init-api-key-toggle');

// メインUI
const $main            = $('app-main');
const $container       = $('canvas-container');
const $form            = $('word-form');
const $input           = $('word-input');
const $addBtn          = $('add-btn');
const $addedWords      = $('added-words');
const $legendBody      = $('legend-body');
const $tooltip         = $('tooltip');
const $tooltipPreview  = $('tooltip-preview');
const $tooltipText     = $('tooltip-text');

// モード切替
const $toggleLocal     = $('toggle-local');
const $toggleGemini    = $('toggle-gemini');
const $modeBadge       = $('mode-badge');

// Gemini設定
const $geminiSettings  = $('gemini-settings');
const $apiKeyInput     = $('api-key-input');
const $apiKeyTest      = $('api-key-test');
const $apiKeyStatus    = $('api-key-status');

// ファイルアップロード
const $fileSection     = $('file-upload-section');
const $fileDropZone    = $('file-drop-zone');
const $fileInput       = $('file-input');

// 再計算オーバーレイ
const $recalcOverlay   = $('recalc-overlay');
const $recalcText      = $('recalc-text');

/* ==========================================================
   State
   ========================================================== */
let currentMode = 'local';         // 'local' | 'gemini'
let geminiApiKey = localStorage.getItem('w2v3d-gemini-key') || '';
let localExtractor = null;         // Transformers.js pipeline (lazy loaded)
let localModelLoaded = false;

let allItems = [];                 // { id, label, type, category, text, base64, mimeType, thumbnail, vector }
let vectors3d = [];                // PCA結果
let scaler = null;
let pcaBasis = null;

// Three.js
let scene, camera, renderer, controls;
let pointObjects = [];
let labelSprites = [];
let raycaster, mouse;
let hoveredIndex = -1;
let categoriesVisible = {};

/* ==========================================================
   エントリーポイント
   ========================================================== */
(function main() {
  // ローディング画面 — モード切替
  $initModeLocal.addEventListener('click', () => selectInitMode('local'));
  $initModeGemini.addEventListener('click', () => selectInitMode('gemini'));

  // APIキー表示切替
  $initApiKeyToggle.addEventListener('click', () => {
    $initApiKey.type = $initApiKey.type === 'password' ? 'text' : 'password';
  });

  // 保存済みAPIキーを復元
  if (geminiApiKey) {
    $initApiKey.value = geminiApiKey;
  }

  // ローカルモード開始
  $consentBtnLocal.addEventListener('click', async () => {
    currentMode = 'local';
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    try {
      await loadLocalModel();
      await encodePresetItems();
      computePCA();
      initThreeJS();
      renderPoints();
      buildLegend();
      showApp();
      setupInteractions();
    } catch (e) {
      console.error('Initialization error:', e);
      $status.textContent = `エラー: ${e.message}`;
      $hint.textContent = 'ページをリロードしてください。';
      $progress.style.background = '#ef4444';
    }
  });

  // Geminiモード開始
  $consentBtnGemini.addEventListener('click', async () => {
    const key = $initApiKey.value.trim();
    if (!key) {
      $initApiKey.focus();
      $initApiKey.style.borderColor = '#ef4444';
      return;
    }
    geminiApiKey = key;
    localStorage.setItem('w2v3d-gemini-key', geminiApiKey);
    currentMode = 'gemini';

    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    $hint.textContent = 'Gemini API に接続しています…';

    try {
      // 接続テスト
      $status.textContent = 'API接続をテスト中…';
      $progress.style.width = '20%';
      const ok = await testGeminiConnection();
      if (!ok) throw new Error('Gemini APIへの接続に失敗しました。APIキーを確認してください。');

      $progress.style.width = '40%';
      await encodePresetItems();
      computePCA();
      initThreeJS();
      renderPoints();
      buildLegend();
      showApp();
      setupInteractions();
      updateModeUI();
    } catch (e) {
      console.error('Gemini init error:', e);
      $status.textContent = `エラー: ${e.message}`;
      $hint.textContent = 'APIキーを確認してページをリロードしてください。';
      $progress.style.background = '#ef4444';
    }
  });
})();

function selectInitMode(mode) {
  $initModeLocal.classList.toggle('active', mode === 'local');
  $initModeGemini.classList.toggle('active', mode === 'gemini');
  $consentLocal.style.display = mode === 'local' ? '' : 'none';
  $consentGemini.style.display = mode === 'gemini' ? '' : 'none';
}

/* ==========================================================
   ローカルエンジン (Ruri v3)
   ========================================================== */
async function loadLocalModel() {
  $status.textContent = 'AIモデルをロードしています…';
  localExtractor = await pipeline('feature-extraction', LOCAL_MODEL_ID, {
    dtype: 'fp32',
    subfolder: '',
    model_file_name: 'model_quantized',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        $progress.style.width = pct + '%';
        const mb = (p.loaded / 1048576).toFixed(0);
        const totalMb = (p.total / 1048576).toFixed(0);
        $status.textContent = `モデルをダウンロード中… ${mb}MB / ${totalMb}MB`;
      } else if (p.status === 'done') {
        $progress.style.width = '100%';
      } else if (p.status === 'initiate') {
        $status.textContent = `${p.file || 'ファイル'}を取得中…`;
      }
    },
  });
  localModelLoaded = true;
  $status.textContent = 'モデルの準備完了！';
  $progress.style.width = '100%';
}

async function embedLocalText(text) {
  const output = await localExtractor([text], { pooling: 'mean', normalize: true });
  const dims = output.dims;
  const vec = [];
  for (let j = 0; j < dims[1]; j++) vec.push(output.data[j]);
  return vec;
}

async function embedLocalBatch(texts) {
  const output = await localExtractor(texts, { pooling: 'mean', normalize: true });
  const dims = output.dims;
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    const vec = [];
    for (let j = 0; j < dims[1]; j++) {
      vec.push(output.data[i * dims[1] + j]);
    }
    vectors.push(vec);
  }
  return vectors;
}

/* ==========================================================
   Gemini エンジン (REST API)
   ========================================================== */
async function testGeminiConnection() {
  try {
    const res = await fetch(`${GEMINI_API_BASE}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body: JSON.stringify({
        content: { parts: [{ text: 'test' }] },
        output_dimensionality: 32,  // 最小サイズでテスト
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function embedGeminiText(text) {
  const prefixed = `task: clustering | query: ${text}`;
  const res = await fetch(`${GEMINI_API_BASE}:embedContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiApiKey,
    },
    body: JSON.stringify({
      content: { parts: [{ text: prefixed }] },
      output_dimensionality: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} - ${err}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

async function embedGeminiInlineData(base64, mimeType) {
  const res = await fetch(`${GEMINI_API_BASE}:embedContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiApiKey,
    },
    body: JSON.stringify({
      content: {
        parts: [{
          inline_data: { mime_type: mimeType, data: base64 },
        }],
      },
      output_dimensionality: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} - ${err}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

async function embedGeminiBatchTexts(texts) {
  // batchEmbedContents で複数テキストを一括処理
  const requests = texts.map(t => ({
    model: 'models/gemini-embedding-2',
    content: { parts: [{ text: `task: clustering | query: ${t}` }] },
    output_dimensionality: EMBEDDING_DIM,
  }));

  const res = await fetch(`${GEMINI_API_BASE}:batchEmbedContents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiApiKey,
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini batch error: ${res.status} - ${err}`);
  }
  const data = await res.json();
  return data.embeddings.map(e => e.values);
}

/* ==========================================================
   統合エンベディングインターフェース
   ========================================================== */
async function embedItem(item) {
  if (currentMode === 'local') {
    if (item.type !== 'text') return null;
    return embedLocalText(item.text);
  } else {
    switch (item.type) {
      case 'text':  return embedGeminiText(item.text);
      case 'image': return embedGeminiInlineData(item.base64, item.mimeType);
      case 'pdf':   return embedGeminiInlineData(item.base64, item.mimeType);
      default:      return null;
    }
  }
}

/* ==========================================================
   ファイル処理
   ========================================================== */
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (Math.max(w, h) > IMAGE_MAX_SIZE) {
          const ratio = IMAGE_MAX_SIZE / Math.max(w, h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        // サムネイル (プレビュー用の data URL)
        const thumbnail = canvas.toDataURL('image/jpeg', 0.7);

        // API送信用の base64 (PNGはJPEGに変換して小さく)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const base64 = dataUrl.split(',')[1];

        resolve({ base64, mimeType: 'image/jpeg', thumbnail, width: w, height: h });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ==========================================================
   プリセット単語のエンコード (キャッシュ対応)
   ========================================================== */
async function encodePresetItems() {
  $status.textContent = '単語をベクトルに変換しています…';

  const words = [];
  const categories = [];
  for (const [cat, list] of Object.entries(WORD_CATEGORIES)) {
    for (const w of list) {
      words.push(w);
      categories.push(cat);
    }
  }

  // キャッシュを確認 (サーバーを最優先、なければLocalStorage)
  let cached = await loadServerPresetCache();
  if (cached) {
    console.log(`[Cache] サーバーから ${currentMode} モードのキャッシュを取得しました`);
  } else {
    cached = loadPresetCache();
    if (cached) console.log(`[Cache] LocalStorage から ${currentMode} モードのキャッシュを取得しました`);
  }

  const allCached = cached && words.every(w => cached[w] && cached[w].length === EMBEDDING_DIM);

  let vectors;

  if (allCached) {
    // キャッシュヒット — API呼び出しゼロ
    console.log(`[Cache] ${currentMode}モードのプリセットベクトル(${words.length}語)をキャッシュから復元`);
    $status.textContent = 'キャッシュからベクトルを復元中…';
    $progress.style.width = '80%';
    vectors = words.map(w => cached[w]);
  } else {
    // キャッシュミス — 計算してキャッシュ保存
    console.log(`[Cache] キャッシュなし — ${currentMode}モードで${words.length}語をエンベディング`);

    if (currentMode === 'local') {
      vectors = await embedLocalBatch(words);
    } else {
      // Geminiモード: バッチで処理
      vectors = [];
      for (let i = 0; i < words.length; i += BATCH_SIZE) {
        const chunk = words.slice(i, i + BATCH_SIZE);
        $status.textContent = `単語をベクトル化中… ${i + chunk.length}/${words.length}`;
        const pct = 40 + Math.round(((i + chunk.length) / words.length) * 55);
        $progress.style.width = pct + '%';

        const chunkVectors = await embedGeminiBatchTexts(chunk);
        vectors.push(...chunkVectors);

        if (i + BATCH_SIZE < words.length) {
          await sleep(200);
        }
      }
    }

    // キャッシュ保存
    const presetMap = {};
    for (let i = 0; i < words.length; i++) {
      presetMap[words[i]] = vectors[i];
    }
    savePresetCache(presetMap);
    console.log(`[Cache] ${words.length}語のプリセットベクトルをキャッシュに保存`);
  }

  for (let i = 0; i < words.length; i++) {
    allItems.push({
      id: crypto.randomUUID(),
      label: words[i],
      type: 'text',
      category: categories[i],
      text: words[i],
      base64: null,
      mimeType: null,
      thumbnail: null,
      vector: vectors[i],
    });
  }

  $status.textContent = 'ベクトル変換完了！';
  $progress.style.width = '100%';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ==========================================================
   PCA (主成分分析) — 自前実装
   ========================================================== */
function computePCA() {
  // ベクトルが存在するアイテムのみ
  const validItems = allItems.filter(it => it.vector !== null);
  if (validItems.length < 3) {
    vectors3d = allItems.map(() => [0, 0, 0]);
    scaler = { mins: [0, 0, 0], maxs: [1, 1, 1] };
    return;
  }

  const n = validItems.length;
  const d = validItems[0].vector.length;
  const data = validItems.map(it => it.vector);

  // 1. 平均を計算
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      mean[j] += data[i][j];
    }
  }
  for (let j = 0; j < d; j++) mean[j] /= n;

  // 2. 中心化
  const centered = data.map(row => row.map((v, j) => v - mean[j]));

  // 3. n×n のグラム行列
  const gram = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let k = 0; k < d; k++) {
        dot += centered[i][k] * centered[j][k];
      }
      gram[i][j] = dot;
      gram[j][i] = dot;
    }
  }

  // 4. べき乗法で上位3固有ベクトル
  const numComponents = 3;
  const eigenVectors = [];
  const eigenValues = [];

  for (let comp = 0; comp < numComponents; comp++) {
    let vec = new Float64Array(n);
    for (let i = 0; i < n; i++) vec[i] = Math.sin(i * 7.13 + comp * 3.17);

    for (const ev of eigenVectors) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += vec[i] * ev[i];
      for (let i = 0; i < n; i++) vec[i] -= dot * ev[i];
    }

    for (let iter = 0; iter < 200; iter++) {
      const newVec = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += gram[i][j] * vec[j];
        newVec[i] = sum;
      }

      for (const ev of eigenVectors) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += newVec[i] * ev[i];
        for (let i = 0; i < n; i++) newVec[i] -= dot * ev[i];
      }

      let norm = 0;
      for (let i = 0; i < n; i++) norm += newVec[i] * newVec[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < n; i++) newVec[i] /= norm;

      vec = newVec;
    }

    let eigenVal = 0;
    const Av = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += gram[i][j] * vec[j];
      Av[i] = sum;
    }
    for (let i = 0; i < n; i++) eigenVal += vec[i] * Av[i];

    eigenVectors.push(vec);
    eigenValues.push(eigenVal);
  }

  // 5. d次元の主成分を復元
  const components = [];
  for (let comp = 0; comp < numComponents; comp++) {
    const pc = new Float64Array(d);
    const scale = 1.0 / Math.sqrt(Math.abs(eigenValues[comp]) + 1e-12);
    for (let j = 0; j < d; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += centered[i][j] * eigenVectors[comp][i];
      }
      pc[j] = sum * scale;
    }
    components.push(pc);
  }

  pcaBasis = { mean, components };

  // 6. 全アイテムを3次元に射影
  vectors3d = allItems.map(it => {
    if (it.vector === null) return [0, 0, 0];
    return projectSingle(it.vector);
  });

  // 7. MinMaxScaler
  computeScaler();
}

function projectSingle(vector) {
  const centered = vector.map((v, j) => v - pcaBasis.mean[j]);
  return pcaBasis.components.map(pc => {
    let dot = 0;
    for (let j = 0; j < pc.length; j++) dot += centered[j] * pc[j];
    return dot;
  });
}

function computeScaler() {
  const validVecs = vectors3d.filter((_, i) => allItems[i].vector !== null);
  if (validVecs.length === 0) {
    scaler = { mins: [0, 0, 0], maxs: [1, 1, 1] };
    return;
  }
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const v of validVecs) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < mins[i]) mins[i] = v[i];
      if (v[i] > maxs[i]) maxs[i] = v[i];
    }
  }
  scaler = { mins, maxs };
}

function normalizePoint(v) {
  return v.map((val, i) => {
    const range = scaler.maxs[i] - scaler.mins[i];
    return range < 1e-12 ? 0.5 : (val - scaler.mins[i]) / range;
  });
}

/* ==========================================================
   Three.js 初期化
   ========================================================== */
function initThreeJS() {
  scene = new THREE.Scene();
  updateSceneBg();

  camera = new THREE.PerspectiveCamera(
    55,
    $container.clientWidth / $container.clientHeight,
    0.1,
    1000
  );
  camera.position.set(3, 2.5, 4);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize($container.clientWidth, $container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  $container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 20;

  addAxes();

  const gridHelper = new THREE.GridHelper(8, 20, 0x444444, 0x333333);
  gridHelper.material.opacity = 0.15;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 0.15 };
  mouse = new THREE.Vector2(-999, -999);

  window.addEventListener('resize', onResize);

  const observer = new MutationObserver(updateSceneBg);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  animate();
}

function updateSceneBg() {
  const theme = document.documentElement.getAttribute('data-theme');
  const isDark = theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  scene.background = new THREE.Color(isDark ? 0x0f1115 : 0xf5f7fa);
}

function addAxes() {
  const len = 4;
  const axes = [
    { dir: [len, 0, 0], color: 0xff4444, label: 'PC1' },
    { dir: [0, len, 0], color: 0x44ff44, label: 'PC2' },
    { dir: [0, 0, len], color: 0x4444ff, label: 'PC3' },
  ];
  for (const a of axes) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(...a.dir),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: a.color, transparent: true, opacity: 0.25 });
    scene.add(new THREE.Line(geo, mat));
  }
}

function onResize() {
  const w = $container.clientWidth;
  const h = $container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  raycaster.setFromCamera(mouse, camera);
  const hoverTargets = pointObjects.filter(o => o.userData.isPoint);
  const intersects = raycaster.intersectObjects(hoverTargets);

  if (intersects.length > 0) {
    const idx = intersects[0].object.userData.index;
    if (idx !== hoveredIndex) {
      hoveredIndex = idx;
      const item = allItems[idx];
      $tooltipText.textContent = item.label;

      // 画像プレビュー表示
      if (item.thumbnail) {
        $tooltipPreview.src = item.thumbnail;
        $tooltipPreview.style.display = '';
        $tooltip.classList.add('has-preview');
      } else {
        $tooltipPreview.style.display = 'none';
        $tooltip.classList.remove('has-preview');
      }
      $tooltip.classList.add('visible');
    }
  } else {
    if (hoveredIndex !== -1) {
      hoveredIndex = -1;
      $tooltip.classList.remove('visible');
    }
  }

  renderer.render(scene, camera);
}

/* ==========================================================
   3D ポイント描画
   ========================================================== */
// テクスチャキャッシュ (画像サムネイルを再利用)
const thumbnailTextureCache = new Map();

function renderPoints() {
  for (const obj of pointObjects) scene.remove(obj);
  for (const spr of labelSprites) scene.remove(spr);
  pointObjects = [];
  labelSprites = [];

  const SCALE = 3;

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    if (item.vector === null) continue;  // ベクトルなし (ローカルモードの画像など)

    const v = vectors3d[i];
    const norm = normalizePoint(v);
    const isUser = ['入力', '画像', 'PDF'].includes(item.category);
    const visible = categoriesVisible[item.category] !== false;

    const x = (norm[0] - 0.5) * 2 * SCALE;
    const y = (norm[1] - 0.5) * 2 * SCALE;
    const z = (norm[2] - 0.5) * 2 * SCALE;

    // 色
    const colorHex = CATEGORY_COLORS[item.category] || '#888888';
    let color;
    if (item.category === '入力' && item.type === 'text') {
      const r = Math.round(norm[0] * 255);
      const g = Math.round(norm[1] * 255);
      const b = Math.round(norm[2] * 255);
      color = new THREE.Color(`rgb(${r},${g},${b})`);
    } else {
      color = new THREE.Color(colorHex);
    }

    // 画像アイテム: サムネイルビルボード
    if (item.type === 'image' && item.thumbnail) {
      const sprite = makeImageSprite(item.thumbnail, item.id);
      sprite.position.set(x, y, z);
      sprite.material.opacity = visible ? 1.0 : 0.05;
      sprite.material.transparent = true;
      sprite.userData = { isPoint: true, index: i };
      scene.add(sprite);
      pointObjects.push(sprite);
    } else {
      // テキスト/PDF: 球体
      const radius = isUser ? 0.1 : 0.06;
      const geo = new THREE.SphereGeometry(radius, 16, 12);
      const mat = new THREE.MeshPhongMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.2),
        shininess: 60,
        transparent: true,
        opacity: visible ? (isUser ? 1.0 : 0.85) : 0.05,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.userData = { isPoint: true, index: i };
      scene.add(mesh);
      pointObjects.push(mesh);

      // ユーザー入力のリング
      if (isUser) {
        const ringGeo = new THREE.RingGeometry(0.12, 0.15, 24);
        const ringMat = new THREE.MeshBasicMaterial({
          color: item.type === 'pdf' ? 0xfb923c : 0xffffff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: visible ? 0.6 : 0.05,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(x, y, z);
        ring.lookAt(camera.position);
        scene.add(ring);
        pointObjects.push(ring);
      }
    }

    // テキストラベル
    const sprite = makeTextSprite(item.label, {
      color: colorHex,
      size: isUser ? 18 : 14,
      bold: isUser,
    });
    sprite.position.set(x, y + (item.type === 'image' ? 0.28 : isUser ? 0.18 : 0.12), z);
    sprite.material.opacity = visible ? 1 : 0.05;
    sprite.material.transparent = true;
    scene.add(sprite);
    labelSprites.push(sprite);
  }
}

function makeImageSprite(thumbnailDataUrl, itemId) {
  // キャッシュチェック
  if (thumbnailTextureCache.has(itemId)) {
    const tex = thumbnailTextureCache.get(itemId);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.4, 0.4, 1);
    return sprite;
  }

  // canvas で角丸ボーダー付きサムネイルを作成
  const canvas = document.createElement('canvas');
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.src = thumbnailDataUrl;

  // 画像がすでにロード済みか確認
  if (img.complete) {
    drawImageToCanvas(ctx, img, size);
  } else {
    // 仮の色付き四角を描画、画像ロード後に更新
    ctx.fillStyle = '#f472b6';
    roundRect(ctx, 4, 4, size - 8, size - 8, 12);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  thumbnailTextureCache.set(itemId, tex);

  // 画像がまだロードされてない場合、ロード完了時にテクスチャ更新
  if (!img.complete) {
    img.onload = () => {
      drawImageToCanvas(ctx, img, size);
      tex.needsUpdate = true;
    };
  }

  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.4, 1);
  return sprite;
}

function drawImageToCanvas(ctx, img, size) {
  const padding = 4;
  const radius = 12;
  const innerSize = size - padding * 2;

  ctx.clearRect(0, 0, size, size);

  // 背景
  ctx.fillStyle = 'rgba(20, 20, 30, 0.7)';
  roundRect(ctx, 0, 0, size, size, radius + 2);
  ctx.fill();

  // クリッピングして画像描画
  ctx.save();
  roundRect(ctx, padding, padding, innerSize, innerSize, radius);
  ctx.clip();

  // アスペクト比を維持してカバー
  const aspect = img.width / img.height;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (aspect > 1) {
    sx = (img.width - img.height) / 2;
    sw = img.height;
  } else {
    sy = (img.height - img.width) / 2;
    sh = img.width;
  }
  ctx.drawImage(img, sx, sy, sw, sh, padding, padding, innerSize, innerSize);
  ctx.restore();

  // ボーダー
  ctx.strokeStyle = 'rgba(244, 114, 182, 0.8)';
  ctx.lineWidth = 2;
  roundRect(ctx, padding, padding, innerSize, innerSize, radius);
  ctx.stroke();
}

function makeTextSprite(text, opts = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = opts.size || 14;
  const font = `${opts.bold ? '700' : '500'} ${fontSize * 4}px "Noto Sans JP", "DM Sans", sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const padding = fontSize * 2;

  canvas.width = textWidth + padding * 2;
  canvas.height = fontSize * 6;

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const bgAlpha = opts.bold ? 0.7 : 0.5;
  ctx.fillStyle = `rgba(20, 20, 30, ${bgAlpha})`;
  const bgRadius = fontSize * 1.5;
  roundRect(ctx, 0, canvas.height / 2 - bgRadius, canvas.width, bgRadius * 2, bgRadius * 0.4);
  ctx.fill();

  ctx.fillStyle = opts.color || '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  const aspect = canvas.width / canvas.height;
  const spriteScale = (opts.bold ? 0.7 : 0.5);
  sprite.scale.set(spriteScale * aspect, spriteScale, 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ==========================================================
   凡例
   ========================================================== */
function buildLegend() {
  $legendBody.innerHTML = '';

  const categories = [...Object.keys(CATEGORY_COLORS)];
  // 実際に使われているカテゴリだけ表示
  const usedCategories = new Set(allItems.filter(it => it.vector !== null).map(it => it.category));

  for (const cat of categories) {
    if (!usedCategories.has(cat)) continue;
    if (categoriesVisible[cat] === undefined) categoriesVisible[cat] = true;

    const item = document.createElement('div');
    item.className = 'legend-item' + (categoriesVisible[cat] ? '' : ' dimmed');
    item.innerHTML = `<span class="legend-dot" style="background:${CATEGORY_COLORS[cat]}"></span>${cat}`;
    item.addEventListener('click', () => {
      categoriesVisible[cat] = !categoriesVisible[cat];
      item.classList.toggle('dimmed', !categoriesVisible[cat]);
      renderPoints();
    });
    $legendBody.appendChild(item);
  }
}

/* ==========================================================
   画面表示
   ========================================================== */
function showApp() {
  $loadingScreen.classList.add('fade-out');
  $main.style.display = '';
  onResize();
  setTimeout(() => { $loadingScreen.style.display = 'none'; }, 600);
}

/* ==========================================================
   モード切替UI
   ========================================================== */
function updateModeUI() {
  const isGemini = currentMode === 'gemini';
  $toggleLocal.classList.toggle('active', !isGemini);
  $toggleGemini.classList.toggle('active', isGemini);
  $geminiSettings.style.display = isGemini ? '' : 'none';
  $fileSection.style.display = isGemini ? '' : 'none';
  $modeBadge.textContent = isGemini ? 'Gemini' : 'ローカル';

  // APIキーを復元
  if (isGemini && geminiApiKey) {
    $apiKeyInput.value = geminiApiKey;
  }

  // プレースホルダーを変更
  $input.placeholder = isGemini
    ? '単語を入力… 例: かわいい、宇宙、猫'
    : PLACEHOLDER_TEXTS[Math.floor(Math.random() * PLACEHOLDER_TEXTS.length)];
}

async function switchMode(newMode) {
  if (newMode === currentMode) return;

  // Geminiに切り替える場合はAPIキーチェック
  if (newMode === 'gemini') {
    const key = $apiKeyInput.value.trim() || geminiApiKey;
    if (!key) {
      $apiKeyStatus.textContent = 'APIキーを入力してください';
      $apiKeyStatus.className = 'api-key-status error';
      return;
    }
    geminiApiKey = key;
    localStorage.setItem('w2v3d-gemini-key', geminiApiKey);
  }

  // ローカルモデルがまだロードされてない場合
  if (newMode === 'local' && !localModelLoaded) {
    $recalcOverlay.style.display = '';
    $recalcText.textContent = 'ローカルモデルをダウンロード中…';
    try {
      await loadLocalModel();
    } catch (e) {
      $recalcText.textContent = `エラー: ${e.message}`;
      await sleep(2000);
      $recalcOverlay.style.display = 'none';
      return;
    }
  }

  currentMode = newMode;
  updateModeUI();

  // 全データ再計算
  $recalcOverlay.style.display = '';
  $recalcText.textContent = '全データ再計算中…';

  try {
    // ベクトルをクリア
    for (const item of allItems) {
      item.vector = null;
    }
    thumbnailTextureCache.clear();

    // 再エンベディング (キャッシュ活用)
    const textItems = allItems.filter(it => it.type === 'text');
    const mediaItems = allItems.filter(it => it.type !== 'text');

    // プリセット単語のキャッシュ確認 (サーバー優先)
    let cached = await loadServerPresetCache();
    if (!cached) cached = loadPresetCache();
    const presetWords = new Set();
    for (const list of Object.values(WORD_CATEGORIES)) {
      for (const w of list) presetWords.add(w);
    }

    // テキストをプリセット(キャッシュ可能)とユーザー入力に分離
    const presetTextItems = textItems.filter(it => presetWords.has(it.text));
    const userTextItems = textItems.filter(it => !presetWords.has(it.text));

    // プリセット: キャッシュがあれば使う
    let presetCacheHit = 0;
    if (cached) {
      for (const item of presetTextItems) {
        if (cached[item.text] && cached[item.text].length === EMBEDDING_DIM) {
          item.vector = cached[item.text];
          presetCacheHit++;
        }
      }
    }
    const uncachedPresets = presetTextItems.filter(it => it.vector === null);
    console.log(`[Cache] プリセット: ${presetCacheHit}語キャッシュヒット, ${uncachedPresets.length}語要計算`);

    // 未キャッシュのプリセット + ユーザー入力テキストをまとめて計算
    const needEmbed = [...uncachedPresets, ...userTextItems];

    if (needEmbed.length > 0) {
      if (currentMode === 'local') {
        const texts = needEmbed.map(it => it.text);
        $recalcText.textContent = `テキストを再計算中… 0/${texts.length}`;
        const vectors = await embedLocalBatch(texts);
        for (let i = 0; i < needEmbed.length; i++) {
          needEmbed[i].vector = vectors[i];
        }
      } else {
        const texts = needEmbed.map(it => it.text);
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          const chunk = texts.slice(i, i + BATCH_SIZE);
          $recalcText.textContent = `テキストを再計算中… ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}`;
          const chunkVectors = await embedGeminiBatchTexts(chunk);
          for (let j = 0; j < chunk.length; j++) {
            needEmbed[i + j].vector = chunkVectors[j];
          }
          if (i + BATCH_SIZE < texts.length) await sleep(200);
        }
      }

      // 新たに計算したプリセット分をキャッシュに追加保存
      const newPresetMap = {};
      for (const item of presetTextItems) {
        if (item.vector) newPresetMap[item.text] = item.vector;
      }
      if (Object.keys(newPresetMap).length > 0) {
        savePresetCache(newPresetMap);
      }
    }

    // 画像/PDFを個別処理 (Geminiモードのみ)
    if (currentMode === 'gemini') {
      for (let i = 0; i < mediaItems.length; i++) {
        $recalcText.textContent = `メディアを再計算中… ${i + 1}/${mediaItems.length}`;
        try {
          mediaItems[i].vector = await embedItem(mediaItems[i]);
        } catch (e) {
          console.error(`Failed to embed media item: ${mediaItems[i].label}`, e);
          mediaItems[i].vector = null;
        }
        if (i + 1 < mediaItems.length) await sleep(200);
      }
    }

    // PCA再計算
    computePCA();
    renderPoints();
    buildLegend();
  } catch (e) {
    console.error('Mode switch error:', e);
    $recalcText.textContent = `エラー: ${e.message}`;
    await sleep(2000);
  } finally {
    $recalcOverlay.style.display = 'none';
  }
}

/* ==========================================================
   インタラクション
   ========================================================== */
function setupInteractions() {
  updateModeUI();

  // 単語追加フォーム
  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = $input.value.trim();
    if (!word) return;

    $addBtn.disabled = true;
    $addBtn.textContent = '処理中…';

    try {
      const item = {
        id: crypto.randomUUID(),
        label: word,
        type: 'text',
        category: '入力',
        text: word,
        base64: null,
        mimeType: null,
        thumbnail: null,
        vector: null,
      };

      item.vector = await embedItem(item);
      if (!item.vector) throw new Error('ベクトル化に失敗しました');

      allItems.push(item);
      vectors3d.push(projectSingle(item.vector));
      computeScaler();
      renderPoints();
      buildLegend();

      addItemTag(item);
      $input.value = '';
    } catch (err) {
      console.error('Error adding word:', err);
      alert(`エラー: ${err.message}`);
    } finally {
      $addBtn.disabled = false;
      $addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>追加';
    }
  });

  // モード切替ボタン
  $toggleLocal.addEventListener('click', () => switchMode('local'));
  $toggleGemini.addEventListener('click', () => {
    // まずGemini設定を表示
    if (currentMode !== 'gemini') {
      $geminiSettings.style.display = '';
      $fileSection.style.display = '';
      $toggleLocal.classList.remove('active');
      $toggleGemini.classList.add('active');
      // APIキーが既にあれば自動切替
      const key = $apiKeyInput.value.trim() || geminiApiKey;
      if (key) {
        switchMode('gemini');
      }
    }
  });

  // APIキーテスト
  $apiKeyTest.addEventListener('click', async () => {
    const key = $apiKeyInput.value.trim();
    if (!key) {
      $apiKeyStatus.textContent = 'APIキーを入力してください';
      $apiKeyStatus.className = 'api-key-status error';
      return;
    }
    geminiApiKey = key;
    localStorage.setItem('w2v3d-gemini-key', geminiApiKey);

    $apiKeyStatus.textContent = 'テスト中…';
    $apiKeyStatus.className = 'api-key-status';

    const ok = await testGeminiConnection();
    if (ok) {
      $apiKeyStatus.textContent = '✓ 接続成功';
      $apiKeyStatus.className = 'api-key-status success';
      if (currentMode !== 'gemini') {
        switchMode('gemini');
      }
    } else {
      $apiKeyStatus.textContent = '✕ 接続失敗 — キーを確認してください';
      $apiKeyStatus.className = 'api-key-status error';
    }
  });

  // ファイルアップロード
  $fileDropZone.addEventListener('click', () => $fileInput.click());
  $fileInput.addEventListener('change', () => {
    if ($fileInput.files.length > 0) handleFiles($fileInput.files);
    $fileInput.value = '';
  });

  // ドラッグ&ドロップ
  $fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    $fileDropZone.classList.add('drag-over');
  });
  $fileDropZone.addEventListener('dragleave', () => {
    $fileDropZone.classList.remove('drag-over');
  });
  $fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    $fileDropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  });

  // マウストラッキング (ホバー)
  $container.addEventListener('mousemove', (e) => {
    const rect = $container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    $tooltip.style.left = (e.clientX + 12) + 'px';
    $tooltip.style.top = (e.clientY - 28) + 'px';
  });

  $container.addEventListener('mouseleave', () => {
    mouse.set(-999, -999);
    hoveredIndex = -1;
    $tooltip.classList.remove('visible');
  });

  // パネル折りたたみ
  $('panel-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $('input-panel').classList.toggle('collapsed');
  });
  $('input-panel-header')?.addEventListener('click', (e) => {
    if (e.target.closest('.panel-toggle') || e.target.closest('.mode-toggle')) return;
    $('input-panel').classList.toggle('collapsed');
  });

  $('legend-toggle').addEventListener('click', () => {
    $('legend-panel').classList.toggle('collapsed');
  });
  document.querySelector('.legend-header')?.addEventListener('click', (e) => {
    if (e.target.closest('.legend-toggle')) return;
    $('legend-panel').classList.toggle('collapsed');
  });

  // About パネル
  const $aboutPanel = $('about-panel');
  $('about-btn')?.addEventListener('click', () => {
    $aboutPanel.style.display = $aboutPanel.style.display === 'none' ? '' : 'none';
  });
  $('about-close')?.addEventListener('click', () => {
    $aboutPanel.style.display = 'none';
  });
}

/* ==========================================================
   ファイル処理
   ========================================================== */
async function handleFiles(fileList) {
  if (currentMode !== 'gemini') {
    alert('ファイルの追加は Gemini モードでのみ利用可能です。');
    return;
  }

  for (const file of fileList) {
    const type = file.type;

    if (type === 'image/png' || type === 'image/jpeg') {
      await handleImageFile(file);
    } else if (type === 'application/pdf') {
      await handlePdfFile(file);
    } else {
      alert(`未対応のファイル形式です: ${type}\n対応形式: PNG, JPEG, PDF`);
    }
  }
}

async function handleImageFile(file) {
  $addBtn.disabled = true;

  try {
    const { base64, mimeType, thumbnail } = await resizeImage(file);

    const item = {
      id: crypto.randomUUID(),
      label: file.name.replace(/\.[^.]+$/, ''),
      type: 'image',
      category: '画像',
      text: null,
      base64,
      mimeType,
      thumbnail,
      vector: null,
    };

    item.vector = await embedGeminiInlineData(base64, mimeType);
    allItems.push(item);
    vectors3d.push(projectSingle(item.vector));
    computeScaler();
    renderPoints();
    buildLegend();
    addItemTag(item);
  } catch (err) {
    console.error('Error adding image:', err);
    alert(`画像の処理中にエラー: ${err.message}`);
  } finally {
    $addBtn.disabled = false;
  }
}

async function handlePdfFile(file) {
  $addBtn.disabled = true;

  try {
    const base64 = await readFileAsBase64(file);

    const item = {
      id: crypto.randomUUID(),
      label: file.name,
      type: 'pdf',
      category: 'PDF',
      text: null,
      base64,
      mimeType: 'application/pdf',
      thumbnail: null,
      vector: null,
    };

    item.vector = await embedGeminiInlineData(base64, 'application/pdf');
    allItems.push(item);
    vectors3d.push(projectSingle(item.vector));
    computeScaler();
    renderPoints();
    buildLegend();
    addItemTag(item);
  } catch (err) {
    console.error('Error adding PDF:', err);
    alert(`PDFの処理中にエラー: ${err.message}\n※PDFは1ファイル最大6ページまでです`);
  } finally {
    $addBtn.disabled = false;
  }
}

/* ==========================================================
   タグ表示
   ========================================================== */
function addItemTag(item) {
  const tag = document.createElement('span');
  tag.className = 'added-word-tag';

  if (item.type === 'image') {
    tag.classList.add('image-tag');
    if (item.thumbnail) {
      const thumb = document.createElement('img');
      thumb.src = item.thumbnail;
      thumb.className = 'tag-thumb';
      thumb.alt = item.label;
      tag.appendChild(thumb);
    }
  } else if (item.type === 'pdf') {
    tag.classList.add('pdf-tag');
  }

  const labelText = document.createTextNode(item.label);
  tag.appendChild(labelText);
  tag.title = item.label;

  $addedWords.appendChild(tag);
}
