/**
 * 全角・半角コンバーター — メインスクリプト
 *
 * コア機能:
 *   1. カテゴリ別 全角↔半角 変換（英数字・スペース・カタカナ・記号）
 *   2. プリセット保存・呼び出し (LocalStorage)
 *   3. リアルタイムプレビュー
 *   4. 差分ハイライト（変換された文字だけ色付き表示）
 */
(function () {
  'use strict';

  /* ============================================
     DOM 参照
     ============================================ */
  const $input      = document.getElementById('input-area');
  const $output     = document.getElementById('output-area');
  const $inputCount = document.getElementById('input-count');
  const $btnCopy    = document.getElementById('btn-copy');
  const $toast      = document.getElementById('toast');

  // ルール
  const $ruleAlnum    = document.getElementById('rule-alnum');
  const $ruleSpace    = document.getElementById('rule-space');
  const $ruleKatakana = document.getElementById('rule-katakana');
  const $ruleSymbols  = document.getElementById('rule-symbols');
  const $optHighlight = document.getElementById('opt-highlight');

  // プリセット
  const $presetSelect    = document.getElementById('preset-select');
  const $btnSavePreset   = document.getElementById('btn-save-preset');
  const $btnDelPreset    = document.getElementById('btn-del-preset');

  const STORAGE_KEY = 'width-conv-presets';

  /* ============================================
     変換テーブル
     ============================================ */

  // 全角→半角 英数字 (U+FF01〜U+FF5E → U+0021〜U+007E のうち英数字)
  function fullToHalfAlnum(ch) {
    const code = ch.charCodeAt(0);
    // 全角英数字: Ａ-Ｚ = FF21-FF3A, ａ-ｚ = FF41-FF5A, ０-９ = FF10-FF19
    if (code >= 0xFF10 && code <= 0xFF19) return String.fromCharCode(code - 0xFEE0); // 数字
    if (code >= 0xFF21 && code <= 0xFF3A) return String.fromCharCode(code - 0xFEE0); // 大文字
    if (code >= 0xFF41 && code <= 0xFF5A) return String.fromCharCode(code - 0xFEE0); // 小文字
    return null;
  }

  function halfToFullAlnum(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code + 0xFEE0); // 数字
    if (code >= 0x41 && code <= 0x5A) return String.fromCharCode(code + 0xFEE0); // 大文字
    if (code >= 0x61 && code <= 0x7A) return String.fromCharCode(code + 0xFEE0); // 小文字
    return null;
  }

  // 全角カタカナ → 半角カタカナ テーブル
  const FULL_KATA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョ。、ー「」・';
  const HALF_KATA = ['ｱ','ｲ','ｳ','ｴ','ｵ','ｶ','ｷ','ｸ','ｹ','ｺ','ｻ','ｼ','ｽ','ｾ','ｿ','ﾀ','ﾁ','ﾂ','ﾃ','ﾄ','ﾅ','ﾆ','ﾇ','ﾈ','ﾉ','ﾊ','ﾋ','ﾌ','ﾍ','ﾎ','ﾏ','ﾐ','ﾑ','ﾒ','ﾓ','ﾔ','ﾕ','ﾖ','ﾗ','ﾘ','ﾙ','ﾚ','ﾛ','ﾜ','ｦ','ﾝ','ｧ','ｨ','ｩ','ｪ','ｫ','ｯ','ｬ','ｭ','ｮ','｡','､','ｰ','｢','｣','･'];

  // 濁点・半濁点付きカタカナ
  const DAKU_FULL = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ';
  const DAKU_HALF = ['ｶﾞ','ｷﾞ','ｸﾞ','ｹﾞ','ｺﾞ','ｻﾞ','ｼﾞ','ｽﾞ','ｾﾞ','ｿﾞ','ﾀﾞ','ﾁﾞ','ﾂﾞ','ﾃﾞ','ﾄﾞ','ﾊﾞ','ﾋﾞ','ﾌﾞ','ﾍﾞ','ﾎﾞ','ﾊﾟ','ﾋﾟ','ﾌﾟ','ﾍﾟ','ﾎﾟ','ｳﾞ'];

  const fullKataMap = {};
  const halfKataMap = {};
  for (let i = 0; i < FULL_KATA.length; i++) {
    fullKataMap[FULL_KATA[i]] = HALF_KATA[i];
    halfKataMap[HALF_KATA[i]] = FULL_KATA[i];
  }
  for (let i = 0; i < DAKU_FULL.length; i++) {
    fullKataMap[DAKU_FULL[i]] = DAKU_HALF[i];
    halfKataMap[DAKU_HALF[i]] = DAKU_FULL[i];
  }

  // 記号マッピング（よく使うもの）
  const SYM_FULL_TO_HALF = {
    '！': '!', '？': '?', '（': '(', '）': ')', '［': '[', '］': ']',
    '｛': '{', '｝': '}', '＜': '<', '＞': '>', '＆': '&', '＠': '@',
    '＃': '#', '＄': '$', '％': '%', '＾': '^', '＊': '*', '＋': '+',
    '－': '-', '＝': '=', '～': '~', '｜': '|', '＼': '\\', '／': '/',
    '：': ':', '；': ';', '＂': '"', '＇': "'", '，': ',', '．': '.',
    '＿': '_',
  };
  const SYM_HALF_TO_FULL = {};
  for (const [f, h] of Object.entries(SYM_FULL_TO_HALF)) {
    SYM_HALF_TO_FULL[h] = f;
  }

  /* ============================================
     変換エンジン
     ============================================ */
  /**
   * テキストを変換し、変換された位置の情報も返す。
   * @returns {{ result: string, changed: boolean[] }}
   */
  function convert(text) {
    const rules = {
      alnum: $ruleAlnum.value,
      space: $ruleSpace.value,
      katakana: $ruleKatakana.value,
      symbols: $ruleSymbols.value,
    };

    const result = [];
    const changed = [];

    // 半角カタカナは2文字で濁点を表すので、先に結合処理
    let processed = text;

    // カタカナ: 半角→全角の場合、先に濁点/半濁点を結合
    if (rules.katakana === 'full') {
      // 半角濁点・半濁点の結合 (例: ｶﾞ → ガ)
      for (let i = 0; i < DAKU_FULL.length; i++) {
        const pattern = DAKU_HALF[i];
        processed = processed.split(pattern).join('\x00DAKU' + i + '\x00');
      }
    }

    const chars = Array.from(processed);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];

      // 濁音マーカーの復元
      if (ch === '\x00' && chars.slice(i).join('').startsWith('\x00DAKU')) {
        const match = chars.slice(i).join('').match(/^\x00DAKU(\d+)\x00/);
        if (match) {
          const idx = parseInt(match[1]);
          result.push(DAKU_FULL[idx]);
          changed.push(true);
          // マーカーの文字数分スキップ
          i += match[0].length - 1;
          continue;
        }
      }

      let converted = null;

      // 英数字
      if (rules.alnum === 'half') {
        converted = fullToHalfAlnum(ch);
      } else if (rules.alnum === 'full') {
        converted = halfToFullAlnum(ch);
      }

      if (converted) {
        result.push(converted);
        changed.push(true);
        continue;
      }

      // スペース
      if (rules.space === 'half' && ch === '\u3000') {
        result.push(' ');
        changed.push(true);
        continue;
      } else if (rules.space === 'full' && ch === ' ') {
        result.push('\u3000');
        changed.push(true);
        continue;
      }

      // カタカナ (全角→半角)
      if (rules.katakana === 'half' && fullKataMap[ch]) {
        result.push(fullKataMap[ch]);
        changed.push(true);
        continue;
      }
      // カタカナ (半角→全角、非濁音)
      if (rules.katakana === 'full' && halfKataMap[ch]) {
        result.push(halfKataMap[ch]);
        changed.push(true);
        continue;
      }

      // 記号
      if (rules.symbols === 'half' && SYM_FULL_TO_HALF[ch]) {
        result.push(SYM_FULL_TO_HALF[ch]);
        changed.push(true);
        continue;
      } else if (rules.symbols === 'full' && SYM_HALF_TO_FULL[ch]) {
        result.push(SYM_HALF_TO_FULL[ch]);
        changed.push(true);
        continue;
      }

      result.push(ch);
      changed.push(false);
    }

    return { result: result.join(''), changed };
  }

  /* ============================================
     出力更新
     ============================================ */
  function updateOutput() {
    const text = $input.value;
    $inputCount.textContent = `${text.length} chars`;

    if (!text) {
      $output.innerHTML = '';
      return;
    }

    const { result, changed } = convert(text);
    const showHighlight = $optHighlight.checked;

    if (showHighlight && changed.some(c => c)) {
      // 差分ハイライト付き表示
      const chars = Array.from(result);
      let html = '';
      let idx = 0;
      for (let i = 0; i < chars.length; i++) {
        const ch = escapeHtml(chars[i]);
        if (changed[i]) {
          html += `<span class="hl-changed">${ch}</span>`;
        } else {
          html += ch;
        }
      }
      $output.innerHTML = html;
    } else {
      $output.textContent = result;
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ============================================
     トースト
     ============================================ */
  let toastTimer = null;
  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2000);
  }

  /* ============================================
     クリップボード
     ============================================ */
  async function copyResult() {
    // プレーンテキストとしてコピー
    const text = $output.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      $btnCopy.classList.add('copied');
      $btnCopy.querySelector('.copy-label').textContent = 'コピー済';
      setTimeout(() => {
        $btnCopy.classList.remove('copied');
        $btnCopy.querySelector('.copy-label').textContent = 'コピー';
      }, 1500);
      showToast('📋 クリップボードにコピーしました');
    } catch {
      showToast('⚠ コピーに失敗しました');
    }
  }

  /* ============================================
     プリセット管理
     ============================================ */
  function getPresets() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePresets(presets) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  }

  function getCurrentRules() {
    return {
      alnum: $ruleAlnum.value,
      space: $ruleSpace.value,
      katakana: $ruleKatakana.value,
      symbols: $ruleSymbols.value,
    };
  }

  function applyRules(rules) {
    $ruleAlnum.value    = rules.alnum    || 'none';
    $ruleSpace.value    = rules.space    || 'none';
    $ruleKatakana.value = rules.katakana || 'none';
    $ruleSymbols.value  = rules.symbols  || 'none';
    updateOutput();
  }

  function refreshPresetSelect() {
    const presets = getPresets();
    // 既存の動的オプションを削除
    while ($presetSelect.options.length > 1) {
      $presetSelect.remove(1);
    }
    for (const name of Object.keys(presets)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      $presetSelect.appendChild(opt);
    }
  }

  // 保存
  $btnSavePreset.addEventListener('click', () => {
    const name = prompt('プリセット名を入力:');
    if (!name || !name.trim()) return;
    const presets = getPresets();
    presets[name.trim()] = getCurrentRules();
    savePresets(presets);
    refreshPresetSelect();
    $presetSelect.value = name.trim();
    showToast(`💾 "${name.trim()}" を保存しました`);
  });

  // 削除
  $btnDelPreset.addEventListener('click', () => {
    const name = $presetSelect.value;
    if (!name) {
      showToast('削除するプリセットを選択してください');
      return;
    }
    if (!confirm(`"${name}" を削除しますか？`)) return;
    const presets = getPresets();
    delete presets[name];
    savePresets(presets);
    refreshPresetSelect();
    showToast(`🗑 "${name}" を削除しました`);
  });

  // 選択
  $presetSelect.addEventListener('change', () => {
    const name = $presetSelect.value;
    if (!name) return;
    const presets = getPresets();
    if (presets[name]) {
      applyRules(presets[name]);
      showToast(`✅ "${name}" を適用しました`);
    }
  });

  /* ============================================
     イベント
     ============================================ */
  $input.addEventListener('input', updateOutput);

  // ルール変更 → リアルタイム更新
  [$ruleAlnum, $ruleSpace, $ruleKatakana, $ruleSymbols].forEach(el => {
    el.addEventListener('change', updateOutput);
  });

  $optHighlight.addEventListener('change', updateOutput);
  $btnCopy.addEventListener('click', copyResult);

  // 初期化
  refreshPresetSelect();
})();
