/**
 * apps/dictionary/dictionary.mjs — オフライン辞書の純ロジック
 *
 * MyApps の `dictionary` は、英和・和英（JMdict）と漢字（Kanjidic）を
 * **初回だけ取得して以後はオフライン**で引く。このファイルは DOM / fetch /
 * IndexedDB に依存しない「計算」だけを置き、`script.js` の UI と
 * `node --test` のテストから共有する。
 *
 * データ形式の出典:
 *   JMdict / Kanjidic (EDRDG) を JSON 化した scriptin/jmdict-simplified
 *   https://github.com/scriptin/jmdict-simplified
 *   ライセンス: CC BY-SA 4.0 (EDRDG)。出典表示と継承が必要。
 *
 * 注意 (事実):
 *   - 配布物は `.json.tgz` (gzip + tar) のみで、生の `.json` は無い。
 *   - GitHub の release アセットは `Access-Control-Allow-Origin` を返さないため、
 *     GitHub Pages 上のブラウザから直接 fetch すると CORS で失敗しうる。
 *     そのため script.js は「自動取得 → 失敗時は手元のファイル取込」の二段構えにする。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 保存するデータスキーマの版。構造を変えたら上げる。 */
export const DICT_SCHEMA_VERSION = 1;

/** 取得元の release タグ (バージョン + 生成日時)。 */
export const RELEASE_TAG = '3.6.2+20261012204142';

/** release のアセット名は `<辞書>-<tag>.json.tgz`。 */
export const RELEASE_BASE = 'https://github.com/scriptin/jmdict-simplified/releases/download';
export const RELEASES_PAGE = 'https://github.com/scriptin/jmdict-simplified/releases';

/** 出典表示 (CC BY-SA 4.0 のクレジット)。 */
export const SOURCE_ATTRIBUTION = Object.freeze({
  name: 'JMdict / Kanjidic (EDRDG)',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  projectUrl: 'https://github.com/scriptin/jmdict-simplified',
});

/** meta.json に宣言するネットワーク方針。 */
export const NET_DECLARATION = '初回のみ取得、以後送信なし（辞書データの GET のみ。検索語は送信しない）';

/** データの種類ごとの配布ファイル (標準/完全の 2 パック)。 */
export const DATA_PACKS = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    label: '標準（常用語）',
    approxBytes: 1_400_000,
    jmdict: 'jmdict-eng-common',
    kanjidic: 'kanjidic2-en',
  }),
  full: Object.freeze({
    id: 'full',
    label: '完全（全項目）',
    approxBytes: 11_000_000,
    jmdict: 'jmdict-eng',
    kanjidic: 'kanjidic2-en',
  }),
});

/** 単語帳・ノートへの受け渡しに使う localStorage キー (契約)。 */
export const INBOX_KEYS = Object.freeze({
  studyCards: 'myapps:inbox:study-cards',
  notesVault: 'myapps:inbox:notes-vault',
});

/** 受け渡しキューに貯める最大件数。 */
export const INBOX_LIMIT = 500;

/* ==========================================================
   品詞ラベル (JMdict の POS タグ -> 日本語)
   ========================================================== */

export const POS_LABELS = Object.freeze({
  n: '名詞',
  'n-suf': '名詞 (接尾)',
  'n-pref': '名詞 (接頭)',
  pn: '代名詞',
  adv: '副詞',
  'adv-to': '副詞 (と)',
  adj: '形容詞',
  'adj-i': 'い形容詞',
  'adj-na': 'な形容詞',
  'adj-no': 'の形容詞',
  'adj-pn': '連体詞',
  'adj-f': '形容詞 (連体)',
  'adj-t': 'たる形容詞',
  v1: '動詞 (一段)',
  'v1-s': '動詞 (一段・ス)',
  v5u: '動詞 (五段・う)',
  v5k: '動詞 (五段・く)',
  v5g: '動詞 (五段・ぐ)',
  v5s: '動詞 (五段・す)',
  v5t: '動詞 (五段・つ)',
  v5n: '動詞 (五段・ぬ)',
  v5b: '動詞 (五段・ぶ)',
  v5m: '動詞 (五段・む)',
  v5r: '動詞 (五段・る)',
  'v5aru': '動詞 (五段・ある)',
  'v5k-s': '動詞 (五段・く特殊)',
  'v5r-i': '動詞 (五段・る特殊)',
  vs: '動詞 (する)',
  'vs-i': '動詞 (する・特殊)',
  'vs-s': '動詞 (する・ス)',
  vt: '他動詞',
  vi: '自動詞',
  vk: '動詞 (くる)',
  vz: '動詞 (一段・ずる)',
  aux: '助動詞',
  'aux-v': '助動詞',
  'aux-adj': '助動詞 (形容)',
  prt: '助詞',
  conj: '接続詞',
  int: '感動詞',
  exp: '表現',
  num: '数詞',
  ctr: '助数詞',
  pref: '接頭辞',
  suf: '接尾辞',
  'n-adv': '名詞 (副詞的)',
  unc: '未分類',
  uk: '通常かな',
});

/** POS タグを日本語ラベルにする。未知のタグはそのまま返す。 */
export function posLabel(tag) {
  return POS_LABELS[tag] || tag || '';
}

/* ==========================================================
   かな変換
   ========================================================== */

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** カタカナをひらがなへ (長音符 ー と ヵヶ はそのまま)。 */
export function katakanaToHiragana(input) {
  const s = String(input ?? '');
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= KATAKANA_START && code <= KATAKANA_END) {
      out += String.fromCodePoint(code - KANA_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

/** ひらがなをカタカナへ。 */
export function hiraganaToKatakana(input) {
  const s = String(input ?? '');
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x3041 && code <= 0x3096) {
      out += String.fromCodePoint(code + KANA_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

/** ひらがな・カタカナのいずれか。 */
export function isKana(ch) {
  const code = String(ch ?? '').codePointAt(0) || 0;
  return (code >= 0x3041 && code <= 0x3096) || (code >= KATAKANA_START && code <= KATAKANA_END);
}

/** CJK 統合漢字のいずれか。 */
export function isKanji(ch) {
  const code = String(ch ?? '').codePointAt(0) || 0;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/** 検索用に日本語文字列を正規化する (NFKC + カタカナ→ひらがな + 小文字化)。 */
export function normalizeJapanese(input) {
  const s = String(input ?? '').normalize('NFKC').trim().toLowerCase();
  return katakanaToHiragana(s);
}

/** 検索用にラテン文字列を正規化する (NFKC + 小文字化 + 空白圧縮)。 */
export function normalizeLatin(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/* --- ローマ字 -> ひらがな --- */

const ROMAJI_TABLE = (() => {
  const table = {
    a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
    sa: 'さ', si: 'し', shi: 'し', su: 'す', se: 'せ', so: 'そ',
    ta: 'た', ti: 'ち', chi: 'ち', tu: 'つ', tsu: 'つ', te: 'て', to: 'と',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
    ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
    ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
    wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を',
    ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
    pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
    hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
    rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
    pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
    kwa: 'くゎ',
    n: 'ん',
    // 小書き (x / l 前置)
    xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ',
    la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ',
    xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ',
    xtu: 'っ', xtsu: 'っ', ltu: 'っ', ltsu: 'っ',
    xwa: 'ゎ', lwa: 'ゎ',
  };
  return table;
})();

const ROMAJI_KEYS = Object.keys(ROMAJI_TABLE).sort((a, b) => b.length - a.length);

const ROMAJI_RE = /^[a-z'\- ]+$/i;

/**
 * ローマ字 (Hepburn 寄り) をひらがなへ変換する。
 * - 促音: 子音の重なり (`katta` -> かった)
 * - 撥音: `n` / `nn` / `n'` (`shin'ichi` -> しんいち)
 * - 長音 `-` は `ー`
 * - 表に無い並びはそのまま通す
 */
export function romajiToHiragana(input) {
  const s = String(input ?? '').toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (!/[a-z'\-]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    // アポストロフィ: 直前が n なら撥音として消費済みの想定。単独なら読み飛ばす。
    if (ch === "'") {
      i += 1;
      continue;
    }
    if (ch === '-') {
      out += 'ー';
      i += 1;
      continue;
    }
    // n + ' -> ん
    if (ch === 'n' && s[i + 1] === "'") {
      out += 'ん';
      i += 2;
      continue;
    }
    // 促音: 同じ子音が続く (n は撥音として別扱い)
    const next = s[i + 1];
    if (ch !== 'n' && !'aiueo'.includes(ch) && next === ch) {
      out += 'っ';
      i += 1;
      continue;
    }
    // 最長一致
    let matched = null;
    for (const key of ROMAJI_KEYS) {
      if (s.startsWith(key, i)) {
        matched = key;
        break;
      }
    }
    if (matched) {
      out += ROMAJI_TABLE[matched];
      i += matched.length;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * 検索語を「日本語として」正規化する。
 * ラテン文字だけならローマ字→ひらがな、それ以外は NFKC + カタカナ→ひらがな。
 */
export function japaneseQuery(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (ROMAJI_RE.test(raw)) return romajiToHiragana(raw);
  return normalizeJapanese(raw);
}

/* ==========================================================
   JMdict / Kanjidic の取り込み
   ========================================================== */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return asArray(value).map((v) => String(v ?? '')).filter(Boolean);
}

/** JMdict-simplified の 1 語を内部形式へ正規化する。 */
export function normalizeJmdictWord(raw = {}) {
  const kanji = asArray(raw.kanji)
    .map((k) => ({ text: String(k?.text ?? ''), common: Boolean(k?.common), tags: asStringArray(k?.tags) }))
    .filter((k) => k.text);
  const kana = asArray(raw.kana)
    .map((k) => ({
      text: String(k?.text ?? ''),
      common: Boolean(k?.common),
      tags: asStringArray(k?.tags),
      appliesToKanji: asStringArray(k?.appliesToKanji),
    }))
    .filter((k) => k.text);
  const senses = asArray(raw.sense).map((s) => ({
    pos: asStringArray(s?.partOfSpeech),
    gloss: asArray(s?.gloss)
      .map((g) => (typeof g === 'string' ? g : String(g?.text ?? '')))
      .filter(Boolean),
    field: asStringArray(s?.field),
    misc: asStringArray(s?.misc),
    info: asStringArray(s?.info),
  }));
  const head = kanji[0]?.text || kana[0]?.text || '';
  const readings = kana.map((k) => k.text);
  const common = kanji.some((k) => k.common) || kana.some((k) => k.common);
  return { id: String(raw.id ?? ''), head, kanji, kana, readings, senses, common };
}

/** Kanjidic2-simplified の 1 字を内部形式へ正規化する。 */
export function normalizeKanjidicCharacter(raw = {}) {
  const misc = raw.misc || {};
  const on = [];
  const kun = [];
  const meanings = [];
  for (const group of asArray(raw.readingMeaning?.groups)) {
    for (const r of asArray(group?.readings)) {
      const value = String(r?.value ?? '');
      if (!value) continue;
      if (r?.type === 'ja_on') on.push(value);
      else if (r?.type === 'ja_kun') kun.push(value);
    }
    for (const m of asArray(group?.meanings)) {
      if (!m?.lang || m.lang === 'en') {
        const value = String(m?.value ?? '');
        if (value) meanings.push(value);
      }
    }
  }
  const strokes = asArray(misc.strokeCounts)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    literal: String(raw.literal ?? ''),
    on,
    kun,
    meanings,
    grade: num(misc.grade),
    strokes: strokes.length ? Math.min(...strokes) : null,
    freq: num(misc.freq),
    jlpt: num(misc.jlpt),
  };
}

/** 取り込んだ生データから内部データセット (保存形式) を組み立てる。 */
export function buildDataset({ jmdict = null, kanjidic = null, pack = 'standard', now = null } = {}) {
  const words = [];
  for (const raw of asArray(jmdict?.words)) {
    const word = normalizeJmdictWord(raw);
    if (word.head) words.push(word);
  }
  const kanji = [];
  for (const raw of asArray(kanjidic?.characters)) {
    const char = normalizeKanjidicCharacter(raw);
    if (char.literal) kanji.push(char);
  }
  return {
    schema: DICT_SCHEMA_VERSION,
    pack,
    source: {
      jmdictVersion: jmdict?.version ?? null,
      kanjidicVersion: kanjidic?.version ?? null,
      dictDate: jmdict?.dictDate ?? null,
    },
    generatedAt: now,
    words,
    kanji,
  };
}

function normalizeStoredWord(word = {}) {
  const kanji = asArray(word.kanji).map((k) => ({ text: String(k?.text ?? ''), common: Boolean(k?.common), tags: asStringArray(k?.tags) }));
  const kana = asArray(word.kana).map((k) => ({ text: String(k?.text ?? ''), common: Boolean(k?.common), tags: asStringArray(k?.tags), appliesToKanji: asStringArray(k?.appliesToKanji) }));
  const head = String(word.head ?? (kanji[0]?.text || kana[0]?.text || ''));
  return {
    id: String(word.id ?? ''),
    head,
    kanji,
    kana,
    readings: asArray(word.readings).map((r) => String(r ?? '')).filter(Boolean),
    senses: asArray(word.senses).map((s) => ({
      pos: asStringArray(s?.pos),
      gloss: asStringArray(s?.gloss),
      field: asStringArray(s?.field),
      misc: asStringArray(s?.misc),
      info: asStringArray(s?.info),
    })),
    common: Boolean(word.common),
  };
}

function normalizeStoredKanji(char = {}) {
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    literal: String(char.literal ?? ''),
    on: asStringArray(char.on),
    kun: asStringArray(char.kun),
    meanings: asStringArray(char.meanings),
    grade: num(char.grade),
    strokes: num(char.strokes),
    freq: num(char.freq),
    jlpt: num(char.jlpt),
  };
}

/**
 * 保存済みデータを現行スキーマへ移行する。
 * - schema 欠落は v1 として読み替える (旧版互換)
 * - 未知の新しい schema は拒否する
 * - 欠けたフィールドは既定値で補う (前方互換)
 */
export function migrateDataset(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('辞書データの形式が正しくありません。');
  }
  const version = Number(obj.schema);
  if (Number.isFinite(version) && version > DICT_SCHEMA_VERSION) {
    throw new Error('このアプリより新しい辞書データです。アプリを更新してください。');
  }
  const source = obj.source && typeof obj.source === 'object' ? { ...obj.source } : {};
  return {
    schema: DICT_SCHEMA_VERSION,
    pack: typeof obj.pack === 'string' && obj.pack ? obj.pack : 'standard',
    source: {
      jmdictVersion: source.jmdictVersion ?? null,
      kanjidicVersion: source.kanjidicVersion ?? null,
      dictDate: source.dictDate ?? null,
    },
    generatedAt: obj.generatedAt ?? null,
    words: asArray(obj.words).map(normalizeStoredWord).filter((w) => w.head),
    kanji: asArray(obj.kanji).map(normalizeStoredKanji).filter((k) => k.literal),
  };
}

/* ==========================================================
   アーカイブ (gzip + tar) の展開
   ========================================================== */

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** gzip を展開する。DecompressionStream を要求する。 */
export async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('この環境は gzip 展開 (DecompressionStream) に対応していません。');
  }
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function readTarString(header, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && header[end] !== 0) end += 1;
  return new TextDecoder('utf-8').decode(header.subarray(offset, end)).trim();
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

/**
 * tar アーカイブから条件に合う最初のファイルを取り出す。
 * GNU long name (typeflag 'L') に対応する。
 * @returns {{name:string, data:Uint8Array}|null}
 */
export function extractTarMember(bytes, { match = /\.json$/i } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;
  let pendingName = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = readTarString(header, 0, 100);
    const size = parseInt(readTarString(header, 124, 12) || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (type === 'L') {
      // 次のエントリの長い名前 (本文が名前)
      pendingName = new TextDecoder('utf-8').decode(data.subarray(dataStart, dataEnd)).replace(/\0+$/, '');
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    const isFile = type === '0' || type === '\0' || type === '';
    const resolvedName = pendingName || name;
    if (isFile && match.test(resolvedName)) {
      return { name: resolvedName, data: data.subarray(dataStart, Math.min(dataEnd, data.length)) };
    }
    pendingName = null;
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 辞書アーカイブ (`.json.tgz` または生 `.json`) を解析してオブジェクトを返す。
 * @returns {{name:string, data:object}}
 */
export async function parseDictionaryArchive(bytes, { match = /\.json$/i } = {}) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const raw = isGzip(source) ? await gunzip(source) : source;
  let jsonBytes = raw;
  let name = '(inline json)';
  // tar でなければ生 JSON とみなす
  const member = extractTarMember(raw, { match });
  if (member) {
    jsonBytes = member.data;
    name = member.name;
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
  } catch {
    throw new Error('辞書データの JSON を解析できません。ファイルが壊れている可能性があります。');
  }
  return { name, data };
}

/** 配布アセットの URL を組み立てる (jmdict / kanjidic)。 */
export function dataFileUrl(kind, pack = 'standard', tag = RELEASE_TAG) {
  const config = DATA_PACKS[pack] || DATA_PACKS.standard;
  const base = kind === 'kanjidic' ? config.kanjidic : config.jmdict;
  return `${RELEASE_BASE}/${encodeURIComponent(tag)}/${encodeURIComponent(`${base}-${tag}.json.tgz`)}`;
}

/* ==========================================================
   検索索引
   ========================================================== */

function tokenizeGloss(gloss) {
  const normalized = normalizeLatin(gloss).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const keys = new Set();
  if (normalized) keys.add(normalized);
  for (const token of normalized.split(' ')) if (token) keys.add(token);
  return keys;
}

function mapPush(map, key, index) {
  if (!key) return;
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(index);
}

/**
 * データセットから検索索引を組み立てる。索引は保存せず、読み込み時に作る。
 * headMap は漢字・かなの見出しを、glossMap は英語の語義トークンを引く。
 */
export function buildIndex(dataset) {
  const words = asArray(dataset?.words);
  const kanji = asArray(dataset?.kanji);
  const headMap = new Map();
  const kanaMap = new Map();
  const glossMap = new Map();
  const kanjiMap = new Map();

  words.forEach((word, index) => {
    const headKeys = new Set();
    for (const k of asArray(word.kanji)) headKeys.add(normalizeJapanese(k.text));
    for (const k of asArray(word.kana)) {
      const key = normalizeJapanese(k.text);
      headKeys.add(key);
      mapPush(kanaMap, key, index);
    }
    if (headKeys.size === 0 && word.head) headKeys.add(normalizeJapanese(word.head));
    for (const key of headKeys) mapPush(headMap, key, index);

    for (const sense of asArray(word.senses)) {
      for (const gloss of asArray(sense.gloss)) {
        for (const token of tokenizeGloss(gloss)) mapPush(glossMap, token, index);
      }
    }
  });

  kanji.forEach((char, index) => {
    if (char.literal && !kanjiMap.has(char.literal)) kanjiMap.set(char.literal, index);
  });

  return {
    words,
    kanji,
    headMap,
    kanaMap,
    glossMap,
    kanjiMap,
    headKeys: [...headMap.keys()].sort(),
    kanaKeys: [...kanaMap.keys()].sort(),
    glossKeys: [...glossMap.keys()].sort(),
  };
}

/**
 * 昇順ソート済みの文字列配列から、指定プレフィックスの範囲 [start, end) を返す。
 * 日本語は BMP に収まるため終端に U+FFFF を使う。
 */
export function prefixRange(sortedKeys, prefix) {
  const keys = asArray(sortedKeys);
  if (!prefix) return [0, keys.length];
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  const upper = `${prefix}\uffff`;
  let lo2 = start;
  let hi2 = keys.length;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (keys[mid] < upper) lo2 = mid + 1;
    else hi2 = mid;
  }
  return [start, lo2];
}

function rankResults(index, scored, limit) {
  const items = [...scored.entries()].map(([idx, score]) => ({ idx, score, word: index.words[idx] }));
  items.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.word.common) - Number(a.word.common) ||
      a.word.head.length - b.word.head.length ||
      a.word.head.localeCompare(b.word.head, 'ja'),
  );
  return items.slice(0, limit).map((item) => ({ ...item.word, score: item.score }));
}

function collectPrefix(map, keys, prefix, add, max) {
  const [start, end] = prefixRange(keys, prefix);
  const stop = Math.min(end, start + max);
  for (let i = start; i < stop; i += 1) {
    for (const idx of map.get(keys[i]) || []) add(idx, 2);
  }
}

/** 日本語 (見出し・かな) で引く。ローマ字入力はひらがなに直してから引く。 */
export function searchJapanese(index, query, { limit = 50, prefixLimit = 200 } = {}) {
  const q = japaneseQuery(query);
  if (!q) return [];
  const scored = new Map();
  const add = (idx, score) => {
    const cur = scored.get(idx);
    if (cur === undefined || score < cur) scored.set(idx, score);
  };
  for (const idx of index.headMap.get(q) || []) add(idx, 0);
  collectPrefix(index.headMap, index.headKeys, q, add, prefixLimit);
  return rankResults(index, scored, limit);
}

/** 英語の語義で引く (英和)。 */
export function searchEnglish(index, query, { limit = 50, prefixLimit = 200 } = {}) {
  const q = normalizeLatin(query);
  if (!q) return [];
  const scored = new Map();
  const add = (idx, score) => {
    const cur = scored.get(idx);
    if (cur === undefined || score < cur) scored.set(idx, score);
  };
  for (const idx of index.glossMap.get(q) || []) add(idx, 0);
  collectPrefix(index.glossMap, index.glossKeys, q, add, prefixLimit);
  return rankResults(index, scored, limit);
}

/** モード ('ja' | 'en') に応じて検索する。 */
export function search(index, query, options = {}) {
  const mode = options.mode === 'en' ? 'en' : 'ja';
  return mode === 'en' ? searchEnglish(index, query, options) : searchJapanese(index, query, options);
}

/** 漢字表記にその文字列を含む語を探す (漢字モード)。 */
export function searchByKanji(index, query, { limit = 50 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const scored = new Map();
  index.words.forEach((word, idx) => {
    if (asArray(word.kanji).some((k) => k.text.includes(q))) scored.set(idx, 0);
  });
  return rankResults(index, scored, limit);
}

/** 漢字 1 字の情報を返す (Kanjidic)。 */
export function lookupKanji(index, char) {
  const key = String(char ?? '').trim();
  if (!key) return null;
  const idx = index.kanjiMap.get(key[0]);
  return idx === undefined ? null : index.kanji[idx];
}

/** データセットの統計 (UI 表示用)。 */
export function datasetStats(dataset) {
  return {
    words: asArray(dataset?.words).length,
    kanji: asArray(dataset?.kanji).length,
    pack: dataset?.pack ?? null,
  };
}

/* ==========================================================
   単語帳 / ノートへの受け渡し
   ========================================================== */

/** 1 語から暗記カード (study-cards 用) のペイロードを作る。 */
export function buildStudyCard(word, sense = null) {
  const s = sense || asArray(word?.senses)[0] || { gloss: [] };
  return {
    front: String(word?.head ?? ''),
    back: asArray(s.gloss).slice(0, 3).join('; '),
    reading: asArray(word?.kana).map((k) => k.text).join('・'),
    tags: ['dictionary', ...asArray(s.pos).slice(0, 2)],
    source: 'dictionary',
  };
}

/** 1 語からノート (notes-vault 用) のペイロードを作る。 */
export function buildNote(word, memo = '') {
  const meaning = asArray(asArray(word?.senses)[0]?.gloss).join('; ');
  const reading = asArray(word?.kana).map((k) => k.text).join('・');
  return {
    title: String(word?.head ?? ''),
    body: [reading, meaning, String(memo ?? '')].filter(Boolean).join('\n'),
    tags: ['dictionary'],
    source: 'dictionary',
  };
}

/**
 * 受け渡しキューに 1 件足す (イミュータブル)。
 * key に文字列を渡すとそのフィールド、関数を渡すとその戻り値で重複を排除する。
 * limit を超えたら古い方から捨てる。
 */
export function pushInbox(list, item, { limit = INBOX_LIMIT, key = null } = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  let filtered = arr;
  if (key) {
    const keyOf = typeof key === 'function' ? key : (x) => x?.[key];
    const target = keyOf(item);
    if (target !== undefined && target !== null) {
      filtered = arr.filter((x) => keyOf(x) !== target);
    }
  }
  filtered.push(item);
  return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
}

/* ==========================================================
   表示補助 (純関数)
   ========================================================== */

/** バイト数を人が読める表記にする (1024 基準)。 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

/** 単語の読みを 1 行にまとめる (先頭 3 件)。 */
export function readingLine(word) {
  return asArray(word?.kana).map((k) => k.text).slice(0, 3).join('・');
}

/** 単語の代表的な語義を 1 行にまとめる (先頭の語義グループから max 件)。 */
export function glossLine(word, { max = 4, senses = 2 } = {}) {
  const glosses = [];
  for (const sense of asArray(word?.senses).slice(0, senses)) {
    for (const gloss of asArray(sense.gloss)) {
      if (glosses.length >= max) break;
      glosses.push(gloss);
    }
    if (glosses.length >= max) break;
  }
  return glosses.join('; ');
}
