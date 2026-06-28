// Geo utilities for snapping points to a river centreline and measuring
// distances along it. Canonical location: imported by both the browser app
// (app.js) and the build pipeline (scripts/*.mjs).
//
// Coordinate convention: [lat, lng] everywhere. Leaflet-native; convert at
// boundaries (Overpass `out geom` gives {lat, lon}, Natural Earth gives
// [lng, lat]).
//
// Algorithm reference: THAMES_HANDOFF.md §4 (validated in Node).

const R = 6371000;
const D2R = Math.PI / 180;

export function haversine(a, b) {
  const la1 = a[0] * D2R, la2 = b[0] * D2R;
  const dla = (b[0] - a[0]) * D2R, dlo = (b[1] - a[1]) * D2R;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function buildCum(line) {
  const c = new Array(line.length);
  c[0] = 0;
  for (let i = 1; i < line.length; i++) c[i] = c[i - 1] + haversine(line[i - 1], line[i]);
  return c;
}

// Project target onto each segment in a local equirectangular metre space.
// Good at river scale; the cos(lat) factor handles longitude shrink.
export function snap(line, cum, target) {
  let best = { d2: Infinity, i: 0, t: 0 };
  const mLat = 111320;
  const mLng = 111320 * Math.cos(target[0] * D2R);
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][1] - target[1]) * mLng;
    const ay = (line[i][0] - target[0]) * mLat;
    const bx = (line[i + 1][1] - target[1]) * mLng;
    const by = (line[i + 1][0] - target[0]) * mLat;
    const ux = bx - ax, uy = by - ay;
    const uu = ux * ux + uy * uy;
    let t = uu > 0 ? -(ax * ux + ay * uy) / uu : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * ux, py = ay + t * uy;
    const d2 = px * px + py * py;
    if (d2 < best.d2) best = { d2, i, t };
  }
  const A = line[best.i], B = line[best.i + 1];
  const latlng = [A[0] + best.t * (B[0] - A[0]), A[1] + best.t * (B[1] - A[1])];
  return {
    latlng,
    along: cum[best.i] + haversine(A, latlng),
    off: Math.sqrt(best.d2),
    i: best.i,
    t: best.t,
  };
}

export function measure(line, cum, ptA, ptB) {
  const a = snap(line, cum, ptA);
  const b = snap(line, cum, ptB);
  const river = Math.abs(a.along - b.along);
  const straight = haversine(a.latlng, b.latlng);
  return {
    river,
    straight,
    sinuosity: straight > 0 ? river / straight : 1,
    upstream: a.along < b.along ? 'A' : 'B',
    a,
    b,
  };
}

// The highlighted stretch source→sea between the two snaps.
export function reachPts(line, a, b) {
  if (a.along > b.along) [a, b] = [b, a];
  const pts = [a.latlng.slice()];
  for (let k = a.i + 1; k <= b.i; k++) pts.push(line[k]);
  pts.push(b.latlng.slice());
  return pts;
}

// Douglas–Peucker simplification with tolerance in metres.
// Uses a local equirectangular projection around the line's midpoint.
export function simplify(line, toleranceMeters) {
  if (line.length < 3) return line.slice();
  const midLat = line[Math.floor(line.length / 2)][0];
  const mLat = 111320;
  const mLng = 111320 * Math.cos(midLat * D2R);
  const xy = line.map(([lat, lng]) => [lng * mLng, lat * mLat]);
  const tol2 = toleranceMeters * toleranceMeters;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD2 = 0, idx = -1;
    const [sx, sy] = xy[s], [ex, ey] = xy[e];
    const ux = ex - sx, uy = ey - sy;
    const uu = ux * ux + uy * uy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i];
      const ax = px - sx, ay = py - sy;
      let t = uu > 0 ? (ax * ux + ay * uy) / uu : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = sx + t * ux - px, cy = sy + t * uy - py;
      const d2 = cx * cx + cy * cy;
      if (d2 > maxD2) { maxD2 = d2; idx = i; }
    }
    if (maxD2 > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < line.length; i++) if (keep[i]) out.push(line[i]);
  return out;
}
