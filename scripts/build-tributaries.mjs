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

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { stitch } from './utils/stitch.mjs';
import { simplify, haversine, buildCum, snap } from '../lib/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'tributaries.json');
const THAMES_PATH = resolve(__dirname, '..', 'data', 'thames.json');

// Visible envelope for the data pull — polylines are clipped to this. Reaches
// a touch beyond the Thames corridor so tributaries lead off the river into
// surrounding country, and far enough north to catch the Cherwell up to
// Banbury (paddleable above Oxford).
const BBOX = { latMin: 51.20, latMax: 52.10, lngMin: -1.95, lngMax: -0.25 };

// short_name is what appears on the poster label; label_at is a rough anchor
// (the poster generator can override); confluence is the precise OSM-end-node
// where the waterway meets the Thames, used as the stitch sink so the returned
// polyline is upstream→confluence.
//
// `names` lets one waterway match several OSM `name` tags — e.g. the Loddon's
// lower reach (Twyford → Shiplake) is tagged just "Loddon", not "River Loddon",
// so without the alias the stitched polyline stops 7 km short of the Thames at
// Twyford. `name` (singular) is retained as the display name.
//
// The K&A canal shares the Kennet's confluence because it joins the Thames via
// the Kennet (K&A ends at Newbury). Keeping the two confluences equal lets the
// browser's shared-confluence fallback bridge the Newbury↔Reading gap at
// measure time.
//
// River Thame is intentionally omitted: OSM has an aggregate "overview" way
// covering the full extent that short-circuits the stitch — dijkstra picks the
// single-edge path and yields ~1 km of polyline instead of the ~24 km channel.
// Needs an extraction that excludes overview ways or walks member ways via a
// relation.
const WATERWAYS = [
  { name: 'River Cherwell',        short_name: 'Cherwell',           waterway: 'river', confluence: [51.74415, -1.25175], label_at: [51.83, -1.24] },
  { name: 'River Windrush',        short_name: 'Windrush',           waterway: 'river', confluence: [51.70987, -1.41731], label_at: [51.78, -1.49] },
  { name: 'River Evenlode',        short_name: 'Evenlode',           waterway: 'river', confluence: [51.78486, -1.33739], label_at: [51.86, -1.42] },
  { name: 'River Kennet',          short_name: 'Kennet',             waterway: 'river', confluence: [51.45952, -0.94939], label_at: [51.44, -1.20] },
  // Loddon joins the Thames at Shiplake Railway Bridge; OSM tags the lower
  // reach as just "Loddon" so we alias both. Hennerton Backwater is slightly
  // downstream of the confluence and forms a loop — not a tree-shaped
  // tributary, so excluded.
  { name: 'River Loddon',          short_name: 'Loddon',             waterway: 'river', confluence: [51.50187, -0.87983], label_at: [51.44, -0.92], names: ['River Loddon', 'Loddon'] },
  { name: 'River Wey',             short_name: 'Wey',                waterway: 'river', confluence: [51.38099, -0.45751], label_at: [51.29, -0.55] },
  { name: 'River Mole',            short_name: 'Mole',               waterway: 'river', confluence: [51.40086, -0.34351], label_at: [51.32, -0.335] },
  { name: 'Kennet and Avon Canal', short_name: 'Kennet & Avon Canal', waterway: 'canal', confluence: [51.45952, -0.94939], label_at: [51.402, -1.38] },
];
for (const w of WATERWAYS) if (!w.names) w.names = [w.name];

// bbox-restrict every query so we don't pull the entire named-river extent
// (Cherwell reaches Northamptonshire, Kennet stretches west to Marlborough).
// Overpass filters the response server-side, dodging the 504s we hit without it.
const BB = `${BBOX.latMin},${BBOX.lngMin},${BBOX.latMax},${BBOX.lngMax}`;
const QUERY = `
[out:json][timeout:180];
(
${WATERWAYS.flatMap((w) =>
  w.names.map((n) => `  way["waterway"="${w.waterway}"]["name"="${n}"](${BB});`)
).join('\n')}
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

  // Load the Thames centreline so we can project each confluence onto it and
  // bake confluence_along_m. The browser uses this to route cross-waterway
  // measurements via the Thames without recomputing the snap at runtime.
  const thames = JSON.parse(readFileSync(THAMES_PATH, 'utf8'));

  const out = { waterways: [] };
  for (const w of WATERWAYS) {
    const nameSet = new Set(w.names);
    const ways = allWays.filter(
      (el) => nameSet.has(el.tags?.name) && el.tags?.waterway === w.waterway
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

    // Orient the polyline so its LAST point is nearest the confluence. The
    // browser relies on this invariant: distance from a snapped pin to the
    // confluence = length_m - snap.along.
    const endPt = simplified[simplified.length - 1];
    const startPt = simplified[0];
    const distEnd = endPt ? haversine(endPt, w.confluence) : Infinity;
    const distStart = startPt ? haversine(startPt, w.confluence) : Infinity;
    let extended = simplified;
    if (distStart < distEnd) {
      extended = simplified.slice().reverse();
    }
    const confluenceEndDist = Math.min(distStart, distEnd);
    // Named rivers get a straight-line stub to the configured confluence if
    // the OSM-named reach stops short (e.g. "River Cherwell" ends in North
    // Oxford). Below ~1 km the stub is a reasonable visual bridge; above that
    // the straight line is visibly wrong (e.g. the Loddon's named reach ends
    // at Twyford, 7.7 km from the Wargrave mouth through braided channels).
    // In that case we skip the visual stub but still bake the configured
    // confluence into `confluence_thames_along_m` so measurements route via
    // the correct Thames point — the browser bridges the gap at render time.
    // Canals are NEVER extended — K&A really does end at Newbury.
    const STUB_MAX_M = 2500;
    let stubAppended = false;
    if (w.waterway === 'river' && confluenceEndDist > 200 && confluenceEndDist <= STUB_MAX_M) {
      extended.push(w.confluence);
      stubAppended = true;
    } else if (w.waterway === 'river' && confluenceEndDist > STUB_MAX_M) {
      console.warn(`[build-tributaries] ${w.name}: polyline end is ${confluenceEndDist.toFixed(0)} m from confluence — skipping visual stub. Measurement still routes via confluence.`);
    }

    // Project the configured confluence onto the Thames centreline. This is
    // the handoff point used by the browser when composing cross-waterway
    // measurements.
    const confluenceSnap = snap(thames.coords, thames.cum, w.confluence);

    console.log(
      `[build-tributaries] ${w.name}: ${ways.length} ways, ${raw.length} raw, ${clipped.length} clipped, ${extended.length} simplified` +
      (stubAppended ? ` (+1 confluence stub, ${confluenceEndDist.toFixed(0)} m)` : '') +
      `  thames_along=${(confluenceSnap.along / 1000).toFixed(2)}km (off=${confluenceSnap.off.toFixed(0)}m)`
    );

    if (extended.length < 2) continue;
    const cum = buildCum(extended);
    out.waterways.push({
      name: w.name,
      short_name: w.short_name,
      kind: w.waterway,
      label_at: w.label_at,
      points: extended,
      cum,
      length_m: cum[cum.length - 1],
      confluence: w.confluence,
      confluence_thames_along_m: confluenceSnap.along,
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
