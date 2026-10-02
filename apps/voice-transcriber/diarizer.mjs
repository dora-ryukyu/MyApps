/**
 * diarizer.mjs — Nemotron 3 Diarization のストリーミング推論 (純粋ロジック)
 *
 * DOM / WebGPU / Worker に依存しない。onnxruntime のセッションと
 * テンソル生成関数は外から注入する (worker.js が本物を、テストが偽物を渡す)。
 *
 * 実装は NVIDIA のブラウザデモ (ahmadw/nemotron-diarization-web) が
 * onnxruntime-web で行っているストリーミング Sortformer の手順を
 * そのまま移植したもの。詳細は以下を参照:
 *   https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX
 *   https://huggingface.co/blog/nvidia/nemotron-diarization
 *
 * 構成:
 *   FFT → メルフィルタバンク → 対数メル特徴 (128 bin / 10ms)
 *   → 31 層 Transformer エンコーダ (ONNX) → [T, 8] 話者確率
 *   ストリーミングは Arrival-Order Speaker Cache (AOSC) + FIFO で話者同一性を保つ。
 */

/* ==========================================================
   行列ヘルパー (行優先の {data, rows, cols})
   ========================================================== */

export function makeMatrix(rows, cols) {
  return { data: new Float32Array(rows * cols), rows, cols };
}

export function reshape(data, cols) {
  if (!Number.isInteger(cols) || cols <= 0) throw new Error('cols が不正です');
  if (data.length % cols !== 0) throw new Error('data 長が cols で割り切れません');
  return { data, rows: data.length / cols, cols };
}

export function sliceRows(matrix, from, to) {
  const rows = Math.max(0, to - from);
  return {
    data: matrix.data.slice(from * matrix.cols, (from + rows) * matrix.cols),
    rows,
    cols: matrix.cols,
  };
}

export function concatRows(a, b) {
  const data = new Float32Array(a.data.length + b.data.length);
  data.set(a.data, 0);
  data.set(b.data, a.data.length);
  return { data, rows: a.rows + b.rows, cols: a.cols };
}

export function writeRows(dst, src, offset = 0) {
  dst.data.set(src.data, offset * dst.cols);
}

export function gatherRows(matrix, indices) {
  const out = makeMatrix(indices.length, matrix.cols);
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i] * matrix.cols;
    out.data.set(matrix.data.subarray(start, start + matrix.cols), i * matrix.cols);
  }
  return out;
}

/** 降順 (同点は添字昇順) の上位 k 件の添字を返す */
export function topKIndices(values, k) {
  const idx = new Int32Array(values.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return idx.sort((a, b) => values[b] - values[a] || a - b).slice(0, k);
}

/* ==========================================================
   FFT (radix-2, パワースペクトル)
   ========================================================== */

export class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT サイズは 2 の冪である必要があります: ${size}`);
    }
    this.size = size;
    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let n = i;
      let s = 0;
      for (let j = 0; j < bits; j++) {
        s = (s << 1) | (n & 1);
        n >>= 1;
      }
      this.reversed[i] = s;
    }
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
  }

  /** input のパワースペクトルを output (長さ size/2+1) に書く */
  powerSpectrum(input, output) {
    const { size, real, imag, reversed, cosTable, sinTable } = this;
    for (let i = 0; i < size; i++) real[i] = input[reversed[i]];
    imag.fill(0);
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const cos = cosTable[k];
          const sin = sinTable[k];
          const tr = real[b] * cos + imag[b] * sin;
          const ti = imag[b] * cos - real[b] * sin;
          real[b] = real[a] - tr;
          imag[b] = imag[a] - ti;
          real[a] += tr;
          imag[a] += ti;
        }
      }
    }
    for (let i = 0; i <= size / 2; i++) output[i] = real[i] * real[i] + imag[i] * imag[i];
  }
}

/* ==========================================================
   メルフィルタバンク (Slaney 風) と窓関数
   ========================================================== */

const MEL_F_SP = 200 / 3;
const MEL_F_MAX = 1000;
const MEL_LOG_STEP = Math.log(6.4) / 27;

export function hzToMel(freq) {
  return freq >= MEL_F_MAX
    ? MEL_F_MAX / MEL_F_SP + Math.log(freq / MEL_F_MAX) / MEL_LOG_STEP
    : freq / MEL_F_SP;
}

export function melToHz(mel) {
  return mel >= MEL_F_MAX / MEL_F_SP
    ? MEL_F_MAX * Math.exp(MEL_LOG_STEP * (mel - MEL_F_MAX / MEL_F_SP))
    : MEL_F_SP * mel;
}

export function melFilterbank({ samplingRate, nFft, numMelBins }) {
  const numFreq = nFft / 2 + 1;
  const freqs = Float64Array.from({ length: numFreq }, (_, i) => (i * samplingRate) / nFft);
  const melMin = hzToMel(0);
  const melMax = hzToMel(samplingRate / 2);
  const points = Float64Array.from(
    { length: numMelBins + 2 },
    (_, i) => melToHz(melMin + ((melMax - melMin) * i) / (numMelBins + 1)),
  );
  const filters = new Float32Array(numMelBins * numFreq);
  for (let m = 0; m < numMelBins; m++) {
    const left = points[m];
    const center = points[m + 1];
    const right = points[m + 2];
    const norm = 2 / (right - left);
    for (let f = 0; f < numFreq; f++) {
      const freq = freqs[f];
      const up = (freq - left) / (center - left);
      const down = (right - freq) / (right - center);
      filters[m * numFreq + f] = Math.max(0, Math.min(up, down)) * norm;
    }
  }
  return filters;
}

export function hannWindow(winLength, nFft) {
  const window = new Float32Array(nFft);
  const offset = (nFft - winLength) >> 1;
  for (let i = 0; i < winLength; i++) {
    window[offset + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (winLength - 1));
  }
  return window;
}

/* ==========================================================
   対数メル特徴抽出 (10ms ホップ / 128 bin)
   ========================================================== */

export const DEFAULT_FEATURE_CONFIG = Object.freeze({
  featureSize: 128,
  samplingRate: 16000,
  hopLength: 160,
  nFft: 512,
  winLength: 400,
  preemphasis: 0.97,
});

const LOG_EPS = 2 ** -24;

export class MelFeatureExtractor {
  constructor(config = DEFAULT_FEATURE_CONFIG) {
    this.config = config;
    const { nFft, winLength, featureSize, samplingRate } = config;
    this.fft = new FFT(nFft);
    this.window = hannWindow(winLength, nFft);
    this.melFilters = melFilterbank({ samplingRate, nFft, numMelBins: featureSize });
    this.numFrequencyBins = nFft / 2 + 1;
    this.frameBuffer = new Float32Array(nFft);
    this.powerBuffer = new Float32Array(this.numFrequencyBins);
  }

  numFrames(length, center) {
    const { nFft, hopLength } = this.config;
    const n = center ? length + 2 * (nFft >> 1) : length;
    return Math.max(0, Math.floor((n - nFft) / hopLength) + (center ? 0 : 1));
  }

  extract(samples, center) {
    const { nFft, hopLength, featureSize, preemphasis } = this.config;
    const frames = this.numFrames(samples.length, center);
    const out = makeMatrix(frames, featureSize);
    if (frames === 0) return out;
    const pad = center ? nFft >> 1 : 0;
    const signal = this.preemphasise(samples, pad, preemphasis);
    for (let f = 0; f < frames; f++) {
      const start = f * hopLength;
      for (let i = 0; i < nFft; i++) this.frameBuffer[i] = signal[start + i] * this.window[i];
      this.fft.powerSpectrum(this.frameBuffer, this.powerBuffer);
      this.projectToMel(out.data, f * featureSize);
    }
    return out;
  }

  preemphasise(samples, pad, coeff) {
    const out = new Float32Array(samples.length + 2 * pad);
    if (samples.length === 0) return out;
    out[pad] = samples[0];
    for (let i = 1; i < samples.length; i++) out[pad + i] = samples[i] - coeff * samples[i - 1];
    return out;
  }

  projectToMel(out, offset) {
    const { numFrequencyBins, melFilters, powerBuffer } = this;
    for (let m = 0; m < this.config.featureSize; m++) {
      const base = m * numFrequencyBins;
      let sum = 0;
      for (let f = 0; f < numFrequencyBins; f++) sum += powerBuffer[f] * melFilters[base + f];
      out[offset + m] = Math.log(sum + LOG_EPS);
    }
  }
}

/* ==========================================================
   設定の解決 (config.json / processor_config.json)
   ========================================================== */

/** ストリーミングモードから [chunk_length, right_context] を返す */
export function resolveChunk(config, streamingMode) {
  if (streamingMode === 'offline') {
    return [config.model.chunk_length, config.model.chunk_right_context];
  }
  const mode = config.processor.streaming_modes[streamingMode];
  if (!mode) throw new Error(`未知のストリーミングモードです: ${streamingMode}`);
  return mode;
}

/** キャッシュ設定を返す (offline はモデル既定の fifo / update period を使う) */
export function resolveCacheConfig(config, streamingMode) {
  if (streamingMode !== 'offline') return config.model.streaming_config;
  return {
    ...config.model.streaming_config,
    fifo_length: config.model.fifo_length,
    speaker_cache_update_period: config.model.speaker_cache_update_period,
  };
}

/** 1 チャンクあたりの遅延 (ms) */
export function latencyMs(config, streamingMode) {
  const [chunk, right] = resolveChunk(config, streamingMode);
  const { hop_length, sampling_rate } = config.processor.feature_extractor;
  const frameMs = (config.processor.subsampling_factor * hop_length * 1000) / sampling_rate;
  return Math.round((chunk + right) * frameMs);
}

/* ==========================================================
   Arrival-Order Speaker Cache (AOSC) + FIFO
   ========================================================== */

const STRONG_BOOST = -2 * Math.log(0.5);
const WEAK_BOOST = -Math.log(0.5);

export class SpeakerCache {
  constructor(config, hiddenSize = 512) {
    this.config = config;
    const perSpeaker =
      Math.floor(config.speaker_cache_length / config.num_speakers) -
      config.speaker_cache_silence_frames_per_speaker;
    this.minPositiveScores = Math.floor(perSpeaker * config.min_positive_scores_rate);
    this.numStrongBoostedFrames = Math.floor(perSpeaker * config.strong_boost_rate);
    this.numWeakBoostedFrames = Math.floor(perSpeaker * config.weak_boost_rate);
    this.embeds = makeMatrix(config.speaker_cache_length, hiddenSize);
    this.probs = makeMatrix(config.speaker_cache_length, config.num_speakers);
    this.fifo = makeMatrix(config.fifo_length, hiddenSize);
    this.numCacheFrames = 0;
    this.numFifoFrames = 0;
    this.isCompressed = false;
  }

  getCachedEmbeds() {
    return concatRows(
      sliceRows(this.embeds, 0, this.numCacheFrames),
      sliceRows(this.fifo, 0, this.numFifoFrames),
    );
  }

  get cachedLength() {
    return this.numCacheFrames + this.numFifoFrames;
  }

  update(newEmbeds, newProbs, silenceEmbeds, numNewFrames) {
    const { numCacheFrames, numFifoFrames } = this;
    const pooled = this.poolProbabilities(newProbs);
    const cachedLen = numCacheFrames + numFifoFrames;
    const newFifoPart = sliceRows(newEmbeds, cachedLen, cachedLen + numNewFrames);
    let fifo = concatRows(sliceRows(this.fifo, 0, numFifoFrames), newFifoPart);
    const popped = this.numPoppedFrames(fifo.rows);
    if (popped > 0) {
      const pooledNew = sliceRows(pooled, numCacheFrames, numCacheFrames + fifo.rows);
      const probsBase = this.isCompressed
        ? sliceRows(this.probs, 0, numCacheFrames)
        : sliceRows(pooled, 0, numCacheFrames);
      let embeds = concatRows(sliceRows(this.embeds, 0, numCacheFrames), sliceRows(fifo, 0, popped));
      let probs = concatRows(probsBase, sliceRows(pooledNew, 0, popped));
      fifo = sliceRows(fifo, popped, fifo.rows);
      if (embeds.rows > this.config.speaker_cache_length) {
        ({ embeds, probs } = this.compress(embeds, probs, silenceEmbeds));
        this.isCompressed = true;
      }
      this.numCacheFrames = embeds.rows;
      writeRows(this.embeds, embeds);
      writeRows(this.probs, probs);
    }
    this.numFifoFrames = fifo.rows;
    writeRows(this.fifo, fifo);
  }

  poolProbabilities(probs) {
    const sub = this.config.subsampling_factor;
    const cols = probs.cols;
    const out = makeMatrix(Math.floor(probs.rows / sub), cols);
    for (let r = 0; r < out.rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let k = 0; k < sub; k++) sum += 1 / (1 + Math.exp(-probs.data[(r * sub + k) * cols + c]));
        out.data[r * cols + c] = sum / sub;
      }
    }
    return out;
  }

  numPoppedFrames(rows) {
    if (rows <= this.config.fifo_length) return 0;
    const r = Math.max(this.config.speaker_cache_update_period, rows - this.config.fifo_length);
    return Math.min(r, rows);
  }

  frameScores(probs) {
    const { prediction_score_threshold: threshold, num_speakers: n } = this.config;
    const scores = new Float32Array(probs.data.length);
    for (let r = 0; r < probs.rows; r++) {
      const base = r * n;
      let sumLog = 0;
      for (let s = 0; s < n; s++) sumLog += Math.log(Math.max(1 - probs.data[base + s], threshold));
      for (let s = 0; s < n; s++) {
        const p = probs.data[base + s];
        if (p <= 0.5) {
          scores[base + s] = -Infinity;
          continue;
        }
        const lp = Math.log(Math.max(p, threshold));
        const l1p = Math.log(Math.max(1 - p, threshold));
        scores[base + s] = lp - l1p + sumLog - Math.log(0.5);
      }
    }
    for (let s = 0; s < n; s++) {
      let count = 0;
      for (let r = 0; r < probs.rows; r++) if (scores[r * n + s] > 0) count++;
      if (!(count < this.minPositiveScores)) {
        for (let r = 0; r < probs.rows; r++) {
          const i = r * n + s;
          if (scores[i] <= 0) scores[i] = -Infinity;
        }
      }
    }
    return scores;
  }

  boostScores(scores, rows, k, amount) {
    const n = this.config.num_speakers;
    const column = new Float32Array(rows);
    for (let s = 0; s < n; s++) {
      for (let r = 0; r < rows; r++) column[r] = scores[r * n + s];
      for (const idx of topKIndices(column, k)) scores[idx * n + s] += amount;
    }
  }

  compress(embeds, probs, silenceEmbeds) {
    const {
      speaker_cache_length: cacheLen,
      num_speakers: n,
      speaker_cache_silence_frames_per_speaker: silenceFrames,
    } = this.config;
    const rows = probs.rows;
    const scores = this.frameScores(probs);
    for (let r = cacheLen; r < rows; r++) {
      for (let s = 0; s < n; s++) scores[r * n + s] += this.config.latest_frames_score_boost;
    }
    this.boostScores(scores, rows, this.numStrongBoostedFrames, STRONG_BOOST);
    this.boostScores(scores, rows, this.numWeakBoostedFrames, WEAK_BOOST);

    const stride = rows + silenceFrames;
    const total = stride * n;
    const flat = new Float32Array(total);
    for (let s = 0; s < n; s++) {
      for (let r = 0; r < rows; r++) flat[s * stride + r] = scores[r * n + s];
      for (let r = 0; r < silenceFrames; r++) flat[s * stride + rows + r] = Infinity;
    }
    const idx = topKIndices(flat, cacheLen);
    for (let k = 0; k < cacheLen; k++) if (flat[idx[k]] === -Infinity) idx[k] = total;
    idx.sort();
    const mapped = new Int32Array(cacheLen);
    for (let k = 0; k < cacheLen; k++) {
      mapped[k] = idx[k] === total ? rows : Math.min(idx[k] % stride, rows);
    }
    const embedsAll = concatRows(embeds, reshape(silenceEmbeds, embeds.cols));
    const probsAll = concatRows(probs, makeMatrix(1, n));
    return { embeds: gatherRows(embedsAll, mapped), probs: gatherRows(probsAll, mapped) };
  }
}

/* ==========================================================
   ストリーミング話者分離
   ========================================================== */

function toFloat32Array(value) {
  if (value instanceof Float32Array) return value;
  if (value && value.data) {
    const d = value.data;
    if (d instanceof Float32Array) return d;
    return new Float32Array(d.buffer, d.byteOffset, d.length);
  }
  throw new Error('テンソルのデータを取得できません');
}

export class Diarizer {
  /**
   * @param {object} session onnxruntime のセッション (.run(feeds) を持つ)
   * @param {object} config  { model: config.json, processor: processor_config.json }
   * @param {string} streamingMode 'offline' | 'low_latency' | ...
   * @param {object} featureConfig メル特徴の設定
   * @param {(type:string, data:ArrayBufferView, dims:number[]) => any} makeTensor
   */
  constructor(session, config, streamingMode, featureConfig, makeTensor) {
    this.session = session;
    this.config = config;
    this.streamingMode = streamingMode;
    this.featureConfig = featureConfig;
    this.makeTensor = makeTensor;
    this.featureExtractor = new MelFeatureExtractor(featureConfig);
    this.cache = new SpeakerCache(
      resolveCacheConfig(config, streamingMode),
      config.model.audio_config.hidden_size,
    );
    this.silenceEmbeds = new Float32Array(0);
    this.buffer = new Float32Array(0);
    this.bufferStart = 0;
    this.chunkStart = 0;
    this.melFrameIndex = 0;
    this.emittedFrames = 0;
    this.isFirstChunk = true;
  }

  get samplingRate() {
    return this.featureConfig.samplingRate;
  }

  get numSpeakers() {
    return this.config.model.head_config.num_speakers;
  }

  get frameDurationSeconds() {
    return this.featureConfig.hopLength / this.featureConfig.samplingRate;
  }

  get subsamplingFactor() {
    return this.config.model.audio_config.subsampling_factor;
  }

  get chunkRightContext() {
    return resolveChunk(this.config, this.streamingMode)[1];
  }

  get melFramesPerChunk() {
    const [chunk, right] = resolveChunk(this.config, this.streamingMode);
    return (chunk + right) * this.subsamplingFactor;
  }

  get melFramesPerStep() {
    return resolveChunk(this.config, this.streamingMode)[0] * this.subsamplingFactor;
  }

  get samplesInFirstChunk() {
    const { hopLength, winLength } = this.featureConfig;
    return (this.melFramesPerChunk - 1) * hopLength + (winLength >> 1);
  }

  get samplesInChunk() {
    const { hopLength, winLength } = this.featureConfig;
    return this.melFramesPerChunk * hopLength + winLength;
  }

  reset() {
    this.cache = new SpeakerCache(
      resolveCacheConfig(this.config, this.streamingMode),
      this.config.model.audio_config.hidden_size,
    );
    this.buffer = new Float32Array(0);
    this.bufferStart = 0;
    this.chunkStart = 0;
    this.melFrameIndex = 0;
    this.emittedFrames = 0;
    this.isFirstChunk = true;
  }

  append(samples) {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
  }

  hasCompleteChunk() {
    const needed = this.isFirstChunk ? this.samplesInFirstChunk : this.samplesInChunk;
    return this.bufferStart + this.buffer.length - this.chunkStart >= needed;
  }

  takeChunk() {
    const offset = this.chunkStart - this.bufferStart;
    const length = this.isFirstChunk ? this.samplesInFirstChunk : this.samplesInChunk;
    return this.buffer.subarray(offset, offset + length);
  }

  advance() {
    this.isFirstChunk = false;
    this.melFrameIndex += this.melFramesPerStep;
    this.chunkStart = this.melFrameIndex * this.featureConfig.hopLength - (this.featureConfig.nFft >> 1);
    const offset = this.chunkStart - this.bufferStart;
    this.buffer = this.buffer.slice(offset);
    this.bufferStart = this.chunkStart;
  }

  async runChunk(samples, isFirst, rightContext) {
    const features = this.featureExtractor.extract(samples, isFirst);
    const cached = this.cache.getCachedEmbeds();
    const newFrames = Math.ceil(features.rows / this.subsamplingFactor);
    const totalFrames = cached.rows + newFrames;
    const outputs = await this.session.run({
      input_features: this.makeTensor('float32', features.data, [1, features.rows, features.cols]),
      cached_embeds: this.makeTensor('float32', cached.data, [1, cached.rows, cached.cols]),
      attention_mask: this.makeTensor(
        'int64',
        new BigInt64Array(totalFrames).fill(1n),
        [1, totalFrames],
      ),
    });
    const logits = reshape(toFloat32Array(outputs.logits), this.numSpeakers);
    const chunkEmbeds = reshape(toFloat32Array(outputs.chunk_embeds), cached.cols);
    this.silenceEmbeds = toFloat32Array(outputs.silence_embeds);

    const logitsTrimmed = sliceRows(logits, 0, totalFrames * this.subsamplingFactor);
    const newFramesAfter = newFrames - rightContext;
    this.cache.update(
      concatRows(cached, chunkEmbeds),
      logitsTrimmed,
      this.silenceEmbeds,
      newFramesAfter,
    );
    const start = cached.rows * this.subsamplingFactor;
    const emitted = sliceRows(logitsTrimmed, start, start + newFramesAfter * this.subsamplingFactor);
    return this.toProbabilities(emitted, Math.min(features.rows, emitted.rows));
  }

  toProbabilities(matrix, rows) {
    const out = makeMatrix(rows, matrix.cols);
    for (let i = 0; i < out.data.length; i++) out.data[i] = 1 / (1 + Math.exp(-matrix.data[i]));
    return out;
  }

  collect(results) {
    const startFrame = this.emittedFrames;
    if (results.length === 0) {
      return { probabilities: new Float32Array(0), numFrames: 0, numSpeakers: this.numSpeakers, startFrame };
    }
    const merged = results.reduce((a, b) => concatRows(a, b));
    this.emittedFrames += merged.rows;
    return {
      probabilities: merged.data,
      numFrames: merged.rows,
      numSpeakers: merged.cols,
      startFrame,
    };
  }

  async push(samples) {
    this.append(samples);
    const results = [];
    while (this.hasCompleteChunk()) {
      results.push(await this.runChunk(this.takeChunk(), this.isFirstChunk, this.chunkRightContext));
      this.advance();
    }
    return this.collect(results);
  }

  async flush() {
    const samples = this.buffer.subarray(this.chunkStart - this.bufferStart);
    if (this.featureExtractor.numFrames(samples.length, this.isFirstChunk) === 0) {
      return this.collect([]);
    }
    const result = await this.runChunk(samples, this.isFirstChunk, 0);
    this.isFirstChunk = false;
    this.chunkStart = this.bufferStart + this.buffer.length;
    this.buffer = new Float32Array(0);
    this.bufferStart = this.chunkStart;
    return this.collect([result]);
  }

  async dispose() {
    if (this.session && typeof this.session.release === 'function') await this.session.release();
  }
}
