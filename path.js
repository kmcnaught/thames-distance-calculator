// Minimal Thames Path distance app: click two spots, see along-trail distance.
// Reuses lib/geo.mjs for snap + measure; data is data/thames-path.json.

import { snap, haversine } from './lib/geo.mjs';

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

// Accommodation layer — colored circle markers banded by cheap-OSM-tag proxy.
// Band → colour map and human-readable labels are kept in one place so the
// legend swatches in path.html can be eyeballed against the markers.
const BAND_COLOR = {
  cheap:        '#2a7d2a',
  medium:       '#c08020',
  medium_pricy: '#c45c3f',
  pricy:        '#7c3aed',
};
const BAND_LABEL = {
  cheap:        '£ · cheap',
  medium:       '££ · medium',
  medium_pricy: '£££ · upper-mid',
  pricy:        '££££ · pricy',
};
const TYPE_LABEL = {
  hotel: 'hotel',
  hostel: 'hostel',
  guest_house: 'B&B / guest house',
  bed_and_breakfast: 'B&B',
  motel: 'motel',
  chalet: 'chalet',
};

const accomLayer = L.layerGroup();
try {
  const accomData = await fetch('./data/path-accommodation.json').then((r) => {
    if (!r.ok) throw new Error(`accommodation fetch: ${r.status}`);
    return r.json();
  });
  for (const a of accomData.accommodation) {
    const marker = L.circleMarker([a.lat, a.lng], {
      radius: 5,
      color: '#fff',
      weight: 1,
      fillColor: BAND_COLOR[a.band] || '#888',
      fillOpacity: 0.9,
    });
    const nameHtml = a.name ? escapeHtml(a.name) : '<em>unnamed</em>';
    const typeHtml = escapeHtml(TYPE_LABEL[a.type] || a.type);
    const bandHtml = escapeHtml(BAND_LABEL[a.band] || a.band);
    marker.bindPopup(
      `<div class="accom-popup">
        <div class="accom-name">${nameHtml}</div>
        <div class="accom-meta">${typeHtml}</div>
        <div class="accom-band"><span class="band-swatch" style="background:${BAND_COLOR[a.band] || '#888'}"></span>${bandHtml}</div>
      </div>`
    );
    marker.addTo(accomLayer);
  }
  console.log(`[path] loaded ${accomData.accommodation.length} accommodations`);
} catch (err) {
  console.warn('[path] accommodation layer unavailable:', err.message);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

el('toggle-accom').addEventListener('change', (ev) => {
  if (ev.target.checked) accomLayer.addTo(map);
  else accomLayer.remove();
});

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
