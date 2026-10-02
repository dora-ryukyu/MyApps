/**
 * pipeline.mjs — ビート/ダウンビート解析の純ロジック
 *
 * DOM / Web Audio / ONNX Runtime に依存しない計算だけを置き、`node --test` で検証する。
 * 推論そのものは script.js が担当する:
 *   - CPJKU Beat This! (ISMIR 2024, MIT) の ONNX 変換
 *     https://github.com/CPJKU/beat_this
 *     https://huggingface.co/ashudesai/songbird-models
 *
 * 前処理は公式実装 (beat_this.preprocessing.LogMelSpect) に一致させる:
 *   sample_rate=22050, n_fft=1024, hop_length=441, n_mels=128,
 *   f_min=30, f_max=11000, mel_scale="slaney", normalized="frame_length",
 *   power=1, log_multiplier=1000。mel_spectrogram.onnx はこの変換を内包する。
 *
 * モデル入出力 (実機で確認済み, 2026-10-02):
 *   mel_spectrogram.onnx : audio_pcm float32 [1, N]  ->  mel_spectrogram [1, T, 128]
 *   small0.onnx          : spectrogram [1, T, 128]   ->  beat [1, T], downbeat [1, T]
 *   ただし入力名は変換版によって異なりうるため script.js は inputNames を使う。
 *
 * チャンク分割と集約は公式 inference.py の split_piece / aggregate_prediction
 * (chunk_size=1500, border_size=6, overlap_mode="keep_first") を移植する。
 */

/* ==========================================================
   音声 / モデル定数
   ========================================================== */

export const SAMPLE_RATE = 22050;
export const N_FFT = 1024;
export const HOP_LENGTH = 441;
export const N_MELS = 128;
/** フレームレート (フレーム/秒)。22050 / 441 = 50 */
export const FPS = SAMPLE_RATE / HOP_LENGTH;

/** Beat This! の学習時のチャンク長 (フレーム)。約 30 秒。 */
export const CHUNK_SIZE = 1500;
/** 端で学習していない分を捨てるフレーム数。 */
export const BORDER_SIZE = 6;

/** ピーク検出の半径 (フレーム)。公式の max_pool1d(kernel=7) = ±3 フレーム = ±70ms。 */
export const PEAK_RADIUS = 3;
/** ピークとして残すロジットの下限。sigmoid(0)=0.5 に相当。 */
export const PEAK_THRESHOLD = 0;
/** 隣接ピークをまとめる許容幅 (フレーム)。 */
export const DEDUPE_WIDTH = 1;

export const MAX_INPUT_SECONDS = 600;
export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const DEFAULT_METER = 4;

/** HuggingFace のモデル (MIT)。SONGBIRD_MODEL_BASE からの相対名。 */
export const SONGBIRD_MODEL_BASE =
  'https://huggingface.co/ashudesai/songbird-models/resolve/main/';
export const MEL_MODEL_FILE = 'mel_spectrogram.onnx';
export const BEAT_MODEL_FILE = 'small0.onnx';
/** 実測値 (2026-10-02 に HEAD / ダウンロードで確認) */
export const MEL_MODEL_BYTES = 302301;
export const SMALL_MODEL_BYTES = 10401044;
export const ORT_WASM_BYTES = 11210254;
export const ORT_LOADER_BYTES = 80000;

/** onnxruntime-web の ESM ローダと wasm の置き場所 (jsDelivr) */
export const ORT_VERSION = '1.22.0';
export const ORT_DIST_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_MODULE_URL = `${ORT_DIST_BASE}ort.wasm.min.mjs`;
export const ORT_WASM_PATHS = ORT_DIST_BASE;

export const AUDIO_EXTENSIONS = Object.freeze([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.webm',
]);

/** 初回ダウンロード量の見積り (メル変換 + ビートモデル + ONNX Runtime の wasm) */
export function estimateDownloadBytes() {
  return MEL_MODEL_BYTES + SMALL_MODEL_BYTES + ORT_WASM_BYTES + ORT_LOADER_BYTES;
}

/* ==========================================================
   数値ユーティリティ
   ========================================================== */

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/* ==========================================================
   音声: モノラル化 / リサンプル
   ========================================================== */

/**
 * 複数チャンネルを 1 本のモノラルに平均する。
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  const valid = channels.filter((c) => c && Number.isFinite(c.length));
  if (valid.length === 0) return new Float32Array(0);
  if (valid.length === 1) return Float32Array.from(valid[0]);
  const length = Math.min(...valid.map((c) => c.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of valid) sum += channel[i];
    out[i] = sum / valid.length;
  }
  return out;
}

/**
 * 線形補間でサンプルレートを変換するフォールバック実装。
 * ブラウザでは OfflineAudioContext を優先し、使えない環境でのみ使う。
 */
export function resampleLinear(input, inRate, outRate) {
  const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
  if (!(inRate > 0) || !(outRate > 0)) throw new RangeError('サンプルレートは正の数です');
  if (src.length === 0) return new Float32Array(0);
  if (inRate === outRate) return Float32Array.from(src);
  const outLength = Math.max(1, Math.round((src.length * outRate) / inRate));
  const out = new Float32Array(outLength);
  if (outLength === 1) {
    out[0] = src[0];
    return out;
  }
  const ratio = (src.length - 1) / (outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

/* ==========================================================
   フレーム / チャンク
   ========================================================== */

/** 22050Hz のサンプル数からメルフレーム数を求める (公式の STFT と一致)。 */
export function melFrameCount(numSamples, hop = HOP_LENGTH) {
  const n = Math.floor(Number(numSamples));
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!(hop > 0)) throw new RangeError('hop は正の数です');
  return Math.floor(n / hop) + 1;
}

export function frameToSeconds(frame, fps = FPS) {
  const f = Number(frame);
  if (!Number.isFinite(f)) return 0;
  return f / fps;
}

export function secondsToFrame(seconds, fps = FPS) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return 0;
  return Math.round(s * fps);
}

/**
 * フレーム列を公式と同じ規則でチャンクに分ける。
 * `starts = arange(-border, total - border, chunk_size - 2*border)`。
 * avoid_short_end のときは最後の開始位置を末尾に寄せる。
 * @returns {{start:number, chunkStart:number, chunkEnd:number, padLeft:number, padRight:number}[]}
 */
export function planSpectChunks(
  totalFrames,
  { chunkSize = CHUNK_SIZE, border = BORDER_SIZE, avoidShortEnd = true } = {},
) {
  const total = Math.floor(Number(totalFrames));
  if (!Number.isFinite(total) || total < 0) throw new RangeError('フレーム数が不正です');
  if (total === 0) return [];
  const cs = Math.floor(Number(chunkSize));
  const b = Math.floor(Number(border));
  if (!(cs > 0)) throw new RangeError('チャンク長は正の数です');
  if (!(b >= 0) || 2 * b >= cs) throw new RangeError('border は 0 以上、チャンク長の半分未満です');
  if (total <= cs) return [{ start: 0, chunkStart: 0, chunkEnd: total, padLeft: 0, padRight: 0 }];

  const hop = cs - 2 * b;
  const starts = [];
  for (let s = -b; s < total - b; s += hop) starts.push(s);
  if (avoidShortEnd && total > cs - 2 * b && starts.length > 0) {
    starts[starts.length - 1] = total - (cs - b);
  }
  return starts.map((start) => {
    const chunkStart = Math.max(start, 0);
    const chunkEnd = Math.min(start + cs, total);
    return {
      start,
      chunkStart,
      chunkEnd,
      padLeft: Math.max(0, -start),
      padRight: Math.max(0, Math.min(b, start + cs - total)),
    };
  });
}

/**
 * 1 チャンク分のメル入力をゼロパディング付きで組み立てる。
 * @param {Float32Array|number[]} spect フラットな [frames * bins]
 * @param {object} plan planSpectChunks の要素
 * @param {number} bins メルビン数 (128)
 * @param {number} chunkSize チャンク長 (frames)
 * @returns {Float32Array} length = chunkSize * bins
 */
export function buildChunkInput(spect, plan, bins = N_MELS, chunkSize = CHUNK_SIZE) {
  const src = spect instanceof Float32Array ? spect : Float32Array.from(spect || []);
  const out = new Float32Array(chunkSize * bins);
  const frames = plan.chunkEnd - plan.chunkStart;
  if (frames <= 0) return out;
  const offset = plan.padLeft * bins;
  out.set(src.subarray(plan.chunkStart * bins, plan.chunkEnd * bins), offset);
  return out;
}

/**
 * チャンクごとの予測を全体フレーム列へ集約する (overlap_mode="keep_first")。
 * 先のチャンクの予測が後のチャンクの予測を上書きする。
 * @param {{beat:Float32Array|number[], downbeat:Float32Array|number[]}[]} chunkPreds
 * @param {object[]} plans
 * @returns {{beat:Float32Array, downbeat:Float32Array}}
 */
export function aggregateChunkPredictions(
  chunkPreds,
  plans,
  totalFrames,
  { chunkSize = CHUNK_SIZE, border = BORDER_SIZE } = {},
) {
  const total = Math.max(0, Math.floor(Number(totalFrames)));
  const beat = new Float32Array(total).fill(-1000);
  const downbeat = new Float32Array(total).fill(-1000);
  const list = Array.isArray(plans) ? plans : [];
  // keep_first: 後のチャンクから書いて、先のチャンクで上書きする
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const plan = list[i];
    const pred = chunkPreds[i];
    if (!plan || !pred) continue;
    const from = plan.start + border;
    const length = chunkSize - 2 * border;
    for (let k = 0; k < length; k += 1) {
      const t = from + k;
      if (t < 0 || t >= total) continue;
      beat[t] = pred.beat[border + k];
      downbeat[t] = pred.downbeat[border + k];
    }
  }
  return { beat, downbeat };
}

/* ==========================================================
   ピーク検出
   ========================================================== */

/**
 * 隣接するフレーム番号を width 以内ならまとめ、平均値へ置き換える。
 * 公式 deduplicate_peaks の移植。
 */
export function deduplicatePeaks(frames, width = DEDUPE_WIDTH) {
  const list = (Array.isArray(frames) ? frames : []).map((v) => Number(v)).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  if (list.length === 0) return out;
  let p = list[0];
  let c = 1;
  for (let i = 1; i < list.length; i += 1) {
    const p2 = list[i];
    if (p2 - p <= width) {
      c += 1;
      p += (p2 - p) / c;
    } else {
      out.push(p);
      p = p2;
      c = 1;
    }
  }
  out.push(p);
  return out;
}

/**
 * ロジット列からビート位置 (秒) を検出する。
 * 公式 postp_minimal: ロジット > 0 かつ ±radius フレームの最大値であるフレームを採る。
 * @param {Float32Array|number[]} logits
 * @returns {number[]} 秒 (昇順)
 */
export function pickPeaks(
  logits,
  { fps = FPS, radius = PEAK_RADIUS, threshold = PEAK_THRESHOLD, dedupeWidth = DEDUPE_WIDTH } = {},
) {
  const data = logits instanceof Float32Array ? logits : Float32Array.from(logits || []);
  const n = data.length;
  const frames = [];
  for (let i = 0; i < n; i += 1) {
    const v = data[i];
    if (!(v > threshold)) continue;
    let m = v;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    for (let j = lo; j <= hi; j += 1) if (data[j] > m) m = data[j];
    if (v === m) frames.push(i);
  }
  return deduplicatePeaks(frames, dedupeWidth).map((f) => f / fps);
}

/** ダウンビートを最寄りのビート位置へスナップする (公式 _postp_minimal_item と同じ)。 */
export function snapToBeats(times, beats, tolerance = Infinity) {
  const points = (Array.isArray(beats) ? beats : []).filter(Number.isFinite);
  const out = [];
  for (const t of Array.isArray(times) ? times : []) {
    if (!Number.isFinite(t) || points.length === 0) continue;
    let best = points[0];
    for (const b of points) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
    if (Math.abs(best - t) <= tolerance) out.push(best);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* ==========================================================
   テンポ / 拍子の推定
   ========================================================== */

/**
 * ビート間隔の中央値から BPM を推定する。外れ値に強い。
 * @returns {{bpm:number, confidence:number, intervalCount:number, intervalSeconds:number}}
 */
export function estimateTempo(beatTimes, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const times = (Array.isArray(beatTimes) ? beatTimes : [])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1];
    if (!(d > 0)) continue;
    const bpm = 60 / d;
    if (bpm >= minBpm && bpm <= maxBpm) intervals.push(d);
  }
  if (intervals.length === 0) {
    return { bpm: 0, confidence: 0, intervalCount: 0, intervalSeconds: 0 };
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = intervals.map((d) => Math.abs(d - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  const confidence = clamp(1 - mad / median, 0, 1);
  return {
    bpm: round(60 / median, 2),
    confidence: round(confidence, 2),
    intervalCount: intervals.length,
    intervalSeconds: round(median, 4),
  };
}

/**
 * ダウンビート間のビート数から拍子 (1 小節の拍数) を推定する。
 * @returns {{beatsPerBar:number, confidence:number, samples:number}}
 */
export function inferMeter(
  beatTimes,
  downbeatTimes,
  { fallback = DEFAULT_METER, maxMeter = 12 } = {},
) {
  const beats = (Array.isArray(beatTimes) ? beatTimes : []).filter(Number.isFinite).sort((a, b) => a - b);
  const downs = (Array.isArray(downbeatTimes) ? downbeatTimes : [])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (downs.length < 2 || beats.length < 2) {
    return { beatsPerBar: fallback, confidence: 0, samples: 0 };
  }
  const counts = [];
  for (let i = 0; i < downs.length - 1; i += 1) {
    const start = downs[i];
    const end = downs[i + 1];
    const n = beats.filter((b) => b >= start - 1e-6 && b < end - 1e-6).length;
    if (n >= 1 && n <= maxMeter) counts.push(n);
  }
  if (counts.length === 0) return { beatsPerBar: fallback, confidence: 0, samples: 0 };
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  let best = fallback;
  let bestCount = 0;
  for (const [meter, count] of freq) {
    if (count > bestCount || (count === bestCount && meter > best)) {
      best = meter;
      bestCount = count;
    }
  }
  return { beatsPerBar: best, confidence: round(bestCount / counts.length, 2), samples: counts.length };
}

/**
 * 検出結果を 1 つのグリッドオブジェクトにまとめる。
 * これを JSON/CSV に書き出し、midi-studio への受け渡しにも使う。
 */
export function buildBeatGrid(
  beatTimes,
  downbeatTimes,
  { fps = FPS, duration = null, maxSeconds = MAX_INPUT_SECONDS } = {},
) {
  const beats = (Array.isArray(beatTimes) ? beatTimes : [])
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= maxSeconds)
    .map((t) => round(t, 4))
    .sort((a, b) => a - b);
  const downbeats = (Array.isArray(downbeatTimes) ? downbeatTimes : [])
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= maxSeconds)
    .map((t) => round(t, 4))
    .sort((a, b) => a - b);
  const tempo = estimateTempo(beats);
  const meter = inferMeter(beats, downbeats);
  const lastBeat = beats.length ? beats[beats.length - 1] : 0;
  return {
    version: 1,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    intervalSeconds: tempo.intervalSeconds,
    beatsPerBar: meter.beatsPerBar,
    meterConfidence: meter.confidence,
    beats,
    downbeats,
    beatCount: beats.length,
    downbeatCount: downbeats.length,
    firstBeat: beats.length ? beats[0] : null,
    lastBeat: beats.length ? lastBeat : null,
    duration: Number.isFinite(duration) ? round(duration, 4) : round(lastBeat, 4),
  };
}

/* ==========================================================
   書き出し (JSON / CSV)
   ========================================================== */

export function gridToJson(grid) {
  return `${JSON.stringify(grid, null, 2)}\n`;
}

/** `time_seconds,type` の CSV。downbeat を先に、時刻でソートする。 */
export function gridToCsv(grid) {
  const rows = [['time_seconds', 'type']];
  const beats = new Set((grid && grid.beats) || []);
  const downs = new Set((grid && grid.downbeats) || []);
  const all = [...new Set([...beats, ...downs])].sort((a, b) => a - b);
  for (const t of all) {
    rows.push([String(round(t, 4)), downs.has(t) ? 'downbeat' : 'beat']);
  }
  return `${rows.map((r) => r.join(',')).join('\n')}\n`;
}

/* ==========================================================
   midi-studio への受け渡し (sessionStorage)
   ========================================================== */

/** midi-studio と共有する sessionStorage キー。両アプリでこの文字列を一致させる。 */
export const BEAT_HANDOFF_KEY = 'myapps:beat-grid';
/** 受け渡しを諦めるしきい値 */
export const HANDOFF_MAX_BYTES = 1024 * 1024;

/** 受け渡し用に最小限のフィールドだけを残す。 */
export function compactGrid(grid) {
  if (!grid || typeof grid !== 'object') return null;
  return {
    version: 1,
    bpm: grid.bpm,
    beatsPerBar: grid.beatsPerBar,
    beats: Array.isArray(grid.beats) ? grid.beats : [],
    downbeats: Array.isArray(grid.downbeats) ? grid.downbeats : [],
    duration: grid.duration,
  };
}

export function serializeBeatHandoff(grid) {
  return JSON.stringify(compactGrid(grid));
}

/** sessionStorage の生文字列を検証してグリッドに戻す。不正なら null。 */
export function deserializeBeatHandoff(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.beats) || parsed.beats.length === 0) return null;
  for (const t of parsed.beats) if (!Number.isFinite(t)) return null;
  if (parsed.downbeats !== undefined && !Array.isArray(parsed.downbeats)) return null;
  return {
    version: 1,
    bpm: Number.isFinite(parsed.bpm) ? parsed.bpm : 0,
    beatsPerBar: Number.isFinite(parsed.beatsPerBar) ? parsed.beatsPerBar : DEFAULT_METER,
    beats: parsed.beats,
    downbeats: Array.isArray(parsed.downbeats) ? parsed.downbeats : [],
    duration: Number.isFinite(parsed.duration) ? parsed.duration : 0,
  };
}

export function canHandoffBeat(grid) {
  try {
    return serializeBeatHandoff(grid).length <= HANDOFF_MAX_BYTES;
  } catch {
    return false;
  }
}

/* ==========================================================
   ファイル名 / 入力判定 / 表示
   ========================================================== */

export function isSupportedAudioFile(file) {
  if (!file) return false;
  const name = typeof file === 'string' ? file : file.name;
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function sanitizeBaseName(name) {
  if (typeof name !== 'string') return 'beats';
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned || !/[A-Za-z]/.test(cleaned)) return 'beats';
  return cleaned;
}

export function buildFileName(name, extension) {
  const ext = typeof extension === 'string' && extension.startsWith('.') ? extension : `.${extension}`;
  return `${sanitizeBaseName(name)}${ext}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '0:00.0';
  const tenths = Math.floor(s * 10) % 10;
  const secs = Math.floor(s) % 60;
  const mins = Math.floor(s / 60);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/** 拍子の表示 (例: 4/4)。分母は 4 固定 (ビート単位) とする。 */
export function formatMeter(beatsPerBar) {
  const n = clamp(Math.round(Number(beatsPerBar)), 1, 12);
  return `${n}/4`;
}
