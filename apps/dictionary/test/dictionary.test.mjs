import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_PACKS,
  DICT_SCHEMA_VERSION,
  INBOX_KEYS,
  INBOX_LIMIT,
  NET_DECLARATION,
  RELEASE_TAG,
  SOURCE_ATTRIBUTION,
  buildDataset,
  buildIndex,
  buildNote,
  buildStudyCard,
  dataFileUrl,
  datasetStats,
  extractTarMember,
  formatBytes,
  glossLine,
  gunzip,
  hiraganaToKatakana,
  isKana,
  isKanji,
  japaneseQuery,
  katakanaToHiragana,
  lookupKanji,
  migrateDataset,
  normalizeJapanese,
  normalizeJmdictWord,
  normalizeKanjidicCharacter,
  normalizeLatin,
  parseDictionaryArchive,
  posLabel,
  prefixRange,
  pushInbox,
  readingLine,
  romajiToHiragana,
  search,
  searchByKanji,
  searchEnglish,
  searchJapanese,
} from '../dictionary.mjs';

/* ==========================================================
   サンプルデータ
   ========================================================== */

const JMDICT = {
  version: '3.6.2',
  dictDate: '2026-10-12',
  words: [
    {
      id: '1000000',
      kanji: [{ text: '日本', common: true }],
      kana: [
        { text: 'にほん', common: true, appliesToKanji: ['*'] },
        { text: 'ニホン', common: false, appliesToKanji: ['*'] },
      ],
      sense: [{ partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'Japan' }] }],
    },
    {
      id: '1000001',
      kanji: [{ text: '日本語', common: true }],
      kana: [{ text: 'にほんご', common: true }],
      sense: [{ partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'Japanese language' }] }],
    },
    {
      id: '1000002',
      kanji: [],
      kana: [{ text: 'アメリカ', common: true }],
      sense: [{ partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'America' }] }],
    },
    {
      id: '1000003',
      kanji: [{ text: '学校', common: true }],
      kana: [{ text: 'がっこう', common: true }],
      sense: [{ partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'school' }] }],
    },
    {
      id: '1000004',
      kanji: [{ text: '猫', common: true }],
      kana: [{ text: 'ねこ', common: true }],
      sense: [
        { partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'cat' }] },
        { partOfSpeech: ['n'], gloss: [{ lang: 'en', text: 'kitty' }] },
      ],
    },
  ],
};

const KANJIDIC = {
  version: '3.6.2',
  characters: [
    {
      literal: '日',
      misc: { grade: 1, strokeCounts: [4], freq: 1, jlpt: 4 },
      readingMeaning: {
        groups: [
          {
            readings: [
              { type: 'ja_on', value: 'ニチ' },
              { type: 'ja_kun', value: 'ひ' },
              { type: 'pinyin', value: 'ri4' },
            ],
            meanings: [{ lang: 'en', value: 'day' }, { lang: 'fr', value: 'soleil' }],
          },
        ],
      },
    },
    { literal: '学', misc: { grade: 1, strokeCounts: [8] }, readingMeaning: { groups: [] } },
  ],
};

function buildSampleIndex() {
  const dataset = buildDataset({ jmdict: JMDICT, kanjidic: KANJIDIC });
  return { dataset, index: buildIndex(dataset) };
}

/* ==========================================================
   tar / gzip ヘルパー (テスト専用)
   ========================================================== */

function tarHeader(name, size) {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode('0000644\0'), 100);
  header.set(enc.encode('0000000\0'), 108);
  header.set(enc.encode('0000000\0'), 116);
  header.set(enc.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  header.set(enc.encode('00000000000\0'), 136);
  header.set(enc.encode('        '), 148);
  header[156] = 0x30; // '0'
  header.set(enc.encode('ustar\0'), 257);
  header.set(enc.encode('00'), 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

function makeTar(name, content) {
  const data = new TextEncoder().encode(content);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return new Uint8Array([...tarHeader(name, data.length), ...padded, ...new Uint8Array(1024)]);
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ==========================================================
   定数
   ========================================================== */

test('定数はスキーマ・方針を表す', () => {
  assert.equal(DICT_SCHEMA_VERSION, 1);
  assert.match(NET_DECLARATION, /送信なし/);
  assert.match(NET_DECLARATION, /初回のみ取得/);
  assert.equal(SOURCE_ATTRIBUTION.license, 'CC BY-SA 4.0');
  assert.equal(DATA_PACKS.standard.id, 'standard');
  assert.equal(DATA_PACKS.full.jmdict, 'jmdict-eng');
  assert.equal(DATA_PACKS.standard.jmdict, 'jmdict-eng-common');
  assert.equal(INBOX_KEYS.studyCards, 'myapps:inbox:study-cards');
  assert.equal(INBOX_KEYS.notesVault, 'myapps:inbox:notes-vault');
  assert.ok(INBOX_LIMIT >= 100);
  assert.match(RELEASE_TAG, /^\d+\.\d+\.\d+\+/);
});

test('dataFileUrl はタグを URL エンコードする', () => {
  const url = dataFileUrl('jmdict', 'standard');
  assert.ok(url.startsWith('https://github.com/scriptin/jmdict-simplified/releases/download/'));
  assert.ok(url.includes('3.6.2%2B'), `タグがエンコードされていない: ${url}`);
  assert.ok(url.endsWith('.json.tgz'));
  assert.ok(dataFileUrl('kanjidic', 'full').includes('kanjidic2-en-'));
  assert.ok(dataFileUrl('jmdict', 'full').includes('jmdict-eng-3.6.2'));
});

/* ==========================================================
   かな変換
   ========================================================== */

test('katakanaToHiragana / hiraganaToKatakana は相互変換できる', () => {
  assert.equal(katakanaToHiragana('アメリカ'), 'あめりか');
  assert.equal(katakanaToHiragana('ニホン・ゴ'), 'にほん・ご');
  assert.equal(katakanaToHiragana('ひらがな'), 'ひらがな');
  assert.equal(hiraganaToKatakana('あめりか'), 'アメリカ');
  assert.equal(katakanaToHiragana('ABC123'), 'ABC123');
});

test('isKana / isKanji', () => {
  assert.equal(isKana('あ'), true);
  assert.equal(isKana('ア'), true);
  assert.equal(isKana('日'), false);
  assert.equal(isKanji('日'), true);
  assert.equal(isKanji('あ'), false);
  assert.equal(isKanji('A'), false);
});

test('normalizeJapanese / normalizeLatin', () => {
  assert.equal(normalizeJapanese(' ニホン '), 'にほん');
  assert.equal(normalizeJapanese('ＡＢＣ'), 'abc');
  assert.equal(normalizeLatin('  Give   Up '), 'give up');
});

test('romajiToHiragana は基本・促音・撥音・拗音を扱う', () => {
  const cases = {
    a: 'あ',
    nihon: 'にほん',
    gakkou: 'がっこう',
    katta: 'かった',
    zasshi: 'ざっし',
    shinichi: 'しにち',
    "shin'ichi": 'しんいち',
    onna: 'おんな',
    konnyaku: 'こんにゃく',
    tsunami: 'つなみ',
    ryokou: 'りょこう',
    gakusei: 'がくせい',
    kya: 'きゃ',
    ja: 'じゃ',
    fa: 'ふぁ',
    Amerika: 'あめりか',
    hon: 'ほん',
    "kan'i": 'かんい',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(romajiToHiragana(input), expected, `${input} -> ${expected}`);
  }
  assert.equal(romajiToHiragana('ko-hi-'), 'こーひー');
  assert.equal(romajiToHiragana('123'), '123');
});

test('japaneseQuery はローマ字だけかなに直す', () => {
  assert.equal(japaneseQuery('nihon'), 'にほん');
  assert.equal(japaneseQuery('ニホン'), 'にほん');
  assert.equal(japaneseQuery('日本'), '日本');
  assert.equal(japaneseQuery('  '), '');
});

test('posLabel はタグを日本語にし、未知はそのまま返す', () => {
  assert.equal(posLabel('n'), '名詞');
  assert.equal(posLabel('adj-i'), 'い形容詞');
  assert.equal(posLabel('xyz'), 'xyz');
  assert.equal(posLabel(undefined), '');
});

/* ==========================================================
   取り込み / 正規化
   ========================================================== */

test('normalizeJmdictWord は内部形式へ整える', () => {
  const word = normalizeJmdictWord(JMDICT.words[0]);
  assert.equal(word.head, '日本');
  assert.deepEqual(word.readings, ['にほん', 'ニホン']);
  assert.equal(word.common, true);
  assert.deepEqual(word.senses[0].pos, ['n']);
  assert.deepEqual(word.senses[0].gloss, ['Japan']);
});

test('normalizeKanjidicCharacter は読み・意味・属性を取る', () => {
  const char = normalizeKanjidicCharacter(KANJIDIC.characters[0]);
  assert.equal(char.literal, '日');
  assert.deepEqual(char.on, ['ニチ']);
  assert.deepEqual(char.kun, ['ひ']);
  assert.deepEqual(char.meanings, ['day']); // en 以外は含めない
  assert.equal(char.grade, 1);
  assert.equal(char.strokes, 4);
  assert.equal(char.freq, 1);
  assert.equal(char.jlpt, 4);
});

test('buildDataset / datasetStats', () => {
  const dataset = buildDataset({ jmdict: JMDICT, kanjidic: KANJIDIC, pack: 'full' });
  assert.equal(dataset.schema, DICT_SCHEMA_VERSION);
  assert.equal(dataset.pack, 'full');
  assert.equal(dataset.source.jmdictVersion, '3.6.2');
  assert.deepEqual(datasetStats(dataset), { words: 5, kanji: 2, pack: 'full' });
});

test('buildDataset は head の無い語を落とす', () => {
  const dataset = buildDataset({ jmdict: { words: [{ id: 'x', kanji: [], kana: [], sense: [] }] } });
  assert.equal(dataset.words.length, 0);
});

/* ==========================================================
   スキーマ移行
   ========================================================== */

test('migrateDataset は schema 欠落を v1 として補完する', () => {
  const migrated = migrateDataset({
    words: [{ head: '猫', kana: [{ text: 'ねこ' }] }],
    kanji: [{ literal: '猫' }],
  });
  assert.equal(migrated.schema, DICT_SCHEMA_VERSION);
  assert.equal(migrated.pack, 'standard');
  assert.equal(migrated.words[0].head, '猫');
  assert.deepEqual(migrated.words[0].senses, []);
  assert.equal(migrated.kanji[0].literal, '猫');
});

test('migrateDataset は未知の新しい版を拒否し、壊れた入力を弾く', () => {
  assert.throws(() => migrateDataset({ schema: 99 }), /新しい辞書データ/);
  assert.throws(() => migrateDataset(null), /形式が正しくありません/);
  assert.throws(() => migrateDataset([1, 2, 3]), /形式が正しくありません/);
});

/* ==========================================================
   索引 / 検索
   ========================================================== */

test('prefixRange は昇順配列のプレフィックス範囲を返す', () => {
  const keys = ['あい', 'あお', 'かき', 'かに', 'ん'];
  assert.deepEqual(prefixRange(keys, 'あ'), [0, 2]);
  assert.deepEqual(prefixRange(keys, 'か'), [2, 4]);
  assert.deepEqual(prefixRange(keys, 'ん'), [4, 5]);
  assert.deepEqual(prefixRange(keys, 'さ'), [4, 4]);
  assert.deepEqual(prefixRange(keys, ''), [0, 5]);
});

test('buildIndex は見出し・かな・語義の索引を作る', () => {
  const { index } = buildSampleIndex();
  assert.ok(index.headMap.has('にほん'));
  assert.ok(index.headMap.has('日本'));
  assert.ok(index.glossMap.has('school'));
  assert.ok(index.kanjiMap.has('日'));
  assert.equal(index.headKeys.length, index.headMap.size);
});

test('searchJapanese はローマ字・かな・漢字の前方一致で引ける', () => {
  const { index } = buildSampleIndex();
  assert.deepEqual(searchJapanese(index, 'nihon').map((w) => w.head), ['日本', '日本語']);
  assert.deepEqual(searchJapanese(index, 'にほ').map((w) => w.head), ['日本', '日本語']);
  assert.deepEqual(searchJapanese(index, 'がっこう').map((w) => w.head), ['学校']);
  assert.deepEqual(searchJapanese(index, 'アメリ').map((w) => w.head), ['アメリカ']);
  assert.deepEqual(searchJapanese(index, '日本').map((w) => w.head), ['日本', '日本語']);
  assert.deepEqual(searchJapanese(index, 'zzzz'), []);
  assert.deepEqual(searchJapanese(index, ''), []);
});

test('searchJapanese は完全一致を前方一致より上位に置く', () => {
  const { index } = buildSampleIndex();
  const results = searchJapanese(index, '日本');
  assert.equal(results[0].head, '日本');
  assert.equal(results[0].score, 0);
  assert.equal(results[1].score, 2);
});

test('searchEnglish は語義トークンで引ける', () => {
  const { index } = buildSampleIndex();
  assert.deepEqual(searchEnglish(index, 'school').map((w) => w.head), ['学校']);
  assert.deepEqual(searchEnglish(index, 'cat').map((w) => w.head), ['猫']);
  assert.deepEqual(searchEnglish(index, 'japan').map((w) => w.head), ['日本', '日本語']);
  assert.deepEqual(searchEnglish(index, 'zzz'), []);
});

test('search はモードで振り分ける', () => {
  const { index } = buildSampleIndex();
  assert.deepEqual(search(index, 'school', { mode: 'en' }).map((w) => w.head), ['学校']);
  assert.deepEqual(search(index, 'nihon', { mode: 'ja' }).map((w) => w.head), ['日本', '日本語']);
});

test('searchByKanji は漢字を含む語を返す', () => {
  const { index } = buildSampleIndex();
  assert.deepEqual(searchByKanji(index, '日本').map((w) => w.head), ['日本', '日本語']);
  assert.deepEqual(searchByKanji(index, '猫').map((w) => w.head), ['猫']);
  assert.deepEqual(searchByKanji(index, '犬'), []);
});

test('lookupKanji は Kanjidic の字を返す', () => {
  const { index } = buildSampleIndex();
  assert.equal(lookupKanji(index, '日').literal, '日');
  assert.equal(lookupKanji(index, '学').literal, '学');
  assert.equal(lookupKanji(index, '犬'), null);
  assert.equal(lookupKanji(index, ''), null);
});

test('limit で件数を絞れる', () => {
  const { index } = buildSampleIndex();
  assert.equal(searchJapanese(index, 'nihon', { limit: 1 }).length, 1);
});

/* ==========================================================
   アーカイブ
   ========================================================== */

test('extractTarMember は最初の JSON を取り出す', () => {
  const tar = makeTar('jmdict-eng-common-x.json', '{"words":[]}');
  const member = extractTarMember(tar);
  assert.equal(member.name, 'jmdict-eng-common-x.json');
  assert.equal(new TextDecoder().decode(member.data), '{"words":[]}');
  assert.equal(extractTarMember(makeTar('readme.txt', 'hi')), null);
});

test('parseDictionaryArchive は .json.tgz を展開する', async () => {
  const json = JSON.stringify({ version: '3.6.2', words: [{ kanji: [{ text: '猫' }], kana: [{ text: 'ねこ' }], sense: [{ gloss: [{ text: 'cat' }] }] }] });
  const tar = makeTar('jmdict-eng-common-x.json', json);
  const gz = await gzipBytes(tar);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);

  const parsed = await parseDictionaryArchive(gz);
  assert.equal(parsed.name, 'jmdict-eng-common-x.json');
  assert.equal(parsed.data.words[0].kanji[0].text, '猫');
});

test('parseDictionaryArchive は生 JSON も受け付ける', async () => {
  const bytes = new TextEncoder().encode('{"characters":[{"literal":"日"}]}');
  const parsed = await parseDictionaryArchive(bytes);
  assert.equal(parsed.data.characters[0].literal, '日');
});

test('parseDictionaryArchive は壊れた JSON を拒否する', async () => {
  const bytes = new TextEncoder().encode('not json');
  await assert.rejects(() => parseDictionaryArchive(bytes), /解析できません/);
});

test('gunzip は gzip を展開する', async () => {
  const original = new TextEncoder().encode('hello こんにちは');
  const gz = await gzipBytes(original);
  const out = await gunzip(gz);
  assert.equal(new TextDecoder().decode(out), 'hello こんにちは');
});

/* ==========================================================
   受け渡し / 表示
   ========================================================== */

test('buildStudyCard は単語帳向けのカードを作る', () => {
  const { dataset } = buildSampleIndex();
  const card = buildStudyCard(dataset.words[0]);
  assert.equal(card.front, '日本');
  assert.equal(card.back, 'Japan');
  assert.equal(card.reading, 'にほん・ニホン');
  assert.deepEqual(card.tags, ['dictionary', 'n']);
  assert.equal(card.source, 'dictionary');
});

test('buildNote はノート向けの本文を作る', () => {
  const { dataset } = buildSampleIndex();
  const note = buildNote(dataset.words[0], '第1章で出た');
  assert.equal(note.title, '日本');
  assert.ok(note.body.includes('にほん'));
  assert.ok(note.body.includes('Japan'));
  assert.ok(note.body.includes('第1章で出た'));
  assert.deepEqual(note.tags, ['dictionary']);
});

test('pushInbox は重複を排除し上限で古い方を捨てる', () => {
  const list = [{ front: 'a' }, { front: 'b' }];
  const added = pushInbox(list, { front: 'a', back: 'new' }, { key: 'front' });
  assert.equal(added.length, 2);
  assert.equal(added.find((x) => x.front === 'a').back, 'new');

  let many = [];
  for (let i = 0; i < 5; i += 1) many = pushInbox(many, { front: `w${i}` }, { key: 'front', limit: 3 });
  assert.equal(many.length, 3);
  assert.deepEqual(many.map((x) => x.front), ['w2', 'w3', 'w4']);

  const withFn = pushInbox([{ id: 1 }], { id: 1, v: 2 }, { key: (x) => x.id });
  assert.equal(withFn.length, 1);
  assert.equal(withFn[0].v, 2);
});

test('formatBytes / readingLine / glossLine', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatBytes(null), '—');

  const { dataset } = buildSampleIndex();
  assert.equal(readingLine(dataset.words[0]), 'にほん・ニホン');
  assert.equal(glossLine(dataset.words[4]), 'cat; kitty');
});
