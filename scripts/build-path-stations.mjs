// Build the train-stations layer for the Thames Path page.
//
// Source: OSM `railway=station` (ODbL), within 1 mile (1609 m) of the trail.
// Includes mainline, Overground, DLR, and tube — anything you can board a
// train at. Excludes `disused:railway` / `abandoned` entries.
//
// Usage: node scripts/build-path-stations.mjs
// Requires data/thames-path.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH_FILE = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'path-stations.json');
const CACHE_PATH = '/tmp/path-stations-cache.json';

const CORRIDOR_M = 1609;

const path = JSON.parse(readFileSync(PATH_FILE, 'utf8'));
const { coords, cum } = path;

// Same subsampling trick as build-path-accommodation: 400 m anchor spacing
// keeps the Overpass query body small while neighbouring 1-mi discs overlap.
function subsample(coords, cum, stepM) {
  const anchors = [coords[0]];
  let nextMark = stepM;
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= nextMark) {
      anchors.push(coords[i]);
      nextMark = cum[i] + stepM;
    }
  }
  const last = coords[coords.length - 1];
  const tail = anchors[anchors.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) anchors.push(last);
  return anchors;
}

const anchors = subsample(coords, cum, 400);
const aroundList = anchors.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',');
console.log(`[build-path-stations] ${anchors.length} anchors`);

const QUERY = `
[out:json][timeout:240];
nwr["railway"="station"](around:${CORRIDOR_M},${aroundList});
out tags center;
`.trim();

console.log('[build-path-stations] fetching Overpass…');
const json = await overpass(QUERY, { cachePath: CACHE_PATH });
const elements = json.elements || [];
console.log(`[build-path-stations] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// Collapse the `station` tag into coarse buckets for icon colouring + popup.
// `null` → mainline (National Rail / Overground / DLR / etc.)
function networkOf(tags) {
  const s = (tags.station || '').toLowerCase();
  if (s === 'subway') return 'tube';
  if (s === 'light_rail') return 'light_rail';
  return 'rail';
}

const kept = [];
for (const el of elements) {
  const ll = latlngOf(el);
  if (!ll) continue;
  const tags = el.tags || {};
  // Guard against disused/abandoned entries slipping in.
  if (tags['disused:railway'] || tags.disused === 'yes' || tags.abandoned === 'yes') continue;
  const sn = snap(coords, cum, ll);
  if (sn.off > CORRIDOR_M) continue;
  kept.push({
    osm_id: el.id,
    osm_type: el.type,
    name: tags.name || null,
    network: networkOf(tags),
    operator: tags.operator || undefined,
    naptan_atco: tags['naptan:AtcoCode'] || tags['ref:crs'] || undefined,
    website: tags.website || tags['contact:website'] || undefined,
    lat: ll[0],
    lng: ll[1],
    along_m: Math.round(sn.along),
    snap_off_m: Math.round(sn.off),
  });
}
kept.sort((a, b) => a.along_m - b.along_m);

const byNetwork = {};
for (const k of kept) byNetwork[k.network] = (byNetwork[k.network] || 0) + 1;

console.log(`[build-path-stations] kept ${kept.length} within ${CORRIDOR_M} m of trail`);
console.log(`[build-path-stations] by network: ${JSON.stringify(byNetwork)}`);

const out = {
  stations: kept,
  meta: {
    n: kept.length,
    by_network: byNetwork,
    corridor_m: CORRIDOR_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-path-stations] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 5:');
for (const k of kept.slice(0, 5))
  console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${String(k.snap_off_m).padStart(4)} m  ${k.network.padEnd(10)} ${k.name || '—'}`);
console.log('last 5:');
for (const k of kept.slice(-5))
  console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${String(k.snap_off_m).padStart(4)} m  ${k.network.padEnd(10)} ${k.name || '—'}`);
