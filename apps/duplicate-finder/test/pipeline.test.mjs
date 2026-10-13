import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_SIZE,
  DEFAULT_SIMILAR_THRESHOLD,
  DHASH_HEX_LENGTH,
  REPORT_APP,
  REPORT_VERSION,
  extensionOf,
  isImageName,
  isImageFile,
  formatBytes,
  shortenPath,
  splitFileName,
  uniqueName,
  hexEncode,
  hexToBytes,
  sha256Hex,
  chunkRanges,
  candidateKey,
  groupCandidates,
  groupExact,
  grayFromRGBA,
  resampleGray,
  dHash,
  hammingDistance,
  similarityPercent,
  isSimilar,
  clusterBySimilarity,
  defaultKeepId,
  summarizeGroups,
  planMoves,
  buildReport,
  groupsToJSON,
  groupsFromJSON,
  escapeCsv,
  rowsToCSV,
  reportToRows,
} from '../pipeline.mjs';

/* ---------- ヘルパー ---------- */

function gradientGray(width, height, step = 6) {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = Math.min(255, x * step);
    }
  }
  return gray;
}

function fileEntry(id, size, head = '', tail = '', full = '') {
  return { id, name: `${id}.bin`, path: id, size, headHash: head, tailHash: tail, fullHash: full };
}

/* ---------- ファイル判定 ---------- */

test('extensionOf と isImageName / isImageFile', () => {
  assert.equal(extensionOf('photo.JPG'), 'jpg');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('.hidden'), '');

  assert.equal(isImageName('a.png'), true);
  assert.equal(isImageName('a.WEBP'), true);
  assert.equal(isImageName('a.txt'), false);

  assert.equal(isImageFile({ name: 'a.txt', type: 'image/png' }), true);
  assert.equal(isImageFile({ name: 'a.png', type: '' }), true);
  assert.equal(isImageFile({ name: 'a.txt', type: 'text/plain' }), false);
  assert.equal(isImageFile(null), false);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(-5), '0 B');
});

test('shortenPath は末尾を残す', () => {
  assert.equal(shortenPath('short', 32), 'short');
  const long = 'a'.repeat(80) + '/file.txt';
  const short = shortenPath(long, 20);
  assert.ok(short.startsWith('…'));
  assert.ok(short.length <= 20);
  assert.ok(short.endsWith('/file.txt'));
});

test('splitFileName と uniqueName は同名衝突を回避する', () => {
  assert.deepEqual(splitFileName('a.txt'), { base: 'a', ext: '.txt' });
  assert.deepEqual(splitFileName('notes'), { base: 'notes', ext: '' });
  assert.deepEqual(splitFileName('.gitignore'), { base: '.gitignore', ext: '' });

  assert.equal(uniqueName('a.txt', []), 'a.txt');
  assert.equal(uniqueName('a.txt', ['a.txt']), 'a (1).txt');
  assert.equal(uniqueName('a.txt', ['a.txt', 'a (1).txt']), 'a (2).txt');
  // 大文字小文字を区別しない
  assert.equal(uniqueName('A.TXT', ['a.txt']), 'A (1).TXT');
  // 拡張子なし
  assert.equal(uniqueName('notes', new Set(['notes'])), 'notes (1)');
});

/* ---------- バイト列 / ハッシュ ---------- */

test('hexEncode / hexToBytes', () => {
  assert.equal(hexEncode([0, 1, 15, 16, 255]), '00010f10ff');
  assert.equal(hexEncode(new Uint8Array([255, 0])), 'ff00');
  assert.equal(hexEncode(new Uint8Array([]).buffer), '');
  assert.deepEqual(hexToBytes('00010f10ff'), [0, 1, 15, 16, 255]);
  assert.throws(() => hexToBytes('abc'), /奇数/);
});

test('sha256Hex は既知のベクタと一致する', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(
    await sha256Hex(bytes),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

/* ---------- チャンク / 候補 ---------- */

test('chunkRanges は先頭と末尾を返す', () => {
  assert.deepEqual(chunkRanges(0), []);
  assert.deepEqual(chunkRanges(50, 64), [{ offset: 0, length: 50 }]);
  assert.deepEqual(chunkRanges(64, 64), [{ offset: 0, length: 64 }]);
  assert.deepEqual(chunkRanges(1000, 64), [
    { offset: 0, length: 64 },
    { offset: 936, length: 64 },
  ]);
  assert.equal(chunkRanges(-5).length, 0);
});

test('candidateKey はサイズとチャンクを含む', () => {
  assert.equal(candidateKey(100, 'aa', 'bb'), '100:aa:bb');
  assert.equal(candidateKey(100, '', ''), '100::');
});

test('groupCandidates は同一候補のみをまとめる', () => {
  const entries = [
    fileEntry('a', 100, 'h', 't'),
    fileEntry('b', 100, 'h', 't'),
    fileEntry('c', 100, 'h', 'x'),
    fileEntry('d', 200, 'h', 't'),
  ];
  const groups = groupCandidates(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.id), ['a', 'b']);
  assert.equal(groups[0].key, '100:h:t');
});

test('groupExact は完全ハッシュでまとめる', () => {
  const entries = [
    fileEntry('a', 100, '', '', 'HASH1'),
    fileEntry('b', 100, '', '', 'HASH1'),
    fileEntry('c', 100, '', '', 'HASH2'),
  ];
  const groups = groupExact(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.id), ['a', 'b']);
});

/* ---------- 画像 / dHash ---------- */

test('grayFromRGBA は輝度を返す', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const gray = grayFromRGBA(rgba, 3, 1);
  assert.equal(gray[0], 76);
  assert.equal(gray[1], 150);
  assert.equal(gray[2], 29);
});

test('resampleGray は領域平均で縮小する', () => {
  const gray = new Uint8Array([0, 10, 20, 30]);
  const small = resampleGray(gray, 2, 2, 1, 1);
  assert.equal(small.length, 1);
  assert.equal(small[0], 15);
});

test('dHash は同一画像で距離 0、明るさの平行移動に強い', () => {
  const gray = gradientGray(32, 32);
  const hash = dHash(gray, 32, 32);
  assert.equal(hash.length, DHASH_HEX_LENGTH);
  assert.equal(hammingDistance(hash, dHash(gray, 32, 32)), 0);

  const brighter = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) brighter[i] = Math.min(255, gray[i] + 30);
  assert.equal(hammingDistance(hash, dHash(brighter, 32, 32)), 0);

  // 反転した勾配は全ビット反転 (距離 64)
  const flipped = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) flipped[i] = 255 - gray[i];
  assert.equal(hammingDistance(hash, dHash(flipped, 32, 32)), 64);
});

test('dHash は異なる模様を区別する', () => {
  const gray = gradientGray(32, 32);
  // 縦縞 (8px ごとに明暗反転)。隣接比較に 1 と 0 の両方が現れる。
  const stripes = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      stripes[y * 32 + x] = x % 16 < 8 ? 200 : 20;
    }
  }
  const d = hammingDistance(dHash(gray, 32, 32), dHash(stripes, 32, 32));
  assert.ok(d > 0 && d <= 64, `期待: 0<d<=64, 実際: ${d}`);
});

test('hammingDistance / similarityPercent / isSimilar', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.throws(() => hammingDistance('ff', 'ffff'), /一致/);

  assert.equal(similarityPercent('0000000000000000', '0000000000000000'), 100);
  assert.equal(similarityPercent('0000000000000000', 'ffffffffffffffff'), 0);
  assert.equal(similarityPercent('0000000000000000', '0000000000000001'), 98);

  assert.equal(isSimilar('0000000000000000', '0000000000000001', 1), true);
  assert.equal(isSimilar('0000000000000000', '0000000000000001', 0), false);
  assert.equal(DEFAULT_SIMILAR_THRESHOLD, 10);
});

test('clusterBySimilarity は近い画像をまとめる', () => {
  const items = [
    { id: 'a', dhash: '0000000000000000' },
    { id: 'b', dhash: '0000000000000001' },
    { id: 'c', dhash: 'ffffffffffffffff' },
    { id: 'd', dhash: '00000000000000ff' },
  ];
  const near = clusterBySimilarity(items, { threshold: 2 });
  assert.equal(near.length, 1);
  assert.deepEqual(near[0].map((i) => i.id), ['a', 'b']);

  const wider = clusterBySimilarity(items, { threshold: 8 });
  assert.equal(wider.length, 1);
  assert.deepEqual(wider[0].map((i) => i.id), ['a', 'b', 'd']);
});

test('clusterBySimilarity は maxItems で打ち切る', () => {
  const items = [
    { id: 'a', dhash: '0000000000000000' },
    { id: 'b', dhash: '0000000000000000' },
    { id: 'c', dhash: '0000000000000000' },
  ];
  const groups = clusterBySimilarity(items, { threshold: 0, maxItems: 2 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((i) => i.id), ['a', 'b']);
});

/* ---------- 集計 / 計画 ---------- */

test('defaultKeepId はサイズ最大、同点は id 順', () => {
  assert.equal(defaultKeepId({ files: [{ id: 'a', size: 10 }, { id: 'b', size: 30 }] }), 'b');
  assert.equal(defaultKeepId({ files: [{ id: 'b', size: 10 }, { id: 'a', size: 10 }] }), 'a');
  assert.equal(defaultKeepId({ files: [] }), null);
});

test('summarizeGroups は削減見込みを計算する', () => {
  const groups = [
    { id: 'g1', files: [{ id: 'a', size: 100 }, { id: 'b', size: 100 }, { id: 'c', size: 100 }] },
    { id: 'g2', files: [{ id: 'd', size: 100 }, { id: 'e', size: 300 }] },
  ];
  const summary = summarizeGroups(groups);
  assert.equal(summary.groupCount, 2);
  assert.equal(summary.fileCount, 5);
  assert.equal(summary.duplicateCount, 3);
  assert.equal(summary.totalBytes, 700);
  // g1: 300-100=200, g2: 400-300=100
  assert.equal(summary.reclaimableBytes, 300);
});

test('summarizeGroups は keepIds を尊重する', () => {
  const groups = [{ id: 'g1', files: [{ id: 'a', size: 100 }, { id: 'b', size: 300 }] }];
  const summary = summarizeGroups(groups, { keepIds: new Map([['g1', 'a']]) });
  assert.equal(summary.reclaimableBytes, 300);
});

test('planMoves はグループごとに 1 件を残し命名衝突を避ける', () => {
  const groups = [
    {
      id: 'g1',
      files: [
        { id: 'a', name: 'photo.jpg', path: 'p/photo.jpg', size: 100 },
        { id: 'b', name: 'photo.jpg', path: 'q/photo.jpg', size: 100 },
      ],
    },
    {
      id: 'g2',
      files: [
        { id: 'c', name: 'photo.jpg', path: 'r/photo.jpg', size: 100 },
        { id: 'd', name: 'photo.jpg', path: 's/photo.jpg', size: 100 },
      ],
    },
  ];
  const { moves } = planMoves(groups);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map((m) => m.from), ['q/photo.jpg', 's/photo.jpg']);
  assert.deepEqual(moves.map((m) => m.name), ['photo.jpg', 'photo (1).jpg']);
});

test('planMoves は keepIds を尊重する', () => {
  const groups = [
    {
      id: 'g1',
      files: [
        { id: 'a', name: 'a.txt', path: 'p/a.txt', size: 1 },
        { id: 'b', name: 'b.txt', path: 'q/b.txt', size: 1 },
      ],
    },
  ];
  const { moves } = planMoves(groups, { keepIds: new Map([['g1', 'b']]) });
  assert.deepEqual(moves.map((m) => m.fileId), ['a']);
});

/* ---------- レポート ---------- */

test('buildReport / groupsToJSON / groupsFromJSON の往復', () => {
  const groups = [
    {
      id: 'exact:1',
      kind: 'exact',
      key: '1:H',
      files: [
        { id: 'a', name: 'a.txt', path: 'p/a.txt', size: 100, hash: 'H', file: { fake: true } },
        { id: 'b', name: 'b.txt', path: 'q/b.txt', size: 100, hash: 'H', file: { fake: true } },
      ],
    },
  ];
  const report = buildReport(groups, { root: 'Downloads', generatedAt: '2026-10-13T00:00:00Z' });
  assert.equal(report.app, REPORT_APP);
  assert.equal(report.version, REPORT_VERSION);
  assert.equal(report.root, 'Downloads');
  assert.equal(report.summary.groupCount, 1);
  assert.equal(report.groups[0].keepId, 'a');

  const json = groupsToJSON(report);
  assert.ok(json.includes('"app": "duplicate-finder"'));
  // File オブジェクトはシリアライズされない
  assert.ok(!json.includes('fake'));

  const restored = groupsFromJSON(json);
  assert.equal(restored.groups.length, 1);
  assert.equal(restored.groups[0].files.length, 2);
  assert.equal(restored.groups[0].keepId, 'a');
  assert.deepEqual(restored.warnings, []);
});

test('groupsFromJSON は不正な入力を拒否し、別アプリを警告する', () => {
  assert.throws(() => groupsFromJSON('not json'), /解析/);
  assert.throws(() => groupsFromJSON('{"groups": {}}'), /形式/);
  const other = groupsFromJSON(JSON.stringify({ app: 'other', version: 99, groups: [] }));
  assert.equal(other.warnings.length, 2);
});

test('escapeCsv / rowsToCSV は引用符を正しく扱う', () => {
  assert.equal(escapeCsv('plain'), 'plain');
  assert.equal(escapeCsv('a,b'), '"a,b"');
  assert.equal(escapeCsv('a"b'), '"a""b"');
  const csv = rowsToCSV([{ a: 'x', b: 'y,z' }], ['a', 'b']);
  assert.equal(csv, 'a,b\r\nx,"y,z"');
  assert.equal(rowsToCSV([], []), '');
});

test('reportToRows は keep / move を付ける', () => {
  const report = buildReport(
    [
      {
        id: 'g1',
        kind: 'exact',
        files: [
          { id: 'a', name: 'a.txt', path: 'p/a.txt', size: 100, hash: 'H' },
          { id: 'b', name: 'b.txt', path: 'q/b.txt', size: 100, hash: 'H' },
        ],
      },
    ],
    { generatedAt: '2026-10-13T00:00:00Z' },
  );
  const rows = reportToRows(report);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'keep');
  assert.equal(rows[1].status, 'move');
  assert.equal(rows[0].sizeText, '100 B');
  assert.equal(rows[0].kind, 'exact');
});

test('CHUNK_SIZE は 64KB', () => {
  assert.equal(CHUNK_SIZE, 64 * 1024);
});
