/**
 * pipeline.mjs — Book Reader の純ロジック
 *
 * DOM に依存しない計算・検証だけをまとめる。EPUB/CBZ のページ進行、
 * 目次の平坦化、読書位置 (しおり) のシリアライズ/復元、CBZ のページ並び、
 * 表示設定の正規化を扱い、node --test からそのまま検証できる。
 */

/* ==========================================================
   定数
   ========================================================== */

/** 保存する読書状態のスキーマ版。上がったら古い状態は破棄する。 */
export const STATE_VERSION = 1;

/** 対応する電子書籍の拡張子 */
export const BOOK_EXTENSIONS = ['.epub', '.cbz'];

/** CBZ (画像 zip) として扱う画像拡張子 */
export const IMAGE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.avif', '.bmp', '.jxl', '.tif', '.tiff',
];

/** 本文テーマ (「アプリのテーマ」とは別の、本の地色) */
export const READER_THEMES = ['light', 'sepia', 'dark'];

/** ページ送りの流し方 */
export const FLOWS = ['paginated', 'scrolled'];

export const FONT_SCALE = { min: 0.75, max: 2, step: 0.05, default: 1 };
export const MARGIN = { min: 16, max: 128, step: 8, default: 48 };

export const DEFAULT_SETTINGS = Object.freeze({
  readerTheme: 'light',
  fontScale: FONT_SCALE.default,
  margin: MARGIN.default,
  flow: 'paginated',
});

/** 本文テーマごとの配色 (buildReaderCss で使う) */
export const READER_THEME_PALETTE = Object.freeze({
  light: { scheme: 'light', background: '#ffffff', color: '#1f2328', link: '#2563eb' },
  sepia: { scheme: 'light', background: '#f8f1e3', color: '#3f3427', link: '#9a5b1e' },
  dark: { scheme: 'dark', background: '#15171c', color: '#e6e6e6', link: '#7cb2ff' },
});

/* ==========================================================
   基本ユーティリティ
   ========================================================== */

export function clamp01(value) {
  const n = Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(n, 0), 1);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * パスの末尾の拡張子 (小文字, ドット込み) を返す。
 * ".gitignore" のようなドットファイルは拡張子なし扱いにする。
 */
export function fileExtension(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().toLowerCase();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

/** 対応形式かどうか */
export function isSupportedBookFile(name) {
  return BOOK_EXTENSIONS.includes(fileExtension(name));
}

/** 拡張子から 'epub' | 'cbz' | null を返す */
export function detectFormat(name) {
  const ext = fileExtension(name);
  if (ext === '.epub') return 'epub';
  if (ext === '.cbz') return 'cbz';
  return null;
}

/* ==========================================================
   CBZ のページ (画像エントリ) の並び
   ========================================================== */

/** CBZ 内のエントリが表示対象の画像かどうか */
export function isImageEntry(name) {
  const raw = String(name ?? '');
  if (!raw || raw.endsWith('/')) return false;
  if (raw.startsWith('__MACOSX/') || raw.includes('/__MACOSX/')) return false;
  const base = raw.split('/').pop();
  if (!base || base.startsWith('.')) return false;
  return IMAGE_EXTENSIONS.includes(fileExtension(base));
}

/**
 * 数字を数値として比較する自然順ソート。
 * "page2.jpg" を "page10.jpg" より前に置く。
 */
export function naturalCompare(a, b) {
  const tokenize = (value) => String(value).toLowerCase().match(/(\d+|\D+)/g) ?? [];
  const ax = tokenize(a);
  const bx = tokenize(b);
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i += 1) {
    const x = ax[i];
    const y = bx[i];
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/** 画像エントリだけを残し、自然順に並べる */
export function sortCbzPages(names) {
  return (Array.isArray(names) ? names : [])
    .filter(isImageEntry)
    .slice()
    .sort(naturalCompare);
}

/* ==========================================================
   ページ進行
   ========================================================== */

/** index を [0, count-1] に丸める。count<=0 なら -1。 */
export function clampIndex(index, count) {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return -1;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.min(Math.max(i, 0), n - 1);
}

export function nextIndex(index, count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n <= 0) return -1;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.min(i + 1, n - 1);
}

export function prevIndex(index, count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n <= 0) return -1;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.max(i - 1, 0);
}

/** 現在ページの進捗 (%)。count<=0 なら 0。 */
export function progressPercent(index, count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n <= 0) return 0;
  const i = clampIndex(index, n);
  return clamp01((i + 1) / n) * 100;
}

/** 電子書籍全体の進捗 (0..1)。セクション内 fraction も加味する。 */
export function overallFraction(index, fraction, sectionCount) {
  const count = Number.isFinite(sectionCount) && sectionCount > 0
    ? Math.floor(sectionCount)
    : 1;
  const i = clampIndex(index, count);
  if (i < 0) return 0;
  return clamp01((i + clamp01(fraction)) / count);
}

/** "3 / 42" のようなページ表記 */
export function buildCbzPageLabel(index, count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n <= 0) return '0 / 0';
  return `${clampIndex(index, n) + 1} / ${n}`;
}

/* ==========================================================
   目次
   ========================================================== */

function tocLabel(label) {
  if (label == null) return '';
  if (typeof label === 'string') return label;
  if (typeof label === 'object') {
    const keys = Object.keys(label);
    return keys.length ? String(label[keys[0]] ?? '') : '';
  }
  return String(label);
}

/**
 * foliate-js の TOC ツリー ({ label, href, subitems }) を
 * 平坦な [{ label, href, depth }] に変換する。
 */
export function normalizeToc(items) {
  const out = [];
  const visit = (list, depth) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      out.push({
        label: tocLabel(item.label),
        href: typeof item.href === 'string' ? item.href : '',
        depth,
      });
      visit(item.subitems, depth + 1);
    }
  };
  visit(items, 0);
  return out;
}

/** href (断片つき可) からクエリ/断片を除いたパスを返す */
export function stripHref(href) {
  return String(href ?? '').split('#')[0].split('?')[0];
}

/** href の #断片 を返す (無ければ '') */
export function hrefFragment(href) {
  const s = String(href ?? '');
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(i + 1) : '';
}

/** basePath を基準に href を解決する (EPUB の相対パス用) */
export function resolveRelativePath(basePath, href) {
  const clean = stripHref(href);
  if (!clean) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith('/')) return clean;
  const base = String(basePath ?? '');
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const segments = (dir + clean).split('/');
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 平坦化済み目次から href が一致する項目の index を返す (無ければ -1) */
export function findTocIndex(toc, href) {
  if (!Array.isArray(toc)) return -1;
  const target = stripHref(href);
  if (!target) return -1;
  return toc.findIndex((item) => stripHref(item?.href) === target);
}

/* ==========================================================
   読書位置・しおりの保存
   ========================================================== */

/**
 * ファイルの同一性判定に使うキー。ファイル名・サイズ・更新時刻から作る。
 * ブラウザは再読込後にファイルへ再アクセスできないため、
 * 「同じファイルを選び直したとき」に続きから再開するために使う。
 */
export function buildBookKey(file = {}) {
  const name = String(file.name ?? 'unknown');
  const size = Number.isFinite(file.size) ? Math.floor(file.size) : 0;
  const mtime = Number.isFinite(file.lastModified) ? Math.floor(file.lastModified) : 0;
  return `book:${name}:${size}:${mtime}`;
}

/** 読書位置を保存できる形に正規化する */
export function normalizeReadingState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sectionCount = Number.isFinite(src.sectionCount) && src.sectionCount > 0
    ? Math.floor(src.sectionCount)
    : 0;
  let index = Number.isFinite(src.index) ? Math.max(0, Math.floor(src.index)) : 0;
  if (sectionCount > 0) index = clampIndex(index, sectionCount);
  if (index < 0) index = 0;
  return {
    v: STATE_VERSION,
    index,
    fraction: clamp01(src.fraction),
    cfi: typeof src.cfi === 'string' ? src.cfi : '',
    label: typeof src.label === 'string' ? src.label : '',
  };
}

export function serializeReadingState(state) {
  return JSON.stringify(normalizeReadingState(state));
}

/** 壊れた JSON や版違いは null を返す (例外を投げない) */
export function deserializeReadingState(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== STATE_VERSION) return null;
  return normalizeReadingState(parsed);
}

/** 2 つの読書位置がほぼ同じか (しおりの重複判定用) */
export function isSameReadingState(a, b) {
  const x = normalizeReadingState(a);
  const y = normalizeReadingState(b);
  if (x.cfi && y.cfi) return x.cfi === y.cfi;
  return x.index === y.index && Math.abs(x.fraction - y.fraction) < 0.005;
}

/** "42% · 第3章" のような表示用ラベル */
export function readingPositionLabel(state) {
  const s = normalizeReadingState(state);
  const percent = `${Math.round(s.fraction * 100)}%`;
  return s.label ? `${percent} · ${s.label}` : percent;
}

/* ==========================================================
   表示設定
   ========================================================== */

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    readerTheme: READER_THEMES.includes(src.readerTheme)
      ? src.readerTheme
      : DEFAULT_SETTINGS.readerTheme,
    fontScale: clampNumber(src.fontScale, FONT_SCALE.min, FONT_SCALE.max, FONT_SCALE.default),
    margin: clampNumber(src.margin, MARGIN.min, MARGIN.max, MARGIN.default),
    flow: FLOWS.includes(src.flow) ? src.flow : DEFAULT_SETTINGS.flow,
  };
}

/**
 * 本の本文へ注入する CSS。文字サイズ・地色・リンク色を設定から生成する。
 * (foliate-view の renderer.setStyles に渡す)
 */
export function buildReaderCss(settings) {
  const s = normalizeSettings(settings);
  const palette = READER_THEME_PALETTE[s.readerTheme];
  const fontSize = Math.round(16 * s.fontScale);
  return [
    `html { color-scheme: ${palette.scheme}; }`,
    `body { background: ${palette.background} !important; color: ${palette.color} !important; font-size: ${fontSize}px; line-height: 1.7; }`,
    `a:link, a:visited { color: ${palette.link}; }`,
    'img, svg, video { max-width: 100%; }',
  ].join('\n');
}

/* ==========================================================
   表示ヘルパー
   ========================================================== */

export function formatBytes(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatPercent(fraction, digits = 0) {
  return `${(clamp01(fraction) * 100).toFixed(digits)}%`;
}

/** ダウンロード用のハイライト書き出しファイル名 */
export function buildHighlightsFileName(baseName) {
  const base = String(baseName ?? 'book').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
  return `${base || 'book'}-highlights.md`;
}
