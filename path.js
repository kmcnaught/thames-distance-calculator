// Minimal Thames Path distance app: click two spots, see along-trail distance.
// Reuses lib/geo.mjs for snap + measure; data is data/thames-path.json.

import { snap, haversine } from './lib/geo.mjs';
import * as overlays from './lib/overlays.mjs';

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

const pinStyle = (letter, color) => L.divIcon({
  className: 'tp-pin',
  html: `<div style="background:${color};color:#fff;width:26px;height:26px;border-radius:50%;` +
        `display:flex;align-items:center;justify-content:center;font-weight:700;` +
        `box-shadow:0 2px 6px rgba(0,0,0,.3);border:2px solid #fff;">${letter}</div>`,
  iconSize: [26, 26], iconAnchor: [13, 13],
});

const pins = { A: null, B: null };     // {marker, snap}
let next = 'A';

function placePin(letter, latlng) {
  const target = [latlng.lat, latlng.lng];
  const s = snap(coords, cum, target);
  const color = letter === 'A' ? '#e11d48' : '#0891b2';
  if (pins[letter]) pins[letter].marker.remove();
  const marker = L.marker(latlng, { icon: pinStyle(letter, color), draggable: true });
  marker.addTo(map);
  marker.on('drag', (ev) => {
    const ll = ev.target.getLatLng();
    pins[letter].snap = snap(coords, cum, [ll.lat, ll.lng]);
    refresh();
  });
  pins[letter] = { marker, snap: s };
  next = letter === 'A' ? 'B' : 'A';
  refresh();
}

function refresh() {
  const { A, B } = pins;
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

  // Snap-offset warning: if the user clicked far from the trail, the along
  // distance may not reflect their real intent.
  const maxOff = Math.max(A.snap.off, B.snap.off);
  if (maxOff > 200) {
    el('warn').hidden = false;
    el('warn').textContent =
      `Pin ${A.snap.off > B.snap.off ? 'A' : 'B'} is ${maxOff.toFixed(0)} m from the trail — distance snaps to the nearest point.`;
  } else {
    el('warn').hidden = true;
  }

  // Highlight the trail stretch between A and B.
  const [lo, hi] = A.snap.along < B.snap.along ? [A.snap, B.snap] : [B.snap, A.snap];
  const stretch = [lo.latlng.slice()];
  for (let k = lo.i + 1; k <= hi.i; k++) stretch.push(coords[k]);
  stretch.push(hi.latlng.slice());
  highlight.setLatLngs(stretch);
}

map.on('click', (ev) => {
  busLayer?.clearPinned();
  // If both pins are placed, move whichever is nearer to the click.
  if (pins.A && pins.B) {
    const target = [ev.latlng.lat, ev.latlng.lng];
    const dA = haversine(target, [pins.A.marker.getLatLng().lat, pins.A.marker.getLatLng().lng]);
    const dB = haversine(target, [pins.B.marker.getLatLng().lat, pins.B.marker.getLatLng().lng]);
    placePin(dA < dB ? 'A' : 'B', ev.latlng);
  } else {
    placePin(next, ev.latlng);
  }
});

el('btn-swap').addEventListener('click', () => {
  if (!pins.A || !pins.B) return;
  const aLL = pins.A.marker.getLatLng();
  const bLL = pins.B.marker.getLatLng();
  pins.A.marker.remove();
  pins.B.marker.remove();
  pins.A = null; pins.B = null;
  placePin('A', bLL);
  placePin('B', aLL);
});

el('btn-clear').addEventListener('click', () => {
  if (pins.A) pins.A.marker.remove();
  if (pins.B) pins.B.marker.remove();
  pins.A = null; pins.B = null;
  next = 'A';
  refresh();
});

refresh();
