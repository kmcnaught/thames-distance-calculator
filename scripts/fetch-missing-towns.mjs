// Fetch just the towns that failed in the last build-town-boundaries.mjs run.
// Merges into data/town-boundaries.json without disturbing the successful ones.
// Ad-hoc utility; not part of the standard pipeline.
//
// Usage:  node scripts/fetch-missing-towns.mjs <name> [name...]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { simplify, haversine } from '../lib/geo.mjs';
import pc from '/tmp/node_modules/polygon-clipping/dist/polygon-clipping.esm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'town-boundaries.json');

// Copy of TOWNS metadata from build-town-boundaries.mjs (subset for missing).
const TOWN_LOOKUP = {
  'Pangbourne':  { lat: 51.4859, lng: -1.0876, radius_km: 1.2 },
  'Marlow':      { lat: 51.5710, lng: -0.7770, radius_km: 2.0 },
  'Windsor':     { lat: 51.4823, lng: -0.6088, radius_km: 3.0 },
  'High Wycombe':{ lat: 51.6289, lng: -0.7482, radius_km: 3.5 },
  'Bracknell':   { lat: 51.4136, lng: -0.7515, radius_km: 3.0 },
};

function bboxAround(lat, lng, km) {
  const dLat = km / 111;
  const dLng = dLat / Math.cos(lat * Math.PI / 180);
  return { south: lat - dLat, west: lng - dLng, north: lat + dLat, east: lng + dLng };
}
function polygonAreaSqM(pts) {
  if (pts.length < 3) return 0;
  const midLat = pts[Math.floor(pts.length / 2)][0];
  const D2R = Math.PI / 180;
  const kLat = 111320, kLng = 111320 * Math.cos(midLat * D2R);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [lat1, lng1] = pts[i];
    const [lat2, lng2] = pts[(i + 1) % pts.length];
    sum += (lng1 * kLng) * (lat2 * kLat) - (lng2 * kLng) * (lat1 * kLat);
  }
  return Math.abs(sum) / 2;
}
function polygonCentroid(pts) {
  let sx = 0, sy = 0;
  for (const [lat, lng] of pts) { sy += lat; sx += lng; }
  return [sy / pts.length, sx / pts.length];
}
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
    const tx = (next[1] - prev[1]) / dLng;
    const ty = (next[0] - prev[0]) / dLat;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    out[i] = [pts[i][0] + ny * dLat, pts[i][1] + nx * dLng];
  }
  return out;
}
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
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

async function fetchOne(name) {
  const meta = TOWN_LOOKUP[name];
  if (!meta) throw new Error(`unknown town: ${name}`);
  const bb = bboxAround(meta.lat, meta.lng, meta.radius_km);
  const q = `[out:json][timeout:60];(way["landuse"="residential"](${bb.south},${bb.west},${bb.north},${bb.east}););out geom;`;
  const j = await overpass(q);
  const ways = (j.elements || []).filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 4);
  const polys = ways.map((w) => w.geometry.map((g) => [g.lat, g.lon]));
  const radiusM = meta.radius_km * 1000;
  const kept = polys.map((pts) => ({ pts, distM: haversine(polygonCentroid(pts), [meta.lat, meta.lng]), areaM2: polygonAreaSqM(pts) }))
    .filter((c) => c.distM <= radiusM && c.areaM2 >= 10_000);
  if (kept.length === 0) return null;
  kept.sort((a, b) => b.areaM2 - a.areaM2);

  const allPts = [];
  for (const k of kept) for (const p of k.pts) allPts.push(p);
  const hull = convexHull(allPts);

  const buffered = kept.map((k) => [bufferPolygon(k.pts, 120).map(([lat, lng]) => [lng, lat])]);
  let unionedRings;
  try {
    const mp = pc.union(...buffered);
    unionedRings = mp.map((poly) => poly[0].map(([lng, lat]) => [lat, lng]));
  } catch {
    unionedRings = [hull];
  }
  const blobsWithArea = unionedRings.map((r) => ({ ring: r, area: polygonAreaSqM(r) })).sort((a, b) => b.area - a.area);
  const largestArea = blobsWithArea[0]?.area || 0;
  const blobs = blobsWithArea.filter((b) => b.area >= largestArea * 0.05).map((b) => simplify(b.ring, 60));

  const totalArea = kept.reduce((s, k) => s + k.areaM2, 0);
  return {
    name, lat: meta.lat, lng: meta.lng,
    source_polygon_count: kept.length,
    source_total_area_km2: totalArea / 1e6,
    blob_count: blobs.length,
    blob_area_km2: blobsWithArea.reduce((s, b) => s + b.area, 0) / 1e6,
    hull_area_km2: polygonAreaSqM(hull) / 1e6,
    blobs, hull,
  };
}

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error('usage: node scripts/fetch-missing-towns.mjs <name> [name...]');
    process.exit(1);
  }
  const cur = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const byName = new Map(cur.towns.map((t) => [t.name, t]));

  for (const name of names) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetchOne(name);
        if (res) {
          byName.set(name, res);
          console.log(`[fetch-missing] ${name}: ${res.source_polygon_count} → ${res.blob_count} blob(s), ${res.blob_area_km2.toFixed(1)} km²`);
        } else {
          console.warn(`[fetch-missing] ${name}: no polygons`);
        }
        break;
      } catch (err) {
        console.warn(`[fetch-missing] ${name} attempt ${attempt}: ${err.message.slice(0, 60)}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 6000 * attempt));
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  cur.towns = [...byName.values()];
  writeFileSync(OUT_PATH, JSON.stringify(cur));
  console.log(`[fetch-missing] wrote ${OUT_PATH} (${cur.towns.length} towns)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
