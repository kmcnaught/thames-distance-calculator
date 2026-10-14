// Shared build pipeline for a 1D geo corridor (polyline + cumulative distance).
// Used by build-thames.mjs (river) and build-thames-path.mjs (walking trail).
//
// Steps: fetchCoords → simplify (Douglas–Peucker) → buildCum → validate → write.
// The caller supplies fetchCoords (Overpass + ordering) and validate (bounds +
// landmark checks), both corridor-specific.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildCum, simplify } from './geo.mjs';

export async function buildCorridor({
  label,
  outPath,
  fetchCoords,
  simplifyMeters = 5,
  validate,
}) {
  console.log(`[${label}] fetching…`);
  const { coords: rawCoords, meta: fetchMeta } = await fetchCoords();

  console.log(`[${label}] simplifying (Douglas–Peucker, ${simplifyMeters} m)…`);
  const coords = simplify(rawCoords, simplifyMeters);
  console.log(`[${label}] simplified to ${coords.length} pts (from ${rawCoords.length})`);

  const cum = buildCum(coords);
  const lengthM = cum[cum.length - 1];

  validate({ coords, cum, lengthM, fetchMeta });

  const out = {
    coords,
    cum,
    meta: {
      length_m: Math.round(lengthM),
      n_points: coords.length,
      ...fetchMeta,
      generated_at: new Date().toISOString(),
      attribution: '© OpenStreetMap contributors (ODbL)',
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  const payload = JSON.stringify(out);
  writeFileSync(outPath, payload);
  console.log(`[${label}] wrote ${outPath} (${(payload.length / 1024).toFixed(1)} KiB)`);
  console.log(`[${label}] length ${(lengthM / 1000).toFixed(2)} km, ${coords.length} points`);
  return out;
}
