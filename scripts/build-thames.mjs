// Build the non-tidal Thames centreline.
//
// Pipeline:
//   1. Fetch all `waterway=river` ways named "River Thames" from Overpass.
//   2. Stitch them into one channel from the westmost endpoint to the
//      endpoint nearest Teddington Lock (clipping to non-tidal).
//   3. Simplify with Douglas–Peucker, ~5 m tolerance.
//   4. Precompute cumulative metres at each vertex.
//   5. Validate (≥500 pts, length 200–250 km, sensible bbox).
//   6. Write data/thames.json.
//
// Usage:  node scripts/build-thames.mjs
// Output: /workspace/data/thames.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { stitch } from './utils/stitch.mjs';
import { buildCum, simplify } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'thames.json');

// Teddington Lock — the canonical non-tidal/tidal Thames boundary.
const TEDDINGTON = [51.4313, -0.3243];

const QUERY = `
[out:json][timeout:180];
way["waterway"="river"]["name"="River Thames"];
out geom;
`.trim();

async function main() {
  console.log('[build-thames] fetching Overpass…');
  const json = await overpass(QUERY);
  const ways = (json.elements || []).filter((e) => e.type === 'way' && e.geometry?.length >= 2);
  console.log(`[build-thames] ${ways.length} ways`);

  console.log('[build-thames] stitching source → Teddington…');
  const { coords: rawCoords, meta } = stitch(ways, TEDDINGTON);
  console.log(`[build-thames] stitched: ${rawCoords.length} pts, ${(meta.pathLengthM / 1000).toFixed(1)} km`);
  console.log(`[build-thames] source: lat=${meta.source.lat} lng=${meta.source.lng}`);
  console.log(`[build-thames] sink:   lat=${meta.sink.lat} lng=${meta.sink.lng} (Teddington offset ${meta.sinkOffsetM.toFixed(0)} m)`);

  console.log('[build-thames] simplifying (Douglas–Peucker, 5 m)…');
  const coords = simplify(rawCoords, 5);
  console.log(`[build-thames] simplified to ${coords.length} pts (from ${rawCoords.length})`);

  const cum = buildCum(coords);
  const lengthM = cum[cum.length - 1];

  validate({ coords, lengthM, meta });

  const out = {
    coords,
    cum,
    meta: {
      length_m: Math.round(lengthM),
      n_points: coords.length,
      source: meta.source,
      sink: meta.sink,
      sink_offset_to_teddington_m: Math.round(meta.sinkOffsetM),
      generated_at: new Date().toISOString(),
      attribution: '© OpenStreetMap contributors (ODbL)',
    },
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const bytes = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`[build-thames] wrote ${OUT_PATH} (${bytes} KiB)`);
  console.log(`[build-thames] length ${(lengthM / 1000).toFixed(2)} km, ${coords.length} points`);
}

function validate({ coords, lengthM, meta }) {
  const errs = [];
  if (coords.length < 500) errs.push(`too few points: ${coords.length} (expected ≥500)`);
  if (lengthM < 200_000 || lengthM > 260_000) errs.push(`unexpected length ${(lengthM / 1000).toFixed(1)} km (expected 200–260)`);
  const srcLng = meta.source.lng;
  const sinkLng = meta.sink.lng;
  if (srcLng > -1.4) errs.push(`source longitude ${srcLng} is east of expected (< -1.4)`);
  if (sinkLng < -0.4 || sinkLng > -0.25) errs.push(`sink longitude ${sinkLng} is not near Teddington (-0.32)`);
  if (meta.sinkOffsetM > 1000) errs.push(`sink is ${meta.sinkOffsetM.toFixed(0)} m from Teddington — stitch may have stopped early`);
  if (errs.length) {
    throw new Error('build-thames validation failed:\n  - ' + errs.join('\n  - '));
  }
  console.log('[build-thames] ✓ validation passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
