// Build tributary + canal polylines from OSM.
//
// Pipeline:
//   1. Fetch named waterways (rivers + K&A canal) from Overpass.
//   2. Group ways by name; stitch each into a single ordered polyline (using
//      the same Dijkstra stitcher as build-thames.mjs, with the confluence as
//      the sink target).
//   3. Clip the result to a visible bbox around the Thames corridor so distant
//      upstream reaches don't dominate.
//   4. Simplify with Douglas–Peucker (~30 m tolerance).
//   5. Write data/tributaries.json.
//
// Usage:  node scripts/build-tributaries.mjs
// Output: data/tributaries.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { stitch } from './utils/stitch.mjs';
import { simplify, haversine } from '../lib/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'tributaries.json');

// Visible envelope for the poster — polylines are clipped to this. Chosen a
// touch larger than the Thames' own bbox so tributaries lead a short way off
// the river into the surrounding country.
const BBOX = { latMin: 51.20, latMax: 51.95, lngMin: -1.95, lngMax: -0.25 };

// short_name is what appears on the poster label; label_at is a rough anchor
// (the poster generator can override); confluence is where the waterway meets
// the Thames, used as the stitch sink so the returned polyline is
// upstream→confluence.
const WATERWAYS = [
  { name: 'River Cherwell',        short_name: 'Cherwell',           waterway: 'river', confluence: [51.7412, -1.2519], label_at: [51.83, -1.24] },
  { name: 'River Kennet',          short_name: 'Kennet',             waterway: 'river', confluence: [51.4576, -0.9720], label_at: [51.44, -1.20] },
  { name: 'River Wey',             short_name: 'Wey',                waterway: 'river', confluence: [51.3742, -0.4569], label_at: [51.29, -0.55] },
  { name: 'River Mole',            short_name: 'Mole',               waterway: 'river', confluence: [51.394,  -0.3435], label_at: [51.32, -0.335] },
  { name: 'Kennet and Avon Canal', short_name: 'Kennet & Avon Canal', waterway: 'canal', confluence: [51.4576, -0.9720], label_at: [51.402, -1.38] },
];

// bbox-restrict every query so we don't pull the entire named-river extent
// (Cherwell reaches Northamptonshire, Kennet stretches west to Marlborough).
// Overpass filters the response server-side, dodging the 504s we hit without it.
const BB = `${BBOX.latMin},${BBOX.lngMin},${BBOX.latMax},${BBOX.lngMax}`;
const QUERY = `
[out:json][timeout:180];
(
${WATERWAYS.map((w) => `  way["waterway"="${w.waterway}"]["name"="${w.name}"](${BB});`).join('\n')}
);
out geom;
`.trim();

// Split into runs of in-bbox points, then prefer the run whose closest vertex
// is near the confluence (the waterway's mouth on the Thames). Some rivers
// (Wey) have long southern reaches that would otherwise dominate.
function clipToConfluenceRun(pts, bbox, confluence) {
  const inBox = ([lat, lng]) =>
    lat >= bbox.latMin && lat <= bbox.latMax && lng >= bbox.lngMin && lng <= bbox.lngMax;
  const runs = [];
  let cur = [];
  for (const p of pts) {
    if (inBox(p)) cur.push(p);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  if (runs.length === 0) return [];
  const distSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Choose the run with the closest point to the confluence.
  let best = runs[0];
  let bestD = Infinity;
  for (const run of runs) {
    for (const p of run) {
      const d = distSq(p, confluence);
      if (d < bestD) { bestD = d; best = run; }
    }
  }
  return best;
}

async function main() {
  console.log('[build-tributaries] fetching Overpass…');
  const json = await overpass(QUERY);
  const allWays = (json.elements || []).filter((e) => e.type === 'way' && e.geometry?.length >= 2);
  console.log(`[build-tributaries] ${allWays.length} ways`);

  const out = { waterways: [] };
  for (const w of WATERWAYS) {
    const ways = allWays.filter(
      (el) => el.tags?.name === w.name && el.tags?.waterway === w.waterway
    );
    if (ways.length === 0) {
      console.warn(`[build-tributaries] no ways for "${w.name}", skipping`);
      continue;
    }

    let raw;
    try {
      raw = stitch(ways, w.confluence).coords;
    } catch (err) {
      console.warn(`[build-tributaries] stitch failed for ${w.name} (${err.message}); using concatenated raw geoms`);
      raw = [];
      for (const way of ways) for (const g of way.geometry) raw.push([g.lat, g.lon]);
    }

    const clipped = clipToConfluenceRun(raw, BBOX, w.confluence);
    const simplified = clipped.length > 2 ? simplify(clipped, 30) : clipped;

    // If a NAMED RIVER's downstream end stops short of the true confluence
    // (e.g. Cherwell's "River Cherwell" name ends in North Oxford before it
    // reaches the Thames), append a straight-line stub to the confluence so it
    // visually reaches the Thames. Canals are NOT extended — a canal ends
    // where OSM says it does (K&A really ends at Newbury; the last mile is
    // navigable river handled by the Kennet polyline). Bridging a canal to a
    // river confluence produced a visibly wrong straight line.
    const endPt = simplified[simplified.length - 1];
    const startPt = simplified[0];
    const distEnd = endPt ? haversine(endPt, w.confluence) : Infinity;
    const distStart = startPt ? haversine(startPt, w.confluence) : Infinity;
    let extended = simplified;
    if (w.waterway === 'river' && endPt && distEnd > 200) {
      if (distStart < distEnd) {
        extended = simplified.slice().reverse();
      }
      extended.push(w.confluence);
    }

    console.log(
      `[build-tributaries] ${w.name}: ${ways.length} ways, ${raw.length} raw, ${clipped.length} clipped, ${extended.length} simplified` +
      (extended.length > simplified.length ? ` (+1 confluence stub, ${distEnd.toFixed(0)} m)` : '')
    );

    if (extended.length < 2) continue;
    out.waterways.push({
      name: w.name,
      short_name: w.short_name,
      kind: w.waterway,
      label_at: w.label_at,
      points: extended,
    });
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const bytes = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`[build-tributaries] wrote ${OUT_PATH} (${bytes} KiB, ${out.waterways.length} waterways)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
