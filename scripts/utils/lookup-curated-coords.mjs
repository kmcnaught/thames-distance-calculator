// One-shot resolver for data/curated-waypoints.json.
//
// Populates each waypoint with lat/lng by:
//   - locks: matching against data/launches.json by fuzzy name
//   - bridges: matching against data/bridges.json by fuzzy name
//   - settlements (town/village/hamlet/landmark tagged as such in OSM):
//       ONE Overpass query for place=* nodes across the Thames corridor, then
//       exact/fuzzy name match against the curated names.
//   - landmarks: manually curated by editing this file's LANDMARK_COORDS map.
//
// The output is a merged curated-waypoints.json with lat/lng populated for
// every entry that could be resolved. Ambiguous or unresolved entries are
// listed at the end for hand-fixup.
//
// Usage:
//   node scripts/utils/lookup-curated-coords.mjs           # dry run: print report
//   node scripts/utils/lookup-curated-coords.mjs --write   # write updated JSON

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './overpass.mjs';
import { snap } from './geo.mjs';

// Left/right bank looking downstream. Uses the sign of the cross product of
// the local downstream tangent with the pin→snap vector. +ve = left bank.
function bankSide(coords, target, snapResult) {
  const A = coords[snapResult.i];
  const B = coords[snapResult.i + 1];
  const mLat = 111320;
  const mLng = 111320 * Math.cos(target[0] * Math.PI / 180);
  const tangentX = (B[1] - A[1]) * mLng;
  const tangentY = (B[0] - A[0]) * mLat;
  const toTargetX = (target[1] - snapResult.latlng[1]) * mLng;
  const toTargetY = (target[0] - snapResult.latlng[0]) * mLat;
  const cross = tangentX * toTargetY - tangentY * toTargetX;
  return cross > 0 ? 'L' : cross < 0 ? 'R' : 'C';
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (name) => resolve(__dirname, '..', '..', 'data', name);

const WRITE = process.argv.includes('--write');

// Manually curated coordinates for entries not cleanly resolvable
// via place=*, lock=*, or bridge=* lookup. Sourced by name from
// Overpass with tight bboxes; see the block comment at bottom of
// this file for provenance notes.
const LANDMARK_COORDS = {
  "Source": [51.6939, -2.0270],
  "Water Hay Car Park": [51.6444, -1.9124],
  "Buscot": [51.6844, -1.6614],
  "Bablock Hythe": [51.7396, -1.3785],
  "Radley Boat House": [51.6871, -1.2323],
  "Kennet Canal": [51.4551, -0.9666],
  "Shiplake College Boathouse": [51.5158, -0.8747],
  "Dorney/Bray Marina": [51.5062, -0.6817],
  "Dorney Lake": [51.4844, -0.6650],
  "Bells of Ouzeley": [51.4649, -0.5691],
  "Runnymede": [51.4453, -0.5638],
  "Shepperton Landing": [51.3934, -0.4499],
  "Hampton Court": [51.4034, -0.3382],
  "Teddington": [51.4310, -0.3236],

  // Bridges not in data/bridges.json (OSM tagging gaps). Fetched
  // via Overpass name lookup with tight bboxes on the expected location.
  "Hannington Bridge": [51.65553, -1.75200],   // proxy: Hannington Wick hamlet (bridge is right at the hamlet)
  "Radcot Bridge": [51.69267, -1.58820],        // OSM way name="Radcot Bridge" (A4095)
  "Tadpole Bridge": [51.70123, -1.51743],       // proxy: Tadpole hamlet (bridge is directly here)
  "Osney Bridge, Oxford": [51.75256, -1.27263], // OSM man_made=bridge name="Osney Bridge"
  "Culham Old Bridge": [51.65850, -1.27731],    // OSM way name="Old Culham Bridge"
  "Reading Bridge": [51.46096, -0.96787],       // OSM man_made=bridge name="Reading Bridge"
};

// Manual name aliases for OSM records that don't match the guide's spelling.
const NAME_ALIASES = {
  "Days Lock/Little Wittenham": ["Day's Lock", "Days Lock"],
  "Hambleden": ["Hambleden Lock", "Hambledon Lock"],
  "Pinkhill": ["Pinkhill Lock"],
  "Osney Bridge, Oxford": ["Osney Bridge"],
  "Folly Bridge, Oxford": ["Folly Bridge"],
  "Albert Bridge, Old Windsor": ["Albert Bridge"],
  "Swinford Bridge": ["Swinford Toll Bridge"],
  "Lechlade": ["Lechlade", "Lechlade-on-Thames"],
  "Abingdon": ["Abingdon", "Abingdon-on-Thames"],
  "Dorchester": ["Dorchester", "Dorchester on Thames", "Dorchester-on-Thames"],
  "Goring & Streatley": ["Goring", "Goring-on-Thames"],  // pick Goring; Streatley resolves separately if wanted
  "Whitchurch & Pangbourne": ["Pangbourne"],  // Pangbourne is the bigger of the pair
  "Purley on Thames": ["Purley on Thames", "Purley-on-Thames"],
  "Henley": ["Henley-on-Thames", "Henley"],
  "Marlow": ["Marlow", "Great Marlow"],
  "Eton and Windsor": ["Windsor", "New Windsor"],
  "Staines": ["Staines-upon-Thames", "Staines"],
  "Walton": ["Walton-on-Thames"],
  "Kingston upon Thames": ["Kingston upon Thames"],
  "Reading Bridge": [],  // treat as a bridge, resolve by bridge lookup
  "Aston": ["Aston"],  // narrow via bbox
};

// --- inputs ---

const curated = JSON.parse(readFileSync(DATA('curated-waypoints.json'), 'utf8'));
const thames = JSON.parse(readFileSync(DATA('thames.json'), 'utf8'));
const launches = JSON.parse(readFileSync(DATA('launches.json'), 'utf8')).launches;
const bridges = JSON.parse(readFileSync(DATA('bridges.json'), 'utf8')).bridges;
const extras = JSON.parse(readFileSync(DATA('extras.json'), 'utf8')).extras;

// --- helpers ---

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findInLocalDataset(waypoint, dataset, kindHint) {
  const aliases = NAME_ALIASES[waypoint.name] || [waypoint.name];
  const candidates = aliases.map(normalize);
  const hits = dataset.filter((entry) => {
    if (!entry.name) return false;
    if (kindHint && entry.type && kindHint === 'lock' && entry.type !== 'lock') return false;
    const n = normalize(entry.name);
    return candidates.some((c) => n === c || n.includes(c) || c.includes(n));
  });
  return hits;
}

function pickBest(hits, waypoint) {
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  // Prefer the closest to the expected along_m derived from path_mi.
  // Rough map: our along_m ≈ (path_mi - 12.2) * 1609.344 (Cricklade is our ~0).
  const expected = Math.max(0, (waypoint.path_mi - 12.2) * 1609.344);
  hits.sort((a, b) => Math.abs(a.along_m - expected) - Math.abs(b.along_m - expected));
  return hits[0];
}

// --- pass 1: locks and bridges from local datasets ---

const resolved = new Map();  // waypoint.name -> { lat, lng, source, along_m }
const ambiguous = [];
const unresolved = [];

for (const w of curated.waypoints) {
  if (w.kind === 'lock') {
    const hits = findInLocalDataset(w, launches, 'lock');
    const pick = pickBest(hits, w);
    if (pick) {
      const sn = snap(thames.coords, thames.cum, [pick.lat, pick.lng]);
      resolved.set(w.name, {
        lat: pick.snap_lat, lng: pick.snap_lng,
        source: `launches.json (${pick.name})`,
        along_m: pick.along_m,
        side: bankSide(thames.coords, [pick.lat, pick.lng], sn),
        offset_m: Math.round(sn.off),
      });
    } else if (hits.length > 1) {
      ambiguous.push({ w, hits: hits.map(h => h.name) });
    }
  } else if (w.kind === 'bridge') {
    const hits = findInLocalDataset(w, bridges);
    const pick = pickBest(hits, w);
    if (pick) {
      const sn = snap(thames.coords, thames.cum, [pick.lat, pick.lng]);
      resolved.set(w.name, {
        lat: pick.snap_lat, lng: pick.snap_lng,
        source: `bridges.json (${pick.name})`,
        along_m: pick.along_m,
        side: bankSide(thames.coords, [pick.lat, pick.lng], sn),
        offset_m: Math.round(sn.off),
      });
    } else if (hits.length > 1) {
      ambiguous.push({ w, hits: hits.map(h => h.name) });
    }
  }
}

// --- pass 2: settlements via Overpass ---

// Build the bbox from the centreline with a 4 km buffer — settlements
// like Tilehurst, Cholsey and Datchet sit up to 2 km off the river.
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

const [s, w, n, e] = bbox(thames.coords, 4);
const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;

const settlementWaypoints = curated.waypoints.filter(
  (w) => !resolved.has(w.name) && !LANDMARK_COORDS[w.name] &&
         ['town', 'village', 'hamlet'].includes(w.kind)
);

const wantedNames = new Set();
for (const w of settlementWaypoints) {
  const aliases = NAME_ALIASES[w.name] || [w.name];
  for (const a of aliases) wantedNames.add(a);
}

// Overpass regex escape — pipe-separated alternation, no special regex chars in place names.
const nameRegex = [...wantedNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const QUERY = `
[out:json][timeout:120];
(
  node["place"~"^(town|village|hamlet|suburb)$"]["name"~"^(${nameRegex})$"](${bb});
);
out;
`.trim();

// Cache the Overpass response so re-runs (e.g. dry-run → write) don't re-hit
// the API. The API 500s intermittently, so caching also makes write reliable.
const CACHE_PATH = resolve(__dirname, '.overpass-cache-settlements.json');
let osm;
try {
  const cached = readFileSync(CACHE_PATH, 'utf8');
  osm = JSON.parse(cached);
  console.error(`[lookup] using cached Overpass response (${osm.elements?.length ?? 0} elements) from ${CACHE_PATH}`);
} catch {
  console.error('[lookup] Overpass query fetching settlements…');
  osm = await overpass(QUERY);
  writeFileSync(CACHE_PATH, JSON.stringify(osm));
  console.error(`[lookup] cached response to ${CACHE_PATH}`);
}
const places = osm.elements || [];
console.error(`[lookup] got ${places.length} candidate places`);

// Match settlements — for each waypoint, find OSM matches by name, pick closest to river.
for (const wp of settlementWaypoints) {
  const aliases = (NAME_ALIASES[wp.name] || [wp.name]).map(normalize);
  const hits = places.filter((p) => {
    const n = normalize(p.tags?.name);
    return aliases.some((a) => n === a);
  });
  if (hits.length === 0) {
    unresolved.push(wp);
    continue;
  }
  // Pick the one whose snap-to-river distance is smallest (guards against
  // homonyms like "Aston" that also exists off-river).
  const scored = hits.map((p) => {
    const sn = snap(thames.coords, thames.cum, [p.lat, p.lon]);
    return { p, dist_m: sn.off, along_m: sn.along, side: bankSide(thames.coords, [p.lat, p.lon], sn) };
  });
  scored.sort((a, b) => a.dist_m - b.dist_m);
  const best = scored[0];
  resolved.set(wp.name, {
    lat: best.p.lat, lng: best.p.lon,
    source: `overpass place=${best.p.tags.place} (${best.p.tags.name}) [${scored.length} candidates, off ${best.dist_m.toFixed(0)}m]`,
    along_m: best.along_m,
    side: best.side,
    offset_m: Math.round(best.dist_m),
  });
}

// --- pass 3: hardcoded landmarks ---

for (const wp of curated.waypoints) {
  if (resolved.has(wp.name)) continue;
  const ll = LANDMARK_COORDS[wp.name];
  if (ll) {
    const sn = snap(thames.coords, thames.cum, ll);
    resolved.set(wp.name, {
      lat: ll[0], lng: ll[1],
      source: `LANDMARK_COORDS (hand-coded)`,
      along_m: sn.along,
      side: bankSide(thames.coords, ll, sn),
      offset_m: Math.round(sn.off),
    });
  } else {
    unresolved.push(wp);
  }
}

// --- report ---

console.log('# Resolution report');
console.log(`Resolved: ${resolved.size} / ${curated.waypoints.length}`);
console.log(`Unresolved: ${unresolved.length}`);
console.log(`Ambiguous (>1 match, needs manual disambiguation): ${ambiguous.length}`);
console.log();
console.log('# Per waypoint:');
for (const wp of curated.waypoints) {
  const r = resolved.get(wp.name);
  if (r) {
    const alongMi = (r.along_m / 1609.344).toFixed(1);
    const drift = (r.along_m / 1609.344 - (wp.path_mi - 12.2)).toFixed(1);
    console.log(`  ✓ ${wp.name.padEnd(35)} [${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}]  along=${alongMi.padStart(6)}mi  drift=${drift.padStart(5)}mi  (${r.source})`);
  } else {
    console.log(`  ✗ ${wp.name.padEnd(35)} UNRESOLVED (kind=${wp.kind}, path_mi=${wp.path_mi})`);
  }
}

if (ambiguous.length) {
  console.log('\n# Ambiguous:');
  for (const a of ambiguous) {
    console.log(`  ${a.w.name} → ${a.hits.join(', ')}`);
  }
}

// --- write ---

if (WRITE) {
  const updated = {
    ...curated,
    waypoints: curated.waypoints.map((wp) => {
      const r = resolved.get(wp.name);
      if (!r) return wp;
      return {
        ...wp,
        lat: r.lat, lng: r.lng,
        along_m: Math.round(r.along_m),
        offset_m: r.offset_m,
        side: r.side,
      };
    }),
  };
  writeFileSync(DATA('curated-waypoints.json'), JSON.stringify(updated, null, 2) + '\n');
  console.log('\n[write] updated data/curated-waypoints.json');
}
