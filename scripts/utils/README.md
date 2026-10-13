# Build utilities

Shared helpers for the Thameswise build pipeline. Per the global scripts policy: log every utility module here.

| Module | Purpose |
|---|---|
| `geo.mjs` | Re-exports `lib/geo.mjs` — single source of truth for haversine, snap, measure, reachPts, buildCum, simplify. The browser app and the build scripts import the same code. |
| `overpass.mjs` | POST to Overpass API with mirror fallback + timeout. `await overpass(query)` returns parsed JSON. |
| `stitch.mjs` | Dijkstra-based stitching of unordered OSM `way` segments into a single ordered channel from the westmost endpoint to a target latlng (used to clip to Teddington Lock). Per THAMES_HANDOFF.md §5. |
| `lookup-curated-coords.mjs` | One-shot resolver for `data/curated-waypoints.json`. Populates each entry with `lat`, `lng`, `along_m`, `offset_m`, `side` by joining locks against `launches.json`, bridges against `bridges.json`, settlements via a cached Overpass `place=*` query, and stragglers via a hand-coded `LANDMARK_COORDS` map inside the script. Dry-run by default; `--write` mutates the JSON. Overpass response is cached to `.overpass-cache-settlements.json` (gitignored) so re-runs don't re-hit the API. |

Build entrypoints live one level up in `scripts/`:

| Script | Phase | What it does |
|---|---|---|
| `build-thames.mjs` | 1 | Fetches + stitches + simplifies → `data/thames.json` |
| `build-launches.mjs` | 2 | EA AIMS + OSM slipways + put-ins → `data/launches.json` |
| `build-campsites.mjs` | 3 | OSM `tourism=camp_site` within 2 km → `data/campsites.json` |
| `build-parking.mjs` | 3 | OSM `amenity=parking` within 500 m of launches → `data/parking.json` |
| `build-bridges.mjs` | 2 | OSM `highway+bridge=yes` intersecting the centreline → `data/bridges.json` (used as put-ins) |
| `build-extras.mjs` | 2 | OSM piers, quays, weirs, ferry terminals snapped to the river → `data/extras.json` |
| `build-tributaries.mjs` | 2 | OSM named rivers (Cherwell, Kennet, Wey, Mole) + K&A Canal, bbox-clipped, stitched → `data/tributaries.json`. Named rivers get a straight-line stub to their confluence if they end short; canals do not. |
| `build-hills.mjs` | 2 | OSM AONBs ("National Landscape") relations — Cotswolds, Chilterns, North Wessex Downs, Surrey Hills — outer rings simplified → `data/hills.json` |
| `build-counties.mjs` | 2 | OSM `admin_level=6` ceremonial counties around the Thames corridor → `data/counties.json` (dashed boundary lines on the poster) |
| `build-town-boundaries.mjs` | 2 | OSM `landuse=residential` polygons per town, buffered + unioned via `polygon-clipping` into coalesced blobs (fewer bigger shapes than individual neighbourhoods) → `data/town-boundaries.json`. Also stores a convex hull as fallback. |
| `build-poster.mjs` | 4 | Assembles the A3 colouring poster SVG from the above baked data → `poster.svg`. Depends on Thames, launches, tributaries, hills, counties, and (optional) town-boundaries. |
| `fetch-missing-towns.mjs` | ad-hoc | Re-fetches only the named towns from `build-town-boundaries.mjs` and merges into `data/town-boundaries.json`. Use when a full run leaves 5xx failures behind. |
