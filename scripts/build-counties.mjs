// Build county boundary polygons for background context.
//
// Fetches boundary=administrative admin_level=6 relations (English ceremonial
// / shire counties) for the counties framing the Thames corridor. Berkshire
// was abolished in 1998 so it's not present at admin_level=6 — instead there
// are 6 unitary authorities where Berkshire used to be. We skip those to keep
// the poster readable; the gap in the county lines is visibly "Berkshire".
//
// Usage:  node scripts/build-counties.mjs
// Output: data/counties.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { simplify } from '../lib/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'counties.json');

// Ceremonial/shire counties around the Thames. Label anchors are picked to sit
// in reasonably empty parts of each county within our poster bbox.
const COUNTIES = [
  { name: 'Gloucestershire', label_at: [51.85, -1.95] },
  { name: 'Wiltshire',       label_at: [51.42, -1.85] },
  { name: 'Oxfordshire',     label_at: [51.83, -1.42] },
  { name: 'Buckinghamshire', label_at: [51.79, -0.95] },
  { name: 'Hertfordshire',   label_at: [51.75, -0.42] },
  { name: 'Surrey',          label_at: [51.28, -0.55] },
  { name: 'Hampshire',       label_at: [51.25, -1.25] },
];

const QUERY = `
[out:json][timeout:180];
(
${COUNTIES.map((c) => `  relation["boundary"="administrative"]["admin_level"="6"]["name"="${c.name}"];`).join('\n')}
);
out geom;
`.trim();

function keyOf([lat, lng]) { return `${lat.toFixed(6)},${lng.toFixed(6)}`; }

// Stitch outer-way segments into rings by matching endpoints. Same algorithm
// as build-hills.mjs — counties are usually one big outer ring but may be
// multipolygons.
function buildRings(ways) {
  const remaining = ways
    .map((w) => w.geometry.map((g) => [g.lat, g.lon]))
    .filter((pts) => pts.length >= 2);

  const rings = [];
  while (remaining.length) {
    const first = remaining.shift();
    let ring = first.slice();
    let extended = true;
    while (extended) {
      extended = false;
      const tailKey = keyOf(ring[ring.length - 1]);
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        if (keyOf(w[0]) === tailKey) {
          ring.push(...w.slice(1));
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (keyOf(w[w.length - 1]) === tailKey) {
          ring.push(...w.slice(0, -1).reverse());
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    rings.push(ring);
  }
  return rings;
}

async function main() {
  console.log('[build-counties] fetching Overpass…');
  const json = await overpass(QUERY);
  const relations = (json.elements || []).filter((e) => e.type === 'relation');
  console.log(`[build-counties] ${relations.length} relations`);

  const out = { counties: [] };
  for (const c of COUNTIES) {
    const rel = relations.find((r) => r.tags?.name === c.name);
    if (!rel) {
      console.warn(`[build-counties] no relation for ${c.name}, skipping`);
      continue;
    }
    const outerWays = (rel.members || []).filter(
      (m) => m.type === 'way' && m.role === 'outer' && Array.isArray(m.geometry) && m.geometry.length >= 2
    );
    const rings = buildRings(outerWays);
    // Simplify aggressively — county borders don't need 100 m resolution on a
    // poster. 400 m tolerance still preserves the shape.
    const simplifiedRings = rings.map((r) => (r.length > 2 ? simplify(r, 400) : r));
    console.log(
      `[build-counties] ${c.name}: ${outerWays.length} ways → ${rings.length} rings ` +
      `(sizes ${rings.map((r) => r.length).join(',')} → ${simplifiedRings.map((r) => r.length).join(',')})`
    );

    out.counties.push({
      name: c.name,
      osm_id: rel.id,
      label_at: c.label_at,
      rings: simplifiedRings,
    });
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const bytes = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`[build-counties] wrote ${OUT_PATH} (${bytes} KiB, ${out.counties.length} counties)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
