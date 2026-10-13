/**
 * pipeline.mjs — ローカル RSS/Atom リーダーの純ロジック
 *
 * DOM / fetch / localStorage に依存する処理は script.js が担当し、ここには
 * `node --test` で検証できる計算だけを置く:
 *   - XML の軽量パーサ (RSS 2.0 / Atom / RDF)
 *   - フィード本文の正規化と安定キー (GUID / リンク / 日付) による重複排除・新着差分
 *   - OPML の読み書き
 *   - 本文抽出のフォールバック (script.js は @mozilla/readability を優先し、
 *     読み込めない場合にここの extractArticle を使う)
 *   - HTML → Markdown のフォールバック (script.js は turndown を優先する)
 *   - 購読・既読・あとで読むの状態リデューサとシリアライズ
 *
 * 依存ゼロ。ブラウザと Node の両方で動く。
 *
 * 参考:
 *   rss-parser  https://github.com/rbren/rss-parser          (MIT)
 *   readability https://github.com/mozilla/readability       (Apache-2.0)
 *   turndown    https://github.com/mixmark-io/turndown        (MIT)
 */

/* ==========================================================
   定数
   ========================================================== */

export const APP_ID = 'feed-reader';
export const STATE_KEY = 'myapps:feed-reader:state:v1';
export const STATE_VERSION = 1;

/** notes-vault (P-20261011-01) へクリップを渡すときの sessionStorage キー。 */
export const CLIP_HANDOFF_KEY = 'myapps:note-clip';
export const CLIP_HANDOFF_URL = '../notes-vault/index.html';

/** 本文抽出 / Markdown 化に使うライブラリ (版固定)。script.js が動的 import する。 */
export const READABILITY_MODULE_URL =
  'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/+esm';
export const TURNDOWN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/turndown@7.2.4/+esm';
/** meta.json の net.hosts と一致させること。 */
export const LIBRARY_CDN_HOST = 'cdn.jsdelivr.net';

export const OPML_MIME = 'text/x-opml';
export const OPML_EXT = '.opml';
export const CLIP_MIME = 'text/markdown';

/** 1 フィードあたり保持する記事数の上限。 */
export const MAX_ITEMS_PER_FEED = 300;
/** 抽出する本文 HTML の最大バイト数 (暴走ページ対策)。 */
export const MAX_ARTICLE_BYTES = 400000;
/** localStorage に保持する状態の目安バイト数。 */
export const MAX_STATE_BYTES = 4000000;
/** 取得のタイムアウト (ms)。 */
export const FETCH_TIMEOUT_MS = 15000;

/** 本文抽出のフォールバックで丸ごと落とす要素。 */
const DROP_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed',
  'form', 'button', 'input', 'select', 'textarea', 'nav', 'aside', 'footer', 'header', 'menu',
];

/** XML の名前付き実体 (よく出るものだけ)。 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', minus: '\u2212',
  deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  sect: '\u00a7', para: '\u00b6', dagger: '\u2020', bull: '\u2022',
  lsaquo: '\u2039', rsaquo: '\u203a', permil: '\u2030', shy: '\u00ad',
  prime: '\u2032', Prime: '\u2033', frasl: '\u2044',
};

/* ==========================================================
   文字列ヘルパ
   ========================================================== */

/** XML / HTML の実体参照をデコードする。 */
export function decodeEntities(input) {
  if (input == null) return '';
  return String(input).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      let code;
      if (body[1] === 'x' || body[1] === 'X') code = parseInt(body.slice(2), 16);
      else code = parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? NAMED_ENTITIES[body]
      : match;
  });
}

/** XML の特殊文字をエスケープする。 */
export function escapeXml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** タグを落として空白を整えたプレーンテキストを返す。 */
export function htmlToText(html) {
  return decodeEntities(
    String(html == null ? '' : html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** タイトルや著者名などの 1 行テキストを整える。 */
export function cleanText(input) {
  if (input == null) return '';
  return decodeEntities(String(input))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FNV-1a 32bit。安定キーの生成に使う。 */
export function stableHash(input) {
  let hash = 0x811c9dc5;
  const str = String(input == null ? '' : input);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/* ==========================================================
   XML パーサ (要素・属性・CDATA・実体)
   ========================================================== */

/** 名前空間接頭辞を除いた小文字のローカル名。 */
export function localName(name) {
  const idx = String(name).lastIndexOf(':');
  const base = idx < 0 ? String(name) : String(name).slice(idx + 1);
  return base.toLowerCase();
}

function findTagEnd(src, lt) {
  let quote = null;
  for (let i = lt + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

/**
 * 軽量 XML パーサ。`{ name, localName, attrs, children, text }` の木を返す。
 * 厳密な仕様追従ではなく、一般的なフィード XML を読むためのもの。
 */
export function parseXml(xml) {
  const root = { name: '#root', localName: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(xml == null ? '' : xml);
  const n = src.length;
  const top = () => stack[stack.length - 1];
  let i = 0;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = findTagEnd(src, lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) { top().text += decodeEntities(src.slice(lt)); break; }
    const inner = src.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k > 0) stack.length = k;
      i = gt + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(inner);
    const body = selfClosing ? inner.replace(/\/\s*$/, '') : inner;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) { i = gt + 1; continue; }
    const name = nameMatch[1];
    const attrs = parseAttributes(body.slice(nameMatch[0].length));
    const node = { name, localName: localName(name), attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

function childrenByLocal(node, name) {
  return node.children.filter((c) => c.localName === name);
}

function firstChild(node, name) {
  return node.children.find((c) => c.localName === name);
}

function childText(node, name) {
  const child = firstChild(node, name);
  return child ? child.text : '';
}

/** Atom の `<author><name>...</name></author>` のような入れ子テキスト。 */
function nestedText(node, name, inner) {
  const child = firstChild(node, name);
  if (!child) return '';
  return childText(child, inner) || child.text;
}

/* ==========================================================
   フィードのパース
   ========================================================== */

export function detectFeedFormat(xml) {
  const head = String(xml == null ? '' : xml).slice(0, 4096).toLowerCase();
  if (head.includes('<rdf:rdf')) return 'rdf';
  if (/<rss[\s>]/.test(head)) return 'rss';
  if (/<feed[\s>]/.test(head)) return 'atom';
  return 'unknown';
}

function extractLink(node) {
  const links = childrenByLocal(node, 'link');
  const alternate = links.find((c) => (c.attrs.rel || '').toLowerCase() === 'alternate' && c.attrs.href);
  if (alternate) return alternate.attrs.href.trim();
  const withText = links.find((c) => c.text && c.text.trim());
  if (withText) return decodeEntities(withText.text).trim();
  const withHref = links.find((c) => c.attrs.href);
  if (withHref) return withHref.attrs.href.trim();
  return '';
}

function pickLongest(values) {
  let best = '';
  for (const value of values) {
    const str = String(value == null ? '' : value);
    if (str.length > best.length) best = str;
  }
  return best;
}

function parseRssItem(node) {
  const categories = childrenByLocal(node, 'category')
    .map((c) => cleanText(c.attrs.term || c.text))
    .filter(Boolean);
  return {
    guid: cleanText(childText(node, 'guid') || childText(node, 'id')),
    title: cleanText(childText(node, 'title')),
    link: extractLink(node),
    author: cleanText(
      childText(node, 'creator') || nestedText(node, 'author', 'name') || childText(node, 'author'),
    ),
    published:
      childText(node, 'pubdate') ||
      childText(node, 'date') ||
      childText(node, 'published') ||
      childText(node, 'updated'),
    content: pickLongest([
      childText(node, 'encoded'),
      childText(node, 'content'),
      childText(node, 'description'),
      childText(node, 'summary'),
    ]),
    categories,
  };
}

function parseAtomEntry(node) {
  const categories = childrenByLocal(node, 'category')
    .map((c) => cleanText(c.attrs.term || c.text))
    .filter(Boolean);
  return {
    guid: cleanText(childText(node, 'id') || extractLink(node)),
    title: cleanText(childText(node, 'title')),
    link: extractLink(node),
    author: cleanText(nestedText(node, 'author', 'name') || childText(node, 'author')),
    published: childText(node, 'published') || childText(node, 'updated'),
    content: pickLongest([childText(node, 'content'), childText(node, 'summary')]),
    categories,
  };
}

/** フィード XML を `{ format, title, link, description, items }` に正規化する。 */
export function parseFeed(xml) {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => ['rss', 'feed', 'rdf'].includes(c.localName));
  if (!root) return { format: 'unknown', title: '', link: '', description: '', items: [] };

  if (root.localName === 'feed') {
    return {
      format: 'atom',
      title: cleanText(childText(root, 'title')),
      link: extractLink(root),
      description: cleanText(childText(root, 'subtitle')),
      items: childrenByLocal(root, 'entry').map((node) => normalizeRawItem(parseAtomEntry(node))),
    };
  }

  const rdf = root.localName === 'rdf';
  const channel = rdf ? firstChild(root, 'channel') : firstChild(root, 'channel');
  const itemNodes = rdf
    ? childrenByLocal(root, 'item')
    : (channel ? childrenByLocal(channel, 'item') : []);
  const meta = channel || root;

  return {
    format: rdf ? 'rdf' : 'rss',
    title: cleanText(childText(meta, 'title')),
    link: extractLink(meta),
    description: cleanText(childText(meta, 'description') || childText(meta, 'subtitle')),
    items: itemNodes.map((node) => normalizeRawItem(parseRssItem(node))),
  };
}

/* ==========================================================
   記事の正規化・重複排除・新着差分
   ========================================================== */

export function normalizeUrl(url) {
  if (!url) return '';
  let value = decodeEntities(String(url)).trim();
  if (value.startsWith('//')) value = 'https:' + value;
  return value;
}

function canonicalUrl(url) {
  return normalizeUrl(url).replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
}

export function sameUrl(a, b) {
  const left = canonicalUrl(a);
  const right = canonicalUrl(b);
  return Boolean(left) && left === right;
}

export function isLikelyFeedUrl(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveUrl(href, base) {
  try {
    return new URL(normalizeUrl(href), base || undefined).href;
  } catch {
    return normalizeUrl(href);
  }
}

/** HTML の `<link rel="alternate" type="application/rss+xml">` からフィード URL を拾う。 */
export function discoverFeedLinks(html, baseUrl = '') {
  const out = [];
  const tagRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(String(html == null ? '' : html)))) {
    const tag = m[0];
    const type = (attrOf(tag, 'type') || '').toLowerCase();
    if (!/application\/(rss|atom)\+xml/.test(type)) continue;
    const rel = (attrOf(tag, 'rel') || 'alternate').toLowerCase();
    if (rel && rel !== 'alternate') continue;
    const href = attrOf(tag, 'href');
    if (!href) continue;
    out.push({ url: resolveUrl(href, baseUrl), title: attrOf(tag, 'title') || '' });
  }
  return out;
}

function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (!m) return '';
  return decodeEntities(m[1] !== undefined ? m[1] : m[2]).trim();
}

export function parseDate(input) {
  if (!input) return '';
  const ts = Date.parse(String(input).trim());
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toISOString();
}

/** 生の item オブジェクト (parseRssItem / parseAtomEntry の戻り) を正規化する。 */
export function normalizeRawItem(raw) {
  const publishedAt = parseDate(raw.published);
  const content = String(raw.content || '');
  return {
    guid: String(raw.guid || '').trim(),
    title: cleanText(raw.title) || '(無題)',
    link: normalizeUrl(raw.link || ''),
    author: cleanText(raw.author),
    publishedAt,
    publishedTs: publishedAt ? Date.parse(publishedAt) : 0,
    contentHtml: content,
    summaryText: htmlToText(content).slice(0, 600),
    categories: Array.isArray(raw.categories) ? raw.categories : [],
  };
}

/** フィード ID から記事の安定キーを作る。GUID → リンク → (タイトル, 日付) の順。 */
export function itemKey({ feedId, guid, link, title, publishedAt }) {
  const identity = guid || link || `${title || ''}|${publishedAt || ''}`;
  return 'i_' + stableHash(`${feedId || ''}|${identity}`);
}

export function feedId(url) {
  return 'f_' + stableHash(canonicalUrl(url) || normalizeUrl(url));
}

/** 安定キーを付けて記事を正規化する。 */
export function toItem(raw, feed) {
  const feedKey = typeof feed === 'string' ? feed : (feed && feed.id) || '';
  const normalized = raw && raw.key ? raw : normalizeRawItem(raw || {});
  return {
    key: itemKey({ feedId: feedKey, guid: normalized.guid, link: normalized.link, title: normalized.title, publishedAt: normalized.publishedAt }),
    feedId: feedKey,
    guid: normalized.guid || '',
    title: normalized.title || '(無題)',
    link: normalized.link || '',
    author: normalized.author || '',
    publishedAt: normalized.publishedAt || '',
    publishedTs: normalized.publishedTs || 0,
    contentHtml: normalized.contentHtml || '',
    summaryText: normalized.summaryText || '',
    categories: normalized.categories || [],
  };
}

export function dedupeByKey(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item || !item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** 既知キーに含まれない記事 (= 新着) を返す。 */
export function diffNewItems(knownKeys, incoming) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
  return (incoming || []).filter((item) => item && item.key && !known.has(item.key));
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const diff = (b.publishedTs || 0) - (a.publishedTs || 0);
    if (diff !== 0) return diff;
    return String(b.key).localeCompare(String(a.key));
  });
}

/** 既存記事と新規記事を統合する (新しい順、上限で切り詰め)。 */
export function mergeFeedItems(existingItems, incomingItems, limit = MAX_ITEMS_PER_FEED) {
  const merged = sortItems(dedupeByKey([...(incomingItems || []), ...(existingItems || [])]));
  return limit && merged.length > limit ? merged.slice(0, limit) : merged;
}

export function estimateReadMinutes(text) {
  const chars = htmlToText(text).length;
  if (!chars) return 0;
  return Math.max(1, Math.round(chars / 500));
}

/* ==========================================================
   OPML
   ========================================================== */

export function buildOpml(feeds, opts = {}) {
  const title = escapeXml(opts.title || 'MyApps Feed Reader');
  const dateCreated = opts.dateCreated || new Date().toUTCString();
  const outlines = (feeds || [])
    .filter((f) => f && f.url)
    .map((f) => {
      const text = escapeXml(f.title || f.url);
      const xmlUrl = escapeXml(f.url);
      const htmlUrl = f.siteUrl ? ` htmlUrl="${escapeXml(f.siteUrl)}"` : '';
      return `    <outline type="rss" text="${text}" title="${text}" xmlUrl="${xmlUrl}"${htmlUrl} />`;
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${title}</title>`,
    `    <dateCreated>${escapeXml(dateCreated)}</dateCreated>`,
    '  </head>',
    '  <body>',
    outlines.join('\n'),
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}

export function parseOpml(xml) {
  const doc = parseXml(xml);
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.localName === 'outline') {
        const xmlUrl = (child.attrs.xmlUrl || child.attrs.xmlurl || '').trim();
        if (xmlUrl) {
          out.push({
            url: normalizeUrl(xmlUrl),
            title: cleanText(child.attrs.title || child.attrs.text || xmlUrl),
            siteUrl: normalizeUrl(child.attrs.htmlUrl || child.attrs.htmlurl || ''),
          });
        }
        walk(child);
      } else {
        walk(child);
      }
    }
  };
  walk(doc);
  return out;
}

/* ==========================================================
   本文抽出 (fallback)
   ========================================================== */

export function stripUnwantedHtml(html) {
  let out = String(html == null ? '' : html);
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  out = out.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(?:href|src)\s*=\s*(?:"|')?\s*javascript:[^"'>\s]*(?:"|')?/gi, '');
  return out;
}

function extractTag(html, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return m ? m[1] : '';
}

function pickContainer(cleaned) {
  for (const tag of ['article', 'main']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(cleaned);
    if (m && htmlToText(m[1]).length > 200) return m[1];
  }
  const candidates = [];
  const re = /<(div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(cleaned))) {
    const inner = m[2];
    const paragraphs = (inner.match(/<p\b/gi) || []).length;
    const length = htmlToText(inner).length;
    if (paragraphs >= 2 && length > 200) {
      candidates.push({ inner, score: length + paragraphs * 200 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].inner : '';
}

function extractByline(cleaned) {
  const meta = /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(cleaned)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i.exec(cleaned);
  if (meta) return cleanText(meta[1]);
  const rel = /<a[^>]+rel=["'][^"']*author[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(cleaned);
  if (rel) return cleanText(rel[1]);
  return '';
}

/**
 * readability が使えないときの簡易本文抽出。
 * 記事全体 (article/main) → 段落の多いブロック → 全体、の順に選ぶ。
 */
export function extractArticle(html, url = '') {
  const raw = String(html == null ? '' : html);
  const cleaned = stripUnwantedHtml(raw);
  const title = cleanText(extractTag(cleaned, 'title')) || cleanText(extractTag(cleaned, 'h1'));
  const byline = extractByline(cleaned);
  const container = pickContainer(cleaned);
  const content = (container || cleaned).slice(0, MAX_ARTICLE_BYTES);
  const text = htmlToText(content);
  return { title, byline, content, text, length: text.length, url: normalizeUrl(url) };
}

/* ==========================================================
   HTML → Markdown (fallback)
   ========================================================== */

function cleanInline(html) {
  return htmlToText(html);
}

/** turndown が使えないときの簡易 HTML→Markdown。 */
export function htmlToMarkdown(html) {
  let s = stripUnwantedHtml(html);
  s = s.replace(/\r\n?/g, '\n');

  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => `\n\n\`\`\`\n${htmlToText(inner)}\n\`\`\`\n\n`);
  s = s.replace(/<img\b[^>]*\/?>/gi, (tag) => {
    const src = attrOf(tag, 'src');
    if (!src) return '';
    return `![${attrOf(tag, 'alt')}](${src})`;
  });
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => `[${cleanInline(text)}](${href})`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `**${cleanInline(inner)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `*${cleanInline(inner)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, inner) => '`' + htmlToText(inner) + '`');

  for (let level = 6; level >= 1; level--) {
    const hashes = '#'.repeat(level);
    s = s.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi'),
      (m, inner) => `\n\n${hashes} ${cleanInline(inner)}\n\n`,
    );
  }

  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => {
    const body = htmlToText(inner);
    return '\n\n' + body.split('\n').map((line) => `> ${line}`).join('\n') + '\n\n';
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (m, inner) => `\n- ${cleanInline(inner)}`);
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|blockquote|tr|table|thead|tbody|ul|ol)\s*>/gi, '\n\n');
  s = s.replace(/<(p|div|section|article|blockquote|tr|table|thead|tbody|ul|ol)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' | ');
  s = s.replace(/<(td|th)\b[^>]*>/gi, '| ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/* ==========================================================
   クリップ (Markdown) とファイル名
   ========================================================== */

export function slugify(input) {
  const slug = String(input == null ? '' : input)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'clip';
}

export function buildClipFileName(item) {
  return `${slugify(item && item.title)}.md`;
}

export function buildOpmlFileName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `feeds-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.opml`;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatRelativeDate(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = Math.round((now - ts) / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return 'たった今';
  if (abs < 3600) return `${Math.round(abs / 60)} 分前`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 時間前`;
  if (abs < 86400 * 7) return `${Math.round(abs / 86400)} 日前`;
  return formatDate(ts);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 記事を Markdown クリップに整形する。本文 Markdown があればそれを、
 * 無ければ contentHtml / summaryText から変換する。
 */
export function buildClipMarkdown({ item, article, feed } = {}, opts = {}) {
  const title = cleanText(
    (item && item.title) || (article && article.title) || '(無題)',
  );
  const lines = [`# ${title}`, ''];
  const meta = [];
  const source = (feed && (feed.title || feed.url)) || '';
  if (source) meta.push(`出典: ${source}`);
  if (item && item.author) meta.push(`著者: ${item.author}`);
  if (item && item.publishedAt) meta.push(`公開: ${formatDate(item.publishedAt)}`);
  if (item && item.link) meta.push(`元記事: ${item.link}`);
  const now = opts.now || Date.now();
  meta.push(`取り込み: ${formatDate(now)}`);
  lines.push(meta.map((line) => `> ${line}`).join('\n'), '');

  const body =
    (article && article.markdown) ||
    htmlToMarkdown((article && article.content) || (item && item.contentHtml) || (item && item.summaryText) || '');
  lines.push(body);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** notes-vault へ渡すクリップ payload。 */
export function buildNoteClip({ item, article, feed } = {}, opts = {}) {
  return {
    source: 'feed-reader',
    title: cleanText((item && item.title) || (article && article.title) || '(無題)'),
    url: (item && item.link) || '',
    feed: feed ? { title: feed.title || '', url: feed.url || '' } : null,
    markdown: buildClipMarkdown({ item, article, feed }, opts),
    savedAt: opts.now || Date.now(),
  };
}

/* ==========================================================
   状態 (購読・既読・あとで読む)
   ========================================================== */

export function createState() {
  return { version: STATE_VERSION, feeds: [], items: {}, status: {}, articles: {} };
}

export function findFeed(state, id) {
  return (state.feeds || []).find((f) => f.id === id) || null;
}

export function findFeedByUrl(state, url) {
  return (state.feeds || []).find((f) => sameUrl(f.url, url)) || null;
}

export function findItem(state, key) {
  for (const list of Object.values(state.items || {})) {
    const found = (list || []).find((it) => it.key === key);
    if (found) return found;
  }
  return null;
}

export function addFeed(state, feed, opts = {}) {
  const url = normalizeUrl(feed && feed.url);
  if (!url) return state;
  if (findFeedByUrl(state, url)) return state;
  const entry = {
    id: feedId(url),
    url,
    title: cleanText(feed.title) || '',
    siteUrl: normalizeUrl(feed.siteUrl || ''),
    format: feed.format || '',
    addedAt: opts.now || Date.now(),
    lastFetchedAt: 0,
    error: '',
  };
  return { ...state, feeds: [...state.feeds, entry] };
}

export function updateFeed(state, id, patch) {
  return {
    ...state,
    feeds: state.feeds.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  };
}

export function removeFeed(state, id) {
  const items = { ...state.items };
  const removedKeys = new Set((items[id] || []).map((it) => it.key));
  delete items[id];
  const status = {};
  for (const [key, value] of Object.entries(state.status || {})) {
    if (!removedKeys.has(key)) status[key] = value;
  }
  const articles = {};
  for (const [key, value] of Object.entries(state.articles || {})) {
    if (!removedKeys.has(key)) articles[key] = value;
  }
  return {
    ...state,
    feeds: state.feeds.filter((f) => f.id !== id),
    items,
    status,
    articles,
  };
}

/** 取得結果を状態へ反映する。既読などのステータスは保持する。 */
export function applyFeedResult(state, feedIdValue, parsed, opts = {}) {
  const now = opts.now || Date.now();
  const incoming = (parsed.items || []).map((raw) => toItem(raw, feedIdValue));
  const existing = state.items[feedIdValue] || [];
  const knownKeys = new Set(existing.map((it) => it.key));
  const added = diffNewItems(knownKeys, incoming);
  const merged = mergeFeedItems(existing, incoming, opts.limit || MAX_ITEMS_PER_FEED);
  const items = { ...state.items, [feedIdValue]: merged };
  const feeds = state.feeds.map((f) =>
    f.id === feedIdValue
      ? {
          ...f,
          title: f.title || cleanText(parsed.title) || f.url,
          siteUrl: f.siteUrl || normalizeUrl(parsed.link || ''),
          format: parsed.format || f.format,
          lastFetchedAt: now,
          error: '',
        }
      : f,
  );
  return { state: { ...state, feeds, items }, added };
}

export function markRead(state, key, read = true) {
  const current = state.status[key] || {};
  return {
    ...state,
    status: { ...state.status, [key]: { ...current, read: Boolean(read), updatedAt: Date.now() } },
  };
}

export function toggleReadLater(state, key) {
  const current = state.status[key] || {};
  const readLater = !current.readLater;
  return {
    ...state,
    status: {
      ...state.status,
      [key]: { ...current, readLater, savedAt: readLater ? Date.now() : 0 },
    },
  };
}

export function setReadRatio(state, key, ratio) {
  const current = state.status[key] || {};
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  return {
    ...state,
    status: { ...state.status, [key]: { ...current, readRatio: clamped } },
  };
}

export function getStatus(state, key) {
  return state.status[key] || {};
}

export function unreadCount(state, feedIdValue = null) {
  let count = 0;
  for (const [id, list] of Object.entries(state.items || {})) {
    if (feedIdValue && id !== feedIdValue) continue;
    for (const item of list || []) {
      if (!(state.status[item.key] || {}).read) count++;
    }
  }
  return count;
}

export function readLaterCount(state) {
  return Object.values(state.status || {}).filter((s) => s && s.readLater).length;
}

export function countNew(state) {
  return unreadCount(state);
}

/** 表示条件で記事を絞り込む: 'all' | 'unread' | 'readlater' | { feedId }。 */
export function selectItems(state, filter = 'all', opts = {}) {
  const now = opts.now || Date.now();
  let items = [];
  if (filter && typeof filter === 'object' && filter.feedId) {
    items = state.items[filter.feedId] || [];
  } else {
    for (const list of Object.values(state.items || {})) items.push(...(list || []));
  }
  if (filter === 'unread') {
    items = items.filter((it) => !(state.status[it.key] || {}).read);
  } else if (filter === 'readlater') {
    items = items.filter((it) => (state.status[it.key] || {}).readLater);
  }
  const sorted = sortItems(items);
  const query = (opts.query || '').trim().toLowerCase();
  const filtered = query
    ? sorted.filter((it) =>
        `${it.title} ${it.summaryText} ${it.author}`.toLowerCase().includes(query),
      )
    : sorted;
  void now;
  return filtered;
}

export function serializeState(state) {
  return JSON.stringify(state);
}

export function normalizeState(raw) {
  const base = createState();
  if (!raw || typeof raw !== 'object') return base;
  base.feeds = Array.isArray(raw.feeds)
    ? raw.feeds
        .filter((f) => f && f.url)
        .map((f) => ({
          id: f.id || feedId(f.url),
          url: normalizeUrl(f.url),
          title: f.title || '',
          siteUrl: normalizeUrl(f.siteUrl || ''),
          format: f.format || '',
          addedAt: f.addedAt || 0,
          lastFetchedAt: f.lastFetchedAt || 0,
          error: f.error || '',
        }))
    : [];
  base.items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  base.status = raw.status && typeof raw.status === 'object' ? raw.status : {};
  base.articles = raw.articles && typeof raw.articles === 'object' ? raw.articles : {};
  return base;
}

export function deserializeState(text) {
  if (!text) return createState();
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return createState();
  }
}

export function stateByteSize(state) {
  return serializeState(state).length;
}

/**
 * 容量を超えたら古い記事キャッシュを捨てる。あとで読む記事は保持する。
 */
export function pruneArticlesToBudget(state, maxBytes = MAX_STATE_BYTES) {
  if (stateByteSize(state) <= maxBytes) return state;
  const candidates = Object.entries(state.articles || {})
    .filter(([key]) => !((state.status[key] || {}).readLater))
    .sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0));
  const articles = { ...state.articles };
  let next = { ...state, articles };
  for (const [key] of candidates) {
    if (stateByteSize(next) <= maxBytes) break;
    delete next.articles[key];
    next = { ...next, articles: { ...next.articles } };
  }
  return next;
}
