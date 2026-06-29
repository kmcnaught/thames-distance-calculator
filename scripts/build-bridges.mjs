// Build the bridges layer — road crossings of the non-tidal Thames.
//
// Bridges are useful as informal put-ins: many have a small layby on the
// abutment or a road-side pull-in. We include them in the trip-finder's
// put-in set alongside locks/slipways that have parking nearby.
//
// Pipeline:
//   1. Bbox derived from thames.json with a small buffer.
//   2. Overpass query for way[highway][bridge=yes] (with geometry).
//   3. Filter to vehicle-bearing highway classes (motorway → service,
//      excluding cycleway/footway/path/steps).
//   4. Compute segment-segment intersection between the bridge polyline
//      and the centreline polyline. The first crossing point IS the put-in.
//   5. Snap the crossing point to the centreline → along_m.
//   6. Dedupe near-duplicates (dual carriageways are mapped as two ways).
//
// Usage: node scripts/build-bridges.mjs
// Requires data/thames.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'bridges.json');

// Highway classes admitting a vehicle (=> have a verge / layby option).
// Footway/cycleway/path bridges don't help with shuttle planning so we skip them.
const ALLOWED_HIGHWAY = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'service', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

// Two carriageways of the same crossing should collapse to one bridge.
const DEDUPE_ALONG_M = 80;

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
console.log(`[build-bridges] bbox: ${bb}`);

const QUERY = `
[out:json][timeout:180];
(
  way["highway"]["bridge"="yes"](${bb});
  way["highway"]["bridge"~"^(yes|viaduct|aqueduct|movable)$"](${bb});
);
out geom tags;
`.trim();

console.log('[build-bridges] fetching Overpass…');
const json = await overpass(QUERY);
const ways = json.elements || [];
console.log(`[build-bridges] ${ways.length} raw highway-bridge ways`);

// Standard 2D segment-segment intersection in lat/lng space. Earth curvature
// at the scale of a bridge (≤ 200 m) is negligible — we treat lat/lng as flat.
function segIntersect(a1, a2, b1, b2) {
  const x1 = a1[1], y1 = a1[0];
  const x2 = a2[1], y2 = a2[0];
  const x3 = b1[1], y3 = b1[0];
  const x4 = b2[1], y4 = b2[0];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [y1 + t * (y2 - y1), x1 + t * (x2 - x1)];
}

function findCrossing(geometry, river) {
  if (!geometry || geometry.length < 2) return null;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a1 = [geometry[i].lat, geometry[i].lon];
    const a2 = [geometry[i + 1].lat, geometry[i + 1].lon];
    const minLat = Math.min(a1[0], a2[0]) - 0.0005;
    const maxLat = Math.max(a1[0], a2[0]) + 0.0005;
    const minLng = Math.min(a1[1], a2[1]) - 0.0005;
    const maxLng = Math.max(a1[1], a2[1]) + 0.0005;
    for (let j = 0; j < river.length - 1; j++) {
      const b1 = river[j], b2 = river[j + 1];
      if (b1[0] < minLat && b2[0] < minLat) continue;
      if (b1[0] > maxLat && b2[0] > maxLat) continue;
      if (b1[1] < minLng && b2[1] < minLng) continue;
      if (b1[1] > maxLng && b2[1] > maxLng) continue;
      const x = segIntersect(a1, a2, b1, b2);
      if (x) return x;
    }
  }
  return null;
}

const candidates = [];
for (const w of ways) {
  const tags = w.tags || {};
  if (!ALLOWED_HIGHWAY.has(tags.highway)) continue;
  // Skip ways explicitly closed to motor vehicles.
  if (tags.motor_vehicle === 'no' || tags.access === 'no' || tags.access === 'private') continue;
  const cross = findCrossing(w.geometry, thames.coords);
  if (!cross) continue;
  const sn = snap(thames.coords, thames.cum, cross);
  if (sn.off > 30) continue; // sanity: the crossing point IS on the river
  candidates.push({
    lat: cross[0],
    lng: cross[1],
    snap_lat: sn.latlng[0],
    snap_lng: sn.latlng[1],
    name: tags.name || tags.bridge_name || null,
    highway: tags.highway,
    ref: tags.ref || null,
    along_m: Math.round(sn.along),
    snap_offset_m: Math.round(sn.off),
    osm_id: `way/${w.id}`,
  });
}
console.log(`[build-bridges] ${candidates.length} crossings detected`);

// Dedupe near-duplicates (dual carriageways, multi-span bridges mapped as
// adjacent ways). Prefer the named entry; otherwise prefer the higher-class
// highway.
const HIGHWAY_RANK = ['motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service'];
function rankHighway(h) {
  const i = HIGHWAY_RANK.indexOf(h);
  return i === -1 ? 99 : i;
}
candidates.sort((a, b) => a.along_m - b.along_m);
const kept = [];
for (const c of candidates) {
  const last = kept[kept.length - 1];
  if (last && Math.abs(c.along_m - last.along_m) < DEDUPE_ALONG_M) {
    const replace =
      (!last.name && c.name) ||
      (last.name === c.name && rankHighway(c.highway) < rankHighway(last.highway));
    if (replace) kept[kept.length - 1] = c;
    continue;
  }
  kept.push(c);
}

const named = kept.filter(b => b.name).length;
console.log(`[build-bridges] kept ${kept.length} bridges (${named} named, ${kept.length - named} unnamed)`);

const out = {
  bridges: kept,
  meta: {
    n: kept.length,
    named,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-bridges] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 8:');
for (const b of kept.slice(0, 8)) console.log(`  ${(b.along_m / 1000).toFixed(2).padStart(7)} km  ${(b.name || b.ref || b.highway).padEnd(30)} (${b.lat.toFixed(4)}, ${b.lng.toFixed(4)})`);
console.log('last 8:');
for (const b of kept.slice(-8)) console.log(`  ${(b.along_m / 1000).toFixed(2).padStart(7)} km  ${(b.name || b.ref || b.highway).padEnd(30)} (${b.lat.toFixed(4)}, ${b.lng.toFixed(4)})`);
