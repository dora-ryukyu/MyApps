import test from 'node:test';
import assert from 'node:assert/strict';

import * as age from 'age-encryption';

import {
  AGE_HEADER,
  AGE_LIB_LICENSE,
  AGE_LIB_VERSION,
  ARMOR_BEGIN,
  ARMOR_END,
  DEFAULT_SCRYPT_WORK_FACTOR,
  MAX_INPUT_BYTES,
  MAX_SCRYPT_WORK_FACTOR,
  MIN_PASSPHRASE_LENGTH,
  MIN_SCRYPT_WORK_FACTOR,
  armorDecode,
  armorEncode,
  buildAgeFileName,
  buildIdentityFileName,
  byteLength,
  clampScryptWorkFactor,
  classifyKeyValue,
  decryptBytes,
  encryptBytes,
  formatBytes,
  generateKeyPair,
  isAgeCiphertext,
  isProbablyText,
  looksLikeArmor,
  resolveEncryptedInput,
  sanitizeBaseName,
  stripAgeExtension,
  toUint8Array,
  validateIdentity,
  validatePassphrase,
  validateRecipient,
} from '../pipeline.mjs';

/* ==========================================================
   定数 / カタログ
   ========================================================== */

test('同梱ライブラリの版とライセンスを記録している', () => {
  assert.equal(AGE_LIB_VERSION, '0.3.1');
  assert.equal(AGE_LIB_LICENSE, 'BSD-3-Clause');
  assert.equal(AGE_HEADER, 'age-encryption.org/v1');
  assert.equal(ARMOR_BEGIN, '-----BEGIN AGE ENCRYPTED FILE-----');
  assert.equal(ARMOR_END, '-----END AGE ENCRYPTED FILE-----');
  assert.equal(MAX_INPUT_BYTES, 64 * 1024 * 1024);
});

/* ==========================================================
   検証
   ========================================================== */

test('validatePassphrase は長さと一致を確認する', () => {
  assert.equal(validatePassphrase('').ok, false);
  assert.equal(validatePassphrase('short').ok, false);
  assert.equal(validatePassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH)).ok, true);
  const mismatch = validatePassphrase('long-enough-pass', 'different-pass');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /一致/);
  assert.equal(validatePassphrase('long-enough-pass', 'long-enough-pass').ok, true);
});

test('validateIdentity は AGE-SECRET-KEY / AGE-PLUGIN を受け付ける', () => {
  assert.equal(validateIdentity('').ok, false);
  assert.equal(validateIdentity('age1xxxx').ok, false);
  assert.equal(validateIdentity('AGE-SECRET-KEY-1ABCD').ok, true);
  assert.equal(validateIdentity('AGE-SECRET-KEY-PQ-1ABCD').ok, true);
  assert.equal(validateIdentity('AGE-PLUGIN-FIDO2PRF-1ABCD').ok, true);
});

test('validateRecipient は age1 のみ受け付ける', () => {
  assert.equal(validateRecipient('').ok, false);
  assert.equal(validateRecipient('AGE-SECRET-KEY-1ABCD').ok, false);
  assert.equal(validateRecipient('age1something').ok, true);
});

test('classifyKeyValue は入力の種別を判定する', () => {
  assert.equal(classifyKeyValue(''), 'empty');
  assert.equal(classifyKeyValue('AGE-SECRET-KEY-1ABCD'), 'identity');
  assert.equal(classifyKeyValue('AGE-PLUGIN-FIDO2PRF-1ABCD'), 'identity');
  assert.equal(classifyKeyValue('age1abc'), 'recipient');
  assert.equal(classifyKeyValue('hello world'), 'unknown');
});

test('looksLikeArmor は前後の空白を許容する', () => {
  const ok = `\n  ${ARMOR_BEGIN}\nAAAA\n${ARMOR_END}\n`;
  assert.equal(looksLikeArmor(ok), true);
  assert.equal(looksLikeArmor('not armor'), false);
  assert.equal(looksLikeArmor(''), false);
});

/* ==========================================================
   数値・表示
   ========================================================== */

test('clampScryptWorkFactor は [10, 20] に丸め、不正値は既定へ', () => {
  assert.equal(DEFAULT_SCRYPT_WORK_FACTOR, 18);
  assert.equal(clampScryptWorkFactor(18), 18);
  assert.equal(clampScryptWorkFactor(2), MIN_SCRYPT_WORK_FACTOR);
  assert.equal(clampScryptWorkFactor(99), MAX_SCRYPT_WORK_FACTOR);
  assert.equal(clampScryptWorkFactor('12'), 12);
  assert.equal(clampScryptWorkFactor(NaN), DEFAULT_SCRYPT_WORK_FACTOR);
});

test('formatBytes は読みやすい単位にする', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MiB');
  assert.equal(formatBytes(-1), '0 B');
});

test('sanitizeBaseName / buildAgeFileName は安全な名前を作る', () => {
  assert.equal(sanitizeBaseName('secret memo.txt'), 'secret memo');
  assert.equal(sanitizeBaseName('a/b:c*d?.txt'), 'a_b_c_d_');
  assert.equal(sanitizeBaseName(''), 'data');
  assert.equal(buildAgeFileName('secret memo.txt'), 'secret memo.txt.age');
  assert.equal(buildAgeFileName('notes'), 'notes.age');
  assert.equal(buildAgeFileName('archive.age'), 'archive.age');
  assert.equal(buildAgeFileName(''), 'data.age');
});

test('stripAgeExtension は .age を落とす', () => {
  assert.equal(stripAgeExtension('secret.txt.age'), 'secret.txt');
  assert.equal(stripAgeExtension('data.age'), 'data');
  assert.equal(stripAgeExtension('data.bin'), 'data.bin');
  assert.equal(stripAgeExtension(''), 'decrypted');
  assert.equal(buildIdentityFileName(), 'key.txt');
});

/* ==========================================================
   バイト列
   ========================================================== */

test('toUint8Array / byteLength は各入力を扱う', () => {
  assert.deepEqual(Array.from(toUint8Array([1, 2, 3])), [1, 2, 3]);
  assert.equal(toUint8Array(new Uint8Array([1, 2])).length, 2);
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength(new Uint8Array(4)), 4);
  assert.equal(byteLength(null), 0);
  assert.throws(() => toUint8Array(123), /対応/);
});

test('isProbablyText は UTF-8 とバイナリを区別する', () => {
  assert.equal(isProbablyText('hello こんにちは'), true);
  assert.equal(isProbablyText(new Uint8Array([0, 1, 2, 3])), false);
  assert.equal(isProbablyText(new Uint8Array([0xff, 0xfe, 0x00])), false);
  assert.equal(isProbablyText(new Uint8Array(0)), true);
});

/* ==========================================================
   鍵生成
   ========================================================== */

test('generateKeyPair は対応する identity / recipient を返す', async () => {
  const { identity, recipient } = await generateKeyPair(age);
  assert.ok(identity.startsWith('AGE-SECRET-KEY-'));
  assert.ok(recipient.startsWith('age1'));
  assert.equal(await age.identityToRecipient(identity), recipient);
});

/* ==========================================================
   round-trip
   ========================================================== */

test('X25519 の recipient で暗号化し identity で復号できる', async () => {
  const { identity, recipient } = await generateKeyPair(age);
  const plaintext = 'サーバーに送らない秘密のメモ 🔐\nline2';
  const cipher = await encryptBytes(age, { mode: 'keypair', recipient }, plaintext);
  assert.ok(cipher instanceof Uint8Array);
  assert.ok(isAgeCiphertext(cipher), '標準 age 形式ではない');
  const out = await decryptBytes(age, { mode: 'keypair', identity }, cipher);
  assert.equal(new TextDecoder().decode(out), plaintext);
});

test('バイナリも round-trip できる', async () => {
  const { identity, recipient } = await generateKeyPair(age);
  const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 37) & 0xff);
  const cipher = await encryptBytes(age, { mode: 'keypair', recipient }, bytes);
  const out = await decryptBytes(age, { mode: 'keypair', identity }, cipher);
  assert.deepEqual(Array.from(out), Array.from(bytes));
});

test('パスフレーズで暗号化し同じパスフレーズで復号できる', async () => {
  const passphrase = 'correct horse battery staple';
  const cipher = await encryptBytes(
    age,
    { mode: 'passphrase', passphrase, scryptWorkFactor: 10 },
    'メモ',
  );
  assert.ok(isAgeCiphertext(cipher));
  const out = await decryptBytes(age, { mode: 'passphrase', passphrase }, cipher);
  assert.equal(new TextDecoder().decode(out), 'メモ');
});

test('armor encode / decode は round-trip する', async () => {
  const { identity, recipient } = await generateKeyPair(age);
  const cipher = await encryptBytes(age, { mode: 'keypair', recipient }, 'armored');
  const armored = armorEncode(age, cipher);
  assert.ok(armored.startsWith(ARMOR_BEGIN));
  assert.ok(armored.includes(ARMOR_END));
  const decoded = armorDecode(age, armored);
  assert.deepEqual(Array.from(decoded), Array.from(cipher));
  const out = await decryptBytes(age, { mode: 'keypair', identity }, decoded);
  assert.equal(new TextDecoder().decode(out), 'armored');
});

/* ==========================================================
   失敗系
   ========================================================== */

test('誤ったパスフレーズでは復号できない', async () => {
  const cipher = await encryptBytes(
    age,
    { mode: 'passphrase', passphrase: 'the-right-passphrase', scryptWorkFactor: 10 },
    'secret',
  );
  await assert.rejects(
    () => decryptBytes(age, { mode: 'passphrase', passphrase: 'the-wrong-passphrase' }, cipher),
  );
});

test('誤った identity では復号できない', async () => {
  const a = await generateKeyPair(age);
  const b = await generateKeyPair(age);
  const cipher = await encryptBytes(age, { mode: 'keypair', recipient: a.recipient }, 'secret');
  await assert.rejects(
    () => decryptBytes(age, { mode: 'keypair', identity: b.identity }, cipher),
  );
});

test('入力検証に失敗すると暗号化前にエラーになる', async () => {
  await assert.rejects(() => encryptBytes(age, { mode: 'passphrase', passphrase: 'short' }, 'x'), /8 文字/);
  await assert.rejects(() => encryptBytes(age, { mode: 'keypair', recipient: 'not-a-key' }, 'x'), /age1/);
  await assert.rejects(() => decryptBytes(age, { mode: 'keypair', identity: 'age1wrong' }, new Uint8Array([1])), /AGE-SECRET-KEY/);
});

/* ==========================================================
   入力解決
   ========================================================== */

test('resolveEncryptedInput は bytes / armor テキストの両方を扱う', async () => {
  const { identity, recipient } = await generateKeyPair(age);
  const cipher = await encryptBytes(age, { mode: 'keypair', recipient }, 'resolved');
  const fromBytes = resolveEncryptedInput(age, { bytes: cipher });
  assert.deepEqual(Array.from(fromBytes), Array.from(cipher));
  const fromText = resolveEncryptedInput(age, { text: armorEncode(age, cipher) });
  const out = await decryptBytes(age, { mode: 'keypair', identity }, fromText);
  assert.equal(new TextDecoder().decode(out), 'resolved');
  assert.throws(() => resolveEncryptedInput(age, { text: 'plain text' }), /暗号文/);
});

test('isAgeCiphertext は armor テキストを拒否する', () => {
  const header = new TextEncoder().encode(`${AGE_HEADER}\nrest`);
  assert.equal(isAgeCiphertext(header), true);
  assert.equal(isAgeCiphertext(new TextEncoder().encode('not age')), false);
});
