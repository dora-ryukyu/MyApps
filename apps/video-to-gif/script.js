/**
 * script.js — 動画 → GIF の UI
 *
 * 動画のデコード (HTMLVideoElement + Canvas) はメインスレッド、
 * GIF の量子化・圧縮は worker.js に任せる。
 */

import {
  GIF_MIME,
  DISCORD_HINT_BYTES,
  MAX_OUTPUT_FRAMES,
  MAX_SELECTION_SECONDS,
  MIN_SELECTION_SECONDS,
  FPS_MIN,
  FPS_MAX,
  clampTime,
  normalizeTrim,
  formatTimecode,
  estimateFrameCount,
  sampleFrameTimes,
  maxFramesForMemory,
  computeOutputSize,
  formatBytes,
  buildGifFileName,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  videoName: $('video-name'),
  videoMeta: $('video-meta'),
  editor: $('editor-section'),
  clearFileBtn: $('clear-file-btn'),
  video: $('video'),
  playBtn: $('play-btn'),
  timeLabel: $('time-label'),
  setInBtn: $('set-in-btn'),
  setOutBtn: $('set-out-btn'),
  loopBtn: $('loop-btn'),
  timelineWrap: $('timeline-wrap'),
  timeline: $('timeline-canvas'),
  inInput: $('in-input'),
  outInput: $('out-input'),
  clipInfo: $('clip-info'),
  presetSelect: $('preset-select'),
  fpsRange: $('fps-range'),
  fpsValue: $('fps-value'),
  sizeSelect: $('size-select'),
  colorsSelect: $('colors-select'),
  diffCheck: $('diff-check'),
  ditherCheck: $('dither-check'),
  estimateInfo: $('estimate-info'),
  generateBtn: $('generate-btn'),
  cancelBtn: $('cancel-btn'),
  progressWrap: $('progress-wrap'),
  progressBar: $('progress-bar'),
  progressLabel: $('progress-label'),
  resultSection: $('result-section'),
  resultImg: $('result-img'),
  resultMeta: $('result-meta'),
  resultWarning: $('result-warning'),
  downloadBtn: $('download-btn'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
};

const PRESETS = {
  discord: { fps: 12, size: 480, colors: 256, diff: true, dither: false },
  light: { fps: 10, size: 320, colors: 128, diff: true, dither: false },
  quality: { fps: 15, size: 640, colors: 256, diff: true, dither: false },
};

const state = {
  url: '',
  fileName: '',
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,
  inTime: 0,
  outTime: 0,
  loop: true,
  generating: false,
  cancelled: false,
  filmstrip: null,
  filmstripToken: 0,
  dragging: null,
  worker: null,
  pendingEncode: null,
  gif: null,
};

/* ==========================================================
   共通ヘルパー
   ========================================================== */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function hideError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function waitForEvent(target, name) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('動画を読み込めませんでした'));
    };
    function cleanup() {
      target.removeEventListener(name, onEvent);
      target.removeEventListener('error', onError);
    }
    target.addEventListener(name, onEvent);
    target.addEventListener('error', onError);
  });
}

function waitForFrame(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    video.requestVideoFrameCallback(done);
    setTimeout(done, 500);
  });
}

/** 指定時刻へシークし、そのフレームが描画可能になるまで待つ */
function seekTo(time, targetVideo = els.video) {
  const video = targetVideo;
  const target = clampTime(time, state.duration);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
      callback(value);
    };
    const onSeeked = () => finish(async () => {
      await waitForFrame(video);
      resolve();
    });
    const onError = () => finish(reject, new Error('動画のデコードに失敗しました'));
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    const timer = setTimeout(() => finish(resolve), 2500);
    try {
      video.currentTime = target;
    } catch (error) {
      finish(reject, error);
    }
  });
}

/* ==========================================================
   設定
   ========================================================== */

function readSettings() {
  return {
    fps: Number(els.fpsRange.value) || 12,
    maxLongEdge: Number(els.sizeSelect.value) || 0,
    colors: Number(els.colorsSelect.value) || 256,
    diff: els.diffCheck.checked,
    dither: els.ditherCheck.checked,
  };
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  els.fpsRange.value = preset.fps;
  els.sizeSelect.value = String(preset.size);
  els.colorsSelect.value = String(preset.colors);
  els.diffCheck.checked = preset.diff;
  els.ditherCheck.checked = preset.dither;
  syncFpsLabel();
  updateEstimate();
}

function syncFpsLabel() {
  els.fpsValue.textContent = `${els.fpsRange.value} fps`;
}

function currentClip() {
  return normalizeTrim(state.inTime, state.outTime, state.duration);
}

function maxFramesFor(width, height) {
  return Math.min(MAX_OUTPUT_FRAMES, maxFramesForMemory(width, height));
}

function updateEstimate() {
  if (!state.duration) {
    els.clipInfo.textContent = '';
    els.estimateInfo.textContent = '';
    els.generateBtn.disabled = true;
    return;
  }
  const settings = readSettings();
  const { start, end } = currentClip();
  const count = estimateFrameCount(start, end, settings.fps);
  const size = computeOutputSize(state.videoWidth, state.videoHeight, settings.maxLongEdge);
  const span = end - start;
  const maxFrames = maxFramesFor(size.width, size.height);

  els.clipInfo.textContent =
    `選択範囲: ${span.toFixed(2)} 秒（${formatTimecode(start)} – ${formatTimecode(end)}）`;

  let info = `${count} フレーム / 出力 ${size.width}×${size.height} px / 同設定の上限 ${maxFrames} フレーム`;
  if (count > maxFrames) {
    info += ` — 長すぎます。fps を下げるか範囲を短くしてください（最大 約${(maxFrames / settings.fps).toFixed(1)} 秒）`;
  }
  if (span > MAX_SELECTION_SECONDS) {
    info += ` — 選択範囲は最大 ${MAX_SELECTION_SECONDS} 秒までです`;
  }
  els.estimateInfo.textContent = info;
  els.generateBtn.disabled = state.generating || count > maxFrames || span > MAX_SELECTION_SECONDS;
}

/* ==========================================================
   動画の読み込み
   ========================================================== */

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)) {
    showError('動画ファイルを選んでください。');
    return;
  }
  hideError();
  resetResult();
  state.cancelled = false;
  state.fileName = file.name;
  els.videoName.textContent = file.name;
  els.videoMeta.textContent = `${formatBytes(file.size)} / 読み込み中…`;

  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  const video = els.video;
  video.src = state.url;
  try {
    await waitForEvent(video, 'loadedmetadata');
  } catch (error) {
    showError('この動画はブラウザで読み込めませんでした。対応形式か確認してください。');
    return;
  }
  if (!Number.isFinite(video.duration)) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener('durationchange', finish);
        resolve();
      };
      video.addEventListener('durationchange', finish);
      try {
        video.currentTime = 1e7;
      } catch {
        finish();
      }
      setTimeout(finish, 1500);
    });
    try {
      video.currentTime = 0;
    } catch {
      /* noop */
    }
  }
  state.duration = Number.isFinite(video.duration) ? video.duration : 0;
  state.videoWidth = video.videoWidth;
  state.videoHeight = video.videoHeight;
  if (!state.duration || !state.videoWidth || !state.videoHeight) {
    showError('この動画の長さ・解像度を取得できませんでした。');
    return;
  }

  state.inTime = 0;
  state.outTime = state.duration;
  els.videoMeta.textContent =
    `${formatBytes(file.size)} / ${state.videoWidth}×${state.videoHeight} / ${formatTimecode(state.duration)}`;
  els.editor.hidden = false;
  syncTrimInputs();
  updateEstimate();
  resizeTimeline();
  try {
    await seekTo(0);
  } catch {
    /* プレビューの失敗は無視 */
  }
  updateTimeLabel();
  buildFilmstrip();
}

function clearFile() {
  cancelGeneration();
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = '';
  state.fileName = '';
  state.duration = 0;
  state.videoWidth = 0;
  state.videoHeight = 0;
  state.inTime = 0;
  state.outTime = 0;
  state.filmstrip = null;
  state.filmstripToken += 1;
  els.video.removeAttribute('src');
  try {
    els.video.load();
  } catch {
    /* noop */
  }
  els.editor.hidden = true;
  els.videoName.textContent = '';
  els.videoMeta.textContent = '';
  els.fileInput.value = '';
  resetResult();
  hideError();
  updateEstimate();
}

/* ==========================================================
   カット範囲
   ========================================================== */

function syncTrimInputs() {
  els.inInput.value = state.inTime.toFixed(2);
  els.outInput.value = state.outTime.toFixed(2);
  els.inInput.max = state.duration.toFixed(2);
  els.outInput.max = state.duration.toFixed(2);
}

function setIn(time) {
  const maxIn = Math.max(0, state.outTime - MIN_SELECTION_SECONDS);
  state.inTime = clampTime(Math.min(time, maxIn), state.duration);
  syncTrimInputs();
  updateEstimate();
  drawTimeline();
}

function setOut(time) {
  const minOut = Math.min(state.duration, state.inTime + MIN_SELECTION_SECONDS);
  state.outTime = clampTime(Math.max(time, minOut), state.duration);
  syncTrimInputs();
  updateEstimate();
  drawTimeline();
}

/* ==========================================================
   再生
   ========================================================== */

function updatePlayIcon() {
  const playing = !els.video.paused;
  els.playBtn.querySelector('[data-play-icon]').hidden = playing;
  els.playBtn.querySelector('[data-pause-icon]').hidden = !playing;
}

function updateTimeLabel() {
  els.timeLabel.textContent =
    `${formatTimecode(els.video.currentTime)} / ${formatTimecode(state.duration)}`;
}

function togglePlay() {
  if (!state.duration || state.generating) return;
  const video = els.video;
  if (video.paused) {
    if (video.currentTime < state.inTime - 0.01 || video.currentTime >= state.outTime - 0.01) {
      video.currentTime = state.inTime;
    }
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function playbackTick() {
  const video = els.video;
  if (video.paused) return;
  if (state.loop && video.currentTime >= state.outTime - 0.03) {
    video.currentTime = state.inTime;
  }
  updateTimeLabel();
  drawTimeline();
  requestAnimationFrame(playbackTick);
}

function pauseAndSeek(time) {
  els.video.pause();
  seekTo(time).then(() => {
    updateTimeLabel();
    drawTimeline();
  }).catch(() => {});
}

/* ==========================================================
   タイムライン
   ========================================================== */

function timeToX(time) {
  if (!state.duration) return 0;
  return (clampTime(time, state.duration) / state.duration) * els.timeline.width;
}

function xToTime(x) {
  if (!els.timeline.width) return 0;
  return (x / els.timeline.width) * state.duration;
}

function canvasPoint(event) {
  const rect = els.timeline.getBoundingClientRect();
  const scale = els.timeline.width / Math.max(1, rect.width);
  return {
    x: (event.clientX - rect.left) * scale,
    time: xToTime((event.clientX - rect.left) * scale),
    hitWidth: 14 * scale,
  };
}

function resizeTimeline() {
  if (els.editor.hidden) return;
  const width = els.timelineWrap.clientWidth || 600;
  const height = 64;
  const dpr = window.devicePixelRatio || 1;
  els.timeline.width = Math.max(320, Math.round(width * dpr));
  els.timeline.height = Math.round(height * dpr);
  drawTimeline();
}

function drawTimeline() {
  const canvas = els.timeline;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!state.duration) return;

  if (state.filmstrip) {
    ctx.drawImage(state.filmstrip, 0, 0, state.filmstrip.width, state.filmstrip.height, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#222228';
    ctx.fillRect(0, 0, w, h);
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--app-color').trim() || '#d946ef';
  const inX = timeToX(state.inTime);
  const outX = timeToX(state.outTime);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, Math.max(0, inX), h);
  ctx.fillRect(Math.min(w, outX), 0, Math.max(0, w - outX), h);

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(inX + 1, 1, Math.max(0, outX - inX - 2), h - 2);

  ctx.fillStyle = accent;
  ctx.fillRect(inX - 2, 0, 5, h);
  ctx.fillRect(outX - 3, 0, 5, h);

  const playX = timeToX(els.video.currentTime);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(playX - 1, 0, 2, h);
}

function bindTimeline() {
  const canvas = els.timeline;

  canvas.addEventListener('pointerdown', (event) => {
    if (!state.duration || state.generating) return;
    const point = canvasPoint(event);
    const inX = timeToX(state.inTime);
    const outX = timeToX(state.outTime);
    if (Math.abs(point.x - inX) <= point.hitWidth) {
      state.dragging = 'in';
    } else if (Math.abs(point.x - outX) <= point.hitWidth) {
      state.dragging = 'out';
    } else {
      state.dragging = 'playhead';
      pauseAndSeek(point.time);
    }
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!state.duration) return;
    const point = canvasPoint(event);
    if (state.dragging === 'in') {
      setIn(point.time);
    } else if (state.dragging === 'out') {
      setOut(point.time);
    } else if (state.dragging === 'playhead') {
      pauseAndSeek(point.time);
    } else {
      const inX = timeToX(state.inTime);
      const outX = timeToX(state.outTime);
      canvas.style.cursor =
        Math.abs(point.x - inX) <= point.hitWidth || Math.abs(point.x - outX) <= point.hitWidth
          ? 'ew-resize'
          : 'pointer';
    }
  });

  const endDrag = () => {
    state.dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

/* ==========================================================
   フィルムストリップ
   ========================================================== */

async function buildFilmstrip() {
  const token = ++state.filmstripToken;
  if (!state.url) return;
  const count = 12;
  const thumbHeight = 54;
  const aspect = state.videoWidth / Math.max(1, state.videoHeight);
  const thumbWidth = Math.max(24, Math.round(thumbHeight * aspect));
  const strip = document.createElement('canvas');
  strip.width = thumbWidth * count;
  strip.height = thumbHeight;
  const ctx = strip.getContext('2d');

  // プレビューのシークと競合しないよう、専用の video 要素で生成する
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = state.url;
  const release = () => {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      /* noop */
    }
  };
  try {
    await waitForEvent(video, 'loadedmetadata');
    for (let i = 0; i < count; i += 1) {
      if (token !== state.filmstripToken) {
        release();
        return;
      }
      const time = ((i + 0.5) / count) * state.duration;
      try {
        await seekTo(time, video);
      } catch {
        release();
        return;
      }
      if (token !== state.filmstripToken) {
        release();
        return;
      }
      ctx.drawImage(video, i * thumbWidth, 0, thumbWidth, thumbHeight);
    }
  } catch {
    release();
    return;
  }
  release();
  state.filmstrip = strip;
  drawTimeline();
}

/* ==========================================================
   進捗・結果
   ========================================================== */

function setProgress(ratio, label) {
  const percent = Math.max(0, Math.min(100, ratio * 100));
  els.progressBar.style.width = `${percent.toFixed(1)}%`;
  if (label) els.progressLabel.textContent = label;
}

function setBusy(busy) {
  els.cancelBtn.hidden = !busy;
  els.progressWrap.hidden = !busy;
  const controls = [
    els.fileInput,
    els.fpsRange,
    els.sizeSelect,
    els.colorsSelect,
    els.diffCheck,
    els.ditherCheck,
    els.presetSelect,
    els.inInput,
    els.outInput,
    els.playBtn,
    els.setInBtn,
    els.setOutBtn,
    els.loopBtn,
    els.clearFileBtn,
  ];
  for (const el of controls) el.disabled = busy;
  if (busy) {
    els.generateBtn.disabled = true;
    els.progressBar.style.width = '0%';
  } else {
    updateEstimate();
  }
}

function resetResult() {
  if (state.gif && state.gif.url) URL.revokeObjectURL(state.gif.url);
  state.gif = null;
  els.resultSection.hidden = true;
  els.resultWarning.hidden = true;
  els.resultMeta.textContent = '';
  els.resultImg.removeAttribute('src');
  els.downloadBtn.disabled = true;
  setProgress(0, '');
}

function showResult(blob, result) {
  const url = URL.createObjectURL(blob);
  state.gif = {
    url,
    blob,
    width: result.width,
    height: result.height,
    frameCount: result.frameCount,
  };
  els.resultImg.src = url;
  els.resultMeta.textContent =
    `${formatBytes(blob.size)} / ${result.width}×${result.height} px / ` +
    `${result.frameCount} フレーム（元 ${result.sourceFrameCount}） / ${result.colorCount} 色`;
  const overLimit = blob.size > DISCORD_HINT_BYTES;
  els.resultWarning.hidden = !overLimit;
  if (overLimit) {
    els.resultWarning.textContent =
      `Discord の無料プランの目安（約 ${formatBytes(DISCORD_HINT_BYTES)}）を超えています。` +
      `fps・解像度・色数を下げるか、カット範囲を短くしてください。`;
  }
  els.downloadBtn.disabled = false;
  els.resultSection.hidden = false;
}

/* ==========================================================
   GIF 生成
   ========================================================== */

function terminateWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function encodeInWorker({ buffers, width, height, fps, colors, dither, diff }) {
  return new Promise((resolve, reject) => {
    terminateWorker();
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    state.pendingEncode = { reject };

    worker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'progress') {
        setProgress(0.72 + (message.progress || 0) * 0.28, message.label || 'エンコード中…');
      } else if (message.type === 'done') {
        state.pendingEncode = null;
        terminateWorker();
        resolve(message);
      } else if (message.type === 'error') {
        state.pendingEncode = null;
        terminateWorker();
        reject(new Error(message.message || 'GIF の生成に失敗しました'));
      }
    });
    worker.addEventListener('error', (event) => {
      state.pendingEncode = null;
      terminateWorker();
      reject(new Error(event.message || 'GIF の生成に失敗しました'));
    });
    worker.postMessage(
      { type: 'encode', buffers, width, height, fps, colors, dither, diff },
      buffers,
    );
  });
}

function cancelGeneration() {
  state.cancelled = true;
  if (state.pendingEncode) {
    const { reject } = state.pendingEncode;
    state.pendingEncode = null;
    reject(new DOMException('cancelled', 'AbortError'));
  }
  terminateWorker();
  state.generating = false;
  setBusy(false);
  setProgress(0, 'キャンセルしました');
}

async function generate() {
  if (state.generating || !state.duration) return;
  hideError();
  const settings = readSettings();
  const { start, end } = currentClip();
  const count = estimateFrameCount(start, end, settings.fps);
  const size = computeOutputSize(state.videoWidth, state.videoHeight, settings.maxLongEdge);
  const maxFrames = maxFramesFor(size.width, size.height);
  if (count > maxFrames || end - start > MAX_SELECTION_SECONDS) {
    updateEstimate();
    return;
  }

  state.generating = true;
  state.cancelled = false;
  resetResult();
  setBusy(true);
  els.video.pause();

  try {
    const times = sampleFrameTimes(start, end, settings.fps);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const buffers = [];

    for (let i = 0; i < times.length; i += 1) {
      if (state.cancelled) throw new DOMException('cancelled', 'AbortError');
      await seekTo(times[i]);
      ctx.drawImage(els.video, 0, 0, size.width, size.height);
      buffers.push(ctx.getImageData(0, 0, size.width, size.height).data.buffer);
      setProgress(((i + 1) / times.length) * 0.72, `フレームを抽出中 ${i + 1} / ${times.length}`);
      if ((i & 3) === 0) await nextPaint();
    }

    setProgress(0.72, 'GIF をエンコード中…');
    const result = await encodeInWorker({
      buffers,
      width: size.width,
      height: size.height,
      fps: settings.fps,
      colors: settings.colors,
      dither: settings.dither,
      diff: settings.diff,
    });
    if (state.cancelled) throw new DOMException('cancelled', 'AbortError');
    showResult(new Blob([result.bytes], { type: GIF_MIME }), result);
    setProgress(1, '完了しました');
  } catch (error) {
    if (!state.cancelled && error && error.name !== 'AbortError') {
      showError(error.message || 'GIF の生成に失敗しました。');
    }
  } finally {
    state.generating = false;
    setBusy(false);
  }
}

/* ==========================================================
   イベント登録
   ========================================================== */

function bindFileInput() {
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) loadFile(file);
  });

  els.dropZone.addEventListener('click', (event) => {
    if (event.target.closest('label')) return;
    els.fileInput.click();
  });
  els.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  for (const name of ['dragenter', 'dragover']) {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.add('is-dragover');
    });
  }
  for (const name of ['dragleave', 'drop']) {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove('is-dragover');
    });
  }
  els.dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());
}

function bindControls() {
  els.playBtn.addEventListener('click', togglePlay);
  els.video.addEventListener('play', () => {
    updatePlayIcon();
    requestAnimationFrame(playbackTick);
  });
  els.video.addEventListener('pause', () => {
    updatePlayIcon();
    updateTimeLabel();
    drawTimeline();
  });
  els.video.addEventListener('loadeddata', () => {
    updateTimeLabel();
    drawTimeline();
  });

  els.setInBtn.addEventListener('click', () => setIn(els.video.currentTime));
  els.setOutBtn.addEventListener('click', () => setOut(els.video.currentTime));
  els.loopBtn.addEventListener('click', () => {
    state.loop = !state.loop;
    els.loopBtn.classList.toggle('is-active', state.loop);
    els.loopBtn.setAttribute('aria-pressed', String(state.loop));
  });

  els.inInput.addEventListener('change', () => setIn(Number(els.inInput.value)));
  els.outInput.addEventListener('change', () => setOut(Number(els.outInput.value)));

  els.presetSelect.addEventListener('change', () => applyPreset(els.presetSelect.value));
  els.fpsRange.addEventListener('input', () => {
    syncFpsLabel();
    els.presetSelect.value = 'custom';
    updateEstimate();
  });
  for (const el of [els.sizeSelect, els.colorsSelect, els.diffCheck, els.ditherCheck]) {
    el.addEventListener('change', () => {
      els.presetSelect.value = 'custom';
      updateEstimate();
    });
  }

  els.generateBtn.addEventListener('click', generate);
  els.cancelBtn.addEventListener('click', cancelGeneration);
  els.clearFileBtn.addEventListener('click', clearFile);

  els.downloadBtn.addEventListener('click', () => {
    if (!state.gif) return;
    const anchor = document.createElement('a');
    anchor.href = state.gif.url;
    anchor.download = buildGifFileName(state.fileName);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
}

function bindInfoModal() {
  const open = () => {
    els.infoModal.style.display = 'flex';
  };
  const close = () => {
    els.infoModal.style.display = 'none';
  };
  els.infoBtn.addEventListener('click', open);
  els.closeInfoBtn.addEventListener('click', close);
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.infoModal.style.display === 'flex') close();
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (els.editor.hidden || state.generating) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const fps = Number(els.fpsRange.value) || 12;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'i' || event.key === 'I') {
      setIn(els.video.currentTime);
    } else if (event.key === 'o' || event.key === 'O') {
      setOut(els.video.currentTime);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      pauseAndSeek(els.video.currentTime - (event.shiftKey ? 1 : 1 / fps));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      pauseAndSeek(els.video.currentTime + (event.shiftKey ? 1 : 1 / fps));
    }
  });
}

function init() {
  bindFileInput();
  bindControls();
  bindTimeline();
  bindInfoModal();
  bindKeyboard();
  window.addEventListener('resize', debounce(resizeTimeline, 120));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(resizeTimeline).catch(() => {});
  }
  updateEstimate();
}

init();
