// Diagnostic: show stitch-graph component structure for one named waterway.
//
// Fetches all OSM `way["waterway"=river]["name"=<NAME>]` in the Thames-corridor
// bbox, builds the endpoint graph the stitcher sees, and prints:
//   - number of connected components + top-10 sizes
//   - endpoint bbox for the five biggest components
//   - haversine min-gap between the two biggest (how close a single edge
//     would need to bridge to make them one component)
//
// Use when build-tributaries produces a suspiciously short polyline — tells
// you whether the named ways form one chain, several islands, or whether an
// aggregate "overview" way is short-circuiting dijkstra.
//
// Usage:  node scripts/utils/diag-stitch.mjs "River Thame"
// Output: stdout only (no files written)

import { overpass } from './overpass.mjs';
import { haversine } from '../../lib/geo.mjs';

const NAME = process.argv[2] || 'River Thame';
const BB = '51.20,-1.95,52.10,-0.25';
const q = `[out:json][timeout:120];
way["waterway"="river"]["name"="${NAME}"](${BB});
out geom qt;`;

const j = await overpass(q);
const ways = (j.elements || []).filter((e) => e.type === 'way' && e.geometry?.length >= 2);
console.log(`${NAME}: ${ways.length} ways`);

const keyFor = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
const nodes = new Map();
for (let wi = 0; wi < ways.length; wi++) {
  const g = ways[wi].geometry;
  const a = g[0], b = g[g.length - 1];
  const aKey = keyFor(a.lat, a.lon), bKey = keyFor(b.lat, b.lon);
  if (aKey === bKey) continue;
  if (!nodes.has(aKey)) nodes.set(aKey, { lat: a.lat, lng: a.lon, edges: [] });
  if (!nodes.has(bKey)) nodes.set(bKey, { lat: b.lat, lng: b.lon, edges: [] });
  nodes.get(aKey).edges.push(bKey);
  nodes.get(bKey).edges.push(aKey);
}

// BFS components.
const comp = new Map();
let nc = 0;
for (const start of nodes.keys()) {
  if (comp.has(start)) continue;
  const cid = nc++;
  const stack = [start];
  while (stack.length) {
    const k = stack.pop();
    if (comp.has(k)) continue;
    comp.set(k, cid);
    for (const o of nodes.get(k).edges) if (!comp.has(o)) stack.push(o);
  }
}
const sizes = new Array(nc).fill(0);
for (const cid of comp.values()) sizes[cid]++;
sizes.sort((a, b) => b - a);
console.log('components:', nc, 'sizes top-10:', sizes.slice(0, 10));

// For each component, compute endpoint bbox.
const byComp = new Map();
for (const [k, cid] of comp) {
  if (!byComp.has(cid)) byComp.set(cid, []);
  byComp.get(cid).push(nodes.get(k));
}
const entries = [...byComp.entries()].sort((a, b) => b[1].length - a[1].length);
for (let i = 0; i < Math.min(5, entries.length); i++) {
  const [cid, ns] = entries[i];
  let latMin=90,latMax=-90,lngMin=180,lngMax=-180;
  for (const n of ns) {
    if (n.lat<latMin)latMin=n.lat; if(n.lat>latMax)latMax=n.lat;
    if (n.lng<lngMin)lngMin=n.lng; if(n.lng>lngMax)lngMax=n.lng;
  }
  console.log(`  comp #${cid}: ${ns.length} nodes  bbox=${latMin.toFixed(3)},${lngMin.toFixed(3)}→${latMax.toFixed(3)},${lngMax.toFixed(3)}`);
}

// Minimum inter-component distance (how close are the two biggest components?)
if (entries.length >= 2) {
  const [, a] = entries[0];
  const [, b] = entries[1];
  let min = Infinity;
  for (const na of a) for (const nb of b) {
    const d = haversine([na.lat, na.lng], [nb.lat, nb.lng]);
    if (d < min) min = d;
  }
  console.log(`  min gap between #0 and #1: ${min.toFixed(0)} m`);
}
