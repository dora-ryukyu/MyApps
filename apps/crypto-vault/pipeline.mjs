/**
 * pipeline.mjs — age 互換の暗号化 / 復号アプリの純ロジック
 *
 * DOM に依存しない部分だけをまとめる:
 *   - パスフレーズ / identity / recipient の検証
 *   - 鍵入力の種別判定 (identity か recipient か armor か)
 *   - scrypt work factor の丸め
 *   - ファイル名・バイト表示の整形
 *   - age-encryption を注入して使う暗号化 / 復号 / armor のラッパー
 *
 * age ライブラリ本体は第1引数で受け取る。ブラウザでは vendor/age.js が
 * 作る window.age を、node --test では npm の age-encryption を渡す。
 * これにより DOM もバンドラも無しに round-trip を検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

export const APP_ID = 'crypto-vault';

/** 同梱した age-encryption の版と出典 (監査用) */
export const AGE_LIB_VERSION = '0.3.1';
export const AGE_LIB_LICENSE = 'BSD-3-Clause';
export const AGE_LIB_SOURCE = 'https://github.com/FiloSottile/typage';

/** 標準 age 形式のヘッダ。ciphertext はこれで始まる */
export const AGE_HEADER = 'age-encryption.org/v1';

/** ASCII armor の区切り */
export const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
export const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

/** identity / recipient の接頭辞 */
export const IDENTITY_PREFIX = 'AGE-SECRET-KEY-';
export const HYBRID_IDENTITY_PREFIX = 'AGE-SECRET-KEY-PQ-';
export const FIDO2_IDENTITY_PREFIX = 'AGE-PLUGIN-FIDO2PRF-';
export const RECIPIENT_PREFIX = 'age1';

/** パスフレーズの最低長 (ライブラリ推奨の下限) */
export const MIN_PASSPHRASE_LENGTH = 8;

/** scrypt の work factor (logN)。ライブラリ既定 18 / 上限 20 */
export const DEFAULT_SCRYPT_WORK_FACTOR = 18;
export const MIN_SCRYPT_WORK_FACTOR = 10;
export const MAX_SCRYPT_WORK_FACTOR = 20;

/** メモリに載せて扱う入力の上限 (64MiB) */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/* ==========================================================
   数値・検証
   ========================================================== */

/** scrypt work factor を [10, 20] に丸める */
export function clampScryptWorkFactor(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SCRYPT_WORK_FACTOR;
  return Math.min(MAX_SCRYPT_WORK_FACTOR, Math.max(MIN_SCRYPT_WORK_FACTOR, n));
}

/**
 * パスフレーズを検証する。
 * 戻り値: { ok: boolean, error: string | null }
 */
export function validatePassphrase(passphrase, confirmation = undefined) {
  const value = typeof passphrase === 'string' ? passphrase : '';
  if (value.length === 0) return { ok: false, error: 'パスフレーズを入力してください。' };
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: `パスフレーズは ${MIN_PASSPHRASE_LENGTH} 文字以上にしてください。` };
  }
  if (confirmation !== undefined && value !== confirmation) {
    return { ok: false, error: '確認用のパスフレーズが一致しません。' };
  }
  return { ok: true, error: null };
}

/** identity 文字列を検証する */
export function validateIdentity(identity) {
  const value = typeof identity === 'string' ? identity.trim() : '';
  if (!value) return { ok: false, error: 'identity (秘密鍵) を入力してください。' };
  if (
    !value.startsWith(IDENTITY_PREFIX) &&
    !value.startsWith(HYBRID_IDENTITY_PREFIX) &&
    !value.startsWith(FIDO2_IDENTITY_PREFIX)
  ) {
    return { ok: false, error: 'identity は AGE-SECRET-KEY- / AGE-PLUGIN- で始まる必要があります。' };
  }
  return { ok: true, error: null };
}

/** recipient (公開鍵) 文字列を検証する */
export function validateRecipient(recipient) {
  const value = typeof recipient === 'string' ? recipient.trim() : '';
  if (!value) return { ok: false, error: 'recipient (公開鍵) を入力するか、鍵ペアを生成してください。' };
  if (!value.startsWith(RECIPIENT_PREFIX)) {
    return { ok: false, error: 'recipient は age1 で始まる必要があります。' };
  }
  return { ok: true, error: null };
}

/**
 * 入力文字列の種別を判定する。
 * 'identity' | 'recipient' | 'armor' | 'unknown' | 'empty'
 */
export function classifyKeyValue(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return 'empty';
  if (
    value.startsWith(IDENTITY_PREFIX) ||
    value.startsWith(HYBRID_IDENTITY_PREFIX) ||
    value.startsWith(FIDO2_IDENTITY_PREFIX)
  ) {
    return 'identity';
  }
  if (value.startsWith(RECIPIENT_PREFIX)) return 'recipient';
  if (looksLikeArmor(value)) return 'armor';
  return 'unknown';
}

/** ASCII armor のテキストかどうか (前後の空白は許容) */
export function looksLikeArmor(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.startsWith(ARMOR_BEGIN) && value.includes(ARMOR_END);
}

/* ==========================================================
   表示・ファイル名
   ========================================================== */

export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

/** 元のファイル名から安全なベース名を作る */
export function sanitizeBaseName(name) {
  const raw = String(name || '').replace(/[\\/]+$/, '').replace(/\.[^./\\]+$/, '');
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return safe || 'data';
}

/** 暗号文のファイル名。foo.txt → foo.txt.age */
export function buildAgeFileName(name) {
  const raw = String(name || '').trim();
  const base = raw.replace(/[\\/]+$/, '') || 'data';
  if (base.toLowerCase().endsWith('.age')) return base;
  return `${base}.age`;
}

/** identity のファイル名 (age の慣例に合わせる) */
export function buildIdentityFileName() {
  return 'key.txt';
}

/** 復号結果のファイル名。foo.txt.age → foo.txt / armor なら .age を落とす */
export function stripAgeExtension(name) {
  const raw = String(name || '').trim().replace(/[\\/]+$/, '');
  if (!raw) return 'decrypted';
  if (raw.toLowerCase().endsWith('.age')) return raw.slice(0, -4) || 'decrypted';
  return raw;
}

/** identity を安全に保管するための拡張子付きファイル名 */
export function buildRecipientFileName() {
  return 'recipient.txt';
}

/* ==========================================================
   バイト列ユーティリティ
   ========================================================== */

/** Uint8Array / ArrayBuffer / string を Uint8Array にする */
export function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new TypeError('Uint8Array / ArrayBuffer / string のみ対応しています。');
}

export function byteLength(data) {
  if (data == null) return 0;
  if (typeof data === 'string') return new TextEncoder().encode(data).length;
  if (data.byteLength != null) return data.byteLength;
  return 0;
}

/**
 * UTF-8 テキストとして表示して安全かどうかを判定する。
 * NUL や不正な UTF-8 を含む場合はバイナリ扱い。
 */
export function isProbablyText(bytes) {
  const data = toUint8Array(bytes);
  if (data.length === 0) return true;
  if (data.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    // 制御文字 (タブ・改行・復帰を除く) が多ければバイナリとみなす
    const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g);
    return !control || control.length <= text.length / 100;
  } catch {
    return false;
  }
}

/* ==========================================================
   age ライブラリのラッパー (age は注入)
   ========================================================== */

function assertAge(age) {
  if (!age || typeof age.generateIdentity !== 'function' || typeof age.Encrypter !== 'function') {
    throw new Error('age ライブラリが読み込まれていません。');
  }
}

/** X25519 の identity / recipient を生成する */
export async function generateKeyPair(age) {
  assertAge(age);
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * データを暗号化する。
 * options: { mode: 'passphrase'|'keypair', passphrase?, recipient?, scryptWorkFactor? }
 * 戻り値: Uint8Array (標準 age 形式)
 */
export async function encryptBytes(age, options, data) {
  assertAge(age);
  const input = toUint8Array(data);
  const encrypter = new age.Encrypter();
  if (options?.mode === 'passphrase') {
    const check = validatePassphrase(options.passphrase);
    if (!check.ok) throw new Error(check.error);
    encrypter.setPassphrase(options.passphrase);
    if (options.scryptWorkFactor != null) {
      encrypter.setScryptWorkFactor(clampScryptWorkFactor(options.scryptWorkFactor));
    }
  } else {
    const check = validateRecipient(options?.recipient);
    if (!check.ok) throw new Error(check.error);
    encrypter.addRecipient(options.recipient.trim());
  }
  return encrypter.encrypt(input);
}

/**
 * データを復号する。
 * options: { mode: 'passphrase'|'keypair', passphrase?, identity? }
 * 戻り値: Uint8Array
 */
export async function decryptBytes(age, options, data) {
  assertAge(age);
  const input = toUint8Array(data);
  const decrypter = new age.Decrypter();
  if (options?.mode === 'passphrase') {
    const check = validatePassphrase(options.passphrase);
    if (!check.ok) throw new Error(check.error);
    decrypter.addPassphrase(options.passphrase);
  } else {
    const check = validateIdentity(options?.identity);
    if (!check.ok) throw new Error(check.error);
    decrypter.addIdentity(options.identity.trim());
  }
  return decrypter.decrypt(input, 'uint8array');
}

/** 暗号文を ASCII armor (テキスト) にする */
export function armorEncode(age, bytes) {
  assertAge(age);
  return age.armor.encode(toUint8Array(bytes));
}

/** ASCII armor のテキストを暗号文に戻す */
export function armorDecode(age, text) {
  assertAge(age);
  return age.armor.decode(String(text ?? ''));
}

/**
 * 復号の入力を解決する。
 * bytes があればそれを使い、無ければ armor テキストとしてデコードする。
 */
export function resolveEncryptedInput(age, { bytes = null, text = '' } = {}) {
  if (bytes && byteLength(bytes) > 0) return toUint8Array(bytes);
  if (looksLikeArmor(text)) return armorDecode(age, text);
  throw new Error('暗号文がありません。ファイルを選ぶか、armor テキストを貼り付けてください。');
}

/** 標準 age 形式かどうか (先頭ヘッダの確認) */
export function isAgeCiphertext(bytes) {
  const data = toUint8Array(bytes);
  const head = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, AGE_HEADER.length));
  return head === AGE_HEADER;
}
