// Thameswise — non-tidal Thames on-river distance calculator.
// Map-first single-page app. Click two spots, see channel-following distance,
// iterate. URL state (?a=lat,lng&b=lat,lng) is the share format.

import { snap, haversine } from './lib/geo.mjs';
import { mergeWaymarks } from './lib/waymarks.mjs';
import { initStrip } from './strip.js';

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
  // Distance from Oxford to the nearer of the trip's two ends. Max is large
  // enough to act as "no limit" in practice (the navigable Thames is ~140 mi).
  findOxford: { mi: [0, 80, 1,   15],  km: [0, 130, 1, 25] },
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

// Hide piers/quays/weirs/ferries that sit within this along-river distance of a
// lock or slipway — at that range they're redundant hints for a put-in that's
// already represented. Raw data in extras.json is untouched; tweak this constant
// to tighten/loosen the filter.
const EXTRA_SUPPRESS_RADIUS_M = 0.25 * M_PER_MILE;

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
  tabPanels: {
    measure: document.getElementById('tab-measure'),
    find:    document.getElementById('tab-find'),
    strip:   document.getElementById('tab-strip'),
  },
  findTarget: document.getElementById('find-target'),
  findTol: document.getElementById('find-tol'),
  findWalk: document.getElementById('find-walk'),
  findOxford: document.getElementById('find-oxford'),
  findOxfordSide: document.getElementById('find-oxford-side'),
  findNeedCamp: document.getElementById('find-need-camp'),
  findNeedPark: document.getElementById('find-need-park'),
  findDistOut: document.getElementById('find-dist-out'),
  findWalkOut: document.getElementById('find-walk-out'),
  findOxfordOut: document.getElementById('find-oxford-out'),
  btnFind: document.getElementById('btn-find'),
  findResults: document.getElementById('find-results'),
  findSummary: document.getElementById('find-summary'),
};

const state = {
  thames: null,           // { coords, cum, meta }
  waterways: [],          // [{ name, short_name, kind, coords, cum, length_m }]  Thames + tributaries
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
    tributaries: null,    // L.layerGroup of tributary polylines
    launches: null,       // L.layerGroup
    bridges: null,        // L.layerGroup
    extras: null,         // L.layerGroup
    findOverlay: null,    // L.layerGroup of route ribbons
    stripFocus: null,     // L.circleMarker from the last strip-waymark tap
  },
};

// Snap a target to the nearest waterway. Returns { ww, snap }. Thames gets a
// small distance bias (-15 m) so a point that's a near-tie between the Thames
// and a tributary close to its confluence prefers the Thames — matches the
// expectation that the measure tool is primarily a Thames tool.
function snapAny(target) {
  let best = null;
  for (const ww of state.waterways) {
    const s = snap(ww.coords, ww.cum, target);
    const bias = ww.kind === 'thames' ? -15 : 0;
    const score = s.off + bias;
    if (!best || score < best.score) best = { ww, snap: s, score };
  }
  return best;
}

function thamesWaterway() {
  return state.waterways.find((w) => w.kind === 'thames');
}

// Route a measurement between two snapped pins through the Thames if they're
// on different waterways. Assumes tree topology: each tributary joins the
// Thames at exactly one confluence (stored at build time as
// `confluence_thames_along_m`). Tributary polylines are oriented so the LAST
// vertex is the confluence end — so a pin's distance to its confluence is
// `length_m - snap.along`. Returns { river, straight, legs, path } where
// `legs` describes the three (or fewer) components and `path` is the latlng
// polyline for drawing the reach.
function measureAcross(a, b) {
  // Interpolate a latlng on a line at a given cumulative-distance along_m.
  const interpAlong = (ww, alongM) => {
    const cum = ww.cum, coords = ww.coords;
    if (alongM <= 0) return coords[0].slice();
    if (alongM >= cum[cum.length - 1]) return coords[cum.length - 1].slice();
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= alongM) lo = mid; else hi = mid;
    }
    const t = (alongM - cum[lo]) / (cum[hi] - cum[lo]);
    return [coords[lo][0] + t * (coords[hi][0] - coords[lo][0]),
            coords[lo][1] + t * (coords[hi][1] - coords[lo][1])];
  };
  // Slice a polyline between two along_m values, returning the latlngs in
  // low-to-high order (reverse at the call site if needed).
  const sliceBetween = (ww, fromM, toM) => {
    const [lo, hi] = fromM <= toM ? [fromM, toM] : [toM, fromM];
    const pts = [interpAlong(ww, lo)];
    for (let i = 0; i < ww.cum.length; i++) {
      if (ww.cum[i] > lo && ww.cum[i] < hi) pts.push(ww.coords[i].slice());
    }
    pts.push(interpAlong(ww, hi));
    return pts;
  };

  const sameWaterway = a.ww === b.ww;
  const straight = haversine(a.snap.latlng, b.snap.latlng);

  if (sameWaterway) {
    const river = Math.abs(a.snap.along - b.snap.along);
    const path = sliceBetween(a.ww, a.snap.along, b.snap.along);
    return { river, straight, legs: [{ ww: a.ww, meters: river }], path };
  }

  // Cross-waterway: compose via the Thames. Every tributary carries a baked
  // `confluence_thames_along_m` from the build pipeline.
  const thames = thamesWaterway();
  if (!thames) return null;
  const alongOnThames = (side) =>
    side.ww.kind === 'thames' ? side.snap.along : side.ww.confluence_thames_along_m;
  const toConfluence = (side) =>
    side.ww.kind === 'thames' ? 0 : side.ww.length_m - side.snap.along;

  const legA_m = toConfluence(a);
  const legB_m = toConfluence(b);
  const thamesFrom = alongOnThames(a);
  const thamesTo = alongOnThames(b);
  // Normal case: both pins project to distinct Thames alongs, so the Thames
  // leg is the Thames arc between them. Edge case: when two tributaries share
  // a confluence coord (K&A and Kennet both bake Reading as confluence) but
  // their polyline ends are physically apart (K&A ends at Newbury), fall back
  // to the straight-line gap between the polyline ends — otherwise we'd
  // undercount by that gap distance.
  let thamesLeg_m = Math.abs(thamesFrom - thamesTo);
  if (thamesLeg_m < 100 && a.ww.kind !== 'thames' && b.ww.kind !== 'thames') {
    const endA = a.ww.coords[a.ww.coords.length - 1];
    const endB = b.ww.coords[b.ww.coords.length - 1];
    thamesLeg_m = haversine(endA, endB);
  }
  const river = legA_m + thamesLeg_m + legB_m;

  // Build the drawn path: pin A → confluence A (on tributary), confluence A
  // snapped onto Thames → confluence B (on Thames), confluence B snapped onto
  // Thames → pin B (on tributary). Each tributary segment runs from the
  // pin's snap along_m to the end of its polyline (the confluence end).
  const path = [];
  if (a.ww.kind !== 'thames') {
    const seg = sliceBetween(a.ww, a.snap.along, a.ww.length_m);
    path.push(...seg);
  } else {
    path.push(a.snap.latlng.slice());
  }
  if (thamesLeg_m > 0) {
    const seg = sliceBetween(thames, thamesFrom, thamesTo);
    // sliceBetween returned low→high; flip if we're travelling high→low so the
    // drawn line matches the direction of travel from A to B.
    if (thamesFrom > thamesTo) seg.reverse();
    path.push(...seg);
  }
  if (b.ww.kind !== 'thames') {
    const seg = sliceBetween(b.ww, b.snap.along, b.ww.length_m);
    // seg runs from snap→confluence end; we need confluence→snap for the
    // B-side so the path's direction continues A→Thames→B.
    seg.reverse();
    path.push(...seg);
  } else {
    path.push(b.snap.latlng.slice());
  }

  const legs = [];
  if (a.ww.kind !== 'thames') legs.push({ ww: a.ww, meters: legA_m });
  if (thamesLeg_m > 0) legs.push({ ww: thames, meters: thamesLeg_m });
  if (b.ww.kind !== 'thames') legs.push({ ww: b.ww, meters: legB_m });

  return { river, straight, legs, path };
}

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
// Separate pane so Esri place-name tiles render above satellite imagery
// (z-index 400) but below markers/popups (600+).
map.createPane('labelsPane');
map.getPane('labelsPane').style.zIndex = 450;
map.getPane('labelsPane').style.pointerEvents = 'none';

const baseSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Imagery © Esri' }
);
const offRiverLabels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, pane: 'labelsPane' }
);
const onRiverLabels = L.layerGroup();

baseStreets.addTo(map);
const layerControl = L.control.layers(
  { 'Streets': baseStreets, 'Satellite': baseSatellite },
  {
    'Place names (off-river)': offRiverLabels,
    'River labels (locks, towns)': onRiverLabels,
  },
  { position: 'topright', collapsed: true }
).addTo(map);

// OSM street tiles have labels baked in, so Esri place labels would double up
// on Streets. Auto-hide them there, remember the user's choice, restore on Satellite.
let satOffRiverPref = true;
let syncingOffRiver = false;
function syncOffRiverToBase() {
  const shouldShow = map.hasLayer(baseSatellite) && satOffRiverPref;
  syncingOffRiver = true;
  if (shouldShow && !map.hasLayer(offRiverLabels)) offRiverLabels.addTo(map);
  else if (!shouldShow && map.hasLayer(offRiverLabels)) map.removeLayer(offRiverLabels);
  syncingOffRiver = false;
  // Control.Layers only repaints checkbox state on its own user-click handler,
  // so mirror it when we toggle the layer programmatically. offRiverLabels is
  // the first overlay registered — the control preserves registration order.
  const input = layerControl.getContainer()
    .querySelector('.leaflet-control-layers-overlays input[type="checkbox"]');
  if (input) input.checked = shouldShow;
}
map.on('baselayerchange', syncOffRiverToBase);
map.on('overlayadd overlayremove', (e) => {
  // Only treat user-driven overlay toggles as a preference change — otherwise
  // the base-switch auto-hide would wipe the user's choice on every bounce.
  if (!syncingOffRiver && e.layer === offRiverLabels) {
    satOffRiverPref = (e.type === 'overlayadd');
  }
});

// Auto-fall-back on tile error (handoff §6).
baseStreets.on('tileerror', () => {
  if (map.hasLayer(baseStreets)) {
    map.removeLayer(baseStreets);
    baseSatellite.addTo(map);
    syncOffRiverToBase();
  }
});

// Populate onRiverLabels with town/landmark/lock markers. Called from boot
// so the layer piggybacks on the fetches that renderLaunches already needs.
function populateRiverLabels(waypoints, launches) {
  const place = (lat, lng, text, cls) => {
    const safe = text ? escapeHtml(text) : '';
    const html = `<div class="river-label ${cls}"><span class="rl-dot"></span>${safe ? `<span class="rl-txt">${safe}</span>` : ''}</div>`;
    L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      interactive: false, keyboard: false,
    }).addTo(onRiverLabels);
  };
  for (const w of waypoints) {
    if (w.kind === 'lock') continue;
    const major = w.tier === 'major' || w.kind === 'town';
    place(w.lat, w.lng, major ? w.name : '', major ? 'place' : 'dot');
  }
  for (const l of launches) {
    if (l.type !== 'lock' || !l.name) continue;
    place(l.lat, l.lng, l.name.replace(/ Lock$/, ''), 'lock');
  }
}

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

// Manual double-tap detector. Leaflet's dblclick is unreliable on iOS Safari —
// the second tap is often consumed by the OS even with doubleClickZoom off.
// Two click events within 350 ms / 30 px works uniformly for mouse and touch.
let lastTap = { t: 0, x: 0, y: 0 };
map.on('click', (e) => {
  const now = Date.now();
  const dx = e.containerPoint.x - lastTap.x;
  const dy = e.containerPoint.y - lastTap.y;
  if (now - lastTap.t < 350 && Math.hypot(dx, dy) < 30) {
    setPin(state.next, [e.latlng.lat, e.latlng.lng]);
    lastTap = { t: 0, x: 0, y: 0 };
    return;
  }
  lastTap = { t: now, x: e.containerPoint.x, y: e.containerPoint.y };
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

  // Snap each pin to whichever waterway is nearest; may be Thames or any tributary.
  const snapA = hasA && state.waterways.length ? snapAny(A) : null;
  const snapB = hasB && state.waterways.length ? snapAny(B) : null;

  // Snap lines
  for (const slot of ['A', 'B']) {
    if (state.layers.snapLines[slot]) {
      map.removeLayer(state.layers.snapLines[slot]);
      state.layers.snapLines[slot] = null;
    }
    const s = slot === 'A' ? snapA : snapB;
    if (s) {
      state.layers.snapLines[slot] = L.polyline([state.pins[slot], s.snap.latlng], {
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
    const result = measureAcross(snapA, snapB);
    const u = activeUnit(), au = altUnit();
    const sameWw = snapA.ww === snapB.ww;
    const ww = snapA.ww;
    els.distPrimary.textContent = inUnit(result.river, u).toFixed(2);
    if (sameWw) {
      els.distPrimaryUnit.textContent = UNITS[u].label + (ww.kind === 'thames' ? ' on the river' : ` on the ${ww.short_name}`);
    } else {
      // Cross-river: name the segments in travel order so the readout reads
      // like a route (e.g. "via Thames + Cherwell").
      const segs = result.legs.map((l) => l.ww.short_name).join(' → ');
      els.distPrimaryUnit.textContent = UNITS[u].label + ' via ' + segs;
    }
    els.distSecondary.textContent = fmtDist(result.river, 2, au);
    els.distStraight.textContent = fmtDist(result.straight, 2, u) + ' straight';
    const sinuosity = result.straight > 0 ? result.river / result.straight : 1;
    els.sinuosity.textContent = 'sinuosity ' + sinuosity.toFixed(2);
    const warnings = [];
    if (snapA.snap.off > 500) warnings.push(`A is ${fmtDist(snapA.snap.off, 2)} from the ${snapA.ww.short_name}`);
    if (snapB.snap.off > 500) warnings.push(`B is ${fmtDist(snapB.snap.off, 2)} from the ${snapB.ww.short_name}`);
    if (warnings.length) {
      els.warn.hidden = false;
      els.warn.textContent = warnings.join(' · ');
    } else {
      els.warn.hidden = true;
    }
    state.layers.reach = L.polyline(result.path, {
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
  clearStripFocus();
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
  const ox = parseFloat(els.findOxford.value);
  const oxMax = parseFloat(els.findOxford.max);
  els.findOxfordOut.textContent = ox >= oxMax ? 'any distance from Oxford' : `${ox} ${lbl} of Oxford`;
}
els.findTarget.addEventListener('input', updateFindLabels);
els.findTol.addEventListener('input', updateFindLabels);
els.findWalk.addEventListener('input', updateFindLabels);
els.findOxford.addEventListener('input', updateFindLabels);
els.findNeedCamp.addEventListener('change', () => {
  els.findWalk.disabled = !els.findNeedCamp.checked;
});

// 'any' | 'upstream' | 'downstream' — bound to the segmented control. Upstream
// means both ends of the trip are upstream of Sandford Lock (lower along_m).
let oxfordSide = 'any';
for (const btn of els.findOxfordSide.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => {
    oxfordSide = btn.dataset.side;
    for (const b of els.findOxfordSide.querySelectorAll('.seg-btn')) {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  });
}

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
  const oxfordMax = parseFloat(els.findOxford.value);
  const oxfordSliderMax = parseFloat(els.findOxford.max);
  const oxfordCapM = oxfordMax >= oxfordSliderMax ? Infinity : oxfordMax / factor;
  // Oxford filters need a reference; if launches.json didn't yield Sandford,
  // skip those filters entirely rather than silently dropping every result.
  const sandford = state.sandfordM;
  const oxfordReady = sandford != null;

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
      if (oxfordReady) {
        if (oxfordSide === 'upstream' && B.along_m > sandford) continue;
        if (oxfordSide === 'downstream' && A.along_m < sandford) continue;
        // Trip's nearest along-river point to Oxford: 0 if it straddles Sandford.
        const nearestOx =
          A.along_m <= sandford && sandford <= B.along_m
            ? 0
            : Math.min(Math.abs(A.along_m - sandford), Math.abs(B.along_m - sandford));
        if (nearestOx > oxfordCapM) continue;
      }
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
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const activate = () => {
      clearPin('A'); clearPin('B');
      setPin('A', [A.snap_lat, A.snap_lng]);
      setPin('B', [B.snap_lat, B.snap_lng]);
      map.fitBounds([[A.snap_lat, A.snap_lng], [B.snap_lat, B.snap_lng]], { padding: [40, 40] });
      // Switch back to Measure tab so user sees the readout
      document.querySelector('.tab[data-tab="measure"]').click();
    };
    li.addEventListener('click', activate);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
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

function clearStripFocus() {
  if (state.layers.stripFocus) {
    map.removeLayer(state.layers.stripFocus);
    state.layers.stripFocus = null;
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

// Drop extras whose along_m is within EXTRA_SUPPRESS_RADIUS_M of any launch.
// Both are snapped to the Thames centreline so comparing along_m is exact.
function filterRedundantExtras(extras, launches) {
  if (!launches?.length) return extras;
  const launchAlong = launches.map(l => l.along_m).slice().sort((a, b) => a - b);
  return extras.filter(e => {
    for (const a of launchAlong) {
      if (a > e.along_m + EXTRA_SUPPRESS_RADIUS_M) break;
      if (Math.abs(a - e.along_m) <= EXTRA_SUPPRESS_RADIUS_M) return false;
    }
    return true;
  });
}

function renderExtras() {
  if (!state.extras) return;
  const renderer = L.svg();
  const group = L.layerGroup();
  for (const e of state.extras.shown) {
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
  layerControl.addOverlay(group, `Piers · quays · weirs · ferries (${state.extras.shown.length})`);
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
    for (const e of state.extras.shown) {
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
  const [thamesRes, tributariesRes, launchesRes, campsitesRes, parkingRes, bridgesRes, extrasRes, curatedRes, transportRes] = await Promise.all([
    fetch('./data/thames.json'),
    fetch('./data/tributaries.json').catch(() => null),
    fetch('./data/launches.json').catch(() => null),
    fetch('./data/campsites.json').catch(() => null),
    fetch('./data/parking.json').catch(() => null),
    fetch('./data/bridges.json').catch(() => null),
    fetch('./data/extras.json').catch(() => null),
    fetch('./data/curated-waypoints.json').catch(() => null),
    fetch('./data/curated-transport.json').catch(() => null),
  ]);
  state.thames = await thamesRes.json();
  state.waterways.push({
    name: 'River Thames',
    short_name: 'Thames',
    kind: 'thames',
    coords: state.thames.coords,
    cum: state.thames.cum,
    length_m: state.thames.cum[state.thames.cum.length - 1],
  });
  // Render the centreline so the user sees the navigable channel. Colour
  // depends on base tiles: dark navy against the pale Streets tiles, lighter
  // blue against Satellite imagery so it stays visible against dark terrain.
  state.layers.centreline = L.polyline(state.thames.coords, {
    color: '#0b3a5c',
    weight: 3.6,
    opacity: 0.55,
  }).addTo(map);
  map.fitBounds(state.layers.centreline.getBounds(), { padding: [40, 40] });
  const retintCentreline = () => {
    const satellite = map.hasLayer(baseSatellite);
    state.layers.centreline.setStyle(satellite
      ? { color: '#7dd3fc', opacity: 0.9 }
      : { color: '#0b3a5c', opacity: 0.55 });
  };
  map.on('baselayerchange', retintCentreline);

  // Tributaries: thinner, lighter blue; canals get a dashed stroke to read
  // differently from natural rivers. Pins can snap to any of these.
  if (tributariesRes && tributariesRes.ok) {
    const tribs = await tributariesRes.json();
    state.layers.tributaries = L.layerGroup().addTo(map);
    for (const w of tribs.waterways) {
      state.waterways.push({
        name: w.name,
        short_name: w.short_name,
        kind: w.kind,
        coords: w.points,
        cum: w.cum,
        length_m: w.length_m,
        confluence: w.confluence,
        confluence_thames_along_m: w.confluence_thames_along_m,
      });
      L.polyline(w.points, {
        color: w.kind === 'canal' ? '#4a6fa5' : '#2a6ea5',
        weight: 2,
        opacity: 0.7,
        dashArray: w.kind === 'canal' ? '4 4' : null,
      }).addTo(state.layers.tributaries);
    }
    layerControl.addOverlay(state.layers.tributaries, 'Tributaries');
  }

  if (launchesRes && launchesRes.ok) {
    state.launches = await launchesRes.json();
    const sandford = state.launches.launches.find(l => l.name === 'Sandford Lock');
    if (sandford) state.sandfordM = sandford.along_m;
    renderLaunches();
  }
  if (campsitesRes && campsitesRes.ok) state.campsites = await campsitesRes.json();
  if (parkingRes && parkingRes.ok) state.parking = await parkingRes.json();
  if (bridgesRes && bridgesRes.ok) state.bridges = await bridgesRes.json();
  if (extrasRes && extrasRes.ok) {
    state.extras = await extrasRes.json();
    state.extras.shown = state.launches
      ? filterRedundantExtras(state.extras.extras, state.launches.launches)
      : state.extras.extras.slice();
  }
  const curated = curatedRes && curatedRes.ok ? await curatedRes.json() : null;
  if (curated && state.launches) {
    populateRiverLabels(curated.waypoints, state.launches.launches);
  }

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

  // Strip view — merges curated + locks + transport, mounts the vertical
  // 1D projection in #tab-strip. Only initialises if the curated data loaded.
  if (curated && launchesRes && launchesRes.ok) {
    const transport = transportRes && transportRes.ok ? await transportRes.json() : { transport: [] };
    const waymarks = mergeWaymarks({ curated, transport, launches: state.launches });
    const totalRiverM = state.thames.cum[state.thames.cum.length - 1];
    initStrip({
      container: els.tabPanels.strip,
      waymarks,
      totalRiverM,
      onFocusRiver: (latlng) => {
        // Pan the map and drop a transient marker at the tapped waymark.
        map.panTo(latlng, { animate: true });
        clearStripFocus();
        state.layers.stripFocus = L.circleMarker(latlng, {
          radius: 7, color: '#0b3a5c', fillColor: '#facc15', fillOpacity: 0.9, weight: 2,
        }).addTo(map);
      },
    });
  }

  parseUrl();
})();
