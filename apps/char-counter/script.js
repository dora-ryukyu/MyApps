/**
 * 文字数カウンター Pro — メインスクリプト
 *
 * コア機能:
 *   1. マルチカウント（文字数/単語数/行数/段落数/原稿用紙換算）
 *   2. ターゲット設定（目標/制限）+ プログレスバー
 *   3. 自動保存 (LocalStorage)
 *   4. 選択範囲のみカウント
 *   5. Intl.Segmenter による正確な単語カウント
 */
(function () {
  'use strict';

  /* ============================================
     DOM
     ============================================ */
  const $editor    = document.getElementById('editor');
  const $vChars    = document.getElementById('v-chars');
  const $vCharsNS  = document.getElementById('v-chars-ns');
  const $vWords    = document.getElementById('v-words');
  const $vLines    = document.getElementById('v-lines');
  const $vParas    = document.getElementById('v-paragraphs');
  const $vPages    = document.getElementById('v-pages');

  const $targetType   = document.getElementById('target-type');
  const $targetValue  = document.getElementById('target-value');
  const $targetMetric = document.getElementById('target-metric');
  const $progressWrap = document.getElementById('progress-wrap');
  const $progressFill = document.getElementById('progress-fill');
  const $progressText = document.getElementById('progress-text');

  const $selBar   = document.getElementById('selection-bar');
  const $selChars = document.getElementById('sel-chars');
  const $selWords = document.getElementById('sel-words');

  const STORAGE_TEXT   = 'char-counter-text';
  const STORAGE_TARGET = 'char-counter-target';

  /* ============================================
     Intl.Segmenter (対応ブラウザ用)
     ============================================ */
  let wordSegmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      wordSegmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    }
  } catch { /* フォールバック */ }

  /* ============================================
     カウントロジック
     ============================================ */
  function countText(text) {
    const chars = text.length;
    const charsNoSpace = text.replace(/[\s\u3000]/g, '').length;

    // 単語数
    let words = 0;
    if (wordSegmenter) {
      for (const seg of wordSegmenter.segment(text)) {
        if (seg.isWordLike) words++;
      }
    } else {
      // フォールバック: 英単語 + 日本語文字を個別カウント
      const enWords = text.match(/[a-zA-Z]+(?:['-][a-zA-Z]+)*/g);
      const jaChars = text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g);
      words = (enWords ? enWords.length : 0) + (jaChars ? jaChars.length : 0);
    }

    // 行数
    const lines = text ? text.split('\n').length : 0;

    // 段落数 (空行区切り)
    const paragraphs = text.trim()
      ? text.trim().split(/\n{2,}/).filter(p => p.trim()).length
      : 0;

    // 原稿用紙換算 (400字詰め)
    const pages = Math.ceil(charsNoSpace / 400) || 0;

    return { chars, charsNoSpace, words, lines, paragraphs, pages };
  }

  /* ============================================
     UI 更新
     ============================================ */
  function update() {
    const text = $editor.value;
    const c = countText(text);

    $vChars.textContent   = c.chars.toLocaleString();
    $vCharsNS.textContent = c.charsNoSpace.toLocaleString();
    $vWords.textContent   = c.words.toLocaleString();
    $vLines.textContent   = c.lines.toLocaleString();
    $vParas.textContent   = c.paragraphs.toLocaleString();
    $vPages.textContent   = `${c.pages} 枚`;

    updateProgress(c);
    saveText(text);
  }

  /* ============================================
     プログレスバー
     ============================================ */
  function updateProgress(c) {
    const type = $targetType.value;
    if (type === 'none') {
      $progressWrap.style.display = 'none';
      return;
    }

    $progressWrap.style.display = '';
    const target = parseInt($targetValue.value) || 1;
    const metric = $targetMetric.value;

    let current;
    if (metric === 'words') current = c.words;
    else if (metric === 'chars-ns') current = c.charsNoSpace;
    else current = c.chars;

    const pct = Math.min((current / target) * 100, 100);
    const isOver = type === 'limit' && current > target;

    $progressFill.style.width = `${pct}%`;
    $progressFill.classList.toggle('over', isOver);
    $progressText.textContent = `${current.toLocaleString()} / ${target.toLocaleString()}`;
    $progressText.classList.toggle('over', isOver);

    saveTarget();
  }

  /* ============================================
     選択範囲カウント
     ============================================ */
  function updateSelection() {
    const start = $editor.selectionStart;
    const end = $editor.selectionEnd;

    if (start === end) {
      $selBar.style.display = 'none';
      return;
    }

    const selected = $editor.value.substring(start, end);
    const c = countText(selected);
    $selChars.textContent = c.chars.toLocaleString();
    $selWords.textContent = c.words.toLocaleString();
    $selBar.style.display = '';
  }

  /* ============================================
     LocalStorage
     ============================================ */
  function saveText(text) {
    try { localStorage.setItem(STORAGE_TEXT, text); } catch {}
  }

  function loadText() {
    try { return localStorage.getItem(STORAGE_TEXT) || ''; } catch { return ''; }
  }

  function saveTarget() {
    try {
      localStorage.setItem(STORAGE_TARGET, JSON.stringify({
        type: $targetType.value,
        value: $targetValue.value,
        metric: $targetMetric.value,
      }));
    } catch {}
  }

  function loadTarget() {
    try {
      const raw = localStorage.getItem(STORAGE_TARGET);
      if (!raw) return;
      const t = JSON.parse(raw);
      $targetType.value = t.type || 'none';
      $targetValue.value = t.value || 2000;
      $targetMetric.value = t.metric || 'chars';
    } catch {}
  }

  /* ============================================
     イベント
     ============================================ */
  $editor.addEventListener('input', update);

  // 選択範囲の変更検知
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === $editor) {
      updateSelection();
    }
  });
  $editor.addEventListener('mouseup', updateSelection);
  $editor.addEventListener('keyup', updateSelection);

  // ターゲット設定変更
  $targetType.addEventListener('change', update);
  $targetValue.addEventListener('input', update);
  $targetMetric.addEventListener('change', update);

  /* ============================================
     初期化
     ============================================ */
  loadTarget();
  const saved = loadText();
  if (saved) {
    $editor.value = saved;
  }
  update();
})();
