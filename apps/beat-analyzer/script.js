/**
 * script.js — ビート解析のメインスレッド制御
 *
 * すべてブラウザ内で完結する。音声はどこにも送信しない。
 * 推論は onnxruntime-web (WASM) で Beat This! の ONNX 変換を動かす。
 * 純ロジック (フレーム/チャンク・ピーク検出・BPM/拍子推定・書き出し) は pipeline.mjs に分離。
 *
 * モデル:
 *   https://huggingface.co/ashudesai/songbird-models (MIT)
 *   https://github.com/CPJKU/beat_this (MIT)
 */

import {
  SAMPLE_RATE,
  N_MELS,
  CHUNK_SIZE,
  BORDER_SIZE,
  MAX_INPUT_SECONDS,
  SONGBIRD_MODEL_BASE,
  MEL_MODEL_FILE,
  BEAT_MODEL_FILE,
  ORT_MODULE_URL,
  ORT_WASM_PATHS,
  estimateDownloadBytes,
  formatBytes,
  formatSeconds,
  formatMeter,
  mixToMono,
  resampleLinear,
  melFrameCount,
  planSpectChunks,
  buildChunkInput,
  aggregateChunkPredictions,
  pickPeaks,
  snapToBeats,
  buildBeatGrid,
  gridToJson,
  gridToCsv,
  BEAT_HANDOFF_KEY,
  serializeBeatHandoff,
  canHandoffBeat,
  isSupportedAudioFile,
  sanitizeBaseName,
  buildFileName,
  DEFAULT_METER,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

/* ==========================================================
   DOM
   ========================================================== */

const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');
const $modelSize = $('model-size');
const $modelLicense = $('model-license');

const $appMain = $('app-main');
const $errorBox = $('error-box');
const $audioDrop = $('audio-drop');
const $fileInput = $('file-input');
const $recordBtn = $('record-btn');
const $recordStatus = $('record-status');
const $sourceName = $('source-name');
const $audioPreview = $('audio-preview');
const $thresholdInput = $('threshold-input');
const $thresholdValue = $('threshold-value');
const $radiusInput = $('radius-input');
const $radiusValue = $('radius-value');
const $analyzeBtn = $('analyze-btn');
const $clearBtn = $('clear-btn');
const $processProgress = $('process-progress');
const $processProgressFill = $('process-progress-fill');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $timeBadge = $('time-badge');
const $statusText = $('status-text');

const $statBpm = $('stat-bpm');
const $statBpmNote = $('stat-bpm-note');
const $statMeter = $('stat-meter');
const $statMeterNote = $('stat-meter-note');
const $statBeats = $('stat-beats');
const $statDownbeats = $('stat-downbeats');
const $timelineWrap = $('timeline-wrap');
const $timelineCanvas = $('timeline-canvas');
const $resultEmpty = $('result-empty');
const $playBtn = $('play-btn');
const $stopBtn = $('stop-btn');
const $clickToggle = $('click-toggle');
const $saveJsonBtn = $('save-json-btn');
const $saveCsvBtn = $('save-csv-btn');
const $openStudioBtn = $('open-studio-btn');
const $infoBtn = $('info-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

/* ==========================================================
   状態
   ========================================================== */

let ort = null; // onnxruntime-web モジュール
let melSession = null;
let beatSession = null;
let melInputName = 'audio_pcm';
let beatInputName = 'spectrogram';
let appReady = false;
let modelReady = false;
let running = false;

let sourceSamples = null; // Float32Array @ 22050Hz mono
let sourceDuration = 0;
let sourceLabel = '';
let sourceUrl = null;

let mediaRecorder = null;
let recordStream = null;
let recordedChunks = [];

let grid = null; // buildBeatGrid の結果
let elapsedMs = 0;

let audioCtx = null;
let playing = false;
let playToken = 0;
let scheduledClicks = [];
let playStartedAt = 0;
let playheadSeconds = -1;

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */

function setStatus(text) {
  $statusText.textContent = text;
}

function setLoadingStatus(text) {
  $loadingStatus.textContent = text;
}

function setProgress(ratio) {
  $progressFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
}

function setProcessProgress(ratio) {
  $processProgressFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
}

function showError(text) {
  $errorBox.textContent = text;
  $errorBox.style.display = 'block';
}

function clearError() {
  $errorBox.textContent = '';
  $errorBox.style.display = 'none';
}

function showApp() {
  $loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    $loadingScreen.style.display = 'none';
    $appMain.style.display = 'block';
    renderTimeline();
  }, 400);
}

function resetConsent(buttonLabel) {
  $loadingState.style.display = 'none';
  $consentState.style.display = 'block';
  $consentBtn.disabled = false;
  $consentBtn.textContent = buttonLabel;
  appReady = false;
  modelReady = false;
}

/* ==========================================================
   エンジンの読み込み
   ========================================================== */

function detectBackend() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return gl ? 'WebGL' : 'CPU';
  } catch {
    return 'CPU';
  }
}

async function fetchModel(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`モデルを取得できません (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(total ? received / total : 0, received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function initEngine() {
  setLoadingStatus('ONNX Runtime (WASM) を読み込んでいます…');
  setProgress(0.02);
  ort = await import(/* webpackIgnore: true */ ORT_MODULE_URL);
  ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';

  setLoadingStatus(`メル変換モデル（${formatBytes(302301)}）を読み込んでいます…`);
  setProgress(0.15);
  const melBytes = await fetchModel(`${SONGBIRD_MODEL_BASE}${MEL_MODEL_FILE}`, (p) => setProgress(0.15 + p * 0.1));
  melSession = await ort.InferenceSession.create(melBytes, { executionProviders: ['wasm'] });
  melInputName = melSession.inputNames[0] || 'audio_pcm';

  setLoadingStatus(`ビートモデル（${formatBytes(10401044)}）を読み込んでいます…`);
  setProgress(0.3);
  const beatBytes = await fetchModel(`${SONGBIRD_MODEL_BASE}${BEAT_MODEL_FILE}`, (p) => setProgress(0.3 + p * 0.65));
  beatSession = await ort.InferenceSession.create(beatBytes, { executionProviders: ['wasm'] });
  beatInputName = beatSession.inputNames[0] || 'spectrogram';

  modelReady = true;
  setProgress(1);
  updateBackendBadge();
  updateModelBadge();
  if (!appReady) {
    appReady = true;
    $loadingHint.textContent = '準備完了';
    showApp();
  }
  updateAnalyzeEnabled();
  setStatus('準備完了 — 音声を選ぶか録音してください');
}

/* ==========================================================
   音声の読み込み / デコード / リサンプル
   ========================================================== */

async function loadAudioFile(file) {
  if (!file) return;
  if (!isSupportedAudioFile(file)) {
    showError('対応していない音声形式です (WAV / MP3 / M4A / OGG / FLAC / WebM)。');
    return;
  }
  clearError();
  setStatus('音声を読み込み中…');
  try {
    const buffer = await file.arrayBuffer();
    await decodeAndStore(buffer, file.name || 'audio');
    setPreview(file);
  } catch (err) {
    console.error(err);
    showError(`音声を読み込めませんでした: ${err && err.message ? err.message : String(err)}`);
    setStatus('読み込みに失敗しました');
  }
}

async function decodeAndStore(arrayBuffer, label) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio API が利用できません');
  const ctx = new AudioCtx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (typeof ctx.close === 'function') ctx.close();
  }
  if (decoded.duration > MAX_INPUT_SECONDS) {
    throw new Error(`音源が長すぎます (${Math.round(decoded.duration)} 秒 > 上限 ${MAX_INPUT_SECONDS} 秒)`);
  }

  let samples;
  let duration = decoded.duration;
  try {
    const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    samples = rendered.getChannelData(0);
    duration = rendered.duration;
  } catch (err) {
    console.warn('OfflineAudioContext resample failed, falling back', err);
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
    samples = resampleLinear(mixToMono(channels), decoded.sampleRate, SAMPLE_RATE);
    duration = decoded.duration;
  }

  sourceSamples = Float32Array.from(samples);
  sourceDuration = duration;
  sourceLabel = label;
  resetResult();
  $audioDrop.classList.add('has-audio');
  $sourceName.textContent = `${label} (${formatSeconds(duration)} / ${SAMPLE_RATE}Hz モノラル)`;
  updateAnalyzeEnabled();
  setStatus('音声を読み込みました。「解析する」を押してください');
}

function setPreview(file) {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  $audioPreview.src = sourceUrl;
  $audioPreview.hidden = false;
}

/* ==========================================================
   録音
   ========================================================== */

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('このブラウザではマイク録音を利用できません。');
    return;
  }
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError(`マイクを使用できません: ${err && err.message ? err.message : String(err)}`);
    return;
  }
  recordedChunks = [];
  const mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : '';
  mediaRecorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  });
  mediaRecorder.addEventListener('stop', async () => {
    const type = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
    const blob = new Blob(recordedChunks, { type });
    stopRecordUi();
    try {
      const buffer = await blob.arrayBuffer();
      await decodeAndStore(buffer, 'recording');
      setPreview(blob);
    } catch (err) {
      console.error(err);
      showError(`録音を読み込めませんでした: ${err && err.message ? err.message : String(err)}`);
    }
  });
  mediaRecorder.start();
  startRecordUi();
}

function startRecordUi() {
  $recordBtn.querySelector('span').textContent = '録音を停止';
  $recordStatus.textContent = '録音中…';
  $recordStatus.classList.add('recording');
  setStatus('録音中… ビートの分かる音源をマイクに向けてください');
}

function stopRecordUi() {
  if (recordStream) {
    for (const track of recordStream.getTracks()) track.stop();
    recordStream = null;
  }
  mediaRecorder = null;
  $recordBtn.querySelector('span').textContent = 'マイクで録音';
  $recordStatus.textContent = '録音していません';
  $recordStatus.classList.remove('recording');
}

/* ==========================================================
   解析
   ========================================================== */

function updateAnalyzeEnabled() {
  $analyzeBtn.disabled = !(modelReady && sourceSamples && !running);
  const hasGrid = Boolean(grid && grid.beatCount > 0);
  $playBtn.disabled = !hasGrid;
  $stopBtn.disabled = !hasGrid;
  $saveJsonBtn.disabled = !hasGrid;
  $saveCsvBtn.disabled = !hasGrid;
  $openStudioBtn.disabled = !hasGrid;
}

function startProgress() {
  $processProgress.style.display = 'block';
  setProcessProgress(0);
}

function stopProgress() {
  $processProgress.style.display = 'none';
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** メルスペクトログラムを推論し、フレームごとの beat/downbeat ロジットを返す。 */
async function inferFrames(samples) {
  const totalFrames = melFrameCount(samples.length);
  const plans = planSpectChunks(totalFrames, { chunkSize: CHUNK_SIZE, border: BORDER_SIZE });
  const chunkPreds = [];

  for (const plan of plans) {
    const input = buildChunkInput(samples, plan, N_MELS, CHUNK_SIZE);
    // メル変換モデルは波形を [1, N] (rank 2) で受ける (実機確認済み)
    const melOut = await melSession.run({
      [melInputName]: new ort.Tensor('float32', input, [1, CHUNK_SIZE * N_MELS]),
    });
    const spect = melOut.mel_spectrogram;
    const beatOut = await beatSession.run({ [beatInputName]: spect });
    chunkPreds.push({
      beat: beatOut.beat.data,
      downbeat: beatOut.downbeat.data,
    });
    setProcessProgress((chunkPreds.length / plans.length) * 0.98);
    await nextFrame();
  }

  return aggregateChunkPredictions(chunkPreds, plans, totalFrames, {
    chunkSize: CHUNK_SIZE,
    border: BORDER_SIZE,
  });
}

async function analyze() {
  if (!modelReady || !sourceSamples || running) return;
  clearError();
  running = true;
  updateAnalyzeEnabled();
  startProgress();

  const threshold = Number($thresholdInput.value);
  const radius = Number($radiusInput.value);
  const startedAt = performance.now();

  try {
    setStatus('メルスペクトログラムを計算しています…');
    const frames = await inferFrames(sourceSamples);

    setStatus('ビート位置を検出しています…');
    const beats = pickPeaks(frames.beat, { threshold, radius });
    const rawDownbeats = pickPeaks(frames.downbeat, { threshold, radius });
    const downbeats = snapToBeats(rawDownbeats, beats);

    grid = buildBeatGrid(beats, downbeats, { duration: sourceDuration });
    elapsedMs = performance.now() - startedAt;
    renderResult();
    setStatus(
      grid.beatCount
        ? `${grid.beatCount} 個のビートを検出しました (${grid.bpm} BPM / ${formatMeter(grid.beatsPerBar)})`
        : 'ビートは見つかりませんでした。しきい値を下げるか、拍のはっきりした音源で試してください',
    );
  } catch (err) {
    console.error(err);
    showError(`解析に失敗しました: ${err && err.message ? err.message : String(err)}`);
    setStatus('解析に失敗しました');
  } finally {
    running = false;
    stopProgress();
    updateAnalyzeEnabled();
  }
}

/* ==========================================================
   結果表示
   ========================================================== */

function resetResult() {
  stopPlayback();
  grid = null;
  elapsedMs = 0;
  $timelineCanvas.width = 0;
  $timelineCanvas.height = 0;
  $timelineCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  $statBpm.textContent = '-';
  $statBpmNote.textContent = '-';
  $statMeter.textContent = '-';
  $statMeterNote.textContent = '-';
  $statBeats.textContent = '-';
  $statDownbeats.textContent = '-';
  $timeBadge.textContent = '-';
  updateAnalyzeEnabled();
}

function renderResult() {
  if (!grid) return;
  $statBpm.textContent = grid.bpm ? String(grid.bpm) : '-';
  $statBpmNote.textContent = grid.bpm
    ? `信頼度 ${Math.round(grid.bpmConfidence * 100)}% / 間隔 ${grid.intervalSeconds}s`
    : '検出できませんでした';
  $statMeter.textContent = formatMeter(grid.beatsPerBar);
  $statMeterNote.textContent = grid.meterConfidence
    ? `信頼度 ${Math.round(grid.meterConfidence * 100)}%`
    : '既定値';
  $statBeats.textContent = String(grid.beatCount);
  $statDownbeats.textContent = `ダウンビート ${grid.downbeatCount}`;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(2)} 秒`;
  renderTimeline();
  updateAnalyzeEnabled();
}

function renderTimeline() {
  if (!grid || grid.beatCount === 0) {
    $timelineCanvas.style.display = 'none';
    $resultEmpty.style.display = 'block';
    return;
  }
  $resultEmpty.style.display = 'none';
  $timelineCanvas.style.display = 'block';

  const ctx = $timelineCanvas.getContext('2d');
  const cssWidth = Math.max(320, $timelineWrap.clientWidth - 2);
  const height = 120;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  $timelineCanvas.width = Math.floor(cssWidth * dpr);
  $timelineCanvas.height = Math.floor(height * dpr);
  $timelineCanvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--c-accent').trim() || '#0d9488';
  const surface = styles.getPropertyValue('--c-surface-solid').trim() || '#ffffff';
  const border = styles.getPropertyValue('--c-border').trim() || '#e2e8f0';
  const textColor = styles.getPropertyValue('--c-text-3').trim() || '#94a3b8';
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  ctx.clearRect(0, 0, cssWidth, height);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, cssWidth, height);

  const duration = Math.max(0.5, grid.duration || grid.lastBeat || 1);
  const pad = 8;
  const width = cssWidth - pad * 2;
  const xOf = (t) => pad + (t / duration) * width;

  // 秒グリッド
  const step = duration > 60 ? 10 : duration > 20 ? 5 : duration > 8 ? 2 : 1;
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,17,21,0.08)';
  ctx.fillStyle = textColor;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= duration; t += step) {
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height - 16);
    ctx.stroke();
    ctx.fillText(`${t}s`, x + 2, height - 14);
  }

  // ビート (細い線) とダウンビート (太い線)
  for (const t of grid.beats) {
    const x = xOf(t);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 24);
    ctx.lineTo(x, height - 20);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const t of grid.downbeats) {
    const x = xOf(t);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, height - 20);
    ctx.stroke();
  }

  // 再生ヘッド
  if (playheadSeconds >= 0) {
    const x = xOf(playheadSeconds);
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.strokeStyle = border;
  ctx.strokeRect(0.5, 0.5, cssWidth - 1, height - 1);
}

/* ==========================================================
   クリック音の再生
   ========================================================== */

function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function scheduleClick(audio, at, strong) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(strong ? 1600 : 1000, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(strong ? 0.35 : 0.22, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + 0.06);
  scheduledClicks.push(osc);
}

function stopPlayback() {
  playing = false;
  playToken += 1;
  playheadSeconds = -1;
  for (const osc of scheduledClicks) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      /* ignore */
    }
  }
  scheduledClicks = [];
  if (grid) renderTimeline();
}

function playClicks() {
  if (!grid || grid.beatCount === 0) return;
  stopPlayback();
  const audio = ensureAudio();
  const token = ++playToken;
  playing = true;
  playStartedAt = audio.currentTime;
  const downSet = new Set(grid.downbeats);
  const startAt = audio.currentTime + 0.08;
  for (const t of grid.beats) {
    scheduleClick(audio, startAt + t, downSet.has(t));
  }
  const total = (grid.duration || grid.lastBeat || 1) + 0.2;

  const tick = () => {
    if (!playing || token !== playToken) return;
    playheadSeconds = audio.currentTime - playStartedAt;
    if (playheadSeconds >= total) {
      stopPlayback();
      return;
    }
    renderTimeline();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ==========================================================
   書き出し / midi-studio への受け渡し
   ========================================================== */

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`書き出し: ${filename}`);
}

function saveJson() {
  if (!grid) return;
  downloadText(gridToJson(grid), buildFileName(sourceLabel, '.json'), 'application/json');
}

function saveCsv() {
  if (!grid) return;
  downloadText(gridToCsv(grid), buildFileName(sourceLabel, '.csv'), 'text/csv');
}

function openInStudio() {
  if (!grid) return;
  if (!canHandoffBeat(grid)) {
    setStatus('ビート格子が大きいため .json を保存し、MIDI スタジオで読み込んでください');
    saveJson();
    return;
  }
  try {
    sessionStorage.setItem(BEAT_HANDOFF_KEY, serializeBeatHandoff(grid));
  } catch (err) {
    console.warn('handoff failed', err);
    saveJson();
    return;
  }
  window.location.href = '../midi-studio/index.html';
}

function clearAll() {
  stopPlayback();
  sourceSamples = null;
  sourceDuration = 0;
  sourceLabel = '';
  if (sourceUrl) {
    URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
  }
  $audioPreview.removeAttribute('src');
  $audioPreview.hidden = true;
  $fileInput.value = '';
  $audioDrop.classList.remove('has-audio');
  $sourceName.textContent = '';
  resetResult();
  setStatus('クリアしました');
}

/* ==========================================================
   バックエンド / モデル表示
   ========================================================== */

function updateBackendBadge() {
  const backend = detectBackend();
  $backendBadge.textContent = backend === 'WebGL' ? 'バックエンド: WASM (WebGL あり)' : 'バックエンド: WASM (CPU)';
  $backendBadge.classList.toggle('badge-warning', backend !== 'WebGL');
}

function updateModelBadge() {
  $modelBadge.textContent = `モデル: Beat This! small (${formatBytes(estimateDownloadBytes())})`;
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */

function updateParameterLabels() {
  $thresholdValue.textContent = Number($thresholdInput.value).toFixed(2);
  $radiusValue.textContent = String(Number($radiusInput.value));
}

function updateConsentInfo() {
  $modelSize.textContent = formatBytes(estimateDownloadBytes());
  $modelLicense.textContent = '使用モデル: Beat This! (CPJKU) / ライセンス: MIT';
}

function setupUi() {
  updateParameterLabels();
  updateConsentInfo();
  updateAnalyzeEnabled();

  $consentBtn.addEventListener('click', async () => {
    clearError();
    $consentBtn.disabled = true;
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    $loadingHint.textContent = '初回はモデルのダウンロードが発生します';
    try {
      await initEngine();
    } catch (err) {
      console.error(err);
      showError(`初期化に失敗しました: ${err && err.message ? err.message : String(err)}`);
      resetConsent('再試行する');
    }
  });

  $fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) loadAudioFile(file);
  });

  $audioDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    $audioDrop.classList.add('drag-over');
  });
  $audioDrop.addEventListener('dragleave', () => $audioDrop.classList.remove('drag-over'));
  $audioDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    $audioDrop.classList.remove('drag-over');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadAudioFile(file);
  });

  $recordBtn.addEventListener('click', toggleRecording);
  $thresholdInput.addEventListener('input', updateParameterLabels);
  $radiusInput.addEventListener('input', updateParameterLabels);

  $analyzeBtn.addEventListener('click', analyze);
  $clearBtn.addEventListener('click', clearAll);
  $playBtn.addEventListener('click', playClicks);
  $stopBtn.addEventListener('click', stopPlayback);
  $saveJsonBtn.addEventListener('click', saveJson);
  $saveCsvBtn.addEventListener('click', saveCsv);
  $openStudioBtn.addEventListener('click', openInStudio);

  $infoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'flex';
  });
  $closeInfoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'none';
  });
  $infoModal.addEventListener('click', (event) => {
    if (event.target === $infoModal) $infoModal.style.display = 'none';
  });

  $clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('モデルのキャッシュを削除しますか？\n次回起動時に再ダウンロードが必要になります。')) return;
    try {
      const keys = await caches.keys();
      let removed = 0;
      for (const key of keys) {
        if (key.includes('onnx') || key.includes('ort') || key.includes('huggingface')) {
          await caches.delete(key);
          removed += 1;
        }
      }
      setStatus(`モデルキャッシュを削除しました (${removed} 件)`);
    } catch (err) {
      showError(`キャッシュの削除に失敗しました: ${err && err.message ? err.message : String(err)}`);
    }
  });

  window.addEventListener('resize', () => {
    if (grid) renderTimeline();
  });
}

setupUi();
