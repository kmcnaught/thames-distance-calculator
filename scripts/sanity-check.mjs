// Sanity-check the measurement pipeline. Same-waterway pairs are landmark
// Thames pairs — mostly non-tidal (Lechlade → Teddington) where CanalPlanAC's
// lock-to-lock distances give independent reference numbers. Tidal pairs
// aren't included (harder to cross-reference) but the measurement works
// down to Tower Bridge. Cross-waterway pairs exercise the tributary →
// confluence → Thames composition that app.js uses when A and B are on
// different waterways.
//
// Expected distances cross-referenced against CanalPlanAC / common
// published Thames lock-to-lock tables. Tolerances are generous because
// CanalPlanAC's gazetteer distances are themselves rounded.
//
// Usage: node scripts/sanity-check.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { measure, snap, haversine } from './utils/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'thames.json'), 'utf8'));
const tributaries = JSON.parse(readFileSync(resolve(__dirname, '..', 'data', 'tributaries.json'), 'utf8'));

const KM = 1000;
const MI = 1609.344;

// Inline copy of app.js measureAcross for cross-waterway pairs. A pin on a
// tributary routes to the Thames via the tributary's confluence (baked at
// build time as confluence_thames_along_m). Tributary polylines are oriented
// so the LAST vertex is the confluence end — so distance pin → confluence is
// length_m - snap.along.
//
// Duplication, not shared code: these pairs guard the *data* (tributary
// orientation, confluence baking) via the formula. If measureAcross moves
// to a shared library, import it here instead of duplicating.
function measureCross(aSide, bSide) {
  const toConfluence = (s) => s.ww.kind === 'thames' ? 0 : s.ww.length_m - s.snap.along;
  const onThames = (s) => s.ww.kind === 'thames' ? s.snap.along : s.ww.confluence_thames_along_m;
  const legA = toConfluence(aSide);
  const legB = toConfluence(bSide);
  const thamesLeg = Math.abs(onThames(aSide) - onThames(bSide));
  return { river: legA + thamesLeg + legB, legA, legB, thamesLeg };
}

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

// Cross-waterway pairs. One pin on a tributary, one on the Thames. These
// catch regressions in tributary polyline orientation, confluence baking,
// and the measureCross composition itself (not just the Thames line).
const thamesWw = {
  name: 'River Thames', short_name: 'Thames', kind: 'thames',
  coords: data.coords, cum: data.cum,
  length_m: data.cum[data.cum.length - 1],
};
const wwByName = Object.fromEntries(
  tributaries.waterways.map((w) => [w.name, {
    name: w.name, short_name: w.short_name, kind: w.kind,
    coords: w.points, cum: w.cum, length_m: w.length_m,
    confluence_thames_along_m: w.confluence_thames_along_m,
  }])
);

const crossPairs = [
  {
    name: 'Magdalen Bridge (Cherwell) ↔ Oxford Folly (Thames)',
    a: { ww: wwByName['River Cherwell'], pt: [51.7523, -1.2492] },
    b: { ww: thamesWw,                   pt: [51.7437, -1.2557] },
    expect_km: 1.4, tol_km: 0.5,  // classic Oxford punt route
  },
  {
    name: 'Fobney Lock (Kennet) ↔ Caversham (Thames)',
    a: { ww: wwByName['River Kennet'], pt: [51.4360, -0.9915] },
    b: { ww: thamesWw,                 pt: [51.4630, -0.9760] },
    expect_km: 7.1, tol_km: 1.5,  // Kennet lower reach + short Thames leg
  },
];
for (const p of crossPairs) {
  const aSide = { ww: p.a.ww, snap: snap(p.a.ww.coords, p.a.ww.cum, p.a.pt) };
  const bSide = { ww: p.b.ww, snap: snap(p.b.ww.coords, p.b.ww.cum, p.b.pt) };
  const res = measureCross(aSide, bSide);
  const km = res.river / KM;
  const err = Math.abs(km - p.expect_km);
  const ok = err <= p.tol_km;
  console.log(
    `${ok ? '✓' : '✗'} ${p.name.padEnd(50)} ${km.toFixed(2).padStart(6)} km` +
    `  expected ≈ ${p.expect_km} ± ${p.tol_km}` +
    `  legs: ${(res.legA/KM).toFixed(2)}+${(res.thamesLeg/KM).toFixed(2)}+${(res.legB/KM).toFixed(2)}`
  );
  if (!ok) allPass = false;
}

console.log(`\nmean abs error: ${(totalErr / pairs.length).toFixed(2)} km`);
process.exit(allPass ? 0 : 1);
