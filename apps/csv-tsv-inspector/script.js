(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const inputEl = $('input-data');
  const delimiterEl = $('delimiter-select');
  const optHeaderEl = $('opt-header');
  const optTrimEl = $('opt-trim');
  const infoEl = $('input-info');

  const statRowsEl = $('stat-rows');
  const statColsEl = $('stat-cols');
  const statEmptyEl = $('stat-empty');
  const statFillEl = $('stat-fill');
  const columnBodyEl = $('column-body');
  const previewEl = $('preview-table');

  const exportJsonEl = $('export-json');
  const exportMdEl = $('export-md');
  const exportLatexEl = $('export-latex');
  const exportHtmlEl = $('export-html');
  const btnCopyJson = $('btn-copy-json');
  const btnCopyMd = $('btn-copy-md');
  const btnCopyLatex = $('btn-copy-latex');
  const btnCopyHtml = $('btn-copy-html');
  const btnSample = $('btn-sample');
  const btnClear = $('btn-clear');

  const sample = `name,department,score,active
Alice,Design,82,true
Bob,Engineering,91,true
Cathy,Engineering,88,true
Daisuke,Sales,71,false
Erika,Marketing,85,true`;

  const state = {
    rows: [],
    headers: [],
    data: [],
  };

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          row.push(field);
          field = '';
        } else if (ch === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else if (ch === '\r') {
          if (text[i + 1] === '\n') i += 1;
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else {
          field += ch;
        }
      }
    }

    row.push(field);
    rows.push(row);

    if (rows.length && rows[rows.length - 1].every((v) => v === '')) {
      rows.pop();
    }

    return rows;
  }

  function countFields(line, delimiter) {
    let count = 1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        count += 1;
      }
    }
    return count;
  }

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).slice(0, 6).filter(Boolean);
    const candidates = [',', '\t', ';', '|'];
    let best = { delimiter: ',', score: -Infinity, avg: 0 };

    candidates.forEach((delim) => {
      const counts = lines.map((line) => countFields(line, delim));
      const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
      const variance = counts.reduce((a, b) => a + Math.abs(b - avg), 0);
      const score = avg - variance * 0.25;
      if (avg > 1 && score > best.score) {
        best = { delimiter: delim, score, avg };
      }
    });

    return best.delimiter;
  }

  function normalizeRows(rows) {
    const max = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return rows.map((row) => {
      if (row.length === max) return row;
      return row.concat(Array(max - row.length).fill(''));
    });
  }

  function normalizeHeaders(rawHeaders) {
    const used = new Map();
    return rawHeaders.map((name, idx) => {
      let clean = (name || '').trim();
      if (!clean) clean = `Column ${idx + 1}`;
      const count = used.get(clean) || 0;
      used.set(clean, count + 1);
      return count === 0 ? clean : `${clean}_${count + 1}`;
    });
  }

  function isNumber(value) {
    return /^-?\d+(\.\d+)?$/.test(value);
  }

  function isBoolean(value) {
    return /^(true|false)$/i.test(value);
  }

  function isDate(value) {
    if (!/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value)) return false;
    const date = Date.parse(value);
    return Number.isFinite(date);
  }

  function inferType(values) {
    if (!values.length) return 'empty';
    const numCount = values.filter(isNumber).length;
    const boolCount = values.filter(isBoolean).length;
    const dateCount = values.filter(isDate).length;

    if (numCount === values.length) return 'number';
    if (boolCount === values.length) return 'boolean';
    if (dateCount === values.length) return 'date';
    if (numCount || boolCount || dateCount) return 'mixed';
    return 'text';
  }

  function computeStats(rows, headers) {
    const rowCount = rows.length;
    const colCount = headers.length;
    const totalCells = rowCount * colCount;

    let empty = 0;
    const columns = headers.map((header, index) => {
      const values = rows.map((row) => row[index] ?? '');
      const nonEmpty = values.filter((v) => v !== '');
      empty += values.length - nonEmpty.length;
      const unique = new Set(nonEmpty).size;
      const maxLen = values.reduce((m, v) => Math.max(m, v.length), 0);
      return {
        name: header,
        type: inferType(nonEmpty),
        empty: values.length - nonEmpty.length,
        unique,
        maxLen,
      };
    });

    const fill = totalCells ? ((totalCells - empty) / totalCells) * 100 : 0;

    return {
      rowCount,
      colCount,
      empty,
      fillRate: `${fill.toFixed(1)}%`,
      columns,
    };
  }

  function renderStats(stats) {
    statRowsEl.textContent = stats.rowCount.toString();
    statColsEl.textContent = stats.colCount.toString();
    statEmptyEl.textContent = stats.empty.toString();
    statFillEl.textContent = stats.fillRate;

    columnBodyEl.innerHTML = '';
    stats.columns.forEach((col) => {
      const row = document.createElement('div');
      row.className = 'column-row';
      const items = [
        col.name,
        col.type,
        col.empty.toString(),
        col.unique.toString(),
        col.maxLen.toString(),
      ];
      items.forEach((text) => {
        const span = document.createElement('span');
        span.textContent = text;
        row.appendChild(span);
      });
      columnBodyEl.appendChild(row);
    });
  }

  function renderPreview(headers, rows) {
    previewEl.innerHTML = '';

    if (!rows.length) return;

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((header) => {
      const th = document.createElement('th');
      th.textContent = header;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.slice(0, 50).forEach((row) => {
      const tr = document.createElement('tr');
      headers.forEach((_, idx) => {
        const td = document.createElement('td');
        td.textContent = row[idx] ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    previewEl.appendChild(table);
  }

  function escapeMarkdown(value) {
    return (value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function buildJson(headers, rows) {
    if (!rows.length) return '';
    const objects = rows.map((row) => {
      const obj = {};
      headers.forEach((header, idx) => {
        obj[header] = row[idx] ?? '';
      });
      return obj;
    });
    return JSON.stringify(objects, null, 2);
  }

  function buildMarkdown(headers, rows) {
    if (!rows.length) return '';
    const head = `| ${headers.map(escapeMarkdown).join(' | ')} |`;
    const separator = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.slice(0, 20).map((row) => {
      const cells = headers.map((_, idx) => escapeMarkdown(row[idx] ?? ''));
      return `| ${cells.join(' | ')} |`;
    });
    return [head, separator, ...body].join('\n');
  }

  function escLaTeX(s) {
    return (s || '').replace(/[&%$#_{}~^\\]/g, m => '\\' + m);
  }

  function buildLaTeX(headers, rows) {
    if (!rows.length) return '';
    const cols = headers.length;
    const colSpec = Array(cols).fill('l').join(' ');
    const lines = [];
    lines.push('\\begin{table}[htbp]');
    lines.push('  \\centering');
    lines.push(`  \\begin{tabular}{${colSpec}}`);
    lines.push('    \\hline');
    
    lines.push('    ' + headers.map(escLaTeX).join(' & ') + ' \\\\');
    lines.push('    \\hline');

    rows.slice(0, 50).forEach((row) => {
      const cells = headers.map((_, c) => escLaTeX(row[c] ?? ''));
      lines.push('    ' + cells.join(' & ') + ' \\\\');
    });

    lines.push('    \\hline');
    lines.push('  \\end{tabular}');
    lines.push('  \\caption{}');
    lines.push('  \\label{tab:}');
    lines.push('\\end{table}');

    return lines.join('\n');
  }

  function escHTML(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildHTML(headers, rows) {
    if (!rows.length) return '';
    const cols = headers.length;
    const lines = [];
    lines.push('<table>');
    lines.push('  <thead>');
    lines.push('    <tr>');
    for (let c = 0; c < cols; c++) {
      lines.push(`      <th>${escHTML(headers[c])}</th>`);
    }
    lines.push('    </tr>');
    lines.push('  </thead>');
    lines.push('  <tbody>');
    
    rows.slice(0, 50).forEach((row) => {
      lines.push('    <tr>');
      for (let c = 0; c < cols; c++) {
        lines.push(`      <td>${escHTML(row[c] ?? '')}</td>`);
      }
      lines.push('    </tr>');
    });
    lines.push('  </tbody>');
    lines.push('</table>');

    return lines.join('\n');
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

  function update() {
    const text = inputEl.value;
    if (!text.trim()) {
      infoEl.textContent = 'まだデータがありません。';
      renderStats({ rowCount: 0, colCount: 0, empty: 0, fillRate: '0%', columns: [] });
      previewEl.innerHTML = '';
      exportJsonEl.value = '';
      exportMdEl.value = '';
      exportLatexEl.value = '';
      exportHtmlEl.value = '';
      return;
    }

    const delimiter = delimiterEl.value === 'auto' ? detectDelimiter(text) : delimiterEl.value;
    const rows = parseDelimited(text, delimiter);
    const normalized = normalizeRows(rows).map((row) =>
      optTrimEl.checked ? row.map((cell) => cell.trim()) : row
    );

    let headers = [];
    let data = normalized;

    if (optHeaderEl.checked && normalized.length) {
      headers = normalizeHeaders(normalized[0]);
      data = normalized.slice(1);
    } else {
      const colCount = normalized[0]?.length || 0;
      headers = normalizeHeaders(Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`));
    }

    state.rows = normalized;
    state.headers = headers;
    state.data = data;

    const stats = computeStats(data, headers);
    renderStats(stats);
    renderPreview(headers, data);

    exportJsonEl.value = buildJson(headers, data);
    exportMdEl.value = buildMarkdown(headers, data);
    exportLatexEl.value = buildLaTeX(headers, data);
    exportHtmlEl.value = buildHTML(headers, data);

    const label = delimiter === '\t' ? 'タブ' : delimiter;
    infoEl.textContent = `区切り文字: ${label} ｜ 行 ${stats.rowCount} / 列 ${stats.colCount}`;
  }

  let timer = null;
  function scheduleUpdate() {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 150);
  }

  inputEl.addEventListener('input', scheduleUpdate);
  delimiterEl.addEventListener('change', update);
  optHeaderEl.addEventListener('change', update);
  optTrimEl.addEventListener('change', update);

  btnCopyJson.addEventListener('click', () => copyText(exportJsonEl.value));
  btnCopyMd.addEventListener('click', () => copyText(exportMdEl.value));
  btnCopyLatex.addEventListener('click', () => copyText(exportLatexEl.value));
  btnCopyHtml.addEventListener('click', () => copyText(exportHtmlEl.value));

  btnSample.addEventListener('click', () => {
    inputEl.value = sample;
    update();
  });

  btnClear.addEventListener('click', () => {
    inputEl.value = '';
    update();
  });

  update();
})();
