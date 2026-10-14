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

// Accommodation banding — colours match the inline £ swatches used in the
// overlay-picker label below.
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

const NETWORK_COLOR = {
  rail:       '#1e40af',
  tube:       '#dc2626',
  light_rail: '#0d9488',
};
const NETWORK_LABEL = {
  rail: 'rail',
  tube: 'tube',
  light_rail: 'DLR / light rail',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

const accomLayer = L.layerGroup();
try {
  const accomData = await fetch('./data/path-accommodation.json').then((r) => {
    if (!r.ok) throw new Error(`accommodation fetch: ${r.status}`);
    return r.json();
  });
  for (const a of accomData.accommodation) {
    const color = BAND_COLOR[a.band] || '#888';
    const marker = L.circleMarker([a.lat, a.lng], {
      radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9,
    });
    const parts = [];
    parts.push(`<div class="pop-name">${a.name ? escapeHtml(a.name) : '<em>unnamed</em>'}</div>`);
    parts.push(`<div class="pop-meta">${escapeHtml(TYPE_LABEL[a.type] || a.type)}</div>`);
    parts.push(`<div class="pop-band"><span class="band-swatch" style="background:${color}"></span>${escapeHtml(BAND_LABEL[a.band] || a.band)}</div>`);
    if (a.website) {
      parts.push(`<a class="pop-link" href="${escapeHtml(a.website)}" target="_blank" rel="noopener">${escapeHtml(hostnameOf(a.website))}</a>`);
    }
    marker.bindPopup(`<div class="pop">${parts.join('')}</div>`);
    marker.addTo(accomLayer);
  }
  console.log(`[path] loaded ${accomData.accommodation.length} accommodations`);
} catch (err) {
  console.warn('[path] accommodation layer unavailable:', err.message);
}

const stationIcon = (color) => L.divIcon({
  className: 'tp-station-pin',
  html: `<div style="background:${color};color:#fff;width:18px;height:18px;border-radius:3px;` +
        `display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;` +
        `font-family:system-ui,sans-serif;line-height:1;` +
        `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3);">T</div>`,
  iconSize: [18, 18], iconAnchor: [9, 9],
});

const stationsLayer = L.layerGroup();
try {
  const sData = await fetch('./data/path-stations.json').then((r) => {
    if (!r.ok) throw new Error(`stations fetch: ${r.status}`);
    return r.json();
  });
  for (const s of sData.stations) {
    const color = NETWORK_COLOR[s.network] || '#555';
    const marker = L.marker([s.lat, s.lng], { icon: stationIcon(color) });
    const parts = [];
    parts.push(`<div class="pop-name">${s.name ? escapeHtml(s.name) : '<em>unnamed station</em>'}</div>`);
    parts.push(`<div class="pop-meta">${escapeHtml(NETWORK_LABEL[s.network] || s.network)}${s.operator ? ' · ' + escapeHtml(s.operator) : ''}</div>`);
    if (s.website) {
      parts.push(`<a class="pop-link" href="${escapeHtml(s.website)}" target="_blank" rel="noopener">${escapeHtml(hostnameOf(s.website))}</a>`);
    }
    marker.bindPopup(`<div class="pop">${parts.join('')}</div>`);
    marker.addTo(stationsLayer);
  }
  console.log(`[path] loaded ${sData.stations.length} stations`);
} catch (err) {
  console.warn('[path] stations layer unavailable:', err.message);
}

// Legend-in-label: tiny coloured swatches sit next to each overlay name so
// the band / network colouring is self-explanatory from the picker.
const accomSwatches =
  `<span class="band-swatch" style="background:${BAND_COLOR.cheap}"></span>£` +
  `<span class="band-swatch" style="background:${BAND_COLOR.medium};margin-left:4px"></span>££` +
  `<span class="band-swatch" style="background:${BAND_COLOR.medium_pricy};margin-left:4px"></span>£££` +
  `<span class="band-swatch" style="background:${BAND_COLOR.pricy};margin-left:4px"></span>££££`;
const stationSwatches =
  `<span class="band-swatch" style="background:${NETWORK_COLOR.rail}"></span>rail` +
  `<span class="band-swatch" style="background:${NETWORK_COLOR.tube};margin-left:4px"></span>tube` +
  `<span class="band-swatch" style="background:${NETWORK_COLOR.light_rail};margin-left:4px"></span>DLR`;

L.control.layers(null, {
  [`Accommodation &nbsp; <span style="color:#888">${accomSwatches}</span>`]: accomLayer,
  [`Train stations &nbsp; <span style="color:#888">${stationSwatches}</span>`]: stationsLayer,
}, { position: 'topright', collapsed: true }).addTo(map);

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
