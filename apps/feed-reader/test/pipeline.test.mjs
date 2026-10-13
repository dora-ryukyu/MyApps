import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_VERSION,
  CLIP_HANDOFF_KEY,
  decodeEntities,
  escapeXml,
  htmlToText,
  cleanText,
  stableHash,
  localName,
  parseXml,
  detectFeedFormat,
  parseFeed,
  normalizeRawItem,
  normalizeUrl,
  sameUrl,
  isLikelyFeedUrl,
  discoverFeedLinks,
  parseDate,
  itemKey,
  feedId,
  toItem,
  dedupeByKey,
  diffNewItems,
  mergeFeedItems,
  estimateReadMinutes,
  buildOpml,
  parseOpml,
  stripUnwantedHtml,
  extractArticle,
  htmlToMarkdown,
  slugify,
  buildClipFileName,
  buildOpmlFileName,
  formatDate,
  formatRelativeDate,
  formatBytes,
  buildClipMarkdown,
  buildNoteClip,
  createState,
  addFeed,
  updateFeed,
  removeFeed,
  findFeed,
  findFeedByUrl,
  findItem,
  applyFeedResult,
  markRead,
  toggleReadLater,
  setReadRatio,
  getStatus,
  unreadCount,
  readLaterCount,
  selectItems,
  serializeState,
  normalizeState,
  deserializeState,
  stateByteSize,
  pruneArticlesToBudget,
} from '../pipeline.mjs';

/* ==========================================================
   文字列ヘルパ
   ========================================================== */

test('decodeEntities は名前付き・数値・16 進の実体をデコードする', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
  assert.equal(decodeEntities('&#65;&#x42;&#x6c;'), 'ABl');
  assert.equal(decodeEntities('caf&eacute;'), 'caf&eacute;', '未知の実体はそのまま');
  assert.equal(decodeEntities(null), '');
});

test('escapeXml は 5 つの特殊文字をエスケープする', () => {
  assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
});

test('htmlToText はタグとスクリプトを落とす', () => {
  const text = htmlToText('<p>Hello <b>world</b></p><script>bad()</script><style>x{}</style>');
  assert.equal(text, 'Hello world');
});

test('cleanText はタグと連続空白を整理する', () => {
  assert.equal(cleanText('  <b>A</b>\n\t B  '), 'A B');
});

test('stableHash は決定的で 8 桁の 16 進を返す', () => {
  assert.equal(stableHash('abc'), stableHash('abc'));
  assert.match(stableHash('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(stableHash('abc'), stableHash('abd'));
});

test('localName は名前空間接頭辞を外して小文字化する', () => {
  assert.equal(localName('content:encoded'), 'encoded');
  assert.equal(localName('PubDate'), 'pubdate');
  assert.equal(localName('link'), 'link');
});

/* ==========================================================
   XML パーサ
   ========================================================== */

test('parseXml は要素・属性・CDATA・自己終了タグ・入れ子を読む', () => {
  const doc = parseXml(
    '<?xml version="1.0"?><rss version="2.0"><channel><item><title>A &amp; B</title>' +
      '<link rel="x" href="https://e.example/1" /><description><![CDATA[<p>hi</p>]]></description>' +
      '</item></channel></rss>',
  );
  const rss = doc.children[0];
  assert.equal(rss.name, 'rss');
  assert.equal(rss.attrs.version, '2.0');
  const channel = rss.children[0];
  const item = channel.children[0];
  const title = item.children.find((c) => c.localName === 'title');
  assert.equal(title.text, 'A & B');
  const link = item.children.find((c) => c.localName === 'link');
  assert.equal(link.attrs.href, 'https://e.example/1');
  const desc = item.children.find((c) => c.localName === 'description');
  assert.equal(desc.text, '<p>hi</p>');
});

/* ==========================================================
   フィードのパース
   ========================================================== */

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <description>desc</description>
    <item>
      <title>Hello &amp; World</title>
      <link>https://example.com/a</link>
      <guid isPermaLink="false">post-1</guid>
      <dc:creator>Alice</dc:creator>
      <pubDate>Mon, 06 Oct 2025 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>Summary <b>here</b></p>]]></description>
      <content:encoded><![CDATA[<article><p>Full</p></article>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <link href="https://example.org/"/>
  <subtitle>sub</subtitle>
  <entry>
    <title>Entry 1</title>
    <link rel="alternate" href="https://example.org/e1"/>
    <id>tag:example.org,2025:e1</id>
    <author><name>Bob</name></author>
    <published>2025-10-05T00:00:00Z</published>
    <summary>short</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel><title>RDF Feed</title><link>https://example.net/</link></channel>
  <item><title>R1</title><link>https://example.net/1</link></item>
</rdf:RDF>`;

test('detectFeedFormat は rss / atom / rdf を見分ける', () => {
  assert.equal(detectFeedFormat(RSS), 'rss');
  assert.equal(detectFeedFormat(ATOM), 'atom');
  assert.equal(detectFeedFormat(RDF), 'rdf');
  assert.equal(detectFeedFormat('<html><body>nope</body></html>'), 'unknown');
});

test('parseFeed は RSS 2.0 を正規化する', () => {
  const feed = parseFeed(RSS);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'Example Feed');
  assert.equal(feed.link, 'https://example.com/');
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.guid, 'post-1');
  assert.equal(item.title, 'Hello & World');
  assert.equal(item.link, 'https://example.com/a');
  assert.equal(item.author, 'Alice');
  assert.equal(item.publishedAt, '2025-10-06T12:00:00.000Z');
  assert.equal(item.contentHtml, '<article><p>Full</p></article>');
});

test('parseFeed は Atom を正規化する', () => {
  const feed = parseFeed(ATOM);
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Atom Feed');
  assert.equal(feed.link, 'https://example.org/');
  const item = feed.items[0];
  assert.equal(item.guid, 'tag:example.org,2025:e1');
  assert.equal(item.link, 'https://example.org/e1');
  assert.equal(item.author, 'Bob');
  assert.equal(item.publishedAt, '2025-10-05T00:00:00.000Z');
  assert.equal(item.contentHtml, '<p>Body</p>');
});

test('parseFeed は RDF (RSS 1.0) を読む', () => {
  const feed = parseFeed(RDF);
  assert.equal(feed.format, 'rdf');
  assert.equal(feed.title, 'RDF Feed');
  assert.equal(feed.items[0].title, 'R1');
});

test('parseFeed は未知の XML に空の items を返す', () => {
  const feed = parseFeed('<notafeed><x/></notafeed>');
  assert.equal(feed.format, 'unknown');
  assert.deepEqual(feed.items, []);
});

test('normalizeRawItem は日付と要約をそろえる', () => {
  const item = normalizeRawItem({
    title: 'T',
    link: '//example.com/x',
    published: 'nonsense',
    content: '<p>body</p>',
  });
  assert.equal(item.publishedAt, '');
  assert.equal(item.link, 'https://example.com/x');
  assert.equal(item.summaryText, 'body');
});

/* ==========================================================
   URL と検出
   ========================================================== */

test('normalizeUrl / sameUrl / isLikelyFeedUrl', () => {
  assert.equal(normalizeUrl('//example.com/a'), 'https://example.com/a');
  assert.ok(sameUrl('https://example.com/a/', 'https://example.com/a'));
  assert.ok(!sameUrl('https://example.com/a', 'https://example.com/b'));
  assert.ok(isLikelyFeedUrl('https://example.com/feed'));
  assert.ok(!isLikelyFeedUrl('javascript:alert(1)'));
  assert.ok(!isLikelyFeedUrl('not a url'));
});

test('discoverFeedLinks は alternate の RSS/Atom link を解決する', () => {
  const html =
    '<html><head>' +
    '<link rel="alternate" type="application/rss+xml" title="F" href="/feed.xml">' +
    '<link rel="stylesheet" href="/style.css">' +
    '<link rel="alternate" type="application/atom+xml" href="https://cdn.example/atom.xml">' +
    '</head></html>';
  const links = discoverFeedLinks(html, 'https://site.example/blog');
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://site.example/feed.xml');
  assert.equal(links[1].url, 'https://cdn.example/atom.xml');
});

test('parseDate は RFC822 と ISO を ISO 文字列へそろえる', () => {
  assert.equal(parseDate('Mon, 06 Oct 2025 12:00:00 GMT'), '2025-10-06T12:00:00.000Z');
  assert.equal(parseDate(''), '');
  assert.equal(parseDate('not a date'), '');
});

/* ==========================================================
   記事キー・重複排除・新着差分
   ========================================================== */

test('itemKey と toItem は GUID 優先で安定キーを作る', () => {
  const a = toItem({ guid: 'g1', title: 'T', link: 'https://e.example/1' }, 'f1');
  const b = toItem({ guid: 'g1', title: 'T changed', link: 'https://e.example/1' }, 'f1');
  assert.equal(a.key, b.key, 'GUID が同じならタイトルが変わっても同一キー');
  const c = toItem({ guid: 'g2', title: 'T' }, 'f1');
  assert.notEqual(a.key, c.key);
  const d = toItem({ guid: 'g1', title: 'T' }, 'f2');
  assert.notEqual(a.key, d.key, 'フィードが違えばキーも違う');
});

test('feedId は URL から安定 ID を作る', () => {
  assert.equal(feedId('https://example.com/feed'), feedId('https://example.com/feed/'));
});

test('dedupeByKey は重複を落とす', () => {
  const items = [{ key: 'a' }, { key: 'a' }, { key: 'b' }];
  assert.deepEqual(dedupeByKey(items).map((i) => i.key), ['a', 'b']);
});

test('diffNewItems は既知キーを除いた新着を返す', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.deepEqual(diffNewItems(['a', 'c'], items).map((i) => i.key), ['b']);
});

test('mergeFeedItems は新しい順に並べて上限で切る', () => {
  const existing = [{ key: 'a', publishedTs: 100 }];
  const incoming = [
    { key: 'b', publishedTs: 300 },
    { key: 'a', publishedTs: 100 },
    { key: 'c', publishedTs: 200 },
  ];
  const merged = mergeFeedItems(existing, incoming, 2);
  assert.deepEqual(merged.map((i) => i.key), ['b', 'c']);
});

test('estimateReadMinutes は最低 1 分を返す', () => {
  assert.equal(estimateReadMinutes(''), 0);
  assert.equal(estimateReadMinutes('<p>short</p>'), 1);
  assert.equal(estimateReadMinutes('x'.repeat(1500)), 3);
});

/* ==========================================================
   OPML
   ========================================================== */

test('buildOpml / parseOpml は往復する', () => {
  const feeds = [
    { url: 'https://a.example/feed', title: 'A & B', siteUrl: 'https://a.example/' },
    { url: 'https://b.example/rss', title: 'B' },
  ];
  const xml = buildOpml(feeds, { dateCreated: 'Mon, 01 Jan 2024 00:00:00 GMT' });
  assert.match(xml, /<opml version="2.0">/);
  assert.match(xml, /xmlUrl="https:\/\/a\.example\/feed"/);
  assert.match(xml, /A &amp; B/);
  const parsed = parseOpml(xml);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    url: 'https://a.example/feed',
    title: 'A & B',
    siteUrl: 'https://a.example/',
  });
});

test('parseOpml は入れ子の outline も拾う', () => {
  const xml =
    '<opml><body><outline text="folder">' +
    '<outline type="rss" text="C" xmlUrl="https://c.example/feed" />' +
    '</outline></body></opml>';
  const parsed = parseOpml(xml);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'https://c.example/feed');
});

/* ==========================================================
   本文抽出・Markdown
   ========================================================== */

test('stripUnwantedHtml は script / nav / イベント属性 / javascript: を落とす', () => {
  const html =
    '<div><script>bad()</script><nav>menu</nav>' +
    '<a href="javascript:alert(1)" onclick="x()">click</a><p onclick="y()">text</p></div>';
  const cleaned = stripUnwantedHtml(html);
  assert.doesNotMatch(cleaned, /script/i);
  assert.doesNotMatch(cleaned, /menu/);
  assert.doesNotMatch(cleaned, /javascript:/i);
  assert.doesNotMatch(cleaned, /onclick/i);
  assert.match(cleaned, /text/);
});

test('extractArticle は article から本文を取り出す', () => {
  const long = 'これは段落です。'.repeat(40);
  const html =
    '<html><head><title>My Article</title><meta name="author" content="Jane"></head>' +
    `<body><header>Site header</header><nav>Menu</nav><article><h1>My Article</h1>` +
    `<p>${long}</p><p>${long}</p></article><footer>Footer</footer></body></html>`;
  const article = extractArticle(html, 'https://e.example/post');
  assert.equal(article.title, 'My Article');
  assert.equal(article.byline, 'Jane');
  assert.ok(article.text.includes('これは段落です。'));
  assert.ok(!article.text.includes('Menu'));
  assert.ok(!article.text.includes('Footer'));
  assert.ok(article.length > 200);
});

test('htmlToMarkdown は見出し・強調・リンク・リスト・コード・画像を変換する', () => {
  const html =
    '<h2>Title</h2>' +
    '<p>Hello <strong>world</strong> and <a href="https://x.example">link</a>.</p>' +
    '<ul><li>one</li><li>two</li></ul>' +
    '<pre><code>const a = 1;</code></pre>' +
    '<img src="https://img.example/a.png" alt="pic">';
  const md = htmlToMarkdown(html);
  assert.match(md, /## Title/);
  assert.match(md, /\*\*world\*\*/);
  assert.match(md, /\[link\]\(https:\/\/x\.example\)/);
  assert.match(md, /- one/);
  assert.match(md, /- two/);
  assert.match(md, /```/);
  assert.match(md, /const a = 1;/);
  assert.match(md, /!\[pic\]\(https:\/\/img\.example\/a\.png\)/);
});

test('slugify / buildClipFileName / buildOpmlFileName', () => {
  assert.equal(slugify('a/b:c?d'), 'abcd');
  assert.equal(slugify('  Hello  World  '), 'Hello-World');
  assert.equal(slugify(''), 'clip');
  assert.equal(buildClipFileName({ title: 'My Post' }), 'My-Post.md');
  assert.equal(buildOpmlFileName(Date.UTC(2026, 0, 2)), 'feeds-20260102.opml');
});

test('formatDate / formatRelativeDate / formatBytes', () => {
  assert.equal(formatDate(Date.UTC(2026, 9, 13)), '2026-10-13');
  const now = Date.UTC(2026, 9, 13);
  assert.equal(formatRelativeDate(now - 30 * 1000, now), 'たった今');
  assert.equal(formatRelativeDate(now - 5 * 60 * 1000, now), '5 分前');
  assert.equal(formatRelativeDate(now - 2 * 3600 * 1000, now), '2 時間前');
  assert.equal(formatRelativeDate(now - 3 * 86400 * 1000, now), '3 日前');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

test('buildClipMarkdown と buildNoteClip は出典つき Markdown を作る', () => {
  const payload = {
    item: {
      title: 'My Post',
      link: 'https://e.example/post',
      author: 'Jane',
      publishedAt: '2026-10-01T00:00:00.000Z',
      contentHtml: '<p>Body</p>',
    },
    article: { content: '<p>Body</p>', markdown: 'Body paragraph' },
    feed: { title: 'Example', url: 'https://e.example/feed' },
  };
  const md = buildClipMarkdown(payload, { now: Date.UTC(2026, 9, 13) });
  assert.match(md, /^# My Post/m);
  assert.match(md, /> 出典: Example/);
  assert.match(md, /> 著者: Jane/);
  assert.match(md, /> 元記事: https:\/\/e\.example\/post/);
  assert.match(md, /> 取り込み: 2026-10-13/);
  assert.match(md, /Body paragraph/);

  const clip = buildNoteClip(payload, { now: Date.UTC(2026, 9, 13) });
  assert.equal(clip.source, 'feed-reader');
  assert.equal(clip.title, 'My Post');
  assert.equal(clip.feed.title, 'Example');
  assert.match(clip.markdown, /My Post/);
});

/* ==========================================================
   状態リデューサ
   ========================================================== */

function stateWithFeed() {
  let state = createState();
  state = addFeed(state, { url: 'https://a.example/feed', title: 'A' });
  const feed = state.feeds[0];
  const parsed = parseFeed(
    '<rss version="2.0"><channel><title>A</title><item><guid>1</guid><title>One</title>' +
      '<pubDate>Mon, 06 Oct 2025 12:00:00 GMT</pubDate><description>d1</description></item>' +
      '<item><guid>2</guid><title>Two</title><pubDate>Tue, 07 Oct 2025 12:00:00 GMT</pubDate>' +
      '<description>d2</description></item></channel></rss>',
  );
  const applied = applyFeedResult(state, feed.id, parsed, { now: 1000 });
  return { state: applied.state, feed, added: applied.added };
}

test('createState は既定の形を返す', () => {
  const state = createState();
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(state.feeds, []);
  assert.deepEqual(state.items, {});
  assert.deepEqual(state.status, {});
  assert.deepEqual(state.articles, {});
});

test('addFeed は重複 URL を追加しない', () => {
  let state = createState();
  state = addFeed(state, { url: 'https://a.example/feed', title: 'A' });
  state = addFeed(state, { url: 'https://a.example/feed/', title: 'A2' });
  assert.equal(state.feeds.length, 1);
  assert.ok(findFeedByUrl(state, 'https://a.example/feed'));
});

test('applyFeedResult は新着を数えて既存を保持する', () => {
  const { state, feed, added } = stateWithFeed();
  assert.equal(added.length, 2);
  assert.equal(state.items[feed.id].length, 2);
  assert.equal(feed.title, 'A');
  assert.equal(state.feeds[0].lastFetchedAt, 1000);

  // 同じ結果を再適用しても新着 0・件数維持
  const parsed = parseFeed(
    '<rss version="2.0"><channel><title>A</title><item><guid>1</guid><title>One</title>' +
      '<pubDate>Mon, 06 Oct 2025 12:00:00 GMT</pubDate></item>' +
      '<item><guid>2</guid><title>Two</title><pubDate>Tue, 07 Oct 2025 12:00:00 GMT</pubDate></item>' +
      '</channel></rss>',
  );
  const again = applyFeedResult(state, feed.id, parsed, { now: 2000 });
  assert.equal(again.added.length, 0);
  assert.equal(again.state.items[feed.id].length, 2);
});

test('markRead / toggleReadLater / setReadRatio はステータスを更新する', () => {
  const { state, feed } = stateWithFeed();
  const key = state.items[feed.id][0].key;
  let next = markRead(state, key, true);
  assert.equal(getStatus(next, key).read, true);
  assert.equal(unreadCount(next), 1);

  next = toggleReadLater(next, key);
  assert.equal(getStatus(next, key).readLater, true);
  assert.equal(readLaterCount(next), 1);

  next = setReadRatio(next, key, 0.5);
  assert.equal(getStatus(next, key).readRatio, 0.5);
  next = setReadRatio(next, key, 5);
  assert.equal(getStatus(next, key).readRatio, 1);
});

test('removeFeed は記事とステータスも消す', () => {
  const { state, feed } = stateWithFeed();
  const key = state.items[feed.id][0].key;
  let next = markRead(state, key, true);
  next = removeFeed(next, feed.id);
  assert.equal(next.feeds.length, 0);
  assert.equal(next.items[feed.id], undefined);
  assert.equal(next.status[key], undefined);
});

test('selectItems はフィルタと検索で絞り込む', () => {
  const { state, feed } = stateWithFeed();
  const [first, second] = state.items[feed.id];
  assert.equal(selectItems(state, 'all').length, 2);

  let next = markRead(state, first.key, true);
  assert.equal(selectItems(next, 'unread').length, 1);
  assert.equal(selectItems(next, 'unread')[0].key, second.key);

  next = toggleReadLater(next, second.key);
  assert.equal(selectItems(next, 'readlater').length, 1);

  assert.equal(selectItems(state, 'all', { query: 'Two' }).length, 1);
  assert.equal(selectItems(state, { feedId: feed.id }).length, 2);
});

test('serializeState / deserializeState は往復し、壊れた入力に耐える', () => {
  const { state } = stateWithFeed();
  const text = serializeState(state);
  const restored = deserializeState(text);
  assert.equal(restored.feeds.length, 1);
  assert.equal(Object.keys(restored.items).length, 1);
  assert.deepEqual(deserializeState('{not json'), createState());
  assert.deepEqual(deserializeState(''), createState());
  const normalized = normalizeState({ feeds: [{ url: 'x' }, {}] });
  assert.equal(normalized.feeds.length, 1);
});

test('pruneArticlesToBudget は古い記事を捨て、あとで読むを残す', () => {
  const { state, feed } = stateWithFeed();
  const [first, second] = state.items[feed.id];
  let next = {
    ...state,
    articles: {
      [first.key]: { content: 'a'.repeat(2000), savedAt: 1 },
      [second.key]: { content: 'b'.repeat(2000), savedAt: 2 },
    },
  };
  next = toggleReadLater(next, second.key); // あとで読むは status 側で管理する
  const before = stateByteSize(next);
  // あとで読む 1 件ぶんだけ残る予算を指定する
  const budget = stateByteSize({ ...next, articles: { [second.key]: next.articles[second.key] } });
  const pruned = pruneArticlesToBudget(next, budget);
  assert.ok(stateByteSize(pruned) < before, '容量が減る');
  assert.equal(pruned.articles[first.key], undefined, '古い通常記事は削除');
  assert.ok(pruned.articles[second.key], 'あとで読むは保持');
  assert.equal(pruneArticlesToBudget(next, before + 1), next, '予算内なら変更しない');
});

test('updateFeed / findItem が動く', () => {
  const { state, feed } = stateWithFeed();
  const updated = updateFeed(state, feed.id, { error: 'boom' });
  assert.equal(findFeed(updated, feed.id).error, 'boom');
  const key = state.items[feed.id][0].key;
  assert.equal(findItem(state, key).key, key);
  assert.equal(findItem(state, 'nope'), null);
});

test('CLIP_HANDOFF_KEY は notes-vault 用の固定キー', () => {
  assert.equal(CLIP_HANDOFF_KEY, 'myapps:note-clip');
});
