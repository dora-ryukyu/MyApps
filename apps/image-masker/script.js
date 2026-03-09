/**
 * 機密画像マスキング — Core Script
 *
 * 機能:
 *   - クリップボード / ドロップ / ファイル選択で画像読込
 *   - 黒塗り / モザイク / ぼかし 3モード
 *   - マウスドラッグで矩形範囲選択 → 即座加工
 *   - Undo / Redo (ImageData スナップショット)
 *   - 加工済み画像をクリップボードにコピー / ファイル保存
 */
(function () {
  'use strict';

  /* ========== DOM ========== */
  const $ = (id) => document.getElementById(id);
  const container   = $('canvas-container');
  const mainCanvas  = $('main-canvas');
  const overlay     = $('overlay-canvas');
  const placeholder = $('canvas-placeholder');
  const fileInput   = $('file-input');
  const btnUndo     = $('btn-undo');
  const btnRedo     = $('btn-redo');
  const btnClear    = $('btn-clear');
  const btnCopy     = $('btn-copy');
  const btnSave     = $('btn-save');
  const toast       = $('toast');

  const mainCtx    = mainCanvas.getContext('2d');
  const overlayCtx = overlay.getContext('2d');

  /* ========== State ========== */
  let currentMode = 'blackout'; // 'blackout' | 'mosaic' | 'blur'
  let hasImage = false;
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };

  // Undo / Redo
  const MAX_HISTORY = 50;
  let history = [];
  let historyIndex = -1;

  /* ========== Mode Selection ========== */
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      currentMode = btn.dataset.mode;
    });
  });

  /* ========== Image Loading ========== */

  /** 画像を Canvas に描画 */
  function loadImage(img) {
    mainCanvas.width = img.naturalWidth;
    mainCanvas.height = img.naturalHeight;
    mainCtx.drawImage(img, 0, 0);

    // overlay を同サイズで配置
    syncOverlay();

    hasImage = true;
    container.classList.add('has-image');
    btnCopy.disabled = false;
    btnSave.disabled = false;

    // 初期状態を history に保存
    history = [mainCtx.getImageData(0, 0, mainCanvas.width, mainCanvas.height)];
    historyIndex = 0;
    updateUndoRedo();
  }

  /** overlay のサイズ・位置をmainCanvasに合わせる */
  function syncOverlay() {
    const rect = mainCanvas.getBoundingClientRect();
    overlay.width = mainCanvas.width;
    overlay.height = mainCanvas.height;
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.left = (mainCanvas.offsetLeft) + 'px';
    overlay.style.top = (mainCanvas.offsetTop) + 'px';
  }

  /** blob/file → Image */
  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
    });
  }

  // Ctrl+V — クリップボード
  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        try {
          const blob = item.getAsFile();
          const img = await blobToImage(blob);
          loadImage(img);
          showToast('画像を読み込みました');
        } catch (err) {
          showToast('画像の読み込みに失敗しました');
        }
        return;
      }
    }
  });

  // ドラッグ＆ドロップ
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        const img = await blobToImage(file);
        loadImage(img);
        showToast('画像を読み込みました');
      } catch {
        showToast('画像の読み込みに失敗しました');
      }
    }
  });

  // ファイル選択
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        const img = await blobToImage(file);
        loadImage(img);
        showToast('画像を読み込みました');
      } catch {
        showToast('画像の読み込みに失敗しました');
      }
    }
    fileInput.value = '';
  });

  /* ========== Rectangle Selection & Masking ========== */

  /** Canvas座標に変換 */
  function canvasCoords(e) {
    const rect = overlay.getBoundingClientRect();
    const scaleX = mainCanvas.width / rect.width;
    const scaleY = mainCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  overlay.addEventListener('mousedown', (e) => {
    if (!hasImage || e.button !== 0) return;
    isDragging = true;
    dragStart = canvasCoords(e);
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const cur = canvasCoords(e);
    drawSelectionRect(dragStart, cur);
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    const end = canvasCoords(e);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    const rect = normalizeRect(dragStart, end);
    if (rect.w > 2 && rect.h > 2) {
      applyMask(rect);
      pushHistory();
    }
  });

  // ウィンドウ外でマウスを離した場合
  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    }
  });

  // タッチ対応
  overlay.addEventListener('touchstart', (e) => {
    if (!hasImage) return;
    e.preventDefault();
    const touch = e.touches[0];
    isDragging = true;
    dragStart = canvasCoords(touch);
  }, { passive: false });

  overlay.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    drawSelectionRect(dragStart, canvasCoords(touch));
  }, { passive: false });

  overlay.addEventListener('touchend', (e) => {
    if (!isDragging) return;
    isDragging = false;
    const touch = e.changedTouches[0];
    const end = canvasCoords(touch);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    const rect = normalizeRect(dragStart, end);
    if (rect.w > 2 && rect.h > 2) {
      applyMask(rect);
      pushHistory();
    }
  });

  /** 選択矩形を overlay に描画 */
  function drawSelectionRect(start, end) {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    const r = normalizeRect(start, end);

    // 半透明オーバーレイ
    overlayCtx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    overlayCtx.fillRect(r.x, r.y, r.w, r.h);

    // ボーダー
    overlayCtx.strokeStyle = '#ef4444';
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([6, 3]);
    overlayCtx.strokeRect(r.x, r.y, r.w, r.h);
    overlayCtx.setLineDash([]);
  }

  /** 2点から正規化された矩形 */
  function normalizeRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(Math.abs(b.x - a.x)),
      h: Math.round(Math.abs(b.y - a.y)),
    };
  }

  /* ========== Masking Algorithms ========== */

  function applyMask(rect) {
    switch (currentMode) {
      case 'blackout':
        applyBlackout(rect);
        break;
      case 'mosaic':
        applyMosaic(rect);
        break;
      case 'blur':
        applyBlur(rect);
        break;
    }
  }

  /** 黒塗り */
  function applyBlackout(rect) {
    mainCtx.fillStyle = '#000000';
    mainCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  /** モザイク */
  function applyMosaic(rect) {
    const blockSize = Math.max(8, Math.round(Math.min(rect.w, rect.h) / 12));
    const imageData = mainCtx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const data = imageData.data;

    for (let by = 0; by < rect.h; by += blockSize) {
      for (let bx = 0; bx < rect.w; bx += blockSize) {
        // ブロック内の平均色を計算
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        const bw = Math.min(blockSize, rect.w - bx);
        const bh = Math.min(blockSize, rect.h - by);

        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const idx = ((by + py) * rect.w + (bx + px)) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            a += data[idx + 3];
            count++;
          }
        }

        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        a = Math.round(a / count);

        // ブロック全体を平均色で塗る
        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const idx = ((by + py) * rect.w + (bx + px)) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = a;
          }
        }
      }
    }

    mainCtx.putImageData(imageData, rect.x, rect.y);
  }

  /** ぼかし（Canvas filter を使用） */
  function applyBlur(rect) {
    // 対象範囲を一時キャンバスに切り出してぼかす
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = rect.w;
    tempCanvas.height = rect.h;
    const tempCtx = tempCanvas.getContext('2d');

    // 元のピクセルをコピー
    tempCtx.drawImage(
      mainCanvas,
      rect.x, rect.y, rect.w, rect.h,
      0, 0, rect.w, rect.h
    );

    // ぼかしを適用して描き戻す
    mainCtx.save();
    mainCtx.beginPath();
    mainCtx.rect(rect.x, rect.y, rect.w, rect.h);
    mainCtx.clip();
    mainCtx.filter = 'blur(12px)';
    // 少しはみ出して描画することでエッジのアーティファクトを軽減
    mainCtx.drawImage(
      tempCanvas,
      0, 0, rect.w, rect.h,
      rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8
    );
    mainCtx.restore();
    mainCtx.filter = 'none';
  }

  /* ========== Undo / Redo ========== */

  function pushHistory() {
    // 現在位置より先の履歴を削除
    history = history.slice(0, historyIndex + 1);
    // スナップショットを追加
    history.push(mainCtx.getImageData(0, 0, mainCanvas.width, mainCanvas.height));
    // 上限チェック
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    historyIndex = history.length - 1;
    updateUndoRedo();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    mainCtx.putImageData(history[historyIndex], 0, 0);
    updateUndoRedo();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    mainCtx.putImageData(history[historyIndex], 0, 0);
    updateUndoRedo();
  }

  function updateUndoRedo() {
    btnUndo.disabled = historyIndex <= 0;
    btnRedo.disabled = historyIndex >= history.length - 1;
  }

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      undo();
    } else if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  /* ========== Clipboard Copy ========== */

  btnCopy.addEventListener('click', async () => {
    if (!hasImage) return;
    try {
      const blob = await new Promise((resolve) =>
        mainCanvas.toBlob(resolve, 'image/png')
      );
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      // コピー成功 UI
      btnCopy.classList.add('copied');
      const label = btnCopy.querySelector('.copy-label');
      if (label) label.textContent = 'コピー済み';
      showToast('クリップボードにコピーしました');
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        if (label) label.textContent = 'コピー';
      }, 2000);
    } catch {
      showToast('コピーに失敗しました。ブラウザの権限を確認してください');
    }
  });

  /* ========== Save ========== */

  btnSave.addEventListener('click', () => {
    if (!hasImage) return;
    mainCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `masked_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('画像を保存しました');
    }, 'image/png');
  });

  /* ========== Clear ========== */

  btnClear.addEventListener('click', () => {
    if (!hasImage) return;
    mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    hasImage = false;
    container.classList.remove('has-image');
    btnCopy.disabled = true;
    btnSave.disabled = true;
    history = [];
    historyIndex = -1;
    updateUndoRedo();
    showToast('クリアしました');
  });

  /* ========== Toast ========== */

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  /* ========== Window Resize ========== */

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (hasImage) syncOverlay();
    }, 100);
  });

  // ResizeObserver で mainCanvas の表示サイズ変更を検知
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (hasImage) syncOverlay();
    }).observe(mainCanvas);
  }

})();
