(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const tabsEl = $('category-tabs');
  const unitAEl = $('unit-a');
  const unitBEl = $('unit-b');
  const valueAEl = $('value-a');
  const valueBEl = $('value-b');
  const precisionEl = $('precision');
  const formulaEl = $('formula');
  const quickListEl = $('quick-list');
  const swapBtn = $('swap-btn');

  const CATEGORIES = {
    length: {
      label: '長さ',
      base: 'm',
      units: {
        m: { label: 'メートル (m)', factor: 1 },
        km: { label: 'キロメートル (km)', factor: 1000 },
        cm: { label: 'センチメートル (cm)', factor: 0.01 },
        mm: { label: 'ミリメートル (mm)', factor: 0.001 },
        in: { label: 'インチ (in)', factor: 0.0254 },
        ft: { label: 'フィート (ft)', factor: 0.3048 },
        yd: { label: 'ヤード (yd)', factor: 0.9144 },
        mi: { label: 'マイル (mi)', factor: 1609.344 },
      },
      quick: [
        ['m', 'cm'],
        ['km', 'm'],
        ['in', 'cm'],
        ['mi', 'km'],
      ],
    },
    mass: {
      label: '重さ',
      base: 'kg',
      units: {
        kg: { label: 'キログラム (kg)', factor: 1 },
        g: { label: 'グラム (g)', factor: 0.001 },
        mg: { label: 'ミリグラム (mg)', factor: 0.000001 },
        lb: { label: 'ポンド (lb)', factor: 0.45359237 },
        oz: { label: 'オンス (oz)', factor: 0.0283495 },
      },
      quick: [
        ['kg', 'g'],
        ['lb', 'kg'],
        ['oz', 'g'],
      ],
    },
    temp: {
      label: '温度',
      base: 'c',
      units: {
        c: {
          label: '摂氏 (°C)',
          toBase: (v) => v,
          fromBase: (v) => v,
        },
        f: {
          label: '華氏 (°F)',
          toBase: (v) => (v - 32) * (5 / 9),
          fromBase: (v) => (v * 9) / 5 + 32,
        },
        k: {
          label: 'ケルビン (K)',
          toBase: (v) => v - 273.15,
          fromBase: (v) => v + 273.15,
        },
      },
      quick: [
        ['c', 'f'],
        ['c', 'k'],
      ],
    },
    area: {
      label: '面積',
      base: 'm2',
      units: {
        m2: { label: '平方メートル (m²)', factor: 1 },
        km2: { label: '平方キロメートル (km²)', factor: 1_000_000 },
        cm2: { label: '平方センチ (cm²)', factor: 0.0001 },
        ha: { label: 'ヘクタール (ha)', factor: 10000 },
        acre: { label: 'エーカー', factor: 4046.8564224 },
        sqft: { label: '平方フィート (ft²)', factor: 0.09290304 },
      },
      quick: [
        ['m2', 'cm2'],
        ['ha', 'm2'],
        ['acre', 'm2'],
      ],
    },
    volume: {
      label: '体積',
      base: 'l',
      units: {
        l: { label: 'リットル (L)', factor: 1 },
        ml: { label: 'ミリリットル (mL)', factor: 0.001 },
        m3: { label: '立方メートル (m³)', factor: 1000 },
        cup: { label: 'カップ (US)', factor: 0.236588 },
        gal: { label: 'ガロン (US)', factor: 3.78541 },
      },
      quick: [
        ['l', 'ml'],
        ['m3', 'l'],
        ['gal', 'l'],
      ],
    },
    data: {
      label: 'データ量',
      base: 'b',
      units: {
        b: { label: 'バイト (B)', factor: 1 },
        kb: { label: 'キロバイト (KB)', factor: 1000 },
        mb: { label: 'メガバイト (MB)', factor: 1_000_000 },
        gb: { label: 'ギガバイト (GB)', factor: 1_000_000_000 },
        tb: { label: 'テラバイト (TB)', factor: 1_000_000_000_000 },
        kib: { label: 'キビバイト (KiB)', factor: 1024 },
        mib: { label: 'メビバイト (MiB)', factor: 1_048_576 },
        gib: { label: 'ギビバイト (GiB)', factor: 1_073_741_824 },
      },
      quick: [
        ['mb', 'gb'],
        ['gb', 'tb'],
        ['mib', 'mb'],
      ],
    },
    speed: {
      label: '速度',
      base: 'ms',
      units: {
        ms: { label: 'm/s', factor: 1 },
        kmh: { label: 'km/h', factor: 0.2777777778 },
        mph: { label: 'mph', factor: 0.44704 },
        knot: { label: 'ノット', factor: 0.514444 },
      },
      quick: [
        ['kmh', 'ms'],
        ['mph', 'kmh'],
      ],
    },
    time: {
      label: '時間',
      base: 's',
      units: {
        s: { label: '秒', factor: 1 },
        min: { label: '分', factor: 60 },
        h: { label: '時間', factor: 3600 },
        day: { label: '日', factor: 86400 },
      },
      quick: [
        ['min', 's'],
        ['h', 'min'],
        ['day', 'h'],
      ],
    },
  };

  const state = {
    category: 'length',
    unitA: 'm',
    unitB: 'cm',
    lastEdited: 'a',
  };

  function formatNumber(value, precision) {
    if (!Number.isFinite(value)) return '';
    if (precision === 0) return Math.round(value).toString();
    const fixed = value.toFixed(precision);
    return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function parseNumber(text) {
    if (text === '' || text === null || text === undefined) return null;
    const sanitized = text.replace(/,/g, '');
    const value = Number(sanitized);
    return Number.isFinite(value) ? value : null;
  }

  function toBase(category, unit, value) {
    const def = CATEGORIES[category].units[unit];
    if (def.toBase) return def.toBase(value);
    return value * def.factor;
  }

  function fromBase(category, unit, value) {
    const def = CATEGORIES[category].units[unit];
    if (def.fromBase) return def.fromBase(value);
    return value / def.factor;
  }

  function convert(value, fromUnit, toUnit) {
    const base = toBase(state.category, fromUnit, value);
    return fromBase(state.category, toUnit, base);
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    Object.entries(CATEGORIES).forEach(([key, def]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = def.label;
      if (key === state.category) btn.classList.add('active');
      btn.addEventListener('click', () => {
        state.category = key;
        const units = Object.keys(def.units);
        state.unitA = units[0];
        state.unitB = units[1] || units[0];
        renderTabs();
        renderUnits();
        update();
      });
      tabsEl.appendChild(btn);
    });
  }

  function renderUnits() {
    const def = CATEGORIES[state.category];
    const units = Object.entries(def.units);
    unitAEl.innerHTML = '';
    unitBEl.innerHTML = '';

    units.forEach(([key, unit]) => {
      const optionA = document.createElement('option');
      optionA.value = key;
      optionA.textContent = unit.label;
      unitAEl.appendChild(optionA);

      const optionB = document.createElement('option');
      optionB.value = key;
      optionB.textContent = unit.label;
      unitBEl.appendChild(optionB);
    });

    unitAEl.value = state.unitA;
    unitBEl.value = state.unitB;
  }

  function updateFormula() {
    const baseValue = 1;
    const converted = convert(baseValue, state.unitA, state.unitB);
    const precision = Number(precisionEl.value);
    const leftLabel = CATEGORIES[state.category].units[state.unitA].label;
    const rightLabel = CATEGORIES[state.category].units[state.unitB].label;
    formulaEl.textContent = `1 ${leftLabel} = ${formatNumber(converted, precision)} ${rightLabel}`;
  }

  function renderQuick() {
    quickListEl.innerHTML = '';
    const def = CATEGORIES[state.category];
    def.quick.forEach(([from, to]) => {
      const value = convert(1, from, to);
      const precision = Number(precisionEl.value);
      const card = document.createElement('div');
      card.className = 'quick-card';
      const label = document.createElement('div');
      label.className = 'quick-label';
      label.textContent = `${def.units[from].label} → ${def.units[to].label}`;
      const val = document.createElement('div');
      val.className = 'quick-value';
      val.textContent = formatNumber(value, precision);
      card.appendChild(label);
      card.appendChild(val);
      card.addEventListener('click', () => {
        state.unitA = from;
        state.unitB = to;
        unitAEl.value = from;
        unitBEl.value = to;
        update();
      });
      quickListEl.appendChild(card);
    });
  }

  function update() {
    const precision = Number(precisionEl.value);

    const valueA = parseNumber(valueAEl.value);
    const valueB = parseNumber(valueBEl.value);

    if (state.lastEdited === 'a') {
      if (valueA === null) {
        valueBEl.value = '';
      } else {
        valueBEl.value = formatNumber(convert(valueA, state.unitA, state.unitB), precision);
      }
    } else {
      if (valueB === null) {
        valueAEl.value = '';
      } else {
        valueAEl.value = formatNumber(convert(valueB, state.unitB, state.unitA), precision);
      }
    }

    updateFormula();
    renderQuick();
  }

  valueAEl.addEventListener('input', () => {
    state.lastEdited = 'a';
    update();
  });

  valueBEl.addEventListener('input', () => {
    state.lastEdited = 'b';
    update();
  });

  unitAEl.addEventListener('change', () => {
    state.unitA = unitAEl.value;
    update();
  });

  unitBEl.addEventListener('change', () => {
    state.unitB = unitBEl.value;
    update();
  });

  precisionEl.addEventListener('change', update);

  swapBtn.addEventListener('click', () => {
    [state.unitA, state.unitB] = [state.unitB, state.unitA];
    [valueAEl.value, valueBEl.value] = [valueBEl.value, valueAEl.value];
    state.lastEdited = 'a';
    unitAEl.value = state.unitA;
    unitBEl.value = state.unitB;
    update();
  });

  renderTabs();
  renderUnits();
  update();
})();
