/**
 * script.js — 音声文字起こしアプリのメインスレッド制御
 *
 * UI・音声のデコード・波形表示を担当し、推論は worker.js に投げる。
 * 推論モデルのダウンロードも worker 側で完結する。
 */

import {
  SAMPLE_RATE,
  TASKS,
  DTYPE_WEBGPU,
  estimateModelBytes,
  formatBytes,
  formatTimestamp,
  downmixChannels,
  resampleLinear,
  computePeaks,
  findSpeechSegments,
  transcriptToText,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

/* Loading */
const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');
const $modelSize = $('model-size');

/* App */
const $appMain = $('app-main');
const $errorBox = $('error-box');
const $taskSelect = $('task-select');
const $segmentToggle = $('segment-toggle');
const $recordBtn = $('record-btn');
const $fileInput = $('file-input');
const $audioDrop = $('audio-drop');
const $audioPreview = $('audio-preview');
const $audioPlayer = $('audio-player');
const $playBtn = $('play-btn');
const $playIcon = $('play-icon');
const $pauseIcon = $('pause-icon');
const $waveform = $('waveform-canvas');
const $waveformProgress = $('waveform-progress');
const $audioTime = $('audio-time');
const $fileName = $('file-name');
const $transcribeBtn = $('transcribe-btn');
const $cancelBtn = $('cancel-btn');
const $clearBtn = $('clear-btn');
const $backendBadge = $('backend-badge');
const $timeBadge = $('time-badge');
const $segmentBadge = $('segment-badge');
const $statusText = $('status-text');
const $outputText = $('output-text');
const $copyBtn = $('copy-btn');
const $downloadBtn = $('download-btn');
const $infoBtn = $('info-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

/* ==========================================================
   状態
   ========================================================== */
let worker = null;
let ready = false;
let running = false;
let backend = '';
let currentSamples = null; // Float32Array (16kHz mono)
let currentObjectUrl = null;
let mediaRecorder = null;
let recordChunks = [];
let recording = false;
let results = []; // { start, end, text }
let domSegments = []; // { start, end, text } 最終結果

/* ==========================================================
   起動
   ========================================================== */
function createWorker() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function setupWorker() {
  worker = createWorker();

  worker.addEventListener('error', (event) => {
    console.error('worker error:', event);
    showError(`ワーカーでエラーが発生しました: ${event.message || '不明なエラー'}`);
    if (!ready) {
      $loadingState.style.display = 'none';
      $consentState.style.display = 'block';
      $consentBtn.disabled = false;
      $consentBtn.textContent = '再試行する';
    }
  });

  worker.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'status':
        $loadingStatus.textContent = message.message || '準備中…';
        break;
      case 'progress':
        handleProgress(message);
        break;
      case 'backend':
        backend = message.backend || '';
        updateBackendBadge(message.backend, message.fp16, message.fallback);
        break;
      case 'ready':
        ready = true;
        $loadingHint.textContent = '準備完了';
        $progressFill.style.width = '100%';
        showApp();
        break;
      case 'partial':
        handlePartial(message);
        break;
      case 'segment':
        handleSegment(message);
        break;
      case 'done':
        handleDone(message);
        break;
      case 'error':
        handleWorkerError(message);
        break;
      case 'cache-cleared':
        setStatus(`モデルキャッシュを削除しました (${message.removed} 件)`);
        break;
      default:
        break;
    }
  });

  worker.postMessage({ type: 'init' });
}

/* ==========================================================
   ローディング / エラー表示
   ========================================================== */
function handleProgress(message) {
  if (message.stage !== 'download') return;
  const percent = Number(message.percent) || 0;
  if (percent > 0) $progressFill.style.width = `${Math.min(99, percent)}%`;
  if (message.file) {
    $loadingStatus.textContent = 'モデルをダウンロード中…';
    if (message.total) {
      $loadingHint.textContent = `${formatBytes(message.loaded)} / ${formatBytes(message.total)}`;
    }
  }
}

function showApp() {
  $loadingScreen.classList.add('fade-out');
  setTimeout(() => {
    $loadingScreen.style.display = 'none';
    $appMain.style.display = 'block';
    drawWaveform();
  }, 400);
}

function handleWorkerError(message) {
  const prefix =
    message.stage === 'transcribe'
      ? '推論エラー'
      : message.stage === 'cache'
        ? 'キャッシュ操作エラー'
        : '初期化エラー';
  showError(`${prefix}: ${message.error}`);

  if (message.stage === 'init') {
    $loadingState.style.display = 'none';
    $consentState.style.display = 'block';
    $consentBtn.disabled = false;
    $consentBtn.textContent = '再試行する';
  } else if (message.stage === 'transcribe') {
    running = false;
    setRunningUi(false);
    setStatus('推論に失敗しました');
  }
}

function showError(text) {
  $errorBox.textContent = text;
  $errorBox.style.display = 'block';
}

function clearError() {
  $errorBox.textContent = '';
  $errorBox.style.display = 'none';
}

function setStatus(text) {
  $statusText.textContent = text;
}

/* ==========================================================
   音声の読み込み
   ========================================================== */
async function loadAudioFile(file) {
  if (!file) return;
  clearError();
  $fileName.textContent = file.name;
  setStatus('音声を読み込み中…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    currentSamples = await decodeAudio(arrayBuffer);
    onAudioReady();
    const duration = currentSamples.length / SAMPLE_RATE;
    setStatus(`読み込み完了 (${formatTimestamp(duration)})`);
  } catch (err) {
    console.error(err);
    showError(`音声を読み込めませんでした: ${err && err.message ? err.message : String(err)}`);
    setStatus('読み込みに失敗しました');
  }
}

async function decodeAudio(arrayBuffer) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('AudioContext が利用できません');

  let audioCtx;
  try {
    audioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
  } catch {
    audioCtx = new AudioCtx();
  }

  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }
    let mono = downmixChannels(channels);
    if (audioBuffer.sampleRate !== SAMPLE_RATE) {
      mono = resampleLinear(mono, audioBuffer.sampleRate, SAMPLE_RATE);
    }
    return mono;
  } finally {
    if (typeof audioCtx.close === 'function') audioCtx.close();
  }
}

function onAudioReady() {
  $audioDrop.classList.add('has-audio');
  $audioPreview.style.display = 'block';
  drawWaveform();
  updateTranscribeEnabled();
}

function setAudioPlayerSource(blobOrFile) {
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blobOrFile);
  $audioPlayer.src = currentObjectUrl;
  $audioPlayer.currentTime = 0;
  $waveformProgress.style.width = '0%';
  $audioTime.textContent = formatTimestamp(0);
}

/* ==========================================================
   録音
   ========================================================== */
async function toggleRecording() {
  if (recording) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordChunks.push(event.data);
    };
    mediaRecorder.onstop = async () => {
      recording = false;
      setRecordUi(false);
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(recordChunks, { type: recordChunks[0]?.type || 'audio/webm' });
      if (blob.size === 0) return;
      clearError();
      $fileName.textContent = '録音';
      setAudioPlayerSource(blob);
      setStatus('録音した音声を解析中…');
      try {
        currentSamples = await decodeAudio(await blob.arrayBuffer());
        onAudioReady();
        setStatus(`録音を読み込みました (${formatTimestamp(currentSamples.length / SAMPLE_RATE)})`);
      } catch (err) {
        showError(`録音を解析できませんでした: ${err && err.message ? err.message : String(err)}`);
      }
    };
    mediaRecorder.start();
    recording = true;
    setRecordUi(true);
    setStatus('録音中… もう一度押すと停止します');
  } catch (err) {
    console.error(err);
    showError('マイクを利用できませんでした (権限を確認してください)');
  }
}

function setRecordUi(isRecording) {
  $recordBtn.classList.toggle('recording', isRecording);
  $recordBtn.querySelector('span').textContent = isRecording ? '停止' : '録音';
}

/* ==========================================================
   波形
   ========================================================== */
function drawWaveform() {
  if (!currentSamples) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = $waveform.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height || 64));
  $waveform.width = Math.floor(width * dpr);
  $waveform.height = Math.floor(height * dpr);

  const ctx = $waveform.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const color =
    getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || '#14b8a6';
  ctx.fillStyle = color;

  const buckets = Math.max(1, Math.floor(width / 3));
  const peaks = computePeaks(currentSamples, buckets);
  const centerY = height / 2;
  for (let i = 0; i < buckets; i++) {
    const barHeight = Math.max(2, peaks[i] * height * 0.9);
    ctx.fillRect(i * 3, centerY - barHeight / 2, 2, barHeight);
  }
  ctx.restore();
}

function updateWaveformProgress() {
  const duration = $audioPlayer.duration;
  if (!duration || !Number.isFinite(duration)) return;
  const ratio = Math.min(1, $audioPlayer.currentTime / duration);
  $waveformProgress.style.width = `${ratio * 100}%`;
  $audioTime.textContent = `${formatTimestamp($audioPlayer.currentTime)} / ${formatTimestamp(duration)}`;
}

function seekAudio(event) {
  const duration = $audioPlayer.duration;
  if (!duration || !Number.isFinite(duration)) return;
  const rect = $waveform.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  $audioPlayer.currentTime = ratio * duration;
  updateWaveformProgress();
}

function togglePlayback() {
  if (!$audioPlayer.src) return;
  if ($audioPlayer.paused) {
    $audioPlayer.play();
    $playIcon.style.display = 'none';
    $pauseIcon.style.display = 'block';
  } else {
    $audioPlayer.pause();
    $playIcon.style.display = 'block';
    $pauseIcon.style.display = 'none';
  }
}

/* ==========================================================
   推論
   ========================================================== */
function updateTranscribeEnabled() {
  $transcribeBtn.disabled = !(ready && currentSamples && !running);
}

function buildSegments() {
  const duration = currentSamples.length / SAMPLE_RATE;
  if (!$segmentToggle.checked) return [{ start: 0, end: duration }];
  const segments = findSpeechSegments(currentSamples, SAMPLE_RATE);
  if (segments.length === 0) return [{ start: 0, end: duration }];
  return segments;
}

function startTranscribe() {
  if (!ready || !currentSamples || running) return;
  clearError();
  running = true;
  results = [];
  domSegments = [];
  renderOutput();

  const segments = buildSegments();
  const task = $taskSelect.value;
  $segmentBadge.textContent = `区間: ${segments.length}`;
  $timeBadge.textContent = '-';
  setRunningUi(true);
  setStatus(`推論中… (${segments.length} 区間)`);

  // メイン側のサンプルを保持したまま、コピーをワーカーへ転送する
  const copy = currentSamples.slice();
  worker.postMessage({ type: 'transcribe', task, segments, samples: copy.buffer }, [copy.buffer]);
}

function setRunningUi(isRunning) {
  $transcribeBtn.disabled = isRunning;
  $cancelBtn.style.display = isRunning ? 'inline-flex' : 'none';
  $recordBtn.disabled = isRunning;
  if (!isRunning) updateTranscribeEnabled();
}

function handlePartial(message) {
  results[message.segmentIndex] = {
    start: message.start,
    end: message.end,
    text: message.text || '',
    partial: true,
  };
  renderOutput();
}

function handleSegment(message) {
  results[message.segmentIndex] = {
    start: message.start,
    end: message.end,
    text: message.text || '',
    partial: false,
  };
  renderOutput();
}

function handleDone(message) {
  running = false;
  setRunningUi(false);
  domSegments = results.filter(Boolean);
  renderOutput();
  $timeBadge.textContent = `${(message.elapsedMs / 1000).toFixed(1)} 秒`;
  const hasText = domSegments.some((s) => s.text.trim());
  $copyBtn.disabled = !hasText;
  $downloadBtn.disabled = !hasText;
  if (message.cancelled) {
    setStatus('中止しました');
  } else if (!hasText) {
    setStatus('音声を認識できませんでした');
  } else {
    setStatus('完成');
  }
}

function renderOutput() {
  const rows = results.filter(Boolean);
  if (rows.length === 0) {
    $outputText.innerHTML = '<p class="output-placeholder">ここに文字起こし結果が表示されます</p>';
    return;
  }
  const html = rows
    .map((row) => {
      const text = escapeHtml((row.text || '').trim()) || '<span class="muted">認識中…</span>';
      const cursor = row.partial ? '<span class="streaming-cursor"></span>' : '';
      return `<div class="transcript-row"><span class="timestamp">${formatTimestamp(row.start)}</span>` +
        `<span class="transcript-text">${text}${cursor}</span></div>`;
    })
    .join('');
  $outputText.innerHTML = html;
  $outputText.scrollTop = $outputText.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ==========================================================
   コピー / 保存 / クリア
   ========================================================== */
async function copyTranscript() {
  const text = transcriptToText(domSegments);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('クリップボードにコピーしました');
  } catch (err) {
    showError('コピーに失敗しました');
  }
}

function downloadTranscript() {
  const text = transcriptToText(domSegments);
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clearAll() {
  currentSamples = null;
  results = [];
  domSegments = [];
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  $audioPlayer.removeAttribute('src');
  $audioPreview.style.display = 'none';
  $audioDrop.classList.remove('has-audio');
  $fileInput.value = '';
  $fileName.textContent = '';
  $waveformProgress.style.width = '0%';
  $audioTime.textContent = '0:00';
  $segmentBadge.textContent = '区間: -';
  $timeBadge.textContent = '-';
  $copyBtn.disabled = true;
  $downloadBtn.disabled = true;
  renderOutput();
  updateTranscribeEnabled();
  setStatus('クリアしました');
}

/* ==========================================================
   バックエンド表示
   ========================================================== */
function updateBackendBadge(ep, fp16, fallback) {
  if (!ep) {
    $backendBadge.textContent = 'バックエンド: 不明';
    return;
  }
  if (ep === 'webgpu') {
    $backendBadge.textContent = `バックエンド: WebGPU${fp16 ? ' (fp16)' : ''}`;
    $backendBadge.classList.remove('badge-warning');
  } else {
    $backendBadge.textContent = fallback ? 'バックエンド: WASM (フォールバック)' : 'バックエンド: WASM (低速)';
    $backendBadge.classList.add('badge-warning');
  }
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */
function populateTasks() {
  for (const task of TASKS) {
    const option = document.createElement('option');
    option.value = task.key;
    option.textContent = `${task.label} — ${task.description}`;
    $taskSelect.appendChild(option);
  }
  $taskSelect.value = TASKS[0].key;
}

function setupUi() {
  populateTasks();
  $modelSize.textContent = formatBytes(estimateModelBytes(DTYPE_WEBGPU));

  $consentBtn.addEventListener('click', () => {
    clearError();
    $consentBtn.disabled = true;
    $consentState.style.display = 'none';
    $loadingState.style.display = 'block';
    $loadingHint.textContent = '初回は約 1.7 GiB のダウンロードが発生します';
    if (!worker) setupWorker();
  });

  $fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) {
      setAudioPlayerSource(file);
      loadAudioFile(file);
    }
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
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      showError('音声ファイルをドロップしてください');
      return;
    }
    setAudioPlayerSource(file);
    loadAudioFile(file);
  });

  $recordBtn.addEventListener('click', toggleRecording);
  $transcribeBtn.addEventListener('click', startTranscribe);
  $cancelBtn.addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'cancel' });
    setStatus('中止を要求しました…');
  });
  $clearBtn.addEventListener('click', clearAll);

  $playBtn.addEventListener('click', togglePlayback);
  $waveform.addEventListener('click', seekAudio);
  $audioPlayer.addEventListener('timeupdate', updateWaveformProgress);
  $audioPlayer.addEventListener('ended', () => {
    $playIcon.style.display = 'block';
    $pauseIcon.style.display = 'none';
    $waveformProgress.style.width = '0%';
  });
  window.addEventListener('resize', drawWaveform);

  $copyBtn.addEventListener('click', copyTranscript);
  $downloadBtn.addEventListener('click', downloadTranscript);

  $infoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'flex';
  });
  $closeInfoBtn.addEventListener('click', () => {
    $infoModal.style.display = 'none';
  });
  $infoModal.addEventListener('click', (event) => {
    if (event.target === $infoModal) $infoModal.style.display = 'none';
  });

  $clearCacheBtn.addEventListener('click', () => {
    if (
      !confirm(
        'モデルのキャッシュを削除しますか？\n次回起動時に再ダウンロード（約1.7GiB）が必要になります。',
      )
    ) {
      return;
    }
    if (worker) worker.postMessage({ type: 'clear-cache' });
  });

  updateTranscribeEnabled();
}

setupUi();
