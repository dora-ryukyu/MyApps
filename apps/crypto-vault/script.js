/**
 * script.js — 暗号化ボルトの UI
 *
 * age ライブラリは vendor/age.js が window.age として公開する。
 * 暗号化・復号・armor の純ロジックは pipeline.mjs に置き、
 * ここでは DOM の組み立てとファイル入出力だけを扱う。
 */

import {
  AGE_LIB_LICENSE,
  AGE_LIB_SOURCE,
  AGE_LIB_VERSION,
  MAX_INPUT_BYTES,
  armorEncode,
  buildAgeFileName,
  buildIdentityFileName,
  buildRecipientFileName,
  byteLength,
  classifyKeyValue,
  decryptBytes,
  encryptBytes,
  formatBytes,
  generateKeyPair,
  isProbablyText,
  resolveEncryptedInput,
  stripAgeExtension,
  toUint8Array,
  validateIdentity,
  validatePassphrase,
  validateRecipient,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),

  tabEncrypt: $('tab-encrypt'),
  tabDecrypt: $('tab-decrypt'),
  encryptSection: $('encrypt-section'),
  decryptSection: $('decrypt-section'),

  // 暗号化
  encPassphraseFields: $('enc-passphrase-fields'),
  encKeypairFields: $('enc-keypair-fields'),
  encPassphrase: $('enc-passphrase'),
  encPassphraseConfirm: $('enc-passphrase-confirm'),
  encShowPassphrase: $('enc-show-passphrase'),
  genKeypairBtn: $('gen-keypair-btn'),
  keypairResult: $('keypair-result'),
  recipientOutput: $('recipient-output'),
  identityOutput: $('identity-output'),
  copyRecipientBtn: $('copy-recipient-btn'),
  copyIdentityBtn: $('copy-identity-btn'),
  downloadIdentityBtn: $('download-identity-btn'),
  downloadRecipientBtn: $('download-recipient-btn'),
  encRecipient: $('enc-recipient'),
  inputTabText: $('input-tab-text'),
  inputTabFile: $('input-tab-file'),
  encTextPanel: $('enc-text-panel'),
  encFilePanel: $('enc-file-panel'),
  encText: $('enc-text'),
  encDropZone: $('enc-drop-zone'),
  encFileInput: $('enc-file-input'),
  encFileName: $('enc-file-name'),
  encFileMeta: $('enc-file-meta'),
  encArmorCheck: $('enc-armor-check'),
  encryptBtn: $('encrypt-btn'),
  encResult: $('enc-result'),
  encResultMeta: $('enc-result-meta'),
  encArmorOutputWrap: $('enc-armor-output-wrap'),
  encArmorOutput: $('enc-armor-output'),
  copyArmorBtn: $('copy-armor-btn'),
  downloadCipherBtn: $('download-cipher-btn'),
  downloadCipherLabel: $('download-cipher-label'),

  // 復号
  decPassphraseFields: $('dec-passphrase-fields'),
  decKeypairFields: $('dec-keypair-fields'),
  decPassphrase: $('dec-passphrase'),
  decShowPassphrase: $('dec-show-passphrase'),
  decIdentity: $('dec-identity'),
  decIdentityFile: $('dec-identity-file'),
  decInputTabFile: $('dec-input-tab-file'),
  decInputTabText: $('dec-input-tab-text'),
  decFilePanel: $('dec-file-panel'),
  decTextPanel: $('dec-text-panel'),
  decDropZone: $('dec-drop-zone'),
  decFileInput: $('dec-file-input'),
  decFileName: $('dec-file-name'),
  decFileMeta: $('dec-file-meta'),
  decArmorInput: $('dec-armor-input'),
  decryptBtn: $('decrypt-btn'),
  decResult: $('dec-result'),
  decResultMeta: $('dec-result-meta'),
  decTextOutputWrap: $('dec-text-output-wrap'),
  decTextOutput: $('dec-text-output'),
  copyDecryptedBtn: $('copy-decrypted-btn'),
  downloadPlainBtn: $('download-plain-btn'),
  downloadPlainLabel: $('download-plain-label'),

  // Info
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
};

const state = {
  mode: 'encrypt',
  encInput: 'text',
  decInput: 'file',
  encFile: null,
  decFile: null,
  cipherBytes: null,
  cipherName: '',
  plainBytes: null,
  plainName: '',
  identity: '',
  recipient: '',
};

/* ==========================================================
   共通ヘルパー
   ========================================================== */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
  els.errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.querySelector('span').textContent = label;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'コピーしました';
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch {
    showError('クリップボードにコピーできませんでした。手動で選択してコピーしてください。');
  }
}

function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadText(text, filename, mime = 'text/plain') {
  downloadBytes(new TextEncoder().encode(text), filename, mime);
}

function readFileAsBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsText(file);
  });
}

function getAge() {
  if (!window.age || typeof window.age.Encrypter !== 'function') {
    throw new Error('age ライブラリの読み込みに失敗しました。ページを再読み込みしてください。');
  }
  return window.age;
}

/* ==========================================================
   モード切替
   ========================================================== */

function setMode(mode) {
  state.mode = mode;
  const isEncrypt = mode === 'encrypt';
  els.encryptSection.hidden = !isEncrypt;
  els.decryptSection.hidden = isEncrypt;
  els.tabEncrypt.classList.toggle('is-active', isEncrypt);
  els.tabDecrypt.classList.toggle('is-active', !isEncrypt);
  els.tabEncrypt.setAttribute('aria-selected', String(isEncrypt));
  els.tabDecrypt.setAttribute('aria-selected', String(!isEncrypt));
  clearError();
}

/* ==========================================================
   暗号化: 方式・入力の切替
   ========================================================== */

function encMode() {
  return document.querySelector('input[name="enc-mode"]:checked')?.value || 'passphrase';
}

function decMode() {
  return document.querySelector('input[name="dec-mode"]:checked')?.value || 'passphrase';
}

function updateEncModeFields() {
  const keypair = encMode() === 'keypair';
  els.encPassphraseFields.hidden = keypair;
  els.encKeypairFields.hidden = !keypair;
}

function setEncInput(kind) {
  state.encInput = kind;
  const isText = kind === 'text';
  els.encTextPanel.hidden = !isText;
  els.encFilePanel.hidden = isText;
  els.inputTabText.classList.toggle('is-active', isText);
  els.inputTabFile.classList.toggle('is-active', !isText);
  els.inputTabText.setAttribute('aria-selected', String(isText));
  els.inputTabFile.setAttribute('aria-selected', String(!isText));
}

function setDecInput(kind) {
  state.decInput = kind;
  const isFile = kind === 'file';
  els.decFilePanel.hidden = !isFile;
  els.decTextPanel.hidden = isFile;
  els.decInputTabFile.classList.toggle('is-active', isFile);
  els.decInputTabText.classList.toggle('is-active', !isFile);
  els.decInputTabFile.setAttribute('aria-selected', String(isFile));
  els.decInputTabText.setAttribute('aria-selected', String(!isFile));
}

/* ==========================================================
   鍵ペア
   ========================================================== */

async function handleGenerateKeyPair() {
  clearError();
  setBusy(els.genKeypairBtn, true, '生成中…');
  try {
    const { identity, recipient } = await generateKeyPair(getAge());
    state.identity = identity;
    state.recipient = recipient;
    els.recipientOutput.value = recipient;
    els.identityOutput.value = identity;
    els.encRecipient.value = recipient;
    els.keypairResult.hidden = false;
  } catch (error) {
    showError(error.message || '鍵ペアの生成に失敗しました。');
  } finally {
    setBusy(els.genKeypairBtn, false, '鍵ペアを生成');
  }
}

/* ==========================================================
   暗号化
   ========================================================== */

async function handleEncrypt() {
  clearError();
  const age = getAge();
  const mode = encMode();

  let options;
  if (mode === 'passphrase') {
    const check = validatePassphrase(els.encPassphrase.value, els.encPassphraseConfirm.value);
    if (!check.ok) {
      showError(check.error);
      return;
    }
    options = { mode: 'passphrase', passphrase: els.encPassphrase.value };
  } else {
    const recipient = els.encRecipient.value.trim() || state.recipient;
    const check = validateRecipient(recipient);
    if (!check.ok) {
      showError(check.error);
      return;
    }
    options = { mode: 'keypair', recipient };
  }

  let data;
  let baseName;
  if (state.encInput === 'text') {
    const text = els.encText.value;
    if (!text) {
      showError('暗号化するテキストを入力してください。');
      return;
    }
    data = new TextEncoder().encode(text);
    baseName = 'message.txt';
  } else {
    if (!state.encFile) {
      showError('暗号化するファイルを選択してください。');
      return;
    }
    if (state.encFile.size > MAX_INPUT_BYTES) {
      showError(`ファイルが大きすぎます（上限 ${formatBytes(MAX_INPUT_BYTES)}）。`);
      return;
    }
    data = await readFileAsBytes(state.encFile);
    baseName = state.encFile.name;
  }

  setBusy(els.encryptBtn, true, '暗号化中…');
  try {
    const cipher = await encryptBytes(age, options, data);
    state.cipherBytes = cipher;
    state.cipherName = buildAgeFileName(baseName);

    const useArmor = els.encArmorCheck.checked;
    els.encArmorOutputWrap.hidden = !useArmor;
    if (useArmor) {
      els.encArmorOutput.value = armorEncode(age, cipher);
    }
    els.downloadCipherLabel.textContent = useArmor
      ? `${state.cipherName} をダウンロード`
      : `${state.cipherName} をダウンロード`;
    els.encResultMeta.textContent = `${formatBytes(cipher.length)} の age 暗号文を生成しました。`;
    els.encResult.hidden = false;
    els.encResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showError(error.message || '暗号化に失敗しました。');
  } finally {
    setBusy(els.encryptBtn, false, '暗号化する');
  }
}

/* ==========================================================
   復号
   ========================================================== */

async function handleDecrypt() {
  clearError();
  const age = getAge();
  const mode = decMode();

  let options;
  if (mode === 'passphrase') {
    const check = validatePassphrase(els.decPassphrase.value);
    if (!check.ok) {
      showError(check.error);
      return;
    }
    options = { mode: 'passphrase', passphrase: els.decPassphrase.value };
  } else {
    const identity = els.decIdentity.value.trim();
    const check = validateIdentity(identity);
    if (!check.ok) {
      showError(check.error);
      return;
    }
    options = { mode: 'keypair', identity };
  }

  let cipher;
  let baseName;
  try {
    if (state.decInput === 'file') {
      if (!state.decFile) {
        showError('復号する暗号文ファイルを選択してください。');
        return;
      }
      cipher = await readFileAsBytes(state.decFile);
      baseName = state.decFile.name;
    } else {
      const text = els.decArmorInput.value;
      if (!text.trim()) {
        showError('armor テキストを貼り付けてください。');
        return;
      }
      cipher = resolveEncryptedInput(age, { text });
      baseName = 'message.age';
    }
  } catch (error) {
    showError(error.message || '暗号文を読み取れませんでした。');
    return;
  }

  setBusy(els.decryptBtn, true, '復号中…');
  try {
    const plain = await decryptBytes(age, options, cipher);
    state.plainBytes = plain;
    state.plainName = stripAgeExtension(baseName);

    const textLike = isProbablyText(plain);
    els.decTextOutputWrap.hidden = !textLike;
    if (textLike) {
      els.decTextOutput.value = new TextDecoder().decode(plain);
    }
    els.downloadPlainLabel.textContent = `${state.plainName} をダウンロード`;
    els.decResultMeta.textContent = `${formatBytes(plain.length)} を復号しました。`;
    els.decResult.hidden = false;
    els.decResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showError(
      '復号に失敗しました。パスフレーズまたは identity が正しいか、暗号文が壊れていないか確認してください。',
    );
  } finally {
    setBusy(els.decryptBtn, false, '復号する');
  }
}

/* ==========================================================
   ドロップゾーン
   ========================================================== */

function wireDropZone(zone, input, onFile) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
}

function setEncFile(file) {
  state.encFile = file;
  els.encFileName.textContent = file.name;
  els.encFileMeta.textContent = formatBytes(file.size);
  clearError();
}

function setDecFile(file) {
  state.decFile = file;
  els.decFileName.textContent = file.name;
  els.decFileMeta.textContent = formatBytes(file.size);
  clearError();
}

/* ==========================================================
   初期化
   ========================================================== */

function init() {
  // モード
  els.tabEncrypt.addEventListener('click', () => setMode('encrypt'));
  els.tabDecrypt.addEventListener('click', () => setMode('decrypt'));

  // 暗号化方式
  document.querySelectorAll('input[name="enc-mode"]').forEach((radio) => {
    radio.addEventListener('change', updateEncModeFields);
  });
  document.querySelectorAll('input[name="dec-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const keypair = decMode() === 'keypair';
      els.decPassphraseFields.hidden = keypair;
      els.decKeypairFields.hidden = !keypair;
    });
  });

  // 入力切替
  els.inputTabText.addEventListener('click', () => setEncInput('text'));
  els.inputTabFile.addEventListener('click', () => setEncInput('file'));
  els.decInputTabFile.addEventListener('click', () => setDecInput('file'));
  els.decInputTabText.addEventListener('click', () => setDecInput('text'));

  // パスフレーズ表示
  els.encShowPassphrase.addEventListener('change', () => {
    const type = els.encShowPassphrase.checked ? 'text' : 'password';
    els.encPassphrase.type = type;
    els.encPassphraseConfirm.type = type;
  });
  els.decShowPassphrase.addEventListener('change', () => {
    els.decPassphrase.type = els.decShowPassphrase.checked ? 'text' : 'password';
  });

  // 鍵ペア
  els.genKeypairBtn.addEventListener('click', handleGenerateKeyPair);
  els.copyRecipientBtn.addEventListener('click', () => copyText(els.recipientOutput.value, els.copyRecipientBtn));
  els.copyIdentityBtn.addEventListener('click', () => copyText(els.identityOutput.value, els.copyIdentityBtn));
  els.downloadIdentityBtn.addEventListener('click', () =>
    downloadText(els.identityOutput.value, buildIdentityFileName()),
  );
  els.downloadRecipientBtn.addEventListener('click', () =>
    downloadText(els.recipientOutput.value, buildRecipientFileName()),
  );

  // ファイル入力
  wireDropZone(els.encDropZone, els.encFileInput, setEncFile);
  wireDropZone(els.decDropZone, els.decFileInput, setDecFile);

  // identity ファイル読み込み
  els.decIdentityFile.addEventListener('change', async () => {
    const file = els.decIdentityFile.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const kind = classifyKeyValue(text);
      if (kind !== 'identity') {
        showError('選択したファイルは identity（AGE-SECRET-KEY-...）ではありません。');
        return;
      }
      els.decIdentity.value = text.trim();
      clearError();
    } catch (error) {
      showError(error.message || 'identity ファイルを読み込めませんでした。');
    }
  });

  // 実行
  els.encryptBtn.addEventListener('click', handleEncrypt);
  els.decryptBtn.addEventListener('click', handleDecrypt);

  // コピー / ダウンロード
  els.copyArmorBtn.addEventListener('click', () => copyText(els.encArmorOutput.value, els.copyArmorBtn));
  els.copyDecryptedBtn.addEventListener('click', () => copyText(els.decTextOutput.value, els.copyDecryptedBtn));
  els.downloadCipherBtn.addEventListener('click', () => {
    if (!state.cipherBytes) return;
    downloadBytes(state.cipherBytes, state.cipherName);
  });
  els.downloadPlainBtn.addEventListener('click', () => {
    if (!state.plainBytes) return;
    downloadBytes(state.plainBytes, state.plainName);
  });

  // Info モーダル
  els.infoBtn.addEventListener('click', () => {
    els.infoModal.style.display = 'flex';
  });
  els.closeInfoBtn.addEventListener('click', () => {
    els.infoModal.style.display = 'none';
  });
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) els.infoModal.style.display = 'none';
  });

  // 初期表示
  updateEncModeFields();
  setEncInput('text');
  setDecInput('file');

  // 同梱ライブラリの版を控えめに記録
  console.info(`crypto-vault: age-encryption v${AGE_LIB_VERSION} (${AGE_LIB_LICENSE}) ${AGE_LIB_SOURCE}`);
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
