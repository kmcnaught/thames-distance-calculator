// Build the bus-routes overlay dataset for both apps.
//
// Source: OSM `route=bus` relations whose stops include at least one
// `highway=bus_stop` node within 1 mi of the Thames Path corridor. (The
// path's 1-mi buffer fully contains the river's — same reasoning as the
// accommodation/stations builds.)
//
// Pipeline:
//   1. Overpass: all bus_stop nodes near the trail, then every bus route
//      relation referencing them, with inline member way geometry.
//   2. For each route relation, chain member ways end-to-end into one
//      ordered polyline (route-ways in OSM are usually recorded in
//      traversal order; flip where needed).
//   3. Simplify each polyline to a few metres' tolerance.
//   4. Collect the route's stops (member nodes with role stop/platform).
//      Snap each stop to the river and the path; keep both along_* fields.
//   5. Welsh-Powell graph-colour routes: two routes are adjacent iff they
//      share ≥2 stops. 12-colour palette.
//   6. Write data/bus-routes.json.
//
// Usage: node scripts/build-bus-routes.mjs
// Output: data/bus-routes.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { haversine, simplify, snap } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RIVER_FILE = resolve(__dirname, '..', 'data', 'thames.json');
const PATH_FILE  = resolve(__dirname, '..', 'data', 'thames-path.json');
const OUT_PATH   = resolve(__dirname, '..', 'data', 'bus-routes.json');
const CACHE_PATH = '/tmp/bus-routes-cache.json';

const CORRIDOR_M = 1609;
const ANCHOR_SPACING_M = 800;        // wider than accommodation — the response blows up fast
const SIMPLIFY_M = 4;

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
console.log(`[bus-routes] ${anchors.length} path anchors at ${ANCHOR_SPACING_M} m`);

// stops → relations → geometry, all in one call. `out geom` on a relation
// expands each member — ways with inline coord lists and nodes with lat/lon
// — so route polylines AND stop coordinates come from one place. The
// standalone `.stops out tags` is kept only to supply stop *names*.
const QUERY = `
[out:json][timeout:300];
node["highway"="bus_stop"](around:${CORRIDOR_M},${aroundList})->.stops;
.stops out tags;
rel(bn.stops)["type"="route"]["route"="bus"]->.routes;
.routes out geom;
`.trim();

console.log('[bus-routes] fetching Overpass… (this is a big one)');
const json = await overpass(QUERY, { cachePath: CACHE_PATH, timeoutMs: 420_000 });
const elements = json.elements || [];
const stopEls = elements.filter((e) => e.type === 'node' && e.tags?.highway === 'bus_stop');
const routeEls = elements.filter((e) => e.type === 'relation' && e.tags?.type === 'route' && e.tags?.route === 'bus');
console.log(`[bus-routes] ${stopEls.length} stops, ${routeEls.length} relations`);

// --- Chain member ways into one or more polyline segments ----------------
//
// OSM bus-route relations are *usually* ordered by traversal, but mappers
// occasionally slot a branch or a variant into the middle of the list, and
// some are modelled as separate "outbound" / "inbound" halves bolted
// together. Blindly chaining head-to-tail then produces long straight-line
// bridges across those discontinuities.
//
// Instead: still orient each way nose-to-tail, but if the gap exceeds
// GAP_SPLIT_M we end the current segment and start a new one. Leaflet
// renders an array-of-arrays as a multi-polyline (one layer, multiple
// disconnected lines) so the renderer side doesn't care.
const GAP_SPLIT_M = 200;

function chainWays(members) {
  const ways = members
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2)
    .map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  if (ways.length === 0) return { segments: [], maxGapM: 0, splits: 0 };
  if (ways.length === 1) return { segments: [ways[0].slice()], maxGapM: 0, splits: 0 };

  // Orient the first way using the second.
  let first = ways[0].slice();
  const next = ways[1];
  const nextEnds = [next[0], next[next.length - 1]];
  const tailMin = Math.min(...nextEnds.map((p) => haversine(first[first.length - 1], p)));
  const headMin = Math.min(...nextEnds.map((p) => haversine(first[0], p)));
  if (headMin < tailMin) first.reverse();

  const segments = [[...first]];
  let maxGapM = 0;
  let splits = 0;

  for (let i = 1; i < ways.length; i++) {
    let g = ways[i].slice();
    const cur = segments[segments.length - 1];
    const tail = cur[cur.length - 1];
    const dFwd = haversine(tail, g[0]);
    const dRev = haversine(tail, g[g.length - 1]);
    if (dRev < dFwd) g.reverse();
    const gap = Math.min(dFwd, dRev);
    if (gap > maxGapM) maxGapM = gap;
    if (gap > GAP_SPLIT_M) {
      segments.push(g);
      splits++;
      continue;
    }
    const startIdx = gap < 1 ? 1 : 0;
    for (let k = startIdx; k < g.length; k++) cur.push(g[k]);
  }
  return { segments, maxGapM, splits };
}

function totalVertices(segments) {
  let n = 0;
  for (const s of segments) n += s.length;
  return n;
}

// --- Build routes --------------------------------------------------------

const stopById = new Map();
for (const s of stopEls) stopById.set(s.id, s);

const stopsInUse = new Map();   // id → { id, name, lat, lng, routes: [routeKey] }
const routesByKey = new Map();  // dedupe key → route record

// Stops first — coords come from route-member node entries (since the
// standalone `.stops out tags` output omits lat/lon). Names come from
// stopById (which has tags but no coords).
const stopCoordById = new Map();  // id → [lat, lng]
for (const rel of routeEls) {
  for (const m of rel.members || []) {
    if (m.type !== 'node') continue;
    if (typeof m.lat !== 'number' || typeof m.lon !== 'number') continue;
    if (!stopCoordById.has(m.ref)) stopCoordById.set(m.ref, [m.lat, m.lon]);
  }
}

let totalSplits = 0;
let routesWithSplits = 0;

for (const rel of routeEls) {
  const t = rel.tags || {};
  const members = rel.members || [];
  const { segments, splits } = chainWays(members);
  if (segments.length === 0) continue;
  const simplifiedSegs = segments
    .map((seg) => simplify(seg, SIMPLIFY_M))
    .filter((seg) => seg.length >= 2);
  if (simplifiedSegs.length === 0) continue;
  if (splits > 0) { totalSplits += splits; routesWithSplits++; }

  // Collect stop member refs. OSM bus-route schema uses stop/stop_entry_only/
  // stop_exit_only for actual stops and platform* for the pavement objects;
  // both commonly appear. We accept either, then dedupe by node id, and
  // intersect with the set of nodes Overpass tagged bus_stop within corridor.
  const stopIds = [];
  for (const m of members) {
    if (m.type !== 'node') continue;
    const role = (m.role || '').toLowerCase();
    if (role.startsWith('stop') || role.startsWith('platform')) stopIds.push(m.ref);
  }
  const uniqStopIds = Array.from(new Set(stopIds));
  const inCorridorStops = uniqStopIds.filter((id) => stopById.has(id));
  if (inCorridorStops.length === 0) continue;

  const key = (t.operator || '?') + '|' + (t.ref || t.name || '?') + '|' + (t.from || '') + '→' + (t.to || '');
  const existing = routesByKey.get(key);
  const newLen = totalVertices(simplifiedSegs);
  if (existing && totalVertices(existing.geometry) >= newLen) {
    for (const sid of inCorridorStops) existing.stop_ids.push(sid);
    continue;
  }

  routesByKey.set(key, {
    osm_id: rel.id,
    key,
    ref: t.ref || null,
    name: t.name || null,
    operator: t.operator || null,
    network: t.network || null,
    from: t.from || null,
    to: t.to || null,
    colour_tag: t.colour || null,
    geometry: simplifiedSegs,   // array of polylines (multi-polyline)
    stop_ids: [...inCorridorStops],
  });
}

console.log(`[bus-routes] chain splits: ${routesWithSplits} routes had ≥1 gap >${GAP_SPLIT_M} m (${totalSplits} splits total)`);

for (const r of routesByKey.values()) r.stop_ids = Array.from(new Set(r.stop_ids));

const routes = Array.from(routesByKey.values());
console.log(`[bus-routes] ${routes.length} route records after dedupe`);

// Build stop records: coords from the route-member index, names (and the
// bus_stop membership check) from stopById.
for (const r of routes) {
  for (const sid of r.stop_ids) {
    if (!stopsInUse.has(sid)) {
      const n = stopById.get(sid);
      const coord = stopCoordById.get(sid);
      if (!n || !coord) continue;
      stopsInUse.set(sid, {
        id: sid, name: n.tags?.name || null, lat: coord[0], lng: coord[1], routes: [],
      });
    }
    stopsInUse.get(sid).routes.push(r.key);
  }
}
const stops = Array.from(stopsInUse.values());
for (const s of stops) {
  const snR = snap(river.coords, river.cum, [s.lat, s.lng]);
  const snP = snap(path.coords,  path.cum,  [s.lat, s.lng]);
  s.along_river_m = snR.off <= CORRIDOR_M ? Math.round(snR.along) : null;
  s.along_path_m  = snP.off <= CORRIDOR_M ? Math.round(snP.along) : null;
}
const nearRiver = stops.filter((s) => s.along_river_m != null).length;
const nearPath  = stops.filter((s) => s.along_path_m  != null).length;
console.log(`[bus-routes] stops: ${stops.length} total; near river ${nearRiver}, near path ${nearPath}`);

// --- Welsh-Powell graph colouring ---------------------------------------

// Build the adjacency: two routes are adjacent iff they share ≥2 stops.
// Shared-stop count comes from the inverse (stop → routes) index.
const neighbours = new Map();
for (const r of routes) neighbours.set(r.key, new Set());
const shareCount = new Map();   // "a|b" key, a<b → count
for (const s of stops) {
  const rs = s.routes;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const k = a < b ? a + '§' + b : b + '§' + a;
      shareCount.set(k, (shareCount.get(k) || 0) + 1);
    }
  }
}
for (const [k, c] of shareCount) {
  if (c < 2) continue;
  const [a, b] = k.split('§');
  neighbours.get(a).add(b);
  neighbours.get(b).add(a);
}

// 12-colour palette (ColorBrewer Set3-ish, tuned for white backgrounds).
const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf', '#aec7e8', '#ffbb78',
];

// Welsh-Powell: sort by degree desc, greedily assign lowest unused colour.
const order = routes.slice().sort((a, b) => neighbours.get(b.key).size - neighbours.get(a.key).size);
const colourOf = new Map();
let paletteExhausted = 0;
for (const r of order) {
  const used = new Set();
  for (const nb of neighbours.get(r.key)) {
    if (colourOf.has(nb)) used.add(colourOf.get(nb));
  }
  let chosen = PALETTE.find((c) => !used.has(c));
  if (!chosen) {
    chosen = PALETTE[paletteExhausted++ % PALETTE.length];
  }
  colourOf.set(r.key, chosen);
  r.colour = chosen;
}
console.log(`[bus-routes] coloured ${routes.length} routes${paletteExhausted ? ` (palette exhausted ${paletteExhausted}× — pattern repeats on dense junctions)` : ''}`);

// --- Write ---------------------------------------------------------------

// Final shape: `routes` keyed by `key` (the dedupe key) for the stop→routes
// cross-reference; `stops` keeps its route-id list and corridor snaps.
const routesOut = {};
for (const r of routes) {
  routesOut[r.key] = {
    osm_id: r.osm_id,
    ref: r.ref,
    name: r.name,
    operator: r.operator,
    network: r.network,
    from: r.from,
    to: r.to,
    colour: r.colour,
    geometry: r.geometry,
    stop_count: r.stop_ids.length,
  };
}

const payload = {
  routes: routesOut,
  stops,
  meta: {
    n_routes: routes.length,
    n_stops: stops.length,
    n_stops_near_river: nearRiver,
    n_stops_near_path:  nearPath,
    corridor_m: CORRIDOR_M,
    palette: PALETTE,
    palette_exhausted: paletteExhausted,
    generated_at: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  },
};
writeFileSync(OUT_PATH, JSON.stringify(payload));
console.log(`[bus-routes] wrote ${OUT_PATH} (${(JSON.stringify(payload).length / 1024).toFixed(1)} KiB)`);
