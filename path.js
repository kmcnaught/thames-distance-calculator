// Minimal Thames Path distance app: click two spots, see along-trail distance.
// Pin interaction (place, drag, swap, URL round-trip, tap-near-trail gate)
// lives in lib/corridor.mjs; this file handles data loading, overlays, and
// the readout.

import { snap, haversine } from './lib/geo.mjs';
import * as overlays from './lib/overlays.mjs';
import { createCorridor } from './lib/corridor.mjs';

const M_PER_MILE = 1609.344;

const el = (id) => document.getElementById(id);
const map = L.map('map', { zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const data = await fetch('./data/thames-path.json').then((r) => r.json());
const { coords, cum } = data;

const line = L.polyline(coords, { color: '#2d5016', weight: 3, opacity: 0.85 }).addTo(map);
map.fitBounds(line.getBounds(), { padding: [40, 40] });

const highlight = L.polyline([], { color: '#9ac67a', weight: 7, opacity: 0.65 }).addTo(map);

const layerControl = L.control.layers(null, null, { position: 'topright', collapsed: true }).addTo(map);
overlays.tameLayerControl(layerControl);

async function tryLoadLayer(url, build, legend, name) {
  try {
    const d = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${name} fetch: ${r.status}`);
      return r.json();
    });
    const raw = d.accommodation ?? d.stations ?? d.food ?? [];
    const items = overlays.nearPath(raw);
    const group = build(items);
    layerControl.addOverlay(group, overlays.labelWithLegend(name, legend));
    console.log(`[path] loaded ${items.length} ${name.toLowerCase()} (of ${raw.length} total)`);
  } catch (err) {
    console.warn(`[path] ${name.toLowerCase()} layer unavailable:`, err.message);
  }
}

await tryLoadLayer('./data/accommodation.json', overlays.accommodationLayer, overlays.accommodationLegendHtml(), 'Accommodation');
await tryLoadLayer('./data/stations.json',      overlays.stationsLayer,      overlays.stationsLegendHtml(),      'Train stations');
await tryLoadLayer('./data/food.json',          overlays.foodLayer,          overlays.foodLegendHtml(),          'Pubs & cafés');

let busLayer = null;
try {
  const busData = await fetch('./data/bus-routes.json').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  busLayer = overlays.busRoutesLayer(busData, (s) => s.along_path_m != null);
  layerControl.addOverlay(busLayer.layer, overlays.labelWithLegend('Bus routes', overlays.busRoutesLegendHtml(busData.meta?.palette)));
  console.log(`[path] bus-routes: ${busLayer.nRoutes} routes, ${busLayer.nStops} stops in corridor`);
} catch (err) {
  console.warn('[path] bus-routes layer unavailable:', err.message);
}

const corridor = createCorridor({
  map,
  snap: (target) => snap(coords, cum, target),
  colors: { A: '#e11d48', B: '#0891b2' },
  tapSnapPx: 40,
  onChange: refresh,
});

// Clear any pinned bus route whenever the user interacts with the map.
map.on('click', () => busLayer?.clearPinned());

function refresh() {
  const { A, B } = corridor.getPins();
  if (!A && !B) {
    el('readout').hidden = true;
    el('hint').innerHTML = 'Click the map to drop pin <span class="pin-chip pin-a">A</span>.';
    el('btn-swap').disabled = true;
    el('btn-clear').disabled = true;
    highlight.setLatLngs([]);
    return;
  }
  el('btn-clear').disabled = false;
  if (!A || !B) {
    el('readout').hidden = true;
    const nextLetter = !A ? 'A' : 'B';
    el('hint').innerHTML = `Click the map to drop pin <span class="pin-chip pin-${nextLetter.toLowerCase()}">${nextLetter}</span>.`;
    el('btn-swap').disabled = true;
    highlight.setLatLngs([]);
    return;
  }
  el('hint').textContent = 'Click the map again to move the nearer pin.';
  el('btn-swap').disabled = false;
  const trailM = Math.abs(A.snap.along - B.snap.along);
  const straightM = haversine(A.snap.latlng, B.snap.latlng);
  el('miles').textContent = (trailM / M_PER_MILE).toFixed(2);
  el('km').textContent = `${(trailM / 1000).toFixed(2)} km`;
  el('straight').textContent = `${(straightM / 1000).toFixed(2)} km straight`;
  el('readout').hidden = false;

  const maxOff = Math.max(A.snap.off, B.snap.off);
  if (maxOff > 200) {
    el('warn').hidden = false;
    el('warn').textContent =
      `Pin ${A.snap.off > B.snap.off ? 'A' : 'B'} is ${maxOff.toFixed(0)} m from the trail — distance snaps to the nearest point.`;
  } else {
    el('warn').hidden = true;
  }

  const [lo, hi] = A.snap.along < B.snap.along ? [A.snap, B.snap] : [B.snap, A.snap];
  const stretch = [lo.latlng.slice()];
  for (let k = lo.i + 1; k <= hi.i; k++) stretch.push(coords[k]);
  stretch.push(hi.latlng.slice());
  highlight.setLatLngs(stretch);
}

el('btn-swap').addEventListener('click', () => corridor.swap());
el('btn-clear').addEventListener('click', () => corridor.clearAll());

// Hydrate from ?a=&b= if present.
const restored = corridor.restoreFromUrl();
if (restored.A && restored.B) {
  map.fitBounds([restored.A, restored.B], { padding: [60, 60] });
} else if (restored.A || restored.B) {
  map.setView(restored.A || restored.B, 14);
}

refresh();
