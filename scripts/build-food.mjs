// Build a single food dataset (pubs + cafés) usable by both the river app
// and the Thames Path page.
//
// Source: OSM amenity=pub|cafe (ODbL), near **either** the river or the
// Thames Path. Each kept entry carries `along_river_m` (null if not
// admitted to the river corridor) and `along_path_m` (null if not admitted
// to the path corridor); each app filters by its own non-null field.
//
// Corridor is adaptive by local density. Per corridor:
//   - Walk 1 km buckets along the corridor.
//   - In each bucket, start at 250 m. If < K stops within 250 m, grow the
//     bucket's radius to the K-th nearest candidate's offset, capped at
//     1000 m. In rural stretches where even 1 km finds < K, admit all
//     candidates up to the cap.
// This keeps central London tight (always ≥ K within 250 m) while giving
// Thameshead a wide net.
//
// Overpass is driven by a union of river + path anchors (deduped), queried
// at the cap radius plus slop.
//
// Usage:  node scripts/build-food.mjs
// Output: data/food.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RIVER_FILE = resolve(__dirname, '..', 'data', 'thames.json');
const PATH_FILE  = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH   = resolve(__dirname, '..', 'data', 'food.json');
const CACHE_PATH = '/tmp/path-food-cache.json';

const BASE_R = 250;                 // dense-region corridor
const CAP_R  = 1000;                // maximum corridor in sparse regions
const BUCKET_M = 1000;              // along-corridor bucket size for density check
const MIN_PER_BUCKET = 2;           // K: want ≥ this many stops per bucket if possible
const OVERPASS_R = 1200;            // CAP_R + slop; adjacent circles overlap enough with 1 km anchor spacing
const ANCHOR_SPACING_M = 1000;      // coarser than accommodation's 400 m — Overpass choked on dense anchor lists
const DEDUPE_LATLNG_DP = 3;         // ~110 m at UK latitudes — collapses path/river overlap

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

const pathAnchors  = subsample(path.coords,  path.cum,  ANCHOR_SPACING_M);
const riverAnchors = subsample(river.coords, river.cum, ANCHOR_SPACING_M);

const seen = new Set();
const anchors = [];
for (const [lat, lng] of [...pathAnchors, ...riverAnchors]) {
  const k = `${lat.toFixed(DEDUPE_LATLNG_DP)},${lng.toFixed(DEDUPE_LATLNG_DP)}`;
  if (seen.has(k)) continue;
  seen.add(k);
  anchors.push([lat, lng]);
}
console.log(`[build-food] ${pathAnchors.length} path + ${riverAnchors.length} river anchors → ${anchors.length} after dedupe`);

const aroundList = anchors.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',');

const QUERY = `
[out:json][timeout:240];
nwr["amenity"~"^(pub|cafe)$"](around:${OVERPASS_R},${aroundList});
out tags center;
`.trim();

console.log(`[build-food] query size ${(QUERY.length / 1024).toFixed(1)} KiB — fetching Overpass…`);
const json = await overpass(QUERY, { cachePath: CACHE_PATH });
const elements = json.elements || [];
console.log(`[build-food] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// Collect every candidate within CAP_R of either corridor, keeping the
// snap offsets so we can filter adaptively.
const candidates = [];
const seenIds = new Set();
for (const el of elements) {
  const key = `${el.type}/${el.id}`;
  if (seenIds.has(key)) continue;
  seenIds.add(key);

  const ll = latlngOf(el);
  if (!ll) continue;
  const tags = el.tags || {};
  if (tags.amenity !== 'pub' && tags.amenity !== 'cafe') continue;

  const snR = snap(river.coords, river.cum, ll);
  const snP = snap(path.coords, path.cum, ll);
  const nearRiver = snR.off <= CAP_R;
  const nearPath  = snP.off <= CAP_R;
  if (!nearRiver && !nearPath) continue;

  candidates.push({
    el,
    tags,
    ll,
    off_river_m: nearRiver ? snR.off : null,
    along_river_m: nearRiver ? snR.along : null,
    off_path_m: nearPath ? snP.off : null,
    along_path_m: nearPath ? snP.along : null,
  });
}
console.log(`[build-food] ${candidates.length} candidates within ${CAP_R} m of either corridor`);

// Density-adaptive admission per corridor. For each 1 km bucket along the
// corridor, the admission radius is max(BASE_R, off of K-th nearest
// candidate in bucket) capped at CAP_R. Buckets with < K candidates get
// CAP_R outright (sparse — admit everything we have).
function admitByBuckets(candidates, offKey, alongKey) {
  const admit = new Set();
  const buckets = new Map();
  for (const c of candidates) {
    const off = c[offKey];
    if (off == null) continue;
    const idx = Math.floor(c[alongKey] / BUCKET_M);
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(c);
  }
  let nBase = 0, nExtended = 0, nCapped = 0, nSparse = 0;
  for (const [idx, arr] of buckets) {
    arr.sort((a, b) => a[offKey] - b[offKey]);
    let r;
    if (arr.length >= MIN_PER_BUCKET) {
      const kth = arr[MIN_PER_BUCKET - 1][offKey];
      if (kth <= BASE_R) {
        r = BASE_R;
        nBase++;
      } else if (kth <= CAP_R) {
        r = kth;
        nExtended++;
      } else {
        // K-th candidate is beyond the cap — we clamp and knowingly admit <K.
        r = CAP_R;
        nCapped++;
      }
    } else {
      r = CAP_R;
      nSparse++;
    }
    for (const c of arr) {
      if (c[offKey] <= r) admit.add(c);
    }
  }
  return { admit, nBase, nExtended, nCapped, nSparse, nBuckets: buckets.size };
}

const riverPass = admitByBuckets(candidates, 'off_river_m', 'along_river_m');
const pathPass  = admitByBuckets(candidates, 'off_path_m',  'along_path_m');
console.log(`[build-food] river buckets: ${riverPass.nBuckets} (${riverPass.nBase} tight / ${riverPass.nExtended} extended / ${riverPass.nCapped} capped / ${riverPass.nSparse} sparse-cap)`);
console.log(`[build-food] path buckets:  ${pathPass.nBuckets} (${pathPass.nBase} tight / ${pathPass.nExtended} extended / ${pathPass.nCapped} capped / ${pathPass.nSparse} sparse-cap)`);

const kept = [];
for (const c of candidates) {
  const admitRiver = riverPass.admit.has(c);
  const admitPath  = pathPass.admit.has(c);
  if (!admitRiver && !admitPath) continue;
  kept.push({
    osm_id: c.el.id,
    osm_type: c.el.type,
    name: c.tags.name || null,
    type: c.tags.amenity,
    lat: c.ll[0],
    lng: c.ll[1],
    along_river_m: admitRiver ? Math.round(c.along_river_m) : null,
    along_path_m:  admitPath  ? Math.round(c.along_path_m)  : null,
    website: c.tags.website || c.tags['contact:website'] || undefined,
    phone: c.tags.phone || c.tags['contact:phone'] || undefined,
    outdoor_seating: c.tags.outdoor_seating === 'yes' ? true : undefined,
    opening_hours: c.tags.opening_hours || undefined,
  });
}

const byType = {};
let nRiver = 0, nPath = 0, nBoth = 0, nRiverOnly = 0, nPathOnly = 0;
for (const k of kept) {
  byType[k.type] = (byType[k.type] || 0) + 1;
  const r = k.along_river_m != null;
  const p = k.along_path_m  != null;
  if (r) nRiver++;
  if (p) nPath++;
  if (r && p) nBoth++;
  else if (r) nRiverOnly++;
  else if (p) nPathOnly++;
}

console.log(`[build-food] kept ${kept.length} total`);
console.log(`[build-food]   near river: ${nRiver}  near path: ${nPath}  (both: ${nBoth}, river-only: ${nRiverOnly}, path-only: ${nPathOnly})`);
console.log(`[build-food] by type: ${JSON.stringify(byType)}`);

const out = {
  food: kept,
  meta: {
    n: kept.length,
    n_near_river: nRiver,
    n_near_path:  nPath,
    by_type: byType,
    base_corridor_m: BASE_R,
    cap_corridor_m: CAP_R,
    bucket_m: BUCKET_M,
    min_per_bucket: MIN_PER_BUCKET,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    note: `amenity=pub|cafe; adaptive corridor ${BASE_R}–${CAP_R} m, widened in sparse ${BUCKET_M} m stretches to reach ${MIN_PER_BUCKET} stops`,
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-food] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);
