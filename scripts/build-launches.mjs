// Build the launches layer for the non-tidal Thames.
//
// Sources (all OSM, ODbL):
//   - Locks:    waterway=lock_gate   (EA's authoritative 45 along the river)
//   - Slipways: leisure=slipway      (public boat slips)
//   - Put-ins:  canoe=put_in         (informal launches, patchy)
//
// Pipeline:
//   1. Bbox derived from thames.json with a 1 km buffer.
//   2. Overpass query for the three tag families.
//   3. Snap each candidate to the centreline; drop anything >200 m away
//      (= not actually on this river).
//   4. Dedupe by clustering within 60 m; keep the most authoritative type
//      (lock > slipway > put_in).
//   5. Sort by along_m. Write data/launches.json.
//
// Usage: node scripts/build-launches.mjs
// Requires data/thames.json (run build-thames.mjs first).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { snap, haversine } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');
const OUT_PATH = resolve(__dirname, '..', 'data', 'launches.json');

const MAX_SNAP_OFFSET_M = 200;
const TYPE_RANK = { lock: 3, slipway: 2, put_in: 1 };
// Dedupe radii (m). Locks especially: gate nodes can sit 30–100 m from the
// named lock-chamber way's centre, so the radius needs to be generous.
const DEDUPE_RADIUS_M = { lock: 200, slipway: 60, put_in: 60 };

const thames = JSON.parse(readFileSync(THAMES_PATH, 'utf8'));

function bboxWithBuffer(coords, bufferKm = 1) {
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
const bbox = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
console.log(`[build-launches] bbox: ${bbox}`);

const QUERY = `
[out:json][timeout:120];
(
  // Lock gates (point structures along the river)
  node["waterway"="lock_gate"](${bbox});
  way["waterway"="lock_gate"](${bbox});
  // Lock chambers / cuts — these carry the human-readable name
  way["waterway"="lock"](${bbox});
  way["lock"="yes"](${bbox});
  relation["waterway"="lock"](${bbox});
  // Slipways (public boat slips)
  node["leisure"="slipway"](${bbox});
  way["leisure"="slipway"](${bbox});
  // Designated canoe / paddle put-ins
  node["canoe"="put_in"](${bbox});
);
out tags center;
`.trim();

console.log('[build-launches] fetching Overpass…');
const json = await overpass(QUERY);
const elements = json.elements || [];
console.log(`[build-launches] ${elements.length} raw elements`);

function classify(tags = {}) {
  if (tags.waterway === 'lock_gate' || tags.waterway === 'lock' || tags.lock === 'yes') return 'lock';
  if (tags.leisure === 'slipway') return 'slipway';
  if (tags.canoe === 'put_in') return 'put_in';
  return null;
}

// Some OSM elements inherit their parent way's name (e.g. "River Thames",
// "Thames & Severn Canal") — useless for a lock label. Drop those so the UI
// falls back to "Lock at km …".
function cleanName(rawName, type) {
  if (!rawName) return null;
  const n = String(rawName).trim();
  if (!n) return null;
  if (type === 'lock') {
    if (/^(river\s+)?thames$/i.test(n)) return null;
    if (/canal/i.test(n) && !/lock/i.test(n)) return null;
  }
  return n;
}

function latlngOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

const candidates = [];
for (const el of elements) {
  const type = classify(el.tags);
  if (!type) continue;
  const ll = latlngOf(el);
  if (!ll) continue;
  const s = snap(thames.coords, thames.cum, ll);
  if (s.off > MAX_SNAP_OFFSET_M) continue;
  candidates.push({
    lat: ll[0],
    lng: ll[1],
    snap_lat: s.latlng[0],
    snap_lng: s.latlng[1],
    name: cleanName(el.tags?.['lock_name'] || el.tags?.name, type),
    type,
    along_m: Math.round(s.along),
    snap_offset_m: Math.round(s.off),
    osm_id: `${el.type}/${el.id}`,
  });
}
console.log(`[build-launches] ${candidates.length} candidates within ${MAX_SNAP_OFFSET_M} m of centreline`);

// Dedupe: cluster by snapped position. Radius depends on the larger of the
// two entry types (locks get a generous 200 m because lock_gate nodes can
// sit far from the named chamber). Within a cluster, prefer:
//   1. higher-ranked type (lock > slipway > put_in)
//   2. has a name
//   3. closer snap to centreline
candidates.sort((a, b) => a.along_m - b.along_m);
const kept = [];
for (const c of candidates) {
  let merged = false;
  for (let i = kept.length - 1; i >= 0; i--) {
    const k = kept[i];
    const radius = Math.max(DEDUPE_RADIUS_M[c.type], DEDUPE_RADIUS_M[k.type]);
    if (Math.abs(c.along_m - k.along_m) > radius * 4) break;
    const d = haversine([c.snap_lat, c.snap_lng], [k.snap_lat, k.snap_lng]);
    if (d < radius) {
      const better =
        TYPE_RANK[c.type] > TYPE_RANK[k.type] ||
        (TYPE_RANK[c.type] === TYPE_RANK[k.type] && !!c.name && !k.name) ||
        (TYPE_RANK[c.type] === TYPE_RANK[k.type] && !!c.name === !!k.name && c.snap_offset_m < k.snap_offset_m);
      if (better) kept[i] = c;
      merged = true;
      break;
    }
  }
  if (!merged) kept.push(c);
}
kept.sort((a, b) => a.along_m - b.along_m);

const byType = {};
for (const k of kept) byType[k.type] = (byType[k.type] || 0) + 1;
console.log(`[build-launches] kept ${kept.length}: ${JSON.stringify(byType)}`);

const named = kept.filter((k) => k.name);
console.log(`[build-launches] ${named.length} named (${kept.length - named.length} unnamed)`);

const out = {
  launches: kept,
  meta: {
    n: kept.length,
    by_type: byType,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(`[build-launches] wrote ${OUT_PATH} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);

// Print a few examples for spot-checking
console.log('\nfirst 5:');
for (const k of kept.slice(0, 5)) console.log(`  ${k.type.padEnd(8)} ${(k.along_m / 1000).toFixed(2)} km  ${(k.name || '—').padEnd(34)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
console.log('last 5:');
for (const k of kept.slice(-5)) console.log(`  ${k.type.padEnd(8)} ${(k.along_m / 1000).toFixed(2)} km  ${(k.name || '—').padEnd(34)} (${k.lat.toFixed(4)}, ${k.lng.toFixed(4)})`);
