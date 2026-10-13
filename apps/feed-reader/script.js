/**
 * script.js — RSS/Atom リーダーの UI
 *
 * 純ロジックは pipeline.mjs に置き、ここでは DOM / fetch / localStorage を扱う。
 * 本文抽出は @mozilla/readability、Markdown 化は turndown を動的 import し、
 * 読み込めない場合は pipeline.mjs の内蔵フォールバックを使う。
 */

import {
  STATE_KEY,
  CLIP_HANDOFF_KEY,
  CLIP_HANDOFF_URL,
  READABILITY_MODULE_URL,
  TURNDOWN_MODULE_URL,
  OPML_MIME,
  CLIP_MIME,
  MAX_STATE_BYTES,
  FETCH_TIMEOUT_MS,
  isLikelyFeedUrl,
  normalizeUrl,
  discoverFeedLinks,
  parseFeed,
  applyFeedResult,
  addFeed,
  updateFeed,
  removeFeed,
  findFeed,
  findFeedByUrl,
  findItem,
  createState,
  deserializeState,
  serializeState,
  stateByteSize,
  pruneArticlesToBudget,
  markRead,
  toggleReadLater,
  setReadRatio,
  getStatus,
  unreadCount,
  readLaterCount,
  selectItems,
  buildOpml,
  parseOpml,
  buildOpmlFileName,
  extractArticle,
  htmlToMarkdown,
  buildClipMarkdown,
  buildNoteClip,
  buildClipFileName,
  formatRelativeDate,
  formatBytes,
  estimateReadMinutes,
} from './pipeline.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  errorBox: $('error-box'),
  infoBtn: $('info-btn'),
  infoModal: $('info-modal'),
  closeInfoBtn: $('close-info-btn'),
  addForm: $('add-feed-form'),
  feedUrl: $('feed-url-input'),
  addFeedBtn: $('add-feed-btn'),
  feedStatus: $('feed-status'),
  refreshAllBtn: $('refresh-all-btn'),
  filterAll: $('filter-all'),
  filterUnread: $('filter-unread'),
  filterReadlater: $('filter-readlater'),
  countAll: $('count-all'),
  countUnread: $('count-unread'),
  countReadlater: $('count-readlater'),
  feedList: $('feed-list'),
  feedEmpty: $('feed-empty'),
  importInput: $('import-opml-input'),
  exportBtn: $('export-opml-btn'),
  storageInfo: $('storage-info'),
  listView: $('list-view'),
  listTitle: $('list-title'),
  listMeta: $('list-meta'),
  searchInput: $('search-input'),
  markAllReadBtn: $('mark-all-read-btn'),
  articleList: $('article-list'),
  listEmpty: $('list-empty'),
  readerView: $('reader-view'),
  backBtn: $('back-btn'),
  readerFeed: $('reader-feed'),
  readerDate: $('reader-date'),
  readerReadlaterBtn: $('reader-readlater-btn'),
  readerMarkBtn: $('reader-mark-btn'),
  toggleMdBtn: $('toggle-md-btn'),
  copyMdBtn: $('copy-md-btn'),
  downloadMdBtn: $('download-md-btn'),
  clipBtn: $('clip-btn'),
  openOriginalBtn: $('open-original-btn'),
  readerTitle: $('reader-title'),
  readerByline: $('reader-byline'),
  readerStatus: $('reader-status'),
  readerError: $('reader-error'),
  readerErrorText: $('reader-error-text'),
  readerRetryBtn: $('reader-retry-btn'),
  readerLoading: $('reader-loading'),
  readerBody: $('reader-body'),
  readerMd: $('reader-md'),
  readerSource: $('reader-source'),
};

const FILTER_LABELS = {
  all: 'すべての記事',
  unread: '未読の記事',
  readlater: 'あとで読む',
};

let state = loadState();
let filter = 'all';
let filterFeedId = null;
let currentKey = null;
let readabilityCtor = null;
let turndownCtor = null;

/* ==========================================================
   初期化
   ========================================================== */

function loadState() {
  try {
    return deserializeState(localStorage.getItem(STATE_KEY));
  } catch {
    return createState();
  }
}

function persist() {
  try {
    state = pruneArticlesToBudget(state, MAX_STATE_BYTES);
    localStorage.setItem(STATE_KEY, serializeState(state));
  } catch (err) {
    showError('保存に失敗しました (容量超過の可能性): ' + err.message);
  }
  updateStorageInfo();
}

function init() {
  render();
  bindEvents();
  if (state.feeds.length) void refreshAllFeeds({ silent: true });
}

/* ==========================================================
   表示
   ========================================================== */

function render() {
  renderFilters();
  renderFeedList();
  renderList();
  if (currentKey) renderReader();
  updateStorageInfo();
}

function renderFilters() {
  els.countAll.textContent = String(countAllItems());
  els.countUnread.textContent = String(unreadCount(state));
  els.countReadlater.textContent = String(readLaterCount(state));
  for (const button of [els.filterAll, els.filterUnread, els.filterReadlater]) {
    button.classList.toggle('is-active', button.dataset.filter === filter);
  }
}

function countAllItems() {
  return Object.values(state.items).reduce((sum, list) => sum + (list ? list.length : 0), 0);
}

function renderFeedList() {
  els.feedList.textContent = '';
  els.feedEmpty.hidden = state.feeds.length > 0;

  for (const feed of state.feeds) {
    const li = document.createElement('li');
    li.className = 'feed-item';
    if (filterFeedId === feed.id) li.classList.add('is-active');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feed-open';
    button.addEventListener('click', () => {
      filter = 'all';
      filterFeedId = feed.id;
      render();
    });

    const name = document.createElement('span');
    name.className = 'feed-name';
    name.textContent = feed.title || feed.url;
    button.appendChild(name);

    const unread = unreadCount(state, feed.id);
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(unread);
      button.appendChild(badge);
    }

    li.appendChild(button);

    const actions = document.createElement('div');
    actions.className = 'feed-actions';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'icon-btn';
    refresh.title = '更新';
    refresh.setAttribute('aria-label', 'このフィードを更新');
    refresh.textContent = '↻';
    refresh.addEventListener('click', async (event) => {
      event.stopPropagation();
      await refreshFeed(feed, { silent: false });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.title = '購読解除';
    del.setAttribute('aria-label', '購読解除');
    del.textContent = '×';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!confirm(`「${feed.title || feed.url}」を購読解除しますか？`)) return;
      state = removeFeed(state, feed.id);
      if (filterFeedId === feed.id) filterFeedId = null;
      persist();
      render();
    });

    actions.append(refresh, del);
    li.appendChild(actions);

    if (feed.error) {
      const err = document.createElement('span');
      err.className = 'feed-error';
      err.textContent = feed.error;
      err.title = feed.error;
      li.appendChild(err);
    }

    els.feedList.appendChild(li);
  }
}

function currentItems() {
  const selected = filterFeedId ? { feedId: filterFeedId } : filter;
  return selectItems(state, selected, { query: els.searchInput.value });
}

function renderList() {
  const items = currentItems();
  els.articleList.textContent = '';
  els.listEmpty.hidden = items.length > 0;

  const title = filterFeedId
    ? (findFeed(state, filterFeedId) || {}).title || 'フィード'
    : FILTER_LABELS[filter];
  els.listTitle.textContent = title;
  els.listMeta.textContent = `${items.length} 件${filterFeedId ? '' : ` / 未読 ${unreadCount(state)}`}`;

  for (const item of items) {
    els.articleList.appendChild(renderRow(item));
  }
}

function renderRow(item) {
  const status = getStatus(state, item.key);
  const li = document.createElement('li');
  li.className = 'article-item';
  if (status.read) li.classList.add('is-read');
  if (item.key === currentKey) li.classList.add('is-current');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'article-main';
  main.addEventListener('click', () => openItem(item.key));

  const top = document.createElement('div');
  top.className = 'article-top';

  if (!status.read) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    dot.setAttribute('aria-label', '未読');
    top.appendChild(dot);
  }

  const title = document.createElement('span');
  title.className = 'article-title';
  title.textContent = item.title;
  top.appendChild(title);

  if (status.readLater) {
    const star = document.createElement('span');
    star.className = 'readlater-mark';
    star.title = 'あとで読む';
    star.textContent = '★';
    top.appendChild(star);
  }

  main.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'article-meta';
  const feed = findFeed(state, item.feedId);
  const parts = [];
  if (feed) parts.push(feed.title || feed.url);
  if (item.publishedTs) parts.push(formatRelativeDate(item.publishedTs));
  const minutes = estimateReadMinutes(item.contentHtml || item.summaryText);
  if (minutes) parts.push(`約 ${minutes} 分`);
  meta.textContent = parts.join(' ・ ');
  main.appendChild(meta);

  if (item.summaryText) {
    const summary = document.createElement('p');
    summary.className = 'article-summary';
    summary.textContent = item.summaryText.slice(0, 160);
    main.appendChild(summary);
  }

  li.appendChild(main);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'icon-btn';
  toggle.title = status.readLater ? 'あとで読むを解除' : 'あとで読む';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.textContent = status.readLater ? '★' : '☆';
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    state = toggleReadLater(state, item.key);
    persist();
    render();
  });
  li.appendChild(toggle);

  return li;
}

/* ==========================================================
   リーダー
   ========================================================== */

function openItem(key) {
  currentKey = key;
  const item = findItem(state, key);
  if (!item) return;
  state = markRead(state, key, true);
  persist();
  showReader();
  renderList();
  void ensureArticle(item);
}

function showReader() {
  els.listView.hidden = true;
  els.readerView.hidden = false;
}

function showList() {
  els.readerView.hidden = true;
  els.listView.hidden = false;
  currentKey = null;
  renderList();
}

function renderReader() {
  const item = findItem(state, currentKey);
  if (!item) return;
  const feed = findFeed(state, item.feedId);
  const status = getStatus(state, item.key);

  els.readerFeed.textContent = feed ? feed.title || feed.url : '';
  els.readerDate.textContent = item.publishedTs ? formatRelativeDate(item.publishedTs) : '';
  els.readerTitle.textContent = item.title;
  els.readerByline.textContent = item.author ? `著者: ${item.author}` : '';
  els.readerReadlaterBtn.textContent = status.readLater ? 'あとで読むを解除' : 'あとで読む';
  els.readerMarkBtn.textContent = status.read ? '未読に戻す' : '既読にする';
  els.openOriginalBtn.href = item.link || '#';

  const article = state.articles[item.key];
  const mdVisible = !els.readerMd.hidden;

  if (article) {
    els.readerBody.innerHTML = sanitizeForDisplay(article.content);
    els.readerMd.value = article.markdown || htmlToMarkdown(article.content);
    const mode = article.mode === 'readability' ? 'readability' : '簡易抽出';
    const mdMode = article.markdownMode === 'turndown' ? 'turndown' : '簡易変換';
    els.readerSource.textContent = `本文: ${mode} / Markdown: ${mdMode} / 約 ${estimateReadMinutes(article.content)} 分`;
  } else if (item.contentHtml) {
    els.readerBody.innerHTML = sanitizeForDisplay(item.contentHtml);
    els.readerMd.value = htmlToMarkdown(item.contentHtml);
    els.readerSource.textContent = 'フィードに含まれる本文を表示しています。';
  } else {
    els.readerBody.innerHTML = '';
    els.readerMd.value = '';
    els.readerSource.textContent = '';
  }

  els.readerBody.hidden = mdVisible;
  els.readerMd.hidden = !mdVisible;
  els.toggleMdBtn.textContent = mdVisible ? '本文' : 'Markdown';

  els.readerError.hidden = true;
  els.readerLoading.hidden = true;
  restoreScroll(item.key);
}

async function ensureArticle(item) {
  if (state.articles[item.key]) {
    renderReader();
    return;
  }
  showReader();
  renderReader();
  if (!item.link) {
    els.readerStatus.textContent = 'リンクが無いため本文は取得できません。';
    return;
  }
  els.readerLoading.hidden = false;
  els.readerStatus.textContent = '本文を取得中…';
  try {
    const html = await fetchText(item.link);
    const article = await extractForItem(item, html);
    state = {
      ...state,
      articles: { ...state.articles, [item.key]: { ...article, savedAt: Date.now() } },
    };
    persist();
    renderReader();
  } catch (err) {
    const message = describeFetchError(err);
    els.readerError.hidden = false;
    els.readerErrorText.textContent = message;
    els.readerStatus.textContent = '';
  } finally {
    els.readerLoading.hidden = true;
  }
}

async function extractForItem(item, html) {
  let article = null;
  try {
    const module = await loadReadability();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const parsed = new module.Readability(doc).parse();
    if (parsed && parsed.content) {
      article = {
        title: parsed.title || item.title,
        byline: parsed.byline || '',
        content: parsed.content,
        text: parsed.textContent || '',
        length: (parsed.textContent || '').length,
        url: item.link,
        mode: 'readability',
      };
    }
  } catch {
    article = null;
  }
  if (!article) {
    article = extractArticle(html, item.link);
    article.mode = 'fallback';
  }

  try {
    const module = await loadTurndown();
    const service = new module.default({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    article.markdown = service.turndown(article.content);
    article.markdownMode = 'turndown';
  } catch {
    article.markdown = htmlToMarkdown(article.content);
    article.markdownMode = 'fallback';
  }
  return article;
}

function loadReadability() {
  if (!readabilityCtor) {
    readabilityCtor = import(/* webpackIgnore: true */ READABILITY_MODULE_URL);
  }
  return readabilityCtor;
}

function loadTurndown() {
  if (!turndownCtor) {
    turndownCtor = import(/* webpackIgnore: true */ TURNDOWN_MODULE_URL);
  }
  return turndownCtor;
}

/** 表示用に HTML を無害化する (script / イベント属性 / javascript: を落とす)。 */
function sanitizeForDisplay(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'LINK', 'META', 'BASE']);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (DROP.has(node.tagName)) {
      node.remove();
      continue;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on')) node.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return template.innerHTML;
}

function restoreScroll(key) {
  const ratio = (getStatus(state, key) || {}).readRatio || 0;
  requestAnimationFrame(() => {
    const body = els.readerBody;
    body.scrollTop = ratio * Math.max(0, body.scrollHeight - body.clientHeight);
  });
}

/* ==========================================================
   フィード取得
   ========================================================== */

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err) {
  if (err && err.name === 'AbortError') return '取得がタイムアウトしました。';
  return `取得に失敗しました (CORS 未許可か通信エラーの可能性): ${err.message}`;
}

function setFeedStatus(message, isError = false) {
  els.feedStatus.textContent = message;
  els.feedStatus.classList.toggle('is-error', isError);
}

async function handleAddFeed(event) {
  event.preventDefault();
  const raw = els.feedUrl.value.trim();
  if (!raw) return;
  if (!isLikelyFeedUrl(raw)) {
    setFeedStatus('http(s) の URL を入力してください。', true);
    return;
  }

  els.addFeedBtn.disabled = true;
  setFeedStatus('確認しています…');
  try {
    let url = normalizeUrl(raw);
    let text = await fetchText(url);
    let parsed = parseFeed(text);

    if (parsed.format === 'unknown') {
      const links = discoverFeedLinks(text, url);
      if (links.length) {
        url = links[0].url;
        setFeedStatus(`フィードを検出: ${url}`);
        text = await fetchText(url);
        parsed = parseFeed(text);
      }
    }

    if (parsed.format === 'unknown' || !parsed.items.length) {
      throw new Error('RSS/Atom として解釈できませんでした。');
    }
    if (findFeedByUrl(state, url)) {
      setFeedStatus('すでに購読しています。');
      return;
    }

    state = addFeed(state, {
      url,
      title: parsed.title,
      siteUrl: parsed.link,
      format: parsed.format,
    });
    const feed = findFeedByUrl(state, url);
    state = applyFeedResult(state, feed.id, parsed).state;
    persist();
    els.feedUrl.value = '';
    filterFeedId = feed.id;
    filter = 'all';
    render();
    setFeedStatus(`購読しました: ${parsed.title || url} (${parsed.items.length} 件)`);
  } catch (err) {
    setFeedStatus(describeFetchError(err), true);
  } finally {
    els.addFeedBtn.disabled = false;
  }
}

async function refreshFeed(feed, opts = {}) {
  if (!opts.silent) setFeedStatus(`${feed.title || feed.url} を更新中…`);
  try {
    const xml = await fetchText(feed.url);
    const parsed = parseFeed(xml);
    if (parsed.format === 'unknown') throw new Error('RSS/Atom として解釈できませんでした。');
    const applied = applyFeedResult(state, feed.id, parsed);
    state = applied.state;
    persist();
    if (!opts.silent) render();
    return applied.added.length;
  } catch (err) {
    state = updateFeed(state, feed.id, { error: describeFetchError(err), lastFetchedAt: Date.now() });
    persist();
    if (!opts.silent) {
      setFeedStatus(describeFetchError(err), true);
      render();
    }
    return 0;
  }
}

async function refreshAllFeeds(opts = {}) {
  let added = 0;
  for (const feed of [...state.feeds]) {
    added += await refreshFeed(feed, { silent: true });
  }
  render();
  if (!opts.silent) setFeedStatus(added ? `${added} 件の新着を取り込みました。` : '新着はありませんでした。');
}

/* ==========================================================
   Markdown / notes-vault
   ========================================================== */

function currentArticlePayload() {
  const item = findItem(state, currentKey);
  if (!item) return null;
  return { item, article: state.articles[item.key], feed: findFeed(state, item.feedId) };
}

function currentMarkdown() {
  const payload = currentArticlePayload();
  if (!payload) return '';
  if (payload.article && payload.article.markdown) return payload.article.markdown;
  return buildClipMarkdown(payload);
}

async function copyMarkdown() {
  const markdown = currentMarkdown();
  if (!markdown) return;
  try {
    await navigator.clipboard.writeText(markdown);
    els.readerStatus.textContent = 'Markdown をコピーしました。';
  } catch {
    els.readerStatus.textContent = 'クリップボードにコピーできませんでした。';
  }
}

function downloadMarkdown() {
  const payload = currentArticlePayload();
  if (!payload) return;
  const markdown = currentMarkdown();
  const blob = new Blob([markdown], { type: `${CLIP_MIME};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildClipFileName(payload.item);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function clipToNotesVault() {
  const payload = currentArticlePayload();
  if (!payload) return;
  const clip = buildNoteClip(payload);
  try {
    sessionStorage.setItem(CLIP_HANDOFF_KEY, JSON.stringify(clip));
    els.readerStatus.textContent = 'notes-vault へクリップを渡しました。';
    window.location.href = CLIP_HANDOFF_URL;
  } catch {
    els.readerStatus.textContent = 'クリップの受け渡しに失敗しました。';
  }
}

/* ==========================================================
   OPML
   ========================================================== */

function exportOpml() {
  const xml = buildOpml(state.feeds, { title: 'MyApps Feed Reader' });
  const blob = new Blob([xml], { type: `${OPML_MIME};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildOpmlFileName();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function importOpmlFile(file) {
  try {
    const text = await file.text();
    const feeds = parseOpml(text);
    if (!feeds.length) {
      setFeedStatus('OPML に購読がありませんでした。', true);
      return;
    }
    let before = state.feeds.length;
    for (const feed of feeds) state = addFeed(state, feed);
    persist();
    render();
    setFeedStatus(`${state.feeds.length - before} 件を追加しました (${feeds.length} 件中)。`);
    void refreshAllFeeds({ silent: true });
  } catch (err) {
    setFeedStatus('OPML の取り込みに失敗しました: ' + err.message, true);
  }
}

/* ==========================================================
   ストレージ表示
   ========================================================== */

function updateStorageInfo() {
  const bytes = stateByteSize(state);
  const articles = Object.keys(state.articles).length;
  els.storageInfo.textContent = `保存: ${formatBytes(bytes)} / 記事キャッシュ ${articles} 件 / 上限 ${formatBytes(MAX_STATE_BYTES)}`;
}

/* ==========================================================
   エラー表示
   ========================================================== */

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
}

/* ==========================================================
   イベント
   ========================================================== */

function bindEvents() {
  els.addForm.addEventListener('submit', handleAddFeed);

  for (const button of [els.filterAll, els.filterUnread, els.filterReadlater]) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      filterFeedId = null;
      render();
    });
  }

  els.searchInput.addEventListener('input', renderList);
  els.refreshAllBtn.addEventListener('click', () => void refreshAllFeeds({ silent: false }));
  els.exportBtn.addEventListener('click', exportOpml);
  els.importInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) void importOpmlFile(file);
    event.target.value = '';
  });

  els.markAllReadBtn.addEventListener('click', () => {
    for (const item of currentItems()) state = markRead(state, item.key, true);
    persist();
    render();
  });

  els.backBtn.addEventListener('click', showList);

  els.readerMarkBtn.addEventListener('click', () => {
    const status = getStatus(state, currentKey);
    state = markRead(state, currentKey, !status.read);
    persist();
    render();
  });

  els.readerReadlaterBtn.addEventListener('click', () => {
    state = toggleReadLater(state, currentKey);
    persist();
    render();
  });

  els.toggleMdBtn.addEventListener('click', () => {
    const showMd = els.readerMd.hidden;
    els.readerMd.hidden = !showMd;
    els.readerBody.hidden = showMd;
    els.toggleMdBtn.textContent = showMd ? '本文' : 'Markdown';
  });

  els.copyMdBtn.addEventListener('click', () => void copyMarkdown());
  els.downloadMdBtn.addEventListener('click', downloadMarkdown);
  els.clipBtn.addEventListener('click', clipToNotesVault);
  els.readerRetryBtn.addEventListener('click', () => {
    const item = findItem(state, currentKey);
    if (item) void ensureArticle(item);
  });

  let scrollTimer = null;
  els.readerBody.addEventListener('scroll', () => {
    if (!currentKey) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const body = els.readerBody;
      const max = body.scrollHeight - body.clientHeight;
      if (max <= 0) return;
      state = setReadRatio(state, currentKey, body.scrollTop / max);
      persist();
    }, 400);
  });

  els.infoBtn.addEventListener('click', () => { els.infoModal.style.display = 'flex'; });
  els.closeInfoBtn.addEventListener('click', () => { els.infoModal.style.display = 'none'; });
  els.infoModal.addEventListener('click', (event) => {
    if (event.target === els.infoModal) els.infoModal.style.display = 'none';
  });
}

document.addEventListener('DOMContentLoaded', init);
