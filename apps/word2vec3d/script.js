/**
 * Word2Vec3D — 単語ベクトル3D可視化
 *
 * Transformers.js (ONNX Runtime Web) でベクトル化し、
 * PCA→Three.js で3D空間にプロットする。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pipeline, env } from '@huggingface/transformers';

// HuggingFace のモデルキャッシュを IndexedDB に保存
env.cacheDir = undefined; // ブラウザデフォルト (IndexedDB) を使う
env.allowLocalModels = false;

/* ==========================================================
   定数
   ========================================================== */
const MODEL_ID = 'keisuke-miyako/ruri-v3-130m-onnx-int8';

const WORD_CATEGORIES = {
  '果物':   ['りんご', 'バナナ', 'ぶどう', 'いちご', '桃', 'みかん', '梨', '柿', 'さくらんぼ', 'メロン'],
  '動物':   ['犬', '猫', 'ライオン', '象', 'うさぎ', 'パンダ', 'キリン', 'シマウマ', 'ペンギン', 'イルカ'],
  '乗り物': ['車', '電車', '飛行機', '船', '自転車', '新幹線', 'ロケット', 'バス', 'トラック', 'オートバイ'],
  '感情':   ['嬉しい', '悲しい', '怒り', '楽しい', '驚き', '絶望', '興奮', '不安', '穏やか', '退屈'],
  '自然':   ['山', '海', '空', '太陽', '月', '星', '雲', '雷', '川', '森'],
  '職業':   ['医者', '教師', 'エンジニア', '警察官', '消防士', '弁護士', '宇宙飛行士', '料理人', '芸術家', '農家'],
  '文房具': ['鉛筆', '消しゴム', 'ノート', '定規', 'ハサミ', 'ペン', 'のり', '絵の具', 'クレヨン', 'コンパス'],
  '抽象概念': ['愛', '平和', '自由', '時間', '夢', '知識', '正義', '真実', '幸福', '勇気'],
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
};

const USER_COLOR = '#ffffff';

/* ==========================================================
   DOM
   ========================================================== */
/* ==========================================================
   DOM
   ========================================================== */
const $loadingScreen = document.getElementById('loading-screen');
const $consentState  = document.getElementById('consent-state');
const $consentBtn    = document.getElementById('consent-btn');

const $loadingState  = document.getElementById('loading-state');
const $status        = document.getElementById('loading-status');
const $progress      = document.getElementById('progress-fill');
const $hint          = document.getElementById('loading-hint');

const $main       = document.getElementById('app-main');
const $container  = document.getElementById('canvas-container');
const $form       = document.getElementById('word-form');
const $input      = document.getElementById('word-input');
const $addBtn     = document.getElementById('add-btn');
const $addedWords = document.getElementById('added-words');
const $legendBody = document.getElementById('legend-body');
const $tooltip    = document.getElementById('tooltip');

/* ==========================================================
   State
   ========================================================== */
let extractor = null;       // Transformers.js pipeline
let allWords = [];          // { word, category, vector }
let vectors3d = [];         // PCA結果
let scaler = null;          // MinMaxScaler の min/max
let pcaBasis = null;        // PCA の射影行列 (mean, components)
let scene, camera, renderer, controls;
let pointObjects = [];      // Three.js のオブジェクト
let labelSprites = [];
let raycaster, mouse;
let hoveredIndex = -1;
let categoriesVisible = {};

/* ==========================================================
   エントリーポイント
   ========================================================== */
(function main() {
  // 同意ボタンのイベントリスナー
  $consentBtn.addEventListener('click', async () => {
    // UIをロード中モードに切り替え
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';

    try {
      await loadModel();
      await encodePresetWords();
      computePCA();
      initThreeJS();
      renderPoints();
      buildLegend();
      showApp();
      setupInteractions();
    } catch (e) {
      console.error('Initialization error:', e);
      $status.textContent = `エラーが発生しました: ${e.message}`;
      $hint.textContent = 'ページをリロードしてください。';
      $progress.style.background = '#ef4444'; 
    }
  });
})();

/* ==========================================================
   モデルのロード
   ========================================================== */
async function loadModel() {
  $status.textContent = 'AIモデルをロードしています…';

  // dtype はファイル名のサフィックス制御に使われる（'fp32' = サフィックスなし）
  // モデル自体は INT8 量子化済みで、ONNX Runtime が内部のデータ型に従い正しく推論する
  extractor = await pipeline('feature-extraction', MODEL_ID, {
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

  $status.textContent = 'モデルの準備完了！';
  $progress.style.width = '100%';
}

/* ==========================================================
   プリセット単語のベクトル化
   ========================================================== */
async function encodePresetWords() {
  $status.textContent = '単語をベクトルに変換しています…';

  const words = [];
  const categories = [];
  for (const [cat, list] of Object.entries(WORD_CATEGORIES)) {
    for (const w of list) {
      words.push(w);
      categories.push(cat);
    }
  }

  // バッチ処理（全単語を一度にエンコード）
  const outputs = await extractor(words, { pooling: 'mean', normalize: true });
  const dims = outputs.dims; // [N, hidden_dim]

  for (let i = 0; i < words.length; i++) {
    const vec = [];
    for (let j = 0; j < dims[1]; j++) {
      vec.push(outputs.data[i * dims[1] + j]);
    }
    allWords.push({ word: words[i], category: categories[i], vector: vec });
  }
}

/* ==========================================================
   PCA (主成分分析) — 自前実装
   ========================================================== */
function computePCA() {
  const n = allWords.length;
  const d = allWords[0].vector.length;
  const data = allWords.map(w => w.vector);

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

  // 3. 共分散行列 (d×d は大きすぎるので、n×n のグラム行列を使う)
  //    n << d のとき、n×n のグラム行列の固有ベクトルから d次元の主成分を復元
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

  // 4. べき乗法で上位3固有ベクトルを求める
  const numComponents = 3;
  const eigenVectors = []; // n次元の固有ベクトル
  const eigenValues = [];

  for (let comp = 0; comp < numComponents; comp++) {
    let vec = new Float64Array(n);
    // ランダム初期化 (シード固定的に)
    for (let i = 0; i < n; i++) vec[i] = Math.sin(i * 7.13 + comp * 3.17);

    // デフレーション: 既知の固有ベクトル成分を除去
    for (const ev of eigenVectors) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += vec[i] * ev[i];
      for (let i = 0; i < n; i++) vec[i] -= dot * ev[i];
    }

    for (let iter = 0; iter < 200; iter++) {
      // 行列ベクトル積
      const newVec = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += gram[i][j] * vec[j];
        newVec[i] = sum;
      }

      // デフレーション
      for (const ev of eigenVectors) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += newVec[i] * ev[i];
        for (let i = 0; i < n; i++) newVec[i] -= dot * ev[i];
      }

      // 正規化
      let norm = 0;
      for (let i = 0; i < n; i++) norm += newVec[i] * newVec[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < n; i++) newVec[i] /= norm;

      vec = newVec;
    }

    // 固有値
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

  // 5. d次元の主成分を復元: pc_j = (1/sqrt(λ_j)) * X^T * v_j
  const components = []; // 3 x d
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

  // 6. 全単語を3次元に射影
  vectors3d = projectPCA(data);

  // 7. MinMaxScaler を計算（RGB マッピング用）
  computeScaler();
}

function projectPCA(data) {
  const result = [];
  for (const row of data) {
    const centered = row.map((v, j) => v - pcaBasis.mean[j]);
    const coords = pcaBasis.components.map(pc => {
      let dot = 0;
      for (let j = 0; j < pc.length; j++) dot += centered[j] * pc[j];
      return dot;
    });
    result.push(coords);
  }
  return result;
}

function computeScaler() {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const v of vectors3d) {
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

  // テーマに応じた背景色
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

  // 軸ヘルパー (薄い)
  addAxes();

  // グリッド
  const gridHelper = new THREE.GridHelper(8, 20, 0x444444, 0x333333);
  gridHelper.material.opacity = 0.15;
  gridHelper.material.transparent = true;
  scene.add(gridHelper);

  // ライティング
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  // レイキャスター
  raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 0.15 };
  mouse = new THREE.Vector2(-999, -999);

  // リサイズ
  window.addEventListener('resize', onResize);

  // テーマ変化を監視
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

  // レイキャスト (ホバー)
  raycaster.setFromCamera(mouse, camera);
  const spheres = pointObjects.filter(o => o.userData.isPoint);
  const intersects = raycaster.intersectObjects(spheres);

  if (intersects.length > 0) {
    const idx = intersects[0].object.userData.index;
    if (idx !== hoveredIndex) {
      hoveredIndex = idx;
      $tooltip.textContent = allWords[idx].word;
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
function renderPoints() {
  // 既存のオブジェクトを削除
  for (const obj of pointObjects) scene.remove(obj);
  for (const spr of labelSprites) scene.remove(spr);
  pointObjects = [];
  labelSprites = [];

  // データの3D座標をスケーリング (空間内に収まるように)
  const SCALE = 3;

  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    const v = vectors3d[i];
    const norm = normalizePoint(v);
    const isUser = w.category === '入力';
    const visible = categoriesVisible[w.category] !== false;

    // 座標 (正規化座標を -SCALE ~ +SCALE にマッピング)
    const x = (norm[0] - 0.5) * 2 * SCALE;
    const y = (norm[1] - 0.5) * 2 * SCALE;
    const z = (norm[2] - 0.5) * 2 * SCALE;

    // 色
    let color;
    if (isUser) {
      // ユーザー入力: RGBマッピング
      const r = Math.round(norm[0] * 255);
      const g = Math.round(norm[1] * 255);
      const b = Math.round(norm[2] * 255);
      color = new THREE.Color(`rgb(${r},${g},${b})`);
    } else {
      color = new THREE.Color(CATEGORY_COLORS[w.category] || '#888888');
    }

    // 球体
    const geo = new THREE.SphereGeometry(isUser ? 0.1 : 0.06, 16, 12);
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

    // ユーザー入力の場合はリングを追加
    if (isUser) {
      const ringGeo = new THREE.RingGeometry(0.12, 0.15, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
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

    // テキストラベル (canvas → sprite)
    const sprite = makeTextSprite(w.word, {
      color: isUser ? '#ffffff' : CATEGORY_COLORS[w.category] || '#888888',
      size: isUser ? 18 : 14,
      bold: isUser,
    });
    sprite.position.set(x, y + (isUser ? 0.18 : 0.12), z);
    sprite.material.opacity = visible ? 1 : 0.05;
    sprite.material.transparent = true;
    scene.add(sprite);
    labelSprites.push(sprite);
  }
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

  // 背景 (半透明の暗い背景)
  const bgAlpha = opts.bold ? 0.7 : 0.5;
  ctx.fillStyle = `rgba(20, 20, 30, ${bgAlpha})`;
  const bgRadius = fontSize * 1.5;
  roundRect(ctx, 0, canvas.height / 2 - bgRadius, canvas.width, bgRadius * 2, bgRadius * 0.4);
  ctx.fill();

  // テキスト
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
  // ユーザー入力カテゴリが存在すれば追加
  if (allWords.some(w => w.category === '入力')) {
    categories.push('入力');
  }

  for (const cat of categories) {
    if (categoriesVisible[cat] === undefined) categoriesVisible[cat] = true;

    const item = document.createElement('div');
    item.className = 'legend-item' + (categoriesVisible[cat] ? '' : ' dimmed');
    item.innerHTML = `<span class="legend-dot" style="background:${cat === '入力' ? USER_COLOR : CATEGORY_COLORS[cat]}"></span>${cat}`;
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
   インタラクション
   ========================================================== */
function setupInteractions() {
  // 単語追加フォーム
  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = $input.value.trim();
    if (!word) return;

    $addBtn.disabled = true;
    $addBtn.textContent = '処理中…';

    try {
      // ベクトル化
      const output = await extractor([word], { pooling: 'mean', normalize: true });
      const dims = output.dims;
      const vec = [];
      for (let j = 0; j < dims[1]; j++) vec.push(output.data[j]);

      // PCAで射影
      allWords.push({ word, category: '入力', vector: vec });
      const newCoords = projectPCA([vec])[0];
      vectors3d.push(newCoords);

      // スケーラーを更新
      computeScaler();

      // 再描画
      renderPoints();
      buildLegend();

      // タグ表示
      const tag = document.createElement('span');
      tag.className = 'added-word-tag';
      tag.textContent = word;
      $addedWords.appendChild(tag);

      $input.value = '';
    } catch (err) {
      console.error('Error adding word:', err);
      alert('単語の処理中にエラーが発生しました。');
    } finally {
      $addBtn.disabled = false;
      $addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>追加';
    }
  });

  // マウストラッキング (ホバー)
  $container.addEventListener('mousemove', (e) => {
    const rect = $container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // ツールチップ位置追従
    $tooltip.style.left = (e.clientX + 12) + 'px';
    $tooltip.style.top = (e.clientY - 28) + 'px';
  });

  $container.addEventListener('mouseleave', () => {
    mouse.set(-999, -999);
    hoveredIndex = -1;
    $tooltip.classList.remove('visible');
  });

  // パネル折りたたみ
  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('input-panel').classList.toggle('collapsed');
  });
  document.getElementById('input-panel-header')?.addEventListener('click', (e) => {
    if (e.target.closest('.panel-toggle')) return;
    document.getElementById('input-panel').classList.toggle('collapsed');
  });

  document.getElementById('legend-toggle').addEventListener('click', () => {
    document.getElementById('legend-panel').classList.toggle('collapsed');
  });
  document.querySelector('.legend-header')?.addEventListener('click', (e) => {
    if (e.target.closest('.legend-toggle')) return;
    document.getElementById('legend-panel').classList.toggle('collapsed');
  });

  // About パネル
  const $aboutPanel = document.getElementById('about-panel');
  document.getElementById('about-btn')?.addEventListener('click', () => {
    $aboutPanel.style.display = $aboutPanel.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('about-close')?.addEventListener('click', () => {
    $aboutPanel.style.display = 'none';
  });
}
