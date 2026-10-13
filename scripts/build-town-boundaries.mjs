// Build town-shape polygons from OSM landuse=residential.
//
// For each town we care about, we query landuse=residential ways within a
// small bbox around the town centre and pick the polygon whose centroid is
// closest (falling back to the largest overlapping polygon if the closest one
// is a poor match). Polygons are simplified to a handful of points each; a
// town is typically one main residential area with a few outliers so we only
// keep the largest for each.
//
// Reads TOWN_CENTRES from an inline list (kept in sync with build-poster.mjs).
//
// Usage:  node scripts/build-town-boundaries.mjs
// Output: data/town-boundaries.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { simplify, haversine } from '../lib/geo.mjs';
// polygon-clipping is installed under /tmp/node_modules in this environment;
// import via a stable relative dep once we `npm install polygon-clipping` at repo.
import pc from '/tmp/node_modules/polygon-clipping/dist/polygon-clipping.esm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'town-boundaries.json');

// Towns to fetch. Radius is in km — search bbox is ±radius/111° around centre.
// Small towns get a tight bbox (avoids grabbing neighbouring settlements);
// bigger ones need a wider search.
const TOWNS = [
  // On-river towns
  { name: 'Cricklade',        lat: 51.6455, lng: -1.8580, radius_km: 1.5 },
  { name: 'Lechlade',         lat: 51.6923, lng: -1.6931, radius_km: 1.2 },
  { name: 'Newbridge',        lat: 51.7317, lng: -1.4130, radius_km: 0.6 },
  { name: 'Oxford',           lat: 51.7520, lng: -1.2577, radius_km: 5.0 },
  { name: 'Abingdon',         lat: 51.6714, lng: -1.2820, radius_km: 2.5 },
  { name: 'Dorchester',       lat: 51.6440, lng: -1.1655, radius_km: 1.2 },
  { name: 'Wallingford',      lat: 51.5992, lng: -1.1259, radius_km: 1.8 },
  { name: 'Goring',           lat: 51.5253, lng: -1.1408, radius_km: 1.5 },
  { name: 'Pangbourne',       lat: 51.4859, lng: -1.0876, radius_km: 1.2 },
  { name: 'Reading',          lat: 51.4543, lng: -0.9781, radius_km: 5.0 },
  { name: 'Henley-on-Thames', lat: 51.5361, lng: -0.9032, radius_km: 2.0 },
  { name: 'Marlow',           lat: 51.5710, lng: -0.7770, radius_km: 2.0 },
  { name: 'Maidenhead',       lat: 51.5218, lng: -0.7196, radius_km: 3.5 },
  { name: 'Windsor',          lat: 51.4823, lng: -0.6088, radius_km: 3.0 },
  { name: 'Staines',          lat: 51.4335, lng: -0.5100, radius_km: 2.5 },
  { name: 'Weybridge',        lat: 51.3722, lng: -0.4574, radius_km: 2.5 },
  { name: 'Kingston',         lat: 51.4123, lng: -0.3007, radius_km: 3.5 },
  { name: 'Teddington',       lat: 51.4272, lng: -0.3358, radius_km: 1.8 },

  // Off-river reference towns
  { name: 'Swindon',          lat: 51.5558, lng: -1.7797, radius_km: 5.0 },
  { name: 'Aylesbury',        lat: 51.8156, lng: -0.8084, radius_km: 3.5 },
  { name: 'High Wycombe',     lat: 51.6289, lng: -0.7482, radius_km: 3.5 },
  { name: 'Slough',           lat: 51.5105, lng: -0.5950, radius_km: 4.0 },
  { name: 'Bracknell',        lat: 51.4136, lng: -0.7515, radius_km: 3.0 },
  { name: 'Watford',          lat: 51.6565, lng: -0.3903, radius_km: 3.5 },
];

function bboxAround(lat, lng, km) {
  const dLat = km / 111;
  const dLng = dLat / Math.cos(lat * Math.PI / 180);
  return {
    south: lat - dLat, west: lng - dLng,
    north: lat + dLat, east: lng + dLng,
  };
}

function polygonAreaSqM(pts) {
  // Rough — uses local equirectangular projection.
  if (pts.length < 3) return 0;
  const midLat = pts[Math.floor(pts.length / 2)][0];
  const D2R = Math.PI / 180;
  const kLat = 111320;
  const kLng = 111320 * Math.cos(midLat * D2R);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [lat1, lng1] = pts[i];
    const [lat2, lng2] = pts[(i + 1) % pts.length];
    const x1 = lng1 * kLng, y1 = lat1 * kLat;
    const x2 = lng2 * kLng, y2 = lat2 * kLat;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function polygonCentroid(pts) {
  let sx = 0, sy = 0;
  for (const [lat, lng] of pts) { sy += lat; sx += lng; }
  return [sy / pts.length, sx / pts.length];
}

// Andrew's monotone-chain convex hull. Input: [[lat,lng], ...]. Output: hull
// in counter-clockwise order (in lat,lng — clockwise on-screen since lat is
// y-flipped, doesn't matter for a fill).
function convexHull(pts) {
  const p = [...new Map(pts.map(([lat, lng]) => [`${lat},${lng}`, [lat, lng]])).values()];
  if (p.length <= 2) return p.slice();
  p.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

async function fetchTownOnce(t) {
  const bb = bboxAround(t.lat, t.lng, t.radius_km);
  const q = `
[out:json][timeout:60];
(
  way["landuse"="residential"](${bb.south},${bb.west},${bb.north},${bb.east});
);
out geom;
`.trim();

  const j = await overpass(q);
  const ways = (j.elements || []).filter(
    (e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 4
  );

  const polys = ways.map((w) => w.geometry.map((g) => [g.lat, g.lon]));
  if (polys.length === 0) return null;

  // UK towns are typically mapped as many small per-neighbourhood residential
  // polygons rather than one big footprint. Emit all polygons within radius so
  // the town shape reads as the cluster of them. Drop trivially small ones
  // (< 0.01 km²) so we don't accumulate suburban gardens.
  const radiusM = t.radius_km * 1000;
  const kept = polys
    .map((pts) => {
      const cen = polygonCentroid(pts);
      const distM = haversine(cen, [t.lat, t.lng]);
      const areaM2 = polygonAreaSqM(pts);
      return { pts, distM, areaM2 };
    })
    .filter((c) => c.distM <= radiusM && c.areaM2 >= 10_000);
  if (kept.length === 0) return null;

  kept.sort((a, b) => b.areaM2 - a.areaM2);

  // Convex hull as a fallback shape.
  const allPts = [];
  for (const k of kept) for (const p of k.pts) allPts.push(p);
  const hull = convexHull(allPts);

  // Coalesce nearby polygons via a buffer + union. Each residential polygon
  // is inflated outward by ~120 m using a per-vertex edge-normal shift, then
  // all shifted polygons are unioned via polygon-clipping. Adjacent
  // neighbourhoods that were close but not touching in OSM end up as one blob.
  // polygon-clipping expects [x, y] = [lng, lat].
  const BUFFER_M = 120;
  const buffered = kept.map((k) => {
    const buf = bufferPolygon(k.pts, BUFFER_M);
    // Flip to [lng, lat] and wrap as a single-ring polygon.
    return [buf.map(([lat, lng]) => [lng, lat])];
  });

  let unionedRings = [];
  try {
    // pc.union takes any number of poly/multipoly args; returns MultiPolygon =
    // Array<Array<Ring>>. We keep only the outer ring of each polygon (no holes).
    const mp = pc.union(...buffered);
    unionedRings = mp.map((poly) => poly[0].map(([lng, lat]) => [lat, lng]));
  } catch (err) {
    console.warn(`[build-town-boundaries] union failed for ${t.name}: ${err.message}. Falling back to hull.`);
    unionedRings = [hull];
  }

  // Drop tiny fragments (< 5% of the biggest blob's area) so we keep the main
  // town shape without a scatter of outlying hamlets.
  const blobsWithArea = unionedRings.map((r) => ({ ring: r, area: polygonAreaSqM(r) }));
  blobsWithArea.sort((a, b) => b.area - a.area);
  const largestArea = blobsWithArea[0]?.area || 0;
  const blobs = blobsWithArea
    .filter((b) => b.area >= largestArea * 0.05)
    .map((b) => simplify(b.ring, 60));

  const totalArea = kept.reduce((s, k) => s + k.areaM2, 0);
  const blobsArea = blobsWithArea.reduce((s, b) => s + b.area, 0);

  return {
    name: t.name,
    lat: t.lat,
    lng: t.lng,
    source_polygon_count: kept.length,
    source_total_area_km2: totalArea / 1e6,
    blob_count: blobs.length,
    blob_area_km2: blobsArea / 1e6,
    hull_area_km2: polygonAreaSqM(hull) / 1e6,
    blobs,
    hull,
  };
}

// Simple polygon buffer: shift each vertex outward along the average edge
// normal by bufferM metres. Assumes polygon is in [lat, lng] with a CCW-ish
// winding (OSM usually is). Poor at very concave vertices but the follow-up
// union step tidies most artefacts.
function bufferPolygon(pts, bufferM) {
  if (pts.length < 3) return pts.slice();
  const midLat = pts[Math.floor(pts.length / 2)][0];
  const D2R = Math.PI / 180;
  const dLat = bufferM / 111320;
  const dLng = bufferM / (111320 * Math.cos(midLat * D2R));
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    // Edge tangent (in lat/lng units, scaled to metres via dLat/dLng).
    const tx = (next[1] - prev[1]) / dLng;
    const ty = (next[0] - prev[0]) / dLat;
    const len = Math.hypot(tx, ty) || 1;
    // Outward normal (right-hand relative to tangent for CCW polygon).
    const nx = -ty / len;
    const ny =  tx / len;
    out[i] = [pts[i][0] + ny * dLat, pts[i][1] + nx * dLng];
  }
  return out;
}

async function fetchTown(t, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchTownOnce(t);
    } catch (err) {
      lastErr = err;
      // Only retry on transient 5xx/HTTP errors — bad queries won't get better.
      if (!/HTTP 5\d\d|abort|timed?out|network/i.test(err.message)) throw err;
      const backoffMs = 4000 * (i + 1);
      console.warn(`[build-town-boundaries] ${t.name} attempt ${i + 1}/${attempts} failed (${err.message.slice(0, 60)}), retrying in ${backoffMs / 1000}s`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`[build-town-boundaries] fetching ${TOWNS.length} towns`);
  const out = { towns: [] };
  for (let i = 0; i < TOWNS.length; i++) {
    const t = TOWNS[i];
    try {
      const res = await fetchTown(t);
      if (res) {
        console.log(`[build-town-boundaries] ${t.name}: ${res.source_polygon_count} source polys → ${res.blob_count} blob(s), ${res.blob_area_km2.toFixed(1)} km² (${res.source_total_area_km2.toFixed(1)} km² built, hull ${res.hull_area_km2.toFixed(1)} km²)`);
        out.towns.push(res);
      } else {
        console.warn(`[build-town-boundaries] no polygons for ${t.name}`);
      }
    } catch (err) {
      console.warn(`[build-town-boundaries] ${t.name} FAILED after retries: ${err.message}`);
    }
    // Rate-limit spacing — Overpass 429s us if we hammer.
    if (i < TOWNS.length - 1) await new Promise((r) => setTimeout(r, 2500));
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const bytes = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`[build-town-boundaries] wrote ${OUT_PATH} (${bytes} KiB, ${out.towns.length} towns)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
