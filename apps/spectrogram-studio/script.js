/**
 * script.js — スペクトログラムの UI
 *
 * 音声のデコードと描画はメインスレッド、
 * STFT は worker.js に任せて UI を止めない。
 */

import {
  DEFAULT_FFT_SIZE,
  DEFAULT_HOP_SIZE,
  DEFAULT_WINDOW,
  DEFAULT_COLORMAP,
  DEFAULT_MIN_DB,
  DEFAULT_MAX_DB,
  MAX_INPUT_SECONDS,
  DB_FLOOR,
  SPECTROGRAM_MIME,
  clamp,
  clamp01,
  nextPowerOfTwo,
  defaultMinFreq,
  formatHz,
  formatDb,
  formatSeconds,
  formatBytes,
  mixToMono,
  trimToSeconds,
  binToHz,
  freqToNormalized,
  normalizedToFreq,
  spectrumSlice,
  findPeaks,
  sampleColormap,
  buildSpectrogramImage,
  sliceToCsv,
  peaksToCsv,
  estimateMemoryBytes,
  buildFileName,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  sourceSection: $('source-section'),
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  fileName: $('file-name'),
  fileMeta: $('file-meta'),
  recordBtn: $('record-btn'),
  recordStatus: $('record-status'),
  clearFileBtn: $('clear-file-btn'),
  editor: $('editor-section'),
  audio: $('audio'),
  playBtn: $('play-btn'),
  timeLabel: $('time-label'),
  cursorReadout: $('cursor-readout'),
  fftSize: $('fft-size'),
  windowSelect: $('window-select'),
  hopSize: $('hop-size'),
  colormapSelect: $('colormap-select'),
  minDb: $('min-db'),
  minDbValue: $('min-db-value'),
  maxDb: $('max-db'),
  maxDbValue: $('max-db-value'),
  logFreqCheck: $('log-freq-check'),
  freqMin: $('freq-min'),
  freqMax: $('freq-max'),
  analyzeBtn: $('analyze-btn'),
  cancelBtn: $('cancel-btn'),
  progressWrap: $('progress-wrap'),
  progressBar: $('progress-bar'),
  progressLabel: $('progress-label'),
  statDuration: $('stat-duration'),
  statSize: $('stat-size'),
  statResolution: $('stat-resolution'),
  statusText: $('status-text'),
  peakCount: $('peak-count'),
  peakList: $('peak-list'),
  spectrogramWrap: $('spectrogram-wrap'),
  spectrogram: $('spectrogram-canvas'),
  spectrogramEmpty: $('spectrogram-empty'),
  sliceWrap: $('slice-wrap'),
  slice: $('slice-canvas'),
  sliceEmpty: $('slice-empty'),
  savePngBtn: $('save-png-btn'),
  saveCsvBtn: $('save-csv-btn'),
  savePeaksBtn: $('save-peaks-btn'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
};

const SPECTROGRAM_HEIGHT = 360;
const SLICE_HEIGHT = 200;
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

const state = {
  url: '',
  fileName: '',
  audioBuffer: null,
  mono: null,
  sampleRate: 0,
  duration: 0,
  result: null,
  imageCanvas: null,
  imageKey: '',
  selectedFrame: 0,
  cursorTime: 0,
  peaks: [],
  sliceDb: null,
  worker: null,
  pending: null,
  busy: false,
  cancelled: false,
  live: false,
  liveStream: null,
  liveCtx: null,
  liveAnalyser: null,
  liveSource: null,
  liveRaf: 0,
  liveData: null,
  playing: false,
  raf: 0,
  audioCtx: null,
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

function setStatus(text) {
  els.statusText.textContent = text;
}

function getAudioContext() {
  if (!state.audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctor();
  }
  return state.audioCtx;
}

function readSettings() {
  const fftSize = nextPowerOfTwo(Number(els.fftSize.value) || DEFAULT_FFT_SIZE);
  const hopRaw = Number(els.hopSize.value) || DEFAULT_HOP_SIZE;
  const hopSize = clamp(hopRaw, 1, fftSize);
  const nyquist = state.sampleRate > 0 ? state.sampleRate / 2 : 20000;
  let minFreq = Number(els.freqMin.value);
  let maxFreq = Number(els.freqMax.value);
  if (!Number.isFinite(minFreq)) minFreq = defaultMinFreq(state.sampleRate || 44100);
  if (!Number.isFinite(maxFreq) || maxFreq <= 0) maxFreq = nyquist;
  minFreq = clamp(minFreq, 1, nyquist);
  maxFreq = clamp(maxFreq, minFreq + 1, nyquist);
  return {
    fftSize,
    hopSize,
    windowType: els.windowSelect.value || DEFAULT_WINDOW,
    colormap: els.colormapSelect.value || DEFAULT_COLORMAP,
    minDb: Number(els.minDb.value) || DEFAULT_MIN_DB,
    maxDb: Number(els.maxDb.value),
    logFreq: els.logFreqCheck.checked,
    minFreq,
    maxFreq,
  };
}

function syncDbLabels() {
  els.minDbValue.textContent = `${els.minDb.value} dB`;
  els.maxDbValue.textContent = `${els.maxDb.value} dB`;
}

/* ==========================================================
   音声の読み込み
   ========================================================== */

function isSupportedAudioFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(file.name || '');
}

async function decodeArrayBuffer(arrayBuffer) {
  const ctx = getAudioContext();
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const channels = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) channels.push(buffer.getChannelData(i));
  const mono = trimToSeconds(mixToMono(channels), buffer.sampleRate, MAX_INPUT_SECONDS);
  return { buffer, mono, sampleRate: buffer.sampleRate, duration: mono.length / buffer.sampleRate };
}

async function loadFile(file) {
  if (!isSupportedAudioFile(file)) {
    showError('音声ファイルを選んでください。');
    return;
  }
  hideError();
  resetResult();
  state.fileName = file.name;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} / 読み込み中…`;
  setStatus('音声をデコードしています…');
  try {
    const decoded = await decodeArrayBuffer(await file.arrayBuffer());
    applyDecoded(decoded);
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(file);
    els.audio.src = state.url;
    els.fileMeta.textContent =
      `${formatBytes(file.size)} / ${decoded.buffer.numberOfChannels}ch / ` +
      `${formatSeconds(decoded.duration)}`;
  } catch (error) {
    showError('この音声はデコードできませんでした。対応形式か確認してください。');
    els.fileMeta.textContent = '';
    setStatus('音声を読み込めませんでした。');
  }
}

function applyDecoded({ mono, sampleRate, duration }) {
  stopLive();
  state.mono = mono;
  state.sampleRate = sampleRate;
  state.duration = duration;
  state.selectedFrame = 0;
  state.cursorTime = 0;
  els.editor.hidden = false;
  els.clearFileBtn.hidden = false;
  els.analyzeBtn.disabled = false;
  els.statDuration.textContent = formatSeconds(duration);
  els.statSize.textContent = '-';
  els.statResolution.textContent = `${formatHz(sampleRate / 2)} まで`;
  const nyquist = sampleRate / 2;
  els.freqMax.max = Math.round(nyquist);
  if (Number(els.freqMax.value) > nyquist) els.freqMax.value = String(Math.round(nyquist));
  if (Number(els.freqMin.value) < 1) els.freqMin.value = '1';
  setStatus('「解析する」を押すとスペクトログラムを計算します。');
  resizeCanvases();
  showEmptyState(true);
}

function clearFile() {
  cancelAnalysis();
  stopLive();
  stopPlayback();
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = '';
  state.fileName = '';
  state.mono = null;
  state.sampleRate = 0;
  state.duration = 0;
  state.audioBuffer = null;
  els.audio.removeAttribute('src');
  try {
    els.audio.load();
  } catch {
    /* noop */
  }
  els.fileInput.value = '';
  els.fileName.textContent = '';
  els.fileMeta.textContent = '';
  els.clearFileBtn.hidden = true;
  els.editor.hidden = true;
  resetResult();
  hideError();
}

/* ==========================================================
   解析
   ========================================================== */

function terminateWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

function runWorkerAnalyze({ samples, sampleRate, fftSize, hopSize, windowType, minDb }) {
  return new Promise((resolve, reject) => {
    terminateWorker();
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker = worker;
    state.pending = { reject };

    worker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'progress') {
        setProgress(message.progress || 0, message.label || '解析中…');
      } else if (message.type === 'done') {
        state.pending = null;
        terminateWorker();
        resolve({
          db: new Float32Array(message.db),
          frameCount: message.frameCount,
          binCount: message.binCount,
          fftSize: message.fftSize,
          hopSize: message.hopSize,
          sampleRate: message.sampleRate,
          duration: message.duration,
        });
      } else if (message.type === 'error') {
        state.pending = null;
        terminateWorker();
        reject(new Error(message.message || '解析に失敗しました'));
      }
    });
    worker.addEventListener('error', (event) => {
      state.pending = null;
      terminateWorker();
      reject(new Error(event.message || '解析に失敗しました'));
    });

    const buffer = samples.buffer.slice(0);
    worker.postMessage(
      { type: 'analyze', samples: buffer, sampleRate, fftSize, hopSize, windowType, minDb },
      [buffer],
    );
  });
}

async function analyze() {
  if (state.busy || !state.mono) return;
  hideError();
  stopLive();
  const settings = readSettings();
  state.busy = true;
  state.cancelled = false;
  els.analyzeBtn.disabled = true;
  els.cancelBtn.hidden = false;
  setProgress(0, '準備中…');

  try {
    const result = await runWorkerAnalyze({
      samples: state.mono,
      sampleRate: state.sampleRate,
      fftSize: settings.fftSize,
      hopSize: settings.hopSize,
      windowType: settings.windowType,
      minDb: DB_FLOOR,
    });
    if (state.cancelled) throw new DOMException('cancelled', 'AbortError');
    state.result = result;
    state.cursorTime = 0;
    state.selectedFrame = 0;
    state.imageCanvas = null;
    state.imageKey = '';
    els.statSize.textContent = `${result.frameCount} × ${result.binCount}`;
    els.statResolution.textContent = formatHz(result.sampleRate / result.fftSize);
    const bytes = estimateMemoryBytes(result.frameCount, result.binCount);
    setStatus(
      `解析完了: ${result.frameCount} フレーム / ${result.binCount} ビン (約 ${formatBytes(bytes)})`,
    );
    setProgress(1, '完了');
    showEmptyState(false);
    renderSpectrogram();
    selectFrame(0);
    els.playBtn.disabled = false;
    els.savePngBtn.disabled = false;
    els.saveCsvBtn.disabled = false;
    els.savePeaksBtn.disabled = false;
  } catch (error) {
    if (!state.cancelled && error && error.name !== 'AbortError') {
      showError(error.message || '解析に失敗しました。');
      setStatus('解析に失敗しました。');
    }
  } finally {
    state.busy = false;
    els.analyzeBtn.disabled = !state.mono;
    els.cancelBtn.hidden = true;
    els.progressWrap.hidden = true;
  }
}

function cancelAnalysis() {
  state.cancelled = true;
  if (state.pending) {
    const { reject } = state.pending;
    state.pending = null;
    reject(new DOMException('cancelled', 'AbortError'));
  }
  terminateWorker();
  state.busy = false;
  els.cancelBtn.hidden = true;
  els.progressWrap.hidden = true;
  els.analyzeBtn.disabled = !state.mono;
}

function resetResult() {
  state.result = null;
  state.imageCanvas = null;
  state.imageKey = '';
  state.peaks = [];
  state.sliceDb = null;
  els.playBtn.disabled = true;
  els.savePngBtn.disabled = true;
  els.saveCsvBtn.disabled = true;
  els.savePeaksBtn.disabled = true;
  els.statSize.textContent = '-';
  setProgress(0, '');
  renderPeaks([]);
}

/* ==========================================================
   表示
   ========================================================== */

function setProgress(ratio, label) {
  els.progressWrap.hidden = false;
  const percent = clamp01(ratio) * 100;
  els.progressBar.style.width = `${percent.toFixed(1)}%`;
  if (label) els.progressLabel.textContent = label;
}

function showEmptyState(empty) {
  els.spectrogramEmpty.style.display = empty ? 'flex' : 'none';
  els.sliceEmpty.style.display = state.sliceDb ? 'none' : 'flex';
}

function canvasScale() {
  return Math.min(2, window.devicePixelRatio || 1);
}

function resizeCanvases() {
  if (els.editor.hidden) return;
  const scale = canvasScale();
  const width = Math.max(320, Math.round((els.spectrogramWrap.clientWidth || 600) * scale));
  els.spectrogram.width = width;
  els.spectrogram.height = Math.round(SPECTROGRAM_HEIGHT * scale);
  els.slice.width = width;
  els.slice.height = Math.round(SLICE_HEIGHT * scale);
  renderSpectrogram();
  if (state.result) renderSlice();
}

function settingsKey() {
  const s = readSettings();
  return [
    s.colormap, s.minDb, s.maxDb, s.logFreq, s.minFreq, s.maxFreq,
    state.result ? state.result.frameCount : 0,
    state.result ? state.result.binCount : 0,
    els.spectrogram.width, els.spectrogram.height,
  ].join('|');
}

function buildImageCache() {
  const result = state.result;
  if (!result) return null;
  const key = settingsKey();
  if (state.imageCanvas && state.imageKey === key) return state.imageCanvas;
  const settings = readSettings();
  const image = buildSpectrogramImage({
    db: result.db,
    frameCount: result.frameCount,
    binCount: result.binCount,
    sampleRate: result.sampleRate,
    fftSize: result.fftSize,
    minFreq: settings.minFreq,
    maxFreq: settings.maxFreq,
    logFreq: settings.logFreq,
    minDb: settings.minDb,
    maxDb: settings.maxDb,
    colormap: settings.colormap,
    width: els.spectrogram.width,
    height: els.spectrogram.height,
  });
  const off = document.createElement('canvas');
  off.width = image.width;
  off.height = image.height;
  const offCtx = off.getContext('2d');
  const imageData = offCtx.createImageData(image.width, image.height);
  imageData.data.set(image.data);
  offCtx.putImageData(imageData, 0, 0);
  state.imageCanvas = off;
  state.imageKey = key;
  return off;
}

function timeToX(time) {
  if (!state.duration) return 0;
  return (clamp(time, 0, state.duration) / state.duration) * els.spectrogram.width;
}

function xToTime(x) {
  if (!els.spectrogram.width) return 0;
  return clamp01(x / els.spectrogram.width) * state.duration;
}

function freqToY(freq) {
  const s = readSettings();
  const t = freqToNormalized(freq, s.minFreq, s.maxFreq, s.logFreq);
  return (1 - t) * els.spectrogram.height;
}

function renderSpectrogram() {
  const canvas = els.spectrogram;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const result = state.result;
  if (!result) return;

  const cache = buildImageCache();
  if (cache) ctx.drawImage(cache, 0, 0, canvas.width, canvas.height);

  const settings = readSettings();
  ctx.save();
  ctx.font = `${Math.round(11 * canvasScale())}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'middle';

  // 周波数グリッド
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.lineWidth = 1;
  for (const freq of GRID_FREQS) {
    if (freq < settings.minFreq || freq > settings.maxFreq) continue;
    const y = freqToY(freq);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.fillText(formatHz(freq), 4 * canvasScale(), y - 8 * canvasScale());
  }

  // 再生位置
  const playX = timeToX(els.audio.currentTime || 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(1, canvasScale());
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, canvas.height);
  ctx.stroke();

  // カーソル
  const cursorX = timeToX(state.cursorTime);
  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = Math.max(1, canvasScale());
  ctx.beginPath();
  ctx.moveTo(cursorX, 0);
  ctx.lineTo(cursorX, canvas.height);
  ctx.stroke();
  ctx.restore();
}

function renderSlice() {
  const canvas = els.slice;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const scale = canvasScale();
  ctx.clearRect(0, 0, w, h);
  if (!state.sliceDb || !state.result) return;

  const settings = readSettings();
  const result = state.result;
  const slice = state.sliceDb;
  const padding = { left: 46 * scale, right: 8 * scale, top: 10 * scale, bottom: 20 * scale };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const freqToX = (freq) =>
    padding.left + freqToNormalized(freq, settings.minFreq, settings.maxFreq, settings.logFreq) * plotW;
  const dbToY = (db) =>
    padding.top + (1 - clamp01((db - settings.minDb) / Math.max(1e-6, settings.maxDb - settings.minDb))) * plotH;

  // グリッド
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--c-text-3').trim() || '#94a3b8';
  ctx.font = `${Math.round(10 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.lineWidth = 1;
  for (const freq of GRID_FREQS) {
    if (freq < settings.minFreq || freq > settings.maxFreq) continue;
    const x = freqToX(freq);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotH);
    ctx.stroke();
    ctx.fillText(formatHz(freq), x + 3 * scale, padding.top + plotH + 13 * scale);
  }
  for (const db of [0, -20, -40, -60, -80, -100]) {
    if (db > settings.maxDb || db < settings.minDb) continue;
    const y = dbToY(db);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 4 * scale, y);
  }

  // 曲線
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--app-color').trim() || '#0891b2';
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  ctx.beginPath();
  let started = false;
  for (let k = 0; k < slice.length; k += 1) {
    const freq = binToHz(k, result.sampleRate, result.fftSize);
    if (freq < settings.minFreq || freq > settings.maxFreq) continue;
    const x = freqToX(freq);
    const y = dbToY(slice[k]);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // ピークの印
  ctx.fillStyle = '#f43f5e';
  for (const peak of state.peaks) {
    const x = freqToX(peak.hz);
    const y = dbToY(peak.db);
    ctx.beginPath();
    ctx.arc(x, y, 3.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

function positionToFrame(time) {
  const result = state.result;
  if (!result) return 0;
  return clamp(Math.round((time * result.sampleRate) / result.hopSize), 0, result.frameCount - 1);
}

function selectFrame(frameIndex) {
  const result = state.result;
  if (!result) return;
  const frame = clamp(Math.floor(frameIndex), 0, result.frameCount - 1);
  state.selectedFrame = frame;
  state.cursorTime = (frame * result.hopSize) / result.sampleRate;
  state.sliceDb = spectrumSlice(result.db, result.frameCount, result.binCount, frame);
  const settings = readSettings();
  state.peaks = findPeaks(state.sliceDb, {
    sampleRate: result.sampleRate,
    fftSize: result.fftSize,
    thresholdDb: settings.maxDb - 60,
    minSeparationBins: Math.max(2, Math.round(result.fftSize / 512)),
    maxPeaks: 10,
  });
  els.sliceEmpty.style.display = 'none';
  els.cursorReadout.textContent = `カーソル: ${formatSeconds(state.cursorTime)}`;
  renderPeaks(state.peaks);
  renderSlice();
  renderSpectrogram();
}

function renderPeaks(peaks) {
  els.peakCount.textContent = String(peaks.length);
  els.peakList.innerHTML = '';
  if (!peaks.length) {
    const li = document.createElement('li');
    li.className = 'peak-empty';
    li.textContent = state.result ? 'ピークは検出されませんでした' : 'カーソル位置の断面からピークを表示します';
    els.peakList.appendChild(li);
    return;
  }
  for (const peak of peaks) {
    const li = document.createElement('li');
    li.className = 'peak-item';
    li.textContent = `${formatHz(peak.hz)} — ${formatDb(peak.db)} (bin ${peak.bin})`;
    els.peakList.appendChild(li);
  }
}

function updateTimeLabel() {
  els.timeLabel.textContent = formatSeconds(els.audio.currentTime || 0);
}

/* ==========================================================
   再生
   ========================================================== */

function updatePlayIcon() {
  const playing = !els.audio.paused;
  els.playBtn.querySelector('[data-play-icon]').hidden = playing;
  els.playBtn.querySelector('[data-pause-icon]').hidden = !playing;
}

function playbackLoop() {
  if (els.audio.paused) {
    state.playing = false;
    return;
  }
  state.playing = true;
  updateTimeLabel();
  renderSpectrogram();
  const frame = positionToFrame(els.audio.currentTime);
  if (frame !== state.selectedFrame) {
    state.selectedFrame = frame;
    state.cursorTime = (frame * state.result.hopSize) / state.result.sampleRate;
    state.sliceDb = spectrumSlice(state.result.db, state.result.frameCount, state.result.binCount, frame);
    state.peaks = findPeaks(state.sliceDb, {
      sampleRate: state.result.sampleRate,
      fftSize: state.result.fftSize,
      thresholdDb: readSettings().maxDb - 60,
      minSeparationBins: Math.max(2, Math.round(state.result.fftSize / 512)),
      maxPeaks: 10,
    });
    els.cursorReadout.textContent = `カーソル: ${formatSeconds(state.cursorTime)}`;
    renderPeaks(state.peaks);
    renderSlice();
  }
  state.raf = requestAnimationFrame(playbackLoop);
}

function togglePlay() {
  if (!state.result || state.live) return;
  if (els.audio.paused) {
    els.audio.play().catch(() => {});
  } else {
    els.audio.pause();
  }
}

function stopPlayback() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.playing = false;
  els.audio.pause();
  updatePlayIcon();
}

/* ==========================================================
   マイク (リアルタイム表示)
   ========================================================== */

async function toggleLive() {
  if (state.live) {
    stopLive();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('このブラウザではマイク入力を利用できません。');
    return;
  }
  try {
    stopPlayback();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = getAudioContext();
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    const fftSize = clamp(nextPowerOfTwo(Number(els.fftSize.value) || DEFAULT_FFT_SIZE), 256, 8192);
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    state.liveStream = stream;
    state.liveSource = source;
    state.liveAnalyser = analyser;
    state.liveData = new Float32Array(analyser.frequencyBinCount);
    state.live = true;
    els.recordBtn.classList.add('is-active');
    els.recordStatus.textContent = 'マイク入力中（もう一度押すと停止）';
    els.editor.hidden = false;
    showEmptyState(false);
    els.sliceEmpty.style.display = 'flex';
    resizeCanvases();
    setStatus(`マイク入力: ${analyser.fftSize} 点 FFT / リアルタイム表示中`);
    liveLoop();
  } catch (error) {
    showError('マイク入力を取得できませんでした（許可を確認してください）。');
  }
}

function stopLive() {
  if (state.liveRaf) cancelAnimationFrame(state.liveRaf);
  state.liveRaf = 0;
  if (state.liveSource) {
    try { state.liveSource.disconnect(); } catch { /* noop */ }
  }
  if (state.liveStream) {
    for (const track of state.liveStream.getTracks()) track.stop();
  }
  if (state.liveAnalyser) {
    try { state.liveAnalyser.disconnect(); } catch { /* noop */ }
  }
  state.live = false;
  state.liveStream = null;
  state.liveSource = null;
  state.liveAnalyser = null;
  state.liveData = null;
  els.recordBtn.classList.remove('is-active');
  els.recordStatus.textContent = 'マイクは停止中';
}

function liveLoop() {
  if (!state.live || !state.liveAnalyser) return;
  const canvas = els.spectrogram;
  const ctx = canvas.getContext('2d');
  const scale = canvasScale();
  const settings = readSettings();
  const analyser = state.liveAnalyser;
  analyser.getFloatFrequencyData(state.liveData);

  // 左へ 1px シフトして右端に現在のスペクトルを描く
  ctx.drawImage(canvas, -1, 0);

  const nyquist = analyser.context.sampleRate / 2;
  for (let y = 0; y < canvas.height; y += 1) {
    const t = canvas.height === 1 ? 1 : 1 - y / (canvas.height - 1);
    const freq = normalizedToFreq(t, settings.minFreq, settings.maxFreq, settings.logFreq);
    const bin = clamp(Math.round((freq / nyquist) * (analyser.frequencyBinCount - 1)), 0, state.liveData.length - 1);
    const db = state.liveData[bin];
    const [r, g, b] = sampleColormap(settings.colormap, clamp01((db - settings.minDb) / Math.max(1e-6, settings.maxDb - settings.minDb)));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(canvas.width - 1, y, 1, 1);
  }

  // 周波数ラベル
  ctx.save();
  ctx.font = `${Math.round(11 * scale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  for (const freq of GRID_FREQS) {
    if (freq < settings.minFreq || freq > settings.maxFreq) continue;
    const y = (1 - freqToNormalized(freq, settings.minFreq, settings.maxFreq, settings.logFreq)) * canvas.height;
    ctx.fillText(formatHz(freq), 4 * scale, y - 8 * scale);
  }
  ctx.restore();

  // 右端の断面を表示
  const slice = new Float32Array(analyser.frequencyBinCount);
  for (let k = 0; k < slice.length; k += 1) {
    slice[k] = Number.isFinite(state.liveData[k]) ? state.liveData[k] : DB_FLOOR;
  }
  state.result = {
    db: slice,
    frameCount: 1,
    binCount: slice.length,
    fftSize: analyser.fftSize,
    hopSize: analyser.fftSize,
    sampleRate: analyser.context.sampleRate,
    duration: 0,
  };
  state.sliceDb = slice;
  state.peaks = findPeaks(slice, {
    sampleRate: analyser.context.sampleRate,
    fftSize: analyser.fftSize,
    thresholdDb: settings.maxDb - 60,
    minSeparationBins: Math.max(2, Math.round(analyser.fftSize / 512)),
    maxPeaks: 10,
  });
  renderPeaks(state.peaks);
  renderSlice();

  state.liveRaf = requestAnimationFrame(liveLoop);
}

/* ==========================================================
   書き出し
   ========================================================== */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function savePng() {
  if (!state.result || state.live) return;
  els.spectrogram.toBlob((blob) => {
    if (blob) downloadBlob(blob, buildFileName(state.fileName || 'spectrogram', 'png'));
  }, SPECTROGRAM_MIME);
}

function saveCsv() {
  if (!state.sliceDb || !state.result) return;
  const result = state.result;
  const freqs = new Float32Array(result.binCount);
  for (let k = 0; k < result.binCount; k += 1) freqs[k] = binToHz(k, result.sampleRate, result.fftSize);
  const csv = sliceToCsv(freqs, state.sliceDb);
  downloadBlob(new Blob([csv], { type: 'text/csv' }), buildFileName(state.fileName || 'spectrum', 'csv'));
}

function savePeaks() {
  if (!state.peaks.length) return;
  const csv = peaksToCsv(state.peaks);
  downloadBlob(new Blob([csv], { type: 'text/csv' }), buildFileName(state.fileName || 'spectrum', 'peaks.csv'));
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

function bindSpectrogram() {
  els.spectrogram.addEventListener('click', (event) => {
    if (!state.result || state.live) return;
    const rect = els.spectrogram.getBoundingClientRect();
    const scale = els.spectrogram.width / Math.max(1, rect.width);
    const time = xToTime((event.clientX - rect.left) * scale);
    if (state.url) {
      try { els.audio.currentTime = time; } catch { /* noop */ }
    }
    selectFrame(positionToFrame(time));
    updateTimeLabel();
  });
}

function bindControls() {
  els.analyzeBtn.addEventListener('click', analyze);
  els.cancelBtn.addEventListener('click', cancelAnalysis);
  els.clearFileBtn.addEventListener('click', clearFile);
  els.playBtn.addEventListener('click', togglePlay);
  els.recordBtn.addEventListener('click', toggleLive);

  els.audio.addEventListener('play', () => {
    updatePlayIcon();
    if (!state.playing) state.raf = requestAnimationFrame(playbackLoop);
  });
  els.audio.addEventListener('pause', () => {
    updatePlayIcon();
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.playing = false;
  });

  // STFT パラメータは再解析が必要
  for (const el of [els.fftSize, els.windowSelect, els.hopSize]) {
    el.addEventListener('change', () => {
      if (state.result && !state.live) {
        setStatus('STFT の設定を変更しました。「解析する」で再計算します。');
      }
    });
  }
  // 表示だけを変える項目は再描画
  for (const el of [els.colormapSelect, els.logFreqCheck]) {
    el.addEventListener('change', () => {
      if (state.result && !state.live) {
        renderSpectrogram();
        renderSlice();
      }
    });
  }
  for (const el of [els.minDb, els.maxDb]) {
    el.addEventListener('input', () => {
      syncDbLabels();
      if (state.result && !state.live) {
        renderSpectrogram();
        renderSlice();
      }
    });
  }
  for (const el of [els.freqMin, els.freqMax]) {
    el.addEventListener('change', () => {
      if (state.result && !state.live) {
        renderSpectrogram();
        renderSlice();
      }
    });
  }

  els.savePngBtn.addEventListener('click', savePng);
  els.saveCsvBtn.addEventListener('click', saveCsv);
  els.savePeaksBtn.addEventListener('click', savePeaks);

  document.addEventListener('keydown', (event) => {
    if (els.editor.hidden || state.live) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    }
  });
}

function bindInfoModal() {
  const open = () => { els.infoModal.style.display = 'flex'; };
  const close = () => { els.infoModal.style.display = 'none'; };
  els.infoBtn.addEventListener('click', open);
  els.closeInfoBtn.addEventListener('click', close);
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.infoModal.style.display === 'flex') close();
  });
}

function init() {
  syncDbLabels();
  bindFileInput();
  bindSpectrogram();
  bindControls();
  bindInfoModal();
  let timer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(resizeCanvases, 120);
  });
  resizeCanvases();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(resizeCanvases).catch(() => {});
  }
}

init();
