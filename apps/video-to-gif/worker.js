/**
 * worker.js — GIF エンコードワーカー
 *
 * メインスレッドを止めないよう、量子化・差分計算・LZW 圧縮を
 * この Web Worker 内で実行する。フレーム (RGBA) は ArrayBuffer で
 * 受け取り、生成した GIF も ArrayBuffer で返す。
 */

import { encodeGif } from './pipeline.mjs';

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'encode') return;
  try {
    const frames = message.buffers.map((buffer) => new Uint8ClampedArray(buffer));
    const result = encodeGif({
      width: message.width,
      height: message.height,
      frames,
      fps: message.fps,
      colors: message.colors,
      dither: message.dither,
      diff: message.diff,
      onProgress: (progress, label) => post('progress', { progress, label }),
    });
    post(
      'done',
      {
        bytes: result.bytes.buffer,
        byteLength: result.bytes.length,
        width: result.width,
        height: result.height,
        frameCount: result.frameCount,
        sourceFrameCount: result.sourceFrameCount,
        colorCount: result.colorCount,
      },
      [result.bytes.buffer],
    );
  } catch (error) {
    post('error', { message: error && error.message ? error.message : String(error) });
  }
};
