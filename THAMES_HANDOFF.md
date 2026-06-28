# Thames on-river distance — build handoff

A working prototype ("Thalweg") that measures the distance **along the river channel** between two
points on the Thames, versus the straight line. This doc is the carry-over for a fresh, hosted static
build. It records the data sources, the algorithm (validated), the stitching approach (needs live
verification), what broke, and the recommended architecture for the rewrite.

---

## 1. The problem in one paragraph

"On-river distance" = follow the water, not the crow's flight. You need (a) an **ordered centreline**
of the Thames as lat/lng vertices from source to sea, (b) a way to **snap** each chosen point onto
that line, and (c) the **distance along the line** between the two snapped positions. Everything else
(map, markers, search, units) is presentation around those three steps.

---

## 2. Key architecture decision

The prototype used a **hybrid**: a coarse centreline baked in (always works offline) + a runtime
upgrade to high-resolution OpenStreetMap geometry in the browser.

**For the new static app, drop the hybrid. Bake the good geometry at build time.** Fetch + stitch +
simplify the Thames once as a build step, commit a single `thames.json`, and ship it. This removes the
runtime fetch, the stitching fragility, and the "is Overpass up?" dependency, and makes snapping
instant. The runtime-upgrade dance only existed because the prototype's build sandbox couldn't reach
Overpass (see §6). Claude Code can.

---

## 3. Data sources (what worked, what didn't)

### Authoritative centreline: OpenStreetMap
The Thames is tagged `waterway=river`, `name="River Thames"`, as many `way` segments (often grouped in
a waterway relation). Query the **ways directly** — cleaner than the relation, which can include
riverbank/outline members you don't want:

```
[out:json][timeout:180];
way["waterway"="river"]["name"="River Thames"];
out geom;
```

`out geom;` returns each way with a full `geometry: [{lat,lon}, …]`. Endpoints:
`https://overpass-api.de/api/interpreter` (POST `data=<query>`), with
`https://overpass.kumi.systems/api/interpreter` as a mirror.

Returns hundreds of unordered segments. You must stitch them into one ordered main stem (§5).

### Guaranteed fallback: Natural Earth (used in prototype)
`ne_10m_rivers_lake_centerlines` contains a single ordered "Thames" LineString — **152 points,
~266.5 km, source→estuary**, already in flow order. Coarse (~1.75 km spacing): fine for the upper
river, but it cuts corners through central London's meanders and stops short of the outer estuary.
Good only as an offline backstop, not as the primary for a real tool.

- Repo (GitHub raw reachable): `martynafford/natural-earth-geojson`
- Path: `10m/physical/ne_10m_rivers_lake_centerlines.json`
- Filter: `feature.properties.name === "Thames"`, geometry is `LineString`, coords are `[lng,lat]`.

The extracted/minified `[lat,lng]` version is attached as `thames_fallback.json` if you want a
zero-dependency placeholder while wiring things up.

### Better-than-OSM options (worth considering)
- **OS Open Rivers** (Ordnance Survey, Open Government Licence) — clean topologically-linked UK river
  network; arguably nicer connectivity than OSM.
- **Environment Agency "Detailed River Network"** — authoritative for England.
Both are OGL-licensed. OSM is the path of least resistance; reach for these only if OSM topology
gives you grief.

### Geocoding (place-name search): Nominatim
`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&viewbox=-2.3,52.05,1.0,51.15&q=…`
Works with CORS. Respect the usage policy: ≤1 request/second, send a real `User-Agent`/`Referer`,
debounce input. For production volume, self-host Nominatim or use a keyed provider (Photon, Mapbox).

---

## 4. The measuring algorithm (validated in Node — this part is solid)

Store the centreline as `[[lat,lng], …]`. Precompute cumulative metres once.

```js
const R = 6371000, D2R = Math.PI/180;

function haversine(a, b){
  const la1=a[0]*D2R, la2=b[0]*D2R, dla=(b[0]-a[0])*D2R, dlo=(b[1]-a[1])*D2R;
  const h = Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildCum(line){                     // cumulative distance at each vertex
  const c = [0];
  for (let i=1; i<line.length; i++) c[i] = c[i-1] + haversine(line[i-1], line[i]);
  return c;
}

// Snap a [lat,lng] to the nearest point on the line.
// Projects onto each segment in a local equirectangular metre space (good at river scale).
function snap(line, cum, target){
  let best = {d2: Infinity, i: 0, t: 0};
  const mLat = 111320, mLng = 111320 * Math.cos(target[0]*D2R);
  for (let i=0; i<line.length-1; i++){
    const ax=(line[i][1]-target[1])*mLng,   ay=(line[i][0]-target[0])*mLat;
    const bx=(line[i+1][1]-target[1])*mLng, by=(line[i+1][0]-target[0])*mLat;
    const ux=bx-ax, uy=by-ay, uu=ux*ux+uy*uy;
    let t = uu>0 ? -(ax*ux + ay*uy)/uu : 0;
    t = t<0 ? 0 : t>1 ? 1 : t;
    const px=ax+t*ux, py=ay+t*uy, d2=px*px+py*py;
    if (d2 < best.d2) best = {d2, i, t};
  }
  const A=line[best.i], B=line[best.i+1];
  const latlng=[A[0]+best.t*(B[0]-A[0]), A[1]+best.t*(B[1]-A[1])];
  return {
    latlng,
    along: cum[best.i] + haversine(A, latlng),  // metres from source
    off:   Math.sqrt(best.d2),                  // how far the point was from the river
    i: best.i, t: best.t
  };
}

// Derived quantities
function measure(line, cum, ptA, ptB){
  const a = snap(line, cum, ptA), b = snap(line, cum, ptB);
  const river    = Math.abs(a.along - b.along);
  const straight = haversine(a.latlng, b.latlng);
  return {
    river, straight,
    sinuosity: straight>0 ? river/straight : 1,
    upstream:  a.along < b.along ? 'A' : 'B',
    a, b
  };
}

// The highlighted stretch to draw on the map (ordered source→sea between the snaps)
function reachPts(line, a, b){
  if (a.along > b.along) [a, b] = [b, a];
  const pts = [a.latlng.slice()];
  for (let k=a.i+1; k<=b.i; k++) pts.push(line[k]);
  pts.push(b.latlng.slice());
  return pts;
}
```

Units: km = m/1000, miles = m/1609.344, nautical miles = m/1852.

**Sanity numbers** from the coarse Natural Earth line (real values are higher because that line
under-samples bends — this is the argument for using OSM):

| Pair | river (coarse) | straight | note |
|---|---|---|---|
| Westminster ↔ Tower Bridge | 3.7 km | 3.3 km | real ≈ 4 km |
| Putney ↔ Tower Bridge | 11.1 km | 10.3 km | real ≈ 12–13 km |
| Oxford ↔ Reading | 54 km | 38 km | real ≈ 60+ km |
| Richmond ↔ Greenwich | 27 km | 22 km | ok |

---

## 5. Stitching OSM ways into one ordered line (needs live verification)

OSM gives unordered segments; islands/eyots create parallel branches and the estuary has
distributaries. The approach the prototype implemented — **conceptually sound but never run against
live Overpass** (sandbox blocked it), so test it for real:

1. Build a graph: nodes = segment endpoints (round lat/lng to ~5 dp as the key), edges = ways
   weighted by their haversine length.
2. Pick **source** = westmost endpoint, **mouth** = eastmost endpoint.
3. **Dijkstra** shortest path source→mouth. In a near-linear river graph this returns one continuous
   channel and naturally picks a single side around each island.
4. Reconstruct coordinates by concatenating the chosen segments in path order (reverse a segment when
   traversed tail-first), dedup shared endpoints.
5. **Validate before adopting:** ≥200 points, longitude span roughly source (< −1.4) to estuary
   (> 0.2), total length 200–430 km. Otherwise the stitch failed — fall back.

Two things to watch when you run it live:
- Disconnected pieces / data gaps → Dijkstra finds no path. Have a greedy nearest-endpoint fallback or
  fix the gap.
- The estuary terminus is ambiguous (where does "the Thames" stop — Teddington? the Nore? Southend?).
  Decide the downstream cut-off explicitly rather than letting "eastmost node" pick it for you.

Do this once as a build step; commit the result. Don't ship the stitcher to the browser.

---

## 6. What broke / gotchas (the useful part)

- **Pale basemap reads as blank.** CARTO Positron (`light_all`) is so light it looked empty on mobile —
  the first thing the user hit. Default to an information-rich basemap (standard OSM
  `{s}.tile.openstreetmap.org`, or MapLibre vector), and offer a layer switcher (Streets / Detailed /
  Satellite). Handle Leaflet `tileerror` to auto-fall-back if a provider is blocked.
- **Control collisions.** A left-docked panel sits on top of Leaflet's default top-left zoom control.
  Move zoom + layer controls to the top-right (or wherever the panel isn't).
- **Coordinate order.** Leaflet wants `[lat, lng]`. Natural Earth gives `[lng, lat]`; Overpass `out geom`
  gives `{lat, lon}`. Convert at the boundary and never again.
- **Off-river points.** Snap distance can be large and meaningful — e.g. a "Southend" pin snapped 24 km
  because the coarse line ended short of the outer estuary. Surface the snap offset and warn when it's
  big; don't silently measure to a far-away point.
- **Build sandbox could not reach Overpass** (egress proxy 403). GitHub raw was reachable, which is why
  Natural Earth got baked in and OSM was deferred to runtime. Not a constraint you'll have in Claude
  Code — fetch Overpass at build time.
- **Artifact-only constraints that no longer apply** (you're leaving artifacts): no `localStorage`,
  external scripts only from cdnjs. Free to ignore now.
- **Nominatim politeness:** debounce, `countrycodes=gb`, a `viewbox` bias, ≤1 req/s.

---

## 7. Recommended build for the hosted static app

- **Geometry pipeline (build step, run once / on a schedule):** Overpass → stitch (§5) → simplify with
  Douglas–Peucker (~5–10 m tolerance is a good size/accuracy trade) → precompute cumulative distances →
  emit a compact `thames.json` (e.g. `{coords: [[lat,lng]…], cum: [m…]}`; consider typed arrays /
  flat `Float32Array` packing if size matters). Commit it.
- **Snapping at scale:** once the line has 10k+ vertices, scanning every vertex on every mouse-move is
  wasteful. Add a coarse spatial index — a simple lat/lng grid bucketing segment indices, or an R-tree
  (`rbush`) — and only test nearby segments.
- **Map:** Leaflet is fine and quick. MapLibre GL gives crisper vector basemaps and smooth zoom if you
  want to spend the time. Host on Cloudflare Pages / Netlify / GitHub Pages.
- **Nice-to-haves that fit the subject:**
  - Lock-by-lock or bridge-by-bridge breakdown along the reach.
  - Tidal vs non-tidal split at Teddington (the practical "river vs tideway" boundary).
  - Shareable URL encoding A and B (e.g. `?a=lat,lng&b=lat,lng`).
  - Nautical miles for the tidal reach; elevation profile for the non-tidal river.
  - Keyboard nav through search results; "search fills A then B" on consecutive entries.

---

## 8. Decisions to make before coding

1. **Downstream terminus** of "the Thames" — Teddington, the Nore, or Southend? This sets your data
   extent and the longest measurable distance.
2. **What a point snaps to** — the OSM centreline is a good proxy for the thalweg (deepest channel),
   but it's a proxy; fine for distance, worth a sentence in your UI copy.
3. **How to treat off-river points** — clamp + warn (prototype behaviour), reject, or measure to the
   nearest bank.
4. **Geocoder** — Nominatim for low volume vs a keyed/hosted provider for production.

---

## 9. Reusable assets to carry over

- `thames_fallback.json` — Natural Earth Thames as ordered `[lat,lng]`, 152 pts (placeholder/backstop).
- The functions in §4 (validated) — drop-in for snapping + measuring.
- The Overpass query (§3) and stitch recipe (§5) — for the build-time pipeline.
- Landmark coordinates used for quick-chips (Source, Lechlade, Oxford, Wallingford, Reading, Henley,
  Marlow, Windsor, Staines, Hampton Court, Kingston, Richmond, Kew, Putney, Westminster, Tower Bridge,
  Greenwich, Thames Barrier, Dartford, Gravesend, Southend) — available on request.

The genuinely hard-won parts are the snapping math (done) and the stitch-to-single-channel step (do it
at build time and verify against the real Overpass response). Everything else is straightforward.
