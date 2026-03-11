(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const inputEl = $('url-input');
  const baseEl = $('base-input');
  const hashEl = $('hash-input');
  const rowsEl = $('param-rows');
  const outputEl = $('url-output');
  const statCountEl = $('stat-count');
  const statLengthEl = $('stat-length');

  const optSort = $('opt-sort');
  const optKeepEmpty = $('opt-keep-empty');
  const optPlusSpace = $('opt-plus-space');

  const btnParse = $('btn-parse');
  const btnSample = $('btn-sample');
  const btnClear = $('btn-clear');
  const btnAdd = $('btn-add');
  const btnCopyUrl = $('btn-copy-url');
  const btnCopyQuery = $('btn-copy-query');

  const state = {
    base: '',
    hash: '',
    params: [{ key: '', value: '' }],
  };

  const sample = 'https://example.com/search?q=glassmorphism&lang=ja&empty=#section-2';

  function decodePart(raw) {
    if (!raw) return '';
    let text = raw;
    if (optPlusSpace.checked) {
      text = text.replace(/\+/g, ' ');
    }
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  function encodePart(raw) {
    const encoded = encodeURIComponent(raw ?? '');
    return optPlusSpace.checked ? encoded.replace(/%20/g, '+') : encoded;
  }

  function parseQuery(query) {
    if (!query) return [{ key: '', value: '' }];

    return query.split('&').map((part) => {
      if (!part) return { key: '', value: '' };
      const idx = part.indexOf('=');
      const key = idx >= 0 ? part.slice(0, idx) : part;
      const value = idx >= 0 ? part.slice(idx + 1) : '';
      return {
        key: decodePart(key),
        value: decodePart(value),
      };
    });
  }

  function parseInput(text) {
    const raw = (text || '').trim();
    if (!raw) {
      state.base = '';
      state.hash = '';
      state.params = [{ key: '', value: '' }];
      syncInputs();
      renderRows();
      updateOutput();
      return;
    }

    let hash = '';
    let beforeHash = raw;
    const hashIndex = raw.indexOf('#');
    if (hashIndex >= 0) {
      beforeHash = raw.slice(0, hashIndex);
      hash = raw.slice(hashIndex + 1);
    }

    let base = beforeHash;
    let query = '';
    const queryIndex = beforeHash.indexOf('?');
    if (queryIndex >= 0) {
      base = beforeHash.slice(0, queryIndex);
      query = beforeHash.slice(queryIndex + 1);
    } else if (beforeHash.includes('=')) {
      base = '';
      query = beforeHash;
    }

    state.base = base;
    state.hash = decodePart(hash);
    state.params = parseQuery(query);

    syncInputs();
    renderRows();
    updateOutput();
  }

  function syncInputs() {
    baseEl.value = state.base;
    hashEl.value = state.hash;
  }

  function buildQuery(params) {
    const list = params.map((p, idx) => ({
      key: p.key ?? '',
      value: p.value ?? '',
      idx,
    }));

    if (optSort.checked) {
      list.sort((a, b) => {
        const byKey = (a.key || '').localeCompare(b.key || '', 'ja');
        return byKey !== 0 ? byKey : a.idx - b.idx;
      });
    }

    const pairs = [];
    list.forEach(({ key, value }) => {
      if (!optKeepEmpty.checked && key === '' && value === '') return;
      const encKey = encodePart(key);
      const encValue = encodePart(value);
      if (encKey === '' && encValue === '' && !optKeepEmpty.checked) return;
      if (encValue === '' && optKeepEmpty.checked) {
        pairs.push(`${encKey}=`);
      } else {
        pairs.push(`${encKey}=${encValue}`);
      }
    });

    return pairs.join('&');
  }

  function buildUrl() {
    const query = buildQuery(state.params);
    const hash = state.hash ? `#${encodePart(state.hash)}` : '';

    if (!state.base && !query && hash) return hash;

    let url = state.base || '';
    if (query) {
      url += `${url ? '?' : '?'}${query}`;
    }
    if (hash) url += hash;
    return url;
  }

  function updateOutput() {
    const query = buildQuery(state.params);
    const url = buildUrl();

    outputEl.value = url;
    const count = query ? query.split('&').filter(Boolean).length : 0;
    statCountEl.textContent = count.toString();
    statLengthEl.textContent = url.length.toString();
  }

  function renderRows() {
    rowsEl.innerHTML = '';

    state.params.forEach((param, idx) => {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.dataset.index = idx.toString();

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.name = 'key';
      keyInput.value = param.key;
      keyInput.placeholder = 'key';

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.name = 'value';
      valueInput.value = param.value;
      valueInput.placeholder = 'value';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '削除';
      removeBtn.dataset.remove = 'true';

      row.appendChild(keyInput);
      row.appendChild(valueInput);
      row.appendChild(removeBtn);
      rowsEl.appendChild(row);
    });
  }

  function addRow() {
    state.params.push({ key: '', value: '' });
    renderRows();
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
    }
  }

  rowsEl.addEventListener('input', (event) => {
    const row = event.target.closest('.param-row');
    if (!row) return;
    const idx = Number(row.dataset.index);
    const target = event.target;
    if (target.name === 'key') {
      state.params[idx].key = target.value;
    }
    if (target.name === 'value') {
      state.params[idx].value = target.value;
    }
    updateOutput();
  });

  rowsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-remove]');
    if (!btn) return;
    const row = event.target.closest('.param-row');
    if (!row) return;
    const idx = Number(row.dataset.index);
    state.params.splice(idx, 1);
    if (state.params.length === 0) state.params.push({ key: '', value: '' });
    renderRows();
    updateOutput();
  });

  baseEl.addEventListener('input', () => {
    state.base = baseEl.value.trim();
    updateOutput();
  });

  hashEl.addEventListener('input', () => {
    state.hash = hashEl.value.trim();
    updateOutput();
  });

  [optSort, optKeepEmpty, optPlusSpace].forEach((opt) => {
    opt.addEventListener('change', () => {
      updateOutput();
    });
  });

  btnParse.addEventListener('click', () => parseInput(inputEl.value));
  btnSample.addEventListener('click', () => {
    inputEl.value = sample;
    parseInput(sample);
  });
  btnClear.addEventListener('click', () => {
    inputEl.value = '';
    parseInput('');
  });

  btnAdd.addEventListener('click', () => {
    addRow();
    updateOutput();
  });

  btnCopyUrl.addEventListener('click', () => copyText(outputEl.value));
  btnCopyQuery.addEventListener('click', () => {
    const query = buildQuery(state.params);
    copyText(query);
  });

  let inputTimer = null;
  inputEl.addEventListener('input', () => {
    window.clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => parseInput(inputEl.value), 300);
  });

  inputEl.value = sample;
  parseInput(sample);
})();
