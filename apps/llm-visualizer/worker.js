import { AutoTokenizer, AutoModelForCausalLM, env, Tensor, DynamicCache } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

// WebGPUの有効化
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

let tokenizer = null;
let model = null;
let pastKeyValues = null; // KVキャッシュ用変数

// ONNXモデルの出力( present_* )からDynamicCacheを構築する
//  Transformers.js内部のgetPastKeyValues()と同じロジック
function buildCacheFromOutputs(outputs, existingCache = null) {
    const entries = {};
    for (const name in outputs) {
        if (!name.startsWith('present')) continue;
        const newName = name
            .replace('present_ssm', 'past_ssm')           // Mamba
            .replace('present_conv', 'past_conv')         // LFM2 conv state
            .replace('present_recurrent', 'past_recurrent') // Qwen3.5
            .replace('present_compressor', 'past_compressor') // Deepseek V4
            .replace('present_indexer', 'past_indexer')   // Deepseek V4
            .replace('present', 'past_key_values');        // 標準KV cache
        entries[newName] = outputs[name];
    }
    if (existingCache) {
        existingCache.update(entries);
        return existingCache;
    }
    return new DynamicCache(entries);
}

// モデル初期化関数
async function initModel() {
    if (model) return;
    
    postMessage({ type: 'progress', status: 'Tokenizerを読み込み中...' });
    tokenizer = await AutoTokenizer.from_pretrained('LiquidAI/LFM2.5-1.2B-JP-202606-ONNX', {
        progress_callback: (data) => postMessage({ type: 'progress', data, status: 'Tokenizerをダウンロード中...' })
    });
    
    postMessage({ type: 'progress', status: 'Modelを読み込み中 (約744MB)...' });
    model = await AutoModelForCausalLM.from_pretrained('LiquidAI/LFM2.5-1.2B-JP-202606-ONNX', {
        dtype: 'q4f16',
        device: 'webgpu',
        progress_callback: (data) => postMessage({ type: 'progress', data, status: 'Modelをダウンロード中...' })
    });
    
    postMessage({ 
        type: 'ready',
        eosTokenId: tokenizer.eos_token_id
    });
}

// 確率分布を取得する関数
function getTopKProbabilities(logits, top_k, temperature, inputIds, repetitionPenalty = 1.05) {
    // logits: Tensor of shape [1, seq_len, vocab_size]
    const seqLen = logits.dims[1];
    const vocabSize = logits.dims[2];
    
    // 最後のトークンのlogitsを取得
    const lastLogits = new Float32Array(vocabSize);
    const offset = (seqLen - 1) * vocabSize;
    for (let i = 0; i < vocabSize; i++) {
        lastLogits[i] = logits.data[offset + i];
    }
    
    // 反復ペナルティの適用 (repetition_penalty)
    if (repetitionPenalty > 1.0 && inputIds && inputIds.length > 0) {
        for (const id of inputIds) {
            if (lastLogits[id] < 0) {
                lastLogits[id] *= repetitionPenalty;
            } else {
                lastLogits[id] /= repetitionPenalty;
            }
        }
    }
    
    // Temperature適用
    if (temperature > 0) {
        for (let i = 0; i < vocabSize; i++) {
            lastLogits[i] /= temperature;
        }
    }
    
    // Softmax
    let maxLogit = -Infinity;
    for (let i = 0; i < vocabSize; i++) {
        if (lastLogits[i] > maxLogit) maxLogit = lastLogits[i];
    }
    
    let sumExp = 0;
    const probs = new Float32Array(vocabSize);
    for (let i = 0; i < vocabSize; i++) {
        probs[i] = Math.exp(lastLogits[i] - maxLogit);
        sumExp += probs[i];
    }
    for (let i = 0; i < vocabSize; i++) {
        probs[i] /= sumExp;
    }
    
    // Top-Kの取得
    const indices = Array.from({ length: vocabSize }, (_, i) => i);
    indices.sort((a, b) => probs[b] - probs[a]); // 降順
    
    const topKTokens = [];
    for (let i = 0; i < Math.min(top_k, vocabSize); i++) {
        const id = indices[i];
        const prob = probs[id];
        let tokenStr = tokenizer.decode([id]);
        
        // 特殊なデコード処理（スペースや改行を見やすく）
        tokenStr = tokenStr.replace(/ /g, ' ').replace(/\n/g, '↵');
        
        topKTokens.push({
            id: id,
            token: tokenStr,
            prob: prob
        });
    }
    
    return topKTokens;
}

// メッセージハンドラ
self.addEventListener('message', async (e) => {
    const { type, prompt, inputIds, temperature = 0.1, topK = 50 } = e.data;
    
    if (type === 'init') {
        try {
            await initModel();
        } catch (err) {
            postMessage({ type: 'error', error: err.message });
        }
    } 
    else if (type === 'predict_next') {
        try {
            let inputs;
            if (inputIds) {
                // 2回目以降：最新の1トークンのみを渡し、過去の計算結果(KVキャッシュ)を再利用する
                // position_idsはTransformers.jsがattention_maskから自動生成するので明示指定不要
                const lastTokenId = inputIds[inputIds.length - 1];
                inputs = {
                    input_ids: new Tensor('int64', BigInt64Array.from([BigInt(lastTokenId)]), [1, 1]),
                    attention_mask: new Tensor('int64', BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]),
                };
                if (pastKeyValues) {
                    inputs.past_key_values = pastKeyValues;
                }
            } else {
                // 初回：チャットテンプレートの適用とKVキャッシュの初期化
                pastKeyValues = null;
                const messages = [
                    { role: "system", content: "You are a helpful assistant trained by Liquid AI. Please provide very concise, short and direct answers." },
                    { role: "user", content: prompt }
                ];
                const text = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
                inputs = tokenizer(text);
            }
            
            // Forward pass
            const outputs = await model(inputs);
            
            // ONNX出力( present_* )からDynamicCacheを構築して保存
            //   通常のKV cache + LFM2のconv stateの両方が含まれる
            pastKeyValues = buildCacheFromOutputs(outputs, pastKeyValues);
            
            // ペナルティ計算用に入力ID全体を把握する
            let currentIdsForPenalty;
            if (inputIds) {
                currentIdsForPenalty = inputIds; // 既に全体のID配列がある
            } else {
                currentIdsForPenalty = Array.from(inputs.input_ids.data).map(Number); // 初回
            }
            
            // LogitsからTop-Kを取得 (repetition_penalty=1.05 をデフォルト適用)
            const topCandidates = getTopKProbabilities(outputs.logits, topK, temperature, currentIdsForPenalty, 1.05);
            
            // 現在の入力ID配列を取得（次に繋げるため）
            const currentIds = currentIdsForPenalty;
            
            postMessage({
                type: 'prediction_result',
                candidates: topCandidates,
                currentIds: currentIds
            });
            
        } catch (err) {
            postMessage({ type: 'error', error: err.message });
        }
    }
});
