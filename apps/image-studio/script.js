(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const editorCanvas = $('editor-canvas');
  const overlayCanvas = $('overlay-canvas');
  const previewCanvas = $('perspective-preview');
  const canvasStage = $('canvas-stage');
  const canvasArea = $('canvas-area');
  const emptyState = $('empty-state');
  const statusEl = $('status');

  const fileInput = $('file-input');
  const btnSample = $('btn-sample');
  const btnRevert = $('btn-revert');
  const btnUndo = $('btn-undo');
  const btnRedo = $('btn-redo');
  const btnFit = $('btn-fit');
  const btnActual = $('btn-actual');

  const toolButtons = document.querySelectorAll('.tool-btn');
  const toolPanels = document.querySelectorAll('.tool-panel');

  const straightenInput = $('straighten');
  const straightenVal = $('straighten-val');
  const btnRotateLeft = $('btn-rotate-left');
  const btnRotateRight = $('btn-rotate-right');
  const btnFlipX = $('btn-flip-x');
  const btnFlipY = $('btn-flip-y');
  const btnResetGeometry = $('btn-reset-geometry');
  const perspectiveX = $('perspective-x');
  const perspectiveY = $('perspective-y');

  const cropRatio = $('crop-ratio');
  const btnApplyCrop = $('btn-apply-crop');
  const btnResetCrop = $('btn-reset-crop');

  const adjustSliders = $('adjust-sliders');
  const btnResetAdjust = $('btn-reset-adjust');

  const filterGrid = $('filter-grid');

  const localMode = $('local-mode');
  const localAmount = $('local-amount');
  const brushSize = $('brush-size');
  const brushStrength = $('brush-strength');
  const brushErase = $('brush-erase');
  const showMask = $('show-mask');
  const btnClearLocal = $('btn-clear-local');

  const healSize = $('heal-size');
  const healOpacity = $('heal-opacity');
  const btnClearHeal = $('btn-clear-heal');

  const textInput = $('text-input');
  const textSize = $('text-size');
  const textColor = $('text-color');
  const textOpacity = $('text-opacity');
  const textWeight = $('text-weight');
  const btnAddText = $('btn-add-text');
  const btnRemoveText = $('btn-remove-text');
  const textLayerList = $('text-layer-list');

  const exportFormat = $('export-format');
  const exportQuality = $('export-quality');
  const exportSize = $('export-size');
  const exportBg = $('export-bg');
  const btnExport = $('btn-export');

  const ctx = editorCanvas.getContext('2d');
  const overlayCtx = overlayCanvas.getContext('2d');
  const previewCtx = previewCanvas.getContext('2d');

  const ADJUSTMENTS = [
    { id: 'exposure', label: '露出', min: -1, max: 1, step: 0.01 },
    { id: 'contrast', label: 'コントラスト', min: -1, max: 1, step: 0.01 },
    { id: 'highlights', label: 'ハイライト', min: -1, max: 1, step: 0.01 },
    { id: 'shadows', label: 'シャドウ', min: -1, max: 1, step: 0.01 },
    { id: 'saturation', label: '彩度', min: -1, max: 1, step: 0.01 },
    { id: 'warmth', label: '暖かさ', min: -1, max: 1, step: 0.01 },
    { id: 'tint', label: 'ティント', min: -1, max: 1, step: 0.01 },
    { id: 'clarity', label: '明瞭度', min: -1, max: 1, step: 0.01 },
    { id: 'vignette', label: '周辺光量', min: -1, max: 1, step: 0.01 },
  ];

  const FILTERS = [
    { id: 'none', label: 'なし', adjust: {} },
    { id: 'vivid', label: 'Vivid', adjust: { saturation: 0.35, contrast: 0.2 } },
    { id: 'noir', label: 'Noir', adjust: { saturation: -1, contrast: 0.25, clarity: 0.2 } },
    { id: 'warm', label: 'Warm', adjust: { warmth: 0.25, saturation: 0.15 } },
    { id: 'cool', label: 'Cool', adjust: { warmth: -0.25, tint: 0.1 } },
    { id: 'matte', label: 'Matte', adjust: { contrast: -0.25, shadows: 0.2, highlights: -0.2 } },
  ];

  const DEFAULT_ADJUST = ADJUSTMENTS.reduce((acc, cur) => {
    acc[cur.id] = 0;
    return acc;
  }, {});

  const state = {
    tool: 'geometry',
    image: null,
    original: { w: 0, h: 0 },
    previewScale: 1,
    fullSize: { w: 0, h: 0 },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    transforms: {
      rotate: 0,
      straighten: 0,
      flipX: false,
      flipY: false,
      perspectivePoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      perspectiveManual: false,
    },
    adjustments: { ...DEFAULT_ADJUST },
    filter: 'none',
    local: {
      exposureMask: null,
      saturationMask: null,
      maskScale: 1,
      exposureAmount: 0.3,
      saturationAmount: 0.3,
    },
    heal: {
      strokes: [],
      source: null,
    },
    text: {
      layers: [],
      activeId: null,
      bounds: [],
    },
    history: {
      undo: [],
      redo: [],
    },
    zoom: 1,
  };

  let renderQueued = false;
  let lastSnapshot = null;
  let cropDrag = null;
  let localPaint = false;
  let healPaint = false;
  let textDrag = null;
  let previewDrag = null;
  let pointer = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createCanvas(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }

  function copyCanvas(source) {
    const canvas = createCanvas(source.width, source.height);
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    return canvas;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setEmptyState(visible) {
    emptyState.style.display = visible ? 'block' : 'none';
  }

  let lastNonCropTool = 'geometry';

  function setTool(tool) {
    if (tool !== 'crop') {
      lastNonCropTool = tool;
    }
    state.tool = tool;
    toolButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    toolPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === tool);
    });
    renderOverlay();
  }

  function initSliders() {
    adjustSliders.innerHTML = '';
    ADJUSTMENTS.forEach((adj) => {
      const row = document.createElement('div');
      row.className = 'slider-row';

      const label = document.createElement('label');
      label.className = 'field-label';
      label.htmlFor = `adj-${adj.id}`;
      label.textContent = adj.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.id = `adj-${adj.id}`;
      input.min = adj.min;
      input.max = adj.max;
      input.step = adj.step;
      input.value = state.adjustments[adj.id];

      const value = document.createElement('div');
      value.className = 'value-row';
      value.innerHTML = `<span>${adj.label}</span><strong>0</strong>`;

      input.addEventListener('input', () => {
        state.adjustments[adj.id] = Number(input.value);
        value.querySelector('strong').textContent = Number(input.value).toFixed(2);
        scheduleRender();
      });
      input.addEventListener('change', () => pushHistory());

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(value);
      adjustSliders.appendChild(row);
    });
  }

  function updateSliderValues() {
    ADJUSTMENTS.forEach((adj) => {
      const input = $(`adj-${adj.id}`);
      const value = input?.nextElementSibling?.querySelector('strong');
      if (input) {
        input.value = state.adjustments[adj.id];
      }
      if (value) {
        value.textContent = Number(state.adjustments[adj.id]).toFixed(2);
      }
    });
  }

  function initFilters() {
    filterGrid.innerHTML = '';
    FILTERS.forEach((filter) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'filter-card';
      card.textContent = filter.label;
      card.dataset.filter = filter.id;
      card.classList.toggle('active', filter.id === state.filter);
      card.addEventListener('click', () => {
        state.filter = filter.id;
        filterGrid.querySelectorAll('.filter-card').forEach((el) => {
          el.classList.toggle('active', el.dataset.filter === filter.id);
        });
        scheduleRender();
        pushHistory();
      });
      filterGrid.appendChild(card);
    });
  }

  function updateFilterUI() {
    filterGrid.querySelectorAll('.filter-card').forEach((el) => {
      el.classList.toggle('active', el.dataset.filter === state.filter);
    });
  }

  function defaultCrop() {
    state.crop = { x: 0, y: 0, w: 1, h: 1 };
  }

  function resetGeometry() {
    state.transforms.rotate = 0;
    state.transforms.straighten = 0;
    state.transforms.flipX = false;
    state.transforms.flipY = false;
    state.transforms.perspectivePoints = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    state.transforms.perspectiveManual = false;
    perspectiveX.value = '0';
    perspectiveY.value = '0';
    straightenInput.value = '0';
    straightenVal.textContent = '0°';
    defaultCrop();
    resetLocalAndHeal();
    updatePerspectivePreview();
    scheduleRender();
    pushHistory();
  }

  function resetAdjustments() {
    state.adjustments = { ...DEFAULT_ADJUST };
    updateSliderValues();
    scheduleRender();
    pushHistory();
  }

  function resetLocal() {
    state.local.exposureMask = null;
    state.local.saturationMask = null;
    state.local.exposureAmount = 0.3;
    state.local.saturationAmount = 0.3;
    syncLocalAmount();
  }

  function resetHeal() {
    state.heal.strokes = [];
    state.heal.source = null;
  }

  function resetLocalAndHeal() {
    resetLocal();
    resetHeal();
  }

  function resetText() {
    state.text.layers = [];
    state.text.activeId = null;
    renderTextLayerList();
  }

  function resetAllEdits() {
    resetGeometry();
    resetAdjustments();
    state.filter = 'none';
    updateFilterUI();
    resetLocalAndHeal();
    resetText();
    defaultCrop();
    state.history.undo = [];
    state.history.redo = [];
    syncLocalAmount();
    scheduleRender();
  }

  function syncLocalAmount() {
    if (localMode.value === 'exposure') {
      localAmount.value = state.local.exposureAmount;
    } else {
      localAmount.value = state.local.saturationAmount;
    }
  }

  function pushHistory() {
    if (!state.image) return;
    const snapshot = serializeState();
    const snapshotStr = JSON.stringify(snapshot.meta);
    if (snapshotStr === lastSnapshot) return;
    lastSnapshot = snapshotStr;
    state.history.undo.push(snapshot);
    if (state.history.undo.length > 30) {
      state.history.undo.shift();
    }
    state.history.redo = [];
  }

  function serializeState() {
    const exposureMask = state.local.exposureMask ? state.local.exposureMask.toDataURL() : null;
    const saturationMask = state.local.saturationMask ? state.local.saturationMask.toDataURL() : null;
    return {
      meta: {
        crop: { ...state.crop },
        transforms: {
          rotate: state.transforms.rotate,
          straighten: state.transforms.straighten,
          flipX: state.transforms.flipX,
          flipY: state.transforms.flipY,
          perspectivePoints: state.transforms.perspectivePoints.map((p) => ({ ...p })),
          perspectiveManual: state.transforms.perspectiveManual,
        },
        adjustments: { ...state.adjustments },
        filter: state.filter,
        local: {
          exposureMask,
          saturationMask,
          exposureAmount: state.local.exposureAmount,
          saturationAmount: state.local.saturationAmount,
        },
        heal: {
          strokes: state.heal.strokes.map((s) => ({
            source: { ...s.source },
            start: { ...s.start },
            points: s.points.map((p) => ({ ...p })),
            size: s.size,
            opacity: s.opacity,
          })),
        },
        text: {
          layers: state.text.layers.map((layer) => ({ ...layer })),
          activeId: state.text.activeId,
        },
      },
    };
  }

  async function restoreState(snapshot) {
    if (!snapshot) return;
    const data = snapshot.meta;
    state.crop = { ...data.crop };
    state.transforms.rotate = data.transforms.rotate;
    state.transforms.straighten = data.transforms.straighten;
    state.transforms.flipX = data.transforms.flipX;
    state.transforms.flipY = data.transforms.flipY;
    state.transforms.perspectivePoints = data.transforms.perspectivePoints.map((p) => ({ ...p }));
    state.transforms.perspectiveManual = data.transforms.perspectiveManual;
    state.adjustments = { ...data.adjustments };
    state.filter = data.filter;
    state.heal.strokes = data.heal.strokes.map((s) => ({
      source: { ...s.source },
      start: { ...s.start },
      points: s.points.map((p) => ({ ...p })),
      size: s.size,
      opacity: s.opacity,
    }));
    state.text.layers = data.text.layers.map((l) => ({ ...l }));
    state.text.activeId = data.text.activeId;

    updateSliderValues();
    updateFilterUI();
    updateGeometryUI();
    renderTextLayerList();

    await loadMaskFromDataUrl(data.local.exposureMask, 'exposureMask');
    await loadMaskFromDataUrl(data.local.saturationMask, 'saturationMask');
    state.local.exposureAmount = data.local.exposureAmount ?? state.local.exposureAmount;
    state.local.saturationAmount = data.local.saturationAmount ?? state.local.saturationAmount;
    syncLocalAmount();

    scheduleRender();
  }

  function undo() {
    if (!state.history.undo.length) return;
    const snapshot = state.history.undo.pop();
    state.history.redo.push(serializeState());
    restoreState(snapshot);
  }

  function redo() {
    if (!state.history.redo.length) return;
    const snapshot = state.history.redo.pop();
    state.history.undo.push(serializeState());
    restoreState(snapshot);
  }

  function updateGeometryUI() {
    straightenInput.value = state.transforms.straighten.toFixed(1);
    straightenVal.textContent = `${Number(state.transforms.straighten).toFixed(1)}°`;
  }

  function getPreviewScale() {
    if (!state.image) return 1;
    const maxDim = 1600;
    const maxSide = Math.max(state.original.w, state.original.h);
    return Math.min(1, maxDim / maxSide);
  }

  function ensureMasks(width, height) {
    const maxSide = Math.max(width, height);
    const maskScale = Math.min(1, 512 / maxSide);
    state.local.maskScale = maskScale;
    const maskW = Math.max(1, Math.round(width * maskScale));
    const maskH = Math.max(1, Math.round(height * maskScale));

    if (!state.local.exposureMask) {
      state.local.exposureMask = createCanvas(maskW, maskH);
    } else if (state.local.exposureMask.width !== maskW || state.local.exposureMask.height !== maskH) {
      state.local.exposureMask = createCanvas(maskW, maskH);
    }

    if (!state.local.saturationMask) {
      state.local.saturationMask = createCanvas(maskW, maskH);
    } else if (state.local.saturationMask.width !== maskW || state.local.saturationMask.height !== maskH) {
      state.local.saturationMask = createCanvas(maskW, maskH);
    }
  }

  function loadMaskFromDataUrl(dataUrl, key) {
    return new Promise((resolve) => {
      if (!dataUrl) {
        state.local[key] = null;
        resolve();
        return;
      }
      const img = new Image();
      img.onload = () => {
        const canvas = createCanvas(img.width, img.height);
        const cctx = canvas.getContext('2d');
        cctx.drawImage(img, 0, 0);
        state.local[key] = canvas;
        resolve();
      };
      img.src = dataUrl;
    });
  }

  function getCombinedAdjustments() {
    const base = { ...state.adjustments };
    const filter = FILTERS.find((f) => f.id === state.filter);
    if (filter) {
      Object.entries(filter.adjust).forEach(([key, value]) => {
        base[key] = clamp((base[key] || 0) + value, -1.5, 1.5);
      });
    }
    return base;
  }

  function applyAdjustments(imageData, adjustments) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const exposure = adjustments.exposure || 0;
    const contrast = adjustments.contrast || 0;
    const highlights = adjustments.highlights || 0;
    const shadows = adjustments.shadows || 0;
    const saturation = adjustments.saturation || 0;
    const warmth = adjustments.warmth || 0;
    const tint = adjustments.tint || 0;
    const clarity = adjustments.clarity || 0;
    const vignette = adjustments.vignette || 0;

    const expFactor = Math.pow(2, exposure);
    const contrastFactor = 1 + contrast;

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const idx = (y * w + x) * 4;
        let r = data[idx] / 255;
        let g = data[idx + 1] / 255;
        let b = data[idx + 2] / 255;

        r *= expFactor;
        g *= expFactor;
        b *= expFactor;

        r = (r - 0.5) * contrastFactor + 0.5;
        g = (g - 0.5) * contrastFactor + 0.5;
        b = (b - 0.5) * contrastFactor + 0.5;

        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const highlightMask = clamp((lum - 0.5) * 2, 0, 1);
        const shadowMask = clamp((0.5 - lum) * 2, 0, 1);

        if (highlights !== 0) {
          const hFactor = highlights * highlightMask;
          r += hFactor * (1 - r);
          g += hFactor * (1 - g);
          b += hFactor * (1 - b);
        }

        if (shadows !== 0) {
          const sFactor = shadows * shadowMask;
          r += sFactor * (1 - r);
          g += sFactor * (1 - g);
          b += sFactor * (1 - b);
        }

        const satFactor = 1 + saturation;
        if (satFactor !== 1) {
          r = lum + (r - lum) * satFactor;
          g = lum + (g - lum) * satFactor;
          b = lum + (b - lum) * satFactor;
        }

        if (warmth !== 0) {
          r += warmth * 0.08;
          b -= warmth * 0.08;
        }

        if (tint !== 0) {
          g += tint * 0.05;
          r -= tint * 0.03;
          b -= tint * 0.03;
        }

        if (clarity !== 0) {
          const mid = 1 - Math.abs(lum - 0.5) * 2;
          const clarityFactor = 1 + clarity * mid;
          r = (r - 0.5) * clarityFactor + 0.5;
          g = (g - 0.5) * clarityFactor + 0.5;
          b = (b - 0.5) * clarityFactor + 0.5;
        }

        if (vignette !== 0) {
          const dx = (x / w - 0.5) * 2;
          const dy = (y / h - 0.5) * 2;
          const dist = Math.sqrt(dx * dx + dy * dy) / 1.414;
          const vigFactor = 1 - vignette * dist * dist;
          r *= vigFactor;
          g *= vigFactor;
          b *= vigFactor;
        }

        data[idx] = clamp(r, 0, 1) * 255;
        data[idx + 1] = clamp(g, 0, 1) * 255;
        data[idx + 2] = clamp(b, 0, 1) * 255;
      }
    }
    return imageData;
  }

  function applyLocalAdjustments(imageData, fullWidth, fullHeight) {
    const data = imageData.data;
    const maskScale = state.local.maskScale || 1;
    const exposureMask = state.local.exposureMask;
    const saturationMask = state.local.saturationMask;

    if (!exposureMask && !saturationMask) return imageData;

    const expData = exposureMask
      ? exposureMask.getContext('2d').getImageData(0, 0, exposureMask.width, exposureMask.height).data
      : null;
    const satData = saturationMask
      ? saturationMask.getContext('2d').getImageData(0, 0, saturationMask.width, saturationMask.height).data
      : null;

    const expAmount = state.local.exposureAmount;
    const satAmount = state.local.saturationAmount;

    for (let y = 0; y < fullHeight; y += 1) {
      const maskYExp = exposureMask ? Math.min(Math.floor(y * maskScale), exposureMask.height - 1) : 0;
      const maskYSat = saturationMask ? Math.min(Math.floor(y * maskScale), saturationMask.height - 1) : 0;
      for (let x = 0; x < fullWidth; x += 1) {
        const idx = (y * fullWidth + x) * 4;
        let r = data[idx] / 255;
        let g = data[idx + 1] / 255;
        let b = data[idx + 2] / 255;

        if (expData) {
          const maskX = Math.min(Math.floor(x * maskScale), exposureMask.width - 1);
          const maskIdx = (maskYExp * exposureMask.width + maskX) * 4;
          const maskValue = expData[maskIdx] / 255;
          if (maskValue > 0) {
            const factor = Math.pow(2, expAmount * maskValue);
            r *= factor;
            g *= factor;
            b *= factor;
          }
        }

        if (satData) {
          const maskX = Math.min(Math.floor(x * maskScale), saturationMask.width - 1);
          const maskIdx = (maskYSat * saturationMask.width + maskX) * 4;
          const maskValue = satData[maskIdx] / 255;
          if (maskValue > 0) {
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const satFactor = 1 + satAmount * maskValue;
            r = lum + (r - lum) * satFactor;
            g = lum + (g - lum) * satFactor;
            b = lum + (b - lum) * satFactor;
          }
        }

        data[idx] = clamp(r, 0, 1) * 255;
        data[idx + 1] = clamp(g, 0, 1) * 255;
        data[idx + 2] = clamp(b, 0, 1) * 255;
      }
    }
    return imageData;
  }

  function applyHealing(sourceCanvas, strokes) {
    if (!strokes.length) return sourceCanvas;
    const canvas = copyCanvas(sourceCanvas);
    const context = canvas.getContext('2d');

    strokes.forEach((stroke) => {
      const size = stroke.size * canvas.width;
      const radius = size / 2;
      const source = {
        x: stroke.source.x * canvas.width,
        y: stroke.source.y * canvas.height,
      };
      const start = {
        x: stroke.start.x * canvas.width,
        y: stroke.start.y * canvas.height,
      };

      stroke.points.forEach((point) => {
        const target = {
          x: point.x * canvas.width,
          y: point.y * canvas.height,
        };
        const offset = {
          x: target.x - start.x,
          y: target.y - start.y,
        };
        const srcX = source.x + offset.x;
        const srcY = source.y + offset.y;

        context.save();
        context.beginPath();
        context.arc(target.x, target.y, radius, 0, Math.PI * 2);
        context.clip();
        context.globalAlpha = stroke.opacity;
        context.drawImage(sourceCanvas, -srcX + target.x, -srcY + target.y);
        context.restore();
      });
    });

    return canvas;
  }

  function drawText(canvas) {
    if (!state.text.layers.length) return;
    const context = canvas.getContext('2d');
    state.text.bounds = [];

    state.text.layers.forEach((layer) => {
      if (!layer.text) return;
      const x = layer.x * canvas.width;
      const y = layer.y * canvas.height;
      const fontSize = layer.size * canvas.width;
      context.save();
      const alpha = Number.isFinite(layer.opacity) ? clamp(layer.opacity, 0, 1) : 1;
      context.globalAlpha = alpha;
      context.fillStyle = layer.color;
      context.font = `${layer.weight} ${fontSize}px \"DM Sans\", \"Noto Sans JP\", sans-serif`;
      context.textBaseline = 'alphabetic';
      context.textAlign = layer.align;
      context.textBaseline = 'top';
      const metrics = context.measureText(layer.text);
      const width = metrics.width;
      const height = fontSize;
      const baselineY = y;
      context.fillText(layer.text, x, baselineY);
      let left = x;
      if (layer.align === 'center') left = x - width / 2;
      if (layer.align === 'right') left = x - width;
      const top = y;
      state.text.bounds.push({
        id: layer.id,
        x: left,
        y: top,
        w: width,
        h: height,
      });
      context.restore();
    });
  }

  function computeHomography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i += 1) {
      const { x: xs, y: ys } = src[i];
      const { x: xd, y: yd } = dst[i];
      A.push([xd, yd, 1, 0, 0, 0, -xd * xs, -yd * xs]);
      b.push(xs);
      A.push([0, 0, 0, xd, yd, 1, -xd * ys, -yd * ys]);
      b.push(ys);
    }

    const n = 8;
    for (let i = 0; i < n; i += 1) {
      let maxRow = i;
      for (let k = i + 1; k < n; k += 1) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
          maxRow = k;
        }
      }
      [A[i], A[maxRow]] = [A[maxRow], A[i]];
      [b[i], b[maxRow]] = [b[maxRow], b[i]];

      const pivot = A[i][i];
      if (Math.abs(pivot) < 1e-10) continue;
      for (let j = i; j < n; j += 1) {
        A[i][j] /= pivot;
      }
      b[i] /= pivot;

      for (let k = 0; k < n; k += 1) {
        if (k === i) continue;
        const factor = A[k][i];
        for (let j = i; j < n; j += 1) {
          A[k][j] -= factor * A[i][j];
        }
        b[k] -= factor * b[i];
      }
    }

    return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
  }

  function warpPerspective(canvas, points) {
    const isDefault = points.every((p, i) =>
      Math.abs(p.x - [0, 1, 1, 0][i]) < 0.0001 && Math.abs(p.y - [0, 0, 1, 1][i]) < 0.0001
    );
    if (isDefault) return canvas;

    const w = canvas.width;
    const h = canvas.height;
    const srcCtx = canvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, w, h);
    const dstCanvas = createCanvas(w, h);
    const dstCtx = dstCanvas.getContext('2d');
    const dstData = dstCtx.createImageData(w, h);

    const srcPoints = points.map((p) => ({ x: p.x * w, y: p.y * h }));
    const dstPoints = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];

    const H = computeHomography(srcPoints, dstPoints);

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const denom = H[6] * x + H[7] * y + 1;
        const xs = (H[0] * x + H[1] * y + H[2]) / denom;
        const ys = (H[3] * x + H[4] * y + H[5]) / denom;

        const dx = Math.floor(xs);
        const dy = Math.floor(ys);
        const idx = (y * w + x) * 4;

        if (dx >= 0 && dy >= 0 && dx < w - 1 && dy < h - 1) {
          const fx = xs - dx;
          const fy = ys - dy;
          const idx00 = (dy * w + dx) * 4;
          const idx10 = idx00 + 4;
          const idx01 = idx00 + w * 4;
          const idx11 = idx01 + 4;

          for (let c = 0; c < 4; c += 1) {
            const v00 = srcData.data[idx00 + c];
            const v10 = srcData.data[idx10 + c];
            const v01 = srcData.data[idx01 + c];
            const v11 = srcData.data[idx11 + c];
            const v0 = v00 + (v10 - v00) * fx;
            const v1 = v01 + (v11 - v01) * fx;
            dstData.data[idx + c] = v0 + (v1 - v0) * fy;
          }
        } else {
          dstData.data[idx + 3] = 0;
        }
      }
    }

    dstCtx.putImageData(dstData, 0, 0);
    return dstCanvas;
  }

  function rotateFlip(canvas) {
    const rotateDeg = state.transforms.rotate + state.transforms.straighten;
    const angle = (rotateDeg * Math.PI) / 180;
    const w = canvas.width;
    const h = canvas.height;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const newW = Math.round(w * cos + h * sin);
    const newH = Math.round(w * sin + h * cos);

    const out = createCanvas(newW, newH);
    const outCtx = out.getContext('2d');
    outCtx.save();
    outCtx.translate(newW / 2, newH / 2);
    outCtx.scale(state.transforms.flipX ? -1 : 1, state.transforms.flipY ? -1 : 1);
    outCtx.rotate(angle);
    outCtx.drawImage(canvas, -w / 2, -h / 2);
    outCtx.restore();
    return out;
  }

  function cropCanvas(canvas) {
    const { x, y, w, h } = state.crop;
    const cropX = clamp(x, 0, 1) * canvas.width;
    const cropY = clamp(y, 0, 1) * canvas.height;
    const cropW = clamp(w, 0, 1) * canvas.width;
    const cropH = clamp(h, 0, 1) * canvas.height;
    const out = createCanvas(Math.max(1, Math.round(cropW)), Math.max(1, Math.round(cropH)));
    const outCtx = out.getContext('2d');
    outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    return out;
  }

  function buildPipeline(scale, options = {}) {
    const w = Math.round(state.original.w * scale);
    const h = Math.round(state.original.h * scale);
    const baseCanvas = createCanvas(w, h);
    const baseCtx = baseCanvas.getContext('2d');
    baseCtx.drawImage(state.image, 0, 0, w, h);

    const imageData = baseCtx.getImageData(0, 0, w, h);
    const adjusted = applyAdjustments(imageData, getCombinedAdjustments());
    baseCtx.putImageData(adjusted, 0, 0);

    const perspCanvas = warpPerspective(baseCanvas, state.transforms.perspectivePoints);
    const rotatedCanvas = rotateFlip(perspCanvas);

    state.fullSize = { w: rotatedCanvas.width, h: rotatedCanvas.height };
    ensureMasks(rotatedCanvas.width, rotatedCanvas.height);

    let healingCanvas = rotatedCanvas;
    if (state.heal.strokes.length) {
      healingCanvas = applyHealing(rotatedCanvas, state.heal.strokes);
    }

    const localCtx = healingCanvas.getContext('2d');
    const localData = localCtx.getImageData(0, 0, healingCanvas.width, healingCanvas.height);
    const localAdjusted = applyLocalAdjustments(localData, healingCanvas.width, healingCanvas.height);
    localCtx.putImageData(localAdjusted, 0, 0);

    drawText(healingCanvas);

    const outputCanvas = options.skipCrop ? healingCanvas : cropCanvas(healingCanvas);
    return { full: healingCanvas, output: outputCanvas };
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!state.image) {
      ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      setEmptyState(true);
      setStatus('画像が未読み込みです');
      return;
    }

    const result = buildPipeline(state.previewScale, { skipCrop: state.tool === 'crop' });
    const output = result.output;

    editorCanvas.width = output.width;
    editorCanvas.height = output.height;
    overlayCanvas.width = output.width;
    overlayCanvas.height = output.height;

    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(output, 0, 0);

    applyCanvasTransform();
    renderOverlay();

    const sizeText = `${Math.round(state.original.w)} x ${Math.round(state.original.h)}px`;
    setStatus(`${sizeText} / 表示 ${output.width} x ${output.height}px`);
    setEmptyState(false);
  }

  function applyCanvasTransform() {
    if (!state.image || !editorCanvas.width || !editorCanvas.height) return;
    const rect = canvasStage.getBoundingClientRect();
    const scale = state.zoom;
    const maxWidth = Math.max(1, rect.width - 20);
    const maxHeight = Math.max(1, rect.height - 20);
    const fitScale = Math.min(maxWidth / editorCanvas.width, maxHeight / editorCanvas.height);
    const finalScale = scale === 'fit' ? fitScale : Number(scale) || 1;

    editorCanvas.style.transform = `translate(-50%, -50%) scale(${finalScale})`;
    overlayCanvas.style.transform = `translate(-50%, -50%) scale(${finalScale})`;
  }

  function getCanvasPoint(event) {
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    return { x, y };
  }

  function toFullPoint(point) {
    const full = state.fullSize;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    return { x: point.x + cropX, y: point.y + cropY };
  }

  function toFullCoords(point) {
    const full = state.fullSize;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    return {
      x: (cropX + point.x) / full.w,
      y: (cropY + point.y) / full.h,
    };
  }

  function renderOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!state.image) return;

    if (state.tool === 'crop') {
      drawCropOverlay();
    }

    if (state.tool === 'local') {
      drawBrushOverlay();
      if (showMask.checked) drawMaskOverlay();
    }

    if (state.tool === 'heal') {
      drawBrushOverlay();
      drawHealSource();
    }

    if (state.tool === 'text') {
      drawTextOverlay();
    }
  }

  function drawCropOverlay() {
    const full = state.fullSize;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    const cropW = crop.w * full.w;
    const cropH = crop.h * full.h;

    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.clearRect(cropX, cropY, cropW, cropH);
    overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(cropX, cropY, cropW, cropH);

    const handles = getCropHandles(cropX, cropY, cropW, cropH);
    overlayCtx.fillStyle = '#fff';
    handles.forEach((h) => {
      overlayCtx.fillRect(h.x - 5, h.y - 5, 10, 10);
    });
    overlayCtx.restore();
  }

  function getCropHandles(x, y, w, h) {
    return [
      { id: 'nw', x, y },
      { id: 'ne', x: x + w, y },
      { id: 'se', x: x + w, y: y + h },
      { id: 'sw', x, y: y + h },
    ];
  }

  function drawBrushOverlay() {
    if (!overlayCanvas) return;
    const pos = pointer || { x: overlayCanvas.width / 2, y: overlayCanvas.height / 2 };
    const radius = state.tool === 'heal' ? Number(healSize.value) / 2 : Number(brushSize.value) / 2;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    overlayCtx.lineWidth = 1.5;
    overlayCtx.beginPath();
    overlayCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawHealSource() {
    if (!state.heal.source) return;
    const full = state.fullSize;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    const srcX = state.heal.source.x * full.w - cropX;
    const srcY = state.heal.source.y * full.h - cropY;

    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(255, 150, 150, 0.9)';
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.arc(srcX, srcY, 6, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawMaskOverlay() {
    const full = state.fullSize;
    const maskCanvas = localMode.value === 'exposure' ? state.local.exposureMask : state.local.saturationMask;
    if (!maskCanvas) return;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    const cropW = crop.w * full.w;
    const cropH = crop.h * full.h;
    overlayCtx.save();
    overlayCtx.globalAlpha = 0.35;
    overlayCtx.drawImage(maskCanvas, cropX * state.local.maskScale, cropY * state.local.maskScale, cropW * state.local.maskScale, cropH * state.local.maskScale, 0, 0, cropW, cropH);
    overlayCtx.restore();
  }

  function drawTextOverlay() {
    if (!state.text.bounds.length) return;
    overlayCtx.save();
    overlayCtx.setLineDash([6, 4]);
    state.text.bounds.forEach((bound) => {
      const crop = state.crop;
      const cropX = crop.x * state.fullSize.w;
      const cropY = crop.y * state.fullSize.h;
      const x = bound.x - cropX;
      const y = bound.y - cropY;
      const isActive = bound.id === state.text.activeId;
      overlayCtx.strokeStyle = isActive ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.35)';
      overlayCtx.lineWidth = isActive ? 2 : 1;
      overlayCtx.strokeRect(x, y, bound.w, bound.h);
    });
    overlayCtx.restore();
  }

  function handleCanvasPointerDown(event) {
    if (!state.image) return;
    const point = getCanvasPoint(event);
    pointer = point;

    if (state.tool === 'crop') {
      startCropDrag(point);
    }

    if (state.tool === 'local') {
      localPaint = true;
      paintLocal(point);
    }

    if (state.tool === 'heal') {
      if (event.altKey) {
        state.heal.source = toFullCoords(point);
        scheduleRender();
        return;
      }
      if (!state.heal.source) return;
      healPaint = true;
      startHealStroke(point);
    }

    if (state.tool === 'text') {
      startTextDrag(point);
    }
  }

  function handleCanvasPointerMove(event) {
    if (!state.image) return;
    const point = getCanvasPoint(event);
    pointer = point;

    if ((state.tool === 'local' || state.tool === 'heal') && !localPaint && !healPaint) {
      renderOverlay();
    }

    if (state.tool === 'crop' && cropDrag) {
      updateCropDrag(point);
    }

    if (state.tool === 'local' && localPaint) {
      paintLocal(point);
    }

    if (state.tool === 'heal' && healPaint) {
      paintHeal(point);
    }

    if (state.tool === 'text' && textDrag) {
      moveText(point);
    }
  }

  function handleCanvasPointerUp() {
    if (cropDrag) {
      cropDrag = null;
      pushHistory();
    }
    if (localPaint) {
      localPaint = false;
      pushHistory();
    }
    if (healPaint) {
      healPaint = false;
      pushHistory();
    }
    if (textDrag) {
      textDrag = null;
      pushHistory();
    }
  }

  function startCropDrag(point) {
    const full = state.fullSize;
    const crop = state.crop;
    const cropX = crop.x * full.w;
    const cropY = crop.y * full.h;
    const cropW = crop.w * full.w;
    const cropH = crop.h * full.h;
    const handles = getCropHandles(cropX, cropY, cropW, cropH);
    const handle = handles.find((h) => Math.hypot(point.x - h.x, point.y - h.y) < 12);
    const inside = point.x > cropX && point.x < cropX + cropW && point.y > cropY && point.y < cropY + cropH;

    if (handle) {
      cropDrag = {
        mode: 'resize',
        handle: handle.id,
        start: point,
        rect: { x: cropX, y: cropY, w: cropW, h: cropH },
      };
    } else if (inside) {
      cropDrag = {
        mode: 'move',
        start: point,
        rect: { x: cropX, y: cropY, w: cropW, h: cropH },
      };
    }
  }

  function updateCropDrag(point) {
    const full = state.fullSize;
    const ratioValue = cropRatio.value;
    const ratio = ratioValue === 'free' ? null : ratioValue.split(':').map(Number);
    const start = cropDrag.start;
    const rect = { ...cropDrag.rect };
    const dx = point.x - start.x;
    const dy = point.y - start.y;

    if (cropDrag.mode === 'move') {
      rect.x = clamp(rect.x + dx, 0, full.w - rect.w);
      rect.y = clamp(rect.y + dy, 0, full.h - rect.h);
    }

    if (cropDrag.mode === 'resize') {
      const handle = cropDrag.handle;
      if (handle.includes('n')) {
        rect.y = clamp(rect.y + dy, 0, rect.y + rect.h - 20);
        rect.h = rect.h - dy;
      }
      if (handle.includes('s')) {
        rect.h = clamp(rect.h + dy, 20, full.h - rect.y);
      }
      if (handle.includes('w')) {
        rect.x = clamp(rect.x + dx, 0, rect.x + rect.w - 20);
        rect.w = rect.w - dx;
      }
      if (handle.includes('e')) {
        rect.w = clamp(rect.w + dx, 20, full.w - rect.x);
      }

      if (ratio) {
        const target = ratio[0] / ratio[1];
        if (rect.w / rect.h > target) {
          rect.w = rect.h * target;
        } else {
          rect.h = rect.w / target;
        }
      }
    }

    state.crop = {
      x: rect.x / full.w,
      y: rect.y / full.h,
      w: rect.w / full.w,
      h: rect.h / full.h,
    };

    scheduleRender();
  }

  function paintLocal(point) {
    const full = state.fullSize;
    const maskScale = state.local.maskScale;
    const fullPoint = toFullCoords(point);
    const maskX = fullPoint.x * full.w * maskScale;
    const maskY = fullPoint.y * full.h * maskScale;
    const size = Number(brushSize.value) * maskScale;

    const maskCanvas = localMode.value === 'exposure' ? state.local.exposureMask : state.local.saturationMask;
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext('2d');
    const strength = Number(brushStrength.value);
    mctx.globalCompositeOperation = brushErase.checked ? 'destination-out' : 'source-over';
    mctx.fillStyle = `rgba(255, 255, 255, ${strength})`;
    mctx.beginPath();
    mctx.arc(maskX, maskY, size / 2, 0, Math.PI * 2);
    mctx.fill();
    mctx.globalCompositeOperation = 'source-over';

    scheduleRender();
  }

  function startHealStroke(point) {
    const fullPoint = toFullCoords(point);
    const size = Number(healSize.value) / state.fullSize.w;
    state.heal.strokes.push({
      source: { ...state.heal.source },
      start: { ...fullPoint },
      points: [{ ...fullPoint }],
      size,
      opacity: Number(healOpacity.value),
    });
    scheduleRender();
  }

  function paintHeal(point) {
    const fullPoint = toFullCoords(point);
    const stroke = state.heal.strokes[state.heal.strokes.length - 1];
    if (!stroke) return;
    stroke.points.push({ ...fullPoint });
    scheduleRender();
  }

  function startTextDrag(point) {
    const full = state.fullSize;
    const fullPoint = toFullPoint(point);
    const target = state.text.bounds.find((bound) => {
      return fullPoint.x >= bound.x && fullPoint.x <= bound.x + bound.w && fullPoint.y >= bound.y && fullPoint.y <= bound.y + bound.h;
    });

    if (target) {
      state.text.activeId = target.id;
      const layer = state.text.layers.find((l) => l.id === target.id);
      if (layer) {
        loadTextLayer(layer);
      }
      renderTextLayerList();
      const anchorX = layer ? layer.x * full.w : fullPoint.x;
      const anchorY = layer ? layer.y * full.h : fullPoint.y;
      textDrag = {
        id: target.id,
        offsetX: fullPoint.x - anchorX,
        offsetY: fullPoint.y - anchorY,
      };
    }
  }

  function moveText(point) {
    if (!textDrag) return;
    const layer = state.text.layers.find((l) => l.id === textDrag.id);
    if (!layer) return;

    const full = state.fullSize;
    const fullPoint = toFullPoint(point);

    const newX = (fullPoint.x - textDrag.offsetX) / full.w;
    const newY = (fullPoint.y - textDrag.offsetY) / full.h;

    layer.x = clamp(newX, 0, 1);
    layer.y = clamp(newY, 0, 1);

    scheduleRender();
  }

  function renderTextLayerList() {
    textLayerList.innerHTML = '';
    state.text.layers.forEach((layer) => {
      const item = document.createElement('div');
      item.className = 'layer-item';
      item.textContent = layer.text || 'テキスト';
      item.classList.toggle('active', layer.id === state.text.activeId);
      item.addEventListener('click', () => {
        state.text.activeId = layer.id;
        loadTextLayer(layer);
        renderTextLayerList();
        scheduleRender();
      });
      textLayerList.appendChild(item);
    });
  }

  function loadTextLayer(layer) {
    textInput.value = layer.text;
    textSize.value = Math.round(layer.size * state.fullSize.w);
    textColor.value = layer.color;
    textOpacity.value = Number.isFinite(layer.opacity) ? layer.opacity : 1;
    textWeight.value = layer.weight;
  }

  function addTextLayer() {
    const id = `text-${Date.now()}`;
    const sizePx = Number(textSize.value);
    const size = sizePx / (state.fullSize.w || 1);
    const opacityValue = Number(textOpacity.value);
    const opacity = Number.isFinite(opacityValue) ? clamp(opacityValue, 0.2, 1) : 1;
    const layer = {
      id,
      text: textInput.value || 'テキスト',
      x: 0.5,
      y: 0.5,
      size,
      color: textColor.value,
      opacity,
      weight: textWeight.value,
      align: 'center',
    };
    state.text.layers.push(layer);
    state.text.activeId = id;
    renderTextLayerList();
    scheduleRender();
    pushHistory();
  }

  function updateActiveText() {
    const layer = state.text.layers.find((l) => l.id === state.text.activeId);
    if (!layer) return;
    layer.text = textInput.value;
    layer.size = Number(textSize.value) / (state.fullSize.w || 1);
    layer.color = textColor.value;
    layer.opacity = Number(textOpacity.value);
    layer.weight = textWeight.value;
    scheduleRender();
  }

  function removeActiveText() {
    if (!state.text.activeId) return;
    state.text.layers = state.text.layers.filter((l) => l.id !== state.text.activeId);
    state.text.activeId = null;
    renderTextLayerList();
    scheduleRender();
    pushHistory();
  }

  function updatePerspectivePreview() {
    if (!state.image) {
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      return;
    }
    const width = previewCanvas.clientWidth;
    const height = previewCanvas.clientHeight;
    previewCanvas.width = width;
    previewCanvas.height = height;

    previewCtx.clearRect(0, 0, width, height);
    previewCtx.drawImage(state.image, 0, 0, width, height);

    const points = state.transforms.perspectivePoints;
    previewCtx.save();
    previewCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    previewCtx.lineWidth = 2;
    previewCtx.beginPath();
    previewCtx.moveTo(points[0].x * width, points[0].y * height);
    points.forEach((p, i) => {
      if (i === 0) return;
      previewCtx.lineTo(p.x * width, p.y * height);
    });
    previewCtx.closePath();
    previewCtx.stroke();

    previewCtx.fillStyle = '#fff';
    points.forEach((p) => {
      previewCtx.fillRect(p.x * width - 5, p.y * height - 5, 10, 10);
    });
    previewCtx.restore();
  }

  function handlePreviewPointerDown(event) {
    if (!state.image) return;
    const rect = previewCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const points = state.transforms.perspectivePoints;
    const index = points.findIndex((p) => Math.hypot(p.x - x, p.y - y) < 0.05);
    if (index >= 0) {
      previewDrag = { index };
    }
  }

  function handlePreviewPointerMove(event) {
    if (!previewDrag) return;
    const rect = previewCanvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    state.transforms.perspectivePoints[previewDrag.index] = { x, y };
    state.transforms.perspectiveManual = true;
    updatePerspectivePreview();
    scheduleRender();
  }

  function handlePreviewPointerUp() {
    if (previewDrag) {
      previewDrag = null;
      pushHistory();
    }
  }

  function handleCropApply() {
    pushHistory();
    setTool(lastNonCropTool);
    scheduleRender();
  }

  function loadImageFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.original = { w: img.width, h: img.height };
        state.previewScale = getPreviewScale();
        state.zoom = 'fit';
        resetAllEdits();
        updatePerspectivePreview();
        scheduleRender();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function loadSampleImage() {
    const sampleCanvas = createCanvas(800, 520);
    const sctx = sampleCanvas.getContext('2d');
    const gradient = sctx.createLinearGradient(0, 0, 800, 520);
    gradient.addColorStop(0, '#0ea5e9');
    gradient.addColorStop(1, '#f97316');
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, sampleCanvas.width, sampleCanvas.height);

    sctx.fillStyle = 'rgba(255,255,255,0.8)';
    sctx.fillRect(60, 60, 280, 200);
    sctx.fillRect(380, 200, 320, 240);

    sctx.fillStyle = '#0f172a';
    sctx.font = '700 36px \"DM Sans\", \"Noto Sans JP\", sans-serif';
    sctx.fillText('MyApps Image Studio', 80, 110);
    sctx.font = '400 20px \"DM Sans\", \"Noto Sans JP\", sans-serif';
    sctx.fillText('Sample Canvas', 80, 150);

    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.original = { w: img.width, h: img.height };
      state.previewScale = getPreviewScale();
      state.zoom = 'fit';
      resetAllEdits();
      updatePerspectivePreview();
      scheduleRender();
    };
    img.src = sampleCanvas.toDataURL();
  }

  function exportImage() {
    if (!state.image) return;
    const scale = exportSize.value === 'original' ? 1 : state.previewScale;
    const result = buildPipeline(scale);
    const output = result.output;
    const format = exportFormat.value;

    const exportCanvas = createCanvas(output.width, output.height);
    const exCtx = exportCanvas.getContext('2d');
    if (format !== 'image/png') {
      exCtx.fillStyle = exportBg.value;
      exCtx.fillRect(0, 0, output.width, output.height);
    }
    exCtx.drawImage(output, 0, 0);

    const quality = Number(exportQuality.value);
    exportCanvas.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `myapps-edit.${format.split('/')[1]}`;
        link.click();
        URL.revokeObjectURL(url);
      },
      format,
      quality
    );
  }

  function handleDrop(event) {
    event.preventDefault();
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      loadImageFromFile(event.dataTransfer.files[0]);
    }
  }

  function handleDragOver(event) {
    event.preventDefault();
  }

  function applyPerspectiveSliders() {
    if (state.transforms.perspectiveManual) return;
    const x = Number(perspectiveX.value);
    const y = Number(perspectiveY.value);
    const left = clamp(0 + Math.max(0, x), 0, 0.4);
    const right = clamp(1 + Math.min(0, x), 0.6, 1);
    const top = clamp(0 + Math.max(0, y), 0, 0.4);
    const bottom = clamp(1 + Math.min(0, y), 0.6, 1);

    state.transforms.perspectivePoints = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    updatePerspectivePreview();
    scheduleRender();
  }

  function initEvents() {
    toolButtons.forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (file) loadImageFromFile(file);
    });

    btnSample.addEventListener('click', loadSampleImage);
    btnRevert.addEventListener('click', () => {
      resetAllEdits();
      pushHistory();
    });

    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);

    btnFit.addEventListener('click', () => {
      state.zoom = 'fit';
      applyCanvasTransform();
    });

    btnActual.addEventListener('click', () => {
      state.zoom = 1;
      applyCanvasTransform();
    });

    btnRotateLeft.addEventListener('click', () => {
      state.transforms.rotate -= 90;
      resetLocalAndHeal();
      scheduleRender();
      pushHistory();
    });

    btnRotateRight.addEventListener('click', () => {
      state.transforms.rotate += 90;
      resetLocalAndHeal();
      scheduleRender();
      pushHistory();
    });

    btnFlipX.addEventListener('click', () => {
      state.transforms.flipX = !state.transforms.flipX;
      resetLocalAndHeal();
      scheduleRender();
      pushHistory();
    });

    btnFlipY.addEventListener('click', () => {
      state.transforms.flipY = !state.transforms.flipY;
      resetLocalAndHeal();
      scheduleRender();
      pushHistory();
    });

    straightenInput.addEventListener('input', () => {
      state.transforms.straighten = Number(straightenInput.value);
      straightenVal.textContent = `${state.transforms.straighten.toFixed(1)}°`;
      scheduleRender();
    });

    straightenInput.addEventListener('change', pushHistory);

    perspectiveX.addEventListener('input', () => {
      state.transforms.perspectiveManual = false;
      applyPerspectiveSliders();
    });

    perspectiveY.addEventListener('input', () => {
      state.transforms.perspectiveManual = false;
      applyPerspectiveSliders();
    });

    btnResetGeometry.addEventListener('click', resetGeometry);

    cropRatio.addEventListener('change', () => {
      scheduleRender();
    });

    btnApplyCrop.addEventListener('click', handleCropApply);
    btnResetCrop.addEventListener('click', () => {
      defaultCrop();
      scheduleRender();
      pushHistory();
    });

    btnResetAdjust.addEventListener('click', resetAdjustments);

    localMode.addEventListener('change', () => {
      syncLocalAmount();
      renderOverlay();
    });
    localAmount.addEventListener('input', () => {
      if (localMode.value === 'exposure') {
        state.local.exposureAmount = Number(localAmount.value);
      } else {
        state.local.saturationAmount = Number(localAmount.value);
      }
      scheduleRender();
    });
    brushSize.addEventListener('input', scheduleRender);
    brushStrength.addEventListener('input', scheduleRender);
    brushErase.addEventListener('change', scheduleRender);
    showMask.addEventListener('change', scheduleRender);
    btnClearLocal.addEventListener('click', () => {
      resetLocal();
      scheduleRender();
      pushHistory();
    });

    healSize.addEventListener('input', scheduleRender);
    healOpacity.addEventListener('input', scheduleRender);
    btnClearHeal.addEventListener('click', () => {
      resetHeal();
      scheduleRender();
      pushHistory();
    });

    textInput.addEventListener('input', updateActiveText);
    textSize.addEventListener('input', updateActiveText);
    textColor.addEventListener('input', updateActiveText);
    textOpacity.addEventListener('input', updateActiveText);
    textWeight.addEventListener('change', updateActiveText);
    btnAddText.addEventListener('click', addTextLayer);
    btnRemoveText.addEventListener('click', removeActiveText);

    btnExport.addEventListener('click', exportImage);

    overlayCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
    overlayCanvas.addEventListener('pointermove', handleCanvasPointerMove);
    overlayCanvas.addEventListener('pointerup', handleCanvasPointerUp);
    overlayCanvas.addEventListener('pointerleave', handleCanvasPointerUp);

    previewCanvas.addEventListener('pointerdown', handlePreviewPointerDown);
    previewCanvas.addEventListener('pointermove', handlePreviewPointerMove);
    previewCanvas.addEventListener('pointerup', handlePreviewPointerUp);
    previewCanvas.addEventListener('pointerleave', handlePreviewPointerUp);

    canvasArea.addEventListener('dragover', handleDragOver);
    canvasArea.addEventListener('drop', handleDrop);

    window.addEventListener('resize', () => {
      applyCanvasTransform();
      updatePerspectivePreview();
    });
  }

  initSliders();
  initFilters();
  initEvents();
  syncLocalAmount();
  setTool('geometry');
  setEmptyState(true);
  updatePerspectivePreview();
})();
