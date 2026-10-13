import test from 'node:test';
import assert from 'node:assert/strict';

import * as age from 'age-encryption';
import { generate, verify } from 'otplib';

import {
  CONTAINER_FORMAT,
  CURRENT_VAULT_VERSION,
  DEFAULT_ITERATIONS,
  DEFAULT_PASSWORD_OPTIONS,
  KDF_HASH,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  addEntry,
  base64ToBytes,
  buildAgeExportFileName,
  buildExportFileName,
  bytesToBase64,
  clipboardRemainingMs,
  collectTags,
  computeEntropyBits,
  createEmptyVault,
  createVaultContainer,
  decryptVaultWithAge,
  decryptVaultWithKey,
  deriveKeyFromPassphrase,
  deserializeVault,
  encryptVaultWithAge,
  encryptVaultWithKey,
  findEntry,
  generateId,
  generatePassword,
  generateTotp,
  isContainer,
  isLocked,
  isValidTotpSecret,
  matchesQuery,
  migrateVault,
  normalizeEntry,
  normalizeTags,
  normalizeTotpSecret,
  openVaultContainer,
  parseOtpauthUri,
  removeEntry,
  searchEntries,
  serializeVault,
  shouldClearClipboard,
  strengthLabel,
  totpSecondsRemaining,
  updateEntry,
  validateEntry,
  validatePassphrase,
  verifyTotp,
} from '../vault.mjs';

/* ==========================================================
   ヘルパー
   ========================================================== */

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"

/** 決定的な乱数 (テスト用) */
function seededRandom(seed = 1) {
  let s = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out[i] = (s >>> 16) & 0xff;
    }
    return out;
  };
}

function entryInput(overrides = {}) {
  return {
    title: 'GitHub',
    username: 'dora',
    password: 'p@ssw0rd',
    url: 'https://github.com',
    notes: 'personal account',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    tags: ['dev', 'api'],
    ...overrides,
  };
}

/* ==========================================================
   定数 / エンコード
   ========================================================== */

test('定数はこのアプリの形式を表す', () => {
  assert.equal(CONTAINER_FORMAT, 'secret-vault/1');
  assert.equal(CURRENT_VAULT_VERSION, 1);
  assert.equal(KDF_HASH, 'SHA-256');
  assert.equal(MIN_PASSPHRASE_LENGTH, 8);
  assert.ok(DEFAULT_ITERATIONS >= MIN_ITERATIONS && DEFAULT_ITERATIONS <= MAX_ITERATIONS);
});

test('Base64 は往復でき、UTF-8 の日本語も壊れない', () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);

  const text = 'パスワード🔐';
  const round = new TextDecoder().decode(base64ToBytes(bytesToBase64(new TextEncoder().encode(text))));
  assert.equal(round, text);
});

test('generateId は衝突しない id を返す', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateId()));
  assert.equal(ids.size, 50);
});

/* ==========================================================
   検証
   ========================================================== */

test('validatePassphrase は長さと一致を確認する', () => {
  assert.equal(validatePassphrase('').ok, false);
  assert.equal(validatePassphrase('short').ok, false);
  assert.equal(validatePassphrase('abcdefgh').ok, true);
  assert.equal(validatePassphrase('abcdefgh', 'abcdefgh').ok, true);
  assert.equal(validatePassphrase('abcdefgh', 'different').ok, false);
});

test('validateEntry は空エントリを拒否し、いずれかがあれば通す', () => {
  assert.equal(validateEntry({}).ok, false);
  assert.equal(validateEntry({ title: '  ' }).ok, false);
  assert.equal(validateEntry({ username: 'user' }).ok, true);
  assert.equal(validateEntry({ password: 'x' }).ok, true);
});

/* ==========================================================
   正規化 / シリアライズ
   ========================================================== */

test('normalizeTags は重複・空白を除去し順序を保つ', () => {
  assert.deepEqual(normalizeTags('dev, api , Dev ,, 銀行'), ['dev', 'api', '銀行']);
  assert.deepEqual(normalizeTags(['a', 'A', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('normalizeEntry は既定値を埋め、TOTP シークレットを正規化する', () => {
  const entry = normalizeEntry(
    { title: ' X ', tags: 'a,b', totpSecret: 'jbsw y3dp ehpk 3pxp' },
    { now: '2026-01-02T00:00:00.000Z', id: 'e1' },
  );
  assert.equal(entry.id, 'e1');
  assert.equal(entry.title, 'X');
  assert.deepEqual(entry.tags, ['a', 'b']);
  assert.equal(entry.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(entry.createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(entry.updatedAt, '2026-01-02T00:00:00.000Z');
});

test('serializeVault / deserializeVault は往復できる', () => {
  const vault = createEmptyVault({ id: 'v1', now: '2026-01-01T00:00:00.000Z' });
  const withEntry = addEntry(vault, entryInput(), { id: 'e1', now: '2026-01-01T00:00:01.000Z' });
  const parsed = deserializeVault(serializeVault(withEntry));
  assert.equal(parsed.vaultId, 'v1');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'GitHub');
  assert.deepEqual(parsed.entries[0].tags, ['dev', 'api']);
});

test('migrateVault は version 欠落を v1 として読み、未知の新版を拒否する', () => {
  const migrated = migrateVault({ vaultId: 'v', entries: [{ title: 'a' }] });
  assert.equal(migrated.version, CURRENT_VAULT_VERSION);
  assert.equal(migrated.entries.length, 1);

  assert.throws(() => migrateVault({ version: 99, entries: [] }), /新しい vault/);
  assert.throws(() => deserializeVault('{ not json'), /解析できません/);
  assert.throws(() => migrateVault(null), /形式が正しくありません/);
});

/* ==========================================================
   エントリ操作 / 検索
   ========================================================== */

test('addEntry / updateEntry / removeEntry / findEntry', () => {
  let vault = createEmptyVault({ id: 'v1' });
  vault = addEntry(vault, entryInput(), { id: 'e1', now: '2026-01-01T00:00:00.000Z' });
  vault = addEntry(vault, entryInput({ title: '銀行' }), { id: 'e2' });
  assert.equal(vault.entries.length, 2);
  assert.equal(findEntry(vault, 'e1').title, 'GitHub');

  vault = updateEntry(vault, 'e1', { password: 'newpass' }, { now: '2026-01-02T00:00:00.000Z' });
  assert.equal(findEntry(vault, 'e1').password, 'newpass');
  assert.equal(findEntry(vault, 'e1').updatedAt, '2026-01-02T00:00:00.000Z');
  // 元の値は変わらない (イミュータブル)
  assert.notEqual(findEntry(vault, 'e1').createdAt, '2026-01-02T00:00:00.000Z');

  vault = removeEntry(vault, 'e2');
  assert.equal(vault.entries.length, 1);
  assert.throws(() => updateEntry(vault, 'missing', {}), /見つかりません/);
  assert.throws(() => removeEntry(vault, 'missing'), /見つかりません/);
});

test('searchEntries は AND 検索とタグの AND 絞り込み (大小文字を無視)', () => {
  const entries = [
    normalizeEntry(entryInput({ title: 'GitHub', tags: ['dev', 'api'] }), { id: 'a' }),
    normalizeEntry(entryInput({ title: 'GitLab', username: 'work', url: 'https://gitlab.com', tags: ['dev'] }), { id: 'b' }),
    normalizeEntry(entryInput({ title: '銀行', username: 'me', url: 'https://bank.example', notes: '貯蓄', tags: ['finance'] }), { id: 'c' }),
  ];

  assert.equal(searchEntries(entries, { query: 'git' }).length, 2);
  assert.equal(searchEntries(entries, { query: 'work' }).length, 1);
  assert.equal(searchEntries(entries, { query: 'github dev' }).length, 1);
  assert.equal(searchEntries(entries, { tags: ['dev'] }).length, 2);
  assert.equal(searchEntries(entries, { tags: ['dev', 'api'] }).length, 1);
  assert.equal(searchEntries(entries, { tags: ['DEV'] }).length, 2, 'タグは大小文字を無視');
  assert.equal(searchEntries(entries, { query: '不存在' }).length, 0);
  assert.equal(matchesQuery(entries[0], ''), true);
});

test('collectTags は一意なタグを昇順で返す', () => {
  const entries = [
    normalizeEntry({ tags: ['b', 'a'] }),
    normalizeEntry({ tags: ['a', 'c'] }),
  ];
  assert.deepEqual(collectTags(entries), ['a', 'b', 'c']);
});

/* ==========================================================
   パスワード生成
   ========================================================== */

test('generatePassword は指定長で各文字種を 1 文字以上含む', () => {
  const opts = { length: 32, upper: true, lower: true, digits: true, symbols: true };
  for (let seed = 1; seed <= 20; seed += 1) {
    const pw = generatePassword(opts, seededRandom(seed));
    assert.equal(pw.length, 32);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[!@#$%^&*()\-_=+\[\]{};:,.?]/);
  }
});

test('generatePassword は文字種を絞るとその文字だけになる', () => {
  const pw = generatePassword(
    { length: 20, upper: false, lower: false, digits: true, symbols: false },
    seededRandom(7),
  );
  assert.match(pw, /^[0-9]{20}$/);

  const lower = generatePassword(
    { length: 12, upper: false, lower: true, digits: false, symbols: false },
    seededRandom(3),
  );
  assert.match(lower, /^[a-z]{12}$/);
});

test('generatePassword は紛らわしい文字を除外できる', () => {
  const pw = generatePassword(
    { length: 60, upper: true, lower: true, digits: true, symbols: false, excludeAmbiguous: true },
    seededRandom(11),
  );
  assert.doesNotMatch(pw, /[O0oIl1|]/);
});

test('generatePassword は文字種が無いと例外を投げる', () => {
  assert.throws(
    () => generatePassword({ upper: false, lower: false, digits: false, symbols: false }),
    /1 種類/,
  );
});

test('長さは範囲内へ丸められる', () => {
  const tooShort = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 1 }, seededRandom(1));
  assert.equal(tooShort.length, 4);
  const tooLong = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 9999 }, seededRandom(1));
  assert.equal(tooLong.length, 128);
});

test('computeEntropyBits と strengthLabel', () => {
  const bits = computeEntropyBits({ length: 20, upper: true, lower: true, digits: true, symbols: true });
  assert.ok(bits > 100);
  assert.equal(computeEntropyBits({ length: 8, upper: false, lower: true, digits: false, symbols: false }), Math.round(8 * Math.log2(26) * 10) / 10);

  assert.equal(strengthLabel(10).label, '弱');
  assert.equal(strengthLabel(60).label, '中');
  assert.equal(strengthLabel(100).label, '強');
  assert.equal(strengthLabel(200).label, '非常に強');
});

/* ==========================================================
   クリップボード / 自動ロック
   ========================================================== */

test('clipboardRemainingMs / shouldClearClipboard', () => {
  assert.equal(clipboardRemainingMs({ copiedAt: 1000, now: 5000, clearAfterMs: 10000 }), 6000);
  assert.equal(clipboardRemainingMs({ copiedAt: 1000, now: 12000, clearAfterMs: 10000 }), 0);
  assert.equal(shouldClearClipboard({ copiedAt: 1000, now: 12000, clearAfterMs: 10000 }), true);
  assert.equal(shouldClearClipboard({ copiedAt: 1000, now: 5000, clearAfterMs: 10000 }), false);
  assert.equal(shouldClearClipboard({ copiedAt: Number.NaN, now: 5000 }), true);
});

test('isLocked は最終操作からの経過で判定する', () => {
  assert.equal(isLocked({ lastActivity: 1000, now: 1000 + 300000, lockAfterMs: 300000 }), true);
  assert.equal(isLocked({ lastActivity: 1000, now: 1000 + 299999, lockAfterMs: 300000 }), false);
  assert.equal(isLocked({ lastActivity: Number.NaN }), true);
});

/* ==========================================================
   TOTP
   ========================================================== */

test('isValidTotpSecret / normalizeTotpSecret', () => {
  assert.equal(isValidTotpSecret('JBSWY3DPEHPK3PXP'), true);
  assert.equal(isValidTotpSecret('jbsw y3dp ehpk 3pxp'), true);
  assert.equal(isValidTotpSecret('short'), false);
  assert.equal(isValidTotpSecret('!!!!notbase32!!!!'), false);
  assert.equal(normalizeTotpSecret('jbsw y3dp='), 'JBSWY3DP');
});

test('totpSecondsRemaining は 1..period を返す', () => {
  assert.equal(totpSecondsRemaining({ period: 30, time: 0 }), 30);
  assert.equal(totpSecondsRemaining({ period: 30, time: 1000 }), 29);
  assert.equal(totpSecondsRemaining({ period: 30, time: 30000 }), 30);
  assert.equal(totpSecondsRemaining({ period: 30, time: 59000 }), 1);
  assert.ok(Math.abs(totpSecondsRemaining({ period: 30, time: 59500 }) - 0.5) < 1e-9);
});

test('generateTotp は RFC 6238 のテストベクタに一致する', async () => {
  const cases = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  for (const [seconds, expected] of cases) {
    const { code, epoch } = await generateTotp({ generate }, {
      secret: RFC_SECRET,
      digits: 8,
      algorithm: 'sha1',
      time: seconds * 1000,
    });
    assert.equal(code, expected, `${seconds} 秒のコード`);
    assert.equal(epoch, seconds);
  }
});

test('generateTotp / verifyTotp は不正な入力を拒否する', async () => {
  await assert.rejects(() => generateTotp({}, { secret: RFC_SECRET }), /TOTP ライブラリ/);
  await assert.rejects(() => generateTotp({ generate }, { secret: 'short' }), /Base32/);

  const valid = await verifyTotp({ verify }, {
    secret: RFC_SECRET,
    token: '94287082',
    digits: 8,
    epoch: 59,
  });
  assert.equal(valid, true);
  const invalid = await verifyTotp({ verify }, {
    secret: RFC_SECRET,
    token: '00000000',
    digits: 8,
    epoch: 59,
  });
  assert.equal(invalid, false);
});

test('parseOtpauthUri は各パラメータを取り出す', () => {
  const parsed = parseOtpauthUri(
    'otpauth://totp/MyApps:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=MyApps&digits=8&period=60&algorithm=SHA256',
  );
  assert.equal(parsed.type, 'totp');
  assert.equal(parsed.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(parsed.issuer, 'MyApps');
  assert.equal(parsed.label, 'MyApps:me@example.com');
  assert.equal(parsed.digits, 8);
  assert.equal(parsed.period, 60);
  assert.equal(parsed.algorithm, 'sha256');
  assert.throws(() => parseOtpauthUri('https://example.com'), /otpauth/);
});

/* ==========================================================
   暗号化コンテナ
   ========================================================== */

test('createVaultContainer / openVaultContainer は往復できる', async () => {
  const vault = addEntry(createEmptyVault({ id: 'v1' }), entryInput(), { id: 'e1' });
  const container = await createVaultContainer(vault, 'master-pass', {
    salt: new Uint8Array(16).fill(7),
  });

  assert.equal(container.format, CONTAINER_FORMAT);
  assert.equal(container.kdf.name, 'PBKDF2');
  assert.equal(container.kdf.hash, 'SHA-256');
  assert.ok(container.kdf.iterations >= MIN_ITERATIONS);
  assert.ok(typeof container.cipher.iv === 'string');
  assert.ok(typeof container.data === 'string');

  const { vault: opened } = await openVaultContainer(container, 'master-pass');
  assert.equal(opened.entries[0].title, 'GitHub');
  assert.equal(opened.entries[0].username, 'dora');
});

test('暗号文コンテナに平文の秘密が含まれない', async () => {
  const vault = addEntry(createEmptyVault({ id: 'v1' }), entryInput({ password: 'SUPER_SECRET_123' }), {
    id: 'e1',
  });
  const container = await createVaultContainer(vault, 'master-pass');
  const json = JSON.stringify(container);
  assert.ok(!json.includes('SUPER_SECRET_123'));
  assert.ok(!json.includes('https://github.com'));
  assert.ok(!json.includes('personal account'));
});

test('間違ったパスフレーズでは復号できない', async () => {
  const vault = createEmptyVault({ id: 'v1' });
  const container = await createVaultContainer(vault, 'master-pass');
  await assert.rejects(() => openVaultContainer(container, 'wrong-pass'), /復号に失敗/);
});

test('コンテナ検証 (assertContainer / isContainer)', async () => {
  assert.equal(isContainer({ format: CONTAINER_FORMAT, kdf: {}, cipher: {}, data: '' }), false);
  assert.equal(isContainer(null), false);
  const container = await createVaultContainer(createEmptyVault(), 'master-pass');
  assert.equal(isContainer(container), true);
  await assert.rejects(() => decryptVaultWithKey({ format: 'other' }, null), /未知/);
});

test('鍵導出の反復回数は範囲に丸められる', async () => {
  const salt = new Uint8Array(16).fill(1);
  const key = await deriveKeyFromPassphrase('master-pass', { salt, iterations: 1 });
  const container = await encryptVaultWithKey(createEmptyVault(), key, { salt, iterations: 1 });
  assert.equal(container.kdf.iterations, MIN_ITERATIONS);
});

test('encryptVaultWithKey / decryptVaultWithKey は同じ鍵で往復できる', async () => {
  const salt = new Uint8Array(16).fill(9);
  const key = await deriveKeyFromPassphrase('master-pass', { salt, iterations: MIN_ITERATIONS });
  const vault = addEntry(createEmptyVault({ id: 'v1' }), entryInput(), { id: 'e1' });
  const container = await encryptVaultWithKey(vault, key, { salt, iterations: MIN_ITERATIONS });
  const opened = await decryptVaultWithKey(container, key);
  assert.equal(opened.entries[0].title, 'GitHub');
  assert.equal(container.kdf.salt, bytesToBase64(salt));
});

/* ==========================================================
   書き出し / 読み込み (age)
   ========================================================== */

test('書き出しファイル名を組み立てる', () => {
  const date = new Date('2026-10-13T12:00:00+09:00');
  assert.equal(buildExportFileName(date), 'secret-vault-20261013.json');
  assert.equal(buildAgeExportFileName(date), 'secret-vault-20261013.age');
});

test('age で vault を往復できる', async () => {
  const vault = addEntry(createEmptyVault({ id: 'v1' }), entryInput(), { id: 'e1' });
  const bytes = await encryptVaultWithAge(age, vault, 'master-pass');
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);
  const opened = await decryptVaultWithAge(age, bytes, 'master-pass');
  assert.equal(opened.entries[0].username, 'dora');

  await assert.rejects(() => decryptVaultWithAge(age, bytes, 'wrong-pass'));
  await assert.rejects(() => encryptVaultWithAge(null, vault, 'master-pass'), /age ライブラリ/);
});
