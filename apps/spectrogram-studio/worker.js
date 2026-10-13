/**
 * worker.js — STFT ワーカー
 *
 * 長い音源の短時間フーリエ変換は計算量があるため、
 * メインスレッドを止めないようここで実行する。
 * モノラルの Float32Array を transferable で受け取り、
 * dB 行列 (Float32Array) を transferable で返す。
 */

import { computeStft } from './pipeline.mjs';

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'analyze') return;
  try {
    const result = computeStft({
      samples: new Float32Array(message.samples),
      sampleRate: message.sampleRate,
      fftSize: message.fftSize,
      hopSize: message.hopSize,
      windowType: message.windowType,
      minDb: message.minDb,
      onProgress: (progress, frame, frameCount) => {
        post('progress', {
          progress,
          frame,
          frameCount,
          label: `フレーム ${frame} / ${frameCount} を解析中`,
        });
      },
    });
    post(
      'done',
      {
        db: result.db.buffer,
        frameCount: result.frameCount,
        binCount: result.binCount,
        fftSize: result.fftSize,
        hopSize: result.hopSize,
        sampleRate: result.sampleRate,
        duration: result.duration,
      },
      [result.db.buffer],
    );
  } catch (error) {
    post('error', { message: error && error.message ? error.message : String(error) });
  }
};
