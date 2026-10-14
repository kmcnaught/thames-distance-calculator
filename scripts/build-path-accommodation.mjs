// Build the accommodation layer for the Thames Path National Trail.
//
// Source: OSM `tourism=hotel|hostel|guest_house|motel|chalet|bed_and_breakfast`
// (ODbL), within 1 mile (1609 m) of the trail polyline.
//
// Pipeline:
//   1. Subsample thames-path.json down to ~400 m spacing so the Overpass
//      `around:` list stays small (~800 anchor points).
//   2. Overpass `nwr(around:1609, …)` for all six accommodation tag families.
//   3. Snap each candidate to the centreline; drop anything > 1609 m away
//      (= beyond the 1-mile corridor).
//   4. Band each result from OSM tags only (NO scraped or live prices).
//   5. Sort by along_m. Write data/path-accommodation.json.
//
// Usage: node scripts/build-path-accommodation.mjs
// Requires data/thames-path.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap, haversine } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH_FILE = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'path-accommodation.json');
const CACHE_PATH = '/tmp/path-accom-cache.json';

const CORRIDOR_M = 1609; // 1 mile

const path = JSON.parse(readFileSync(PATH_FILE, 'utf8'));
const { coords, cum } = path;

// Subsample the trail so the Overpass `around:` list stays small. 400 m
// spacing on a 312 km trail → ~780 anchor points (~25 KB query body).
// Overpass unions discs around each anchor, so neighbouring 400-m anchors
// at radius 1609 m overlap heavily — no coverage gaps.
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
console.log(`[build-path-accom] trail has ${coords.length} pts; using ${anchors.length} anchors at 400 m spacing`);

// One `around:` filter, one regex over the six tourism values. Repeating
// the heavy anchor list six times blew the timeout on the main mirror.
const QUERY = `
[out:json][timeout:240];
nwr["tourism"~"^(hotel|hostel|guest_house|motel|chalet|bed_and_breakfast)$"](around:${CORRIDOR_M},${aroundList});
out tags center;
`.trim();

console.log('[build-path-accom] fetching Overpass…');
const json = await overpass(QUERY, { cachePath: CACHE_PATH });
const elements = json.elements || [];
console.log(`[build-path-accom] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// Band heuristic — purely OSM-tag based. See the task brief:
//   hostel / camping_pitch                     → cheap
//   b&b / guest_house / hotel with stars ≤ 2   → medium
//   hotel stars 3–4 OR known budget brand      → medium_pricy
//   hotel stars ≥ 5 OR known luxury marker     → pricy
//   fallback                                   → medium
// Tune this list as surprises surface — do NOT introduce numeric prices.
const BUDGET_BRANDS = [
  'premier inn',
  'travelodge',
  'ibis',
  'holiday inn express',
  'mercure',
];
const LUXURY_MARKERS = [
  'dorchester',
  'cliveden',
  'four seasons',
  'mandarin oriental',
];

function parseStars(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function matchesAny(hay, needles) {
  if (!hay) return false;
  const h = String(hay).toLowerCase();
  return needles.some((n) => h.includes(n));
}

function bandOf(tags = {}) {
  const t = tags.tourism;
  const stars = parseStars(tags.stars);
  const brandish = [tags.operator, tags.brand, tags.name].filter(Boolean).join(' | ');

  if (t === 'hostel' || t === 'camping_pitch') return 'cheap';

  if (t === 'hotel') {
    if (stars != null && stars >= 5) return 'pricy';
    if (matchesAny(brandish, LUXURY_MARKERS)) return 'pricy';
    if (stars != null && stars >= 3 && stars <= 4) return 'medium_pricy';
    if (matchesAny(brandish, BUDGET_BRANDS)) return 'medium_pricy';
    if (stars != null && stars <= 2) return 'medium';
    return 'medium';
  }

  if (t === 'bed_and_breakfast' || t === 'guest_house') return 'medium';

  return 'medium';
}

const kept = [];
for (const el of elements) {
  const ll = latlngOf(el);
  if (!ll) continue;
  const tags = el.tags || {};
  if (!tags.tourism) continue;
  const sn = snap(coords, cum, ll);
  if (sn.off > CORRIDOR_M) continue;
  const stars = parseStars(tags.stars);
  kept.push({
    osm_id: el.id,
    osm_type: el.type,
    name: tags.name || null,
    type: tags.tourism,
    lat: ll[0],
    lng: ll[1],
    along_m: Math.round(sn.along),
    snap_off_m: Math.round(sn.off),
    stars: stars != null ? stars : undefined,
    operator: tags.operator || undefined,
    website: tags.website || tags['contact:website'] || undefined,
    phone: tags.phone || tags['contact:phone'] || undefined,
    band: bandOf(tags),
  });
}
kept.sort((a, b) => a.along_m - b.along_m);

const byBand = {};
const byType = {};
let maxOff = -Infinity, minOff = Infinity;
for (const k of kept) {
  byBand[k.band] = (byBand[k.band] || 0) + 1;
  byType[k.type] = (byType[k.type] || 0) + 1;
  if (k.snap_off_m > maxOff) maxOff = k.snap_off_m;
  if (k.snap_off_m < minOff) minOff = k.snap_off_m;
}

console.log(`[build-path-accom] kept ${kept.length} within ${CORRIDOR_M} m of trail`);
console.log(`[build-path-accom] by band: ${JSON.stringify(byBand)}`);
console.log(`[build-path-accom] by type: ${JSON.stringify(byType)}`);
console.log(`[build-path-accom] snap offsets: min=${minOff} m, max=${maxOff} m`);

const out = {
  accommodation: kept,
  meta: {
    n: kept.length,
    by_band: byBand,
    by_type: byType,
    corridor_m: CORRIDOR_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    note: 'band is a cheap OSM-tag proxy — no scraped or live prices',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-path-accom] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

console.log('\nfirst 5:');
for (const k of kept.slice(0, 5))
  console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${String(k.snap_off_m).padStart(4)} m  ${k.band.padEnd(12)} ${k.type.padEnd(18)} ${(k.name || '—')}`);
console.log('last 5:');
for (const k of kept.slice(-5))
  console.log(`  ${(k.along_m / 1000).toFixed(1)} km  off ${String(k.snap_off_m).padStart(4)} m  ${k.band.padEnd(12)} ${k.type.padEnd(18)} ${(k.name || '—')}`);
