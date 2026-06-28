// Build the parking layer — only parking *near launches* matters for the
// shuttle-driving use case (drop off at A, drive home, paddle back).
//
// Pipeline:
//   1. Single Overpass query for amenity=parking across the thames bbox.
//   2. For each, find the nearest launch (from launches.json).
//   3. Drop anything > 500 m from its nearest launch.
//   4. Output one entry per parking spot with the nearest launch's index +
//      walking distance, sorted by along_m of that launch.
//
// Usage: node scripts/build-parking.mjs
// Requires data/launches.json (run build-launches.mjs first).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { haversine } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');
const LAUNCHES_PATH = resolve(__dirname, '..', 'data', 'launches.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'parking.json');

const MAX_WALK_M = 500;

const thames = JSON.parse(readFileSync(THAMES_PATH, 'utf8'));
const launches = JSON.parse(readFileSync(LAUNCHES_PATH, 'utf8')).launches;

function bbox(coords, bufferKm) {
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

const [s, w, n, e] = bbox(thames.coords, 1);
const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
console.log(`[build-parking] bbox: ${bb}`);

const QUERY = `
[out:json][timeout:120];
(
  node["amenity"="parking"](${bb});
  way["amenity"="parking"](${bb});
);
out tags center;
`.trim();

console.log('[build-parking] fetching Overpass…');
const json = await overpass(QUERY);
const elements = json.elements || [];
console.log(`[build-parking] ${elements.length} raw parking elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

function nearestLaunch(latlng) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < launches.length; i++) {
    const l = launches[i];
    const d = haversine(latlng, [l.snap_lat, l.snap_lng]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distance_m: bestD };
}

const parkings = [];
for (const el of elements) {
  const ll = latlngOf(el);
  if (!ll) continue;
  const { index, distance_m } = nearestLaunch(ll);
  if (distance_m > MAX_WALK_M) continue;
  const t = el.tags || {};
  // Skip clearly inappropriate parking
  if (t.access === 'private' || t.access === 'no') continue;
  if (t.parking === 'street_side' || t.parking === 'lane') continue;
  parkings.push({
    lat: ll[0],
    lng: ll[1],
    name: t.name || null,
    fee: t.fee === 'yes' ? true : t.fee === 'no' ? false : null,
    capacity: t.capacity ? Number(t.capacity) || null : null,
    surface: t.surface || null,
    access: t.access || null,
    near_launch: index,
    near_launch_name: launches[index].name || `${launches[index].type} at ${(launches[index].along_m / 1000).toFixed(1)} km`,
    walk_m: Math.round(distance_m),
    along_m: launches[index].along_m,
    osm_id: `${el.type}/${el.id}`,
  });
}
parkings.sort((a, b) => a.along_m - b.along_m || a.walk_m - b.walk_m);

// Count launches with at least one parking
const launchesWithParking = new Set(parkings.map((p) => p.near_launch));
console.log(`[build-parking] kept ${parkings.length} parking spots covering ${launchesWithParking.size}/${launches.length} launches`);

const out = {
  parkings,
  meta: {
    n: parkings.length,
    launches_with_parking: launchesWithParking.size,
    max_walk_m: MAX_WALK_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-parking] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 8 (head of river):');
for (const p of parkings.slice(0, 8)) console.log(`  ${(p.along_m / 1000).toFixed(1).padStart(6)} km  walk ${String(p.walk_m).padStart(3)}m  ${(p.name || '—').padEnd(28)} ← ${p.near_launch_name}`);
console.log('\nlast 8 (tail):');
for (const p of parkings.slice(-8)) console.log(`  ${(p.along_m / 1000).toFixed(1).padStart(6)} km  walk ${String(p.walk_m).padStart(3)}m  ${(p.name || '—').padEnd(28)} ← ${p.near_launch_name}`);
