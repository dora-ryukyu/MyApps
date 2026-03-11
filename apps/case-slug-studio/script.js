(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const inputEl = $('input-text');
  const tokenListEl = $('token-list');
  const tokenCountEl = $('token-count');

  const opts = {
    trim: $('opt-trim'),
    collapse: $('opt-collapse'),
    removeSymbols: $('opt-remove-symbols'),
    ascii: $('opt-ascii'),
    prefixNumber: $('opt-prefix-number'),
    slugAscii: $('opt-slug-ascii'),
  };

  const outputs = {
    camel: $('out-camel'),
    pascal: $('out-pascal'),
    snake: $('out-snake'),
    kebab: $('out-kebab'),
    upper: $('out-upper'),
    title: $('out-title'),
    sentence: $('out-sentence'),
    slug: $('out-slug'),
  };

  const sample = 'Project New Horizon v2: Launch Schedule';

  let diacriticRegex = /[\u0300-\u036f]/g;
  let symbolRegex = /[^A-Za-z0-9\s]+/g;
  try {
    diacriticRegex = new RegExp('\\p{Diacritic}', 'gu');
    symbolRegex = new RegExp('[^\\p{L}\\p{N}\\s]+', 'gu');
  } catch {
    // Fallback for environments without Unicode property escapes.
  }

  function toAscii(text) {
    return text.normalize('NFKD').replace(diacriticRegex, '');
  }

  function preprocess(raw) {
    let text = raw || '';

    if (opts.ascii.checked) {
      text = toAscii(text);
    }

    text = text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[_\-./]+/g, ' ');

    if (opts.removeSymbols.checked) {
      text = text.replace(symbolRegex, ' ');
    }

    if (opts.collapse.checked) {
      text = text.replace(/\s+/g, ' ');
    }

    if (opts.trim.checked) {
      text = text.trim();
    }

    return text;
  }

  function tokenize(text) {
    if (!text) return [];
    return text.split(' ').filter(Boolean);
  }

  function capitalize(word) {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function guardLeadingNumber(text) {
    if (!opts.prefixNumber.checked) return text;
    if (/^\d/.test(text)) return `_${text}`;
    return text;
  }

  function renderTokens(tokens) {
    tokenListEl.innerHTML = '';
    tokens.forEach((token) => {
      const chip = document.createElement('span');
      chip.className = 'token';
      chip.textContent = token;
      tokenListEl.appendChild(chip);
    });
    tokenCountEl.textContent = tokens.length.toString();
  }

  function buildOutputs(tokens) {
    const lower = tokens.map((t) => t.toLowerCase());

    const camel = lower.length
      ? lower[0] + lower.slice(1).map(capitalize).join('')
      : '';
    const pascal = lower.map(capitalize).join('');
    const snake = lower.join('_');
    const kebab = lower.join('-');
    const upper = lower.map((t) => t.toUpperCase()).join('_');
    const title = tokens.map(capitalize).join(' ');
    const sentence = tokens.length
      ? capitalize(lower.join(' '))
      : '';

    let slug = lower.join('-');
    if (opts.slugAscii.checked) {
      slug = toAscii(slug).toLowerCase().replace(/[^a-z0-9-]/g, '');
    }
    slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '');

    return {
      camel: guardLeadingNumber(camel),
      pascal: guardLeadingNumber(pascal),
      snake: guardLeadingNumber(snake),
      kebab: guardLeadingNumber(kebab),
      upper: guardLeadingNumber(upper),
      title,
      sentence,
      slug,
    };
  }

  function update() {
    const prepared = preprocess(inputEl.value);
    const tokens = tokenize(prepared);
    renderTokens(tokens);

    const results = buildOutputs(tokens);
    Object.entries(outputs).forEach(([key, el]) => {
      el.value = results[key];
    });
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

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-copy');
      copyText(outputs[key].value);
    });
  });

  Object.values(opts).forEach((opt) => {
    opt.addEventListener('change', update);
  });

  inputEl.addEventListener('input', update);

  $('btn-sample').addEventListener('click', () => {
    inputEl.value = sample;
    update();
  });

  $('btn-clear').addEventListener('click', () => {
    inputEl.value = '';
    update();
  });

  inputEl.value = sample;
  update();
})();
