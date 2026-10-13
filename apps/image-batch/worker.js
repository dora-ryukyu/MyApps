/**
 * worker.js — 画像一括処理ワーカー
 *
 * メインスレッドを止めないよう、デコード・リサイズ・透かし・エンコードを
 * この Web Worker 内 (OffscreenCanvas) で実行する。
 *
 * 入力: { type: 'job', id, buffer, sourceMime, sourceName, targetFormat,
 *         width, height, quality, passthrough, stripMetadata, watermark }
 * 出力: { type: 'done', id, buffer, mime, format, width, height }
 *       { type: 'error', id, message }
 *
 * 透かし画像は事前に { type: 'watermark', buffer, mime } で送り、
 * createImageBitmap で一度だけデコードして使い回す。
 */

import {
  FORMAT_INFO,
  stripJpegMetadata,
  isJpeg,
  computeWatermarkLayout,
  rotationRadians,
  formatFromName,
} from './pipeline.mjs';

const MIME_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/png': 'png',
};

let watermarkBitmap = null;

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'watermark') {
    try {
      watermarkBitmap = await createImageBitmap(
        new Blob([message.buffer], { type: message.mime || 'image/png' }),
      );
      post('watermark-ready');
    } catch (error) {
      watermarkBitmap = null;
      post('watermark-error', { message: errorMessage(error) });
    }
    return;
  }

  if (message.type !== 'job') return;

  try {
    const result = message.passthrough ? copyJob(message) : await transcodeJob(message);
    post('done', { id: message.id, ...result }, [result.buffer]);
  } catch (error) {
    post('error', { id: message.id, message: errorMessage(error) });
  }
};

/* ==========================================================
   メタデータだけ落としてコピー
   ========================================================== */

function copyJob(message) {
  const input = new Uint8Array(message.buffer);
  const bytes = message.stripMetadata && isJpeg(input)
    ? stripJpegMetadata(input).bytes
    : input;
  const format =
    formatFromName(message.sourceName) ||
    (message.sourceMime ? MIME_FORMAT[message.sourceMime] : null) ||
    'jpeg';
  return {
    buffer: bytes.buffer,
    mime: message.sourceMime || FORMAT_INFO[format].mime,
    format,
    width: message.width,
    height: message.height,
    passthrough: true,
  };
}

/* ==========================================================
   デコード → リサイズ → 透かし → エンコード
   ========================================================== */

async function transcodeJob(message) {
  const source = new Blob([message.buffer], {
    type: message.sourceMime || 'application/octet-stream',
  });

  let bitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(source);
  }

  const width = Math.max(1, Math.round(message.width || bitmap.width));
  const height = Math.max(1, Math.round(message.height || bitmap.height));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas の 2D コンテキストを取得できませんでした');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  if (message.watermark && message.watermark.enabled) {
    drawWatermark(ctx, width, height, message.watermark);
  }

  const encoded = await encodeCanvas(canvas, message.targetFormat, message.quality);
  const buffer = await encoded.blob.arrayBuffer();

  return {
    buffer,
    mime: encoded.mime,
    format: encoded.format,
    width,
    height,
    passthrough: false,
  };
}

/* ==========================================================
   透かし
   ========================================================== */

function drawWatermark(ctx, canvasWidth, canvasHeight, watermark) {
  const shortEdge = Math.min(canvasWidth, canvasHeight);
  const margin = Math.round(shortEdge * 0.03);
  const scalePercent = Math.max(1, Number(watermark.scalePercent) || 8);
  const baseHeight = Math.max(12, Math.round(canvasHeight * (scalePercent / 100)));
  const opacity = Math.min(1, Math.max(0, (Number(watermark.opacity) || 60) / 100));

  ctx.save();
  ctx.globalAlpha = opacity;

  if (watermark.mode === 'image' && watermarkBitmap) {
    const scale = baseHeight / watermarkBitmap.height;
    const width = Math.max(1, Math.round(watermarkBitmap.width * scale));
    const height = baseHeight;
    const layout = computeWatermarkLayout({
      canvasWidth,
      canvasHeight,
      watermarkWidth: width,
      watermarkHeight: height,
      position: watermark.position,
      margin,
    });
    drawRotated(ctx, layout, watermark.rotation, () => {
      ctx.drawImage(watermarkBitmap, layout.x, layout.y, layout.width, layout.height);
    });
  } else {
    const text = String(watermark.text || '').trim() || '© MyApps';
    const fontPx = baseHeight;
    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const metrics = ctx.measureText(text);
    const width = Math.max(1, Math.ceil(metrics.width));
    const height = Math.ceil(fontPx * 1.25);
    const layout = computeWatermarkLayout({
      canvasWidth,
      canvasHeight,
      watermarkWidth: width,
      watermarkHeight: height,
      position: watermark.position,
      margin,
    });
    drawRotated(ctx, layout, watermark.rotation, () => {
      ctx.lineWidth = Math.max(1, Math.round(fontPx * 0.08));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.strokeText(text, layout.x, layout.y);
      ctx.fillStyle = watermark.color || '#ffffff';
      ctx.fillText(text, layout.x, layout.y);
    });
  }

  ctx.restore();
}

function drawRotated(ctx, layout, degrees, drawFn) {
  const angle = rotationRadians(degrees || 0);
  if (!angle) {
    drawFn();
    return;
  }
  const cx = layout.x + layout.width / 2;
  const cy = layout.y + layout.height / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.translate(-cx, -cy);
  drawFn();
  ctx.restore();
}

/* ==========================================================
   エンコード
   ========================================================== */

async function encodeCanvas(canvas, targetFormat, quality) {
  const info = FORMAT_INFO[targetFormat] || FORMAT_INFO.png;
  const q = Number(quality);
  const qualityValue = Number.isFinite(q) ? Math.min(1, Math.max(0.1, q)) : 0.9;

  const types = [info.mime];
  if (info.mime !== 'image/webp') types.push('image/webp');
  if (info.mime !== 'image/jpeg') types.push('image/jpeg');

  const seen = new Set();
  for (const type of types) {
    if (seen.has(type)) continue;
    seen.add(type);
    try {
      const blob = await canvas.convertToBlob(
        info.quality ? { type, quality: qualityValue } : { type },
      );
      if (blob && blob.size > 0) {
        const actual = blob.type || type;
        return { blob, mime: actual, format: MIME_FORMAT[actual] || targetFormat };
      }
    } catch {
      // 非対応の形式は次の候補へフォールバック
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, mime: 'image/png', format: 'png' };
}
