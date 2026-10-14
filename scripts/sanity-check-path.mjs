// Sanity-check the Thames Path polyline by snapping named landmarks and
// comparing to published mileages from the National Trail guide.
//
// Mileages below are the standard source → point distances. The trail
// crosses sides at many bridges so pin coords are centred on the bridge or
// bridge-adjacent trail; snap offsets of ~50 m are expected.
//
// Usage: node scripts/sanity-check-path.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { measure } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'thames-path.json'), 'utf8'));

const MI = 1609.344;

// Published source → landmark mileages. These are approximate figures from
// the National Trail guide / National Trails UK; tolerances are a few miles
// because (a) different sources round differently, (b) the trail switches
// banks at bridges so pin→trail snap can be 100–200 m off.
const anchor = [data.coords[0][0], data.coords[0][1]]; // trail start = pin A
const checks = [
  { name: 'Lechlade Halfpenny Bridge',   pt: [51.6920, -1.6921], mi: 22,  tolMi: 3 },
  { name: 'Oxford Folly Bridge',         pt: [51.7437, -1.2557], mi: 55,  tolMi: 3 },
  { name: 'Reading Caversham Bridge',    pt: [51.4630, -0.9760], mi: 94,  tolMi: 3 },
  { name: 'Henley Bridge',               pt: [51.5390, -0.8997], mi: 104, tolMi: 3 },
  { name: 'Marlow Bridge',               pt: [51.5683, -0.7765], mi: 114, tolMi: 3 },
  { name: 'Windsor Bridge',              pt: [51.4855, -0.6076], mi: 127, tolMi: 3 },
  { name: 'Teddington Lock',             pt: [51.4313, -0.3243], mi: 151, tolMi: 4 },
  { name: 'Thames Barrier',              pt: [51.4972, 0.0366],  mi: 184, tolMi: 4 },
];

let allOk = true;
let totalErr = 0;
for (const c of checks) {
  const m = measure(data.coords, data.cum, anchor, c.pt);
  const miOnPath = m.river / MI;
  const err = Math.abs(miOnPath - c.mi);
  totalErr += err;
  const ok = err <= c.tolMi;
  if (!ok) allOk = false;
  console.log(
    `${ok ? '✓' : '✗'} ${c.name.padEnd(28)} ${miOnPath.toFixed(2).padStart(6)} mi  ` +
    `expected ≈ ${c.mi} ± ${c.tolMi}   snap=${m.b.off.toFixed(0)} m`,
  );
}
console.log(`\nmean abs error: ${(totalErr / checks.length).toFixed(2)} mi`);
process.exit(allOk ? 0 : 1);
