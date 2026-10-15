// Build the Thames Path National Trail polyline (source → Thames Barrier).
//
// Pipeline (shared with build-thames via utils/build-corridor):
//   1. Fetch the OSM hiking route relation(s) named "Thames Path" (recursively
//      including any sub-relation members), with inlined way geometries.
//   2. Flatten members in relation order; chain each way head-to-tail, flipping
//      where needed to maintain continuity. Report any gaps >50 m.
//   3. Orient so the chain runs source → sea.
//   4. Simplify, cumulate, validate against length + endpoint landmarks.
//   5. Write data/thames-path.json.
//
// Usage:  node scripts/build-thames-path.mjs
// Output: /workspace/data/thames-path.json

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { haversine } from './utils/geo.mjs';
import { buildCorridor } from './utils/build-corridor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'thames-path.json');

// Thames Head near Kemble — the canonical trail start.
const THAMES_SOURCE = [51.6967, -2.0317];

const QUERY = `
[out:json][timeout:180];
relation["type"="route"]["route"="hiking"]["name"="Thames Path"];
(._;>>;);
out geom;
`.trim();

async function fetchCoords() {
  const json = await overpass(QUERY, { cachePath: '/tmp/tp-overpass-cache.json' });
  const elements = json.elements || [];
  console.log(`[thames-path] got ${elements.length} elements`);

  const byId = new Map();
  for (const el of elements) byId.set(`${el.type}/${el.id}`, el);

  const topRels = elements.filter(
    (e) => e.type === 'relation'
      && e.tags?.type === 'route'
      && e.tags?.route === 'hiking'
      && e.tags?.name === 'Thames Path',
  );
  if (topRels.length === 0) throw new Error('[thames-path] no matching route relation found');
  console.log(
    `[thames-path] found ${topRels.length} top-level relation(s): ` +
    topRels.map((r) => `${r.id}(ref=${r.tags?.ref ?? ''})`).join(', '),
  );

  // Flatten members in relation order; recurse into sub-relations once each.
  function flatten(relId, seen = new Set()) {
    if (seen.has(relId)) return [];
    seen.add(relId);
    const rel = byId.get(`relation/${relId}`);
    const out = [];
    for (const m of rel?.members ?? []) {
      if (m.type === 'way' && Array.isArray(m.geometry)) {
        out.push({ geometry: m.geometry, role: m.role, ref: m.ref });
      } else if (m.type === 'relation') {
        out.push(...flatten(m.ref, seen));
      }
    }
    return out;
  }

  // Choose the top relation that yields the longest chain (if OSM has more
  // than one match — e.g. historical variants).
  let best = null;
  for (const top of topRels) {
    const ways = flatten(top.id);
    const { coords, gapsFixed, maxGapM } = chain(ways);
    const lengthM = polylineLength(coords);
    console.log(
      `[thames-path] rel ${top.id}: ${ways.length} ways → ${coords.length} pts, ` +
      `${(lengthM / 1000).toFixed(1)} km, ${gapsFixed} gaps >50 m (max ${maxGapM.toFixed(0)} m)`,
    );
    if (!best || lengthM > best.lengthM) {
      best = { coords, lengthM, osmRelId: top.id, ref: top.tags?.ref ?? null, gapsFixed, maxGapM };
    }
  }

  // Orient source → sea (the chain can emerge either way depending on the
  // first way's recorded direction).
  if (haversine(best.coords[0], THAMES_SOURCE) > haversine(best.coords[best.coords.length - 1], THAMES_SOURCE)) {
    best.coords.reverse();
  }
  const src = best.coords[0];
  const snk = best.coords[best.coords.length - 1];
  const sourceOffsetM = haversine(src, THAMES_SOURCE);
  console.log(`[thames-path] start: lat=${src[0]} lng=${src[1]} (source offset ${sourceOffsetM.toFixed(0)} m)`);
  console.log(`[thames-path] end:   lat=${snk[0]} lng=${snk[1]}`);

  return {
    coords: best.coords,
    meta: {
      osm_rel_id: best.osmRelId,
      ref: best.ref,
      start: { lat: src[0], lng: src[1] },
      end: { lat: snk[0], lng: snk[1] },
      source_offset_m: Math.round(sourceOffsetM),
      gaps_over_50m: best.gapsFixed,
      max_gap_m: Math.round(best.maxGapM),
    },
  };
}

// Chain member ways end-to-end. For each way, pick the orientation whose head
// is closer to the current tail; the resulting gap is the inter-way jump
// (should be ~0 at properly-connected OSM joints, up to a few m otherwise).
function chain(ways) {
  if (ways.length === 0) throw new Error('[thames-path] no ways to chain');
  const toLatLng = (geom) => geom.map((p) => [p.lat, p.lon]);
  let maxGapM = 0;
  let gapsFixed = 0;

  // Orient the first way using the second: whichever of its ends is closer to
  // an end of the second way is the "tail" we want.
  let first = toLatLng(ways[0].geometry);
  if (ways.length > 1) {
    const next = toLatLng(ways[1].geometry);
    const nextEnds = [next[0], next[next.length - 1]];
    const tailMin = Math.min(...nextEnds.map((p) => haversine(first[first.length - 1], p)));
    const headMin = Math.min(...nextEnds.map((p) => haversine(first[0], p)));
    if (headMin < tailMin) first.reverse();
  }
  const coords = [...first];

  for (let i = 1; i < ways.length; i++) {
    let g = toLatLng(ways[i].geometry);
    const tail = coords[coords.length - 1];
    const dFwd = haversine(tail, g[0]);
    const dRev = haversine(tail, g[g.length - 1]);
    if (dRev < dFwd) g.reverse();
    const gap = Math.min(dFwd, dRev);
    if (gap > maxGapM) maxGapM = gap;
    if (gap > 50) gapsFixed++;
    const startIdx = gap < 1 ? 1 : 0;
    for (let k = startIdx; k < g.length; k++) coords.push(g[k]);
  }
  return { coords, gapsFixed, maxGapM };
}

function polylineLength(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}

function validate({ coords, lengthM, fetchMeta }) {
  const errs = [];
  if (coords.length < 1000) errs.push(`too few points: ${coords.length} (expected ≥1000)`);
  // Published National Trail length: ~184 mi / 296 km (source → Thames Barrier),
  // ~190 mi / 306 km (post-2022 Woolwich extension). OSM today carries it a bit
  // further still, down to Crayford Ness.
  if (lengthM < 290_000 || lengthM > 325_000) errs.push(`unexpected length ${(lengthM / 1000).toFixed(1)} km (expected 290–325)`);
  if (fetchMeta.source_offset_m > 3000) errs.push(`start is ${fetchMeta.source_offset_m} m from Thames Head — expected ≤3000`);
  // East terminus bbox: SE London/Kent, east of Greenwich.
  const [endLat, endLng] = [fetchMeta.end.lat, fetchMeta.end.lng];
  if (endLng < 0 || endLng > 0.3 || endLat < 51.4 || endLat > 51.55) {
    errs.push(`east terminus ${endLat.toFixed(4)},${endLng.toFixed(4)} outside expected SE-London bbox`);
  }
  if (fetchMeta.max_gap_m > 500) errs.push(`max inter-way gap ${fetchMeta.max_gap_m} m — chain may be broken`);
  if (errs.length) throw new Error('build-thames-path validation failed:\n  - ' + errs.join('\n  - '));
  console.log('[thames-path] ✓ validation passed');
}

buildCorridor({
  label: 'thames-path',
  outPath: OUT_PATH,
  simplifyMeters: 3,
  fetchCoords,
  validate,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
