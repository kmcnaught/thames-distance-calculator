// Minimal Thames Path distance app: click two spots, see along-trail distance.
// Pin interaction (place, drag, swap, URL round-trip, tap-near-trail gate)
// lives in lib/corridor.mjs; this file handles data loading, overlays, and
// the readout.

import { snap, haversine } from './lib/geo.mjs';
import * as overlays from './lib/overlays.mjs';
import { createCorridor } from './lib/corridor.mjs';
import { UNITS, M_PER_MILE, inUnit, fmtDist, altUnit, createUnitToggle } from './lib/units.mjs';
import { installSharedBasemaps } from './lib/base-layers.mjs';
import { enablePanelSwipe } from './lib/panel-swipe.mjs';
import { mergeWaymarks } from './lib/waymarks.mjs';
import { initStrip } from './strip.js';

const el = (id) => document.getElementById(id);
const map = L.map('map', { zoomControl: false });
L.control.zoom({ position: 'topright' }).addTo(map);

const layerControl = L.control.layers(null, null, { position: 'topright', collapsed: true }).addTo(map);
overlays.tameLayerControl(layerControl);
const { baseSatellite } = installSharedBasemaps(map, layerControl);

const data = await fetch('./data/thames-path.json').then((r) => r.json());
const { coords, cum } = data;

// Dark forest green reads well on OSM Streets; a lighter sage lifts the trail
// off satellite tree cover when the user switches base. The highlight shares
// sage on Streets (base is dark, highlight pops) and switches to a warm
// yellow on Satellite (where the base trail becomes sage itself).
const TRAIL_STREETS = { color: '#2d5016', weight: 3, opacity: 0.85 };
const TRAIL_SATELLITE = { color: '#9ac67a', weight: 3, opacity: 0.95 };
const HIGHLIGHT_STREETS = { color: '#9ac67a', weight: 7, opacity: 0.65 };
const HIGHLIGHT_SATELLITE = { color: '#facc15', weight: 7, opacity: 0.75 };
const line = L.polyline(coords, TRAIL_STREETS).addTo(map);
const highlight = L.polyline([], HIGHLIGHT_STREETS).addTo(map);
map.on('baselayerchange', () => {
  const sat = map.hasLayer(baseSatellite);
  line.setStyle(sat ? TRAIL_SATELLITE : TRAIL_STREETS);
  highlight.setStyle(sat ? HIGHLIGHT_SATELLITE : HIGHLIGHT_STREETS);
});
map.fitBounds(line.getBounds(), { padding: [40, 40] });

async function tryLoadLayer(url, build, legend, name) {
  try {
    const d = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${name} fetch: ${r.status}`);
      return r.json();
    });
    const raw = d.accommodation ?? d.stations ?? d.food ?? [];
    const items = overlays.nearPath(raw);
    const group = build(items);
    layerControl.addOverlay(group, overlays.labelWithLegend(name, legend));
    console.log(`[path] loaded ${items.length} ${name.toLowerCase()} (of ${raw.length} total)`);
  } catch (err) {
    console.warn(`[path] ${name.toLowerCase()} layer unavailable:`, err.message);
  }
}

await tryLoadLayer('./data/accommodation.json', overlays.accommodationLayer, overlays.accommodationLegendHtml(), 'Accommodation');
await tryLoadLayer('./data/stations.json',      overlays.stationsLayer,      overlays.stationsLegendHtml(),      'Train stations');
await tryLoadLayer('./data/food.json',          overlays.foodLayer,          overlays.foodLegendHtml(),          'Pubs & cafés');

let busLayer = null;
try {
  const busData = await fetch('./data/bus-routes.json').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  busLayer = overlays.busRoutesLayer(busData, (s) => s.along_path_m != null);
  layerControl.addOverlay(busLayer.layer, overlays.labelWithLegend('Bus routes', overlays.busRoutesLegendHtml(busData.meta?.palette)));
  console.log(`[path] bus-routes: ${busLayer.nRoutes} routes, ${busLayer.nStops} stops in corridor`);
} catch (err) {
  console.warn('[path] bus-routes layer unavailable:', err.message);
}

const corridor = createCorridor({
  map,
  snap: (target) => snap(coords, cum, target),
  colors: { A: '#e11d48', B: '#0891b2' },
  tapSnapPx: 40,
  onChange: refresh,
});

const unitToggle = createUnitToggle({
  checkbox: el('units-km'),
  storageKey: 'thamespath.unitsKm',
  onChange: refresh,
});

// Clear any pinned bus route whenever the user interacts with the map.
map.on('click', () => busLayer?.clearPinned());

function refresh() {
  try { refreshInner(); } finally { syncDistanceChip?.(); }
}
function refreshInner() {
  const { A, B } = corridor.getPins();
  if (!A && !B) {
    el('readout').hidden = true;
    el('hint').innerHTML = 'Click the map to drop pin <span class="pin-chip pin-a">A</span>.';
    el('btn-swap').disabled = true;
    el('btn-clear').disabled = true;
    highlight.setLatLngs([]);
    return;
  }
  el('btn-clear').disabled = false;
  if (!A || !B) {
    el('readout').hidden = true;
    const nextLetter = !A ? 'A' : 'B';
    el('hint').innerHTML = `Click the map to drop pin <span class="pin-chip pin-${nextLetter.toLowerCase()}">${nextLetter}</span>.`;
    el('btn-swap').disabled = true;
    highlight.setLatLngs([]);
    return;
  }
  el('hint').textContent = 'Click the map again to move the nearer pin.';
  el('btn-swap').disabled = false;
  const trailM = Math.abs(A.snap.along - B.snap.along);
  const straightM = haversine(A.snap.latlng, B.snap.latlng);
  const u = unitToggle.activeUnit();
  const au = altUnit(u);
  el('dist-primary').textContent = inUnit(trailM, u).toFixed(2);
  el('dist-primary-unit').textContent = `${UNITS[u].label} on the trail`;
  el('dist-secondary').textContent = fmtDist(trailM, 2, au);
  el('dist-straight').textContent = `${fmtDist(straightM, 2, u)} straight`;
  el('readout').hidden = false;

  const maxOff = Math.max(A.snap.off, B.snap.off);
  if (maxOff > 200) {
    el('warn').hidden = false;
    el('warn').textContent =
      `Pin ${A.snap.off > B.snap.off ? 'A' : 'B'} is ${maxOff.toFixed(0)} m from the trail — distance snaps to the nearest point.`;
  } else {
    el('warn').hidden = true;
  }

  const [lo, hi] = A.snap.along < B.snap.along ? [A.snap, B.snap] : [B.snap, A.snap];
  const stretch = [lo.latlng.slice()];
  for (let k = lo.i + 1; k <= hi.i; k++) stretch.push(coords[k]);
  stretch.push(hi.latlng.slice());
  highlight.setLatLngs(stretch);
}

el('btn-swap').addEventListener('click', () => corridor.swap());
el('btn-clear').addEventListener('click', () => {
  corridor.clearAll();
  clearStripFocus();
});

const panel = el('panel');
function setCollapsed(collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  panel.classList.toggle('expanded', !collapsed);
  el('panel-toggle').setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  syncDistanceChip();
}
el('panel-toggle').addEventListener('click', () => {
  setCollapsed(!panel.classList.contains('collapsed'));
});
enablePanelSwipe(panel, panel.querySelector('.panel-body'), { onChange: syncDistanceChip });

// Distance chip — only visible when panel collapsed on the Measure tab with
// an active reading.
function syncDistanceChip() {
  const collapsed = panel.classList.contains('collapsed');
  const onMeasure = !el('tab-measure').hidden;
  const hasReading = !el('readout').hidden;
  const show = collapsed && onMeasure && hasReading;
  el('distance-chip').hidden = !show;
  if (show) {
    el('chip-value').textContent = el('dist-primary').textContent;
    el('chip-unit').textContent = el('dist-primary-unit').textContent;
  }
}
el('distance-chip').addEventListener('click', () => setCollapsed(false));

// Tabs
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) {
      const active = t.dataset.tab === which;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const key of ['measure', 'strip']) {
      el(`tab-${key}`).hidden = key !== which;
    }
    syncDistanceChip();
  });
}

// Strip view — curated waypoints with path_mi join against transport by name.
let stripFocus = null;
function clearStripFocus() {
  if (stripFocus) { map.removeLayer(stripFocus); stripFocus = null; }
}
try {
  const [curatedRes, transportRes] = await Promise.all([
    fetch('./data/curated-waypoints.json'),
    fetch('./data/curated-transport.json'),
  ]);
  if (curatedRes.ok) {
    const curated = await curatedRes.json();
    const transport = transportRes.ok ? await transportRes.json() : { transport: [] };
    // Defensive: skip waymarks the curated pipeline couldn't anchor to the
    // trail. Currently a no-op (all 70 curated entries have path_mi) but
    // guards against future entries missing a trail position.
    const waymarks = mergeWaymarks({ curated, transport })
      .filter((w) => w.path_mi != null);
    const totalM = cum[cum.length - 1];
    initStrip({
      container: el('tab-strip'),
      waymarks,
      totalM,
      distanceM: (w) => w.path_mi * M_PER_MILE,
      corridorNoun: 'trail',
      onFocus: (latlng) => {
        map.panTo(latlng, { animate: true });
        clearStripFocus();
        stripFocus = L.circleMarker(latlng, {
          radius: 7, color: '#2d5016', fillColor: '#facc15', fillOpacity: 0.9, weight: 2,
        }).addTo(map);
      },
    });
  }
} catch (err) {
  console.warn('[path] strip view unavailable:', err.message);
}

// Hydrate from ?a=&b= if present.
const restored = corridor.restoreFromUrl();
if (restored.A && restored.B) {
  map.fitBounds([restored.A, restored.B], { padding: [60, 60] });
} else if (restored.A || restored.B) {
  map.setView(restored.A || restored.B, 14);
}

refresh();
