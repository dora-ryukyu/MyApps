import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeMatrix,
  reshape,
  sliceRows,
  concatRows,
  gatherRows,
  topKIndices,
  FFT,
  hzToMel,
  melToHz,
  melFilterbank,
  hannWindow,
  MelFeatureExtractor,
  DEFAULT_FEATURE_CONFIG,
  resolveChunk,
  resolveCacheConfig,
  latencyMs,
  SpeakerCache,
} from '../diarizer.mjs';

/* ---------------------------------------------------------
   行列ヘルパー
   --------------------------------------------------------- */
test('makeMatrix / reshape は行優先の行列を作る', () => {
  const m = makeMatrix(2, 3);
  assert.equal(m.rows, 2);
  assert.equal(m.cols, 3);
  assert.equal(m.data.length, 6);
  const r = reshape(Float32Array.from([1, 2, 3, 4]), 2);
  assert.equal(r.rows, 2);
  assert.equal(r.cols, 2);
  assert.throws(() => reshape(Float32Array.from([1, 2, 3]), 2), /割り切れ/);
});

test('sliceRows / concatRows / gatherRows は行を操作する', () => {
  const m = reshape(Float32Array.from([1, 2, 3, 4, 5, 6]), 2);
  assert.deepEqual(Array.from(sliceRows(m, 1, 3).data), [3, 4, 5, 6]);
  assert.deepEqual(Array.from(sliceRows(m, 2, 1).data), []);
  const c = concatRows(sliceRows(m, 0, 1), sliceRows(m, 2, 3));
  assert.deepEqual(Array.from(c.data), [1, 2, 5, 6]);
  const g = gatherRows(m, [2, 0]);
  assert.deepEqual(Array.from(g.data), [5, 6, 1, 2]);
});

test('topKIndices は降順の上位 k 件を返す', () => {
  assert.deepEqual(Array.from(topKIndices(Float32Array.from([0.1, 0.9, 0.5, 0.7]), 2)), [1, 3]);
  assert.deepEqual(Array.from(topKIndices(Float32Array.from([1, 1, 1]), 2)), [0, 1]);
});

/* ---------------------------------------------------------
   FFT
   --------------------------------------------------------- */
test('FFT は 2 の冪以外を拒否する', () => {
  assert.throws(() => new FFT(6), /2 の冪/);
});

test('FFT は DC 信号で bin 0 にエネルギーを出す', () => {
  const fft = new FFT(8);
  const out = new Float32Array(5);
  fft.powerSpectrum(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1]), out);
  assert.ok(Math.abs(out[0] - 64) < 1e-6, `bin0=${out[0]}`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] < 1e-6, `bin${i}=${out[i]}`);
});

test('FFT は正弦波で対応する bin にピークを出す', () => {
  const n = 16;
  const fft = new FFT(n);
  const out = new Float32Array(n / 2 + 1);
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 3 * i) / n);
  fft.powerSpectrum(input, out);
  let peak = 0;
  for (let i = 1; i < out.length; i++) if (out[i] > out[peak]) peak = i;
  assert.equal(peak, 3);
});

/* ---------------------------------------------------------
   メルフィルタバンク / 窓
   --------------------------------------------------------- */
test('hzToMel / melToHz は往復する', () => {
  for (const hz of [0, 100, 1000, 4000, 8000]) {
    assert.ok(Math.abs(melToHz(hzToMel(hz)) - hz) < 1e-6, `hz=${hz}`);
  }
});

test('melFilterbank は非負で各フィルタにピークがある', () => {
  const filters = melFilterbank({ samplingRate: 16000, nFft: 512, numMelBins: 128 });
  const numFreq = 512 / 2 + 1;
  assert.equal(filters.length, 128 * numFreq);
  for (let m = 0; m < 128; m++) {
    let max = 0;
    for (let f = 0; f < numFreq; f++) {
      const v = filters[m * numFreq + f];
      assert.ok(v >= 0, `負の値: ${v}`);
      if (v > max) max = v;
    }
    assert.ok(max > 0, `フィルタ ${m} が全て 0`);
  }
});

test('hannWindow は中央が 1 で端が 0', () => {
  const w = hannWindow(5, 8);
  assert.equal(w.length, 8);
  assert.equal(w[0], 0);
  assert.equal(w[7], 0);
  assert.ok(Math.abs(w[3] - 1) < 1e-6, `center=${w[3]}`);
});

/* ---------------------------------------------------------
   メル特徴抽出
   --------------------------------------------------------- */
test('MelFeatureExtractor.numFrames はホップ幅でフレーム数を決める', () => {
  const fe = new MelFeatureExtractor(DEFAULT_FEATURE_CONFIG);
  assert.equal(fe.numFrames(16000, false), Math.floor((16000 - 512) / 160) + 1);
  assert.equal(fe.numFrames(100, false), 0);
});

test('MelFeatureExtractor.extract は [frames, 128] を返す', () => {
  const fe = new MelFeatureExtractor(DEFAULT_FEATURE_CONFIG);
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000);
  const out = fe.extract(samples, false);
  assert.equal(out.cols, 128);
  assert.equal(out.rows, fe.numFrames(samples.length, false));
  assert.equal(out.data.length, out.rows * 128);
  for (const v of out.data) assert.ok(Number.isFinite(v), 'NaN/Inf が含まれる');
});

/* ---------------------------------------------------------
   設定の解決
   --------------------------------------------------------- */
const CONFIG = {
  model: {
    chunk_length: 340,
    chunk_right_context: 40,
    fifo_length: 40,
    speaker_cache_update_period: 300,
    streaming_config: { fifo_length: 264, speaker_cache_update_period: 222, num_speakers: 8 },
    audio_config: { subsampling_factor: 8, hidden_size: 512 },
    head_config: { num_speakers: 8 },
  },
  processor: {
    subsampling_factor: 8,
    feature_extractor: { hop_length: 160, sampling_rate: 16000 },
    streaming_modes: { low_latency: [9, 4], ultra_low_latency: [3, 1] },
  },
};

test('resolveChunk は offline とストリーミングモードを切り替える', () => {
  assert.deepEqual(resolveChunk(CONFIG, 'offline'), [340, 40]);
  assert.deepEqual(resolveChunk(CONFIG, 'low_latency'), [9, 4]);
  assert.throws(() => resolveChunk(CONFIG, 'nope'), /未知のストリーミングモード/);
});

test('resolveCacheConfig は offline でモデル既定の fifo を使う', () => {
  const offline = resolveCacheConfig(CONFIG, 'offline');
  assert.equal(offline.fifo_length, 40);
  assert.equal(offline.speaker_cache_update_period, 300);
  const low = resolveCacheConfig(CONFIG, 'low_latency');
  assert.equal(low.fifo_length, 264);
  assert.equal(low.speaker_cache_update_period, 222);
});

test('latencyMs はチャンク長から遅延を見積もる', () => {
  assert.equal(latencyMs(CONFIG, 'offline'), 30400);
  assert.equal(latencyMs(CONFIG, 'low_latency'), 1040);
});

/* ---------------------------------------------------------
   話者キャッシュ
   --------------------------------------------------------- */
const CACHE_CONFIG = {
  speaker_cache_length: 8,
  num_speakers: 2,
  speaker_cache_silence_frames_per_speaker: 1,
  min_positive_scores_rate: 0.5,
  strong_boost_rate: 0.75,
  weak_boost_rate: 1.5,
  fifo_length: 4,
  speaker_cache_update_period: 4,
  prediction_score_threshold: 0.25,
  latest_frames_score_boost: 0.05,
  subsampling_factor: 8,
};

test('SpeakerCache は初期状態で空を返す', () => {
  const cache = new SpeakerCache(CACHE_CONFIG, 4);
  assert.equal(cache.cachedLength, 0);
  assert.equal(cache.getCachedEmbeds().rows, 0);
});

test('SpeakerCache.poolProbabilities は subsampling ごとに平均する', () => {
  const cache = new SpeakerCache(CACHE_CONFIG, 4);
  // poolProbabilities はロジット (シグモイド前) を受け取る
  const logits = makeMatrix(16, 2);
  logits.data.fill(-10);
  for (let f = 0; f < 8; f++) logits.data[f * 2 + 0] = 10;
  for (let f = 8; f < 16; f++) logits.data[f * 2 + 1] = 10;
  const pooled = cache.poolProbabilities(logits);
  assert.equal(pooled.rows, 2);
  assert.ok(pooled.data[0] > 0.9, `pooled[0]=${pooled.data[0]}`);
  assert.ok(pooled.data[3] > 0.9, `pooled[3]=${pooled.data[3]}`);
  assert.ok(pooled.data[1] < 0.1, `pooled[1]=${pooled.data[1]}`);
});

test('SpeakerCache.numPoppedFrames は fifo を超えた分を返す', () => {
  const cache = new SpeakerCache(CACHE_CONFIG, 4);
  assert.equal(cache.numPoppedFrames(4), 0);
  assert.equal(cache.numPoppedFrames(6), 4);
  assert.equal(cache.numPoppedFrames(10), 6);
});

test('SpeakerCache.update はキャッシュを伸ばし上限で圧縮する', () => {
  const cache = new SpeakerCache(CACHE_CONFIG, 4);
  const hidden = 4;
  // 1 回目: 新規 4 フレーム (embeds は cached(0) + 4 行)
  const embeds1 = makeMatrix(4, hidden);
  const probs1 = makeMatrix(4 * CACHE_CONFIG.subsampling_factor, 2);
  probs1.data.fill(0.9);
  cache.update(embeds1, probs1, new Float32Array(hidden), 4);
  assert.ok(cache.cachedLength > 0);
  // 2 回目: さらに 4 フレーム追加して上限 (8) を超えさせ、圧縮経路を通す
  const cached = cache.getCachedEmbeds();
  const embeds2 = makeMatrix(cached.rows + 4, hidden);
  const probs2 = makeMatrix((cached.rows + 4) * CACHE_CONFIG.subsampling_factor, 2);
  probs2.data.fill(0.9);
  cache.update(embeds2, probs2, new Float32Array(hidden), 4);
  assert.ok(cache.cachedLength <= CACHE_CONFIG.speaker_cache_length + CACHE_CONFIG.fifo_length);
});
