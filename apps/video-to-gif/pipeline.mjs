/**
 * pipeline.mjs — 動画→GIF の純ロジック
 *
 * DOM に依存しない計算だけをまとめる:
 *   - カット範囲の正規化・フレーム時刻・遅延の算出
 *   - 出力解像度の算出
 *   - 色量子化 (メディアンカット) とパレット割り当て (任意でベイヤーディザ)
 *   - フレーム差分 (透過 + 部分矩形) による容量削減
 *   - GIF89a / LZW エンコーダ
 *
 * node --test からそのまま検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

export const GIF_MIME = 'image/gif';

/** Discord の無料プランでのアップロード目安 (約10MB) */
export const DISCORD_HINT_BYTES = 10 * 1024 * 1024;

/** 1 回の書き出しで扱う最大フレーム数 */
export const MAX_OUTPUT_FRAMES = 600;

/** カットできる最大の長さ (秒) */
export const MAX_SELECTION_SECONDS = 60;

/** カット範囲の最短の長さ (秒) */
export const MIN_SELECTION_SECONDS = 0.1;

export const FPS_MIN = 5;
export const FPS_MAX = 30;

/* ==========================================================
   時間・範囲
   ========================================================== */

export function clampTime(t, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const value = Number.isFinite(t) ? t : 0;
  return Math.min(Math.max(value, 0), d);
}

/**
 * カット範囲を [0, duration] に収め、短すぎる場合は最小長へ広げる。
 */
export function normalizeTrim(start, end, duration, minDuration = MIN_SELECTION_SECONDS) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const min = Math.min(minDuration, d > 0 ? d : minDuration);
  let a = clampTime(start, d);
  let b = clampTime(end, d);
  if (b - a < min) {
    if (a + min <= d) {
      b = a + min;
    } else {
      b = d;
      a = Math.max(0, d - min);
    }
  }
  return { start: a, end: b };
}

/**
 * "1:23.45" / "0:05.00" のような表記に整形する。
 */
export function formatTimecode(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalCs = Math.round(value * 100);
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const csText = String(cs).padStart(2, '0');
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${csText}`;
  }
  return `${m}:${String(s).padStart(2, '0')}.${csText}`;
}

/** カット範囲から必要なフレーム数を求める */
export function estimateFrameCount(start, end, fps) {
  const span = Math.max(0, (Number.isFinite(end) ? end : 0) - (Number.isFinite(start) ? start : 0));
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  return Math.max(1, Math.round(span * rate));
}

/** フレームのサンプリング時刻 (秒) の一覧 */
export function sampleFrameTimes(start, end, fps) {
  const count = estimateFrameCount(start, end, fps);
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  const times = new Array(count);
  for (let i = 0; i < count; i += 1) {
    times[i] = start + i / rate;
  }
  return times;
}

/**
 * fps から GIF の遅延 (1/100 秒) を求める。
 * 端数は累積して配分し、合計が元の長さに一致するようにする。
 */
export function computeDelays(fps, frameCount) {
  const count = Math.max(1, Math.floor(frameCount));
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 1;
  const delays = new Array(count);
  let consumed = 0;
  for (let i = 1; i <= count; i += 1) {
    let delay = Math.round((i * 100) / rate) - consumed;
    if (delay < 2) delay = 2;
    delays[i - 1] = delay;
    consumed += delay;
  }
  return delays;
}

/** RGBA を丸ごと保持できるフレーム数の上限 (メモリ目安) */
export function maxFramesForMemory(width, height, budgetBytes = 160 * 1024 * 1024) {
  const frameBytes = Math.max(1, width * height * 4);
  return Math.max(1, Math.floor(budgetBytes / frameBytes));
}

/**
 * 長辺が maxLongEdge 以下になるよう縦横比を保って縮小する。
 * 拡大はしない。maxLongEdge が 0/未指定なら元のサイズ。
 */
export function computeOutputSize(srcWidth, srcHeight, maxLongEdge) {
  const w = Math.max(1, Math.round(Number.isFinite(srcWidth) ? srcWidth : 1));
  const h = Math.max(1, Math.round(Number.isFinite(srcHeight) ? srcHeight : 1));
  const longEdge = Math.max(w, h);
  const limit = Number.isFinite(maxLongEdge) ? maxLongEdge : 0;
  const scale = limit > 0 ? Math.min(1, limit / longEdge) : 1;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/** 元の動画名から GIF のファイル名を作る */
export function buildGifFileName(name) {
  const base = String(name || 'movie')
    .replace(/[\\/]+$/, '')
    .replace(/\.[^./\\]+$/, '');
  const safe = base.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${safe || 'movie'}.gif`;
}

/* ==========================================================
   バイト出力
   ========================================================== */

class ByteSink {
  constructor(capacity = 4096) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.length = 0;
  }

  ensure(extra) {
    const needed = this.length + extra;
    if (needed <= this.buf.length) return;
    let capacity = this.buf.length;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  push(byte) {
    this.ensure(1);
    this.buf[this.length] = byte & 0xff;
    this.length += 1;
  }

  pushBytes(bytes) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  pushU16(value) {
    this.push(value & 0xff);
    this.push((value >> 8) & 0xff);
  }

  toUint8Array() {
    return this.buf.slice(0, this.length);
  }
}

/* ==========================================================
   色量子化 (メディアンカット)
   ========================================================== */

function boxFromEntries(entries) {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.r < minR) minR = entry.r;
    if (entry.r > maxR) maxR = entry.r;
    if (entry.g < minG) minG = entry.g;
    if (entry.g > maxG) maxG = entry.g;
    if (entry.b < minB) minB = entry.b;
    if (entry.b > maxB) maxB = entry.b;
    count += entry.count;
  }
  return {
    entries,
    count,
    rangeR: maxR - minR,
    rangeG: maxG - minG,
    rangeB: maxB - minB,
    maxRange: Math.max(maxR - minR, maxG - minG, maxB - minB),
  };
}

function splitBox(box) {
  const { entries } = box;
  let channel = 'r';
  if (box.rangeG >= box.rangeR && box.rangeG >= box.rangeB) channel = 'g';
  else if (box.rangeB >= box.rangeR && box.rangeB >= box.rangeG) channel = 'b';
  const sorted = [...entries].sort((a, b) => a[channel] - b[channel]);
  const half = box.count / 2;
  let acc = 0;
  let split = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    acc += sorted[i].count;
    split = i + 1;
    if (acc >= half) break;
  }
  if (split < 1) split = 1;
  if (split > sorted.length - 1) split = sorted.length - 1;
  return [boxFromEntries(sorted.slice(0, split)), boxFromEntries(sorted.slice(split))];
}

/**
 * 全フレームからメディアンカットで共通パレットを作る。
 * 戻り値の colorCount は実際に使った色数。
 */
export function buildPalette(frames, maxColors = 256) {
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const histogram = new Uint32Array(32768);
  let total = 0;
  for (const frame of frames) {
    const length = frame.length;
    for (let i = 0; i + 3 < length; i += 4) {
      const key = ((frame[i] >> 3) << 10) | ((frame[i + 1] >> 3) << 5) | (frame[i + 2] >> 3);
      histogram[key] += 1;
      total += 1;
    }
  }
  if (total === 0) {
    return { palette: new Uint8Array([0, 0, 0]), colorCount: 1 };
  }

  const entries = [];
  for (let key = 0; key < 32768; key += 1) {
    if (!histogram[key]) continue;
    entries.push({
      r: (((key >> 10) & 31) << 3) + 4,
      g: (((key >> 5) & 31) << 3) + 4,
      b: ((key & 31) << 3) + 4,
      count: histogram[key],
    });
  }

  const boxes = [boxFromEntries(entries)];
  while (boxes.length < limit) {
    let target = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].entries.length < 2) continue;
      const score = boxes[i].count * (boxes[i].maxRange + 1);
      if (score > bestScore) {
        bestScore = score;
        target = i;
      }
    }
    if (target < 0) break;
    const [a, b] = splitBox(boxes[target]);
    boxes.splice(target, 1, a, b);
  }

  const palette = new Uint8Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const entry of box.entries) {
      r += entry.r * entry.count;
      g += entry.g * entry.count;
      b += entry.b * entry.count;
      n += entry.count;
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  }
  return { palette, colorCount: boxes.length };
}

/**
 * 5bit RGB (32768 通り) → パレット番号の逆引き表。
 * 1 フレームあたりの最近色探索を高速化する。
 */
export function buildPaletteLut(palette, colorCount) {
  const lut = new Uint8Array(32768);
  for (let key = 0; key < 32768; key += 1) {
    const r = (((key >> 10) & 31) << 3) + 4;
    const g = (((key >> 5) & 31) << 3) + 4;
    const b = ((key & 31) << 3) + 4;
    let best = 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < colorCount; i += 1) {
      const dr = r - palette[i * 3];
      const dg = g - palette[i * 3 + 1];
      const db = b - palette[i * 3 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
        if (distance === 0) break;
      }
    }
    lut[key] = best;
  }
  return lut;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** RGBA フレームをパレット番号の配列へ変換する */
export function mapFrameToIndices(rgba, width, height, palette, colorCount, lut, dither = false) {
  const table = lut || buildPaletteLut(palette, colorCount);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      let r = rgba[p];
      let g = rgba[p + 1];
      let b = rgba[p + 2];
      if (dither) {
        const shift = (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16 * 24 - 12;
        r += shift;
        g += shift;
        b += shift;
        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;
      }
      out[y * width + x] = table[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    }
  }
  return out;
}

/**
 * 前フレームとの差分を部分矩形へ切り出す。
 * 変化が無ければ null、変化があれば透明色付きの矩形を返す。
 */
export function diffFrames(prev, curr, width, height, transparentIndex) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (prev[row + x] === curr[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const rectWidth = maxX - minX + 1;
  const rectHeight = maxY - minY + 1;
  const indices = new Uint8Array(rectWidth * rectHeight).fill(transparentIndex);
  for (let y = minY; y <= maxY; y += 1) {
    const srcRow = y * width;
    const dstRow = (y - minY) * rectWidth;
    for (let x = minX; x <= maxX; x += 1) {
      const value = curr[srcRow + x];
      if (value !== prev[srcRow + x]) {
        indices[dstRow + (x - minX)] = value;
      }
    }
  }
  return { x: minX, y: minY, width: rectWidth, height: rectHeight, indices };
}

/* ==========================================================
   LZW
   ========================================================== */

const LZW_MAX_CODE = 4096;

/**
 * GIF の画像データを書き出す。
 * 戻り値は [最小コード長, ...サブブロック, 0x00]。
 */
export function lzwEncode(minCodeSize, pixels) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const sink = new ByteSink(Math.max(1024, pixels.length >> 1));
  const block = new Uint8Array(255);
  let blockLength = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dictionary = new Map();

  sink.push(minCodeSize);

  const flushBlock = () => {
    if (!blockLength) return;
    sink.push(blockLength);
    sink.pushBytes(block.subarray(0, blockLength));
    blockLength = 0;
  };

  const writeBits = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLength] = bitBuffer & 0xff;
      blockLength += 1;
      bitBuffer >>>= 8;
      bitCount -= 8;
      if (blockLength === 255) flushBlock();
    }
  };

  const reset = () => {
    dictionary = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  writeBits(clearCode);
  if (pixels.length > 0) {
    let current = pixels[0];
    for (let i = 1; i < pixels.length; i += 1) {
      const k = pixels[i];
      const key = (current << 8) | k;
      const found = dictionary.get(key);
      if (found !== undefined) {
        current = found;
        continue;
      }
      writeBits(current);
      if (nextCode === LZW_MAX_CODE) {
        writeBits(clearCode);
        reset();
      } else {
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
        dictionary.set(key, nextCode);
        nextCode += 1;
      }
      current = k;
    }
    writeBits(current);
  }
  writeBits(eoiCode);
  if (bitCount > 0) {
    block[blockLength] = bitBuffer & 0xff;
    blockLength += 1;
    if (blockLength === 255) flushBlock();
  }
  flushBlock();
  sink.push(0);
  return sink.toUint8Array();
}

/**
 * lzwEncode の逆変換 (テスト・検証用)。
 * data はサブブロックの長さバイトを除いたデータ列。
 */
export function lzwDecode(minCodeSize, data) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let dictionary = [];
  let codeSize = minCodeSize + 1;
  let bitPos = 0;
  let prev = null;
  const totalBits = data.length * 8;

  const reset = () => {
    dictionary = new Array(clearCode + 2);
    for (let i = 0; i < clearCode; i += 1) dictionary[i] = [i];
    dictionary[clearCode] = [];
    dictionary[eoiCode] = [];
    codeSize = minCodeSize + 1;
    prev = null;
  };

  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const bit = (data[bitPos >> 3] >> (bitPos & 7)) & 1;
      code |= bit << i;
      bitPos += 1;
    }
    return code;
  };

  reset();
  while (bitPos + codeSize <= totalBits) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === eoiCode) break;
    let entry;
    if (code < dictionary.length && dictionary[code] && dictionary[code].length > 0) {
      entry = dictionary[code];
    } else if (code === dictionary.length && prev) {
      entry = prev.concat(prev[0]);
    } else {
      break;
    }
    for (const value of entry) out.push(value);
    if (prev) {
      dictionary.push(prev.concat(entry[0]));
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}

/* ==========================================================
   GIF89a
   ========================================================== */

function nextPowerOfTwo(value) {
  let power = 2;
  while (power < value) power *= 2;
  return power;
}

function serializeGif({ width, height, palette, colorCount, transparentIndex, renderFrames, loop }) {
  const tableEntries = nextPowerOfTwo(Math.max(2, colorCount + 1));
  const tableBits = Math.max(1, Math.round(Math.log2(tableEntries)));
  const minCodeSize = Math.max(2, tableBits);
  const sink = new ByteSink(width * height);

  for (const char of 'GIF89a') sink.push(char.charCodeAt(0));

  sink.pushU16(width);
  sink.pushU16(height);
  const globalColorTable = 0x80;
  const colorResolution = 7 << 4;
  sink.push(globalColorTable | colorResolution | (tableBits - 1));
  sink.push(0);
  sink.push(0);

  sink.pushBytes(palette);
  for (let i = palette.length; i < tableEntries * 3; i += 1) sink.push(0);

  if (loop >= 0) {
    sink.push(0x21);
    sink.push(0xff);
    sink.push(11);
    for (const char of 'NETSCAPE2.0') sink.push(char.charCodeAt(0));
    sink.push(3);
    sink.push(1);
    sink.pushU16(loop);
    sink.push(0);
  }

  const usesTransparency = renderFrames.some((frame) => frame.transparent);
  for (const frame of renderFrames) {
    sink.push(0x21);
    sink.push(0xf9);
    sink.push(4);
    const disposal = 1;
    sink.push((disposal << 2) | (frame.transparent ? 1 : 0));
    sink.pushU16(Math.max(1, Math.min(65535, Math.round(frame.delay))));
    sink.push(frame.transparent && usesTransparency ? transparentIndex : 0);
    sink.push(0);

    sink.push(0x2c);
    sink.pushU16(frame.x);
    sink.pushU16(frame.y);
    sink.pushU16(frame.width);
    sink.pushU16(frame.height);
    sink.push(0);
    sink.pushBytes(lzwEncode(minCodeSize, frame.indices));
  }

  sink.push(0x3b);
  return sink.toUint8Array();
}

/**
 * RGBA フレーム列をアニメーション GIF にする。
 *
 * frames: Uint8ClampedArray[] (各 width*height*4 バイト)
 * 戻り値: { bytes, width, height, frameCount, sourceFrameCount, colorCount, palette }
 */
export function encodeGif({
  width,
  height,
  frames,
  fps = 12,
  colors = 256,
  dither = false,
  diff = true,
  loop = 0,
  onProgress = null,
} = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('encodeGif: width / height が不正です');
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('encodeGif: frames が空です');
  }
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  const maxColors = Math.max(2, Math.min(255, Math.floor(colors)));
  report(0.05, 'パレットを作成中');
  const { palette, colorCount } = buildPalette(frames, maxColors);
  const transparentIndex = colorCount;
  const lut = buildPaletteLut(palette, colorCount);

  const mapped = new Array(frames.length);
  for (let i = 0; i < frames.length; i += 1) {
    mapped[i] = mapFrameToIndices(frames[i], width, height, palette, colorCount, lut, dither);
    report(0.05 + 0.5 * ((i + 1) / frames.length), '色を割り当て中');
  }

  const delays = computeDelays(fps, frames.length);
  const renderFrames = [];
  let pendingDelay = 0;
  for (let i = 0; i < mapped.length; i += 1) {
    const delay = delays[i] + pendingDelay;
    pendingDelay = 0;
    if (i === 0 || !diff) {
      renderFrames.push({ x: 0, y: 0, width, height, indices: mapped[i], delay, transparent: false });
    } else {
      const changed = diffFrames(mapped[i - 1], mapped[i], width, height, transparentIndex);
      if (!changed) {
        pendingDelay = delay;
        continue;
      }
      renderFrames.push({ ...changed, delay, transparent: true });
    }
    report(0.55 + 0.28 * ((i + 1) / mapped.length), '差分を計算中');
  }
  if (pendingDelay && renderFrames.length) {
    renderFrames[renderFrames.length - 1].delay += pendingDelay;
  }

  report(0.86, 'GIF を書き出し中');
  const bytes = serializeGif({ width, height, palette, colorCount, transparentIndex, renderFrames, loop });
  report(1, '完了');

  return {
    bytes,
    width,
    height,
    frameCount: renderFrames.length,
    sourceFrameCount: frames.length,
    colorCount,
    palette,
  };
}
