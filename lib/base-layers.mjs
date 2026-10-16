// Streets + Satellite base pair + Esri place-name overlay, shared by the
// river and path apps. Both pages create an empty layer control, pass it
// in here, then add their own corridor-specific overlays alongside.
//
// Depends on the global `L` from Leaflet.

export function installSharedBasemaps(map, layerControl, {
  offRiverLabelName = 'Place names (off-river)',
} = {}) {
  // Separate pane so Esri place-name tiles render above satellite imagery
  // (z-index 400) but below markers/popups (600+).
  if (!map.getPane('labelsPane')) {
    map.createPane('labelsPane');
    map.getPane('labelsPane').style.zIndex = 450;
    map.getPane('labelsPane').style.pointerEvents = 'none';
  }

  const baseStreets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '',
  });
  const baseSatellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery © Esri' },
  );
  const offRiverLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, pane: 'labelsPane' },
  );

  baseStreets.addTo(map);
  layerControl.addBaseLayer(baseStreets, 'Streets');
  layerControl.addBaseLayer(baseSatellite, 'Satellite');
  layerControl.addOverlay(offRiverLabels, offRiverLabelName);

  // OSM street tiles have labels baked in, so Esri place labels would double
  // up on Streets. On Streets we force the layer off AND disable the checkbox
  // so it reads as "not applicable here" rather than "turned off, go toggle".
  // On Satellite we restore whatever preference the user last expressed.
  let satOffRiverPref = true;
  let syncing = false;
  function syncOffRiverToBase() {
    const satellite = map.hasLayer(baseSatellite);
    const shouldShow = satellite && satOffRiverPref;
    syncing = true;
    if (shouldShow && !map.hasLayer(offRiverLabels)) offRiverLabels.addTo(map);
    else if (!shouldShow && map.hasLayer(offRiverLabels)) map.removeLayer(offRiverLabels);
    syncing = false;
    // Mirror checkbox state (Leaflet only repaints on its own click handler),
    // and disable it on Streets to make the "not available here" visible.
    // Invariant: offRiverLabels is the first overlay registered. If a caller
    // ever adds an overlay before invoking installSharedBasemaps, update this
    // selector to match on label text instead.
    const input = layerControl.getContainer()
      .querySelector('.leaflet-control-layers-overlays input[type="checkbox"]');
    if (input) {
      input.checked = shouldShow;
      input.disabled = !satellite;
    }
  }
  map.on('baselayerchange', syncOffRiverToBase);
  map.on('overlayadd overlayremove', (e) => {
    // Only treat user-driven overlay toggles as a preference change — otherwise
    // the base-switch auto-hide would wipe the user's choice on every bounce.
    if (!syncing && e.layer === offRiverLabels) {
      satOffRiverPref = (e.type === 'overlayadd');
    }
  });

  // Auto-fall-back on tile error. Catches the case where OSM's tile server is
  // reachable but refusing requests.
  baseStreets.on('tileerror', () => {
    if (map.hasLayer(baseStreets)) {
      map.removeLayer(baseStreets);
      baseSatellite.addTo(map);
      syncOffRiverToBase();
    }
  });

  // No baselayerchange fires on first paint, so reflect the initial state now.
  syncOffRiverToBase();

  return { baseStreets, baseSatellite, offRiverLabels };
}
