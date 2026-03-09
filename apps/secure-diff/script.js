/**
 * セキュア・テキストDiff — メインスクリプト
 *
 * コア機能:
 *   1. 文字単位 / 行単位の Diff 表示切替
 *   2. 空白・改行コードの無視オプション
 *   3. 同期スクロール
 *   4. ミニマップ（変更位置の俯瞰）
 *
 * 依存: jsdiff (CDN) — https://github.com/kpdecker/jsdiff
 */
(function () {
  'use strict';

  /* ============================================
     DOM 参照
     ============================================ */
  const $leftInput   = document.getElementById('left-input');
  const $rightInput  = document.getElementById('right-input');
  const $leftCount   = document.getElementById('left-count');
  const $rightCount  = document.getElementById('right-count');
  const $diffBody    = document.getElementById('diff-body');
  const $minimap     = document.getElementById('minimap');
  const $viewport    = document.getElementById('minimap-viewport');
  const $stats       = document.getElementById('stats');
  const $btnSwap     = document.getElementById('btn-swap');
  const $btnClear    = document.getElementById('btn-clear');
  const $optWS       = document.getElementById('opt-whitespace');
  const $optNL       = document.getElementById('opt-newline');
  const modeBtns     = document.querySelectorAll('.mode-btn');

  /* ============================================
     状態
     ============================================ */
  let diffMode = 'char'; // 'char' | 'line'
  let debounceTimer = null;

  /* ============================================
     前処理: テキストの正規化
     ============================================ */
  function normalize(text) {
    let t = text;
    if ($optNL.checked) {
      t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    if ($optWS.checked) {
      // 各行の末尾空白を削除し、連続空白を1つに
      t = t.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).join('\n');
    }
    return t;
  }

  /* ============================================
     HTML エスケープ
     ============================================ */
  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ============================================
     Diff 計算 & 描画
     ============================================ */
  function computeDiff() {
    const leftRaw  = $leftInput.value;
    const rightRaw = $rightInput.value;

    // 文字数カウント更新
    $leftCount.textContent  = `${leftRaw.length} chars`;
    $rightCount.textContent = `${rightRaw.length} chars`;

    // 空なら初期表示
    if (!leftRaw && !rightRaw) {
      $diffBody.innerHTML = '<div class="diff-empty">テキストを入力するとDiffが表示されます</div>';
      $stats.textContent = '差分なし';
      $stats.classList.remove('has-diff');
      clearMinimap();
      return;
    }

    const left  = normalize(leftRaw);
    const right = normalize(rightRaw);

    if (diffMode === 'line') {
      renderLineDiff(left, right);
    } else {
      renderCharDiff(left, right);
    }
  }

  /* ============================================
     文字単位 Diff
     ============================================ */
  function renderCharDiff(left, right) {
    const diff = Diff.diffChars(left, right);

    let addCount = 0, delCount = 0;
    // 行ごとに分割して表示
    let lines = [{ leftNum: 1, rightNum: 1, parts: [] }];
    let leftNum = 1, rightNum = 1;

    diff.forEach(part => {
      if (part.added) addCount += part.value.length;
      if (part.removed) delCount += part.value.length;

      const segments = part.value.split('\n');
      segments.forEach((seg, i) => {
        if (i > 0) {
          // 改行 → 新しい行を作る
          if (!part.removed) rightNum++;
          if (!part.added) leftNum++;
          lines.push({ leftNum, rightNum, parts: [] });
        }
        if (seg.length > 0) {
          const current = lines[lines.length - 1];
          current.parts.push({
            text: seg,
            type: part.added ? 'add' : part.removed ? 'del' : 'eq'
          });
        }
      });
    });

    // 行のタイプを決定
    let html = '';
    const lineTypes = [];
    lines.forEach(line => {
      const hasAdd = line.parts.some(p => p.type === 'add');
      const hasDel = line.parts.some(p => p.type === 'del');
      let lineClass = '';
      let prefix = ' ';
      let lineType = 'eq';

      if (hasAdd && !hasDel) {
        lineClass = ' added';
        prefix = '+';
        lineType = 'add';
      } else if (hasDel && !hasAdd) {
        lineClass = ' removed';
        prefix = '−';
        lineType = 'del';
      } else if (hasAdd && hasDel) {
        lineClass = ' added';
        prefix = '~';
        lineType = 'mod';
      }
      lineTypes.push(lineType);

      const leftN  = line.leftNum  != null ? line.leftNum  : '';
      const rightN = line.rightNum != null ? line.rightNum : '';

      let contentHtml = '';
      line.parts.forEach(p => {
        const escaped = esc(p.text);
        if (p.type === 'add') {
          contentHtml += `<span class="diff-char-add">${escaped}</span>`;
        } else if (p.type === 'del') {
          contentHtml += `<span class="diff-char-del">${escaped}</span>`;
        } else {
          contentHtml += escaped;
        }
      });

      html += `<div class="diff-line${lineClass}">` +
        `<div class="diff-line-num">${leftN}</div>` +
        `<div class="diff-line-num">${rightN}</div>` +
        `<div class="diff-line-content"><span class="diff-line-prefix">${prefix}</span>${contentHtml}</div>` +
        `</div>`;
    });

    $diffBody.innerHTML = html;
    updateStats(addCount, delCount);
    buildMinimap(lineTypes);
  }

  /* ============================================
     行単位 Diff
     ============================================ */
  function renderLineDiff(left, right) {
    const diff = Diff.diffLines(left, right);

    let addCount = 0, delCount = 0;
    let html = '';
    let leftNum = 1, rightNum = 1;
    const lineTypes = [];

    diff.forEach(part => {
      const lines = part.value.replace(/\n$/, '').split('\n');

      lines.forEach(line => {
        const escaped = esc(line);
        if (part.added) {
          addCount++;
          lineTypes.push('add');
          html += `<div class="diff-line added">` +
            `<div class="diff-line-num"></div>` +
            `<div class="diff-line-num">${rightNum}</div>` +
            `<div class="diff-line-content"><span class="diff-line-prefix">+</span>${escaped}</div>` +
            `</div>`;
          rightNum++;
        } else if (part.removed) {
          delCount++;
          lineTypes.push('del');
          html += `<div class="diff-line removed">` +
            `<div class="diff-line-num">${leftNum}</div>` +
            `<div class="diff-line-num"></div>` +
            `<div class="diff-line-content"><span class="diff-line-prefix">−</span>${escaped}</div>` +
            `</div>`;
          leftNum++;
        } else {
          lineTypes.push('eq');
          html += `<div class="diff-line">` +
            `<div class="diff-line-num">${leftNum}</div>` +
            `<div class="diff-line-num">${rightNum}</div>` +
            `<div class="diff-line-content"><span class="diff-line-prefix"> </span>${escaped}</div>` +
            `</div>`;
          leftNum++;
          rightNum++;
        }
      });
    });

    $diffBody.innerHTML = html;
    updateStats(addCount, delCount);
    buildMinimap(lineTypes);
  }

  /* ============================================
     統計更新
     ============================================ */
  function updateStats(adds, dels) {
    if (adds === 0 && dels === 0) {
      $stats.textContent = '差分なし';
      $stats.classList.remove('has-diff');
    } else {
      const unit = diffMode === 'line' ? '行' : '文字';
      $stats.textContent = `+${adds} / −${dels} ${unit}`;
      $stats.classList.add('has-diff');
    }
  }

  /* ============================================
     ミニマップ
     ============================================ */
  function buildMinimap(lineTypes) {
    // 既存のバーを削除
    $minimap.querySelectorAll('.minimap-bar').forEach(el => el.remove());

    const total = lineTypes.length;
    if (total === 0) return;

    const mapHeight = $minimap.clientHeight;

    lineTypes.forEach((type, i) => {
      if (type === 'eq') return;
      const bar = document.createElement('div');
      bar.className = `minimap-bar ${type === 'del' ? 'del' : 'add'}`;
      bar.style.top = `${(i / total) * mapHeight}px`;
      $minimap.appendChild(bar);
    });

    updateMinimapViewport();
  }

  function clearMinimap() {
    $minimap.querySelectorAll('.minimap-bar').forEach(el => el.remove());
    $viewport.style.top = '0';
    $viewport.style.height = '100%';
  }

  function updateMinimapViewport() {
    const body = $diffBody;
    if (body.scrollHeight <= body.clientHeight) {
      $viewport.style.top = '0';
      $viewport.style.height = '100%';
      return;
    }
    const mapHeight = $minimap.clientHeight;
    const ratio = body.clientHeight / body.scrollHeight;
    const top = (body.scrollTop / body.scrollHeight) * mapHeight;
    $viewport.style.top = `${top}px`;
    $viewport.style.height = `${ratio * mapHeight}px`;
  }

  /* ミニマップクリックでスクロール */
  $minimap.addEventListener('click', (e) => {
    const rect = $minimap.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    $diffBody.scrollTop = ratio * $diffBody.scrollHeight - $diffBody.clientHeight / 2;
  });

  $diffBody.addEventListener('scroll', updateMinimapViewport);

  /* ============================================
     デバウンス付き差分計算
     ============================================ */
  function debouncedDiff() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(computeDiff, 200);
  }

  /* ============================================
     イベント: テキスト入力
     ============================================ */
  $leftInput.addEventListener('input', debouncedDiff);
  $rightInput.addEventListener('input', debouncedDiff);

  /* ============================================
     イベント: モード切替
     ============================================ */
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      diffMode = btn.dataset.mode;
      computeDiff();
    });
  });

  /* ============================================
     イベント: 無視オプション
     ============================================ */
  $optWS.addEventListener('change', computeDiff);
  $optNL.addEventListener('change', computeDiff);

  /* ============================================
     イベント: 入替
     ============================================ */
  $btnSwap.addEventListener('click', () => {
    const tmp = $leftInput.value;
    $leftInput.value = $rightInput.value;
    $rightInput.value = tmp;
    computeDiff();
  });

  /* ============================================
     イベント: クリア
     ============================================ */
  $btnClear.addEventListener('click', () => {
    $leftInput.value = '';
    $rightInput.value = '';
    computeDiff();
    $leftInput.focus();
  });

  /* ============================================
     同期スクロール (入力テキストエリア)
     ============================================ */
  let syncing = false;

  function syncScroll(source, target) {
    if (syncing) return;
    syncing = true;

    const ratio = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
    target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);

    requestAnimationFrame(() => { syncing = false; });
  }

  $leftInput.addEventListener('scroll', () => syncScroll($leftInput, $rightInput));
  $rightInput.addEventListener('scroll', () => syncScroll($rightInput, $leftInput));
})();
