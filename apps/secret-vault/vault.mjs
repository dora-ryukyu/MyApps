/**
 * vault.mjs — ローカル暗号化クレデンシャル管理の純ロジック
 *
 * DOM に依存しない部分だけをまとめる:
 *   - マスターパスフレーズからの鍵導出 (PBKDF2-SHA256) と AES-GCM による vault 全体の暗号化
 *   - vault / エントリのシリアライズ・マイグレーション・正規化
 *   - 検索・タグ絞り込み
 *   - パスワード生成とエントロピー計算
 *   - TOTP (otplib を注入して使うラッパー、RFC 6238 の epoch 秒で検証可能)
 *   - クリップボード自動クリア判定・自動ロック判定
 *   - 書き出し/読み込み (暗号化済み JSON、age 形式)
 *
 * 外部ライブラリは注入する。ブラウザでは window.otplib / window.age を渡し、
 * node --test では npm の otplib / age-encryption を渡す。これにより
 * ネットワークも DOM も無しに round-trip を検証できる。秘密の平文は
 * ディスク (localStorage) には書かず、暗号文コンテナだけを保存する。
 */

/* ==========================================================
   定数
   ========================================================== */

export const APP_ID = 'secret-vault';

/** 暗号文コンテナの形式識別子 (将来の形式変更に備える) */
export const CONTAINER_FORMAT = 'secret-vault/1';

/** localStorage に保存する鍵。値は暗号文コンテナのみ */
export const STORAGE_KEY = 'secret-vault:container';

/** 設定 (ロック時間など) を保存する鍵。秘密は含めない */
export const SETTINGS_KEY = 'secret-vault:settings';

/** vault 本体のスキーマ版 */
export const CURRENT_VAULT_VERSION = 1;

/* --- 鍵導出 (PBKDF2-SHA256) --- */

export const KDF_NAME = 'PBKDF2';
export const KDF_HASH = 'SHA-256';
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 2_000_000;
export const SALT_BYTES = 16;

/** パスフレーズの最低長 */
export const MIN_PASSPHRASE_LENGTH = 8;

/* --- 暗号化 (AES-GCM 256bit) --- */

export const CIPHER_NAME = 'AES-GCM';
export const KEY_LENGTH = 256;
export const IV_BYTES = 12;

/* --- 自動ロック / クリップボード --- */

export const DEFAULT_LOCK_MS = 5 * 60 * 1000;
export const MIN_LOCK_MS = 30 * 1000;
export const MAX_LOCK_MS = 60 * 60 * 1000;

export const DEFAULT_CLIPBOARD_CLEAR_MS = 30 * 1000;

/* --- パスワード生成 --- */

export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128;

export const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER_CHARS = 'abcdefghijklmnopqrstuvwxyz';
export const DIGIT_CHARS = '0123456789';
export const SYMBOL_CHARS = '!@#$%^&*()-_=+[]{};:,.?';
export const AMBIGUOUS_CHARS = 'O0oIl1|';

export const DEFAULT_PASSWORD_OPTIONS = Object.freeze({
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
});

/* ==========================================================
   バイト列 / Base64
   ========================================================== */

export function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (typeof data === 'string') return utf8Encode(data);
  throw new TypeError('Uint8Array / ArrayBuffer / string のみ対応しています。');
}

export function byteLength(data) {
  if (data == null) return 0;
  if (typeof data === 'string') return utf8Encode(data).length;
  if (data.byteLength != null) return data.byteLength;
  return 0;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(text) {
  return textEncoder.encode(String(text ?? ''));
}

export function utf8Decode(bytes) {
  return textDecoder.decode(toUint8Array(bytes));
}

/** Uint8Array を Base64 文字列にする (btoa / Buffer いずれにも依存しない) */
export function bytesToBase64(bytes) {
  const data = toUint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Base64 文字列を Uint8Array にする */
export function base64ToBytes(base64) {
  const binary = atob(String(base64 ?? ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 暗号学的乱数。crypto を注入できる (テスト用) */
export function randomBytes(length, cryptoObj = globalThis.crypto) {
  const n = Math.max(0, Math.floor(Number(length) || 0));
  const out = new Uint8Array(n);
  if (!cryptoObj?.getRandomValues) throw new Error('乱数生成 (crypto.getRandomValues) が利用できません。');
  cryptoObj.getRandomValues(out);
  return out;
}

let idFallbackCounter = 0;

/** エントリ ID を生成する */
export function generateId(cryptoObj = globalThis.crypto) {
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  idFallbackCounter += 1;
  const rand = randomBytes(8, cryptoObj);
  return `e-${Date.now().toString(36)}-${rand[0].toString(16)}${idFallbackCounter.toString(16)}`;
}

/* ==========================================================
   検証・数値
   ========================================================== */

export function clampIterations(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, n));
}

export function clampLockMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LOCK_MS;
  return Math.min(MAX_LOCK_MS, Math.max(MIN_LOCK_MS, Math.round(n)));
}

/**
 * マスターパスフレーズを検証する。
 * 戻り値: { ok: boolean, error: string | null }
 */
export function validatePassphrase(passphrase, confirmation = undefined) {
  const value = typeof passphrase === 'string' ? passphrase : '';
  if (value.length === 0) return { ok: false, error: 'マスターパスフレーズを入力してください。' };
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: `マスターパスフレーズは ${MIN_PASSPHRASE_LENGTH} 文字以上にしてください。` };
  }
  if (confirmation !== undefined && value !== confirmation) {
    return { ok: false, error: '確認用のパスフレーズが一致しません。' };
  }
  return { ok: true, error: null };
}

/** エントリを検証する。title / username / password のいずれかが要る */
export function validateEntry(input = {}) {
  const title = String(input.title ?? '').trim();
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '').trim();
  if (!title && !username && !password) {
    return { ok: false, error: 'サイト名・ユーザー名・パスワードのいずれかを入力してください。' };
  }
  return { ok: true, error: null };
}

/* ==========================================================
   エントリ / vault の正規化・シリアライズ
   ========================================================== */

const asString = (value) => (value == null ? '' : String(value));

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = asString(raw).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * 入力をエントリの形へ正規化する。
 * now / id はテストで固定できるように注入可能。
 */
export function normalizeEntry(input = {}, { now = new Date().toISOString(), id } = {}) {
  const createdAt = input.createdAt || now;
  return {
    id: id || input.id || generateId(),
    title: asString(input.title).trim(),
    username: asString(input.username).trim(),
    password: asString(input.password),
    url: asString(input.url).trim(),
    notes: asString(input.notes),
    totpSecret: asString(input.totpSecret).replace(/\s+/g, '').toUpperCase(),
    tags: normalizeTags(input.tags),
    createdAt,
    updatedAt: input.updatedAt || createdAt,
  };
}

/** vault オブジェクトを正規化する */
export function normalizeVault(vault = {}) {
  const createdAt = vault.createdAt || new Date().toISOString();
  return {
    version: Number(vault.version) || CURRENT_VAULT_VERSION,
    vaultId: vault.vaultId || generateId(),
    createdAt,
    updatedAt: vault.updatedAt || createdAt,
    entries: Array.isArray(vault.entries) ? vault.entries.map((e) => normalizeEntry(e)) : [],
  };
}

/** vault を決定的な JSON 文字列にする */
export function serializeVault(vault) {
  const normalized = normalizeVault(vault);
  return JSON.stringify({
    version: normalized.version,
    vaultId: normalized.vaultId,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    entries: normalized.entries.map((e) => ({
      id: e.id,
      title: e.title,
      username: e.username,
      password: e.password,
      url: e.url,
      notes: e.notes,
      totpSecret: e.totpSecret,
      tags: e.tags,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
  });
}

/**
 * 旧版を現行版へ移行する。未知の新しい版は拒否する。
 * 現行は v1 のみ。v0 (version 欠落) は v1 として読み替える。
 */
export function migrateVault(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('vault の形式が正しくありません。');
  }
  const version = Number(obj.version);
  if (Number.isFinite(version) && version > CURRENT_VAULT_VERSION) {
    throw new Error('このアプリより新しい vault です。アプリを更新してください。');
  }
  const base = { ...obj, version: CURRENT_VAULT_VERSION };
  return normalizeVault(base);
}

/** JSON 文字列 (またはオブジェクト) を vault へ */
export function deserializeVault(json) {
  let obj;
  if (typeof json === 'string') {
    try {
      obj = JSON.parse(json);
    } catch {
      throw new Error('vault の JSON を解析できません。');
    }
  } else {
    obj = json;
  }
  return migrateVault(obj);
}

export function createEmptyVault({ now = new Date().toISOString(), id } = {}) {
  return {
    version: CURRENT_VAULT_VERSION,
    vaultId: id || generateId(),
    createdAt: now,
    updatedAt: now,
    entries: [],
  };
}

/* ==========================================================
   エントリ操作 (イミュータブル)
   ========================================================== */

export function addEntry(vault, input, { now = new Date().toISOString(), id } = {}) {
  const entry = normalizeEntry(input, { now, id });
  return { ...vault, entries: [...vault.entries, entry], updatedAt: now };
}

export function updateEntry(vault, entryId, patch, { now = new Date().toISOString() } = {}) {
  let found = false;
  const entries = vault.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    found = true;
    return normalizeEntry(
      { ...entry, ...patch, id: entry.id, createdAt: entry.createdAt, updatedAt: now },
      { now },
    );
  });
  if (!found) throw new Error('エントリが見つかりません。');
  return { ...vault, entries, updatedAt: now };
}

export function removeEntry(vault, entryId, { now = new Date().toISOString() } = {}) {
  const entries = vault.entries.filter((entry) => entry.id !== entryId);
  if (entries.length === vault.entries.length) throw new Error('エントリが見つかりません。');
  return { ...vault, entries, updatedAt: now };
}

export function findEntry(vault, entryId) {
  return vault.entries.find((entry) => entry.id === entryId) || null;
}

/* ==========================================================
   検索 / タグ
   ========================================================== */

export function collectTags(entries) {
  const set = new Set();
  for (const entry of entries || []) {
    for (const tag of entry.tags || []) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 空白区切りの AND 検索。title / username / url / notes / tags を対象にする */
export function matchesQuery(entry, query) {
  const q = asString(query).trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    entry.title,
    entry.username,
    entry.url,
    entry.notes,
    ...(entry.tags || []),
  ]
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/**
 * エントリを検索・タグ絞り込みする。
 * tags は AND 条件 (すべてを含む)。
 */
export function searchEntries(entries, { query = '', tags = [] } = {}) {
  const tagList = Array.isArray(tags) ? tags : [...tags];
  return (entries || []).filter((entry) => {
    if (!matchesQuery(entry, query)) return false;
    if (tagList.length === 0) return true;
    const set = new Set((entry.tags || []).map((tag) => String(tag).toLowerCase()));
    return tagList.every((tag) => set.has(String(tag).toLowerCase()));
  });
}

/* ==========================================================
   パスワード生成
   ========================================================== */

function poolFor({ upper, lower, digits, symbols, excludeAmbiguous }) {
  const groups = [];
  if (upper) groups.push(UPPER_CHARS);
  if (lower) groups.push(LOWER_CHARS);
  if (digits) groups.push(DIGIT_CHARS);
  if (symbols) groups.push(SYMBOL_CHARS);
  const filter = (chars) =>
    excludeAmbiguous ? [...chars].filter((c) => !AMBIGUOUS_CHARS.includes(c)).join('') : chars;
  return groups.map(filter).filter((chars) => chars.length > 0);
}

/** 選択された文字種の合計文字数を返す */
export function passwordPoolSize(options = {}) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  return poolFor(opts).reduce((sum, chars) => sum + chars.length, 0);
}

/**
 * パスワードを生成する。各文字種から最低 1 文字を保証する。
 * randomValues(length) は 0..255 を返す Uint8Array を渡す (テストで固定可能)。
 */
export function generatePassword(options = {}, randomValues = (n) => randomBytes(n)) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const length = Math.min(
    PASSWORD_MAX_LENGTH,
    Math.max(PASSWORD_MIN_LENGTH, Math.round(Number(opts.length) || DEFAULT_PASSWORD_OPTIONS.length)),
  );
  const groups = poolFor(opts);
  if (groups.length === 0) throw new Error('少なくとも 1 種類の文字を選んでください。');

  const all = groups.join('');
  const pick = (chars, bytes) => {
    // モジュロバイアスを避けるため、バイト列を棄却サンプリングする
    const max = 256 - (256 % chars.length);
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] < max) return chars[bytes[i] % chars.length];
    }
    return chars[bytes[0] % chars.length];
  };
  const pickByte = () => {
    const bytes = randomValues(1);
    return bytes[0];
  };

  const out = [];
  for (const chars of groups) {
    if (out.length >= length) break;
    let ch;
    let guard = 0;
    do {
      ch = pick(chars, [pickByte()]);
      guard += 1;
    } while (out.includes(ch) && guard < 8 && chars.length > out.length);
    out.push(ch);
  }
  while (out.length < length) {
    const bytes = randomValues(4);
    out.push(pick(all, bytes));
  }

  // シャッフル (Fisher-Yates)
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = pickByte() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, length).join('');
}

/** エントロピー (bit) を概算する */
export function computeEntropyBits(options = {}) {
  const opts = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const length = Math.min(
    PASSWORD_MAX_LENGTH,
    Math.max(PASSWORD_MIN_LENGTH, Math.round(Number(opts.length) || DEFAULT_PASSWORD_OPTIONS.length)),
  );
  const pool = passwordPoolSize(opts);
  if (pool <= 1) return 0;
  return Math.round(length * Math.log2(pool) * 10) / 10;
}

/** エントロピーから強度ラベルを返す */
export function strengthLabel(bits) {
  const n = Number(bits) || 0;
  if (n < 50) return { label: '弱', level: 1 };
  if (n < 80) return { label: '中', level: 2 };
  if (n < 120) return { label: '強', level: 3 };
  return { label: '非常に強', level: 4 };
}

/* ==========================================================
   クリップボード自動クリア / 自動ロック
   ========================================================== */

export function clipboardRemainingMs({
  copiedAt,
  now = Date.now(),
  clearAfterMs = DEFAULT_CLIPBOARD_CLEAR_MS,
}) {
  if (!Number.isFinite(copiedAt)) return 0;
  const remain = copiedAt + Math.max(0, Number(clearAfterMs) || 0) - now;
  return remain > 0 ? remain : 0;
}

export function shouldClearClipboard(args) {
  return clipboardRemainingMs(args) <= 0;
}

export function isLocked({ lastActivity, now = Date.now(), lockAfterMs = DEFAULT_LOCK_MS }) {
  if (!Number.isFinite(lastActivity)) return true;
  return now - lastActivity >= Math.max(0, Number(lockAfterMs) || 0);
}

/* ==========================================================
   TOTP (otplib を注入)
   ========================================================== */

export function normalizeTotpSecret(secret) {
  return asString(secret).replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
}

/** Base32 (A-Z2-7) として妥当か。16 文字以上を要求する */
export function isValidTotpSecret(secret) {
  const value = normalizeTotpSecret(secret);
  return value.length >= 16 && /^[A-Z2-7]+$/.test(value);
}

/** period 内の残り秒 (1..period) */
export function totpSecondsRemaining({ period = 30, time = Date.now() } = {}) {
  const p = Number(period) > 0 ? Number(period) : 30;
  const elapsed = ((Number(time) || 0) / 1000) % p;
  const remain = p - elapsed;
  return remain <= 0 ? p : remain;
}

/**
 * TOTP コードを生成する。
 * otplib の functional API (generate) を注入する。
 * time はミリ秒。otplib には epoch (秒) を渡す。
 */
export async function generateTotp(
  otplib,
  { secret, digits = 6, period = 30, algorithm = 'sha1', time = Date.now() } = {},
) {
  if (!otplib || typeof otplib.generate !== 'function') {
    throw new Error('TOTP ライブラリ (otplib) が読み込まれていません。');
  }
  if (!isValidTotpSecret(secret)) {
    throw new Error('TOTP シークレットが Base32 形式 (16 文字以上) ではありません。');
  }
  const epoch = Math.floor((Number(time) || 0) / 1000);
  const code = await otplib.generate({
    secret: normalizeTotpSecret(secret),
    digits: Number(digits) || 6,
    period: Number(period) > 0 ? Number(period) : 30,
    algorithm,
    epoch,
  });
  return {
    code: String(code),
    remaining: totpSecondsRemaining({ period, time }),
    period: Number(period) > 0 ? Number(period) : 30,
    epoch,
  };
}

/** TOTP コードを検証する (時刻ずれ許容 window) */
export async function verifyTotp(
  otplib,
  { secret, token, digits = 6, period = 30, algorithm = 'sha1', epoch, window = 1 } = {},
) {
  if (!otplib || typeof otplib.verify !== 'function') {
    throw new Error('TOTP ライブラリ (otplib) が読み込まれていません。');
  }
  const result = await otplib.verify({
    secret: normalizeTotpSecret(secret),
    token: String(token),
    digits: Number(digits) || 6,
    period: Number(period) > 0 ? Number(period) : 30,
    algorithm,
    ...(Number.isFinite(epoch) ? { epoch: Math.floor(epoch) } : {}),
    window,
  });
  if (typeof result === 'boolean') return result;
  return Boolean(result?.valid);
}

/** otpauth:// URI を解析する */
export function parseOtpauthUri(uri) {
  let url;
  try {
    url = new URL(asString(uri).trim());
  } catch {
    throw new Error('otpauth:// URI を解析できません。');
  }
  if (url.protocol !== 'otpauth:') throw new Error('otpauth:// URI ではありません。');
  const type = url.host.toLowerCase() === 'hotp' ? 'hotp' : 'totp';
  const secret = normalizeTotpSecret(url.searchParams.get('secret'));
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  return {
    type,
    secret,
    issuer: url.searchParams.get('issuer') || '',
    label,
    digits: Number(url.searchParams.get('digits') || 6),
    period: Number(url.searchParams.get('period') || 30),
    algorithm: (url.searchParams.get('algorithm') || 'SHA1').toLowerCase(),
  };
}

/* ==========================================================
   暗号化コンテナ (AES-GCM)
   ========================================================== */

/** パスフレーズから AES-GCM 鍵を導出する */
export async function deriveKeyFromPassphrase(
  passphrase,
  { salt, iterations = DEFAULT_ITERATIONS, crypto: cryptoObj = globalThis.crypto } = {},
) {
  if (!cryptoObj?.subtle) throw new Error('WebCrypto (crypto.subtle) が利用できません。');
  const saltBytes = salt instanceof Uint8Array ? salt : base64ToBytes(salt);
  const baseKey = await cryptoObj.subtle.importKey(
    'raw',
    utf8Encode(String(passphrase ?? '')),
    KDF_NAME,
    false,
    ['deriveKey'],
  );
  return cryptoObj.subtle.deriveKey(
    { name: KDF_NAME, salt: saltBytes, iterations: clampIterations(iterations), hash: KDF_HASH },
    baseKey,
    { name: CIPHER_NAME, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** コンテナの形を検証する */
export function assertContainer(container) {
  if (!container || typeof container !== 'object') {
    throw new Error('vault の暗号文がありません。');
  }
  if (container.format !== CONTAINER_FORMAT) {
    throw new Error('vault の形式が未知です。');
  }
  const { kdf, cipher, data } = container;
  if (!kdf?.salt || !Number.isFinite(Number(kdf.iterations)) || !cipher?.iv || typeof data !== 'string') {
    throw new Error('vault の暗号文が壊れています。');
  }
  return container;
}

export function isContainer(value) {
  try {
    assertContainer(value);
    return true;
  } catch {
    return false;
  }
}

/** 既存の鍵で vault を暗号化してコンテナを返す */
export async function encryptVaultWithKey(
  vault,
  key,
  { salt, iterations = DEFAULT_ITERATIONS, iv, crypto: cryptoObj = globalThis.crypto } = {},
) {
  if (!key) throw new Error('鍵がありません。');
  if (!cryptoObj?.subtle) throw new Error('WebCrypto (crypto.subtle) が利用できません。');
  const saltBytes = salt instanceof Uint8Array ? salt : base64ToBytes(salt || bytesToBase64(randomBytes(SALT_BYTES, cryptoObj)));
  const ivBytes = iv instanceof Uint8Array ? iv : randomBytes(IV_BYTES, cryptoObj);
  const plaintext = utf8Encode(serializeVault(vault));
  const ciphertext = new Uint8Array(
    await cryptoObj.subtle.encrypt({ name: CIPHER_NAME, iv: ivBytes }, key, plaintext),
  );
  return {
    format: CONTAINER_FORMAT,
    kdf: {
      name: KDF_NAME,
      hash: KDF_HASH,
      iterations: clampIterations(iterations),
      salt: bytesToBase64(saltBytes),
    },
    cipher: { name: CIPHER_NAME, iv: bytesToBase64(ivBytes) },
    data: bytesToBase64(ciphertext),
    updatedAt: vault?.updatedAt || new Date().toISOString(),
  };
}

/** 既存の鍵でコンテナを復号する */
export async function decryptVaultWithKey(container, key, { crypto: cryptoObj = globalThis.crypto } = {}) {
  const c = assertContainer(container);
  if (!cryptoObj?.subtle) throw new Error('WebCrypto (crypto.subtle) が利用できません。');
  let plaintext;
  try {
    plaintext = await cryptoObj.subtle.decrypt(
      { name: CIPHER_NAME, iv: base64ToBytes(c.cipher.iv) },
      key,
      base64ToBytes(c.data),
    );
  } catch {
    throw new Error('復号に失敗しました。パスフレーズが違うか、データが壊れています。');
  }
  return deserializeVault(utf8Decode(plaintext));
}

/** パスフレーズから vault を新規暗号化する (salt を生成) */
export async function createVaultContainer(vault, passphrase, options = {}) {
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(check.error);
  const cryptoObj = options.crypto || globalThis.crypto;
  const salt = options.salt instanceof Uint8Array ? options.salt : randomBytes(SALT_BYTES, cryptoObj);
  const iterations = clampIterations(options.iterations);
  const key = await deriveKeyFromPassphrase(passphrase, { salt, iterations, crypto: cryptoObj });
  return encryptVaultWithKey(vault, key, { salt, iterations, crypto: cryptoObj, iv: options.iv });
}

/** パスフレーズでコンテナを開き、鍵と vault を返す */
export async function openVaultContainer(container, passphrase, options = {}) {
  const c = assertContainer(container);
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(check.error);
  const key = await deriveKeyFromPassphrase(passphrase, {
    salt: c.kdf.salt,
    iterations: c.kdf.iterations,
    crypto: options.crypto,
  });
  const vault = await decryptVaultWithKey(c, key, options);
  return { key, vault };
}

/* ==========================================================
   書き出し / 読み込み (age 相互運用)
   ========================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDateStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 暗号化済み JSON のファイル名 */
export function buildExportFileName(date = new Date()) {
  return `secret-vault-${formatDateStamp(date)}.json`;
}

/** age 形式のファイル名 */
export function buildAgeExportFileName(date = new Date()) {
  return `secret-vault-${formatDateStamp(date)}.age`;
}

/** vault を age (パスフレーズ式) で暗号化する。age は注入する */
export async function encryptVaultWithAge(age, vault, passphrase) {
  if (!age || typeof age.Encrypter !== 'function') {
    throw new Error('age ライブラリが読み込まれていません。');
  }
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(check.error);
  const encrypter = new age.Encrypter();
  encrypter.setPassphrase(passphrase);
  return encrypter.encrypt(utf8Encode(serializeVault(vault)));
}

/** age 暗号文を復号して vault を返す。age は注入する */
export async function decryptVaultWithAge(age, bytes, passphrase) {
  if (!age || typeof age.Decrypter !== 'function') {
    throw new Error('age ライブラリが読み込まれていません。');
  }
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(check.error);
  const decrypter = new age.Decrypter();
  decrypter.addPassphrase(passphrase);
  const out = await decrypter.decrypt(toUint8Array(bytes), 'uint8array');
  return deserializeVault(utf8Decode(out));
}
