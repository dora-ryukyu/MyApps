/**
 * pipeline.mjs — スペクトログラムの純ロジック
 *
 * DOM に依存しない計算だけをまとめる:
 *   - 窓関数 (hann / hamming / blackman / rectangular)
 *   - 基数 2 の FFT と振幅スペクトル
 *   - STFT (短時間フーリエ変換) と dB 変換
 *   - ビン ↔ Hz、対数/線形の周波数マッピング
 *   - ピーク検出と CSV 整形
 *   - カラーマップと画像 (ImageData 相当) の生成
 *
 * node --test からそのまま検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 0 を log に渡さないための下限 */
export const EPSILON = 1e-12;

/** 選択できる FFT サイズ (窓長) */
export const FFT_SIZE_OPTIONS = [256, 512, 1024, 2048, 4096, 8192];

export const DEFAULT_FFT_SIZE = 2048;
export const DEFAULT_HOP_SIZE = 512;

/** FFT サイズに対する hop の既定比率 (重なり 75%) */
export const HOP_RATIO = 0.25;

export const WINDOW_TYPES = ['hann', 'hamming', 'blackman', 'rectangular'];
export const DEFAULT_WINDOW = 'hann';

export const COLORMAP_NAMES = ['viridis', 'magma', 'ice', 'grayscale'];
export const DEFAULT_COLORMAP = 'viridis';

/** 表示・処理の既定 dB レンジ */
export const DEFAULT_MIN_DB = -100;
export const DEFAULT_MAX_DB = 0;

/** 1 回の解析で保持する最大フレーム数 (メモリ目安) */
export const MAX_STFT_FRAMES = 12000;

/** 生データを保持する最大秒数 */
export const MAX_INPUT_SECONDS = 600;

/** dB の下限 (無音・数値誤差をここへ丸める) */
export const DB_FLOOR = -160;

/* ==========================================================
   基本ユーティリティ
   ========================================================== */

export function clamp(value, min, max) {
  const v = Number.isFinite(value) ? value : min;
  if (min > max) return min;
  return Math.min(Math.max(v, min), max);
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function nextPowerOfTwo(value) {
  const n = Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
  let power = 1;
  while (power < n) power *= 2;
  return power;
}

export function isPowerOfTwo(value) {
  const n = Math.floor(value);
  return n > 0 && (n & (n - 1)) === 0;
}

/** 対数スケールの周波数軸で既定の下限 (0Hz を避ける) */
export function defaultMinFreq(sampleRate) {
  const nyquist = sampleRate / 2;
  return Math.max(20, nyquist / 2000);
}

export function formatHz(hz) {
  const value = Number.isFinite(hz) ? hz : 0;
  if (value >= 10000) return `${(value / 1000).toFixed(1)} kHz`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`;
  if (value >= 10) return `${value.toFixed(0)} Hz`;
  return `${value.toFixed(1)} Hz`;
}

export function formatDb(db) {
  const value = Number.isFinite(db) ? db : DB_FLOOR;
  return `${value.toFixed(1)} dB`;
}

export function formatSeconds(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalSeconds = Math.floor(value);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const cs = Math.floor((value - totalSeconds) * 100);
  const parts = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return `${parts}.${String(cs).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/* ==========================================================
   音声データの前処理
   ========================================================== */

/**
 * 複数チャンネルをモノラルへ平均する。長さは最大チャンネルに合わせる。
 */
export function mixToMono(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  let length = 0;
  for (const channel of channels) {
    if (channel && channel.length > length) length = channel.length;
  }
  const out = new Float32Array(length);
  for (const channel of channels) {
    if (!channel) continue;
    for (let i = 0; i < channel.length; i += 1) out[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i += 1) out[i] *= scale;
  return out;
}

/** samples を最大 maxSeconds 秒に切り詰める */
export function trimToSeconds(samples, sampleRate, maxSeconds = MAX_INPUT_SECONDS) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return samples;
  const maxLength = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= maxLength) return samples;
  return samples.subarray(0, maxLength);
}

/* ==========================================================
   窓関数
   ========================================================== */

export function windowLabel(type) {
  switch (type) {
    case 'hann': return 'Hann (ハン)';
    case 'hamming': return 'Hamming (ハミング)';
    case 'blackman': return 'Blackman (ブラックマン)';
    case 'rectangular': return 'Rectangular (矩形)';
    default: return String(type);
  }
}

/**
 * 窓係数を生成する。n=1 のときは [1]。
 */
export function buildWindow(type, size) {
  const n = Math.max(1, Math.floor(Number.isFinite(size) ? size : 1));
  const win = new Float32Array(n);
  if (n === 1) {
    win[0] = 1;
    return win;
  }
  const denom = n - 1;
  for (let i = 0; i < n; i += 1) {
    const x = (2 * Math.PI * i) / denom;
    switch (type) {
      case 'hann':
        win[i] = 0.5 - 0.5 * Math.cos(x);
        break;
      case 'hamming':
        win[i] = 0.54 - 0.46 * Math.cos(x);
        break;
      case 'blackman':
        win[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
        break;
      case 'rectangular':
      default:
        win[i] = 1;
        break;
    }
  }
  return win;
}

/** 窓係数の総和 (正規化に使う) */
export function windowSum(win) {
  let sum = 0;
  for (let i = 0; i < win.length; i += 1) sum += win[i];
  return sum;
}

/* ==========================================================
   FFT
   ========================================================== */

/**
 * 基数 2 の反復 FFT。re / im を in-place で書き換える。
 * re.length は 2 の冪であること。
 */
export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if (!isPowerOfTwo(n)) throw new Error('fft: 長さは 2 の冪である必要があります');

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * 1 フレームの振幅スペクトル。binCount = fftSize/2 + 1。
 * 窓の総和で正規化するので、窓の種類によらずフルスケール正弦が約 0 dB になる。
 */
export function magnitudeSpectrum(frame, options = {}) {
  const fftSize = Math.max(1, Math.floor(options.fftSize || frame.length));
  const windowType = options.windowType || DEFAULT_WINDOW;
  const win = options.window || buildWindow(windowType, fftSize);
  const normalize = options.normalize !== false;

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const offset = options.offset || 0;
  for (let i = 0; i < fftSize; i += 1) {
    const sample = frame[offset + i];
    re[i] = (Number.isFinite(sample) ? sample : 0) * (win[i] || 0);
  }
  fft(re, im);

  const binCount = (fftSize >> 1) + 1;
  const mag = new Float32Array(binCount);
  const sum = normalize ? windowSum(win) : 0;
  const norm = normalize && sum > 0 ? 2 / sum : 1;
  for (let k = 0; k < binCount; k += 1) {
    mag[k] = Math.hypot(re[k], im[k]) * norm;
  }
  return mag;
}

/* ==========================================================
   dB / 線形
   ========================================================== */

export function amplitudeToDb(amplitude, floorDb = DB_FLOOR) {
  const a = Math.abs(Number.isFinite(amplitude) ? amplitude : 0);
  if (a <= EPSILON) return floorDb;
  return Math.max(floorDb, 20 * Math.log10(a));
}

export function powerToDb(power, floorDb = DB_FLOOR) {
  const p = Number.isFinite(power) && power > 0 ? power : 0;
  if (p <= EPSILON) return floorDb;
  return Math.max(floorDb, 10 * Math.log10(p));
}

export function dbToAmplitude(db) {
  return Math.pow(10, (Number.isFinite(db) ? db : DB_FLOOR) / 20);
}

/* ==========================================================
   ビン ↔ 周波数
   ========================================================== */

export function binToHz(bin, sampleRate, fftSize) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(fftSize) || fftSize <= 0) {
    return 0;
  }
  return (bin * sampleRate) / fftSize;
}

export function hzToBin(hz, sampleRate, fftSize) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(fftSize) || fftSize <= 0) {
    return 0;
  }
  return (hz * fftSize) / sampleRate;
}

/** binCount 個の各ビンの中心周波数 (Hz) */
export function frequencyTable(binCount, sampleRate, fftSize) {
  const table = new Float32Array(binCount);
  for (let k = 0; k < binCount; k += 1) table[k] = binToHz(k, sampleRate, fftSize);
  return table;
}

/** 周波数を 0..1 の軸位置へ写す (logFreq で対数) */
export function freqToNormalized(freq, minFreq, maxFreq, logFreq = false) {
  const lo = Math.max(EPSILON, Math.min(minFreq, maxFreq));
  const hi = Math.max(lo + EPSILON, maxFreq);
  const f = clamp(freq, lo, hi);
  if (logFreq) {
    return clamp01((Math.log(f) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
  }
  return clamp01((f - lo) / (hi - lo));
}

/** 0..1 の軸位置を周波数へ戻す */
export function normalizedToFreq(t, minFreq, maxFreq, logFreq = false) {
  const lo = Math.max(EPSILON, Math.min(minFreq, maxFreq));
  const hi = Math.max(lo + EPSILON, maxFreq);
  const x = clamp01(t);
  if (logFreq) return lo * Math.pow(hi / lo, x);
  return lo + x * (hi - lo);
}

/* ==========================================================
   STFT
   ========================================================== */

/**
 * 解析するフレーム数を計算する (末尾の半端は捨てる)。
 */
export function planStft({ sampleLength, fftSize, hopSize }) {
  const fft = Math.max(1, Math.floor(fftSize));
  const hop = Math.max(1, Math.floor(hopSize));
  let frameCount;
  if (sampleLength < fft) {
    frameCount = 1;
  } else {
    frameCount = Math.floor((sampleLength - fft) / hop) + 1;
  }
  frameCount = Math.min(frameCount, MAX_STFT_FRAMES);
  return {
    frameCount: Math.max(1, frameCount),
    binCount: (fft >> 1) + 1,
    fftSize: fft,
    hopSize: hop,
  };
}

/**
 * 短時間フーリエ変換。
 * 戻り値: { db, frameCount, binCount, fftSize, hopSize, sampleRate, duration }
 * db は frameCount * binCount の Float32Array (dB, row-major: frame が先)。
 */
export function computeStft({
  samples,
  sampleRate,
  fftSize = DEFAULT_FFT_SIZE,
  hopSize = DEFAULT_HOP_SIZE,
  windowType = DEFAULT_WINDOW,
  minDb = DB_FLOOR,
  onProgress = null,
  maxFrames = MAX_STFT_FRAMES,
} = {}) {
  const data = samples || new Float32Array(0);
  const plan = planStft({ sampleLength: data.length, fftSize, hopSize });
  const frameCount = Math.min(plan.frameCount, Math.max(1, Math.floor(maxFrames)));
  const { binCount, fftSize: fft } = plan;
  const win = buildWindow(windowType, fft);
  const db = new Float32Array(frameCount * binCount);
  const report = typeof onProgress === 'function' ? onProgress : null;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * plan.hopSize;
    const mag = magnitudeSpectrum(data, { fftSize: fft, window: win, offset });
    const base = frame * binCount;
    for (let k = 0; k < binCount; k += 1) {
      db[base + k] = amplitudeToDb(mag[k], minDb);
    }
    if (report && (frame % 32 === 0 || frame === frameCount - 1)) {
      report((frame + 1) / frameCount, frame + 1, frameCount);
    }
  }

  const duration = Number.isFinite(sampleRate) && sampleRate > 0 ? data.length / sampleRate : 0;
  return {
    db,
    frameCount,
    binCount,
    fftSize: fft,
    hopSize: plan.hopSize,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : 0,
    duration,
  };
}

/** STFT 結果の 1 フレーム分 (1 スライス) を取り出す */
export function spectrumSlice(db, frameCount, binCount, frameIndex) {
  const frame = clamp(Math.floor(frameIndex), 0, Math.max(0, frameCount - 1));
  const base = frame * binCount;
  const out = new Float32Array(binCount);
  for (let k = 0; k < binCount; k += 1) {
    const value = db[base + k];
    out[k] = Number.isFinite(value) ? value : DB_FLOOR;
  }
  return out;
}

/**
 * 全フレームの平均スペクトル (dB)。エネルギー平均してから dB へ戻す。
 */
export function averageSpectrum(db, frameCount, binCount) {
  const out = new Float32Array(binCount);
  if (frameCount <= 0) return out;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * binCount;
    for (let k = 0; k < binCount; k += 1) {
      const value = db[base + k];
      out[k] += dbToAmplitude(Number.isFinite(value) ? value : DB_FLOOR) ** 2;
    }
  }
  const scale = 1 / frameCount;
  for (let k = 0; k < binCount; k += 1) {
    out[k] = powerToDb(out[k] * scale);
  }
  return out;
}

/* ==========================================================
   ピーク検出
   ========================================================== */

/**
 * スペクトル (dB) から局所最大を拾い、近接を間引いて返す。
 * 戻り値: [{ bin, hz, db }] (dB 降順)
 */
export function findPeaks(spectrumDb, options = {}) {
  const sampleRate = options.sampleRate || 0;
  const fftSize = options.fftSize || 0;
  const thresholdDb = Number.isFinite(options.thresholdDb) ? options.thresholdDb : -60;
  const minSeparationBins = Math.max(1, Math.floor(options.minSeparationBins || 4));
  const maxPeaks = Math.max(1, Math.floor(options.maxPeaks || 12));
  const length = spectrumDb ? spectrumDb.length : 0;
  if (length < 3) return [];

  const candidates = [];
  for (let k = 1; k < length - 1; k += 1) {
    const value = spectrumDb[k];
    if (!Number.isFinite(value)) continue;
    if (value < thresholdDb) continue;
    if (value >= spectrumDb[k - 1] && value > spectrumDb[k + 1]) {
      candidates.push({ bin: k, hz: binToHz(k, sampleRate, fftSize), db: value });
    }
  }
  candidates.sort((a, b) => b.db - a.db);

  const picked = [];
  for (const peak of candidates) {
    if (picked.length >= maxPeaks) break;
    let close = false;
    for (const other of picked) {
      if (Math.abs(other.bin - peak.bin) < minSeparationBins) {
        close = true;
        break;
      }
    }
    if (!close) picked.push(peak);
  }
  return picked;
}

/* ==========================================================
   カラーマップ
   ========================================================== */

const COLORMAP_STOPS = {
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [80, 18, 123],
    [182, 54, 121],
    [251, 136, 97],
    [252, 253, 191],
  ],
  ice: [
    [2, 10, 30],
    [20, 60, 120],
    [40, 150, 200],
    [120, 220, 235],
    [240, 255, 255],
  ],
  grayscale: [
    [0, 0, 0],
    [255, 255, 255],
  ],
};

export function sampleColormap(name, t) {
  const stops = COLORMAP_STOPS[name] || COLORMAP_STOPS.viridis;
  const x = clamp01(t);
  if (stops.length === 1) return stops[0].slice();
  const scaled = x * (stops.length - 1);
  const lower = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - lower;
  const a = stops[lower];
  const b = stops[lower + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

/** dB をカラーへ。minDb 未満は最下色、maxDb 以上は最上色。 */
export function dbToColor(db, options = {}) {
  const minDb = Number.isFinite(options.minDb) ? options.minDb : DEFAULT_MIN_DB;
  const maxDb = Number.isFinite(options.maxDb) ? options.maxDb : DEFAULT_MAX_DB;
  const name = options.colormap || DEFAULT_COLORMAP;
  const span = maxDb - minDb;
  const t = span > 0 ? (db - minDb) / span : 0;
  return sampleColormap(name, t);
}

/**
 * STFT 結果を ImageData 相当 (RGBA, row-major) の画像へ変換する。
 * 戻り値: { width, height, data: Uint8ClampedArray }
 */
export function buildSpectrogramImage({
  db,
  frameCount,
  binCount,
  sampleRate,
  fftSize,
  minFreq = 0,
  maxFreq,
  logFreq = false,
  minDb = DEFAULT_MIN_DB,
  maxDb = DEFAULT_MAX_DB,
  colormap = DEFAULT_COLORMAP,
  width,
  height,
} = {}) {
  const w = Math.max(1, Math.floor(width || 1));
  const h = Math.max(1, Math.floor(height || 1));
  const data = new Uint8ClampedArray(w * h * 4);
  const nyquist = sampleRate > 0 ? sampleRate / 2 : 0;
  const hi = Number.isFinite(maxFreq) && maxFreq > 0 ? Math.min(maxFreq, nyquist || maxFreq) : nyquist;
  const lo = Math.max(0, minFreq);
  const frames = Math.max(1, frameCount | 0);
  const bins = Math.max(1, binCount | 0);

  for (let y = 0; y < h; y += 1) {
    const t = h === 1 ? 1 : 1 - y / (h - 1);
    const freq = normalizedToFreq(t, lo, hi, logFreq);
    const bin = Math.round(hzToBin(freq, sampleRate, fftSize));
    const binIndex = clamp(bin, 0, bins - 1);
    for (let x = 0; x < w; x += 1) {
      const frame = w === 1 ? 0 : Math.floor((x / w) * frames);
      const frameIndex = clamp(frame, 0, frames - 1);
      const raw = db ? db[frameIndex * bins + binIndex] : DEFAULT_MIN_DB;
      const value = Number.isFinite(raw) ? raw : minDb;
      const [r, g, b] = dbToColor(value, { minDb, maxDb, colormap });
      const p = (y * w + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/* ==========================================================
   書き出し
   ========================================================== */

/** 1 スライスを CSV 文字列へ */
export function sliceToCsv(freqs, dbValues, options = {}) {
  const digits = Number.isFinite(options.digits) ? options.digits : 3;
  const lines = ['frequency_hz,magnitude_db'];
  const length = Math.min(freqs.length, dbValues.length);
  for (let k = 0; k < length; k += 1) {
    const hz = Number.isFinite(freqs[k]) ? freqs[k] : 0;
    const db = Number.isFinite(dbValues[k]) ? dbValues[k] : DB_FLOOR;
    lines.push(`${hz.toFixed(digits)},${db.toFixed(4)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** ピーク一覧を CSV 文字列へ */
export function peaksToCsv(peaks) {
  const lines = ['bin,frequency_hz,db'];
  for (const peak of peaks || []) {
    const hz = Number.isFinite(peak.hz) ? peak.hz : 0;
    const db = Number.isFinite(peak.db) ? peak.db : DB_FLOOR;
    lines.push(`${peak.bin},${hz.toFixed(3)},${db.toFixed(4)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 解析結果のサイズからメモリ使用量の目安を返す */
export function estimateMemoryBytes(frameCount, binCount) {
  return Math.max(0, frameCount) * Math.max(0, binCount) * 4;
}

/** 元のファイル名から書き出し名を作る */
export function buildFileName(name, suffix) {
  const base = String(name || 'audio')
    .replace(/[\\/]+$/, '')
    .replace(/\.[^./\\]+$/, '');
  const safe = base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'audio';
  return `${safe}.${suffix}`;
}

export const SPECTROGRAM_MIME = 'image/png';
