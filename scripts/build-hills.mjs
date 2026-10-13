// Build hill-region polygons from OSM AONBs.
//
// The uplands that frame the Thames valley are OSM boundary=protected_area
// relations with designation=area_of_outstanding_natural_beauty. Note: the
// AONBs were renamed to "National Landscape" in 2023, so the OSM names all
// end with that phrase.
//   - "The Cotswolds National Landscape"     → Cotswolds
//   - "Chilterns National Landscape"         → Chiltern Hills
//   - "North Wessex Downs National Landscape" → what people locally call
//                                                "Berkshire Downs"
//   - "Surrey Hills National Landscape"      → south of the lower Thames
//
// Pipeline:
//   1. Fetch the three relations with `out geom;` so each member way carries
//      its geometry.
//   2. For each relation, collect members with role="outer" and stitch them
//      into closed rings by matching endpoints (an AONB may have multiple
//      outer rings if it's a multipolygon).
//   3. Simplify each ring with Douglas–Peucker (~200 m tolerance — plenty for
//      a poster; drops rings from thousands of points to a few hundred).
//   4. Write data/hills.json.
//
// Usage:  node scripts/build-hills.mjs
// Output: data/hills.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { overpass } from './utils/overpass.mjs';
import { simplify } from '../lib/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'hills.json');

const AREAS = [
  { display: 'Cotswolds',       osm_name: 'The Cotswolds National Landscape',       label_at: [51.90, -1.90] },
  { display: 'Chiltern Hills',  osm_name: 'Chilterns National Landscape',           label_at: [51.72, -0.75] },
  { display: 'Berkshire Downs', osm_name: 'North Wessex Downs National Landscape',  label_at: [51.52, -1.45] },
  { display: 'Surrey Hills',    osm_name: 'Surrey Hills National Landscape',        label_at: [51.25, -0.45] },
];

const QUERY = `
[out:json][timeout:180];
(
${AREAS.map((a) => `  relation["boundary"="protected_area"]["name"="${a.osm_name}"];`).join('\n')}
);
out geom;
`.trim();

function keyOf([lat, lng]) { return `${lat.toFixed(6)},${lng.toFixed(6)}`; }

// Given a set of outer-way geometries, stitch shared-endpoint ways into rings.
// A "ring" is a polyline whose first and last vertex are (approximately) equal.
// Ways that don't close still get emitted (as an open ring) — the SVG polygon
// element will visually close them, which is close enough for hill blobs.
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
        const headKey = keyOf(w[0]);
        const wTailKey = keyOf(w[w.length - 1]);
        if (headKey === tailKey) {
          ring.push(...w.slice(1));
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (wTailKey === tailKey) {
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
  console.log('[build-hills] fetching Overpass…');
  const json = await overpass(QUERY);
  const relations = (json.elements || []).filter((e) => e.type === 'relation');
  console.log(`[build-hills] ${relations.length} relations`);

  const out = { hills: [] };
  for (const a of AREAS) {
    const rel = relations.find((r) => r.tags?.name === a.osm_name);
    if (!rel) {
      console.warn(`[build-hills] no relation for "${a.osm_name}", skipping ${a.display}`);
      continue;
    }
    const outerWays = (rel.members || []).filter(
      (m) => m.type === 'way' && m.role === 'outer' && Array.isArray(m.geometry) && m.geometry.length >= 2
    );
    const rings = buildRings(outerWays);
    const simplifiedRings = rings.map((r) => (r.length > 2 ? simplify(r, 200) : r));
    console.log(
      `[build-hills] ${a.display}: ${outerWays.length} outer ways → ${rings.length} rings ` +
      `(sizes ${rings.map((r) => r.length).join(',')} → ${simplifiedRings.map((r) => r.length).join(',')})`
    );

    out.hills.push({
      name: a.display,
      osm_name: a.osm_name,
      osm_id: rel.id,
      label_at: a.label_at,
      rings: simplifiedRings,
    });
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const bytes = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`[build-hills] wrote ${OUT_PATH} (${bytes} KiB, ${out.hills.length} hills)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
