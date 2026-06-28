// Stitch unordered OSM `way` segments into one ordered channel from the
// westmost endpoint to the nearest endpoint to a target (used for clipping
// to Teddington Lock = non-tidal terminus). Per THAMES_HANDOFF.md §5.
//
// Input: array of Overpass ways with `geometry: [{lat, lon}, ...]`.
// Output: { coords: [[lat,lng],...], meta: { source, sink, sinkOffsetM } }
//
// Algorithm:
//   1. Graph: nodes = way endpoints (key = "lat,lng" to 5 dp); edges = ways
//      weighted by haversine length along their full geometry.
//   2. Source = westmost endpoint; sink = endpoint closest to target latlng.
//   3. Dijkstra source→sink (naive O(V^2); fine at hundreds of nodes).
//   4. Reconstruct: concat each way's geometry in traversal order, reversing
//      when traversed tail-first, dedup shared endpoints.

import { haversine } from './geo.mjs';

const keyFor = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

export function stitch(ways, sinkTarget) {
  const nodes = new Map();

  for (let wi = 0; wi < ways.length; wi++) {
    const geom = ways[wi].geometry;
    if (!geom || geom.length < 2) continue;
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
    nodes.get(aKey).edges.push({ otherKey: bKey, len, wayIdx: wi, reverse: false });
    nodes.get(bKey).edges.push({ otherKey: aKey, len, wayIdx: wi, reverse: true });
  }

  if (nodes.size === 0) throw new Error('stitch: no usable ways');

  // Bridge micro-gaps: OSM occasionally has near-coincident endpoints that
  // should share a node but don't (a few metres apart). Add bridge edges
  // (wayIdx = null) between any pair of nodes within `bridgeThresholdM`.
  // Threshold is tight enough to ignore real side channels (>100m away).
  const bridgeThresholdM = 50;
  let nBridges = 0;
  const keysArr = [...nodes.keys()];
  for (let i = 0; i < keysArr.length; i++) {
    const ni = nodes.get(keysArr[i]);
    for (let j = i + 1; j < keysArr.length; j++) {
      const nj = nodes.get(keysArr[j]);
      const d = haversine([ni.lat, ni.lng], [nj.lat, nj.lng]);
      if (d > 0 && d < bridgeThresholdM) {
        ni.edges.push({ otherKey: keysArr[j], len: d, wayIdx: null, reverse: false });
        nj.edges.push({ otherKey: keysArr[i], len: d, wayIdx: null, reverse: false });
        nBridges++;
      }
    }
  }

  // Find connected components via BFS, then operate on the largest one.
  // OSM has fragments (side channels, disconnected named-Thames pieces) that
  // confuse a naive westmost/eastmost pick — §5 of THAMES_HANDOFF.md warns.
  const componentOf = new Map();
  let nComponents = 0;
  for (const startKey of nodes.keys()) {
    if (componentOf.has(startKey)) continue;
    const cid = nComponents++;
    const stack = [startKey];
    while (stack.length) {
      const k = stack.pop();
      if (componentOf.has(k)) continue;
      componentOf.set(k, cid);
      for (const edge of nodes.get(k).edges) {
        if (!componentOf.has(edge.otherKey)) stack.push(edge.otherKey);
      }
    }
  }
  const compSizes = new Array(nComponents).fill(0);
  for (const cid of componentOf.values()) compSizes[cid]++;
  const mainCid = compSizes.indexOf(Math.max(...compSizes));

  let sourceKey = null, srcLng = Infinity;
  let sinkKey = null, sinkOffsetM = Infinity;
  for (const [key, n] of nodes) {
    if (componentOf.get(key) !== mainCid) continue;
    if (n.lng < srcLng) { srcLng = n.lng; sourceKey = key; }
    const d = haversine([n.lat, n.lng], sinkTarget);
    if (d < sinkOffsetM) { sinkOffsetM = d; sinkKey = key; }
  }

  const dist = new Map(), prev = new Map(), visited = new Set();
  for (const key of nodes.keys()) dist.set(key, Infinity);
  dist.set(sourceKey, 0);

  while (true) {
    let u = null, uD = Infinity;
    for (const [key, d] of dist) {
      if (!visited.has(key) && d < uD) { u = key; uD = d; }
    }
    if (u === null) break;
    if (u === sinkKey) break;
    visited.add(u);
    for (const edge of nodes.get(u).edges) {
      const nd = uD + edge.len;
      if (nd < dist.get(edge.otherKey)) {
        dist.set(edge.otherKey, nd);
        prev.set(edge.otherKey, { fromKey: u, wayIdx: edge.wayIdx, reverse: edge.reverse });
      }
    }
  }

  if (!Number.isFinite(dist.get(sinkKey))) {
    throw new Error(`stitch: no path from source ${sourceKey} to sink ${sinkKey} — disconnected graph`);
  }

  const edges = [];
  let cur = sinkKey;
  while (cur !== sourceKey) {
    const p = prev.get(cur);
    if (!p) throw new Error(`stitch: broken predecessor chain at ${cur}`);
    edges.unshift({ ...p, toKey: cur });
    cur = p.fromKey;
  }

  const coords = [];
  for (const e of edges) {
    if (e.wayIdx === null) {
      // Bridge across an OSM micro-gap (<50m). Just append the destination
      // node — the straight-line jump is negligible at river scale.
      const n = nodes.get(e.toKey);
      coords.push([n.lat, n.lng]);
      continue;
    }
    let geom = ways[e.wayIdx].geometry.map((g) => [g.lat, g.lon]);
    if (e.reverse) geom.reverse();
    if (coords.length === 0) {
      coords.push(...geom);
    } else {
      for (let i = 1; i < geom.length; i++) coords.push(geom[i]);
    }
  }

  return {
    coords,
    meta: {
      source: nodes.get(sourceKey),
      sink: nodes.get(sinkKey),
      sourceKey,
      sinkKey,
      sinkOffsetM,
      pathLengthM: dist.get(sinkKey),
      nodeCount: nodes.size,
      wayCount: ways.length,
      componentCount: nComponents,
      mainComponentSize: compSizes[mainCid],
      bridges: nBridges,
    },
  };
}
