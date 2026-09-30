/**
 * script.js — 音声→MIDI 採譜のメインスレッド制御
 *
 * すべてブラウザ内で完結する。音声はどこにも送信しない。
 * 採譜モデルは Basic Pitch (@spotify/basic-pitch, Apache-2.0) を
 * jsDelivr から ES モジュールとして読み込み、端末内で推論する。
 * 純ロジック (リサンプル・窓分割・SMF 変換) は pipeline.mjs に分離している。
 */

import {
  LIB_MODULE_URL,
  MODEL_URL,
  estimateDownloadBytes,
  formatBytes,
  formatSeconds,
  mixToMono,
  resampleLinear,
  SAMPLE_RATE,
  MAX_INPUT_SECONDS,
  WINDOW_SAMPLES,
  OVERLAP_SAMPLES,
  planWindows,
  overallProgress,
  offsetNotes,
  mergeNotes,
  notesExtent,
  midiToName,
  notesToProject,
  writeSmf,
  buildMidiFileName,
  isSupportedAudioFile,
  sanitizeBaseName,
  MIDI_HANDOFF_KEY,
  serializeHandoff,
  canHandoff,
  DEFAULT_ONSET_THRESHOLD,
  DEFAULT_FRAME_THRESHOLD,
  DEFAULT_MIN_NOTE_LEN,
  MIN_PITCH,
  MAX_PITCH,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

/* ==========================================================
   DOM
   ========================================================== */

/* Loading */
const $loadingScreen = $('loading-screen');
const $consentState = $('consent-state');
const $loadingState = $('loading-state');
const $consentBtn = $('consent-btn');
const $loadingStatus = $('loading-status');
const $loadingHint = $('loading-hint');
const $progressFill = $('progress-fill');
const $modelSize = $('model-size');
const $modelLicense = $('model-license');

/* App */
const $appMain = $('app-main');
const $errorBox = $('error-box');
const $audioDrop = $('audio-drop');
const $fileInput = $('file-input');
const $recordBtn = $('record-btn');
const $recordStatus = $('record-status');
const $sourceName = $('source-name');
const $audioPreview = $('audio-preview');
const $onsetInput = $('onset-input');
const $onsetValue = $('onset-value');
const $frameInput = $('frame-input');
const $frameValue = $('frame-value');
const $minlenInput = $('minlen-input');
const $minlenValue = $('minlen-value');
const $transcribeBtn = $('transcribe-btn');
const $clearBtn = $('clear-btn');
const $processProgress = $('process-progress');
const $processProgressFill = $('process-progress-fill');
const $backendBadge = $('backend-badge');
const $modelBadge = $('model-badge');
const $countBadge = $('count-badge');
const $timeBadge = $('time-badge');
const $statusText = $('status-text');
const $rollWrap = $('roll-wrap');
const $rollCanvas = $('roll-canvas');
const $resultEmpty = $('result-empty');
const $noteSummary = $('note-summary');
const $noteList = $('note-list');
const $noteEmpty = $('note-empty');
const $saveBtn = $('save-btn');
const $openStudioBtn = $('open-studio-btn');
const $infoBtn = $('info-btn');
const $infoModal = $('info-modal');
const $closeInfoBtn = $('close-info-btn');
const $clearCacheBtn = $('clear-cache-btn');

/* ==========================================================
   状態
   ========================================================== */

let engine = null; // { basicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime }
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

let notes = []; // 採譜結果 (merge 済み)
let elapsedMs = 0;

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
  const percent = Math.max(0, Math.min(100, ratio * 100));
  $progressFill.style.width = `${percent}%`;
}

function setProcessProgress(ratio) {
  const percent = Math.max(0, Math.min(100, ratio * 100));
  $processProgressFill.style.width = `${percent}%`;
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
    renderRoll();
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

async function initEngine() {
  setLoadingStatus('採譜エンジン (Basic Pitch) を読み込んでいます…');
  setProgress(0.05);
  const module = await import(/* webpackIgnore: true */ LIB_MODULE_URL);
  const { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } = module;
  if (typeof BasicPitch !== 'function') throw new Error('BasicPitch が見つかりません');

  setLoadingStatus(`モデル（${formatBytes(estimateDownloadBytes())}）を読み込んでいます…`);
  setProgress(0.3);
  const basicPitch = new BasicPitch(MODEL_URL);
  await basicPitch.model; // tf.loadGraphModel の完了を待つ

  engine = { basicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime };
  modelReady = true;
  setProgress(1);
  updateBackendBadge();
  updateModelBadge();
  if (!appReady) {
    appReady = true;
    $loadingHint.textContent = '準備完了';
    showApp();
  }
  updateTranscribeEnabled();
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
    // 高品質なリサンプル (OfflineAudioContext)
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
    // フォールバック: 自前の線形補間
    console.warn('OfflineAudioContext resample failed, falling back', err);
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
    samples = resampleLinear(mixToMono(channels), decoded.sampleRate, SAMPLE_RATE);
    duration = decoded.duration;
  }

  sourceSamples = Float32Array.from(samples);
  sourceDuration = duration;
  sourceLabel = label;
  notes = [];
  resetResult();
  $audioDrop.classList.add('has-audio');
  $sourceName.textContent = `${label} (${formatSeconds(duration)} / ${SAMPLE_RATE}Hz モノラル)`;
  updateTranscribeEnabled();
  setStatus('音声を読み込みました。「採譜する」を押してください');
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
  setStatus('録音中… 鼻歌や演奏をマイクに向けてください');
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
   採譜
   ========================================================== */

function updateTranscribeEnabled() {
  $transcribeBtn.disabled = !(modelReady && sourceSamples && !running);
  $saveBtn.disabled = notes.length === 0;
  $openStudioBtn.disabled = notes.length === 0;
}

function startProgress() {
  $processProgress.style.display = 'block';
  $processProgress.classList.remove('indeterminate');
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

async function transcribe() {
  if (!modelReady || !sourceSamples || running) return;
  clearError();
  running = true;
  updateTranscribeEnabled();
  startProgress();

  const onsetThresh = Number($onsetInput.value);
  const frameThresh = Number($frameInput.value);
  const minNoteLen = Number($minlenInput.value);
  const samples = sourceSamples;
  const windows = planWindows(samples.length, WINDOW_SAMPLES, OVERLAP_SAMPLES);
  const collected = [];
  const startedAt = performance.now();

  try {
    for (const window of windows) {
      setStatus(`採譜中… (${window.index + 1}/${windows.length} 窓)`);
      const slice = samples.subarray(window.start, window.end);
      const frames = [];
      const onsets = [];
      const contours = [];
      await engine.basicPitch.evaluateModel(
        slice,
        (f, o, c) => {
          frames.push(...f);
          onsets.push(...o);
          contours.push(...c);
        },
        (p) => setProcessProgress(overallProgress(window.index, windows.length, p)),
      );
      if (frames.length > 0) {
        const detected = engine.noteFramesToTime(
          engine.addPitchBendsToNoteEvents(
            contours,
            engine.outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, minNoteLen),
          ),
        );
        collected.push(...offsetNotes(detected, window.start / SAMPLE_RATE));
      }
      setProcessProgress(overallProgress(window.index + 1, windows.length, 0));
      await nextFrame();
    }

    notes = mergeNotes(collected, { gapTolerance: 0.08 });
    elapsedMs = performance.now() - startedAt;
    renderResult();
    setStatus(
      notes.length
        ? `${notes.length} 個の音符を検出しました`
        : '音符は見つかりませんでした。感度を下げるか、はっきりした単音楽器で試してください',
    );
  } catch (err) {
    console.error(err);
    showError(`採譜に失敗しました: ${err && err.message ? err.message : String(err)}`);
    setStatus('採譜に失敗しました');
  } finally {
    running = false;
    stopProgress();
    updateTranscribeEnabled();
  }
}

/* ==========================================================
   結果表示 (piano roll)
   ========================================================== */

function resetResult() {
  notes = [];
  elapsedMs = 0;
  $rollCanvas.width = 0;
  $rollCanvas.height = 0;
  $rollCanvas.style.display = 'none';
  $resultEmpty.style.display = 'block';
  $noteList.textContent = '';
  $noteEmpty.style.display = 'block';
  $noteSummary.textContent = '採譜結果はまだありません';
  $countBadge.textContent = '音符: -';
  $timeBadge.textContent = '-';
  updateTranscribeEnabled();
}

function renderResult() {
  $countBadge.textContent = `音符: ${notes.length} 件`;
  $timeBadge.textContent = `${(elapsedMs / 1000).toFixed(2)} 秒`;
  renderNoteList();
  renderRoll();
  updateTranscribeEnabled();
}

function isBlackKey(midi) {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function renderRoll() {
  if (!notes.length) {
    $rollCanvas.style.display = 'none';
    $resultEmpty.style.display = 'block';
    return;
  }
  $resultEmpty.style.display = 'none';
  $rollCanvas.style.display = 'block';

  const ctx = $rollCanvas.getContext('2d');
  const extent = notesExtent(notes, { minMidi: 48, maxMidi: 72, maxEnd: 1 });
  const low = Math.max(MIN_PITCH, Math.floor((extent.minMidi - 1) / 12) * 12);
  const high = Math.min(MAX_PITCH, Math.ceil((extent.maxMidi + 1) / 12) * 12);
  const rows = Math.max(1, high - low + 1);
  const rowHeight = Math.max(6, Math.min(14, Math.floor(420 / rows)));
  const gutter = 36;
  const padRight = 12;
  const padBottom = 20;
  const cssWidth = Math.max(320, $rollWrap.clientWidth - 24);
  const height = rows * rowHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  $rollCanvas.width = Math.floor(cssWidth * dpr);
  $rollCanvas.height = Math.floor((height + padBottom) * dpr);
  $rollCanvas.style.width = `${cssWidth}px`;
  $rollCanvas.style.height = `${height + padBottom}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--c-accent').trim() || '#be185d';
  const surface = styles.getPropertyValue('--c-surface-solid').trim() || '#ffffff';
  const border = styles.getPropertyValue('--c-border').trim() || '#e2e8f0';
  const textColor = styles.getPropertyValue('--c-text-3').trim() || '#94a3b8';
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  ctx.clearRect(0, 0, cssWidth, height + padBottom);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, cssWidth, height + padBottom);

  const duration = Math.max(0.5, extent.maxEnd);
  const timeLeft = gutter;
  const timeWidth = cssWidth - gutter - padRight;

  // 行 (黒鍵は暗く)
  for (let midi = low; midi <= high; midi += 1) {
    const y = (high - midi) * rowHeight;
    if (isBlackKey(midi)) {
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,17,21,0.05)';
      ctx.fillRect(timeLeft, y, timeWidth, rowHeight);
    }
    if (midi % 12 === 0) {
      ctx.fillStyle = textColor;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 4, y + rowHeight / 2);
    }
  }

  // 秒グリッド
  const step = duration > 60 ? 10 : duration > 20 ? 5 : duration > 8 ? 2 : 1;
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,17,21,0.08)';
  ctx.fillStyle = textColor;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= duration; t += step) {
    const x = timeLeft + (t / duration) * timeWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(`${t}s`, x + 2, height + 4);
  }

  // 音符
  ctx.fillStyle = accent;
  for (const note of notes) {
    const x = timeLeft + (note.startTimeSeconds / duration) * timeWidth;
    const w = Math.max(2, (note.durationSeconds / duration) * timeWidth);
    const y = (high - note.pitchMidi) * rowHeight;
    const h = Math.max(3, rowHeight - 2);
    ctx.fillRect(x, y + (rowHeight - h) / 2, w, h);
  }

  // 枠
  ctx.strokeStyle = border;
  ctx.strokeRect(timeLeft, 0, timeWidth, height);
}

function renderNoteList() {
  $noteList.textContent = '';
  $noteEmpty.style.display = notes.length ? 'none' : 'block';
  $noteSummary.textContent = notes.length
    ? `${notes.length} 個の音符（先頭 ${Math.min(notes.length, 200)} 件を表示）`
    : '採譜結果はまだありません';

  const limit = Math.min(notes.length, 200);
  for (let i = 0; i < limit; i += 1) {
    const note = notes[i];
    const row = document.createElement('div');
    row.className = 'note-item';

    const swatch = document.createElement('span');
    swatch.className = 'note-swatch';

    const body = document.createElement('span');
    body.className = 'note-body';
    const name = document.createElement('span');
    name.className = 'note-name';
    name.textContent = `${midiToName(note.pitchMidi)} (${note.pitchMidi})`;
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = `${formatSeconds(note.startTimeSeconds)} 〜 ${formatSeconds(
      note.startTimeSeconds + note.durationSeconds,
    )} / 強さ ${Math.round(note.amplitude * 100)}%`;
    body.append(name, meta);

    row.append(swatch, body);
    $noteList.appendChild(row);
  }
}

/* ==========================================================
   書き出し / midi-studio への受け渡し
   ========================================================== */

function currentProject() {
  return notesToProject(notes, { name: sanitizeBaseName(sourceLabel) });
}

function downloadMidi() {
  if (!notes.length) return;
  const project = currentProject();
  const bytes = writeSmf(project);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildMidiFileName(sourceLabel);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`書き出し: ${anchor.download} (${bytes.length} バイト)`);
}

function openInStudio() {
  if (!notes.length) return;
  const project = currentProject();
  if (!canHandoff(project)) {
    setStatus('採譜結果が大きいため .mid を保存し、MIDI スタジオで開いてください');
    downloadMidi();
    return;
  }
  try {
    sessionStorage.setItem(MIDI_HANDOFF_KEY, serializeHandoff(project));
  } catch (err) {
    console.warn('handoff failed', err);
    downloadMidi();
    return;
  }
  window.location.href = '../midi-studio/index.html';
}

function clearAll() {
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
  $backendBadge.textContent = backend === 'WebGL' ? 'バックエンド: WebGL' : 'バックエンド: CPU (低速)';
  $backendBadge.classList.toggle('badge-warning', backend !== 'WebGL');
}

function updateModelBadge() {
  $modelBadge.textContent = `モデル: Basic Pitch (${formatBytes(estimateDownloadBytes())})`;
}

/* ==========================================================
   初期化 (UI)
   ========================================================== */

function updateParameterLabels() {
  $onsetValue.textContent = Number($onsetInput.value).toFixed(2);
  $frameValue.textContent = Number($frameInput.value).toFixed(2);
  $minlenValue.textContent = String(Number($minlenInput.value));
}

function updateConsentInfo() {
  $modelSize.textContent = formatBytes(estimateDownloadBytes());
  $modelLicense.textContent = '使用モデル: Spotify Basic Pitch / ライセンス: Apache-2.0';
}

function setupUi() {
  $onsetInput.value = String(DEFAULT_ONSET_THRESHOLD);
  $frameInput.value = String(DEFAULT_FRAME_THRESHOLD);
  $minlenInput.value = String(DEFAULT_MIN_NOTE_LEN);
  updateParameterLabels();
  updateConsentInfo();
  updateTranscribeEnabled();

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
  $onsetInput.addEventListener('input', updateParameterLabels);
  $frameInput.addEventListener('input', updateParameterLabels);
  $minlenInput.addEventListener('input', updateParameterLabels);

  $transcribeBtn.addEventListener('click', transcribe);
  $clearBtn.addEventListener('click', clearAll);
  $saveBtn.addEventListener('click', downloadMidi);
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
        if (key.includes('tfjs') || key.includes('basic-pitch') || key.includes('tensorflow')) {
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
    if (notes.length) renderRoll();
  });
}

setupUi();
