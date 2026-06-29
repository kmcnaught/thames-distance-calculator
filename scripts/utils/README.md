# Build utilities

Shared helpers for the Thameswise build pipeline. Per the global scripts policy: log every utility module here.

| Module | Purpose |
|---|---|
| `geo.mjs` | Re-exports `lib/geo.mjs` — single source of truth for haversine, snap, measure, reachPts, buildCum, simplify. The browser app and the build scripts import the same code. |
| `overpass.mjs` | POST to Overpass API with mirror fallback + timeout. `await overpass(query)` returns parsed JSON. |
| `stitch.mjs` | Dijkstra-based stitching of unordered OSM `way` segments into a single ordered channel from the westmost endpoint to a target latlng (used to clip to Teddington Lock). Per THAMES_HANDOFF.md §5. |

Build entrypoints live one level up in `scripts/`:

| Script | Phase | What it does |
|---|---|---|
| `build-thames.mjs` | 1 | Fetches + stitches + simplifies → `data/thames.json` |
| `build-launches.mjs` | 2 | EA AIMS + OSM slipways + put-ins → `data/launches.json` |
| `build-campsites.mjs` | 3 | OSM `tourism=camp_site` within 2 km → `data/campsites.json` |
| `build-parking.mjs` | 3 | OSM `amenity=parking` within 500 m of launches → `data/parking.json` |
| `build-bridges.mjs` | 2 | OSM `highway+bridge=yes` intersecting the centreline → `data/bridges.json` (used as put-ins) |
| `build-extras.mjs` | 2 | OSM piers, quays, weirs, ferry terminals snapped to the river → `data/extras.json` |
