/**
 * MyApps Hub — メインスクリプト
 *
 * registry.json → 各 apps/{id}/meta.json を並列 fetch し、
 * カードを動的生成する。タグフィルタ + Fuse.js ファジー検索。
 */
(function () {
  'use strict';

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const $grid     = $('app-grid');
  const $loading   = $('loading');
  const $empty     = $('empty-state');
  const $search    = $('search-input');
  const $tags      = $('tags-container');
  const $theme     = $('theme-toggle');

  /* ---------- State ---------- */
  let apps = [];
  let activeTags = new Set();
  let fuse = null;

  /* ---------- SVG Icon paths (Lucide) ---------- */
  const ICON = {
    'package':       '<path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    'box':           '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    'calculator':    '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
    'file-text':     '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    'timer':         '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
    'clock':         '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'palette':       '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    'scan-barcode':  '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 7v10"/><path d="M12 7v10"/><path d="M17 7v10"/>',
    'shield':        '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    'settings':      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'gamepad-2':     '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
    'zap':           '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    'globe':         '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    'code':          '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  };

  const FALLBACK = 'zap';

  function iconSvg(name) {
    const d = ICON[name] || ICON[FALLBACK];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  }

  function softColor(hex) {
    if (!hex) return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},0.1)`;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------- Theme ---------- */
  function initTheme() {
    const saved = localStorage.getItem('myapps-theme') || 'system';
    document.documentElement.setAttribute('data-theme', saved);
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    let next;
    if (cur === 'system') {
      next = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
    } else {
      next = cur === 'dark' ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('myapps-theme', next);
  }

  /* ---------- Data ---------- */
  async function loadApps() {
    try {
      const res = await fetch('registry.json');
      if (!res.ok) throw new Error(res.status);
      const reg = await res.json();
      const metas = await Promise.all(
        reg.apps.map(async (id) => {
          try {
            const r = await fetch(`apps/${id}/meta.json`);
            return r.ok ? await r.json() : null;
          } catch { return null; }
        })
      );
      apps = metas.filter(Boolean);
    } catch (e) {
      console.error('Failed to load apps:', e);
      apps = [];
    }
  }

  /* ---------- Fuse ---------- */
  function initFuse() {
    if (typeof Fuse === 'undefined') return;
    fuse = new Fuse(apps, {
      keys: [
        { name: 'name', weight: 0.5 },
        { name: 'description', weight: 0.3 },
        { name: 'tags', weight: 0.2 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
    });
  }

  /* ---------- Tags ---------- */
  function renderTags() {
    const set = new Set();
    apps.forEach(a => (a.tags || []).forEach(t => set.add(t)));
    $tags.innerHTML = '';
    [...set].sort().forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'tag-btn';
      btn.type = 'button';
      btn.textContent = tag;
      btn.addEventListener('click', () => {
        activeTags.has(tag) ? activeTags.delete(tag) : activeTags.add(tag);
        btn.classList.toggle('active', activeTags.has(tag));
        render();
      });
      $tags.appendChild(btn);
    });
  }

  /* ---------- Filter ---------- */
  function filtered() {
    const q = $search.value.trim();
    let list = apps;

    if (q && fuse) {
      list = fuse.search(q).map(r => r.item);
    } else if (q) {
      const lc = q.toLowerCase();
      list = apps.filter(a =>
        a.name.toLowerCase().includes(lc) ||
        a.description.toLowerCase().includes(lc) ||
        (a.tags || []).some(t => t.toLowerCase().includes(lc))
      );
    }

    if (activeTags.size) {
      list = list.filter(a => (a.tags || []).some(t => activeTags.has(t)));
    }
    return list;
  }

  /* ---------- Card ---------- */
  function card(app, i) {
    const el = document.createElement('a');
    el.className = 'card';
    el.href = `apps/${app.id}/`;
    el.role = 'listitem';
    el.style.animationDelay = `${i * 40}ms`;

    if (app.color) {
      el.style.setProperty('--app-color', app.color);
      el.style.setProperty('--app-color-soft', softColor(app.color));
    }

    const tagsHtml = (app.tags || [])
      .map(t => `<span class="card-tag">${esc(t)}</span>`)
      .join('');

    el.innerHTML =
      `<div class="card-icon">${iconSvg(app.icon || FALLBACK)}</div>` +
      `<div class="card-body">` +
        `<div class="card-name">${esc(app.name)}</div>` +
        `<div class="card-desc">${esc(app.description)}</div>` +
        (tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : '') +
      `</div>`;

    return el;
  }

  /* ---------- Render ---------- */
  function render() {
    const list = filtered();
    $grid.innerHTML = '';

    if (!list.length) {
      $empty.classList.remove('hidden');
    } else {
      $empty.classList.add('hidden');
      list.forEach((a, i) => $grid.appendChild(card(a, i)));
    }
  }

  /* ---------- Init ---------- */
  async function init() {
    initTheme();
    $theme.addEventListener('click', toggleTheme);

    await loadApps();
    $loading.classList.add('hidden');

    if (!apps.length) {
      $empty.classList.remove('hidden');
      return;
    }

    initFuse();
    renderTags();
    render();

    let timer;
    $search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
