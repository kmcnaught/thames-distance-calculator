// Strip view — vertical 1D projection of a corridor with sensible waymarks.
// Used by both the river app (waymarks anchored by along_m) and the path
// app (anchored by path_mi), via the distanceM accessor option.
//
// Owns just the DOM inside #tab-strip. Everything else — the map, the data
// fetch, unit toggle — is passed in via the init options so this module can be
// swapped or rendered standalone without pulling in Leaflet.

const M_PER_MILE = 1609.344;
const KIND_ICON = {
  town: '●',
  village: '○',
  hamlet: '·',
  lock: '⏸',
  bridge: '═',
  landmark: '△',
};

// Single-char glyphs rendered inline next to each waymark name.
const AMENITY_GLYPH = { pub: '🍺', cafe: '☕', shop: '🛒', camping: '⛺', toilets: '🚻', boat_hire: '🛶' };
const TRANSPORT_GLYPH = { rail: '🚂', bus: '🚌', tube: 'Ⓤ', ferry: '⛴' };

export function initStrip({
  container,      // the tab panel root
  waymarks,       // array from mergeWaymarks()
  totalM,         // full length of the corridor in metres
  distanceM = (w) => w.along_m,  // which field anchors a waymark to the strip
  corridorNoun = 'river',        // used in ARIA text ("position on river/trail")
  onFocus,        // (latlng) => void — called when a waymark is tapped
}) {
  const viewport = container.querySelector('#strip-viewport');
  const waymarkLayer = container.querySelector('#strip-waymarks');
  const cursorEl = container.querySelector('#strip-cursor');
  const cursorLabel = cursorEl.querySelector('.strip-cursor-label');
  const scaleEl = container.querySelector('#strip-scale');
  const scaleOut = container.querySelector('#strip-scale-out');

  // Viewport state (in metres along the corridor).
  const state = {
    scaleMi: parseFloat(scaleEl.value),
    // Centre of the viewport, in metres. Seeded at mid-corridor.
    centreM: totalM / 2,
    cursorM: totalM / 2,
  };

  function rangeM() { return state.scaleMi * M_PER_MILE; }
  function startM() { return Math.max(0, state.centreM - rangeM() / 2); }
  function endM()   { return Math.min(totalM, state.centreM + rangeM() / 2); }

  function viewportHeight() { return viewport.clientHeight; }
  function pxPerM() { return viewportHeight() / rangeM(); }
  function alongMToY(m) { return (m - startM()) * pxPerM(); }
  function yToAlongM(y) { return startM() + y / pxPerM(); }

  function render() {
    scaleOut.textContent = `${state.scaleMi} mi in view`;
    renderTicks();
    renderWaymarks();
    renderCursor();
  }

  function renderTicks() {
    // Wipe old ticks; keep the axis pseudo-elements alone by removing tick divs only.
    for (const t of viewport.querySelectorAll('.strip-tick, .strip-tick-label')) t.remove();
    // Ticks are anchored to the cursor and labelled as signed offsets from it.
    // "72.6 mi from the arbitrary OSM Thames start" means nothing to a
    // user — "+5 mi downstream / −3 mi upstream from you" does.
    const c = state.cursorM;
    const s = startM(), e = endM();
    const labelEvery = state.scaleMi <= 10 ? 1 : 2;
    const startOffset = Math.ceil((s - c) / M_PER_MILE);
    const endOffset = Math.floor((e - c) / M_PER_MILE);
    for (let off = startOffset; off <= endOffset; off++) {
      const alongM = c + off * M_PER_MILE;
      if (alongM < 0 || alongM > totalM) continue;
      const y = alongMToY(alongM);
      const tick = document.createElement('div');
      tick.className = 'strip-tick';
      tick.style.top = y + 'px';
      viewport.appendChild(tick);
      if (off % labelEvery === 0) {
        const lab = document.createElement('div');
        lab.className = 'strip-tick-label';
        lab.style.top = y + 'px';
        lab.textContent = off === 0 ? '0' : (off > 0 ? '+' : '−') + Math.abs(off);
        viewport.appendChild(lab);
      }
    }
  }

  function selectVisibleWaymarks() {
    const s = startM(), e = endM();
    const visible = waymarks.filter((w) => distanceM(w) >= s && distanceM(w) <= e);
    // Two-pass min-gap selection: locks always in, then majors, then minors.
    // Gap thresholds in pixels; convert to metres via current pxPerM.
    const majorGapPx = 26;
    const minorGapPx = 18;
    const p = pxPerM();
    const kept = [];
    function farEnough(w, gapPx) {
      const gapM = gapPx / p;
      return kept.every((k) => Math.abs(distanceM(k) - distanceM(w)) >= gapM);
    }
    for (const w of visible) if (w.kind === 'lock') kept.push(w);
    for (const w of visible) if (w.kind !== 'lock' && w.tier === 'major' && farEnough(w, majorGapPx)) kept.push(w);
    for (const w of visible) if (w.kind !== 'lock' && w.tier === 'minor' && farEnough(w, minorGapPx)) kept.push(w);
    kept.sort((a, b) => distanceM(a) - distanceM(b));
    return kept;
  }

  function amenityBadges(w) {
    const parts = [];
    if (w.transport) {
      for (const t of w.transport) {
        const g = TRANSPORT_GLYPH[t.kind];
        if (g) parts.push(g);
      }
    }
    if (w.amenities) {
      for (const [k, v] of Object.entries(w.amenities)) {
        if (v && AMENITY_GLYPH[k]) parts.push(AMENITY_GLYPH[k]);
      }
    }
    return parts.join(' ');
  }

  function renderWaymarks() {
    waymarkLayer.innerHTML = '';
    const list = selectVisibleWaymarks();
    for (const w of list) {
      const el = document.createElement('div');
      el.className = `strip-waymark ${w.tier}`;
      el.style.top = alongMToY(distanceM(w)) + 'px';
      el.dataset.id = w.id;
      const bank = w.side && (w.side === 'L' || w.side === 'R')
        ? `<span class="badge bank-${w.side}" title="${w.side === 'L' ? 'Left bank' : 'Right bank'} looking downstream">${w.side}</span>`
        : '';
      const badges = amenityBadges(w);
      el.innerHTML =
        `<span class="kind-icon" aria-hidden="true">${KIND_ICON[w.kind] || '•'}</span>` +
        `<span class="name">${escapeHtml(w.name)}</span>` +
        (badges ? `<span class="badge">${badges}</span>` : '') +
        bank;
      el.addEventListener('click', () => {
        state.cursorM = clamp(distanceM(w), 0, totalM);
        renderTicks();
        renderCursor();
        if (onFocus) onFocus([w.lat, w.lng]);
      });
      waymarkLayer.appendChild(el);
    }
  }

  function renderCursor() {
    const y = alongMToY(state.cursorM);
    cursorEl.style.top = y + 'px';
    const mi = (state.cursorM / M_PER_MILE).toFixed(1);
    cursorLabel.textContent = `${mi} mi`;
    cursorEl.setAttribute('aria-valuenow', mi);
    cursorEl.setAttribute('aria-valuetext', `${mi} miles along ${corridorNoun}`);
  }

  // Pan the viewport if the cursor would otherwise sit outside (or flush
  // against) the visible range — keeps the focus ring on screen when the
  // keyboard moves the cursor past the current window. Short-corridor case:
  // when the whole corridor fits in view the centre is fixed, so skip the pan.
  function ensureCursorVisible() {
    if (totalM <= rangeM()) return;
    const pad = rangeM() * 0.1;
    const halfR = rangeM() / 2;
    const minCentre = halfR;
    const maxCentre = totalM - halfR;
    if (state.cursorM < startM() + pad) {
      state.centreM = clamp(state.cursorM + halfR - pad, minCentre, maxCentre);
    } else if (state.cursorM > endM() - pad) {
      state.centreM = clamp(state.cursorM - halfR + pad, minCentre, maxCentre);
    }
  }

  // --- interactions ---

  scaleEl.addEventListener('input', () => {
    state.scaleMi = parseFloat(scaleEl.value);
    render();
  });

  // Pan the viewport by dragging on empty space.
  let panning = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.strip-waymark') || e.target === cursorEl || cursorEl.contains(e.target)) return;
    panning = { startY: e.clientY, startCentre: state.centreM };
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!panning) return;
    if (totalM <= rangeM()) return;  // whole corridor fits — nothing to pan
    const dy = e.clientY - panning.startY;
    const dm = -dy / pxPerM();  // dragging down pans upstream (view shows lower along_m)
    state.centreM = clamp(panning.startCentre + dm, rangeM() / 2, totalM - rangeM() / 2);
    render();
  });
  viewport.addEventListener('pointerup', () => { panning = null; });
  viewport.addEventListener('pointercancel', () => { panning = null; });

  // Drag the cursor.
  let cursorDrag = null;
  cursorEl.addEventListener('pointerdown', (e) => {
    cursorDrag = true;
    cursorEl.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  cursorEl.addEventListener('pointermove', (e) => {
    if (!cursorDrag) return;
    const rect = viewport.getBoundingClientRect();
    const y = e.clientY - rect.top;
    state.cursorM = clamp(yToAlongM(y), 0, totalM);
    // Re-render ticks — their labels are cursor-relative, so they must shift
    // when the cursor moves. Waymarks are position-only, no need to re-render.
    renderTicks();
    renderCursor();
  });
  cursorEl.addEventListener('pointerup', () => { cursorDrag = false; });
  cursorEl.addEventListener('pointercancel', () => { cursorDrag = false; });

  // Keyboard support for the slider. Arrow keys step ~0.1 mi (small nudge
  // ≈ 160 m), Page keys step 1 mi, Home/End jump to the ends. Vertical
  // orientation: Down = downstream (increasing distance from source).
  const STEP_SMALL_M = 0.1 * M_PER_MILE;
  const STEP_LARGE_M = M_PER_MILE;
  cursorEl.setAttribute('aria-valuemax', (totalM / M_PER_MILE).toFixed(1));
  cursorEl.addEventListener('keydown', (e) => {
    let next = state.cursorM;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': next += STEP_SMALL_M; break;
      case 'ArrowUp':
      case 'ArrowLeft':  next -= STEP_SMALL_M; break;
      case 'PageDown':   next += STEP_LARGE_M; break;
      case 'PageUp':     next -= STEP_LARGE_M; break;
      case 'Home':       next = 0; break;
      case 'End':        next = totalM; break;
      default: return;
    }
    e.preventDefault();
    state.cursorM = clamp(next, 0, totalM);
    ensureCursorVisible();
    render();
  });

  // Ensure a first render happens once the tab is visible (offsetHeight is 0
  // for hidden panels, so pxPerM would divide by zero — defer until shown).
  const observer = new ResizeObserver(() => {
    if (viewport.clientHeight > 0) render();
  });
  observer.observe(viewport);

  render();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
