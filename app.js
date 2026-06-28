// Thalweg — non-tidal Thames on-river distance calculator.
// Map-first single-page app. Click two spots, see channel-following distance,
// iterate. URL state (?a=lat,lng&b=lat,lng) is the share format.

import { snap, measure, reachPts, haversine } from './lib/geo.mjs';

const M_PER_MILE = 1609.344;

const els = {
  hint: document.getElementById('hint'),
  readout: document.getElementById('readout'),
  distKm: document.getElementById('dist-km'),
  distMi: document.getElementById('dist-mi'),
  distStraight: document.getElementById('dist-straight'),
  sinuosity: document.getElementById('sinuosity'),
  warn: document.getElementById('offset-warn'),
  nextSlot: document.getElementById('next-slot-label'),
  btnSwap: document.getElementById('btn-swap'),
  btnClear: document.getElementById('btn-clear'),
  btnShare: document.getElementById('btn-share'),
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
  pins: { A: null, B: null }, // [lat, lng]
  next: 'A',
  layers: {
    markers: { A: null, B: null },
    snapLines: { A: null, B: null },
    reach: null,
    centreline: null,
    launches: null,       // L.layerGroup
  },
};

const LAUNCH_STYLE = {
  lock:    { color: '#0b3a5c', fill: '#ffffff', radius: 6, weight: 2, label: 'Lock' },
  slipway: { color: '#0e7c66', fill: '#0e7c66', radius: 4, weight: 1, label: 'Slipway' },
  put_in:  { color: '#a16207', fill: '#a16207', radius: 4, weight: 1, label: 'Put-in' },
};

const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
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

map.on('click', (e) => {
  setPin(state.next, [e.latlng.lat, e.latlng.lng]);
});

function setPin(slot, latlng) {
  state.pins[slot] = latlng;
  drawPin(slot);
  state.next = slot === 'A' ? 'B' : 'A';
  els.nextSlot.textContent = state.next;
  els.nextSlot.classList.toggle('pin-a', state.next === 'A');
  els.nextSlot.classList.toggle('pin-b', state.next === 'B');
  refresh();
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
    layers[slot].on('click', (ev) => L.DomEvent.stopPropagation(ev));
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
    els.hint.textContent = 'Tap the map to drop pin A.';
    els.readout.hidden = true;
  } else if (hasA && !hasB) {
    els.hint.hidden = false;
    els.hint.textContent = 'Tap the map to drop pin B.';
    els.readout.hidden = true;
  } else if (hasB && !hasA) {
    els.hint.hidden = false;
    els.hint.textContent = 'Tap the map to drop pin A.';
    els.readout.hidden = true;
  } else {
    els.hint.hidden = true;
    els.readout.hidden = false;
    const m = measure(state.thames.coords, state.thames.cum, A, B);
    els.distKm.textContent = (m.river / 1000).toFixed(2);
    els.distMi.textContent = (m.river / M_PER_MILE).toFixed(2) + ' mi';
    els.distStraight.textContent = (m.straight / 1000).toFixed(2) + ' km straight';
    els.sinuosity.textContent = 'sinuosity ' + m.sinuosity.toFixed(2);
    const warnings = [];
    if (m.a.off > 500) warnings.push(`A is ${(m.a.off / 1000).toFixed(2)} km from the river`);
    if (m.b.off > 500) warnings.push(`B is ${(m.b.off / 1000).toFixed(2)} km from the river`);
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
function updateFindLabels() {
  const target = parseFloat(els.findTarget.value);
  const tol = parseFloat(els.findTol.value);
  els.findDistOut.textContent = `${target} mi ± ${tol} mi`;
  els.findWalkOut.textContent = `${parseFloat(els.findWalk.value).toFixed(2)} km`;
}
els.findTarget.addEventListener('input', updateFindLabels);
els.findTol.addEventListener('input', updateFindLabels);
els.findWalk.addEventListener('input', updateFindLabels);
els.findNeedCamp.addEventListener('change', () => {
  els.findWalk.disabled = !els.findNeedCamp.checked;
});

els.btnFind.addEventListener('click', runFinder);

function runFinder() {
  if (!state.launches || !state.thames) {
    els.findSummary.textContent = 'Data not loaded yet.';
    return;
  }
  const targetMi = parseFloat(els.findTarget.value);
  const tolMi = parseFloat(els.findTol.value);
  const walkKm = parseFloat(els.findWalk.value);
  const needCamp = els.findNeedCamp.checked;
  const needPark = els.findNeedPark.checked;

  const M_PER_MI = 1609.344;
  const minM = (targetMi - tolMi) * M_PER_MI;
  const maxM = (targetMi + tolMi) * M_PER_MI;
  const walkM = walkKm * 1000;

  const launches = state.launches.launches;
  const campsites = state.campsites?.campsites || [];
  const parkings = state.parking?.parkings || [];

  // Index parking by launch
  const parkingByLaunch = new Map();
  for (const p of parkings) {
    if (!parkingByLaunch.has(p.near_launch)) parkingByLaunch.set(p.near_launch, []);
    parkingByLaunch.get(p.near_launch).push(p);
  }

  const results = [];
  for (let i = 0; i < launches.length; i++) {
    const A = launches[i];
    if (needPark && !parkingByLaunch.has(i)) continue;
    for (let j = i + 1; j < launches.length; j++) {
      const B = launches[j];
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
        parking: parkingByLaunch.get(i) || [],
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

function renderFinderResults(results) {
  const M_PER_MI = 1609.344;
  els.findResults.innerHTML = '';
  if (results.length === 0) {
    els.findSummary.textContent = 'No matches. Try widening the distance range or the campsite radius.';
    return;
  }
  els.findSummary.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} (sorted by closest campsite)`;
  const launches = state.launches.launches;
  for (const r of results.slice(0, 40)) {
    const A = launches[r.a], B = launches[r.b];
    const li = document.createElement('li');
    const aName = A.name || `${cap(A.type)} at ${(A.along_m / 1000).toFixed(1)} km`;
    const bName = B.name || `${cap(B.type)} at ${(B.along_m / 1000).toFixed(1)} km`;
    const mi = (r.dist_m / M_PER_MI).toFixed(1);
    const km = (r.dist_m / 1000).toFixed(1);
    const campTxt = r.camp ? `<span class="badge ok">⛺ ${(r.camp.dist_m / 1000).toFixed(2)} km</span>` : '';
    const parkTxt = r.parking.length ? `<span class="badge ok">🅿 ${r.parking.length}</span>` : '';
    li.innerHTML = `
      <div class="result-pair">${escapeHtml(aName)} → ${escapeHtml(bName)}</div>
      <div class="result-meta">${mi} mi · ${km} km${r.camp ? ` · campsite ${escapeHtml(r.camp.camp.name || 'unnamed')}` : ''}${campTxt}${parkTxt}</div>
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
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1).replace('_', '-'); }
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
  for (const l of state.launches.launches) {
    const style = LAUNCH_STYLE[l.type] || LAUNCH_STYLE.put_in;
    const km = (l.along_m / 1000).toFixed(1);
    const labelTitle = l.name || `${style.label} at ${km} km`;
    const marker = L.circleMarker([l.snap_lat, l.snap_lng], {
      radius: style.radius,
      color: style.color,
      fillColor: style.fill,
      fillOpacity: 0.9,
      weight: style.weight,
      renderer,
    });
    marker.bindTooltip(`<b>${escapeHtml(labelTitle)}</b><br>${km} km from source`, {
      direction: 'top',
      offset: [0, -2],
    });
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      setPin(state.next, [l.snap_lat, l.snap_lng]);
    });
    group.addLayer(marker);
  }
  state.layers.launches = group;
  group.addTo(map);
  layerControl.addOverlay(group, `Launches (${state.launches.launches.length})`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Boot
(async () => {
  const [thamesRes, launchesRes, campsitesRes, parkingRes] = await Promise.all([
    fetch('./data/thames.json'),
    fetch('./data/launches.json').catch(() => null),
    fetch('./data/campsites.json').catch(() => null),
    fetch('./data/parking.json').catch(() => null),
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
    renderLaunches();
  }
  if (campsitesRes && campsitesRes.ok) state.campsites = await campsitesRes.json();
  if (parkingRes && parkingRes.ok) state.parking = await parkingRes.json();

  parseUrl();
})();
