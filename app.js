// Thameswise — non-tidal Thames on-river distance calculator.
// Map-first single-page app. Click two spots, see channel-following distance,
// iterate. URL state (?a=lat,lng&b=lat,lng) is the share format.

import { snap, measure, reachPts, haversine } from './lib/geo.mjs';

const M_PER_MILE = 1609.344;
const D2R = Math.PI / 180;

const UNITS = {
  mi: { perM: 1 / M_PER_MILE, label: 'mi' },
  km: { perM: 1 / 1000, label: 'km' },
};

// [min, max, step, defaultValue] in each unit. The form rebuilds these when the
// user toggles units so the slider always operates in the displayed unit.
const SLIDER_RANGES = {
  findTarget: { mi: [3, 25, 0.5, 8],   km: [5, 40, 0.5, 13] },
  findTol:    { mi: [0, 5, 0.5, 1.5],  km: [0, 8, 0.5, 2.5] },
  findWalk:   { mi: [0, 2, 0.1, 0.6],  km: [0, 3, 0.25, 1.0] },
};

const OVERLAY_PALETTE = [
  '#e11d48', '#7c3aed', '#0891b2', '#ea580c',
  '#16a34a', '#9333ea', '#ca8a04', '#0ea5e9',
];

// Marker styles for bridges + extras (piers/quays/weirs/ferry terminals).
const EXTRA_STYLE = {
  bridge:         { color: '#7c2d12', fill: '#fdba74', radius: 5, weight: 2,   label: 'Bridge' },
  pier:           { color: '#a16207', fill: '#fbbf24', radius: 4, weight: 1.5, label: 'Pier' },
  quay:           { color: '#a16207', fill: '#ffffff', radius: 4, weight: 1.5, label: 'Quay' },
  ferry_terminal: { color: '#6b21a8', fill: '#c084fc', radius: 5, weight: 2,   label: 'Ferry terminal' },
  weir:           { color: '#991b1b', fill: '#fca5a5', radius: 4, weight: 1.5, label: 'Weir (hazard)' },
};

const els = {
  hint: document.getElementById('hint'),
  readout: document.getElementById('readout'),
  distPrimary: document.getElementById('dist-primary'),
  distPrimaryUnit: document.getElementById('dist-primary-unit'),
  distSecondary: document.getElementById('dist-secondary'),
  distStraight: document.getElementById('dist-straight'),
  sinuosity: document.getElementById('sinuosity'),
  warn: document.getElementById('offset-warn'),
  nextSlot: document.getElementById('next-slot-label'),
  btnSwap: document.getElementById('btn-swap'),
  btnClear: document.getElementById('btn-clear'),
  btnShare: document.getElementById('btn-share'),
  unitsKm: document.getElementById('units-km'),
  panel: document.getElementById('panel'),
  panelToggle: document.getElementById('panel-toggle'),
  toast: document.getElementById('toast'),
  tabs: document.querySelectorAll('.tab'),
  tabPanels: { measure: document.getElementById('tab-measure'), find: document.getElementById('tab-find') },
  findTarget: document.getElementById('find-target'),
  findTol: document.getElementById('find-tol'),
  findWalk: document.getElementById('find-walk'),
  findNeedCamp: document.getElementById('find-need-camp'),
  findNeedPark: document.getElementById('find-need-park'),
  findDistOut: document.getElementById('find-dist-out'),
  findWalkOut: document.getElementById('find-walk-out'),
  btnFind: document.getElementById('btn-find'),
  findResults: document.getElementById('find-results'),
  findSummary: document.getElementById('find-summary'),
};

const state = {
  thames: null,           // { coords, cum, meta }
  launches: null,         // { launches: [...], meta }
  campsites: null,        // { campsites: [...], meta }
  parking: null,          // { parkings: [...], meta }
  bridges: null,          // { bridges: [...], meta }
  extras: null,           // { extras: [...], meta }  piers/quays/weirs/ferry
  sandfordM: null,        // along_m of Sandford-on-Thames Lock (= "Oxford")
  putIns: [],             // unified put-in list across sources, sorted by along_m
  pins: { A: null, B: null }, // [lat, lng]
  next: 'A',
  layers: {
    markers: { A: null, B: null },
    snapLines: { A: null, B: null },
    reach: null,
    centreline: null,
    launches: null,       // L.layerGroup
    bridges: null,        // L.layerGroup
    extras: null,         // L.layerGroup
    findOverlay: null,    // L.layerGroup of route ribbons
  },
};

function activeUnit() { return els.unitsKm?.checked ? 'km' : 'mi'; }
function altUnit()    { return activeUnit() === 'mi' ? 'km' : 'mi'; }
function inUnit(m, u = activeUnit()) { return m * UNITS[u].perM; }
function fmtDist(m, dec = 2, u = activeUnit()) {
  return inUnit(m, u).toFixed(dec) + ' ' + UNITS[u].label;
}

// A launch counts as a "put-in" if at least one parking lot is nearby
// (parking proximity is our road-access proxy until we ingest road data).
// Put-ins are styled at full strength; landmark-only locks/slipways are muted.
const LAUNCH_STYLE = {
  lock_putin:        { color: '#0b3a5c', fill: '#ffffff', radius: 6, weight: 2, label: 'Lock · put-in' },
  lock_landmark:     { color: '#94a3b8', fill: '#ffffff', radius: 5, weight: 1, label: 'Lock · no parking found' },
  slipway_putin:     { color: '#0e7c66', fill: '#0e7c66', radius: 4, weight: 1, label: 'Slipway · put-in' },
  slipway_landmark:  { color: '#cbd5e1', fill: '#cbd5e1', radius: 3, weight: 1, label: 'Slipway · no parking found' },
};

const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
  doubleClickZoom: false,
}).setView([51.5, -0.9], 9);

L.control.zoom({ position: 'topright' }).addTo(map);

const baseStreets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '',
});
const baseSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution: 'Imagery © Esri',
  }
);
baseStreets.addTo(map);
const layerControl = L.control.layers(
  { Streets: baseStreets, Satellite: baseSatellite },
  {},
  { position: 'topright', collapsed: true }
).addTo(map);

// Auto-fall-back on tile error (handoff §6).
baseStreets.on('tileerror', () => {
  if (map.hasLayer(baseStreets)) {
    map.removeLayer(baseStreets);
    baseSatellite.addTo(map);
  }
});

function pinIcon(letter, color) {
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="color:${color}">
             <svg viewBox="0 0 28 36">
               <path d="M14 1c7 0 13 6 13 13 0 9-13 22-13 22S1 23 1 14C1 7 7 1 14 1z" fill="${color}" />
             </svg>
             <span class="pin-letter">${letter}</span>
           </div>`,
    iconSize: [28, 36],
    iconAnchor: [14, 34],
  });
}

const PIN_COLOR = { A: '#0b3a5c', B: '#c45c3f' };

map.on('dblclick', (e) => {
  setPin(state.next, [e.latlng.lat, e.latlng.lng]);
});

function setPin(slot, latlng) {
  state.pins[slot] = latlng;
  drawPin(slot);
  // Auto-advance only fills empty slots: A → B once. After both pins exist,
  // state.next is sticky so further double-clicks keep refining the same pin
  // (the "anchor + scout" model). The user flips slots by clicking the
  // next-pin chip or by clicking an existing pin on the map.
  if (state.pins.A == null) state.next = 'A';
  else if (state.pins.B == null) state.next = 'B';
  syncNextSlotUI();
  refresh();
}

function syncNextSlotUI() {
  els.nextSlot.textContent = state.next;
  els.nextSlot.classList.toggle('pin-a', state.next === 'A');
  els.nextSlot.classList.toggle('pin-b', state.next === 'B');
}

function drawPin(slot) {
  const layers = state.layers.markers;
  const latlng = state.pins[slot];
  if (layers[slot]) {
    layers[slot].setLatLng(latlng);
  } else {
    layers[slot] = L.marker(latlng, {
      icon: pinIcon(slot, PIN_COLOR[slot]),
      draggable: true,
      autoPan: true,
    }).addTo(map);
    layers[slot].on('drag', () => {
      state.pins[slot] = [layers[slot].getLatLng().lat, layers[slot].getLatLng().lng];
      refresh();
    });
    // Single-clicking a pin makes it the next-to-move target. Lets the user
    // iterate on a chosen anchor without having to drag.
    layers[slot].on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      state.next = slot;
      syncNextSlotUI();
    });
  }
}

function clearPin(slot) {
  state.pins[slot] = null;
  if (state.layers.markers[slot]) {
    map.removeLayer(state.layers.markers[slot]);
    state.layers.markers[slot] = null;
  }
  if (state.layers.snapLines[slot]) {
    map.removeLayer(state.layers.snapLines[slot]);
    state.layers.snapLines[slot] = null;
  }
}

function refresh() {
  const { A, B } = state.pins;
  const hasA = !!A, hasB = !!B;
  els.btnClear.disabled = !hasA && !hasB;
  els.btnSwap.disabled = !(hasA && hasB);
  els.btnShare.disabled = !(hasA && hasB);

  // Snap lines
  for (const slot of ['A', 'B']) {
    if (state.layers.snapLines[slot]) {
      map.removeLayer(state.layers.snapLines[slot]);
      state.layers.snapLines[slot] = null;
    }
    if (state.pins[slot] && state.thames) {
      const s = snap(state.thames.coords, state.thames.cum, state.pins[slot]);
      state.layers.snapLines[slot] = L.polyline([state.pins[slot], s.latlng], {
        color: PIN_COLOR[slot],
        weight: 1.5,
        opacity: 0.55,
        dashArray: '3 5',
      }).addTo(map);
    }
  }

  // Reach
  if (state.layers.reach) { map.removeLayer(state.layers.reach); state.layers.reach = null; }

  if (!hasA && !hasB) {
    els.hint.hidden = false;
    els.hint.textContent = 'Double-tap the map to drop pin A.';
    els.readout.hidden = true;
  } else if (hasA && !hasB) {
    els.hint.hidden = false;
    els.hint.textContent = 'Double-tap the map to drop pin B.';
    els.readout.hidden = true;
  } else if (hasB && !hasA) {
    els.hint.hidden = false;
    els.hint.textContent = 'Double-tap the map to drop pin A.';
    els.readout.hidden = true;
  } else {
    els.hint.hidden = true;
    els.readout.hidden = false;
    const m = measure(state.thames.coords, state.thames.cum, A, B);
    const u = activeUnit(), au = altUnit();
    els.distPrimary.textContent = inUnit(m.river, u).toFixed(2);
    els.distPrimaryUnit.textContent = UNITS[u].label + ' on the river';
    els.distSecondary.textContent = fmtDist(m.river, 2, au);
    els.distStraight.textContent = fmtDist(m.straight, 2, u) + ' straight';
    els.sinuosity.textContent = 'sinuosity ' + m.sinuosity.toFixed(2);
    const warnings = [];
    if (m.a.off > 500) warnings.push(`A is ${fmtDist(m.a.off, 2)} from the river`);
    if (m.b.off > 500) warnings.push(`B is ${fmtDist(m.b.off, 2)} from the river`);
    if (warnings.length) {
      els.warn.hidden = false;
      els.warn.textContent = warnings.join(' · ');
    } else {
      els.warn.hidden = true;
    }
    state.layers.reach = L.polyline(reachPts(state.thames.coords, m.a, m.b), {
      color: '#0b3a5c',
      weight: 5,
      opacity: 0.78,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  }

  updateUrl();
}

function updateUrl() {
  const params = new URLSearchParams();
  const fmt = ([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (state.pins.A) params.set('a', fmt(state.pins.A));
  if (state.pins.B) params.set('b', fmt(state.pins.B));
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, '', url);
}

function parseUrl() {
  const params = new URLSearchParams(location.search);
  const parse = (s) => {
    if (!s) return null;
    const [lat, lng] = s.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  };
  const A = parse(params.get('a'));
  const B = parse(params.get('b'));
  if (A) setPin('A', A);
  if (B) setPin('B', B);
  if (A && B) {
    map.fitBounds([A, B], { padding: [60, 60] });
  } else if (A || B) {
    map.setView(A || B, 14);
  }
}

// Buttons
els.btnSwap.addEventListener('click', () => {
  const a = state.pins.A, b = state.pins.B;
  clearPin('A'); clearPin('B');
  if (b) setPin('A', b);
  if (a) setPin('B', a);
});
els.btnClear.addEventListener('click', () => {
  clearPin('A'); clearPin('B');
  clearFindOverlay();
  state.next = 'A';
  els.nextSlot.textContent = 'A';
  els.nextSlot.classList.add('pin-a');
  els.nextSlot.classList.remove('pin-b');
  refresh();
});
els.btnShare.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied to clipboard');
  } catch {
    toast(location.href);
  }
});
els.panelToggle.addEventListener('click', () => {
  els.panel.classList.toggle('collapsed');
  els.panel.classList.toggle('expanded');
});

els.nextSlot.addEventListener('click', () => {
  state.next = state.next === 'A' ? 'B' : 'A';
  syncNextSlotUI();
});

// Tab switching
for (const tab of els.tabs) {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    for (const t of els.tabs) {
      const active = t.dataset.tab === which;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const [k, panel] of Object.entries(els.tabPanels)) panel.hidden = k !== which;
  });
}

// Trip-finder filter UI
function applySliderRanges(preserveMeters = true) {
  const u = activeUnit();
  for (const [key, ranges] of Object.entries(SLIDER_RANGES)) {
    const [min, max, step, def] = ranges[u];
    const el = els[key];
    const prevUnit = el.dataset.unit;
    let val = def;
    if (preserveMeters && prevUnit === u) {
      val = parseFloat(el.value);
    } else if (preserveMeters && prevUnit && prevUnit !== u) {
      const meters = parseFloat(el.value) / UNITS[prevUnit].perM;
      val = meters * UNITS[u].perM;
    }
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(Math.max(min, Math.min(max, val)));
    el.dataset.unit = u;
  }
}

function updateFindLabels() {
  const u = activeUnit();
  const lbl = UNITS[u].label;
  const target = parseFloat(els.findTarget.value);
  const tol = parseFloat(els.findTol.value);
  els.findDistOut.textContent = `${target} ${lbl} ± ${tol} ${lbl}`;
  els.findWalkOut.textContent = `${parseFloat(els.findWalk.value).toFixed(u === 'mi' ? 1 : 2)} ${lbl}`;
}
els.findTarget.addEventListener('input', updateFindLabels);
els.findTol.addEventListener('input', updateFindLabels);
els.findWalk.addEventListener('input', updateFindLabels);
els.findNeedCamp.addEventListener('change', () => {
  els.findWalk.disabled = !els.findNeedCamp.checked;
});

els.unitsKm.addEventListener('change', () => {
  try { localStorage.setItem('thameswise.unitsKm', els.unitsKm.checked ? '1' : '0'); } catch {}
  applySliderRanges(true);
  updateFindLabels();
  refresh();
});

els.btnFind.addEventListener('click', runFinder);

function runFinder() {
  if (!state.thames || !state.putIns.length) {
    els.findSummary.textContent = 'Data not loaded yet.';
    return;
  }
  const u = activeUnit();
  const factor = UNITS[u].perM; // perM converts metres → display unit
  const target = parseFloat(els.findTarget.value);
  const tol = parseFloat(els.findTol.value);
  const walk = parseFloat(els.findWalk.value);
  const needCamp = els.findNeedCamp.checked;
  const needPark = els.findNeedPark.checked;

  const minM = (target - tol) / factor;
  const maxM = (target + tol) / factor;
  const walkM = walk / factor;

  const putIns = state.putIns;
  const campsites = state.campsites?.campsites || [];

  const results = [];
  for (let i = 0; i < putIns.length; i++) {
    const A = putIns[i];
    if (needPark && A.parkingCount === 0) continue;
    for (let j = i + 1; j < putIns.length; j++) {
      const B = putIns[j];
      const d = B.along_m - A.along_m;
      if (d < minM) continue;
      if (d > maxM) break;
      let nearestCamp = null;
      if (needCamp) {
        let bestD = Infinity;
        for (const c of campsites) {
          const cd = haversineApprox(c.snap_lat, c.snap_lng, B.snap_lat, B.snap_lng);
          if (cd < bestD) { bestD = cd; nearestCamp = { camp: c, dist_m: cd }; }
        }
        if (!nearestCamp || nearestCamp.dist_m > walkM) continue;
      }
      results.push({
        a: i,
        b: j,
        dist_m: d,
        camp: nearestCamp,
        parkingCount: A.parkingCount,
      });
    }
  }
  // Sort: prefer closest-campsite among matching trips, then shortest trip
  results.sort((r1, r2) => {
    const c1 = r1.camp?.dist_m ?? Infinity;
    const c2 = r2.camp?.dist_m ?? Infinity;
    if (c1 !== c2) return c1 - c2;
    return r1.dist_m - r2.dist_m;
  });

  renderFinderResults(results);
}

function haversineApprox(lat1, lng1, lat2, lng2) {
  // Small-distance equirectangular approximation, plenty for campsite-walking.
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

function fromOxfordTxt(alongM) {
  if (state.sandfordM == null) return '';
  const delta = alongM - state.sandfordM;
  if (Math.abs(delta) < 50) return 'at Oxford';
  const dir = delta > 0 ? 'downstream' : 'upstream';
  return `${fmtDist(Math.abs(delta), 1)} ${dir} of Oxford`;
}

function putInDisplayName(p) {
  return p.name || `${p.label} at ${fmtDist(p.along_m, 1)}`;
}

function renderFinderResults(results) {
  els.findResults.innerHTML = '';
  clearFindOverlay();
  if (results.length === 0) {
    els.findSummary.textContent = 'No matches. Try widening the distance range or the campsite radius.';
    return;
  }
  const shown = results.slice(0, 40);
  els.findSummary.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} (sorted by closest campsite). Showing top ${Math.min(shown.length, 8)} on the map.`;
  drawFindOverlay(shown.slice(0, 8));
  shown.forEach((r, idx) => {
    const A = state.putIns[r.a], B = state.putIns[r.b];
    const li = document.createElement('li');
    const aName = putInDisplayName(A);
    const bName = putInDisplayName(B);
    const distTxt = fmtDist(r.dist_m, 1);
    const campTxt = r.camp ? `<span class="badge ok">⛺ ${fmtDist(r.camp.dist_m, 2)}</span>` : '';
    const parkTxt = r.parkingCount ? `<span class="badge ok">🅿 ${r.parkingCount}</span>` : '';
    const colour = idx < 8 ? OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length] : '#94a3b8';
    const swatch = idx < 8 ? `<span class="route-swatch" style="background:${colour}">${idx + 1}</span>` : '';
    const oxA = fromOxfordTxt(A.along_m);
    const oxLine = oxA ? `<div class="result-meta">put-in ${oxA}</div>` : '';
    li.innerHTML = `
      <div class="result-pair">${swatch}${escapeHtml(aName)} → ${escapeHtml(bName)}</div>
      <div class="result-meta">${distTxt}${r.camp ? ` · campsite ${escapeHtml(r.camp.camp.name || 'unnamed')}` : ''}${campTxt}${parkTxt}</div>
      ${oxLine}
    `;
    li.addEventListener('click', () => {
      clearPin('A'); clearPin('B');
      setPin('A', [A.snap_lat, A.snap_lng]);
      setPin('B', [B.snap_lat, B.snap_lng]);
      map.fitBounds([[A.snap_lat, A.snap_lng], [B.snap_lat, B.snap_lng]], { padding: [40, 40] });
      // Switch back to Measure tab so user sees the readout
      document.querySelector('.tab[data-tab="measure"]').click();
    });
    els.findResults.appendChild(li);
  });
}

// Find the lat/lng on the centreline at a given along-distance (metres from source).
function pointAtAlong(coords, cum, alongM) {
  let lo = 0, hi = cum.length - 1;
  if (alongM <= cum[0]) return { i: 0, latlng: coords[0].slice() };
  if (alongM >= cum[hi]) return { i: hi - 1, latlng: coords[hi].slice() };
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] < alongM) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (alongM - cum[i]) / segLen : 0;
  const A = coords[i], B = coords[i + 1];
  return { i, latlng: [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])] };
}

function reachByAlong(coords, cum, fromM, toM) {
  const [lo, hi] = fromM <= toM ? [fromM, toM] : [toM, fromM];
  const a = pointAtAlong(coords, cum, lo);
  const b = pointAtAlong(coords, cum, hi);
  const pts = [a.latlng];
  for (let k = a.i + 1; k <= b.i; k++) pts.push(coords[k]);
  pts.push(b.latlng);
  return pts;
}

// Shift a polyline perpendicular to its local tangent by `offsetM` metres.
// Positive offset = left of the direction of travel (CCW perpendicular).
function offsetPolyline(pts, offsetM) {
  if (!offsetM || pts.length < 2) return pts.map(p => p.slice());
  const out = new Array(pts.length);
  const mLat = 111320;
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i];
    const mLng = 111320 * Math.cos(cur[0] * D2R);
    let dx = 0, dy = 0;
    if (i > 0) {
      dx += (cur[1] - pts[i - 1][1]) * mLng;
      dy += (cur[0] - pts[i - 1][0]) * mLat;
    }
    if (i < pts.length - 1) {
      dx += (pts[i + 1][1] - cur[1]) * mLng;
      dy += (pts[i + 1][0] - cur[0]) * mLat;
    }
    const len = Math.hypot(dx, dy);
    if (len === 0) { out[i] = cur.slice(); continue; }
    const px = -dy / len, py = dx / len; // perpendicular (CCW)
    out[i] = [cur[0] + py * offsetM / mLat, cur[1] + px * offsetM / mLng];
  }
  return out;
}

function clearFindOverlay() {
  if (state.layers.findOverlay) {
    map.removeLayer(state.layers.findOverlay);
    state.layers.findOverlay = null;
  }
}

function drawFindOverlay(items) {
  clearFindOverlay();
  if (!items.length || !state.thames) return;
  const coords = state.thames.coords;
  const cum = state.thames.cum;
  const group = L.layerGroup();
  const n = items.length;
  // Spread offsets symmetrically around the centreline; ~14 m per slot keeps
  // ribbons distinguishable on the centreline render without exploding visually.
  items.forEach((r, idx) => {
    const A = state.putIns[r.a], B = state.putIns[r.b];
    const colour = OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length];
    const offsetM = (idx - (n - 1) / 2) * 14;
    const pts = offsetPolyline(reachByAlong(coords, cum, A.along_m, B.along_m), offsetM);
    const line = L.polyline(pts, {
      color: colour,
      weight: 4,
      opacity: 0.78,
      lineCap: 'round',
      lineJoin: 'round',
    });
    line.bindTooltip(`Route ${idx + 1} · ${fmtDist(r.dist_m, 1)}`, { sticky: true });
    group.addLayer(line);
    // numbered chip at the put-in
    const chip = L.marker([A.snap_lat, A.snap_lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="route-chip" style="background:${colour}">${idx + 1}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      interactive: false,
    });
    group.addLayer(chip);
  });
  state.layers.findOverlay = group;
  group.addTo(map);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1).replace('_', '-'); }

// Restore unit preference, then size sliders to that unit's defaults.
try {
  els.unitsKm.checked = localStorage.getItem('thameswise.unitsKm') === '1';
} catch {}
applySliderRanges(false);
updateFindLabels();

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2200);
}

function renderLaunches() {
  if (!state.launches) return;
  // SVG renderer so launches stay interactive at the DOM level (testable,
  // inspectable). The big centreline polyline still uses canvas via the map's
  // preferCanvas default.
  const renderer = L.svg();
  const group = L.layerGroup();
  let putInCount = 0;
  state.launches.launches.forEach((l, i) => {
    const isPutIn = state.putInIdx?.has(i);
    if (isPutIn) putInCount++;
    const styleKey = `${l.type}_${isPutIn ? 'putin' : 'landmark'}`;
    const style = LAUNCH_STYLE[styleKey] || LAUNCH_STYLE.slipway_landmark;
    const labelTitle = l.name || `${cap(l.type)} at ${fmtDist(l.along_m, 1)}`;
    const subline = isPutIn ? style.label : `${style.label} (landmark only)`;
    const marker = L.circleMarker([l.snap_lat, l.snap_lng], {
      radius: style.radius,
      color: style.color,
      fillColor: style.fill,
      fillOpacity: isPutIn ? 0.9 : 0.55,
      weight: style.weight,
      renderer,
    });
    marker.bindTooltip(`<b>${escapeHtml(labelTitle)}</b><br>${subline}<br>${fmtDist(l.along_m, 1)} from source`, {
      direction: 'top',
      offset: [0, -2],
    });
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      setPin(state.next, [l.snap_lat, l.snap_lng]);
    });
    group.addLayer(marker);
  });
  state.layers.launches = group;
  group.addTo(map);
  layerControl.addOverlay(group, `Launches (${putInCount} put-in / ${state.launches.launches.length} total)`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderBridges() {
  if (!state.bridges) return;
  const renderer = L.svg();
  const group = L.layerGroup();
  for (const b of state.bridges.bridges) {
    const style = EXTRA_STYLE.bridge;
    const marker = L.circleMarker([b.snap_lat, b.snap_lng], {
      color: style.color,
      fillColor: style.fill,
      radius: style.radius,
      weight: style.weight,
      fillOpacity: 0.9,
      renderer,
    });
    const label = b.name || (b.ref ? `${b.ref} bridge` : `Bridge (${b.highway})`);
    marker.bindTooltip(`<b>${escapeHtml(label)}</b><br>${style.label} · put-in<br>${fmtDist(b.along_m, 1)} from source`, {
      direction: 'top',
      offset: [0, -2],
    });
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      setPin(state.next, [b.snap_lat, b.snap_lng]);
    });
    group.addLayer(marker);
  }
  state.layers.bridges = group;
  group.addTo(map);
  layerControl.addOverlay(group, `Bridges (${state.bridges.bridges.length})`);
}

function renderExtras() {
  if (!state.extras) return;
  const renderer = L.svg();
  const group = L.layerGroup();
  for (const e of state.extras.extras) {
    const style = EXTRA_STYLE[e.category];
    if (!style) continue;
    const marker = L.circleMarker([e.snap_lat, e.snap_lng], {
      color: style.color,
      fillColor: style.fill,
      radius: style.radius,
      weight: style.weight,
      fillOpacity: 0.85,
      renderer,
    });
    const label = e.name || style.label;
    const role = e.role === 'put_in' ? 'put-in' : 'landmark · hazard';
    marker.bindTooltip(`<b>${escapeHtml(label)}</b><br>${style.label} · ${role}<br>${fmtDist(e.along_m, 1)} from source`, {
      direction: 'top',
      offset: [0, -2],
    });
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      // Weirs are hazards; we still allow clicking to set a pin since the user
      // may be using one as a measure reference, but the trip finder won't use
      // them (role !== put_in).
      setPin(state.next, [e.snap_lat, e.snap_lng]);
    });
    group.addLayer(marker);
  }
  state.layers.extras = group;
  group.addTo(map);
  layerControl.addOverlay(group, `Piers · quays · weirs · ferries (${state.extras.extras.length})`);
}

// Build the unified put-in list across all sources, sorted by along_m.
// runFinder enumerates A/B pairs from this list.
function buildPutIns() {
  const list = [];
  if (state.launches) {
    state.launches.launches.forEach((l, idx) => {
      if (!state.putInIdx?.has(idx)) return;
      const parkingCount = state.parking
        ? state.parking.parkings.reduce((acc, p) => acc + (p.near_launch === idx ? 1 : 0), 0)
        : 0;
      list.push({
        snap_lat: l.snap_lat,
        snap_lng: l.snap_lng,
        along_m: l.along_m,
        name: l.name,
        source: l.type,                // 'lock' | 'slipway'
        label: cap(l.type),
        parkingCount,
      });
    });
  }
  if (state.bridges) {
    for (const b of state.bridges.bridges) {
      list.push({
        snap_lat: b.snap_lat,
        snap_lng: b.snap_lng,
        along_m: b.along_m,
        name: b.name || (b.ref ? `${b.ref} bridge` : null),
        source: 'bridge',
        label: 'Bridge',
        parkingCount: 0,
      });
    }
  }
  if (state.extras) {
    for (const e of state.extras.extras) {
      if (e.role !== 'put_in') continue;
      list.push({
        snap_lat: e.snap_lat,
        snap_lng: e.snap_lng,
        along_m: e.along_m,
        name: e.name,
        source: e.category,            // 'pier' | 'quay' | 'ferry_terminal'
        label: e.category === 'ferry_terminal' ? 'Ferry terminal' : cap(e.category),
        parkingCount: 0,
      });
    }
  }
  list.sort((a, b) => a.along_m - b.along_m);
  state.putIns = list;
}

// Boot
(async () => {
  const [thamesRes, launchesRes, campsitesRes, parkingRes, bridgesRes, extrasRes] = await Promise.all([
    fetch('./data/thames.json'),
    fetch('./data/launches.json').catch(() => null),
    fetch('./data/campsites.json').catch(() => null),
    fetch('./data/parking.json').catch(() => null),
    fetch('./data/bridges.json').catch(() => null),
    fetch('./data/extras.json').catch(() => null),
  ]);
  state.thames = await thamesRes.json();
  // Render the centreline subtly so the user sees the navigable channel.
  state.layers.centreline = L.polyline(state.thames.coords, {
    color: '#0b3a5c',
    weight: 2,
    opacity: 0.4,
  }).addTo(map);
  map.fitBounds(state.layers.centreline.getBounds(), { padding: [40, 40] });

  if (launchesRes && launchesRes.ok) {
    state.launches = await launchesRes.json();
    const sandford = state.launches.launches.find(l => l.name === 'Sandford Lock');
    if (sandford) state.sandfordM = sandford.along_m;
    renderLaunches();
  }
  if (campsitesRes && campsitesRes.ok) state.campsites = await campsitesRes.json();
  if (parkingRes && parkingRes.ok) state.parking = await parkingRes.json();
  if (bridgesRes && bridgesRes.ok) state.bridges = await bridgesRes.json();
  if (extrasRes && extrasRes.ok) state.extras = await extrasRes.json();

  // Build the put-in index: launches with at least one parking nearby. Used
  // both for find-trips filtering and to mute landmark-only launches on the map.
  state.putInIdx = new Set();
  if (state.parking) {
    for (const p of state.parking.parkings) state.putInIdx.add(p.near_launch);
  }
  if (state.launches) {
    // Re-render now that putInIdx is populated (launches were drawn before).
    if (state.layers.launches) {
      map.removeLayer(state.layers.launches);
      layerControl.removeLayer(state.layers.launches);
      state.layers.launches = null;
    }
    renderLaunches();
  }
  renderBridges();
  renderExtras();
  buildPutIns();

  parseUrl();
})();
