// llm-visualizer script.js

// UI要素の取得
const consentState = document.getElementById('consent-state');
const loadingState = document.getElementById('loading-state');
const loadingScreen = document.getElementById('loading-screen');
const consentBtn = document.getElementById('consent-btn');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');

const promptInput = document.getElementById('prompt-input');
const runBtn = document.getElementById('run-btn');
const outputText = document.getElementById('output-text');
const probTree = document.getElementById('prob-tree');
const tempSlider = document.getElementById('temp-slider');
const tempVal = document.getElementById('temp-val');
const topkSlider = document.getElementById('topk-slider');
const topkVal = document.getElementById('topk-val');
const maxTokensSlider = document.getElementById('max-tokens-slider');
const maxTokensVal = document.getElementById('max-tokens-val');

const modeAuto = document.getElementById('mode-auto');
const modeManual = document.getElementById('mode-manual');

let worker = null;
let currentInputIds = null;
let isGenerating = false;
let currentGenerationId = 0;
let generatedCount = 0;
// モデルの特殊トークン
let modelEosTokenId = null;

// 1. 初期ロード画面の制御
consentBtn.addEventListener('click', () => {
    consentState.style.display = 'none';
    loadingState.style.display = 'block';
    initWorker();
});

function initWorker() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    
    worker.addEventListener('message', (e) => {
        const data = e.data;
        
        switch(data.type) {
            case 'progress':
                statusText.textContent = data.status;
                if (data.data) {
                    // Transformers.js progress event
                    const progress = data.data;
                    if (progress.status === 'progress' && progress.progress !== undefined) {
                        progressBar.style.width = `${progress.progress}%`;
                    }
                }
                break;
            case 'ready':
                if (data.eosTokenId !== undefined) {
                    modelEosTokenId = data.eosTokenId;
                }
                loadingScreen.classList.add('fade-out');
                setTimeout(() => {
                    loadingScreen.style.display = 'none';
                }, 500); // CSSのフェードアウト時間に合わせる
                runBtn.disabled = false;
                break;
            case 'prediction_result':
                handlePredictionResult(data.candidates, data.currentIds, data.generationId);
                break;
            case 'error':
                console.error("Worker Error:", data.error);
                alert("エラーが発生しました: " + data.error);
                resetGeneration();
                break;
        }
    });
    
    worker.addEventListener('error', (e) => {
        console.error('Worker uncaught error:', e);
        alert('Workerで予期しないエラーが発生しました。ページをリロードしてください。');
        if (isGenerating) resetGeneration();
        runBtn.disabled = true;
    });
    
    worker.postMessage({ type: 'init' });
}

// 2. パラメータスライダーの更新
tempSlider.addEventListener('input', (e) => {
    tempVal.textContent = parseFloat(e.target.value).toFixed(1);
});
topkSlider.addEventListener('input', (e) => {
    topkVal.textContent = e.target.value;
});
maxTokensSlider.addEventListener('input', (e) => {
    maxTokensVal.textContent = e.target.value;
});

// 3. 生成の制御
runBtn.addEventListener('click', () => {
    if (isGenerating) {
        resetGeneration(); // ストップ
    } else {
        startGeneration();
    }
});

function startGeneration() {
    const prompt = promptInput.value.trim();
    if (!prompt) {
        alert('プロンプトを入力してください。');
        return;
    }
    
    currentGenerationId++;
    
    isGenerating = true;
    runBtn.textContent = '停止';
    runBtn.classList.remove('btn-accent');
    promptInput.disabled = true;
    outputText.innerHTML = '';
    probTree.innerHTML = '<div class="tree-placeholder">最初のトークンを推論中...</div>';
    probTree.classList.add('is-inferencing');
    
    currentInputIds = null;
    generatedCount = 0;
    
    requestNextToken();
}

function resetGeneration() {
    isGenerating = false;
    runBtn.textContent = '生成開始';
    runBtn.classList.add('btn-accent');
    promptInput.disabled = false;
}

function requestNextToken() {
    if (!isGenerating) return;
    const maxTokens = parseInt(maxTokensSlider.value);
    if (generatedCount >= maxTokens) {
        resetGeneration();
        probTree.innerHTML = '<div class="tree-placeholder">最大トークン数に達しました。</div>';
        return;
    }
    
    const temperature = parseFloat(tempSlider.value);
    const topK = parseInt(topkSlider.value);
    
    worker.postMessage({
        type: 'predict_next',
        generationId: currentGenerationId,
        prompt: promptInput.value,
        inputIds: currentInputIds,
        temperature: temperature,
        topK: topK
    });
}

// 4. 結果の表示と選択
function handlePredictionResult(candidates, ids, generationId) {
    if (generationId !== currentGenerationId) return;
    if (!isGenerating) return;
    
    probTree.classList.remove('is-inferencing');
    currentInputIds = ids;
    renderProbTree(candidates);
    
    const isManual = modeManual.checked;
    
    if (isManual) {
        // 手動モード: ユーザーのクリックを待つ（UIにイベントリスナーはrender時に付与済み）
    } else {
        // 自動モード: 確率に基づいてサンプリング
        setTimeout(() => {
            if (!isGenerating) return;
            const selectedToken = sampleToken(candidates);
            selectToken(selectedToken);
        }, 80); // 視覚効果のため少し待つ
    }
}

function sampleToken(candidates) {
    // Math.random()を使ったルーレット選択
    const rand = Math.random();
    let cumulative = 0;
    for (const cand of candidates) {
        cumulative += cand.prob;
        if (rand <= cumulative) {
            return cand;
        }
    }
    return candidates[0]; // フォールバック
}

function selectToken(candidate) {
    if (!isGenerating) return;
    
    // UIにトークンを追加
    const span = document.createElement('span');
    span.className = 'token-span token-new';
    span.textContent = candidate.token;
    outputText.appendChild(span);
    
    // 既存のアニメーションクラスを消す（次回の際のために）
    setTimeout(() => span.classList.remove('token-new'), 300);
    
    // EOSチェック
    const isEosId = (modelEosTokenId !== null) && 
                    (Array.isArray(modelEosTokenId) ? modelEosTokenId.includes(candidate.id) : candidate.id === modelEosTokenId);
    
    if (isEosId || candidate.token.includes('<|im_end|>') || candidate.token.includes('<|endoftext|>')) {
        resetGeneration();
        probTree.innerHTML = '<div class="tree-placeholder">生成完了 (完了トークンに到達)</div>';
        return;
    }
    
    // Input IDsに選択したトークンを追加
    currentInputIds.push(candidate.id);
    generatedCount++;
    
    // 次の予測へ
    probTree.classList.add('is-inferencing');
    requestNextToken();
}

function renderProbTree(candidates) {
    probTree.innerHTML = '';
    
    candidates.forEach((cand, index) => {
        const item = document.createElement('div');
        item.className = `prob-item ${modeManual.checked ? 'interactive' : ''}`;
        // CSS animation-delay用のカスタムプロパティ
        item.style.setProperty('--i', index);
        
        const probPct = (cand.prob * 100).toFixed(1);
        
        // 背景のバー（CSSアニメーションで伸びる）
        const fill = document.createElement('div');
        fill.className = 'prob-fill';
        fill.style.setProperty('--target-width', `${probPct}%`);
        
        const content = document.createElement('div');
        content.className = 'prob-content';
        
        const tokenLabel = document.createElement('span');
        tokenLabel.className = 'prob-token';
        tokenLabel.textContent = cand.token;
        
        const valueLabel = document.createElement('span');
        valueLabel.className = 'prob-value';
        valueLabel.textContent = `${probPct}%`;
        
        content.appendChild(tokenLabel);
        content.appendChild(valueLabel);
        item.appendChild(fill);
        item.appendChild(content);
        
        // クリックイベント（手動モード用）
        item.addEventListener('click', () => {
            if (isGenerating && modeManual.checked) {
                item.style.borderColor = 'var(--c-accent)';
                fill.style.background = 'var(--c-accent)';
                setTimeout(() => {
                    selectToken(cand);
                }, 150);
            }
        });
        
        probTree.appendChild(item);
    });
}

// 5. Infoモーダルの制御
const infoBtn = document.getElementById('info-btn');
const infoModal = document.getElementById('info-modal');
const closeInfoBtn = document.getElementById('close-info-btn');

infoBtn.addEventListener('click', () => {
    infoModal.style.display = 'flex';
});

closeInfoBtn.addEventListener('click', () => {
    infoModal.style.display = 'none';
});

// モーダルの外側をクリックで閉じる
infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) {
        infoModal.style.display = 'none';
    }
});
