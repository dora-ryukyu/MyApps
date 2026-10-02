import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIF_MIME,
  DISCORD_HINT_BYTES,
  clampTime,
  normalizeTrim,
  formatTimecode,
  estimateFrameCount,
  sampleFrameTimes,
  computeDelays,
  maxFramesForMemory,
  computeOutputSize,
  formatBytes,
  buildGifFileName,
  buildPalette,
  buildPaletteLut,
  mapFrameToIndices,
  diffFrames,
  lzwEncode,
  lzwDecode,
  encodeGif,
} from '../pipeline.mjs';

/* ==========================================================
   テスト用ヘルパー
   ========================================================== */

function solidFrame(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

function fillRect(frame, width, x0, y0, rectWidth, rectHeight, [r, g, b, a = 255]) {
  for (let y = y0; y < y0 + rectHeight; y += 1) {
    for (let x = x0; x < x0 + rectWidth; x += 1) {
      const p = (y * width + x) * 4;
      frame[p] = r;
      frame[p + 1] = g;
      frame[p + 2] = b;
      frame[p + 3] = a;
    }
  }
  return frame;
}

function concatChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u16(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

/** テスト用の最小 GIF パーサー */
function parseGif(bytes) {
  let p = 0;
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  p = 6;
  const width = u16(bytes, p);
  p += 2;
  const height = u16(bytes, p);
  p += 2;
  const packed = bytes[p];
  p += 1;
  const hasGct = Boolean(packed & 0x80);
  const gctSize = 1 << ((packed & 7) + 1);
  p += 2;
  let gct = null;
  if (hasGct) {
    gct = bytes.subarray(p, p + gctSize * 3);
    p += gctSize * 3;
  }

  let loop = null;
  const frames = [];
  let delay = 0;
  let disposal = 0;
  let transparent = false;
  let transparentIndex = 0;

  while (p < bytes.length) {
    const marker = bytes[p];
    p += 1;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[p];
      p += 1;
      if (label === 0xf9) {
        const blockSize = bytes[p];
        assert.equal(blockSize, 4);
        p += 1;
        const flags = bytes[p];
        p += 1;
        delay = u16(bytes, p);
        p += 2;
        transparentIndex = bytes[p];
        p += 1;
        p += 1;
        disposal = (flags >> 2) & 7;
        transparent = Boolean(flags & 1);
      } else {
        const blockSize = bytes[p];
        const app = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + blockSize));
        p += 1 + blockSize;
        if (app === 'NETSCAPE2.0') {
          assert.equal(bytes[p], 3);
          p += 1;
          assert.equal(bytes[p], 1);
          loop = u16(bytes, p + 1);
          p += 3;
        }
        while (bytes[p] !== 0) {
          const size = bytes[p];
          p += 1 + size;
        }
        p += 1;
      }
      continue;
    }
    if (marker === 0x2c) {
      const x = u16(bytes, p);
      p += 2;
      const y = u16(bytes, p);
      p += 2;
      const frameWidth = u16(bytes, p);
      p += 2;
      const frameHeight = u16(bytes, p);
      p += 2;
      const localPacked = bytes[p];
      p += 1;
      assert.equal(localPacked & 0x80, 0, 'ローカルカラーテーブルは使わない');
      const minCodeSize = bytes[p];
      p += 1;
      const chunks = [];
      let total = 0;
      while (bytes[p] !== 0) {
        const size = bytes[p];
        p += 1;
        chunks.push(bytes.subarray(p, p + size));
        total += size;
        p += size;
      }
      p += 1;
      frames.push({
        x,
        y,
        width: frameWidth,
        height: frameHeight,
        minCodeSize,
        data: concatChunks(chunks, total),
        delay,
        disposal,
        transparent,
        transparentIndex,
      });
      continue;
    }
    throw new Error(`unknown marker: 0x${marker.toString(16)}`);
  }
  return { header, width, height, gct, gctSize, loop, frames };
}

/** パース結果を合成してフレームごとのインデックス配列を復元する */
function compositeFrames(parsed) {
  const { width, height } = parsed;
  let canvas = new Uint8Array(width * height);
  const out = [];
  for (const frame of parsed.frames) {
    const indices = lzwDecode(frame.minCodeSize, frame.data);
    assert.equal(indices.length, frame.width * frame.height, 'LZW の展開長が一致しない');
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const value = indices[y * frame.width + x];
        if (frame.transparent && value === frame.transparentIndex) continue;
        canvas[(frame.y + y) * width + (frame.x + x)] = value;
      }
    }
    out.push(canvas.slice());
  }
  return out;
}

/* ==========================================================
   時間・範囲
   ========================================================== */

test('clampTime は 0..duration に収める', () => {
  assert.equal(clampTime(-1, 10), 0);
  assert.equal(clampTime(5, 10), 5);
  assert.equal(clampTime(99, 10), 10);
  assert.equal(clampTime(Number.NaN, 10), 0);
  assert.equal(clampTime(5, Number.NaN), 0);
});

test('normalizeTrim は範囲を正規化し、短すぎる範囲を広げる', () => {
  assert.deepEqual(normalizeTrim(1, 3, 10), { start: 1, end: 3 });
  const atEnd = normalizeTrim(11, 12, 10);
  assert.equal(atEnd.end, 10);
  assert.ok(Math.abs(atEnd.start - 9.9) < 1e-9);
  const widened = normalizeTrim(9.98, 10, 10);
  assert.ok(widened.end - widened.start >= 0.1 - 1e-9);
  assert.equal(widened.end, 10);

  const shortened = normalizeTrim(0, 0.01, 10);
  assert.ok(shortened.end - shortened.start >= 0.1 - 1e-9);
});

test('formatTimecode は M:SS.CC / H:MM:SS.CC を返す', () => {
  assert.equal(formatTimecode(0), '0:00.00');
  assert.equal(formatTimecode(5.5), '0:05.50');
  assert.equal(formatTimecode(65.5), '1:05.50');
  assert.equal(formatTimecode(3661.23), '1:01:01.23');
  assert.equal(formatTimecode(-5), '0:00.00');
});

test('estimateFrameCount / sampleFrameTimes は fps に応じたフレーム時刻を返す', () => {
  assert.equal(estimateFrameCount(0, 1, 12), 12);
  assert.equal(estimateFrameCount(2, 3.5, 10), 15);
  assert.equal(estimateFrameCount(0, 0.001, 10), 1);

  const times = sampleFrameTimes(1, 2, 10);
  assert.equal(times.length, 10);
  assert.equal(times[0], 1);
  assert.ok(times[times.length - 1] < 2);
  assert.ok(Math.abs(times[1] - 1.1) < 1e-9);
});

test('computeDelays は合計が元の長さに一致し、各遅延は 2 以上', () => {
  const delays = computeDelays(12, 100);
  assert.equal(delays.length, 100);
  const total = delays.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 100 * 100 / 12) < 2);
  assert.ok(delays.every((value) => value >= 2));

  const thirty = computeDelays(30, 30);
  assert.equal(thirty.reduce((sum, value) => sum + value, 0), 100);
  assert.ok(thirty.every((value) => value === 3 || value === 4));
});

test('maxFramesForMemory は 1 以上を返す', () => {
  assert.ok(maxFramesForMemory(480, 270) > 100);
  assert.equal(maxFramesForMemory(100000, 100000), 1);
});

test('computeOutputSize は縦横比を保ち、拡大しない', () => {
  assert.deepEqual(computeOutputSize(1920, 1080, 480), { width: 480, height: 270, scale: 0.25 });
  assert.deepEqual(computeOutputSize(1080, 1920, 480), { width: 270, height: 480, scale: 0.25 });
  assert.deepEqual(computeOutputSize(320, 240, 640), { width: 320, height: 240, scale: 1 });
  assert.deepEqual(computeOutputSize(800, 600, 0), { width: 800, height: 600, scale: 1 });
  assert.equal(computeOutputSize(1, 1, 0).width, 1);
});

test('formatBytes と buildGifFileName', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatBytes(DISCORD_HINT_BYTES), '10.00 MB');

  assert.equal(buildGifFileName('clip.mp4'), 'clip.gif');
  assert.equal(buildGifFileName('a.b.webm'), 'a.b.gif');
  assert.equal(buildGifFileName(''), 'movie.gif');
  assert.equal(GIF_MIME, 'image/gif');
});

/* ==========================================================
   量子化
   ========================================================== */

test('buildPalette は指定色数以下のパレットを作る', () => {
  const frame = solidFrame(4, 4, [255, 0, 0]);
  fillRect(frame, 4, 2, 0, 2, 4, [0, 0, 255]);
  const { palette, colorCount } = buildPalette([frame], 2);
  assert.equal(colorCount, 2);
  assert.equal(palette.length, 6);

  const colors = [];
  for (let i = 0; i < colorCount; i += 1) {
    colors.push([palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]]);
  }
  const near = (color, [r, g, b]) =>
    Math.abs(color[0] - r) <= 8 && Math.abs(color[1] - g) <= 8 && Math.abs(color[2] - b) <= 8;
  assert.ok(colors.some((color) => near(color, [255, 0, 0])), '赤が無い');
  assert.ok(colors.some((color) => near(color, [0, 0, 255])), '青が無い');
});

test('buildPalette は色数上限を超えない', () => {
  const frame = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i += 1) {
    frame[i * 4] = (i * 37) & 0xff;
    frame[i * 4 + 1] = (i * 91) & 0xff;
    frame[i * 4 + 2] = (i * 13) & 0xff;
    frame[i * 4 + 3] = 255;
  }
  const { palette, colorCount } = buildPalette([frame], 32);
  assert.ok(colorCount <= 32);
  assert.equal(palette.length, colorCount * 3);
});

test('mapFrameToIndices はパレット色を正しい番号へ割り当てる', () => {
  const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const lut = buildPaletteLut(palette, 3);
  const frame = solidFrame(2, 1, [255, 0, 0]);
  fillRect(frame, 2, 1, 0, 1, 1, [0, 0, 255]);
  const indices = mapFrameToIndices(frame, 2, 1, palette, 3, lut, false);
  assert.deepEqual([...indices], [0, 2]);
});

test('mapFrameToIndices のディザは結果を変えるがサイズは保つ', () => {
  const palette = new Uint8Array(30 * 3);
  for (let i = 0; i < 30; i += 1) {
    palette[i * 3] = i * 8;
    palette[i * 3 + 1] = i * 8;
    palette[i * 3 + 2] = i * 8;
  }
  const lut = buildPaletteLut(palette, 30);
  const frame = solidFrame(8, 8, [128, 128, 128]);
  const plain = mapFrameToIndices(frame, 8, 8, palette, 30, lut, false);
  const dithered = mapFrameToIndices(frame, 8, 8, palette, 30, lut, true);
  assert.equal(plain.length, 64);
  assert.equal(dithered.length, 64);
});

test('diffFrames は変化が無ければ null、変化部分の矩形を返す', () => {
  const width = 6;
  const height = 4;
  const prev = new Uint8Array(width * height).fill(1);
  assert.equal(diffFrames(prev, prev.slice(), width, height, 9), null);

  const curr = prev.slice();
  curr[1 * width + 2] = 5;
  const diff = diffFrames(prev, curr, width, height, 9);
  assert.deepEqual(
    { x: diff.x, y: diff.y, width: diff.width, height: diff.height },
    { x: 2, y: 1, width: 1, height: 1 },
  );
  assert.equal(diff.indices[0], 5);

  const curr2 = prev.slice();
  fillRectIndices(curr2, width, 1, 1, 1, 1, 7);
  fillRectIndices(curr2, width, 3, 1, 1, 1, 7);
  const diff2 = diffFrames(prev, curr2, width, height, 9);
  assert.deepEqual(
    { x: diff2.x, y: diff2.y, width: diff2.width, height: diff2.height },
    { x: 1, y: 1, width: 3, height: 1 },
  );
  assert.equal(diff2.indices[0], 7);
  assert.equal(diff2.indices[1], 9, '変化していない画素は透明色');
  assert.equal(diff2.indices[2], 7);
});

function fillRectIndices(array, width, x0, y0, w, h, value) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) array[y * width + x] = value;
  }
}

/* ==========================================================
   LZW
   ========================================================== */

test('lzwEncode / lzwDecode は往復できる', () => {
  const cases = [
    new Uint8Array([0]),
    new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]),
    Uint8Array.from({ length: 1000 }, (_, i) => i % 8),
    Uint8Array.from({ length: 5000 }, (_, i) => (i * i * 7 + i * 13) % 16),
  ];
  for (const pixels of cases) {
    const minCodeSize = 4;
    const encoded = lzwEncode(minCodeSize, pixels);
    assert.equal(encoded[0], minCodeSize);
    assert.equal(encoded[encoded.length - 1], 0, '終端ブロックが無い');

    const chunks = [];
    let p = 1;
    while (encoded[p] !== 0) {
      const size = encoded[p];
      p += 1;
      chunks.push(encoded.subarray(p, p + size));
      p += size;
    }
    const decoded = lzwDecode(minCodeSize, concatChunks(chunks, chunks.reduce((n, c) => n + c.length, 0)));
    assert.deepEqual([...decoded], [...pixels]);
  }
});

test('lzwEncode は辞書上限でクリアコードを挟む', () => {
  const pixels = Uint8Array.from({ length: 40000 }, (_, i) => (i * 31 + (i >> 3)) & 0xff);
  const encoded = lzwEncode(8, pixels);
  const chunks = [];
  let p = 1;
  while (encoded[p] !== 0) {
    const size = encoded[p];
    p += 1;
    chunks.push(encoded.subarray(p, p + size));
    p += size;
  }
  const decoded = lzwDecode(8, concatChunks(chunks, chunks.reduce((n, c) => n + c.length, 0)));
  assert.equal(decoded.length, pixels.length);
  assert.deepEqual([...decoded], [...pixels]);
});

/* ==========================================================
   GIF 構造
   ========================================================== */

test('encodeGif は GIF89a を生成し、ヘッダ・画面サイズ・ループを含む', () => {
  const frame = solidFrame(8, 4, [10, 20, 30]);
  const result = encodeGif({ width: 8, height: 4, frames: [frame], fps: 10, colors: 16, diff: true });
  const parsed = parseGif(result.bytes);

  assert.equal(parsed.header, 'GIF89a');
  assert.equal(parsed.width, 8);
  assert.equal(parsed.height, 4);
  assert.equal(parsed.loop, 0, '無限ループが無い');
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].delay, 10);
  assert.equal(result.frameCount, 1);
  assert.ok(result.bytes[result.bytes.length - 1] === 0x3b, 'トレーラが無い');
});

test('encodeGif は差分フレームを部分矩形 + 透明で書き出す', () => {
  const width = 24;
  const height = 16;
  const blue = [0, 0, 255];
  const base = [20, 20, 20];

  const frame0 = solidFrame(width, height, base);
  fillRect(frame0, width, 2, 2, 4, 4, blue);

  const frame1 = frame0.slice();
  fillRect(frame1, width, 2, 2, 4, 4, base);
  fillRect(frame1, width, 3, 2, 4, 4, blue);

  const result = encodeGif({
    width,
    height,
    frames: [frame0, frame1],
    fps: 10,
    colors: 16,
    diff: true,
  });
  const parsed = parseGif(result.bytes);

  assert.equal(parsed.frames.length, 2);
  assert.equal(parsed.frames[0].width, width, '1 フレーム目は全体');
  assert.ok(parsed.frames[0].transparent === false);
  assert.equal(parsed.frames[1].x, 2);
  assert.equal(parsed.frames[1].y, 2);
  assert.equal(parsed.frames[1].width, 5);
  assert.equal(parsed.frames[1].height, 4);
  assert.equal(parsed.frames[1].transparent, true);
  assert.equal(parsed.frames[1].delay, 10);

  const lut = buildPaletteLut(result.palette, result.colorCount);
  const mapped = [
    mapFrameToIndices(frame0, width, height, result.palette, result.colorCount, lut, false),
    mapFrameToIndices(frame1, width, height, result.palette, result.colorCount, lut, false),
  ];
  const composed = compositeFrames(parsed);
  assert.equal(composed.length, 2);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual([...composed[i]], [...mapped[i]], `${i} フレーム目が一致しない`);
  }
});

test('encodeGif は変化の無いフレームを遅延へ合算する', () => {
  const frame = solidFrame(8, 8, [200, 10, 10]);
  const result = encodeGif({
    width: 8,
    height: 8,
    frames: [frame, frame.slice(), frame.slice()],
    fps: 10,
    colors: 8,
    diff: true,
  });
  const parsed = parseGif(result.bytes);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].delay, 30);
});

test('encodeGif は diff=false なら全フレームを全体で書く', () => {
  const width = 8;
  const height = 8;
  const a = solidFrame(width, height, [0, 0, 0]);
  const b = solidFrame(width, height, [255, 255, 255]);
  const result = encodeGif({ width, height, frames: [a, b], fps: 5, colors: 8, diff: false });
  const parsed = parseGif(result.bytes);
  assert.equal(parsed.frames.length, 2);
  assert.equal(parsed.frames[0].width, width);
  assert.equal(parsed.frames[1].width, width);
  assert.equal(parsed.frames[1].transparent, false);
});

test('encodeGif は不正な入力で例外を投げる', () => {
  assert.throws(() => encodeGif({ width: 0, height: 0, frames: [] }), /width/);
  assert.throws(() => encodeGif({ width: 8, height: 8, frames: [] }), /frames/);
});
