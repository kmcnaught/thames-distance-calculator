// Build a single train-stations dataset usable by both the river app and
// the Thames Path page.
//
// Source: OSM railway=station (ODbL), within 1 mile (1609 m) of **either**
// corridor. Each entry carries `along_river_m` (null if >1 mi from river)
// and `along_path_m` (null if >1 mi from path). Each app filters by its
// own non-null field at render time.
//
// Usage:  node scripts/build-stations.mjs
// Output: data/stations.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RIVER_FILE = resolve(__dirname, '..', 'data', 'thames.json');
const PATH_FILE  = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH   = resolve(__dirname, '..', 'data', 'stations.json');
const CACHE_PATH = '/tmp/path-stations-cache.json';

const CORRIDOR_M = 1609;
const ANCHOR_SPACING_M = 400;

const river = JSON.parse(readFileSync(RIVER_FILE, 'utf8'));
const path  = JSON.parse(readFileSync(PATH_FILE, 'utf8'));

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

const anchors = subsample(path.coords, path.cum, ANCHOR_SPACING_M);
const aroundList = anchors.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',');
console.log(`[build-stations] ${anchors.length} path anchors`);

const QUERY = `
[out:json][timeout:240];
nwr["railway"="station"](around:${CORRIDOR_M},${aroundList});
out tags center;
`.trim();

console.log('[build-stations] fetching Overpass…');
const json = await overpass(QUERY, { cachePath: CACHE_PATH });
const elements = json.elements || [];
console.log(`[build-stations] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

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
  if (tags['disused:railway'] || tags.disused === 'yes' || tags.abandoned === 'yes') continue;

  const snR = snap(river.coords, river.cum, ll);
  const snP = snap(path.coords, path.cum, ll);
  const inRiver = snR.off <= CORRIDOR_M;
  const inPath  = snP.off <= CORRIDOR_M;
  if (!inRiver && !inPath) continue;

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
    along_river_m: inRiver ? Math.round(snR.along) : null,
    along_path_m:  inPath  ? Math.round(snP.along) : null,
  });
}

const byNetwork = {};
let nRiver = 0, nPath = 0, nBoth = 0, nRiverOnly = 0, nPathOnly = 0;
for (const k of kept) {
  byNetwork[k.network] = (byNetwork[k.network] || 0) + 1;
  const r = k.along_river_m != null;
  const p = k.along_path_m  != null;
  if (r) nRiver++;
  if (p) nPath++;
  if (r && p) nBoth++;
  else if (r) nRiverOnly++;
  else if (p) nPathOnly++;
}

console.log(`[build-stations] kept ${kept.length} total`);
console.log(`[build-stations]   near river: ${nRiver}  near path: ${nPath}  (both: ${nBoth}, river-only: ${nRiverOnly}, path-only: ${nPathOnly})`);
console.log(`[build-stations] by network: ${JSON.stringify(byNetwork)}`);

const out = {
  stations: kept,
  meta: {
    n: kept.length,
    n_near_river: nRiver,
    n_near_path:  nPath,
    by_network: byNetwork,
    corridor_m: CORRIDOR_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-stations] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);
