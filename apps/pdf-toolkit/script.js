/**
 * PDF Toolkit — メインスクリプト
 *
 * 完全ローカルで PDF 操作（結合・抽出・回転）を行う。
 * pdf-lib を使用し、サーバー通信なし。
 *
 * モード:
 *   1. Merge  — 複数 PDF をドラッグソートして結合 DL
 *   2. Extract — 1 PDF からページ範囲を指定して抽出
 *   3. Rotate  — 1 PDF の各ページを回転して保存
 */
(function () {
  'use strict';

  const { PDFDocument, degrees } = PDFLib;

  /* ============================================
     DOM 参照
     ============================================ */
  // タブ
  const $$tabs = document.querySelectorAll('.mode-tab');
  const $$panels = document.querySelectorAll('.mode-panel');

  // 結合
  const $mergeDrop     = document.getElementById('merge-drop');
  const $mergeInput    = document.getElementById('merge-file-input');
  const $mergeList     = document.getElementById('merge-list');
  const $mergeActions  = document.getElementById('merge-actions');
  const $mergeCount    = document.getElementById('merge-count');
  const $mergeClear    = document.getElementById('merge-clear');
  const $mergeDownload = document.getElementById('merge-download');
  const $mergeAddMore  = document.getElementById('merge-add-more');
  const $mergeSortNum  = document.getElementById('merge-sort-num');
  const $mergeReverse  = document.getElementById('merge-reverse');

  // 抽出
  const $extractDrop     = document.getElementById('extract-drop');
  const $extractInput    = document.getElementById('extract-file-input');
  const $extractControls = document.getElementById('extract-controls');
  const $extractFileInfo = document.getElementById('extract-file-info');
  const $extractPages    = document.getElementById('extract-pages');
  const $extractReset    = document.getElementById('extract-reset');
  const $extractDownload = document.getElementById('extract-download');

  // 回転
  const $rotateDrop     = document.getElementById('rotate-drop');
  const $rotateInput    = document.getElementById('rotate-file-input');
  const $rotateControls = document.getElementById('rotate-controls');
  const $rotateFileInfo = document.getElementById('rotate-file-info');
  const $rotateGrid     = document.getElementById('rotate-grid');
  const $rotateAllCw    = document.getElementById('rotate-all-cw');
  const $rotateReset    = document.getElementById('rotate-reset');
  const $rotateDownload = document.getElementById('rotate-download');

  // 共通
  const $toast = document.getElementById('toast');

  /* ============================================
     状態
     ============================================ */
  // Merge
  let mergeFiles = []; // { name, size, data: ArrayBuffer }

  // Extract
  let extractFile = null; // { name, size, data, pageCount }

  // Rotate
  let rotateFile = null;    // { name, size, data, pageCount }
  let rotations = [];       // 各ページの追加回転角度（0/90/180/270）

  /* ============================================
     ユーティリティ
     ============================================ */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function removeExt(name) {
    return name.replace(/\.pdf$/i, '');
  }

  /** "1,3,5-10" → [0,2,4,5,6,7,8,9] (0-indexed) */
  function parsePageRange(input, maxPage) {
    const pages = new Set();
    const parts = input.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        if (isNaN(a) || isNaN(b)) continue;
        const start = Math.max(1, Math.min(a, b));
        const end = Math.min(maxPage, Math.max(a, b));
        for (let i = start; i <= end; i++) pages.add(i - 1);
      } else {
        const n = Number(part);
        if (!isNaN(n) && n >= 1 && n <= maxPage) pages.add(n - 1);
      }
    }
    return [...pages].sort((a, b) => a - b);
  }

  /** ページ番号リストを人間可読なラベルに変換（1-indexed） */
  function pageLabel(indices) {
    if (!indices.length) return '';
    const nums = indices.map(i => i + 1);
    const ranges = [];
    let start = nums[0], end = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === end + 1) {
        end = nums[i];
      } else {
        ranges.push(start === end ? `${start}` : `${start}-${end}`);
        start = end = nums[i];
      }
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges.join(',');
  }

  /* ============================================
     トースト
     ============================================ */
  let toastTimer = null;
  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2500);
  }

  /* ============================================
     処理中オーバーレイ
     ============================================ */
  function showProcessing() {
    const overlay = document.createElement('div');
    overlay.className = 'processing-overlay';
    overlay.id = 'processing-overlay';
    overlay.innerHTML = '<div class="processing-spinner"></div>';
    document.body.appendChild(overlay);
  }

  function hideProcessing() {
    document.getElementById('processing-overlay')?.remove();
  }

  /* ============================================
     ダウンロードヘルパー
     ============================================ */
  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ============================================
     タブ切替
     ============================================ */
  $$tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      $$tabs.forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      $$panels.forEach(p => {
        const isTarget = p.id === `panel-${mode}`;
        p.classList.toggle('active', isTarget);
        p.hidden = !isTarget;
      });
    });
  });

  /* ============================================
     ドラッグ＆ドロップ共通
     ============================================ */
  function setupDropZone(dropEl, inputEl, handler, multiple = false) {
    // ドラッグイベント
    ['dragenter', 'dragover'].forEach(evt => {
      dropEl.addEventListener(evt, e => {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(evt => {
      dropEl.addEventListener(evt, e => {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.remove('drag-over');
      });
    });

    dropEl.addEventListener('drop', e => {
      const files = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) handler(files);
    });

    // クリック → ファイル選択（.btn-file ボタン or ドロップゾーン全体）
    dropEl.addEventListener('click', e => {
      // .btn-file ボタンがクリックされた場合、ボタン自体で処理
      if (!e.target.closest('.btn-file')) {
        inputEl.click();
      }
    });

    // .btn-file ボタンのクリック（イベントバブリングを止めて1回だけ発火）
    dropEl.querySelectorAll('.btn-file').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        inputEl.click();
      });
    });

    inputEl.addEventListener('change', () => {
      const files = [...inputEl.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) handler(files);
      inputEl.value = '';
    });
  }

  /* ============================================
     ============================================
     結合 (Merge) モード
     ============================================
     ============================================ */

  async function addMergeFiles(files) {
    for (const file of files) {
      const data = await file.arrayBuffer();
      // ページ数を取得
      let pageCount = '?';
      try {
        const doc = await PDFDocument.load(data, { ignoreEncryption: true });
        pageCount = doc.getPageCount();
      } catch { /* ignore */ }
      mergeFiles.push({ name: file.name, size: file.size, data, pageCount });
    }
    renderMergeList();
    showToast(`📄 ${files.length} ファイルを追加しました`);
  }

  function renderMergeList() {
    $mergeList.innerHTML = '';

    if (!mergeFiles.length) {
      $mergeActions.style.display = 'none';
      $mergeDrop.style.display = '';
      return;
    }

    $mergeActions.style.display = '';
    $mergeDrop.style.display = 'none';
    $mergeCount.textContent = `${mergeFiles.length} ファイル`;

    mergeFiles.forEach((f, i) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      card.draggable = true;
      card.dataset.index = i;
      card.setAttribute('role', 'listitem');
      card.style.animationDelay = `${i * 40}ms`;

      card.innerHTML = `
        <div class="file-card-grip" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="file-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
            <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
          </svg>
        </div>
        <div class="file-card-info">
          <div class="file-card-name">${escHtml(f.name)}</div>
          <div class="file-card-meta">${formatSize(f.size)} · ${f.pageCount} ページ</div>
        </div>
        <div class="file-card-order">${i + 1}</div>
        <button class="file-card-remove" type="button" aria-label="${escHtml(f.name)} を削除" data-index="${i}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
          </svg>
        </button>
      `;

      // ドラッグ & ドロップソート
      card.addEventListener('dragstart', e => {
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.file-card.drag-target').forEach(c => c.classList.remove('drag-target'));
      });

      card.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-target');
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-target');
      });

      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-target');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toIdx = parseInt(card.dataset.index, 10);
        if (fromIdx !== toIdx && !isNaN(fromIdx) && !isNaN(toIdx)) {
          const [moved] = mergeFiles.splice(fromIdx, 1);
          mergeFiles.splice(toIdx, 0, moved);
          renderMergeList();
        }
      });

      // 削除
      card.querySelector('.file-card-remove').addEventListener('click', e => {
        e.stopPropagation();
        mergeFiles.splice(i, 1);
        renderMergeList();
      });

      $mergeList.appendChild(card);
    });
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ファイル追加ボタン(ドロップゾーン非表示時)
  $mergeActions.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) addMergeFiles(files);
  });
  $mergeActions.addEventListener('dragover', e => e.preventDefault());

  // リストへのドロップでもファイル追加
  $mergeList.addEventListener('drop', e => {
    // ファイルカードでなくリスト本体へのドロップの場合のみ
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      const files = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) addMergeFiles(files);
    }
  });
  $mergeList.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });

  /**
   * 自然順ソート比較関数
   * ファイル名中の数字部分を数値として比較する
   * 例: file2.pdf < file10.pdf
   */
  function naturalCompare(a, b) {
    const ax = a.name.match(/(\d+|\D+)/g) || [];
    const bx = b.name.match(/(\d+|\D+)/g) || [];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      if (i >= ax.length) return -1;
      if (i >= bx.length) return 1;
      const an = ax[i], bn = bx[i];
      const aIsNum = /^\d+$/.test(an), bIsNum = /^\d+$/.test(bn);
      if (aIsNum && bIsNum) {
        const diff = parseInt(an, 10) - parseInt(bn, 10);
        if (diff !== 0) return diff;
      } else {
        const cmp = an.localeCompare(bn, 'ja', { sensitivity: 'base' });
        if (cmp !== 0) return cmp;
      }
    }
    return 0;
  }

  // 数字順ソート
  $mergeSortNum.addEventListener('click', () => {
    mergeFiles.sort(naturalCompare);
    renderMergeList();
    showToast('🔢 ファイル名の数字順にソートしました');
  });

  // 逆順
  $mergeReverse.addEventListener('click', () => {
    mergeFiles.reverse();
    renderMergeList();
    showToast('🔄 順番を逆転しました');
  });

  // ファイル追加
  $mergeAddMore.addEventListener('click', () => {
    $mergeInput.click();
  });

  // 結合ダウンロード
  $mergeDownload.addEventListener('click', async () => {
    if (mergeFiles.length < 2) {
      showToast('⚠ 2つ以上のファイルが必要です');
      return;
    }
    showProcessing();
    try {
      const merged = await PDFDocument.create();
      for (const f of mergeFiles) {
        const src = await PDFDocument.load(f.data, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      }
      const bytes = await merged.save();
      // ファイル名: 元ファイル名を結合 + _merged
      const basenames = mergeFiles.map(f => removeExt(f.name));
      let filename;
      if (basenames.length <= 3) {
        filename = basenames.join('_') + '_merged.pdf';
      } else {
        // ファイルが多い場合は先頭と末尾のみ
        filename = basenames[0] + '_..._' + basenames[basenames.length - 1] + '_merged.pdf';
      }
      downloadBytes(bytes, filename);
      showToast(`✅ ${filename} をダウンロードしました`);
    } catch (err) {
      console.error(err);
      showToast('⚠ 結合に失敗しました: ' + err.message);
    } finally {
      hideProcessing();
    }
  });

  // クリア
  $mergeClear.addEventListener('click', () => {
    mergeFiles = [];
    renderMergeList();
  });

  setupDropZone($mergeDrop, $mergeInput, addMergeFiles, true);

  /* ============================================
     ============================================
     抽出 (Extract) モード
     ============================================
     ============================================ */

  async function loadExtractFile(files) {
    const file = files[0];
    try {
      const data = await file.arrayBuffer();
      const doc = await PDFDocument.load(data, { ignoreEncryption: true });
      extractFile = {
        name: file.name,
        size: file.size,
        data,
        pageCount: doc.getPageCount(),
      };

      $extractDrop.style.display = 'none';
      $extractControls.style.display = '';
      $extractFileInfo.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
          <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
        </svg>
        ${escHtml(file.name)} (${formatSize(file.size)} · ${extractFile.pageCount} ページ)
      `;
      $extractPages.value = '';
      $extractPages.placeholder = `例: 1, 3, 5-${extractFile.pageCount}`;
      $extractPages.focus();
      showToast(`📄 ${file.name} を読み込みました`);
    } catch (err) {
      console.error(err);
      showToast('⚠ PDF の読み込みに失敗しました');
    }
  }

  // 抽出ダウンロード
  $extractDownload.addEventListener('click', async () => {
    if (!extractFile) return;
    const input = $extractPages.value.trim();
    if (!input) {
      showToast('⚠ ページ範囲を入力してください');
      $extractPages.focus();
      return;
    }

    const indices = parsePageRange(input, extractFile.pageCount);
    if (!indices.length) {
      showToast('⚠ 有効なページ範囲を指定してください');
      return;
    }

    showProcessing();
    try {
      const src = await PDFDocument.load(extractFile.data, { ignoreEncryption: true });
      const newDoc = await PDFDocument.create();
      const pages = await newDoc.copyPages(src, indices);
      pages.forEach(p => newDoc.addPage(p));
      const bytes = await newDoc.save();
      const label = pageLabel(indices);
      const filename = `${removeExt(extractFile.name)}_p${label}.pdf`;
      downloadBytes(bytes, filename);
      showToast(`✅ ${filename} をダウンロードしました`);
    } catch (err) {
      console.error(err);
      showToast('⚠ 抽出に失敗しました: ' + err.message);
    } finally {
      hideProcessing();
    }
  });

  // リセット
  $extractReset.addEventListener('click', () => {
    extractFile = null;
    $extractDrop.style.display = '';
    $extractControls.style.display = 'none';
  });

  setupDropZone($extractDrop, $extractInput, loadExtractFile, false);

  /* ============================================
     ============================================
     回転 (Rotate) モード
     ============================================
     ============================================ */

  async function loadRotateFile(files) {
    const file = files[0];
    try {
      const data = await file.arrayBuffer();
      const doc = await PDFDocument.load(data, { ignoreEncryption: true });
      const pageCount = doc.getPageCount();
      rotateFile = { name: file.name, size: file.size, data, pageCount };
      rotations = new Array(pageCount).fill(0);

      $rotateDrop.style.display = 'none';
      $rotateControls.style.display = '';
      $rotateFileInfo.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
          <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
        </svg>
        ${escHtml(file.name)} (${formatSize(file.size)} · ${pageCount} ページ)
      `;
      renderRotateGrid();
      showToast(`📄 ${file.name} を読み込みました`);
    } catch (err) {
      console.error(err);
      showToast('⚠ PDF の読み込みに失敗しました');
    }
  }

  function renderRotateGrid() {
    $rotateGrid.innerHTML = '';

    for (let i = 0; i < rotations.length; i++) {
      const card = document.createElement('button');
      card.className = 'page-card' + (rotations[i] !== 0 ? ' rotated' : '');
      card.type = 'button';
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', `ページ ${i + 1} をクリックで90°回転`);

      const angle = rotations[i];
      card.innerHTML = `
        <div class="page-card-preview" style="transform: rotate(${angle}deg)">
          ${i + 1}
        </div>
        <div class="page-card-label">
          <span>p.${i + 1}</span>
        </div>
        <div class="page-card-rotation">${angle === 0 ? '0°' : `+${angle}°`}</div>
      `;

      card.addEventListener('click', () => {
        rotations[i] = (rotations[i] + 90) % 360;
        renderRotateGrid();
      });

      $rotateGrid.appendChild(card);
    }
  }

  // 全ページ回転
  $rotateAllCw.addEventListener('click', () => {
    rotations = rotations.map(r => (r + 90) % 360);
    renderRotateGrid();
    showToast('🔄 全ページを +90° 回転しました');
  });

  // 回転ダウンロード
  $rotateDownload.addEventListener('click', async () => {
    if (!rotateFile) return;

    // 回転変更がなければ警告
    if (rotations.every(r => r === 0)) {
      showToast('⚠ 回転が適用されていません');
      return;
    }

    showProcessing();
    try {
      const doc = await PDFDocument.load(rotateFile.data, { ignoreEncryption: true });
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        if (rotations[i] !== 0) {
          const current = page.getRotation().angle;
          page.setRotation(degrees(current + rotations[i]));
        }
      });
      const bytes = await doc.save();
      const filename = `${removeExt(rotateFile.name)}_rotated.pdf`;
      downloadBytes(bytes, filename);
      showToast(`✅ ${filename} をダウンロードしました`);
    } catch (err) {
      console.error(err);
      showToast('⚠ 回転の保存に失敗しました: ' + err.message);
    } finally {
      hideProcessing();
    }
  });

  // リセット
  $rotateReset.addEventListener('click', () => {
    rotateFile = null;
    rotations = [];
    $rotateDrop.style.display = '';
    $rotateControls.style.display = 'none';
  });

  setupDropZone($rotateDrop, $rotateInput, loadRotateFile, false);

})();
