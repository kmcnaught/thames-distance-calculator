// Build the "extras" layer — additional river features useful as put-ins or
// as on-water landmarks. Currently:
//
//   pier            (man_made=pier)            → put-in (formal landing)
//   quay            (man_made=quay)            → put-in (built bank, often urban)
//   ferry_terminal  (amenity=ferry_terminal)   → put-in (always road-accessible)
//   weir            (waterway=weir)            → LANDMARK (hazard; do not run)
//
// Pipeline:
//   1. Bbox derived from thames.json with a 0.5 km buffer.
//   2. Single Overpass query covering all four tag families.
//   3. Snap each to the centreline; drop anything > 80 m off (= not on the river).
//   4. Dedupe within 50 m of an existing entry (prefer the named one).
//   5. Sort by along_m. Write data/extras.json.
//
// Usage: node scripts/build-extras.mjs
// Requires data/thames.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap, haversine } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'extras.json');

const MAX_SNAP_OFFSET_M = 80;
const DEDUPE_RADIUS_M = 50;

const thames = JSON.parse(readFileSync(THAMES_PATH, 'utf8'));

function bboxWithBuffer(coords, bufferKm = 0.5) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const dLat = bufferKm / 111.32;
  const dLng = bufferKm / (111.32 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));
  return [minLat - dLat, minLng - dLng, maxLat + dLat, maxLng + dLng];
}

const [s, w, n, e] = bboxWithBuffer(thames.coords);
const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
console.log(`[build-extras] bbox: ${bb}`);

const QUERY = `
[out:json][timeout:120];
(
  node["man_made"="pier"](${bb});
  way["man_made"="pier"](${bb});
  node["man_made"="quay"](${bb});
  way["man_made"="quay"](${bb});
  node["waterway"="weir"](${bb});
  way["waterway"="weir"](${bb});
  node["amenity"="ferry_terminal"](${bb});
  way["amenity"="ferry_terminal"](${bb});
);
out tags center;
`.trim();

console.log('[build-extras] fetching Overpass…');
const json = await overpass(QUERY);
const elements = json.elements || [];
console.log(`[build-extras] ${elements.length} raw elements`);

function classify(tags = {}) {
  if (tags.amenity === 'ferry_terminal') return 'ferry_terminal';
  if (tags.man_made === 'pier') return 'pier';
  if (tags.man_made === 'quay') return 'quay';
  if (tags.waterway === 'weir') return 'weir';
  return null;
}

const ROLE = {
  pier: 'put_in',
  quay: 'put_in',
  ferry_terminal: 'put_in',
  weir: 'landmark', // hazard
};

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

const candidates = [];
for (const el of elements) {
  const category = classify(el.tags);
  if (!category) continue;
  const ll = latlngOf(el);
  if (!ll) continue;
  const sn = snap(thames.coords, thames.cum, ll);
  if (sn.off > MAX_SNAP_OFFSET_M) continue;
  candidates.push({
    lat: ll[0],
    lng: ll[1],
    snap_lat: sn.latlng[0],
    snap_lng: sn.latlng[1],
    name: el.tags?.name || null,
    category,
    role: ROLE[category],
    along_m: Math.round(sn.along),
    snap_offset_m: Math.round(sn.off),
    osm_id: `${el.type}/${el.id}`,
  });
}
console.log(`[build-extras] ${candidates.length} candidates within ${MAX_SNAP_OFFSET_M} m of centreline`);

// Dedupe — favour named within the radius.
candidates.sort((a, b) => a.along_m - b.along_m);
const kept = [];
for (const c of candidates) {
  let merged = false;
  for (let i = kept.length - 1; i >= 0; i--) {
    const k = kept[i];
    if (Math.abs(c.along_m - k.along_m) > DEDUPE_RADIUS_M * 4) break;
    if (k.category !== c.category) continue;
    const d = haversine([c.snap_lat, c.snap_lng], [k.snap_lat, k.snap_lng]);
    if (d < DEDUPE_RADIUS_M) {
      const better = (!!c.name && !k.name) || (!!c.name === !!k.name && c.snap_offset_m < k.snap_offset_m);
      if (better) kept[i] = c;
      merged = true;
      break;
    }
  }
  if (!merged) kept.push(c);
}
kept.sort((a, b) => a.along_m - b.along_m);

const byCat = {};
for (const k of kept) byCat[k.category] = (byCat[k.category] || 0) + 1;
console.log(`[build-extras] kept ${kept.length}: ${JSON.stringify(byCat)}`);

const out = {
  extras: kept,
  meta: {
    n: kept.length,
    by_category: byCat,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-extras] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 8:');
for (const k of kept.slice(0, 8)) console.log(`  ${k.category.padEnd(15)} ${(k.along_m / 1000).toFixed(2).padStart(7)} km  ${(k.name || '—').padEnd(28)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
console.log('last 8:');
for (const k of kept.slice(-8)) console.log(`  ${k.category.padEnd(15)} ${(k.along_m / 1000).toFixed(2).padStart(7)} km  ${(k.name || '—').padEnd(28)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
