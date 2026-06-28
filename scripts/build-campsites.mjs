// Build the campsites layer for the non-tidal Thames corridor.
//
// Source: OSM `tourism=camp_site` (ODbL). The only legally-clean Thames-wide
// dataset; commercial aggregators (Hipcamp, Pitchup, Cool Camping) are
// proprietary or actively ToS-block scraping.
//
// Pipeline:
//   1. Bbox derived from thames.json with a 2 km buffer.
//   2. Overpass query (nodes + ways + relations for camp sites).
//   3. For each: project to nearest centreline point, drop if >2 km away.
//   4. Write data/campsites.json sorted by along_m.
//
// Usage: node scripts/build-campsites.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'campsites.json');

const MAX_OFFSET_M = 2000;

const thames = JSON.parse(readFileSync(THAMES_PATH, 'utf8'));

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

const [s, w, n, e] = bbox(thames.coords, 2.5);
const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
console.log(`[build-campsites] bbox: ${bb}`);

const QUERY = `
[out:json][timeout:120];
(
  node["tourism"="camp_site"](${bb});
  way["tourism"="camp_site"](${bb});
  relation["tourism"="camp_site"](${bb});
);
out tags center;
`.trim();

console.log('[build-campsites] fetching Overpass…');
const json = await overpass(QUERY);
const elements = json.elements || [];
console.log(`[build-campsites] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

const sites = [];
for (const el of elements) {
  const ll = latlngOf(el);
  if (!ll) continue;
  const sn = snap(thames.coords, thames.cum, ll);
  if (sn.off > MAX_OFFSET_M) continue;
  const tags = el.tags || {};
  sites.push({
    lat: ll[0],
    lng: ll[1],
    name: tags.name || null,
    operator: tags.operator || null,
    tents: tags.tents || tags['tent_only'] || null,
    backcountry: tags.backcountry === 'yes' || tags['camp_site'] === 'basic' || null,
    along_m: Math.round(sn.along),
    offset_m: Math.round(sn.off),
    snap_lat: sn.latlng[0],
    snap_lng: sn.latlng[1],
    osm_id: `${el.type}/${el.id}`,
  });
}
sites.sort((a, b) => a.along_m - b.along_m);

const named = sites.filter((s) => s.name).length;
console.log(`[build-campsites] kept ${sites.length} within ${MAX_OFFSET_M} m  (${named} named)`);

const out = {
  campsites: sites,
  meta: {
    n: sites.length,
    max_offset_m: MAX_OFFSET_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-campsites] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 5:');
for (const k of sites.slice(0, 5)) console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${k.offset_m}m  ${(k.name || '—').padEnd(40)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
console.log('last 5:');
for (const k of sites.slice(-5)) console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${k.offset_m}m  ${(k.name || '—').padEnd(40)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
