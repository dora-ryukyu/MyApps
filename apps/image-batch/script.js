/**
 * script.js — 画像一括変換の UI
 *
 * 一覧の管理・設定の読み取り・Worker への処理依頼・結果の ZIP 化を担当する。
 * 画像のデコード・加工・エンコードは worker.js (OffscreenCanvas) が行い、
 * メインスレッドは止まらない。
 */

import {
  MAX_FILES,
  formatBytes,
  formatFromName,
  mimeFromName,
  extensionFor,
  stripExtension,
  buildJobPlan,
  clampQuality,
  summarizeResults,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  editorSection: $('editor-section'),
  clearBtn: $('clear-btn'),
  fileList: $('file-list'),
  fileCount: $('file-count'),
  resizeMode: $('resize-mode'),
  resizeValue: $('resize-value'),
  resizeHint: $('resize-hint'),
  formatSelect: $('format-select'),
  qualityRange: $('quality-range'),
  qualityValue: $('quality-value'),
  watermarkCheck: $('watermark-check'),
  watermarkFields: $('watermark-fields'),
  watermarkText: $('watermark-text'),
  watermarkImage: $('watermark-image'),
  watermarkPosition: $('watermark-position'),
  watermarkScale: $('watermark-scale'),
  watermarkScaleValue: $('watermark-scale-value'),
  watermarkOpacity: $('watermark-opacity'),
  watermarkOpacityValue: $('watermark-opacity-value'),
  watermarkRotation: $('watermark-rotation'),
  watermarkRotationValue: $('watermark-rotation-value'),
  stripMetadataCheck: $('strip-metadata-check'),
  renameMode: $('rename-mode'),
  renamePrefix: $('rename-prefix'),
  renameStart: $('rename-start'),
  renamePad: $('rename-pad'),
  processBtn: $('process-btn'),
  cancelBtn: $('cancel-btn'),
  progressWrap: $('progress-wrap'),
  progressBar: $('progress-bar'),
  progressLabel: $('progress-label'),
  resultSection: $('result-section'),
  resultSummary: $('result-summary'),
  downloadBtn: $('download-btn'),
  resultNote: $('result-note'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
};

const state = {
  entries: [],
  watermarkFile: null,
  worker: null,
  processing: false,
  cancelled: false,
  firstBlob: null,
  zip: null,
  usedNames: new Set(),
};

/* ==========================================================
   ヘルパー
   ========================================================== */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function hideError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return Boolean(formatFromName(file.name));
}

function withExtension(name, format) {
  const base = stripExtension(name) || 'image';
  return `${base}${extensionFor(format)}`;
}

function assignName(name, used) {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  let candidate;
  do {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  } while (used.has(candidate.toLowerCase()));
  used.add(candidate.toLowerCase());
  return candidate;
}

/* ==========================================================
   一覧
   ========================================================== */

function renderList() {
  els.fileList.replaceChildren();
  for (const entry of state.entries) {
    const item = document.createElement('li');
    item.className = 'file-card';
    item.dataset.id = entry.id;

    const thumb = document.createElement('div');
    thumb.className = 'file-thumb';
    const img = document.createElement('img');
    img.src = entry.url;
    img.alt = entry.name;
    img.loading = 'lazy';
    thumb.appendChild(img);

    const name = document.createElement('div');
    name.className = 'file-card-name';
    name.textContent = entry.name;
    name.title = entry.name;

    const meta = document.createElement('div');
    meta.className = 'file-card-meta';
    meta.textContent = entry.width
      ? `${entry.width}×${entry.height}・${formatBytes(entry.file.size)}`
      : formatBytes(entry.file.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.setAttribute('aria-label', `${entry.name} を削除`);
    remove.textContent = '×';

    item.appendChild(thumb);
    item.appendChild(name);
    item.appendChild(meta);
    item.appendChild(remove);
    els.fileList.appendChild(item);
  }

  els.fileCount.textContent = String(state.entries.length);
  els.editorSection.hidden = state.entries.length === 0;
}

function updateCard(id, status, message) {
  const card = els.fileList.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
  if (!card) return;
  card.classList.toggle('is-processing', status === 'processing');
  card.classList.toggle('is-done', status === 'done');
  card.classList.toggle('is-error', status === 'error');
  if (status === 'error' && message) card.title = message;
}

async function addFiles(fileList) {
  const files = [...fileList].filter(isImageFile);
  if (!files.length) {
    showError('対応している画像ファイルが見つかりませんでした。');
    return;
  }
  if (state.entries.length + files.length > MAX_FILES) {
    showError(`一度に処理できるのは ${MAX_FILES} 枚までです。`);
    return;
  }
  hideError();

  for (const file of files) {
    let width = 0;
    let height = 0;
    try {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      if (typeof bitmap.close === 'function') bitmap.close();
    } catch {
      width = 0;
      height = 0;
    }
    state.entries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      name: file.name,
      width,
      height,
      url: URL.createObjectURL(file),
    });
  }
  renderList();
}

function clearAll() {
  for (const entry of state.entries) URL.revokeObjectURL(entry.url);
  state.entries = [];
  state.watermarkFile = null;
  state.firstBlob = null;
  state.zip = null;
  els.watermarkImage.value = '';
  els.resultSection.hidden = true;
  els.progressWrap.hidden = true;
  els.errorBox.hidden = true;
  renderList();
}

/* ==========================================================
   設定
   ========================================================== */

function readSettings() {
  return {
    resize: {
      mode: els.resizeMode.value,
      value: Number(els.resizeValue.value),
    },
    format: els.formatSelect.value,
    quality: clampQuality(Number(els.qualityRange.value) / 100),
    watermark: {
      enabled: els.watermarkCheck.checked,
      mode: state.watermarkFile ? 'image' : 'text',
      text: els.watermarkText.value,
      position: els.watermarkPosition.value,
      scalePercent: Number(els.watermarkScale.value),
      opacity: Number(els.watermarkOpacity.value),
      rotation: Number(els.watermarkRotation.value),
      color: '#ffffff',
    },
    rename: {
      mode: els.renameMode.value,
      prefix: els.renamePrefix.value,
      start: Number(els.renameStart.value),
      pad: Number(els.renamePad.value),
    },
    stripMetadata: els.stripMetadataCheck.checked,
  };
}

function updateResizeUI() {
  const mode = els.resizeMode.value;
  const labels = {
    none: 'サイズ変更なし',
    long: '長辺 (px)',
    short: '短辺 (px)',
    percent: '拡大率 (%)',
  };
  const label = els.resizeValue.closest('.field').querySelector('span');
  if (label) label.textContent = labels[mode] || 'サイズ';
  els.resizeValue.disabled = mode === 'none';
  els.resizeHint.textContent =
    mode === 'none'
      ? 'サイズは変更しません。'
      : mode === 'percent'
        ? '100% 未満で縮小、100% 超で拡大します。'
        : '指定より小さい画像は拡大しません。';
}

function updateQualityUI() {
  els.qualityValue.textContent = els.qualityRange.value;
  const format = els.formatSelect.value;
  const lossy = format === 'jpeg' || format === 'webp' || format === 'avif';
  els.qualityRange.disabled = !lossy;
}

function setControlsDisabled(disabled) {
  for (const el of [
    els.dropZone,
    els.clearBtn,
    els.resizeMode,
    els.formatSelect,
    els.watermarkCheck,
    els.renameMode,
    els.processBtn,
  ]) {
    if (el) el.toggleAttribute('inert', disabled);
  }
  els.processBtn.disabled = disabled;
  els.cancelBtn.hidden = !disabled;
}

/* ==========================================================
   処理
   ========================================================== */

function updateProgress(done, total, label) {
  const percent = total > 0 ? (done / total) * 100 : 0;
  els.progressBar.style.width = `${percent}%`;
  els.progressLabel.textContent = `${label} (${done} / ${total})`;
}

function sendJob(worker, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = event.data;
      if (!message || (message.type !== 'done' && message.type !== 'error')) return;
      if (message.id !== payload.id) return;
      worker.removeEventListener('message', onMessage);
      if (message.type === 'error') reject(new Error(message.message));
      else resolve(message);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(payload, [payload.buffer]);
  });
}

async function prepareWatermark(worker, settings) {
  if (!settings.watermark.enabled || !state.watermarkFile) return;
  const buffer = await state.watermarkFile.arrayBuffer();
  try {
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'watermark-ready') {
          worker.removeEventListener('message', onMessage);
          resolve();
        } else if (message.type === 'watermark-error') {
          worker.removeEventListener('message', onMessage);
          reject(new Error(message.message));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage(
        { type: 'watermark', buffer, mime: state.watermarkFile.type || 'image/png' },
        [buffer],
      );
    });
  } catch {
    // 透かし画像を読めなかった場合はテキスト透かしにフォールバック
    settings.watermark.mode = 'text';
  }
}

async function runProcess() {
  if (state.processing || state.entries.length === 0) return;

  const settings = readSettings();
  if (settings.watermark.enabled && settings.watermark.mode === 'image') {
    // prepareWatermark 内で失敗したらテキストへ切り替わる
  }

  const plan = buildJobPlan(state.entries, settings);
  const entryById = new Map(state.entries.map((entry) => [entry.id, entry]));

  state.processing = true;
  state.cancelled = false;
  state.firstBlob = null;
  state.zip = null;
  state.usedNames = new Set();
  setControlsDisabled(true);
  hideError();
  els.resultSection.hidden = true;
  els.progressWrap.hidden = false;
  els.progressBar.style.width = '0%';
  els.progressLabel.textContent = '準備中…';

  const zipLib = window.JSZip;
  if (plan.length > 1 && !zipLib) {
    state.processing = false;
    setControlsDisabled(false);
    els.progressWrap.hidden = true;
    showError('JSZip の読み込みに失敗しました。ネットワークを確認して再読み込みしてください。');
    return;
  }
  state.zip = zipLib ? new zipLib() : null;

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  state.worker = worker;

  await prepareWatermark(worker, settings);

  const results = [];
  try {
    for (let i = 0; i < plan.length; i += 1) {
      if (state.cancelled) break;
      const job = plan[i];
      const entry = entryById.get(job.id);
      updateCard(job.id, 'processing');
      updateProgress(i, plan.length, `処理中: ${job.sourceName}`);

      try {
        const buffer = await entry.file.arrayBuffer();
        const sourceMime =
          entry.file.type || mimeFromName(job.sourceName) || 'application/octet-stream';
        const response = await sendJob(worker, {
          type: 'job',
          id: job.id,
          buffer,
          sourceMime,
          sourceName: job.sourceName,
          targetFormat: job.targetFormat,
          width: job.width,
          height: job.height,
          quality: settings.quality,
          passthrough: job.passthrough,
          stripMetadata: job.stripMetadata,
          watermark: settings.watermark.enabled ? settings.watermark : null,
        });

        const format = response.format || job.targetFormat;
        const name = assignName(withExtension(job.outputName, format), state.usedNames);
        entry.blob = new Blob([response.buffer], { type: response.mime });
        if (state.zip) state.zip.file(name, response.buffer);
        if (!state.firstBlob) state.firstBlob = { name, blob: entry.blob };
        results.push({
          blob: entry.blob,
          name,
          inputBytes: entry.file.size,
          outputBytes: response.buffer.byteLength,
        });
        updateCard(job.id, 'done');
      } catch (error) {
        results.push({
          error: error && error.message ? error.message : String(error),
          name: job.outputName,
          inputBytes: entry.file.size,
          outputBytes: 0,
        });
        updateCard(job.id, 'error', error && error.message);
      }
      updateProgress(i + 1, plan.length, `処理中: ${job.sourceName}`);
    }
  } finally {
    worker.terminate();
    state.worker = null;
    state.processing = false;
    setControlsDisabled(false);
  }

  await finish(results);
}

async function finish(results) {
  const ok = results.filter((result) => result.blob);
  const failed = results.filter((result) => result.error);

  if (state.cancelled) {
    els.progressLabel.textContent = `${ok.length} 枚まで処理しました（キャンセル）。`;
  }

  if (!ok.length) {
    els.progressLabel.textContent = '処理できた画像がありませんでした。';
    showError('処理できた画像がありませんでした。設定を見直してください。');
    return;
  }

  const summary = summarizeResults(
    results.map((result) => ({
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      skipped: Boolean(result.error),
    })),
  );
  const savedPercent = summary.inputBytes > 0
    ? Math.round((1 - summary.ratio) * 100)
    : 0;

  const lines = [
    `完了: ${summary.done} / ${summary.count} 枚`,
    `サイズ: ${formatBytes(summary.inputBytes)} → ${formatBytes(summary.outputBytes)}` +
      (summary.savedBytes >= 0 ? ` (-${savedPercent}%)` : ` (+${Math.abs(savedPercent)}%)`),
  ];
  if (failed.length) lines.push(`失敗: ${failed.length} 枚`);

  if (ok.length === 1 && failed.length === 0) {
    const single = ok[0];
    els.downloadBtn.querySelector('span').textContent = '画像をダウンロード';
    els.downloadBtn.onclick = () => triggerDownload(single.blob, single.name);
    els.resultNote.textContent = `${single.name} を保存します。`;
  } else {
    els.progressLabel.textContent = 'ZIP を作成しています…';
    const blob = await state.zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const zipName = `image-batch-${new Date().toISOString().slice(0, 10)}.zip`;
    els.downloadBtn.querySelector('span').textContent = 'ZIP でダウンロード';
    els.downloadBtn.onclick = () => triggerDownload(blob, zipName);
    els.resultNote.textContent = `${ok.length} 枚を ZIP にまとめました。`;
  }

  els.resultSummary.textContent = lines.join('\n');
  els.resultSection.hidden = false;
  els.progressWrap.hidden = true;
  els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cancelProcessing() {
  if (!state.processing) return;
  state.cancelled = true;
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  els.progressLabel.textContent = 'キャンセルしました。';
}

/* ==========================================================
   イベント
   ========================================================== */

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
});

['dragenter', 'dragover'].forEach((name) => {
  els.dropZone.addEventListener(name, () => els.dropZone.classList.add('is-dragover'));
});

['dragleave', 'drop'].forEach((name) => {
  els.dropZone.addEventListener(name, () => els.dropZone.classList.remove('is-dragover'));
});

els.dropZone.addEventListener('drop', (event) => {
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files) addFiles(files);
});

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});

els.fileList.addEventListener('click', (event) => {
  const button = event.target.closest('.file-remove');
  if (!button) return;
  const card = button.closest('.file-card');
  const id = card && card.dataset.id;
  const index = state.entries.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    URL.revokeObjectURL(state.entries[index].url);
    state.entries.splice(index, 1);
    renderList();
  }
});

els.clearBtn.addEventListener('click', clearAll);
els.processBtn.addEventListener('click', runProcess);
els.cancelBtn.addEventListener('click', cancelProcessing);

els.resizeMode.addEventListener('change', updateResizeUI);
els.formatSelect.addEventListener('change', updateQualityUI);
els.qualityRange.addEventListener('input', updateQualityUI);

els.watermarkCheck.addEventListener('change', () => {
  els.watermarkFields.hidden = !els.watermarkCheck.checked;
});

els.watermarkImage.addEventListener('change', (event) => {
  state.watermarkFile = event.target.files && event.target.files[0] ? event.target.files[0] : null;
});

els.watermarkScale.addEventListener('input', () => {
  els.watermarkScaleValue.textContent = els.watermarkScale.value;
});
els.watermarkOpacity.addEventListener('input', () => {
  els.watermarkOpacityValue.textContent = els.watermarkOpacity.value;
});
els.watermarkRotation.addEventListener('input', () => {
  els.watermarkRotationValue.textContent = `${els.watermarkRotation.value}°`;
});

els.infoBtn.addEventListener('click', () => {
  els.infoModal.style.display = 'flex';
});
els.closeInfoBtn.addEventListener('click', () => {
  els.infoModal.style.display = 'none';
});
els.infoModal.addEventListener('click', (event) => {
  if (event.target === els.infoModal) els.infoModal.style.display = 'none';
});

updateResizeUI();
updateQualityUI();
renderList();
