// Merge helper for the strip view.
//
// Fuses three sources into a single sorted-by-along_m list of "waymarks":
//   1. data/curated-waypoints.json  — the walkthethames-guide whitelist
//                                     (towns, villages, named bridges, some locks,
//                                     landmarks) with amenity flags
//   2. data/launches.json           — locks (slipways are ignored here — they're
//                                     put-in candidates, not landmarks worth
//                                     surfacing on the strip)
//   3. data/curated-transport.json  — rail/bus mentions joined onto curated
//                                     entries by name
//
// Pure function: takes parsed JSON in, returns a plain array. No fetch, no DOM.
// Imported by the browser app (strip.js) and callable from Node for smoke tests.
//
// Output shape per entry:
// {
//   id:         'curated:cricklade' | 'lock:way-291657107'
//   name:       string
//   kind:       'town' | 'village' | 'hamlet' | 'lock' | 'bridge' | 'landmark'
//   tier:       'major' | 'minor'
//   along_m:    number   // metres from OSM's westmost Thames endpoint
//   offset_m:   number   // straight-line metres from the centreline
//   side:       'L' | 'R' | 'C' | null
//   lat, lng:   number
//   amenities:  { pub, cafe, shop, camping, toilets, boat_hire } | null
//   transport:  [{ kind, station, walk_mi, walk_note, destinations, notes }] | null
//   source:     'curated' | 'launches'
//   path_mi:    number | null  // walker's distance-from-source, when known
// }

export function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Two locks are "the same" if their along_m values are within this tolerance.
// Set well above the ~5 m drift between snap-in-resolver and snap-in-launches,
// but far below the ~1 km typical spacing between consecutive locks so we
// never merge distinct ones.
const LOCK_DEDUP_TOLERANCE_M = 500;

export function mergeWaymarks({ curated, transport, launches } = {}) {
  const curatedWaypoints = curated?.waypoints || [];
  const transportEntries = transport?.transport || [];
  const launchList = launches?.launches || [];

  const transportByName = new Map();
  for (const t of transportEntries) {
    const arr = transportByName.get(t.waypoint) || [];
    arr.push(t);
    transportByName.set(t.waypoint, arr);
  }

  const curatedLockAlongMs = curatedWaypoints
    .filter((w) => w.kind === 'lock')
    .map((w) => w.along_m);

  const out = [];

  for (const w of curatedWaypoints) {
    const t = transportByName.get(w.name);
    out.push({
      id: `curated:${slugify(w.name)}`,
      name: w.name,
      kind: w.kind,
      tier: w.tier,
      along_m: w.along_m,
      offset_m: w.offset_m,
      side: w.side,
      lat: w.lat,
      lng: w.lng,
      amenities: w.amenities || null,
      transport: t?.length ? t : null,
      source: 'curated',
      path_mi: w.path_mi ?? null,
    });
  }

  for (const l of launchList) {
    if (l.type !== 'lock') continue;
    // Drop unnamed locks — OSM has a few (e.g. a nameless one adjacent to Osney
    // Lock, and another next to Sunbury) that appear to be secondary gates of a
    // multi-gate complex or mis-tagged features. Every canonical Thames lock
    // has a name in OSM; anything unnamed is noise on the strip.
    if (!l.name) continue;
    const dup = curatedLockAlongMs.some(
      (m) => Math.abs(m - l.along_m) < LOCK_DEDUP_TOLERANCE_M
    );
    if (dup) continue;
    const idSuffix = l.osm_id ? l.osm_id.replace('/', '-') : slugify(l.name || 'lock');
    out.push({
      id: `lock:${idSuffix}`,
      name: l.name || 'Lock',
      kind: 'lock',
      tier: 'minor',
      along_m: l.along_m,
      offset_m: l.snap_offset_m ?? 0,
      side: null,
      lat: l.lat,
      lng: l.lng,
      amenities: null,
      transport: null,
      source: 'launches',
      path_mi: null,
    });
  }

  out.sort((a, b) => a.along_m - b.along_m);
  return out;
}
