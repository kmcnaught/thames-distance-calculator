// Interactive viewer for the Thames Path colouring poster.
//
// - Inlines poster.svg into the DOM
// - Clicking a ribbon segment cycles its data-fill through "" → "a" → "b" → "both"
// - Ribbon colours and text labels are user-configurable and persisted in localStorage
// - Download Segment → writes an SVG with current fills baked into <path> attributes
//   (so the standalone file colours correctly when printed from anywhere)

const STORAGE_KEY = 'thames-poster-state-v3';

// Which SVG groups each layer checkbox controls.
const LAYER_GROUPS = {
  'hills': ['hills', 'hill-labels'],
  'tributaries': ['tributaries', 'tributary-labels'],
  'canals': ['canals'],
  'town-areas': ['town-areas'],
  'off-town-areas': ['off-town-areas'],
  'counties': ['counties', 'county-labels'],
  'lock-labels': ['lock-labels'],
};

const els = {
  host: document.getElementById('poster-host'),
  colourA: document.getElementById('colour-a'),
  colourB: document.getElementById('colour-b'),
  swatchA: document.getElementById('swatch-a'),
  swatchB: document.getElementById('swatch-b'),
  labelA: document.getElementById('label-a'),
  labelB: document.getElementById('label-b'),
  download: document.getElementById('btn-download'),
  print: document.getElementById('btn-print'),
  exportLabels: document.getElementById('btn-export-labels'),
  reset: document.getElementById('btn-reset'),
};

let svgEl = null;
let styleEl = null;
let state = loadState();

async function main() {
  const res = await fetch('poster.svg', { cache: 'no-store' });
  const text = await res.text();
  els.host.innerHTML = text;
  svgEl = els.host.querySelector('svg');
  styleEl = svgEl.querySelector('style');

  applyColoursToSvg();
  applyFillsFromState();
  applyLayersFromState();
  applyLabelOverridesFromState();
  wireSegmentClicks();
  wireControls();
  wireLayerToggles();
  wireLabelDrag();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, fills: parsed.fills || {} };
  } catch {
    return defaultState();
  }
}
function defaultState() {
  return {
    colourA: '#c04b3a',
    colourB: '#2d6b8c',
    labelA: '',
    labelB: '',
    fills: {},
    layers: Object.fromEntries(Object.keys(LAYER_GROUPS).map((k) => [k, true])),
    labelOverrides: {},
  };
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyColoursToSvg() {
  els.colourA.value = state.colourA;
  els.colourB.value = state.colourB;
  els.labelA.value = state.labelA;
  els.labelB.value = state.labelB;
  els.swatchA.style.background = state.colourA;
  els.swatchB.style.background = state.colourB;

  // Rewrite the SVG's halfband stroke colours by patching the inline <style>.
  // This keeps everything CSS-selector-based inside the SVG so the downloaded
  // file behaves identically to what's on screen.
  if (!styleEl) return;
  const baseCss = styleEl.dataset.baseCss || styleEl.textContent;
  styleEl.dataset.baseCss = baseCss;
  const overrides = `
    .halfband[data-fill="on"][data-side="a"] { stroke: ${state.colourA}; }
    .halfband[data-fill="on"][data-side="b"] { stroke: ${state.colourB}; }
  `;
  styleEl.textContent = baseCss + '\n' + overrides;
}

function applyLayersFromState() {
  for (const [key, groupIds] of Object.entries(LAYER_GROUPS)) {
    const on = state.layers[key] !== false;
    const cb = document.querySelector(`#layers input[data-layer="${key}"]`);
    if (cb) cb.checked = on;
    for (const gid of groupIds) {
      const g = svgEl.getElementById(gid);
      if (g) g.style.display = on ? '' : 'none';
    }
  }
}

function applyLabelOverridesFromState() {
  for (const [id, pos] of Object.entries(state.labelOverrides || {})) {
    const el = svgEl.querySelector(`[data-label-id="${cssEscape(id)}"]`);
    if (el) {
      el.setAttribute('x', pos[0]);
      el.setAttribute('y', pos[1]);
    }
  }
}

function cssEscape(s) {
  return s.replace(/["\\]/g, '\\$&');
}

function screenToSvg(evt) {
  const pt = svgEl.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

function wireLabelDrag() {
  let drag = null;
  svgEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-label-id]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const start = screenToSvg(e);
    drag = {
      el,
      id: el.dataset.labelId,
      startMouse: start,
      startX: parseFloat(el.getAttribute('x')),
      startY: parseFloat(el.getAttribute('y')),
    };
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const cur = screenToSvg(e);
    const newX = drag.startX + (cur.x - drag.startMouse.x);
    const newY = drag.startY + (cur.y - drag.startMouse.y);
    drag.el.setAttribute('x', newX.toFixed(2));
    drag.el.setAttribute('y', newY.toFixed(2));
  });
  const finish = (e) => {
    if (!drag) return;
    const x = parseFloat(drag.el.getAttribute('x'));
    const y = parseFloat(drag.el.getAttribute('y'));
    state.labelOverrides[drag.id] = [x, y];
    saveState();
    drag.el.classList.remove('dragging');
    try { drag.el.releasePointerCapture(e.pointerId); } catch {}
    drag = null;
  };
  svgEl.addEventListener('pointerup', finish);
  svgEl.addEventListener('pointercancel', finish);
}

function wireLayerToggles() {
  document.querySelectorAll('#layers input[data-layer]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.layer;
      state.layers[key] = cb.checked;
      saveState();
      for (const gid of LAYER_GROUPS[key]) {
        const g = svgEl.getElementById(gid);
        if (g) g.style.display = cb.checked ? '' : 'none';
      }
    });
  });
}

function applyFillsFromState() {
  const paths = svgEl.querySelectorAll('.halfband');
  paths.forEach((p) => {
    const key = p.dataset.side + ':' + p.dataset.seg;
    p.setAttribute('data-fill', state.fills[key] ? 'on' : '');
  });
}

function wireSegmentClicks() {
  svgEl.addEventListener('click', (e) => {
    const p = e.target.closest('.halfband');
    if (!p) return;
    const key = p.dataset.side + ':' + p.dataset.seg;
    const on = (p.getAttribute('data-fill') || '') === 'on';
    if (on) {
      p.setAttribute('data-fill', '');
      delete state.fills[key];
    } else {
      p.setAttribute('data-fill', 'on');
      state.fills[key] = true;
    }
    saveState();
  });
}

function wireControls() {
  els.colourA.addEventListener('input', () => {
    state.colourA = els.colourA.value;
    saveState();
    applyColoursToSvg();
  });
  els.colourB.addEventListener('input', () => {
    state.colourB = els.colourB.value;
    saveState();
    applyColoursToSvg();
  });
  els.labelA.addEventListener('input', () => {
    state.labelA = els.labelA.value;
    saveState();
  });
  els.labelB.addEventListener('input', () => {
    state.labelB = els.labelB.value;
    saveState();
  });
  els.download.addEventListener('click', downloadSvg);
  els.print.addEventListener('click', () => window.print());
  els.exportLabels.addEventListener('click', exportLabelOverrides);
  els.reset.addEventListener('click', () => {
    if (!confirm('Clear colouring, colours, layers and label tweaks?')) return;
    state = defaultState();
    saveState();
    // Reload so the SVG reverts to its baked positions.
    location.reload();
  });
}

function exportLabelOverrides() {
  const overrides = state.labelOverrides || {};
  const json = JSON.stringify(overrides, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'label-overrides.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadSvg() {
  // Clone so we don't perturb the on-screen DOM.
  const clone = svgEl.cloneNode(true);
  // Write current colour overrides into the clone's <style> so the file is
  // self-contained.
  const cloneStyle = clone.querySelector('style');
  if (cloneStyle && styleEl) cloneStyle.textContent = styleEl.textContent;
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'thames-poster.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Perceptual midpoint of two hex colours in linear-ish RGB.
function blend(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const mix = a.map((v, i) => Math.round((v + b[i]) / 2));
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const s = hex.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

main();
