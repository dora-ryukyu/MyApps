import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EPSILON,
  DB_FLOOR,
  DEFAULT_FFT_SIZE,
  DEFAULT_HOP_SIZE,
  clamp,
  clamp01,
  nextPowerOfTwo,
  isPowerOfTwo,
  defaultMinFreq,
  formatHz,
  formatDb,
  formatSeconds,
  formatBytes,
  mixToMono,
  trimToSeconds,
  windowLabel,
  buildWindow,
  windowSum,
  fft,
  magnitudeSpectrum,
  amplitudeToDb,
  powerToDb,
  dbToAmplitude,
  binToHz,
  hzToBin,
  frequencyTable,
  freqToNormalized,
  normalizedToFreq,
  planStft,
  computeStft,
  spectrumSlice,
  averageSpectrum,
  findPeaks,
  sampleColormap,
  dbToColor,
  buildSpectrogramImage,
  sliceToCsv,
  peaksToCsv,
  estimateMemoryBytes,
  buildFileName,
} from '../pipeline.mjs';

/* ==========================================================
   ヘルパー
   ========================================================== */

function sine(sampleRate, frequency, seconds, amplitude = 1) {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.cos((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

/** ビン k に正弦があるちょうど N サンプルの信号 (周波数 = k * sr / N) */
function binSine(fftSize, bin, amplitude = 1) {
  const out = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    out[i] = amplitude * Math.cos((2 * Math.PI * bin * i) / fftSize);
  }
  return out;
}

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} ≈ ${expected} (±${tolerance})`,
  );
}

/* ==========================================================
   基本ユーティリティ
   ========================================================== */

test('clamp は範囲内へ収める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(NaN, 2, 10), 2);
  assert.equal(clamp01(1.5), 1);
});

test('nextPowerOfTwo / isPowerOfTwo', () => {
  assert.equal(nextPowerOfTwo(1), 1);
  assert.equal(nextPowerOfTwo(3), 4);
  assert.equal(nextPowerOfTwo(1024), 1024);
  assert.equal(nextPowerOfTwo(1025), 2048);
  assert.ok(isPowerOfTwo(2048));
  assert.ok(!isPowerOfTwo(2047));
  assert.ok(!isPowerOfTwo(0));
});

test('書式ヘルパー', () => {
  assert.equal(formatHz(440), '440 Hz');
  assert.equal(formatHz(20000), '20.0 kHz');
  assert.equal(formatDb(-12.34), '-12.3 dB');
  assert.equal(formatSeconds(65.5), '1:05.50');
  assert.equal(formatBytes(2048), '2.0 KB');
});

test('defaultMinFreq は 0 を避ける', () => {
  assert.ok(defaultMinFreq(48000) >= 20);
});

/* ==========================================================
   前処理
   ========================================================== */

test('mixToMono はチャンネルを平均する', () => {
  const a = Float32Array.from([1, 1, 1, 1]);
  const b = Float32Array.from([0, 0, 0, 0]);
  const mono = mixToMono([a, b]);
  assert.equal(mono.length, 4);
  for (const value of mono) approx(value, 0.5);

  const single = mixToMono([a]);
  assert.equal(single[0], 1);
  assert.deepEqual([...mixToMono([])], []);
});

test('trimToSeconds は最大長へ切り詰める', () => {
  const samples = new Float32Array(48000 * 3);
  const trimmed = trimToSeconds(samples, 48000, 1);
  assert.equal(trimmed.length, 48000);
  const short = new Float32Array(100);
  assert.equal(trimToSeconds(short, 48000, 1).length, 100);
});

/* ==========================================================
   窓関数
   ========================================================== */

test('buildWindow は型ごとの長さと端の値を返す', () => {
  const rect = buildWindow('rectangular', 8);
  assert.equal(rect.length, 8);
  for (const value of rect) assert.equal(value, 1);

  const hann = buildWindow('hann', 8);
  approx(hann[0], 0, 1e-9);
  approx(hann[7], 0, 1e-9);
  // 対称性
  for (let i = 0; i < 4; i += 1) approx(hann[i], hann[7 - i], 1e-9);

  const hamming = buildWindow('hamming', 8);
  approx(hamming[0], 0.08, 1e-6);
  approx(hamming[7], 0.08, 1e-6);

  const blackman = buildWindow('blackman', 8);
  approx(blackman[0], 0, 1e-9);
});

test('buildWindow は n=1 を扱える', () => {
  assert.deepEqual([...buildWindow('hann', 1)], [1]);
});

test('windowSum は矩形で N になる', () => {
  approx(windowSum(buildWindow('rectangular', 16)), 16);
});

test('windowLabel は全型にラベルを持つ', () => {
  for (const type of ['hann', 'hamming', 'blackman', 'rectangular']) {
    assert.ok(windowLabel(type).length > 0);
  }
});

/* ==========================================================
   FFT
   ========================================================== */

test('fft は 2 の冪以外で throw する', () => {
  assert.throws(() => fft(new Float32Array(3), new Float32Array(3)));
});

test('fft はインパルスで全ビン 1 になる', () => {
  const n = 16;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  re[0] = 1;
  fft(re, im);
  for (let k = 0; k < n; k += 1) {
    approx(re[k], 1, 1e-5);
    approx(im[k], 0, 1e-5);
  }
});

test('fft は直流 [1,1,1,1] で bin0=4 になる', () => {
  const re = Float32Array.from([1, 1, 1, 1]);
  const im = new Float32Array(4);
  fft(re, im);
  approx(re[0], 4, 1e-5);
  approx(re[1], 0, 1e-5);
  approx(re[2], 0, 1e-5);
});

/* ==========================================================
   スペクトル
   ========================================================== */

test('magnitudeSpectrum はビン中心の正弦でそのビンが 0 dB になる', () => {
  const n = 256;
  const bin = 8;
  const frame = binSine(n, bin);
  const mag = magnitudeSpectrum(frame, { fftSize: n, windowType: 'rectangular' });
  assert.equal(mag.length, n / 2 + 1);
  approx(amplitudeToDb(mag[bin]), 0, 0.05);
  // bin 0 付近には何も無い
  assert.ok(amplitudeToDb(mag[0]) < -40);
});

test('magnitudeSpectrum は窓を変えてもピーク位置を保つ', () => {
  const n = 512;
  const bin = 40;
  const frame = binSine(n, bin);
  for (const windowType of ['hann', 'hamming', 'blackman', 'rectangular']) {
    const mag = magnitudeSpectrum(frame, { fftSize: n, windowType });
    let maxBin = 0;
    for (let k = 1; k < mag.length; k += 1) {
      if (mag[k] > mag[maxBin]) maxBin = k;
    }
    assert.equal(maxBin, bin, `${windowType} のピーク位置がずれた`);
  }
});

test('amplitudeToDb / dbToAmplitude の往復', () => {
  approx(amplitudeToDb(1), 0, 1e-9);
  approx(amplitudeToDb(0.1), -20, 1e-9);
  approx(amplitudeToDb(0.5), -6.0206, 1e-3);
  assert.equal(amplitudeToDb(0), DB_FLOOR);
  assert.equal(amplitudeToDb(-1e-20), DB_FLOOR);
  approx(dbToAmplitude(0), 1, 1e-9);
  approx(dbToAmplitude(-20), 0.1, 1e-9);
});

test('powerToDb', () => {
  approx(powerToDb(1), 0, 1e-9);
  approx(powerToDb(0.01), -20, 1e-9);
  assert.equal(powerToDb(0), DB_FLOOR);
});

/* ==========================================================
   ビン ↔ 周波数
   ========================================================== */

test('binToHz / hzToBin は逆変換', () => {
  approx(binToHz(100, 48000, 2048), 2343.75, 1e-6);
  approx(hzToBin(2343.75, 48000, 2048), 100, 1e-6);
  assert.equal(binToHz(0, 48000, 2048), 0);
  assert.equal(hzToBin(1000, 0, 2048), 0);
});

test('frequencyTable は単調増加', () => {
  const table = frequencyTable(8, 48000, 2048);
  assert.equal(table.length, 8);
  for (let i = 1; i < table.length; i += 1) assert.ok(table[i] > table[i - 1]);
});

test('freqToNormalized / normalizedToFreq の往復 (線形・対数)', () => {
  for (const logFreq of [false, true]) {
    const min = 20;
    const max = 20000;
    for (const freq of [20, 100, 1000, 20000]) {
      const t = freqToNormalized(freq, min, max, logFreq);
      assert.ok(t >= 0 && t <= 1);
      const back = normalizedToFreq(t, min, max, logFreq);
      approx(back, freq, 1e-3);
    }
  }
  approx(freqToNormalized(1000, 1000, 1000, false), 0, 1e-9);
});

/* ==========================================================
   STFT
   ========================================================== */

test('planStft はフレーム数を正しく見積もる', () => {
  const plan = planStft({ sampleLength: 2048, fftSize: 2048, hopSize: 512 });
  assert.equal(plan.frameCount, 1);
  assert.equal(plan.binCount, 1025);

  const plan2 = planStft({ sampleLength: 4096, fftSize: 2048, hopSize: 512 });
  assert.equal(plan2.frameCount, 5); // (4096-2048)/512 + 1

  const plan3 = planStft({ sampleLength: 100, fftSize: 2048, hopSize: 512 });
  assert.equal(plan3.frameCount, 1);
});

test('computeStft は正しい次数と dB を返す', () => {
  const sampleRate = 48000;
  const samples = sine(sampleRate, 1000, 0.2);
  const result = computeStft({ samples, sampleRate, fftSize: 1024, hopSize: 256, windowType: 'hann' });
  assert.equal(result.binCount, 513);
  assert.equal(result.fftSize, 1024);
  assert.equal(result.hopSize, 256);
  assert.equal(result.frameCount, planStft({ sampleLength: samples.length, fftSize: 1024, hopSize: 256 }).frameCount);
  assert.equal(result.db.length, result.frameCount * result.binCount);
  assert.ok(Math.abs(result.duration - 0.2) < 1e-6);

  // 1000Hz 付近にピークがあり、値は概ね 0 dB
  const slice = spectrumSlice(result.db, result.frameCount, result.binCount, 0);
  const peakBin = Math.round(hzToBin(1000, sampleRate, 1024));
  assert.ok(amplitudeToDb(Math.pow(10, slice[peakBin] / 20)) > -6);
  assert.equal(slice.length, result.binCount);
});

test('computeStft は進捗コールバックを呼ぶ', () => {
  const samples = sine(8000, 200, 0.5);
  const calls = [];
  computeStft({ samples, sampleRate: 8000, fftSize: 512, hopSize: 256, onProgress: (p) => calls.push(p) });
  assert.ok(calls.length > 0);
  assert.ok(calls[calls.length - 1] <= 1 && calls[calls.length - 1] > 0);
});

test('spectrumSlice は範囲外インデックスを丸める', () => {
  const db = Float32Array.from([-10, -20, -30, -40]);
  const slice = spectrumSlice(db, 2, 2, 99);
  assert.deepEqual([...slice], [-30, -40]);
});

test('averageSpectrum はエネルギー平均を dB で返す', () => {
  // 2 フレーム x 1 ビン。50% ずつ → 平均エネルギーは元と同じ → 同じ dB
  const db = Float32Array.from([0, 0]);
  const avg = averageSpectrum(db, 2, 1);
  approx(avg[0], 0, 1e-4);
});

/* ==========================================================
   ピーク検出
   ========================================================== */

test('findPeaks は局所最大を拾う', () => {
  const spectrum = new Float32Array(64).fill(-100);
  spectrum[10] = -20;
  spectrum[11] = -10;
  spectrum[12] = -21;
  spectrum[40] = -30;
  spectrum[41] = -25;
  spectrum[42] = -31;
  const peaks = findPeaks(spectrum, {
    sampleRate: 48000,
    fftSize: 2048,
    thresholdDb: -60,
    minSeparationBins: 4,
  });
  assert.equal(peaks.length, 2);
  assert.equal(peaks[0].bin, 11);
  assert.equal(peaks[1].bin, 41);
  assert.ok(peaks[1].hz > peaks[0].hz);
});

test('findPeaks はしきい値未満と近接を除く', () => {
  const spectrum = new Float32Array(32).fill(-100);
  spectrum[5] = -50; // しきい値未満
  spectrum[5 + 1] = -55;
  spectrum[5 - 1] = -55;
  const none = findPeaks(spectrum, { thresholdDb: -40, minSeparationBins: 4 });
  assert.deepEqual(none, []);

  const close = new Float32Array(32).fill(-100);
  close[10] = -10;
  close[11] = -12;
  const peaks = findPeaks(close, { thresholdDb: -40, minSeparationBins: 4 });
  assert.equal(peaks.length, 1);
});

test('findPeaks は maxPeaks を守る', () => {
  const spectrum = new Float32Array(100).fill(-100);
  for (let k = 10; k < 90; k += 10) spectrum[k] = -20;
  const peaks = findPeaks(spectrum, { thresholdDb: -40, minSeparationBins: 2, maxPeaks: 3 });
  assert.equal(peaks.length, 3);
});

/* ==========================================================
   カラーマップ・画像
   ========================================================== */

test('sampleColormap は端の色を返す', () => {
  assert.deepEqual(sampleColormap('grayscale', 0), [0, 0, 0]);
  assert.deepEqual(sampleColormap('grayscale', 1), [255, 255, 255]);
  const mid = sampleColormap('viridis', 0.5);
  assert.equal(mid.length, 3);
  for (const c of mid) assert.ok(c >= 0 && c <= 255);
});

test('dbToColor はレンジ外を丸める', () => {
  assert.deepEqual(dbToColor(-1000, { minDb: -100, maxDb: 0, colormap: 'grayscale' }), [0, 0, 0]);
  assert.deepEqual(dbToColor(1000, { minDb: -100, maxDb: 0, colormap: 'grayscale' }), [255, 255, 255]);
});

test('buildSpectrogramImage は正しいサイズと不透明ピクセルを返す', () => {
  const frameCount = 4;
  const binCount = 8;
  const db = new Float32Array(frameCount * binCount);
  for (let i = 0; i < db.length; i += 1) db[i] = -80 + (i % 8) * 10;
  const image = buildSpectrogramImage({
    db,
    frameCount,
    binCount,
    sampleRate: 8000,
    fftSize: 16,
    minFreq: 20,
    maxFreq: 4000,
    logFreq: true,
    minDb: -80,
    maxDb: 0,
    colormap: 'viridis',
    width: 16,
    height: 8,
  });
  assert.equal(image.width, 16);
  assert.equal(image.height, 8);
  assert.equal(image.data.length, 16 * 8 * 4);
  for (let p = 3; p < image.data.length; p += 4) assert.equal(image.data[p], 255);
});

test('buildSpectrogramImage は 1x1 でも壊れない', () => {
  const image = buildSpectrogramImage({
    db: Float32Array.from([-40]),
    frameCount: 1,
    binCount: 1,
    sampleRate: 8000,
    fftSize: 2,
    width: 1,
    height: 1,
  });
  assert.equal(image.data.length, 4);
  assert.equal(image.data[3], 255);
});

/* ==========================================================
   書き出し
   ========================================================== */

test('sliceToCsv はヘッダーと行を持つ', () => {
  const freqs = Float32Array.from([0, 23.4, 46.8]);
  const db = Float32Array.from([-10, -20, -30]);
  const csv = sliceToCsv(freqs, db);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'frequency_hz,magnitude_db');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith('0.000,-10.0000'));
});

test('peaksToCsv はヘッダーと行を持つ', () => {
  const csv = peaksToCsv([{ bin: 11, hz: 257.8, db: -10 }]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'bin,frequency_hz,db');
  assert.equal(lines.length, 2);
});

test('estimateMemoryBytes と buildFileName', () => {
  assert.equal(estimateMemoryBytes(10, 5), 200);
  assert.equal(buildFileName('song.m4a', 'png'), 'song.png');
  assert.equal(buildFileName('My Song (live)!.wav', 'csv'), 'My Song (live)!.csv');
  assert.equal(buildFileName('', 'csv'), 'audio.csv');
});
