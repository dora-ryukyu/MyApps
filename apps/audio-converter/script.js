const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusCard = document.getElementById('status-card');
const fileList = document.getElementById('file-list');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressCount = document.getElementById('progress-count');
const statusBadge = document.getElementById('status-badge');
const actionContainer = document.getElementById('action-container');
const downloadBtn = document.getElementById('download-btn');
const downloadSizeSpan = document.getElementById('download-size');

let audioContext = null;
let currentZipBlob = null;

// Icons SVG
const icons = {
  pending: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  converting: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  done: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
};

// Drag and drop events
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
});

dropZone.addEventListener('drop', handleDrop, false);
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

async function handleDrop(e) {
  const dt = e.dataTransfer;
  const files = dt.files;
  await handleFiles(files);
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function handleFiles(files) {
  if (files.length === 0) return;
  
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  
  statusCard.style.display = 'block';
  actionContainer.style.display = 'none';
  fileList.innerHTML = '';
  statusBadge.className = 'status-badge processing';
  statusBadge.textContent = '展開中...';
  progressText.textContent = 'ファイルを読み込み中...';
  progressBar.style.width = '0%';
  currentZipBlob = null;
  
  let oggFiles = []; // { name: string, data: ArrayBuffer, path: string }
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.name.toLowerCase().endsWith('.zip')) {
      progressText.textContent = `ZIPを展開中: ${file.name}`;
      try {
        const zip = await JSZip.loadAsync(file);
        const entries = Object.keys(zip.files);
        for (const relativePath of entries) {
          const zipEntry = zip.files[relativePath];
          if (!zipEntry.dir && relativePath.toLowerCase().endsWith('.ogg')) {
            const data = await zipEntry.async('arraybuffer');
            oggFiles.push({
              name: relativePath.split('/').pop(),
              path: relativePath,
              data: data
            });
          }
        }
      } catch (err) {
        console.error('ZIP load error:', err);
        alert(`ZIPファイルの展開に失敗しました: ${file.name}`);
      }
    } else if (file.name.toLowerCase().endsWith('.ogg')) {
      const data = await file.arrayBuffer();
      oggFiles.push({
        name: file.name,
        path: file.name,
        data: data
      });
    }
  }
  
  if (oggFiles.length === 0) {
    statusBadge.className = 'status-badge';
    statusBadge.textContent = '待機中';
    progressText.textContent = 'OGGファイルが見つかりませんでした。';
    return;
  }
  
  await processFiles(oggFiles);
}

async function processFiles(files) {
  statusBadge.textContent = '変換中...';
  progressText.textContent = 'WAVに変換中...';
  
  // Create UI list
  files.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `file-item-${idx}`;
    
    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    // Adding zero-width space after slashes helps break words for long paths
    nameEl.innerHTML = '&lrm;' + f.path.replace(/\//g, '/<wbr>');
    nameEl.title = f.path;
    
    const statusEl = document.createElement('div');
    statusEl.className = 'file-status status-pending';
    statusEl.id = `file-status-${idx}`;
    statusEl.innerHTML = icons.pending;
    
    item.appendChild(nameEl);
    item.appendChild(statusEl);
    fileList.appendChild(item);
  });
  
  const outputZip = new JSZip();
  let successCount = 0;
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progressCount.textContent = `${i} / ${files.length}`;
    progressBar.style.width = `${((i) / files.length) * 100}%`;
    
    const statusEl = document.getElementById(`file-status-${i}`);
    statusEl.className = 'file-status status-converting';
    statusEl.innerHTML = icons.converting;
    
    // Auto scroll list
    const itemEl = document.getElementById(`file-item-${i}`);
    itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
    try {
      // Decode OGG
      const audioBuffer = await audioContext.decodeAudioData(file.data);
      // Encode WAV
      const wavBuffer = audioBufferToWav(audioBuffer);
      
      // Change extension in path
      const outPath = file.path.replace(/\.ogg$/i, '.wav');
      outputZip.file(outPath, wavBuffer);
      
      statusEl.className = 'file-status status-done';
      statusEl.innerHTML = icons.done;
      successCount++;
    } catch (err) {
      console.error('Error converting file', file.name, err);
      statusEl.className = 'file-status status-error';
      statusEl.innerHTML = icons.error;
      statusEl.title = err.message || '変換エラー';
    }
  }
  
  progressBar.style.width = '100%';
  progressCount.textContent = `${files.length} / ${files.length}`;
  
  if (successCount > 0) {
    statusBadge.textContent = 'ZIP圧縮中...';
    progressText.textContent = 'ダウンロード用のZIPを作成しています...';
    
    const blob = await outputZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    currentZipBlob = blob;
    
    statusBadge.className = 'status-badge success';
    statusBadge.textContent = '完了';
    progressText.textContent = `${successCount} 個のファイルの変換が完了しました。`;
    
    downloadSizeSpan.textContent = formatBytes(blob.size);
    actionContainer.style.display = 'flex';
    
    // Setup download button
    downloadBtn.onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `converted_wavs_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }, 100);
    };
  } else {
    statusBadge.className = 'status-badge';
    statusBadge.textContent = 'エラー';
    progressText.textContent = '変換に成功したファイルがありませんでした。';
  }
}

// WAV Encoder
function audioBufferToWav(buffer, opt) {
  opt = opt || {};
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = opt.float32 ? 3 : 1;
  const bitDepth = format === 3 ? 32 : 16;
  
  let result;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }
  
  return encodeWAV(result, format, sampleRate, numChannels, bitDepth);
}

function interleave(inputL, inputR) {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);
  let index = 0, inputIndex = 0;
  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function encodeWAV(samples, format, sampleRate, numChannels, bitDepth) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  
  if (format === 1) { // Raw PCM
    floatTo16BitPCM(view, 44, samples);
  } else {
    writeFloat32(view, 44, samples);
  }
  
  return buffer;
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function writeFloat32(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
