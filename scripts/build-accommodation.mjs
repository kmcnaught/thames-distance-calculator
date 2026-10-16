// Build a single accommodation dataset usable by both the river app and
// the Thames Path page.
//
// Source: OSM tourism=hotel|hostel|guest_house|motel|chalet|bed_and_breakfast
// (ODbL), within 1 mile (1609 m) of **either** the river or the Thames Path.
//
// One Overpass query, driven by the path's anchor list (the path largely
// contains the river geographically). Each kept entry is snapped to both
// corridors; `along_river_m` is null when the entry is >1 mi from the river,
// and likewise for `along_path_m`. Each app filters by its own non-null
// field at render time.
//
// Band is a cheap OSM-tag proxy (hostel → cheap; B&B / 1–2★ hotel → medium;
// 3–4★ or budget brand → medium_pricy; 5★ or luxury name → pricy). NO
// scraped or live prices anywhere.
//
// Usage:  node scripts/build-accommodation.mjs
// Output: data/accommodation.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RIVER_FILE = resolve(__dirname, '..', 'data', 'thames.json');
const PATH_FILE  = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH   = resolve(__dirname, '..', 'data', 'accommodation.json');
const CACHE_PATH = '/tmp/path-accom-cache.json';

const CORRIDOR_M = 1609; // 1 mile
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

// Drive the Overpass query off the path corridor only — the path's 1-mi
// buffer almost entirely contains the river's 1-mi buffer (the path hugs
// the river), and reusing a single query means we hit Overpass once and
// benefit from an existing cache file.
const anchors = subsample(path.coords, path.cum, ANCHOR_SPACING_M);
const aroundList = anchors.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',');
console.log(`[build-accom] ${anchors.length} path anchors at ${ANCHOR_SPACING_M} m`);

const QUERY = `
[out:json][timeout:240];
nwr["tourism"~"^(hotel|hostel|guest_house|motel|chalet|bed_and_breakfast)$"](around:${CORRIDOR_M},${aroundList});
out tags center;
`.trim();

console.log('[build-accom] fetching Overpass…');
const json = await overpass(QUERY, { cachePath: CACHE_PATH });
const elements = json.elements || [];
console.log(`[build-accom] ${elements.length} raw elements`);

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// Band heuristic — purely OSM-tag based.
// Tune the brand lists as surprises surface — do NOT introduce numeric prices.
const BUDGET_BRANDS = ['premier inn', 'travelodge', 'ibis', 'holiday inn express', 'mercure'];
const LUXURY_MARKERS = ['dorchester', 'cliveden', 'four seasons', 'mandarin oriental'];

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

  const snR = snap(river.coords, river.cum, ll);
  const snP = snap(path.coords, path.cum, ll);
  const inRiver = snR.off <= CORRIDOR_M;
  const inPath  = snP.off <= CORRIDOR_M;
  if (!inRiver && !inPath) continue;

  const stars = parseStars(tags.stars);
  kept.push({
    osm_id: el.id,
    osm_type: el.type,
    name: tags.name || null,
    type: tags.tourism,
    lat: ll[0],
    lng: ll[1],
    along_river_m: inRiver ? Math.round(snR.along) : null,
    along_path_m:  inPath  ? Math.round(snP.along) : null,
    stars: stars != null ? stars : undefined,
    operator: tags.operator || undefined,
    website: tags.website || tags['contact:website'] || undefined,
    phone: tags.phone || tags['contact:phone'] || undefined,
    band: bandOf(tags),
  });
}

const byBand = {};
const byType = {};
let nRiver = 0, nPath = 0, nBoth = 0, nRiverOnly = 0, nPathOnly = 0;
for (const k of kept) {
  byBand[k.band] = (byBand[k.band] || 0) + 1;
  byType[k.type] = (byType[k.type] || 0) + 1;
  const r = k.along_river_m != null;
  const p = k.along_path_m  != null;
  if (r) nRiver++;
  if (p) nPath++;
  if (r && p) nBoth++;
  else if (r) nRiverOnly++;
  else if (p) nPathOnly++;
}

console.log(`[build-accom] kept ${kept.length} total`);
console.log(`[build-accom]   near river: ${nRiver}  near path: ${nPath}  (both: ${nBoth}, river-only: ${nRiverOnly}, path-only: ${nPathOnly})`);
console.log(`[build-accom] by band: ${JSON.stringify(byBand)}`);
console.log(`[build-accom] by type: ${JSON.stringify(byType)}`);

const out = {
  accommodation: kept,
  meta: {
    n: kept.length,
    n_near_river: nRiver,
    n_near_path:  nPath,
    by_band: byBand,
    by_type: byType,
    corridor_m: CORRIDOR_M,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    note: 'band is a cheap OSM-tag proxy — no scraped or live prices',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-accom] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);
