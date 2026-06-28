// Sanity-check the measurement pipeline. Pairs are non-tidal Thames only
// (Lechlade → Teddington); tidal points are explicitly out of scope and
// will snap with a large offset (correct behaviour: surface as a warning).
//
// Expected distances cross-referenced against CanalPlanAC / common
// published Thames lock-to-lock tables. Tolerances are generous because
// CanalPlanAC's gazetteer distances are themselves rounded.
//
// Usage: node scripts/sanity-check.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { measure } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'thames.json'), 'utf8'));

const KM = 1000;
const MI = 1609.344;

const pairs = [
  // Bridge-to-bridge / lock-to-lock landmark pairs along the non-tidal Thames.
  { name: 'Lechlade Halfpenny ↔ Oxford Folly',  A: [51.6920, -1.6921], B: [51.7437, -1.2557], expect_km: 58, tol_km: 8 },
  { name: 'Oxford Folly ↔ Reading Caversham',   A: [51.7437, -1.2557], B: [51.4630, -0.9760], expect_km: 65, tol_km: 8 },
  { name: 'Reading Caversham ↔ Henley',         A: [51.4630, -0.9760], B: [51.5390, -0.8997], expect_km: 14, tol_km: 3 },
  { name: 'Henley ↔ Marlow',                    A: [51.5390, -0.8997], B: [51.5683, -0.7765], expect_km: 14, tol_km: 3 },
  { name: 'Marlow ↔ Windsor',                   A: [51.5683, -0.7765], B: [51.4855, -0.6076], expect_km: 26, tol_km: 4 },
  { name: 'Windsor ↔ Hampton Court',            A: [51.4855, -0.6076], B: [51.4035, -0.3375], expect_km: 32, tol_km: 5 },
  { name: 'Hampton Court ↔ Teddington Lock',    A: [51.4035, -0.3375], B: [51.4313, -0.3243], expect_km: 7, tol_km: 2 },
];

let allPass = true;
let totalErr = 0;
for (const p of pairs) {
  const m = measure(data.coords, data.cum, p.A, p.B);
  const km = m.river / KM;
  const mi = m.river / MI;
  const err = Math.abs(km - p.expect_km);
  totalErr += err;
  const ok = err <= p.tol_km;
  const offA = (m.a.off).toFixed(0);
  const offB = (m.b.off).toFixed(0);
  console.log(
    `${ok ? '✓' : '✗'} ${p.name.padEnd(38)} ${km.toFixed(2).padStart(6)} km (${mi.toFixed(2).padStart(6)} mi)` +
    `  expected ≈ ${p.expect_km} ± ${p.tol_km}  snap A=${offA}m B=${offB}m  k=${m.sinuosity.toFixed(2)}`
  );
  if (!ok) allPass = false;
}

// Off-river point should produce a large snap offset.
const m = measure(data.coords, data.cum, [51.7530, -1.2680], [51.7437, -1.2557]); // Oxford station ish
const offOk = m.a.off > 300;
console.log(`${offOk ? '✓' : '✗'} Snap offset on a point ~500m off the river: ${m.a.off.toFixed(0)} m (should be >300)`);
if (!offOk) allPass = false;

console.log(`\nmean abs error: ${(totalErr / pairs.length).toFixed(2)} km`);
process.exit(allPass ? 0 : 1);
