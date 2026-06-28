// Debug: print connected-component analysis of OSM "River Thames" ways.
// Tells us whether the disconnection is many tiny micro-gaps (fixable by a
// nearest-endpoint bridge) or a few macro-fragments (relation query needed).
//
// Usage: node scripts/debug-components.mjs

import { overpass } from './utils/overpass.mjs';
import { haversine } from './utils/geo.mjs';

const keyFor = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

const QUERY = `
[out:json][timeout:180];
way["waterway"="river"]["name"="River Thames"];
out geom;
`.trim();

const json = await overpass(QUERY);
const ways = (json.elements || []).filter((e) => e.type === 'way' && e.geometry?.length >= 2);
console.log(`ways: ${ways.length}`);

const nodes = new Map();
for (let wi = 0; wi < ways.length; wi++) {
  const geom = ways[wi].geometry;
  const a = geom[0], b = geom[geom.length - 1];
  const aKey = keyFor(a.lat, a.lon);
  const bKey = keyFor(b.lat, b.lon);
  if (aKey === bKey) continue;
  let len = 0;
  for (let i = 1; i < geom.length; i++) {
    len += haversine([geom[i - 1].lat, geom[i - 1].lon], [geom[i].lat, geom[i].lon]);
  }
  if (!nodes.has(aKey)) nodes.set(aKey, { lat: a.lat, lng: a.lon, edges: [] });
  if (!nodes.has(bKey)) nodes.set(bKey, { lat: b.lat, lng: b.lon, edges: [] });
  nodes.get(aKey).edges.push({ otherKey: bKey, len, wayIdx: wi });
  nodes.get(bKey).edges.push({ otherKey: aKey, len, wayIdx: wi });
}
console.log(`nodes: ${nodes.size}`);

const componentOf = new Map();
const comps = [];
for (const startKey of nodes.keys()) {
  if (componentOf.has(startKey)) continue;
  const cid = comps.length;
  comps.push({ keys: [], lengthM: 0, ways: new Set() });
  const stack = [startKey];
  while (stack.length) {
    const k = stack.pop();
    if (componentOf.has(k)) continue;
    componentOf.set(k, cid);
    comps[cid].keys.push(k);
    for (const edge of nodes.get(k).edges) {
      comps[cid].ways.add(edge.wayIdx);
      if (!componentOf.has(edge.otherKey)) stack.push(edge.otherKey);
    }
  }
}
// Compute per-component length (count each way once)
for (const c of comps) {
  for (const wi of c.ways) {
    const g = ways[wi].geometry;
    for (let i = 1; i < g.length; i++) {
      c.lengthM += haversine([g[i - 1].lat, g[i - 1].lon], [g[i].lat, g[i].lon]);
    }
  }
}

comps.sort((a, b) => b.lengthM - a.lengthM);
console.log(`components: ${comps.length}`);
console.log('top 15 by length:');
for (let i = 0; i < Math.min(15, comps.length); i++) {
  const c = comps[i];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const k of c.keys) {
    const n = nodes.get(k);
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lng < minLng) minLng = n.lng;
    if (n.lng > maxLng) maxLng = n.lng;
  }
  console.log(`  [${i}] nodes=${c.keys.length} ways=${c.ways.size} len=${(c.lengthM / 1000).toFixed(1)}km bbox=lat[${minLat.toFixed(3)},${maxLat.toFixed(3)}] lng[${minLng.toFixed(3)},${maxLng.toFixed(3)}]`);
}

// Pairwise nearest-endpoint distances between top 6 components
console.log('\nnearest-endpoint distance between top 6 components:');
const top = comps.slice(0, 6);
for (let i = 0; i < top.length; i++) {
  for (let j = i + 1; j < top.length; j++) {
    let minD = Infinity, pairA = null, pairB = null;
    for (const ka of top[i].keys) {
      const na = nodes.get(ka);
      // Only check endpoints with odd degree (true endpoints, not junctions)
      if (na.edges.length !== 1) continue;
      for (const kb of top[j].keys) {
        const nb = nodes.get(kb);
        if (nb.edges.length !== 1) continue;
        const d = haversine([na.lat, na.lng], [nb.lat, nb.lng]);
        if (d < minD) { minD = d; pairA = na; pairB = nb; }
      }
    }
    if (pairA) {
      console.log(`  [${i}]-[${j}] nearest=${minD.toFixed(1)}m  A=(${pairA.lat.toFixed(4)},${pairA.lng.toFixed(4)})  B=(${pairB.lat.toFixed(4)},${pairB.lng.toFixed(4)})`);
    }
  }
}
