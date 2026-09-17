/**
 * pipeline.mjs — 音声文字起こし・翻訳の純粋ロジック
 *
 * このファイルは DOM / WebGPU / Worker に依存しない。
 * 「ブラウザでも Node でも同じように動く計算」だけを置き、
 * worker.js からも test/ からも import される。
 *
 * 推論そのものは Transformers.js v4 の
 * GraniteSpeechForConditionalGeneration に任せる (worker.js)。
 * ここには音声の前処理・区間分割・表示用の純関数を置く。
 *
 * 出典:
 *   https://huggingface.co/spaces/ibm-granite/granite-speech-webgpu
 *   https://huggingface.co/onnx-community/granite-speech-4.1-2b-ONNX
 */

/* ==========================================================
   モデル / CDN の固定情報
   ========================================================== */

export const MODEL_ID = 'onnx-community/granite-speech-4.1-2b-ONNX';
export const MODEL_REVISION = 'main';
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`;

export const SAMPLE_RATE = 16000;
export const MAX_NEW_TOKENS = 256;

export const TRANSFORMERS_VERSION = '4.2.0';
export const TRANSFORMERS_MODULE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

/**
 * 推論の dtype。IBM 公式デモ (granite-speech-webgpu/app.js) と同一の構成。
 * q4f16 は fp16 演算を使うため WebGPU 専用。WASM では q4 に落とす。
 */
export const DTYPE_WEBGPU = Object.freeze({
  audio_encoder: 'q4',
  embed_tokens: 'q4f16',
  decoder_model_merged: 'q4f16',
});
export const DTYPE_WASM = Object.freeze({
  audio_encoder: 'q4',
  embed_tokens: 'q4',
  decoder_model_merged: 'q4',
});

/**
 * モデル資産のバイト数 (2026-09-17 時点、HF API の blobs=true より)。
 * 同意画面のサイズ表示とテストにだけ使う。
 */
export const MODEL_VARIANTS = Object.freeze({
  'onnx/audio_encoder_q4.onnx': 349494,
  'onnx/audio_encoder_q4.onnx_data': 658277008,
  'onnx/audio_encoder_q4f16.onnx': 353289,
  'onnx/audio_encoder_q4f16.onnx_data': 424598944,
  'onnx/embed_tokens_q4.onnx': 857,
  'onnx/embed_tokens_q4.onnx_data': 131663136,
  'onnx/embed_tokens_q4f16.onnx': 1064,
  'onnx/embed_tokens_q4f16.onnx_data': 118817952,
  'onnx/decoder_model_merged_q4.onnx': 434229,
  'onnx/decoder_model_merged_q4.onnx_data': 1047995680,
  'onnx/decoder_model_merged_q4f16.onnx': 437181,
  'onnx/decoder_model_merged_q4f16.onnx_data': 944641184,
});

/** dtype 設定からダウンロード総バイト数を見積もる */
export function estimateModelBytes(dtype) {
  const d = { ...DTYPE_WEBGPU, ...(dtype || {}) };
  const files = [
    ['audio_encoder', d.audio_encoder],
    ['embed_tokens', d.embed_tokens],
    ['decoder_model_merged', d.decoder_model_merged],
  ];
  let total = 0;
  for (const [module, quant] of files) {
    if (typeof quant !== 'string' || !quant) {
      throw new Error(`dtype.${module} が不正です`);
    }
    for (const suffix of ['.onnx', '.onnx_data']) {
      const name = `onnx/${module}_${quant}${suffix}`;
      if (!(name in MODEL_VARIANTS)) {
        throw new Error(`未知のモデル資産です: ${name}`);
      }
      total += MODEL_VARIANTS[name];
    }
  }
  return total;
}

/** バイト数を人が読める表記にする (1024 基準) */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) return `${mib.toFixed(0)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/* ==========================================================
   タスク (文字起こし / 音声翻訳)
   ========================================================== */

/**
 * Granite Speech は <|audio|> プレースホルダをプロセッサの chat template が
 * 音声トークン列に展開する。プロンプトはデモと同一。
 */
export const TASK_PROMPTS = Object.freeze({
  transcribe: '<|audio|>Transcribe the speech to text with proper punctuation and capitalization',
  translate_en: '<|audio|>Translate the speech to English with proper punctuation and capitalization',
  translate_fr: '<|audio|>Translate the speech to French with proper punctuation and capitalization',
  translate_de: '<|audio|>Translate the speech to German with proper punctuation and capitalization',
  translate_es: '<|audio|>Translate the speech to Spanish with proper punctuation and capitalization',
  translate_pt: '<|audio|>Translate the speech to Portuguese with proper punctuation and capitalization',
  translate_ja: '<|audio|>Translate the speech to Japanese with proper punctuation and capitalization',
});

export const TASKS = Object.freeze([
  { key: 'transcribe', label: '文字起こし', description: '話した言語のまま書き起こす' },
  { key: 'translate_ja', label: '日本語に翻訳', description: '音声を日本語テキストへ' },
  { key: 'translate_en', label: '英語に翻訳', description: '音声を英語テキストへ' },
  { key: 'translate_fr', label: 'フランス語に翻訳', description: '音声をフランス語テキストへ' },
  { key: 'translate_de', label: 'ドイツ語に翻訳', description: '音声をドイツ語テキストへ' },
  { key: 'translate_es', label: 'スペイン語に翻訳', description: '音声をスペイン語テキストへ' },
  { key: 'translate_pt', label: 'ポルトガル語に翻訳', description: '音声をポルトガル語テキストへ' },
]);

const DEFAULT_TASK_KEY = 'transcribe';

/** タスクキーからプロンプトを返す。未知のキーは文字起こしにフォールバック。 */
export function buildTaskPrompt(key) {
  return TASK_PROMPTS[key] || TASK_PROMPTS[DEFAULT_TASK_KEY];
}

/** タスクキーが既知かどうか */
export function isKnownTask(key) {
  return Object.prototype.hasOwnProperty.call(TASK_PROMPTS, key);
}

/* ==========================================================
   音声の前処理
   ========================================================== */

/** 複数チャンネル (Float32Array の配列) をモノラルに平均合成する */
export function downmixChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('チャンネルがありません');
  }
  const length = channels[0].length;
  for (const ch of channels) {
    if (!ch || ch.length !== length) {
      throw new Error('チャンネル長が一致しません');
    }
  }
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * 線形補間によるリサンプリング。
 * AudioContext が 16kHz をサポートしない環境のフォールバック。
 */
export function resampleLinear(input, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || fromRate <= 0) throw new Error('fromRate が不正です');
  if (!Number.isFinite(toRate) || toRate <= 0) throw new Error('toRate が不正です');
  if (!input || typeof input.length !== 'number') throw new Error('input が不正です');
  if (input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return Float32Array.from(input);

  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/** [start, end) 秒をサンプル範囲へ切り出す (範囲は自動でクランプ) */
export function sliceSeconds(samples, sampleRate, start, end) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('sampleRate が不正です');
  const from = Math.max(0, Math.floor(start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(end * sampleRate));
  if (to <= from) return new Float32Array(0);
  return samples.slice(from, to);
}

/* ==========================================================
   波形表示用
   ========================================================== */

/**
 * 波形描画用に、各バケットの最大振幅 (0..1 に正規化) を返す。
 * 無音ならすべて 0。
 */
export function computePeaks(samples, bucketCount) {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new Error('bucketCount は正の整数である必要があります');
  }
  const out = new Float32Array(bucketCount);
  if (!samples || samples.length === 0) return out;

  const perBucket = samples.length / bucketCount;
  let max = 0;
  for (let b = 0; b < bucketCount; b++) {
    const from = Math.floor(b * perBucket);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * perBucket)));
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let b = 0; b < bucketCount; b++) out[b] /= max;
  }
  return out;
}

/* ==========================================================
   簡易 VAD (エネルギー法による区間分割)
   ========================================================== */

/**
 * 20ms フレームの RMS が threshold 以上の区間を発話とみなし、
 * 無音が minSilenceMs 以上続いたら区間を切る。
 *
 * Granite Speech は 1 回の生成で扱える音声長に限りがあるため、
 * 長い音声は maxSegmentMs ごとに分割する。
 * Silero VAD (IBM デモ同梱) の代わりとなる軽量フォールバック。
 */
export function findSpeechSegments(samples, sampleRate, options = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('sampleRate が不正です');
  if (!samples || typeof samples.length !== 'number') throw new Error('samples が不正です');

  const {
    frameMs = 20,
    threshold = 0.01,
    minSpeechMs = 250,
    minSilenceMs = 400,
    padMs = 100,
    maxSegmentMs = 30000,
  } = options;

  if (samples.length === 0) return [];

  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.ceil(samples.length / frameLen);
  const minSpeechFrames = Math.max(1, Math.round(minSpeechMs / frameMs));
  const minSilenceFrames = Math.max(1, Math.round(minSilenceMs / frameMs));
  const maxFrames = Math.max(1, Math.round(maxSegmentMs / frameMs));

  // フレームごとの有声判定
  const speech = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const from = f * frameLen;
    const to = Math.min(from + frameLen, samples.length);
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    speech[f] = rms >= threshold ? 1 : 0;
  }

  // 連続する有声フレームをまとめる (短い無音は同一区間として繋ぐ)
  const regions = [];
  let i = 0;
  while (i < frameCount) {
    if (!speech[i]) {
      i++;
      continue;
    }
    const startFrame = i;
    let endFrame = i;
    let silenceRun = 0;
    i++;
    while (i < frameCount) {
      if (speech[i]) {
        endFrame = i;
        silenceRun = 0;
        i++;
      } else {
        silenceRun++;
        if (silenceRun >= minSilenceFrames) break;
        i++;
      }
    }
    if (endFrame - startFrame + 1 >= minSpeechFrames) {
      regions.push({ startFrame, endFrame });
    }
  }

  // 秒へ変換し、長すぎる区間は分割、前後にパディングを付ける
  const totalSeconds = samples.length / sampleRate;
  const pad = padMs / 1000;
  const segments = [];
  for (const region of regions) {
    let start = region.startFrame;
    while (start <= region.endFrame) {
      const chunkEnd = Math.min(region.endFrame, start + maxFrames - 1);
      const startSec = Math.max(0, (start * frameLen) / sampleRate - pad);
      const endSec = Math.min(totalSeconds, ((chunkEnd + 1) * frameLen) / sampleRate + pad);
      if (endSec > startSec) segments.push({ start: startSec, end: endSec });
      start = chunkEnd + 1;
    }
  }
  return segments;
}

/* ==========================================================
   表示ヘルパー
   ========================================================== */

/** 秒を m:ss / h:mm:ss にする */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** セグメント配列をテキスト化する (コピー / ダウンロード用) */
export function transcriptToText(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((seg) => {
      const text = (seg && seg.text ? String(seg.text) : '').trim();
      if (!text) return '';
      return `[${formatTimestamp(seg.start)}] ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}
