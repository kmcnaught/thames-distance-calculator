// Build the Thames Path colouring poster (A3 landscape).
//
// Reads:  data/thames.json, data/launches.json
// Writes: poster.svg  (used both for printing and as the source for the web viewer)
//
// The poster is A3 landscape (420 × 297 mm). Coordinates are projected with a
// local equirectangular projection about the river's mid-latitude, then scaled
// to fit inside a margin box. The river itself is the hero stroke; two parallel
// "ribbons" (one either side of the centreline) are broken into lock-to-lock
// segments, each an individually-fillable <path>. The viewer wires clicks to
// cycle a segment's fill through {empty, A, B, both}.
//
// Usage:  node scripts/build-poster.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { simplify, snap } from '../lib/geo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(ROOT, 'poster.svg');

// ── Layout ──────────────────────────────────────────────────────────────────
// A3 landscape, mm.
const PAGE_W = 420;
const PAGE_H = 297;
const MARGIN = 14;

// The river is drawn as a fat "band"; each segment can be coloured on the
// north-of-centreline half, the south-of-centreline half, or both. The halves
// are drawn as strokes of width HALF_STROKE_MM, offset by HALF_STROKE_MM/2 from
// the centreline (so each half fills exactly one side of the river band).
const RIVER_STROKE_MM = 4.8;
const HALF_STROKE_MM = RIVER_STROKE_MM / 2;
const CENTRELINE_STROKE_MM = 0.32;
const RIBBON_GAP_MM = 1.1;   // length trimmed from each end of each half-segment

// Waypoint sizes, mm.
const LOCK_DOT_R = 0.7;
const TOWN_DOT_R = 1.4;

// ── Towns ───────────────────────────────────────────────────────────────────
// Hand-picked orientation labels. Positions are approximate town-centre lat/lng
// (the marker sits at the true town centre — not the point where the river
// passes closest — so the dot floats off the river where appropriate).
// radius_km: rough footprint used to render a faint boundary circle behind the
// river as background geography.
// anchor / dx / dy: label placement hints.
const TOWNS = [
  { name: 'Cricklade',       lat: 51.6455, lng: -1.8580, radius_km: 0.9, anchor: 'start',  dx:  2.5, dy:  0   },
  { name: 'Lechlade',        lat: 51.6923, lng: -1.6931, radius_km: 0.7, anchor: 'end',    dx: -2,   dy: -1.5 },
  { name: 'Newbridge',       lat: 51.7317, lng: -1.4130, radius_km: 0.2, anchor: 'middle', dx:  0,   dy: -2.2 },
  { name: 'Oxford',          lat: 51.7520, lng: -1.2577, radius_km: 3.8, anchor: 'start',  dx:  2.5, dy: -1.5 },
  { name: 'Abingdon',        lat: 51.6714, lng: -1.2820, radius_km: 1.8, anchor: 'end',    dx: -2,   dy:  0   },
  { name: 'Dorchester',      lat: 51.6440, lng: -1.1655, radius_km: 0.6, anchor: 'middle', dx:  0,   dy: -2.2 },
  { name: 'Wallingford',     lat: 51.5992, lng: -1.1259, radius_km: 1.1, anchor: 'end',    dx: -2,   dy:  0   },
  { name: 'Goring',          lat: 51.5253, lng: -1.1408, radius_km: 0.9, anchor: 'start',  dx:  2.5, dy: -1   },
  { name: 'Pangbourne',      lat: 51.4859, lng: -1.0876, radius_km: 0.8, anchor: 'end',    dx: -2,   dy:  0   },
  { name: 'Reading',         lat: 51.4543, lng: -0.9781, radius_km: 4.2, anchor: 'middle', dx:  0,   dy:  4   },
  { name: 'Henley-on-Thames',lat: 51.5361, lng: -0.9032, radius_km: 1.6, anchor: 'start',  dx:  2.5, dy:  0   },
  { name: 'Marlow',          lat: 51.5710, lng: -0.7770, radius_km: 1.6, anchor: 'middle', dx:  0,   dy: -2.2 },
  { name: 'Maidenhead',      lat: 51.5218, lng: -0.7196, radius_km: 2.8, anchor: 'end',    dx: -2,   dy:  0   },
  { name: 'Windsor',         lat: 51.4823, lng: -0.6088, radius_km: 2.2, anchor: 'middle', dx:  0,   dy:  4   },
  { name: 'Staines',         lat: 51.4335, lng: -0.5100, radius_km: 2.0, anchor: 'middle', dx:  0,   dy:  4   },
  { name: 'Weybridge',       lat: 51.3722, lng: -0.4574, radius_km: 1.9, anchor: 'middle', dx:  0,   dy:  4   },
  { name: 'Kingston',        lat: 51.4123, lng: -0.3007, radius_km: 2.7, anchor: 'end',    dx: -2.5, dy:  3.5 },
  { name: 'Teddington',      lat: 51.4272, lng: -0.3358, radius_km: 1.4, anchor: 'end',    dx: -2.5, dy: -1.5 },
];

// Off-river reference towns — bigger settlements the reader will recognise.
// Not part of the Thames Path itself; drawn subtler than on-river towns to read
// as orientation cues rather than waypoints.
const OFF_RIVER_TOWNS = [
  { name: 'Swindon',      lat: 51.5558, lng: -1.7797, radius_km: 4.5, anchor: 'middle', dx: 0,   dy:  4   },
  { name: 'Aylesbury',    lat: 51.8156, lng: -0.8084, radius_km: 2.8, anchor: 'middle', dx: 0,   dy: -3.5 },
  { name: 'High Wycombe', lat: 51.6289, lng: -0.7482, radius_km: 3.0, anchor: 'middle', dx: 0,   dy: -3.5 },
  { name: 'Slough',       lat: 51.5105, lng: -0.5950, radius_km: 3.5, anchor: 'middle', dx: 0,   dy: -3.5 },
  { name: 'Bracknell',    lat: 51.4136, lng: -0.7515, radius_km: 2.5, anchor: 'middle', dx: 0,   dy:  4   },
  { name: 'Watford',      lat: 51.6565, lng: -0.3903, radius_km: 3.0, anchor: 'middle', dx: 0,   dy: -3.5 },
];

// Tributaries + canals + hills are baked from OSM by build-tributaries.mjs and
// build-hills.mjs — see data/tributaries.json and data/hills.json. Rerun those
// scripts if the underlying OSM data changes.

// ── Projection ──────────────────────────────────────────────────────────────
// Extra points let callers stretch the bbox to include off-river features
// (reference towns, tributaries) that would otherwise be clipped.
function makeProjector(coords, extraPoints = []) {
  let latMin =  Infinity, latMax = -Infinity;
  let lngMin =  Infinity, lngMax = -Infinity;
  const consume = ([lat, lng]) => {
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
    if (lng < lngMin) lngMin = lng;
    if (lng > lngMax) lngMax = lng;
  };
  for (const p of coords) consume(p);
  for (const p of extraPoints) consume(p);
  const midLat = (latMin + latMax) / 2;
  const D2R = Math.PI / 180;
  const kLng = Math.cos(midLat * D2R);          // longitude shrink at mid-lat

  // Project to unit "map" coordinates (X east, Y south, both in metres * const).
  const toMap = ([lat, lng]) => [(lng - lngMin) * kLng, (latMax - lat)];

  // Fit into the margin box.
  const [x0, y0] = toMap([latMax, lngMin]);
  const [x1, y1] = toMap([latMin, lngMax]);
  const mapW = x1 - x0;
  const mapH = y1 - y0;

  const boxW = PAGE_W - 2 * MARGIN;
  const boxH = PAGE_H - 2 * MARGIN;
  const scale = Math.min(boxW / mapW, boxH / mapH);
  const drawnW = mapW * scale;
  const drawnH = mapH * scale;
  const offX = MARGIN + (boxW - drawnW) / 2;
  const offY = MARGIN + (boxH - drawnH) / 2;

  const project = ([lat, lng]) => {
    const [mx, my] = toMap([lat, lng]);
    return [offX + mx * scale, offY + my * scale];
  };

  // Metres → mm on the page, for buffer widths, etc.
  const mPerDeg = 111320;
  const mmPerMetre = scale / mPerDeg;

  return { project, bbox: { latMin, latMax, lngMin, lngMax }, mmPerMetre };
}

// ── Ribbon offset ───────────────────────────────────────────────────────────
// Naive normal-based offset in the projected (mm) plane. Cusps in tight meanders
// are the known failure mode; we accept them at the segment level and rely on
// stroke-linejoin=round to hide them cosmetically.
function offsetPolyline(points, offsetMm) {
  const n = points.length;
  if (n < 2) return points.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    // Right-hand normal to the tangent (rotate 90° CW in SVG's y-down space).
    const nx =  ty / len;
    const ny = -tx / len;
    out[i] = [points[i][0] + nx * offsetMm, points[i][1] + ny * offsetMm];
  }
  return out;
}

// Trim a polyline by `trimMm` from each end. Walks the polyline consuming
// segment lengths until the trim distance is reached, splitting the segment
// that spans the cut. Returns the middle portion. If the polyline is shorter
// than 2*trimMm we still return a two-point stub at the midpoint so the
// segment stays present (and clickable) in the SVG.
function trimPolyline(pts, trimMm) {
  if (pts.length < 2) return pts.slice();
  const lens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens.push(d);
    total += d;
  }
  if (total <= 2 * trimMm) {
    // Too short — return a tiny two-point line at the midpoint so the path is
    // still selectable.
    const midT = total / 2;
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
      if (acc + lens[i] >= midT) {
        const t = (midT - acc) / lens[i];
        const mx = pts[i][0] + t * (pts[i + 1][0] - pts[i][0]);
        const my = pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
        return [[mx, my], [mx + 0.001, my]];
      }
      acc += lens[i];
    }
  }

  const cutAt = (targetDist) => {
    let acc = 0;
    for (let i = 0; i < lens.length; i++) {
      if (acc + lens[i] >= targetDist) {
        const t = (targetDist - acc) / lens[i];
        const x = pts[i][0] + t * (pts[i + 1][0] - pts[i][0]);
        const y = pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
        return { i, pt: [x, y] };
      }
      acc += lens[i];
    }
    return { i: pts.length - 1, pt: pts[pts.length - 1] };
  };
  const startCut = cutAt(trimMm);
  const endCut = cutAt(total - trimMm);
  const out = [startCut.pt];
  for (let i = startCut.i + 1; i <= endCut.i; i++) out.push(pts[i]);
  out.push(endCut.pt);
  return out;
}

// ── Segment extraction ──────────────────────────────────────────────────────
// Given the centreline cum[] and a sorted array of "along" distances, return the
// index of the vertex nearest each cut. We slice the polyline at these vertices
// to make lock-to-lock sub-polylines. (Snapping to nearest vertex avoids a
// second projection pass and is fine at 5-m simplify tolerance.)
function nearestIndex(cum, along) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < along) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(cum[lo - 1] - along) < Math.abs(cum[lo] - along)) return lo - 1;
  return lo;
}

// Tangent (in degrees, atan2 convention, y-down) of the river at a given
// along-m. Used to pick label side for locks. Binary search cum[] for the
// index, take neighbours as tangent estimate.
function tangentAtAlong(cum, projected, alongM) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < alongM) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, Math.min(projected.length - 2, lo));
  const prev = projected[i - 1];
  const next = projected[i + 1];
  return Math.atan2(next[1] - prev[1], next[0] - prev[0]) * 180 / Math.PI;
}

// ── SVG helpers ─────────────────────────────────────────────────────────────
function pathD(points) {
  if (!points.length) return '';
  let s = `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    s += ` L${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)}`;
  }
  return s;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  console.log('[build-poster] reading data…');
  const thames = JSON.parse(readFileSync(resolve(ROOT, 'data/thames.json'), 'utf8'));
  const launches = JSON.parse(readFileSync(resolve(ROOT, 'data/launches.json'), 'utf8'));
  const tributariesRaw = JSON.parse(readFileSync(resolve(ROOT, 'data/tributaries.json'), 'utf8'));
  const hillsRaw = JSON.parse(readFileSync(resolve(ROOT, 'data/hills.json'), 'utf8'));
  // Optional — if build-town-boundaries.mjs hasn't been run, fall back to circles.
  let townBoundariesRaw = { towns: [] };
  try {
    townBoundariesRaw = JSON.parse(readFileSync(resolve(ROOT, 'data/town-boundaries.json'), 'utf8'));
  } catch { /* file absent, circles it is */ }
  // Optional counties — if build-counties.mjs hasn't been run, skip the layer.
  let countiesRaw = { counties: [] };
  try {
    countiesRaw = JSON.parse(readFileSync(resolve(ROOT, 'data/counties.json'), 'utf8'));
  } catch { /* file absent */ }
  // Label position overrides — hand-tweaked positions exported from the viewer.
  // Keyed by `${type}:${name}`, value is [x_mm, y_mm] in poster viewBox space.
  let labelOverrides = {};
  try {
    labelOverrides = JSON.parse(readFileSync(resolve(ROOT, 'data/label-overrides.json'), 'utf8'));
  } catch { /* no file, no overrides */ }
  // Prefer coalesced blobs (from union of buffered residentials); fall back to
  // the convex hull if a town only carries a hull; further fall back to circle.
  const townPolyMap = new Map(
    townBoundariesRaw.towns.map((t) => [t.name, t.blobs || (t.hull ? [t.hull] : (t.polygon ? [t.polygon] : []))])
  );

  // Split baked waterways into tributaries (rivers) vs canals so we can style
  // them separately without duplicating the storage.
  const tributariesData = tributariesRaw.waterways.filter((w) => w.kind === 'river');
  const canalsData = tributariesRaw.waterways.filter((w) => w.kind === 'canal');

  // Built-in label anchor overrides (in lat/lng, applied before projection).
  // Different from labelOverrides (which stores post-projection pixel positions
  // exported from the viewer). This one nudges anchors that the JSON default
  // put in a crowded area, without needing to rebuild the underlying data.
  const anchorOverrides = {
    'Surrey Hills':          [51.34, -0.55],
    'Kennet & Avon Canal':   [51.418, -1.14],
    'Kennet':                [51.475, -1.05],
    'Mole':                  [51.37, -0.30],
    'Wey':                   [51.335, -0.50],
  };
  const overrideLabel = (name, fallback) => anchorOverrides[name] || fallback;

  const coords = thames.coords;
  const cum = thames.cum;
  // Locks to skip: defunct (Inglesham was physically removed but is still
  // tagged in OSM); OSM lower-gate duplicates that the main lock covers
  // (Boulters Lock Lower Gate is the same site as Boulters Lock).
  const SKIP_LOCKS = new Set([
    'Inglesham Lock',
    'Boulters Lock Lower Gate',
  ]);
  const locks = launches.launches
    .filter((l) => l.type === 'lock')
    .filter((l) => !SKIP_LOCKS.has(l.name))
    .sort((a, b) => a.along_m - b.along_m);
  console.log(`[build-poster] ${coords.length} centreline points, ${locks.length} locks (after skip list)`);

  // Include off-river towns in the bbox so they and their circles fit. Do NOT
  // include tributaries/hills — the real OSM polygons extend far beyond the
  // Thames corridor (Cotswolds runs to Bath, Chilterns to Luton) and would
  // shrink the poster. They get clipped naturally by the SVG viewBox instead.
  const extra = [];
  for (const t of OFF_RIVER_TOWNS) {
    const dLat = (t.radius_km / 111) * 1.1;
    const dLng = dLat / Math.cos(t.lat * Math.PI / 180);
    extra.push([t.lat + dLat, t.lng], [t.lat - dLat, t.lng], [t.lat, t.lng + dLng], [t.lat, t.lng - dLng]);
  }

  const { project, mmPerMetre } = makeProjector(coords, extra);
  const projected = coords.map(project);

  // Simplify the projected polyline lightly to keep the SVG small. 0.15 mm is
  // below print-perceptible; drops us from ~1800 vertices to ~600ish.
  const simplifiedMm = simplifyMm(projected, 0.15);
  console.log(`[build-poster] projected polyline: ${projected.length} → ${simplifiedMm.length} pts after 0.15mm simplify`);

  // Snap every town to the river to get its along_m. Towns not near the river
  // (snap offset > 3 km) are treated as label-only and don't produce a cut.
  const townCuts = [];
  for (const t of TOWNS) {
    const s = snap(coords, cum, [t.lat, t.lng]);
    if (s.off > 3000) continue;
    townCuts.push({ name: t.name, along: s.along, kind: 'town' });
  }
  const lockCuts = locks.map((l) => ({
    name: l.name || 'unnamed lock',
    along: l.along_m,
    kind: 'lock',
  }));

  // Merge, sort, dedup: any two cuts within DEDUP_M of each other collapse to
  // one (locks win over towns, since the lock is a real river feature and lines
  // up with a physical marker). Then bookend with the river's two endpoints.
  const DEDUP_M = 500;
  const merged = [...lockCuts, ...townCuts].sort((a, b) => a.along - b.along);
  const deduped = [];
  for (const c of merged) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(c.along - prev.along) < DEDUP_M) {
      if (prev.kind === 'town' && c.kind === 'lock') deduped[deduped.length - 1] = c;
      continue;
    }
    deduped.push(c);
  }
  const startCut = { name: 'source', along: 0, kind: 'edge' };
  const endCut = { name: 'teddington', along: cum[cum.length - 1], kind: 'edge' };
  const allCuts = [startCut, ...deduped, endCut];
  const nTown = deduped.filter((c) => c.kind === 'town').length;
  const nLock = deduped.filter((c) => c.kind === 'lock').length;
  console.log(`[build-poster] cuts: ${nLock} locks + ${nTown} towns = ${allCuts.length - 1} segments`);

  // Slice the raw projected polyline at cut indices so that each ribbon segment
  // is bounded by cut positions, then aggressively simplify the per-segment
  // polyline before offsetting. Heavy simplify (2.0 mm) smooths tight meanders
  // so the naive normal-offset doesn't self-intersect. The river itself is
  // drawn from a lightly-simplified line — this only affects ribbon path shape.
  const RIBBON_SIMPLIFY_MM = 2.0;
  const cutIdx = allCuts.map((c) => nearestIndex(cum, c.along));
  const segments = [];
  for (let i = 0; i < cutIdx.length - 1; i++) {
    const a = cutIdx[i];
    const b = cutIdx[i + 1];
    if (b <= a) continue;   // guard against dedup edge cases
    const rawSlice = projected.slice(a, b + 1);
    const slice = simplifyMm(rawSlice, RIBBON_SIMPLIFY_MM);
    const fromName = allCuts[i].name;
    const toName = allCuts[i + 1].name;
    segments.push({
      id: `${slugify(fromName)}--${slugify(toName)}`,
      pts: slice,
      fromName,
      toName,
    });
  }

  // Each half-band is a stroke of width HALF_STROKE_MM offset from the
  // centreline by HALF_STROKE_MM/2, so it fills exactly one side of the river.
  const halfOffset = HALF_STROKE_MM / 2;

  const svg = buildSvg({
    riverPathD: pathD(simplifiedMm),
    segments,
    locks: (() => {
      const townNamesLC = new Set(TOWNS.map((t) => t.name.toLowerCase()));
      const stripLock = (n) => n.replace(/\s*Launch\s+Lock$/i, '')
        .replace(/\s*Lower Gate$/i, '')
        .replace(/\s*Lock$/i, '').trim();
      return locks
        .filter((l) => l.name)
        .filter((l) => !townNamesLC.has(stripLock(l.name).toLowerCase()))
        .map((l) => ({
          name: l.name,
          short: stripLock(l.name).replace(/^St\.John's$/i, "St John's"),
          pt: project([l.snap_lat, l.snap_lng]),
          tangentDeg: tangentAtAlong(cum, projected, l.along_m),
        }));
    })(),
    towns: TOWNS.map((t) => ({
      ...t,
      pt: project([t.lat, t.lng]),
      polygonRings: townPolyMap.get(t.name)?.map((ring) => ring.map(project)),
    })),
    offRiverTowns: OFF_RIVER_TOWNS.map((t) => ({
      ...t,
      pt: project([t.lat, t.lng]),
      polygonRings: townPolyMap.get(t.name)?.map((ring) => ring.map(project)),
    })),
    tributaries: tributariesData.map((tr) => {
      const name = tr.short_name || tr.name;
      return {
        name,
        pathPts: tr.points.map(project),
        labelPt: project(overrideLabel(name, tr.label_at)),
      };
    }),
    canals: canalsData.map((c) => {
      const name = c.short_name || c.name;
      return {
        name,
        pathPts: c.points.map(project),
        labelPt: project(overrideLabel(name, c.label_at)),
      };
    }),
    hills: hillsRaw.hills.map((h) => ({
      name: h.name,
      ringsPts: h.rings.map((ring) => ring.map(project)),
      labelPt: project(overrideLabel(h.name, h.label_at)),
    })),
    counties: countiesRaw.counties.map((c) => ({
      name: c.name,
      ringsPts: c.rings.map((ring) => ring.map(project)),
      labelPt: project(overrideLabel(c.name, c.label_at)),
    })),
    halfOffset,
    mmPerMetre,
    labelOverrides,
  });

  writeFileSync(OUT_PATH, svg);
  const bytes = (svg.length / 1024).toFixed(1);
  console.log(`[build-poster] wrote ${OUT_PATH} (${bytes} KiB)`);
}

function simplifyMm(pts, tolMm) {
  if (pts.length < 3) return pts.slice();
  const tol2 = tolMm * tolMm;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [sx, sy] = pts[s], [ex, ey] = pts[e];
    const ux = ex - sx, uy = ey - sy;
    const uu = ux * ux + uy * uy;
    let maxD2 = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      const ax = px - sx, ay = py - sy;
      let t = uu > 0 ? (ax * ux + ay * uy) / uu : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = sx + t * ux - px, cy = sy + t * uy - py;
      const d2 = cx * cx + cy * cy;
      if (d2 > maxD2) { maxD2 = d2; idx = i; }
    }
    if (maxD2 > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function buildSvg({ riverPathD, segments, locks, towns, offRiverTowns, tributaries, canals, hills, counties, halfOffset, mmPerMetre, labelOverrides = {} }) {
  // Helper: emit a text label with a stable data-label-id, applying any
  // override position from data/label-overrides.json.
  const emitLabel = (id, defaultX, defaultY, anchor, className, text) => {
    const ov = labelOverrides[id];
    const x = ov ? ov[0] : defaultX;
    const y = ov ? ov[1] : defaultY;
    return `      <text class="${className}" data-label-id="${xmlEscape(id)}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}">${xmlEscape(text)}</text>`;
  };
  // Halfband overlays: two per segment, one either side of the centreline.
  // Each is a stroke of width HALF_STROKE_MM offset by HALF_STROKE_MM/2 from
  // the centreline so it fills exactly one side of the fat river band. Trimmed
  // at each end so consecutive segments show a visible gap at each cut.
  const trimMm = RIBBON_GAP_MM;
  const halfPaths = [];
  for (const s of segments) {
    const topOff = trimPolyline(offsetPolyline(s.pts, halfOffset), trimMm);
    const botOff = trimPolyline(offsetPolyline(s.pts, -halfOffset), trimMm);
    halfPaths.push(`      <path class="halfband" data-side="a" data-fill="" data-seg="${s.id}" d="${pathD(topOff)}"/>`);
    halfPaths.push(`      <path class="halfband" data-side="b" data-fill="" data-seg="${s.id}" d="${pathD(botOff)}"/>`);
  }
  const halfBands = halfPaths.join('\n');

  const lockMarkers = locks.map((l) => {
    return `      <circle class="lock" cx="${l.pt[0].toFixed(2)}" cy="${l.pt[1].toFixed(2)}" r="${LOCK_DOT_R}"/>`;
  }).join('\n');

  // Smart lock label placement:
  // 1. Compute the local river tangent at each lock (baked in during main()).
  // 2. If the river is E-W-ish, put the label above or below (alternating by
  //    index so adjacent locks don't stack on the same side).
  // 3. If the river is N-S-ish, put the label to the right by default, left
  //    only when the right position would collide with another label.
  // 4. Collision-check against town labels (and previously-placed lock labels)
  //    using rough bounding boxes; flip to the alternate side on collision.
  const LOCK_FONT_MM = 2.6;
  const TOWN_FONT_MM = 3.6;
  const OFFSET_MM = 1.6;   // gap between the lock dot and the label baseline

  const rectOf = (x, y, w, h, anchor) => {
    let x0 = x;
    if (anchor === 'middle') x0 = x - w / 2;
    else if (anchor === 'end') x0 = x - w;
    // SVG text y is baseline; box extends up ~0.8h and down ~0.25h.
    return { x0, y0: y - h * 0.85, x1: x0 + w, y1: y + h * 0.25 };
  };
  const rectsOverlap = (a, b) =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // Rough monospace-ish text width: font size × 0.55 per char.
  const textWidth = (text, fontMm) => Math.max(1, text.length * fontMm * 0.55);

  // Prime placed rects with town labels + off-town labels + hill labels since
  // those already have positions.
  const placedRects = [];
  const addRect = (r) => placedRects.push(r);
  for (const t of towns) {
    const w = textWidth(t.name, TOWN_FONT_MM), h = TOWN_FONT_MM;
    addRect(rectOf(t.pt[0] + (t.dx || 0), t.pt[1] + (t.dy || 0), w, h, t.anchor || 'middle'));
  }
  for (const t of offRiverTowns) {
    const w = textWidth(t.name, 3.4), h = 3.4;
    addRect(rectOf(t.pt[0] + (t.dx || 0), t.pt[1] + (t.dy || 0), w, h, t.anchor || 'middle'));
  }

  const lockLabelData = [];
  locks.forEach((l, idx) => {
    // Override wins outright.
    const ov = labelOverrides[`lock:${l.name}`];
    if (ov) {
      lockLabelData.push({ ...l, x: ov[0], y: ov[1], anchor: 'middle' });
      addRect(rectOf(ov[0], ov[1], textWidth(l.short, LOCK_FONT_MM), LOCK_FONT_MM, 'middle'));
      return;
    }
    const w = textWidth(l.short, LOCK_FONT_MM);
    const h = LOCK_FONT_MM;
    const t = l.tangentDeg;
    const isEW = Math.abs(t) < 45 || Math.abs(t) > 135;

    // Candidate positions in preference order.
    const above = { x: l.pt[0], y: l.pt[1] - OFFSET_MM, anchor: 'middle' };
    const below = { x: l.pt[0], y: l.pt[1] + OFFSET_MM + h * 0.7, anchor: 'middle' };
    const right = { x: l.pt[0] + OFFSET_MM, y: l.pt[1] + h * 0.3, anchor: 'start' };
    const left  = { x: l.pt[0] - OFFSET_MM, y: l.pt[1] + h * 0.3, anchor: 'end' };

    let candidates;
    if (isEW) {
      candidates = idx % 2 === 0 ? [above, below] : [below, above];
    } else {
      candidates = [right, left];
    }
    let chosen = null;
    for (const c of candidates) {
      const r = rectOf(c.x, c.y, w, h, c.anchor);
      if (!placedRects.some((p) => rectsOverlap(p, r))) {
        chosen = { ...c, rect: r };
        break;
      }
    }
    if (!chosen) chosen = { ...candidates[0], rect: rectOf(candidates[0].x, candidates[0].y, w, h, candidates[0].anchor) };
    addRect(chosen.rect);
    lockLabelData.push({ ...l, x: chosen.x, y: chosen.y, anchor: chosen.anchor });
  });
  const lockLabels = lockLabelData.map((l) =>
    emitLabel(`lock:${l.name}`, l.x, l.y, l.anchor, 'lock-label', l.short)
  ).join('\n');

  // Town-area shapes: coalesced blobs (buffered union of OSM landuse=residential
  // polygons) per town. Usually 1–3 blobs each. Circle fallback if no OSM data.
  const townCircles = towns.map((t) => {
    if (t.polygonRings && t.polygonRings.length) {
      return t.polygonRings.map((ring) => {
        const pts = ring.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
        return `      <polygon class="town-area" points="${pts}"/>`;
      }).join('\n');
    }
    const rMm = Math.max(0.6, (t.radius_km || 1) * 1000 * mmPerMetre);
    return `      <circle class="town-area" cx="${t.pt[0].toFixed(2)}" cy="${t.pt[1].toFixed(2)}" r="${rMm.toFixed(2)}"/>`;
  }).join('\n');

  const townMarkers = towns.map((t) => {
    return `      <circle class="town-dot" cx="${t.pt[0].toFixed(2)}" cy="${t.pt[1].toFixed(2)}" r="${TOWN_DOT_R}"/>`;
  }).join('\n');

  const townLabels = towns.map((t) => emitLabel(
    `town:${t.name}`, t.pt[0] + (t.dx || 0), t.pt[1] + (t.dy || 0), t.anchor || 'middle', 'town-label', t.name
  )).join('\n');

  // Off-river reference towns: same shape but greyer/subtler so they orient
  // without competing with the ribbon towns.
  const offCircles = offRiverTowns.map((t) => {
    if (t.polygonRings && t.polygonRings.length) {
      return t.polygonRings.map((ring) => {
        const pts = ring.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
        return `      <polygon class="off-town-area" points="${pts}"/>`;
      }).join('\n');
    }
    const rMm = Math.max(0.8, (t.radius_km || 2) * 1000 * mmPerMetre);
    return `      <circle class="off-town-area" cx="${t.pt[0].toFixed(2)}" cy="${t.pt[1].toFixed(2)}" r="${rMm.toFixed(2)}"/>`;
  }).join('\n');
  const offDots = offRiverTowns.map((t) => {
    return `      <circle class="off-town-dot" cx="${t.pt[0].toFixed(2)}" cy="${t.pt[1].toFixed(2)}" r="${(TOWN_DOT_R * 0.85).toFixed(2)}"/>`;
  }).join('\n');
  const offLabels = offRiverTowns.map((t) => emitLabel(
    `off-town:${t.name}`, t.pt[0] + (t.dx || 0), t.pt[1] + (t.dy || 0), t.anchor || 'middle', 'off-town-label', t.name
  )).join('\n');

  // Tributary rivers: thin light-blue polylines with a small italic label.
  const tribPaths = tributaries.map((tr) => {
    return `      <path class="tributary" d="${pathD(tr.pathPts)}"/>`;
  }).join('\n');
  const tribLabels = tributaries.map((tr) => emitLabel(
    `tributary:${tr.name}`, tr.labelPt[0], tr.labelPt[1], 'middle', 'tributary-label', tr.name
  )).join('\n');

  const canalPaths = canals.map((c) => {
    return `      <path class="canal" d="${pathD(c.pathPts)}"/>`;
  }).join('\n');
  const canalLabels = canals.map((c) => emitLabel(
    `canal:${c.name}`, c.labelPt[0], c.labelPt[1], 'middle', 'canal-label', c.name
  )).join('\n');

  const hillPolys = hills.map((h) => {
    // One polygon per outer ring — multipolygon AONBs can have >1 outer ring.
    return h.ringsPts.map((ring) => {
      const pts = ring.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      return `      <polygon class="hill-region" points="${pts}"/>`;
    }).join('\n');
  }).join('\n');
  const hillLabels = hills.map((h) => emitLabel(
    `hill:${h.name}`, h.labelPt[0], h.labelPt[1], 'middle', 'hill-label', h.name
  )).join('\n');

  const countyLines = counties.map((c) => {
    // Counties drawn as their outer polygon boundary (no fill).
    return c.ringsPts.map((ring) => {
      const pts = ring.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      return `      <polygon class="county-boundary" points="${pts}"/>`;
    }).join('\n');
  }).join('\n');
  const countyLabels = counties.map((c) => emitLabel(
    `county:${c.name}`, c.labelPt[0], c.labelPt[1], 'middle', 'county-label', c.name
  )).join('\n');

  const title = `
      <text class="title" x="${PAGE_W - MARGIN}" y="${PAGE_H - MARGIN - 6}" text-anchor="end">The Thames Path</text>
      <text class="subtitle" x="${PAGE_W - MARGIN}" y="${PAGE_H - MARGIN}" text-anchor="end">Lechlade to Teddington</text>
  `.trimEnd();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 ${PAGE_W} ${PAGE_H}"
     width="${PAGE_W}mm" height="${PAGE_H}mm"
     font-family="'Iowan Old Style','Palatino Linotype',Georgia,serif">
  <style>
    .bg { fill: #f6efe1; }
    /* HILLS layer — safe to delete this block and the g#hills group. */
    .hill-region {
      fill: #7a9260;
      opacity: 0.40;
    }
    .hill-label {
      font-size: 3.8px;
      fill: #3d4c33;
      font-style: italic;
      letter-spacing: 0.6px;
      text-transform: uppercase;
    }
    .county-boundary {
      fill: none;
      stroke: #6a5a48;
      stroke-width: 0.35;
      stroke-dasharray: 2.4 1.6;
      opacity: 0.55;
    }
    .county-label {
      font-size: 4.4px;
      fill: #6a5a48;
      font-style: italic;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      opacity: 0.7;
    }
    .town-area {
      fill: #d8c2a8;
      stroke: #b09880;
      stroke-width: 0.15;
      opacity: 0.55;
    }
    .off-town-area {
      fill: #d8c2a8;
      stroke: #b09880;
      stroke-width: 0.12;
      opacity: 0.32;
    }
    .tributary {
      fill: none;
      stroke: #7ba9ad;
      stroke-width: 0.9;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.95;
    }
    .tributary-label {
      font-size: 3px;
      fill: #6a8a8d;
      font-style: italic;
      letter-spacing: 0.2px;
    }
    .canal {
      fill: none;
      stroke: #7ba9ad;
      stroke-width: 0.85;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.95;
    }
    .canal-label {
      font-size: 3px;
      fill: #6a8a8d;
      font-style: italic;
      letter-spacing: 0.3px;
    }
    .off-town-dot {
      fill: #6a5a48;
    }
    .off-town-label {
      font-size: 3.4px;
      fill: #6a5a48;
      font-style: italic;
      font-weight: 500;
    }
    .river-outline {
      fill: none;
      stroke: #78a6ab;
      stroke-width: ${(RIVER_STROKE_MM + 0.5).toFixed(2)};
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.55;
    }
    .river {
      fill: none;
      stroke: #cfe7ea;
      stroke-width: ${RIVER_STROKE_MM};
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .halfband {
      fill: none;
      stroke: transparent;
      stroke-width: ${HALF_STROKE_MM};
      stroke-linecap: butt;
      stroke-linejoin: miter;
      cursor: pointer;
    }
    .halfband[data-fill="on"][data-side="a"] { stroke: #c04b3a; }
    .halfband[data-fill="on"][data-side="b"] { stroke: #2d6b8c; }
    .river-centreline {
      fill: none;
      stroke: #4a5a5c;
      stroke-width: ${CENTRELINE_STROKE_MM};
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.9;
    }
    .lock {
      fill: #f6efe1;
      stroke: #3a2f22;
      stroke-width: 0.28;
    }
    .lock-label {
      font-size: 2.6px;
      fill: #4a3a2c;
      font-style: italic;
      letter-spacing: 0.2px;
    }
    .town-dot {
      fill: #2a2a2a;
    }
    .town-label {
      font-size: 3.6px;
      fill: #2a2a2a;
      font-weight: 500;
    }
    .title {
      font-size: 8px;
      fill: #2a2a2a;
      font-weight: 600;
      letter-spacing: 0.4px;
    }
    .subtitle {
      font-size: 3.4px;
      fill: #5a5a5a;
      letter-spacing: 0.2px;
    }
  </style>

  <rect class="bg" x="0" y="0" width="${PAGE_W}" height="${PAGE_H}"/>

  <g id="counties">
${countyLines}
  </g>

  <g id="hills">
${hillPolys}
  </g>

  <g id="off-town-areas">
${offCircles}
  </g>

  <g id="town-areas">
${townCircles}
  </g>

  <g id="tributaries">
${tribPaths}
  </g>

  <g id="canals">
${canalPaths}
  </g>

  <g id="river-layer">
    <path class="river-outline" d="${riverPathD}"/>
    <path class="river" d="${riverPathD}"/>
  </g>

  <g id="halfbands">
${halfBands}
  </g>

  <g id="river-centreline-layer">
    <path class="river-centreline" d="${riverPathD}"/>
  </g>

  <g id="locks">
${lockMarkers}
  </g>

  <g id="lock-labels">
${lockLabels}
  </g>

  <g id="towns">
${townMarkers}
${townLabels}
  </g>

  <g id="off-towns">
${offDots}
${offLabels}
  </g>

  <g id="tributary-labels">
${tribLabels}
${canalLabels}
  </g>

  <g id="hill-labels">
${hillLabels}
  </g>

  <g id="county-labels">
${countyLabels}
  </g>

  <g id="title-block">${title}
  </g>
</svg>
`;
}

main();
