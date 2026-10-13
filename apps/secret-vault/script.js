/**
 * script.js — シークレット・ボルトの UI
 *
 * 暗号・シリアライズ・検索などの純ロジックは vault.mjs に置き、
 * ここでは DOM の組み立て、localStorage への暗号文の保存、
 * 自動ロック / クリップボードのタイマーだけを扱う。
 *
 * - TOTP は window.otplib (CDN から SRI 付きで読込) を使う。
 * - age 書き出し/読み込みは window.age (vendor/age.js) を使う。
 * - 秘密の平文はディスクに書かない。localStorage には暗号文のみ保存する。
 */

import {
  CONTAINER_FORMAT,
  DEFAULT_CLIPBOARD_CLEAR_MS,
  DEFAULT_ITERATIONS,
  DEFAULT_LOCK_MS,
  DEFAULT_PASSWORD_OPTIONS,
  MAX_LOCK_MS,
  MIN_LOCK_MS,
  SALT_BYTES,
  SETTINGS_KEY,
  STORAGE_KEY,
  addEntry,
  base64ToBytes,
  buildAgeExportFileName,
  buildExportFileName,
  clipboardRemainingMs,
  collectTags,
  computeEntropyBits,
  createEmptyVault,
  decryptVaultWithAge,
  deriveKeyFromPassphrase,
  deserializeVault,
  encryptVaultWithAge,
  encryptVaultWithKey,
  generatePassword,
  generateTotp,
  isContainer,
  isLocked,
  isValidTotpSecret,
  normalizeTotpSecret,
  openVaultContainer,
  parseOtpauthUri,
  randomBytes,
  removeEntry,
  searchEntries,
  shouldClearClipboard,
  strengthLabel,
  updateEntry,
  validateEntry,
  validatePassphrase,
} from './vault.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),

  // lock
  lockView: $('lock-view'),
  lockTitle: $('lock-title'),
  lockDesc: $('lock-desc'),
  lockForm: $('lock-form'),
  passphrase: $('passphrase'),
  passphraseConfirmWrap: $('passphrase-confirm-wrap'),
  passphraseConfirm: $('passphrase-confirm'),
  lockSubmit: $('lock-submit'),

  // vault
  vaultView: $('vault-view'),
  lockCountdown: $('lock-countdown'),
  settingsBtn: $('settings-btn'),
  lockBtn: $('lock-btn'),
  searchInput: $('search-input'),
  newEntryBtn: $('new-entry-btn'),
  tagFilter: $('tag-filter'),
  entryList: $('entry-list'),
  entryEmpty: $('entry-empty'),
  editorEmpty: $('editor-empty'),
  entryForm: $('entry-form'),
  editorHeading: $('editor-heading'),
  cancelEntryBtn: $('cancel-entry-btn'),
  fieldTitle: $('field-title'),
  fieldUsername: $('field-username'),
  fieldUrl: $('field-url'),
  fieldPassword: $('field-password'),
  togglePassword: $('toggle-password'),
  generatePasswordBtn: $('generate-password'),
  copyPasswordBtn: $('copy-password'),
  genLength: $('gen-length'),
  genLengthLabel: $('gen-length-label'),
  genUpper: $('gen-upper'),
  genLower: $('gen-lower'),
  genDigits: $('gen-digits'),
  genSymbols: $('gen-symbols'),
  genAmbiguous: $('gen-ambiguous'),
  genPreview: $('gen-preview'),
  genStrength: $('gen-strength'),
  genUse: $('gen-use'),
  fieldTotp: $('field-totp'),
  totpPanel: $('totp-panel'),
  totpCode: $('totp-code'),
  totpRemaining: $('totp-remaining'),
  totpCopy: $('totp-copy'),
  fieldTags: $('field-tags'),
  fieldNotes: $('field-notes'),
  saveEntryBtn: $('save-entry-btn'),
  deleteEntryBtn: $('delete-entry-btn'),
  exportJsonBtn: $('export-json-btn'),
  exportAgeBtn: $('export-age-btn'),
  importFile: $('import-file'),
  clipboardStatus: $('clipboard-status'),

  // settings
  settingsModal: $('settings-modal'),
  settingsClose: $('settings-close'),
  lockSeconds: $('lock-seconds'),
  clipboardSeconds: $('clipboard-seconds'),
  iterationsInput: $('iterations-input'),
  settingsSave: $('settings-save'),

  toast: $('toast'),
};

const state = {
  container: null,
  key: null,
  salt: null,
  iterations: DEFAULT_ITERATIONS,
  vault: null,
  selectedId: null,
  activeTags: new Set(),
  lastActivity: Date.now(),
  revealPassword: false,
  clipboard: { value: '', copiedAt: 0, timer: null },
  settings: {
    lockMs: DEFAULT_LOCK_MS,
    clipboardMs: DEFAULT_CLIPBOARD_CLEAR_MS,
    iterations: DEFAULT_ITERATIONS,
  },
  totpBusy: false,
  ticker: null,
};

/* ==========================================================
   小さな UI ヘルパー
   ========================================================== */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

function hideError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function markActivity() {
  state.lastActivity = Date.now();
}

/* ==========================================================
   設定
   ========================================================== */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Number.isFinite(saved.lockMs)) state.settings.lockMs = saved.lockMs;
    if (Number.isFinite(saved.clipboardMs)) state.settings.clipboardMs = saved.clipboardMs;
    if (Number.isFinite(saved.iterations)) state.settings.iterations = saved.iterations;
  } catch {
    /* 壊れた設定は既定に戻す */
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function openSettings() {
  els.lockSeconds.value = String(Math.round(state.settings.lockMs / 1000));
  els.clipboardSeconds.value = String(Math.round(state.settings.clipboardMs / 1000));
  els.iterationsInput.value = String(state.iterations || state.settings.iterations);
  els.settingsModal.classList.add('show');
  els.settingsModal.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  els.settingsModal.classList.remove('show');
  els.settingsModal.setAttribute('aria-hidden', 'true');
}

function applySettings() {
  const lockSeconds = Number(els.lockSeconds.value);
  const clipSeconds = Number(els.clipboardSeconds.value);
  const iterations = Number(els.iterationsInput.value);
  state.settings.lockMs = Math.min(MAX_LOCK_MS, Math.max(MIN_LOCK_MS, Math.round(lockSeconds * 1000)));
  state.settings.clipboardMs = Math.max(5, Math.round(clipSeconds * 1000));
  if (Number.isFinite(iterations) && iterations >= 100000) {
    state.settings.iterations = iterations;
  }
  saveSettings();
  closeSettings();
  toast('設定を保存しました');
}

/* ==========================================================
   ロック / 解錠
   ========================================================== */

function showLockView(createMode) {
  els.vaultView.hidden = true;
  els.lockView.hidden = false;
  if (createMode) {
    els.lockTitle.textContent = 'ボルトを新規作成';
    els.lockDesc.textContent = 'マスターパスフレーズを決めてください。端末外へ送信されず、忘れると復元できません。';
    els.passphraseConfirmWrap.hidden = false;
    els.lockSubmit.textContent = '作成';
    els.passphrase.setAttribute('autocomplete', 'new-password');
  } else {
    els.lockTitle.textContent = 'ボルトを解錠';
    els.lockDesc.textContent = 'マスターパスフレーズを入力してください。パスフレーズは端末外へ送信されません。';
    els.passphraseConfirmWrap.hidden = true;
    els.lockSubmit.textContent = '解錠';
    els.passphrase.setAttribute('autocomplete', 'current-password');
  }
  els.passphrase.value = '';
  els.passphraseConfirm.value = '';
  els.passphrase.focus();
}

function showVaultView() {
  els.lockView.hidden = true;
  els.vaultView.hidden = false;
  renderAll();
}

function lock() {
  state.key = null;
  state.vault = null;
  state.salt = null;
  state.selectedId = null;
  state.activeTags.clear();
  clearTimeout(state.clipboard.timer);
  state.clipboard = { value: '', copiedAt: 0, timer: null };
  setClipboardStatus('');
  // DOM に残った入力も消す (鍵と同じくメモリから破棄する)
  els.entryForm.reset();
  els.fieldPassword.value = '';
  els.fieldTotp.value = '';
  showLockView(false);
}

async function unlockOrCreate() {
  const passphrase = els.passphrase.value;
  if (state.container) {
    const check = validatePassphrase(passphrase);
    if (!check.ok) return showError(check.error);
    const { key, vault } = await openVaultContainer(state.container, passphrase);
    state.key = key;
    state.salt = base64ToBytes(state.container.kdf.salt);
    state.iterations = state.container.kdf.iterations;
    state.vault = vault;
  } else {
    const check = validatePassphrase(passphrase, els.passphraseConfirm.value);
    if (!check.ok) return showError(check.error);
    const iterations = state.settings.iterations || DEFAULT_ITERATIONS;
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKeyFromPassphrase(passphrase, { salt, iterations });
    const vault = createEmptyVault();
    state.key = key;
    state.salt = salt;
    state.iterations = iterations;
    state.vault = vault;
    await persist();
  }
  hideError();
  markActivity();
  showVaultView();
}

/* ==========================================================
   暗号文の保存
   ========================================================== */

async function persist() {
  const container = await encryptVaultWithKey(state.vault, state.key, {
    salt: state.salt,
    iterations: state.iterations,
  });
  state.container = container;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(container));
}

/* ==========================================================
   描画
   ========================================================== */

function renderAll() {
  renderTags();
  renderList();
  updateLockCountdown();
}

function filteredEntries() {
  return searchEntries(state.vault.entries, {
    query: els.searchInput.value,
    tags: [...state.activeTags],
  });
}

function renderTags() {
  const tags = collectTags(state.vault.entries);
  els.tagFilter.innerHTML = '';
  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = tag;
    if (state.activeTags.has(tag)) chip.classList.add('is-active');
    chip.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      renderTags();
      renderList();
    });
    els.tagFilter.appendChild(chip);
  }
}

function renderList() {
  const entries = filteredEntries();
  els.entryList.innerHTML = '';
  els.entryEmpty.hidden = entries.length > 0;

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'entry-item';
    li.tabIndex = 0;
    if (entry.id === state.selectedId) li.classList.add('is-active');

    const title = document.createElement('div');
    title.className = 'entry-item-title';
    title.textContent = entry.title || '(タイトルなし)';
    li.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'entry-item-sub';
    sub.textContent = entry.username || entry.url || '';
    if (sub.textContent) li.appendChild(sub);

    if (entry.tags.length > 0) {
      const tagBox = document.createElement('div');
      tagBox.className = 'entry-item-tags';
      for (const tag of entry.tags) {
        const span = document.createElement('span');
        span.className = 'entry-tag';
        span.textContent = tag;
        tagBox.appendChild(span);
      }
      li.appendChild(tagBox);
    }

    const open = () => openEditor(entry.id);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    els.entryList.appendChild(li);
  }
}

/* ==========================================================
   エディタ
   ========================================================== */

function setPasswordVisibility(visible) {
  state.revealPassword = visible;
  els.fieldPassword.type = visible ? 'text' : 'password';
  els.togglePassword.textContent = visible ? '非表示' : '表示';
}

function openEditor(entryId) {
  const entry = entryId ? state.vault.entries.find((e) => e.id === entryId) : null;
  state.selectedId = entry ? entry.id : null;

  els.editorEmpty.hidden = true;
  els.entryForm.hidden = false;
  els.editorHeading.textContent = entry ? 'エントリを編集' : '新規エントリ';
  els.deleteEntryBtn.hidden = !entry;

  els.fieldTitle.value = entry?.title || '';
  els.fieldUsername.value = entry?.username || '';
  els.fieldUrl.value = entry?.url || '';
  els.fieldPassword.value = entry?.password || '';
  els.fieldTotp.value = entry?.totpSecret || '';
  els.fieldTags.value = (entry?.tags || []).join(', ');
  els.fieldNotes.value = entry?.notes || '';

  setPasswordVisibility(false);
  refreshGenerator();
  updateTotp();
  els.fieldTitle.focus();
  renderList();
}

function closeEditor() {
  state.selectedId = null;
  els.entryForm.hidden = true;
  els.editorEmpty.hidden = false;
  els.totpPanel.hidden = true;
  renderList();
}

function collectFormEntry() {
  return {
    title: els.fieldTitle.value,
    username: els.fieldUsername.value,
    password: els.fieldPassword.value,
    url: els.fieldUrl.value,
    notes: els.fieldNotes.value,
    totpSecret: els.fieldTotp.value,
    tags: els.fieldTags.value,
  };
}

async function submitEntry(event) {
  event.preventDefault();
  const input = collectFormEntry();
  const check = validateEntry(input);
  if (!check.ok) return showError(check.error);

  if (state.selectedId) {
    state.vault = updateEntry(state.vault, state.selectedId, input);
  } else {
    state.vault = addEntry(state.vault, input);
    state.selectedId = state.vault.entries[state.vault.entries.length - 1].id;
  }
  hideError();
  await persist();
  renderAll();
  openEditor(state.selectedId);
  toast('保存しました');
}

async function deleteCurrentEntry() {
  if (!state.selectedId) return;
  const entry = state.vault.entries.find((e) => e.id === state.selectedId);
  if (!entry) return;
  if (!confirm(`「${entry.title || '(タイトルなし)'}」を削除しますか？`)) return;
  state.vault = removeEntry(state.vault, state.selectedId);
  await persist();
  closeEditor();
  renderAll();
  toast('削除しました');
}

/* ==========================================================
   パスワード生成
   ========================================================== */

function currentGeneratorOptions() {
  return {
    length: Number(els.genLength.value) || DEFAULT_PASSWORD_OPTIONS.length,
    upper: els.genUpper.checked,
    lower: els.genLower.checked,
    digits: els.genDigits.checked,
    symbols: els.genSymbols.checked,
    excludeAmbiguous: els.genAmbiguous.checked,
  };
}

function refreshGenerator() {
  const options = currentGeneratorOptions();
  els.genLengthLabel.textContent = String(options.length);
  let preview;
  try {
    preview = generatePassword(options);
  } catch {
    preview = '';
  }
  els.genPreview.textContent = preview || '(文字種を 1 つ以上選んでください)';
  const bits = computeEntropyBits(options);
  const { label } = strengthLabel(bits);
  els.genStrength.textContent = preview ? `${label} (${bits} bits)` : '';
  return preview;
}

/* ==========================================================
   TOTP
   ========================================================== */

function totpParamsFromField() {
  const raw = els.fieldTotp.value.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('otpauth://')) {
    try {
      return parseOtpauthUri(raw);
    } catch {
      return null;
    }
  }
  const secret = normalizeTotpSecret(raw);
  if (!isValidTotpSecret(secret)) return null;
  return { secret, digits: 6, period: 30, algorithm: 'sha1' };
}

async function updateTotp() {
  const params = totpParamsFromField();
  if (!params) {
    els.totpPanel.hidden = true;
    return;
  }
  els.totpPanel.hidden = false;
  if (state.totpBusy) return;
  state.totpBusy = true;
  try {
    const { code, remaining } = await generateTotp(window.otplib, {
      secret: params.secret,
      digits: params.digits,
      period: params.period,
      algorithm: params.algorithm,
    });
    els.totpCode.textContent = code;
    els.totpRemaining.textContent = `${Math.ceil(remaining)} 秒`;
  } catch (error) {
    els.totpCode.textContent = '------';
    els.totpRemaining.textContent = error?.message || 'エラー';
  } finally {
    state.totpBusy = false;
  }
}

/* ==========================================================
   クリップボード
   ========================================================== */

function setClipboardStatus(text) {
  els.clipboardStatus.textContent = text || '';
}

async function copyText(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showError('クリップボードへコピーできませんでした。');
    return;
  }
  state.clipboard.value = text;
  state.clipboard.copiedAt = Date.now();
  clearTimeout(state.clipboard.timer);
  state.clipboard.timer = setTimeout(clearClipboard, state.settings.clipboardMs);
  updateClipboardStatus();
  toast(`${label} をコピーしました（${Math.round(state.settings.clipboardMs / 1000)} 秒後に消去）`);
}

async function clearClipboard() {
  try {
    await navigator.clipboard.writeText('');
  } catch {
    /* 失敗しても状態はクリアする */
  }
  state.clipboard.value = '';
  state.clipboard.copiedAt = 0;
  setClipboardStatus('');
  toast('クリップボードを消去しました');
}

function updateClipboardStatus() {
  if (!state.clipboard.value) {
    setClipboardStatus('');
    return;
  }
  const remain = clipboardRemainingMs({
    copiedAt: state.clipboard.copiedAt,
    clearAfterMs: state.settings.clipboardMs,
  });
  if (shouldClearClipboard({
    copiedAt: state.clipboard.copiedAt,
    clearAfterMs: state.settings.clipboardMs,
  })) {
    clearClipboard();
    return;
  }
  setClipboardStatus(`クリップボード: 残り ${Math.ceil(remain / 1000)} 秒`);
}

/* ==========================================================
   自動ロック / タイマー
   ========================================================== */

function updateLockCountdown() {
  if (!state.vault) {
    els.lockCountdown.textContent = '';
    return;
  }
  const remain = Math.max(0, state.settings.lockMs - (Date.now() - state.lastActivity));
  els.lockCountdown.textContent = `ロックまで ${Math.ceil(remain / 1000)} 秒`;
}

function tick() {
  if (state.vault) {
    updateLockCountdown();
    updateClipboardStatus();
    if (els.entryForm.hidden === false && !els.totpPanel.hidden && !state.totpBusy) {
      updateTotp();
    }
    if (isLocked({ lastActivity: state.lastActivity, lockAfterMs: state.settings.lockMs })) {
      lock();
      toast('一定時間操作が無かったため自動ロックしました');
    }
  }
}

/* ==========================================================
   書き出し / 読み込み
   ========================================================== */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.container)], { type: 'application/json' });
  downloadBlob(blob, buildExportFileName());
  toast('暗号化 JSON を書き出しました');
}

async function exportAge() {
  if (!window.age) {
    showError('age ライブラリを読み込めませんでした。');
    return;
  }
  const passphrase = prompt('age 書き出し用のパスフレーズ（8 文字以上）を入力してください。');
  if (!passphrase) return;
  try {
    const bytes = await encryptVaultWithAge(window.age, state.vault, passphrase);
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), buildAgeExportFileName());
    toast('age ファイルを書き出しました');
  } catch (error) {
    showError(error?.message || 'age 書き出しに失敗しました。');
  }
}

function adoptVault(vault) {
  if (!confirm('現在のボルトを読み込んだ内容で置き換えます。よろしいですか？')) return false;
  state.vault = vault;
  state.selectedId = null;
  persist()
    .then(() => {
      closeEditor();
      renderAll();
      toast('読み込みました');
    })
    .catch((error) => showError(error?.message || '保存に失敗しました。'));
  return true;
}

async function importFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  // 1) このアプリの暗号化コンテナ (JSON)
  try {
    const obj = JSON.parse(text);
    if (isContainer(obj)) {
      const passphrase = prompt('読み込む JSON のマスターパスフレーズを入力してください。');
      if (!passphrase) return;
      const { vault } = await openVaultContainer(obj, passphrase);
      adoptVault(vault);
      return;
    }
    if (obj && (Array.isArray(obj.entries) || Number.isFinite(Number(obj.version)))) {
      adoptVault(deserializeVault(obj));
      return;
    }
  } catch {
    /* JSON でなければ age を試す */
  }

  // 2) age 形式
  if (text.startsWith('age-encryption.org/v1') || text.includes('BEGIN AGE ENCRYPTED FILE')) {
    if (!window.age) {
      showError('age ライブラリを読み込めませんでした。');
      return;
    }
    const passphrase = prompt('age ファイルのパスフレーズを入力してください。');
    if (!passphrase) return;
    const vault = await decryptVaultWithAge(window.age, bytes, passphrase);
    adoptVault(vault);
    return;
  }

  showError('未対応のファイル形式です（暗号化 JSON か age ファイルを選んでください）。');
}

/* ==========================================================
   イベント登録 / 起動
   ========================================================== */

function bindEvents() {
  els.lockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    unlockOrCreate().catch((error) => showError(error?.message || 'エラーが発生しました。'));
  });

  els.lockBtn.addEventListener('click', () => {
    lock();
    toast('ロックしました');
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsSave.addEventListener('click', applySettings);
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });

  els.searchInput.addEventListener('input', renderList);
  els.newEntryBtn.addEventListener('click', () => {
    state.selectedId = null;
    openEditor(null);
  });
  els.cancelEntryBtn.addEventListener('click', closeEditor);
  els.entryForm.addEventListener('submit', (event) => {
    submitEntry(event).catch((error) => showError(error?.message || '保存に失敗しました。'));
  });
  els.deleteEntryBtn.addEventListener('click', () => {
    deleteCurrentEntry().catch((error) => showError(error?.message || '削除に失敗しました。'));
  });

  els.togglePassword.addEventListener('click', () => setPasswordVisibility(!state.revealPassword));
  els.copyPasswordBtn.addEventListener('click', () => copyText(els.fieldPassword.value, 'パスワード'));
  els.generatePasswordBtn.addEventListener('click', () => {
    els.fieldPassword.value = refreshGenerator();
    setPasswordVisibility(true);
  });

  for (const input of [
    els.genLength,
    els.genUpper,
    els.genLower,
    els.genDigits,
    els.genSymbols,
    els.genAmbiguous,
  ]) {
    input.addEventListener('input', refreshGenerator);
  }
  els.genUse.addEventListener('click', () => {
    const preview = refreshGenerator();
    if (preview) {
      els.fieldPassword.value = preview;
      setPasswordVisibility(true);
    }
  });

  els.fieldTotp.addEventListener('input', () => {
    updateTotp();
  });
  els.totpCopy.addEventListener('click', () => copyText(els.totpCode.textContent, 'TOTP コード'));

  els.exportJsonBtn.addEventListener('click', exportJson);
  els.exportAgeBtn.addEventListener('click', () => {
    exportAge().catch((error) => showError(error?.message || 'age 書き出しに失敗しました。'));
  });
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files?.[0];
    if (!file) return;
    importFile(file)
      .catch((error) => showError(error?.message || '読み込みに失敗しました。'))
      .finally(() => {
        els.importFile.value = '';
      });
  });

  document.addEventListener('pointerdown', markActivity, true);
  document.addEventListener('keydown', markActivity, true);
}

function init() {
  loadSettings();
  bindEvents();
  state.ticker = setInterval(tick, 1000);

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const container = JSON.parse(raw);
      if (isContainer(container)) {
        state.container = container;
        showLockView(false);
        return;
      }
    }
  } catch {
    /* 壊れた保存は無視して新規作成へ */
  }
  showLockView(true);
}

init();
