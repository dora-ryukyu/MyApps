/**
 * Music Library — 純ロジック
 *
 * ブラウザでも Node でも動く依存ゼロのモジュール。
 * DOM / Web API / IndexedDB / File System Access は一切書かない
 * （`node --test` で検証する部分だけをここに置く）。
 *
 *   - 音源メタデータの正規化・シリアライズ
 *   - 検索 / 並べ替え / 集計
 *   - プレイリストと M3U / M3U8 の入出力
 *   - タグ差分と ID3v2 フレーム計画
 *   - ファイル名パターンの整形
 *
 * music-metadata (MIT) と browser-id3-writer (MIT) は script.js 側で
 * CDN から読み、ここには「どのタグをどう扱うか」の方針だけを置く。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 走査対象にする音声拡張子（music-metadata が読める形式） */
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.aiff',
  '.aif',
  '.aifc',
  '.wma',
  '.asf',
  '.ape',
  '.wv',
  '.mpc',
  '.mp2',
  '.mka',
  '.webm',
  '.dsf',
  '.dff',
];

/** タグ書き込み（ID3v2 上書き）に対応する拡張子。他は読み取り専用。 */
export const WRITABLE_EXTENSIONS = ['.mp3'];

/** 一覧に表示する列と並べ替えキー */
export const SORT_KEYS = ['file', 'title', 'artist', 'album', 'year', 'track', 'genre', 'duration', 'size'];

export const SORT_OPTIONS = [
  { key: 'track', label: 'アルバム内トラック番号' },
  { key: 'title', label: 'タイトル' },
  { key: 'artist', label: 'アーティスト' },
  { key: 'album', label: 'アルバム' },
  { key: 'year', label: '年' },
  { key: 'genre', label: 'ジャンル' },
  { key: 'duration', label: '長さ' },
  { key: 'size', label: 'ファイルサイズ' },
  { key: 'file', label: 'ファイル名' },
];

/** 個別に編集できるタグ項目（差分計算・ID3 書き込みの対象） */
export const TAG_FIELDS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'trackNo',
  'trackTotal',
  'discNo',
  'discTotal',
  'year',
  'genre',
  'composer',
  'comment',
];

export const TAG_LABELS = {
  title: 'タイトル',
  artist: 'アーティスト',
  album: 'アルバム',
  albumArtist: 'アルバムアーティスト',
  trackNo: 'トラック番号',
  trackTotal: 'トラック総数',
  discNo: 'ディスク番号',
  discTotal: 'ディスク総数',
  year: '年',
  genre: 'ジャンル',
  composer: '作曲者',
  comment: 'コメント',
};

/** ファイル名パターンのプリセット（{token} を置換する） */
export const FILE_PATTERN_PRESETS = [
  { id: 'track-title', label: '{track} - {title}', pattern: '{track} - {title}' },
  { id: 'artist-title', label: '{artist} - {title}', pattern: '{artist} - {title}' },
  { id: 'album-artist-title', label: '{album}/{track} {artist} - {title}', pattern: '{album}/{track} {artist} - {title}' },
  { id: 'number-title', label: '{num} - {title}', pattern: '{num} - {title}' },
];

export const DEFAULT_FILE_PATTERN = '{track} - {title}';

/** M3U で使う改行。M3U8 も同じ生成関数を使う（UTF-8 で保存する）。 */
export const M3U_LINE_SEPARATOR = '\n';

/** IndexedDB に保存するライブラリ/プレイリストのスキーマ版 */
export const LIBRARY_SCHEMA_VERSION = 1;

/* ==========================================================
   汎用ユーティリティ
   ========================================================== */

/** 数値を範囲内に丸める。NaN は下限に寄せる。 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 有限数なら数値、そうでなければ fallback を返す。null/undefined/空文字は欠損として扱う。 */
export function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 検索・比較用にテキストを正規化する（NFKC / 小文字 / 空白圧縮）。 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 重複を除いた文字列配列を返す（空文字は除く）。 */
export function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    const s = String(value ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 文字列 / 配列のどちらでも最初の非空文字列を返す。 */
export function firstString(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null && String(item).trim()) return String(item).trim();
    }
    return '';
  }
  return value == null ? '' : String(value).trim();
}

/* ==========================================================
   ファイル名 / 表示フォーマット
   ========================================================== */

/** 拡張子を小文字・ドット付きで返す（無ければ空文字）。 */
export function extensionOf(name) {
  const base = baseFileName(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** パスからディレクトリを除いたファイル名を返す。 */
export function baseFileName(name) {
  const s = String(name ?? '');
  const normalized = s.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

/** 拡張子を除いたファイル名を返す。 */
export function fileStem(name) {
  const base = baseFileName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 拡張子が音声ファイルかどうか。 */
export function isAudioFileName(name) {
  return AUDIO_EXTENSIONS.includes(extensionOf(name));
}

/** タグを書き換えられる形式かどうか（MP3 のみ）。 */
export function isWritableFileName(name) {
  return WRITABLE_EXTENSIONS.includes(extensionOf(name));
}

/** バイト数を人間が読める文字列にする。 */
export function formatBytes(bytes) {
  const n = toFiniteNumber(bytes, null);
  if (n == null || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 秒数を m:ss / h:mm:ss にする。 */
export function formatDuration(seconds) {
  const n = toFiniteNumber(seconds, null);
  if (n == null || n < 0) return '--:--';
  const total = Math.round(n);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}

/** "m:ss" / "h:mm:ss" を秒に戻す（M3U の EXTINF 読み込み用）。 */
export function parseDuration(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** ビットレートを kbps 表示にする。 */
export function formatBitrate(bps) {
  const n = toFiniteNumber(bps, null);
  if (n == null || n <= 0) return '';
  return `${Math.round(n / 1000)} kbps`;
}

/** サンプリング周波数を kHz 表示にする。 */
export function formatSampleRate(hz) {
  const n = toFiniteNumber(hz, null);
  if (n == null || n <= 0) return '';
  const khz = n / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** トラック番号を "3/12" 形式にする。 */
export function formatTrackNo(trackNo, trackTotal) {
  const no = toFiniteNumber(trackNo, null);
  const total = toFiniteNumber(trackTotal, null);
  if (no == null && total == null) return '';
  if (total != null) return `${no ?? '?'}/${total}`;
  return String(no);
}

/** ファイル名に使えない文字を安全な文字へ置き換える。 */
export function sanitizeFileName(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ==========================================================
   タグの正規化
   ========================================================== */

/** 配列/文字列のジャンルを文字列配列にそろえる。 */
export function normalizeGenres(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return uniqueStrings(values.flatMap((v) => String(v).split(';')));
}

/** 配列/文字列のアーティストを文字列配列にそろえる。 */
export function normalizeArtists(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return uniqueStrings(values);
}

/** ルーズな入力（music-metadata の出力など）を正規化した track にする。 */
export function normalizeTrack(input = {}) {
  let artists = normalizeArtists(input.artists);
  if (!artists.length) {
    artists = Array.isArray(input.artist) ? normalizeArtists(input.artist) : normalizeArtists(String(firstString(input.artist)).split(';'));
  }
  let genres = normalizeGenres(input.genres);
  if (!genres.length) genres = normalizeGenres(input.genre);
  const name = baseFileName(input.name ?? input.path ?? '');
  const path = String(input.path ?? name);
  const trackTotal = toFiniteNumber(input.trackTotal ?? input.totalTracks ?? null, null);
  const discTotal = toFiniteNumber(input.discTotal ?? input.totalDiscs ?? null, null);
  return {
    id: input.id ?? makeTrackId(path, input.size),
    path,
    name,
    ext: input.ext ? String(input.ext).toLowerCase() : extensionOf(name),
    title: firstString(input.title),
    artist: artists.join('; '),
    artists,
    albumArtist: firstString(input.albumArtist),
    album: firstString(input.album),
    trackNo: toFiniteNumber(input.trackNo ?? input.track ?? null, null),
    trackTotal,
    discNo: toFiniteNumber(input.discNo ?? input.disc ?? null, null),
    discTotal,
    year: toFiniteNumber(input.year ?? null, null),
    genre: genres.join('; '),
    genres,
    composer: firstString(input.composer),
    comment: firstString(input.comment),
    duration: toFiniteNumber(input.duration ?? null, null),
    bitrate: toFiniteNumber(input.bitrate ?? null, null),
    sampleRate: toFiniteNumber(input.sampleRate ?? null, null),
    bitsPerSample: toFiniteNumber(input.bitsPerSample ?? null, null),
    channels: toFiniteNumber(input.channels ?? null, null),
    codec: firstString(input.codec),
    lossless: Boolean(input.lossless),
    size: toFiniteNumber(input.size ?? null, null),
    modified: Boolean(input.modified),
    error: input.error ? String(input.error) : '',
  };
}

/** 安定した id を作る。同じパスでもサイズが変われば別物として扱う。 */
export function makeTrackId(path, size) {
  return `${String(path ?? '')}::${toFiniteNumber(size, 0) ?? 0}`;
}

/**
 * base に対する patch を適用した新しい track を返す。
 * patch の `artist` / `genre` 文字列が古い `artists` / `genres` 配列に負けないよう、
 * 派生配列を一度落としてから正規化する。
 */
export function mergeTrack(base, patch) {
  return normalizeTrack({ ...base, artists: undefined, genres: undefined, ...patch });
}

/** 一覧に出す表示名。タグが無ければファイル名を使う。 */
export function trackDisplayName(track) {
  const title = firstString(track.title) || fileStem(track.name || track.path);
  const artist = firstString(track.artist);
  return artist ? `${artist} - ${title}` : title;
}

/** 検索対象になるテキストをまとめて正規化する。 */
export function trackSearchText(track) {
  return normalizeText(
    [
      track.title,
      track.artist,
      track.albumArtist,
      track.album,
      track.genre,
      track.year,
      track.name,
      track.path,
      track.composer,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/** インクリメンタル検索の 1 件判定。空クエリは常に一致。 */
export function matchesQuery(track, query) {
  const q = normalizeText(query);
  if (!q) return true;
  const haystack = track.__searchText ?? trackSearchText(track);
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/** 検索を適用した配列を返す。 */
export function searchTracks(tracks, query) {
  const q = normalizeText(query);
  if (!q) return [...tracks];
  return tracks.filter((track) => matchesQuery(track, query));
}

/* ==========================================================
   並べ替え / 集計
   ========================================================== */

/** 指定キーで比較する。文字列はロケール非依存の小文字比較、数値は欠損を末尾へ。 */
export function compareTracks(a, b, key) {
  if (key === 'duration' || key === 'size' || key === 'year' || key === 'track') {
    return compareNullableNumbers(a[key], b[key]);
  }
  const av = normalizeText(key === 'file' ? a.name : a[key]);
  const bv = normalizeText(key === 'file' ? b.name : b[key]);
  if (av === bv) return compareNullableNumbers(a.trackNo, b.trackNo);
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? -1 : 1;
}

function compareNullableNumbers(a, b) {
  const an = toFiniteNumber(a, null);
  const bn = toFiniteNumber(b, null);
  if (an == null && bn == null) return 0;
  if (an == null) return 1;
  if (bn == null) return -1;
  return an - bn;
}

/** 並べ替えた新しい配列を返す（元は変更しない）。 */
export function sortTracks(tracks, key = 'file', direction = 'asc') {
  const dir = direction === 'desc' ? -1 : 1;
  const sorted = [...tracks];
  sorted.sort((a, b) => compareTracks(a, b, key) * dir);
  return sorted;
}

/** キーでグループ化した配列を返す（キーは表示用の生値）。 */
export function groupTracks(tracks, key) {
  const map = new Map();
  for (const track of tracks) {
    const raw = key === 'file' ? track.name : track[key];
    const groupKey = raw == null || raw === '' ? '(不明)' : String(raw);
    if (!map.has(groupKey)) map.set(groupKey, []);
    map.get(groupKey).push(track);
  }
  return [...map.entries()].map(([groupKey, items]) => ({ key: groupKey, tracks: items }));
}

/** ライブラリ全体の要約。 */
export function summarizeLibrary(tracks) {
  let duration = 0;
  let size = 0;
  let durationKnown = 0;
  const artists = new Set();
  const albums = new Set();
  const genres = new Set();
  const formats = new Set();
  for (const track of tracks) {
    if (Number.isFinite(track.duration)) {
      duration += track.duration;
      durationKnown += 1;
    }
    if (Number.isFinite(track.size)) size += track.size;
    if (track.artist) artists.add(track.artist);
    if (track.album) albums.add(track.album);
    for (const genre of track.genres ?? []) genres.add(genre);
    if (track.ext) formats.add(track.ext);
  }
  return {
    count: tracks.length,
    duration,
    durationKnown,
    size,
    artists: artists.size,
    albums: albums.size,
    genres: [...genres].sort(),
    formats: [...formats].sort(),
  };
}

/* ==========================================================
   タグ編集 / ID3 フレーム計画
   ========================================================== */

/** 編集前後の差分を返す（変更のあったフィールドのみ）。 */
export function diffTags(before, after) {
  const changes = [];
  for (const field of TAG_FIELDS) {
    const a = normalizeFieldValue(field, before?.[field]);
    const b = normalizeFieldValue(field, after?.[field]);
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

function normalizeFieldValue(field, value) {
  if (field === 'trackNo' || field === 'trackTotal' || field === 'discNo' || field === 'discTotal') {
    const n = toFiniteNumber(value, null);
    return n == null ? '' : String(n);
  }
  if (field === 'year') {
    const n = toFiniteNumber(value, null);
    return n == null ? '' : String(Math.trunc(n));
  }
  return firstString(value);
}

/**
 * track から ID3v2.3 フレームの書き込み計画を作る純ロジック。
 * script.js はこれを browser-id3-writer の setFrame に流すだけ。
 * 戻り値は空値を除いた [{ frame, value }] の配列。
 */
export function buildId3FramePlan(track) {
  const frames = [];
  const push = (frame, value) => {
    if (value === undefined || value === null || value === '') return;
    frames.push({ frame, value });
  };
  push('TIT2', firstString(track.title));
  if (track.artists?.length) push('TPE1', track.artists);
  else push('TPE1', firstString(track.artist));
  push('TALB', firstString(track.album));
  push('TPE2', firstString(track.albumArtist));
  push('TCON', track.genres?.length ? track.genres : firstString(track.genre));
  push('TCOM', firstString(track.composer));
  push('TRCK', formatTrackNo(track.trackNo, track.trackTotal));
  push('TPOS', formatTrackNo(track.discNo, track.discTotal));
  push('TYER', toFiniteNumber(track.year, null));
  push('COMM', firstString(track.comment) ? { description: '', text: firstString(track.comment), language: 'eng' } : '');
  return frames;
}

/* ==========================================================
   ファイル名パターン
   ========================================================== */

/** パターン中の {token} を track の値で置換する。値はファイル名として安全化してから埋める。 */
export function formatPattern(pattern, track) {
  const values = {
    title: firstString(track.title) || fileStem(track.name || track.path) || 'untitled',
    artist: firstString(track.artist) || 'unknown artist',
    albumartist: firstString(track.albumArtist),
    album: firstString(track.album) || 'unknown album',
    genre: firstString(track.genre),
    year: toFiniteNumber(track.year, null) == null ? '' : String(Math.trunc(track.year)),
    track: track.trackNo == null ? '' : String(track.trackNo).padStart(2, '0'),
    num: track.trackNo == null ? '' : String(track.trackNo),
    disc: track.discNo == null ? '' : String(track.discNo),
  };
  return String(pattern ?? DEFAULT_FILE_PATTERN).replace(/\{(\w+)\}/g, (match, token) => {
    const key = token.toLowerCase();
    return key in values ? sanitizeTokenValue(values[key]) : match;
  });
}

/** パターン埋め込み用に、パス区切りと禁止文字を除去する。 */
function sanitizeTokenValue(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** パターンから拡張子付きの安全なファイル名を作る。 */
export function buildTrackFileName(track, pattern = DEFAULT_FILE_PATTERN, ext = track.ext) {
  const raw = formatPattern(pattern, track);
  const segments = raw.split('/').map((part) => sanitizeFileName(part)).filter(Boolean);
  if (!segments.length) segments.push(sanitizeFileName(fileStem(track.name || track.path) || 'untitled'));
  const suffix = String(ext ?? '').startsWith('.') ? String(ext) : ext ? `.${ext}` : '';
  return segments.join('/') + suffix;
}

/* ==========================================================
   プレイリスト
   ========================================================== */

/** 新しいプレイリストを作る。 */
export function createPlaylist(name, ids = []) {
  return {
    id: `pl_${normalizeText(name).replace(/\s+/g, '-') || 'playlist'}_${ids.length}`,
    name: firstString(name) || '新しいプレイリスト',
    items: [...new Set(ids)],
    createdAt: null,
    updatedAt: null,
  };
}

/** 末尾に追加する（既にあれば何もしない）。 */
export function addToPlaylist(playlist, id) {
  if (!id || playlist.items.includes(id)) return playlist;
  return { ...playlist, items: [...playlist.items, id] };
}

/** 最初に見つかった一致を 1 つだけ除く。 */
export function removeFromPlaylist(playlist, id) {
  const index = playlist.items.indexOf(id);
  if (index < 0) return playlist;
  const items = [...playlist.items];
  items.splice(index, 1);
  return { ...playlist, items };
}

/** from の要素を to の位置へ移動する。 */
export function moveInPlaylist(playlist, from, to) {
  const items = [...playlist.items];
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return playlist;
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
  return { ...playlist, items };
}

/** プレイリストを track の配列に解決する（見つからない id は飛ばす）。 */
export function resolvePlaylist(playlist, tracks) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return playlist.items.map((id) => byId.get(id)).filter(Boolean);
}

/** プレイリストの件数・合計時間。 */
export function playlistStats(playlist, tracks) {
  const resolved = resolvePlaylist(playlist, tracks);
  let duration = 0;
  let known = 0;
  for (const track of resolved) {
    if (Number.isFinite(track.duration)) {
      duration += track.duration;
      known += 1;
    }
  }
  const total = playlist.items.length;
  return { total, missing: total - resolved.length, duration, durationKnown: known };
}

/** すべてのライブラリ track を 1 本のプレイリストにする。 */
export function playlistFromTracks(name, tracks) {
  return createPlaylist(name, tracks.map((t) => t.id));
}

/** プレイリスト名をファイル名に使える形にする。 */
export function buildPlaylistFileName(name, ext = 'm3u') {
  const safe = sanitizeFileName(name).replace(/\s+/g, '_') || 'playlist';
  const suffix = String(ext ?? '').startsWith('.') ? String(ext) : `.${ext}`;
  return safe + suffix;
}

/* ==========================================================
   M3U / M3U8
   ========================================================== */

/**
 * プレイリストを M3U (UTF-8, = M3U8) テキストに変換する。
 * options.name を渡すと #PLAYLIST 行を付ける。
 * options.pathOf(track) で各行のパスを差し替えられる（既定は track.path）。
 */
export function formatM3U(playlist, tracks, options = {}) {
  const resolved = resolvePlaylist(playlist, tracks);
  const pathOf = typeof options.pathOf === 'function' ? options.pathOf : (track) => track.path || track.name;
  const lines = ['#EXTM3U'];
  const name = options.name ?? playlist?.name;
  if (name) lines.push(`#PLAYLIST:${name}`);
  for (const track of resolved) {
    const seconds = Number.isFinite(track.duration) ? Math.round(track.duration) : -1;
    lines.push(`#EXTINF:${seconds},${trackDisplayName(track)}`);
    lines.push(pathOf(track));
  }
  return lines.join(M3U_LINE_SEPARATOR) + M3U_LINE_SEPARATOR;
}

/** すべての track から M3U テキストを作る（プレイリスト無し）。 */
export function formatM3UFromTracks(name, tracks, options = {}) {
  return formatM3U(playlistFromTracks(name, tracks), tracks, { ...options, name });
}

/**
 * M3U / M3U8 テキストを解析する。
 * 戻り値: { name, entries: [{ path, title, duration }] }
 */
export function parseM3U(text) {
  const entries = [];
  let name = '';
  let pending = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const body = line.slice('#EXTINF:'.length);
      const comma = body.indexOf(',');
      const durationText = comma >= 0 ? body.slice(0, comma) : body;
      const title = comma >= 0 ? body.slice(comma + 1).trim() : '';
      pending = { duration: parseDuration(durationText), title };
      continue;
    }
    if (line.startsWith('#PLAYLIST:')) {
      name = line.slice('#PLAYLIST:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    entries.push({
      path: line,
      title: pending?.title ?? '',
      duration: pending?.duration ?? null,
    });
    pending = null;
  }
  return { name, entries };
}

/** M3U のエントリをライブラリの track と突き合わせる（ファイル名の完全一致）。 */
export function matchM3UEntries(entries, tracks) {
  const byBase = new Map();
  const byStem = new Map();
  for (const track of tracks) {
    byBase.set(normalizeText(baseFileName(track.path)), track);
    byStem.set(normalizeText(fileStem(track.name || track.path)), track);
  }
  return entries.map((entry) => {
    const base = normalizeText(baseFileName(entry.path));
    const stem = normalizeText(fileStem(entry.path));
    return {
      ...entry,
      track: byBase.get(base) ?? byStem.get(stem) ?? null,
    };
  });
}

/* ==========================================================
   シリアライズ（IndexedDB 用）
   ========================================================== */

/** 実行時専用のフィールドを除いた保存用オブジェクトを返す。 */
export function serializeTrack(track) {
  const { __searchText, file, handle, coverUrl, coverData, coverFormat, ...rest } = track;
  return JSON.parse(JSON.stringify(rest));
}

/** 保存用オブジェクトを track に戻す。 */
export function deserializeTrack(obj) {
  return normalizeTrack(obj);
}

/** ライブラリ全体の保存用ペイロード。 */
export function serializeLibrary(tracks, savedAt = null) {
  return {
    version: LIBRARY_SCHEMA_VERSION,
    savedAt,
    tracks: tracks.map(serializeTrack),
  };
}

/** 保存用ペイロードを読み込む（版が違っても最低限の形に寄せる）。 */
export function deserializeLibrary(payload) {
  const list = Array.isArray(payload) ? payload : payload?.tracks;
  if (!Array.isArray(list)) return { version: LIBRARY_SCHEMA_VERSION, savedAt: null, tracks: [] };
  return {
    version: toFiniteNumber(payload?.version, LIBRARY_SCHEMA_VERSION) ?? LIBRARY_SCHEMA_VERSION,
    savedAt: payload?.savedAt ?? null,
    tracks: list.map(deserializeTrack),
  };
}

/** プレイリストの保存用ペイロード。 */
export function serializePlaylists(playlists) {
  return playlists.map((pl) => ({
    id: pl.id,
    name: pl.name,
    items: [...pl.items],
    createdAt: pl.createdAt ?? null,
    updatedAt: pl.updatedAt ?? null,
  }));
}

/** プレイリスト配列を型に寄せる。 */
export function deserializePlaylists(list) {
  if (!Array.isArray(list)) return [];
  return list.map((pl) => ({
    id: String(pl?.id ?? ''),
    name: firstString(pl?.name) || 'プレイリスト',
    items: Array.isArray(pl?.items) ? pl.items.map(String) : [],
    createdAt: pl?.createdAt ?? null,
    updatedAt: pl?.updatedAt ?? null,
  }));
}
