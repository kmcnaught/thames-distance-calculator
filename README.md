# Thalweg

On-river distance + trip planner for the non-tidal Thames (Lechlade → Teddington).
Click two spots on a map, see the channel-following distance. Or open "Find trips"
and the app enumerates put-in / take-out pairs of a given length, optionally with
a campsite near the take-out and parking at the put-in.

Static site. Vanilla JS + Leaflet. Data is baked at build time from OpenStreetMap
(via Overpass) — no live API calls at runtime.

## Run locally

```bash
npx serve            # serves http://localhost:3000
```

Open in a browser. That's it — no `npm install` to use the site, the data files
are committed.

The deployed site lives at https://kmcnaught.github.io/thames-distance-calculator/
(GitHub Pages, served from the repo root on `main`).

## Rebuild the data

Requires Node 18+ (for native `fetch`). Run each script from the repo root:

```bash
node scripts/build-thames.mjs        # → data/thames.json     (centreline, ~95 KiB)
node scripts/build-launches.mjs      # → data/launches.json   (locks + slipways + put-ins)
node scripts/build-campsites.mjs     # → data/campsites.json  (within 2 km of river)
node scripts/build-parking.mjs       # → data/parking.json    (within 500 m of launches)
```

The thames build talks to the public Overpass API; expect 30–120 s per script.
Run them in order — campsites and parking depend on the others' output.

```bash
node scripts/sanity-check.mjs        # measure known bridge-to-bridge pairs against
                                     # canonical Thames distances
```

## URL state

The current pin pair is encoded in the URL:

    http://…/?a=51.4630,-0.9760&b=51.5390,-0.8997

Copy to share a route; the "Share link" button does this.

## Scope

- **Non-tidal Thames only** (Lechlade → Teddington Lock, ~234 km, 45 locks).
  Tidal points (Westminster, Tower Bridge, Putney, etc.) snap with a warning
  rather than measure into the tideway.
- **No live data fetches.** Everything is OGL/ODbL bakeable; the only network
  load at runtime is Leaflet's tile fetch.
- **No accommodation, no public transport, no booking integration.** v1
  intentionally narrow.

## Attribution

Data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Lock coordinates cross-checked against Environment Agency data (Open Government Licence).

## Repo

- `scripts/` — build pipeline. See `scripts/utils/README.md`.
- `index.html`, `app.js`, `app.css` — the deployable site (Leaflet from CDN).
- `lib/geo.mjs` — canonical snap/measure module, shared between the browser
  app and the build scripts.
- `data/` — baked OSM/EA inputs the site loads at runtime.
- `THAMES_HANDOFF.md` — original carry-over notes that informed the design.

## Known sharp edges

- Lock count is 47 rather than the canonical 45 because OSM separates some
  multi-gate lock complexes (e.g. Teddington has three named gates). Acceptable
  — they cluster within ~200 m and won't break trip enumeration.
- A few OSM-mapped fragments around Maidenhead are stitched across a 31 m
  micro-gap; small bridges across OSM data quality issues are flagged in the
  build log.
- The upstream terminus is whatever OSM's westmost `River Thames` endpoint
  resolves to — currently a node around Cricklade, slightly upstream of
  Lechlade. The "0 km" mark in the UI corresponds to that point.
