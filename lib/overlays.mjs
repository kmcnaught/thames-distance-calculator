// Shared Leaflet overlay builders for the accommodation + train-station
// layers. Both the river app (app.js) and the path page (path.js) import
// from here so a change to colouring, popup markup or legend lives in one
// place.
//
// This module depends on the global `L` from Leaflet and on the shared
// styles in lib/overlays.css (`.pop`, `.pop-name`, `.pop-meta`, `.pop-band`,
// `.pop-link`, `.band-swatch`). Pages must link that CSS themselves.
//
// Each layer builder takes an array of plain data records (parsed JSON) and
// returns an `L.LayerGroup` ready to be handed to `L.control.layers`.
// Legends are returned as HTML strings for inlining in the overlay label
// via `labelWithLegend()`.

export const BAND_COLOR = {
  cheap:        '#2a7d2a',
  medium:       '#c08020',
  medium_pricy: '#c45c3f',
  pricy:        '#7c3aed',
};
export const BAND_LABEL = {
  cheap:        '£ · cheap',
  medium:       '££ · medium',
  medium_pricy: '£££ · upper-mid',
  pricy:        '££££ · pricy',
};
export const TYPE_LABEL = {
  hotel: 'hotel',
  hostel: 'hostel',
  guest_house: 'B&B / guest house',
  bed_and_breakfast: 'B&B',
  motel: 'motel',
  chalet: 'chalet',
};

export const NETWORK_COLOR = {
  rail:       '#1e40af',
  tube:       '#dc2626',
  light_rail: '#0d9488',
};
export const NETWORK_LABEL = {
  rail: 'rail',
  tube: 'tube',
  light_rail: 'DLR / light rail',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function websiteLinkHtml(url) {
  if (!url) return '';
  return `<a class="pop-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hostnameOf(url))}</a>`;
}

// Filter helpers for the unified datasets. Each item carries both
// `along_river_m` and `along_path_m`; non-null means it's within the
// corresponding corridor's 1-mile buffer.
export const nearRiver = (items) => items.filter((a) => a.along_river_m != null);
export const nearPath  = (items) => items.filter((a) => a.along_path_m  != null);

export function accommodationLayer(items) {
  const group = L.layerGroup();
  for (const a of items) {
    const color = BAND_COLOR[a.band] || '#888';
    const marker = L.circleMarker([a.lat, a.lng], {
      radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9,
    });
    const html =
      `<div class="pop">` +
        `<div class="pop-name">${a.name ? escapeHtml(a.name) : '<em>unnamed</em>'}</div>` +
        `<div class="pop-meta">${escapeHtml(TYPE_LABEL[a.type] || a.type)}</div>` +
        `<div class="pop-band"><span class="band-swatch" style="background:${color}"></span>${escapeHtml(BAND_LABEL[a.band] || a.band)}</div>` +
        websiteLinkHtml(a.website) +
      `</div>`;
    marker.bindPopup(html);
    marker.addTo(group);
  }
  return group;
}

export function accommodationLegendHtml() {
  return (
    `<span class="band-swatch" style="background:${BAND_COLOR.cheap}"></span>£` +
    `<span class="band-swatch" style="background:${BAND_COLOR.medium};margin-left:4px"></span>££` +
    `<span class="band-swatch" style="background:${BAND_COLOR.medium_pricy};margin-left:4px"></span>£££` +
    `<span class="band-swatch" style="background:${BAND_COLOR.pricy};margin-left:4px"></span>££££`
  );
}

const stationIconCache = new Map();
function stationIcon(color) {
  if (stationIconCache.has(color)) return stationIconCache.get(color);
  const icon = L.divIcon({
    className: 'tp-station-pin',
    html:
      `<div style="background:${color};color:#fff;width:18px;height:18px;border-radius:3px;` +
      `display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;` +
      `font-family:system-ui,sans-serif;line-height:1;` +
      `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3);">T</div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  stationIconCache.set(color, icon);
  return icon;
}

export function stationsLayer(items) {
  const group = L.layerGroup();
  for (const s of items) {
    const color = NETWORK_COLOR[s.network] || '#555';
    const marker = L.marker([s.lat, s.lng], { icon: stationIcon(color) });
    const operatorBit = s.operator ? ` · ${escapeHtml(s.operator)}` : '';
    const html =
      `<div class="pop">` +
        `<div class="pop-name">${s.name ? escapeHtml(s.name) : '<em>unnamed station</em>'}</div>` +
        `<div class="pop-meta">${escapeHtml(NETWORK_LABEL[s.network] || s.network)}${operatorBit}</div>` +
        websiteLinkHtml(s.website) +
      `</div>`;
    marker.bindPopup(html);
    marker.addTo(group);
  }
  return group;
}

export function stationsLegendHtml() {
  return (
    `<span class="band-swatch" style="background:${NETWORK_COLOR.rail}"></span>rail` +
    `<span class="band-swatch" style="background:${NETWORK_COLOR.tube};margin-left:4px"></span>tube` +
    `<span class="band-swatch" style="background:${NETWORK_COLOR.light_rail};margin-left:4px"></span>DLR`
  );
}

// Format an overlay-picker label with a small coloured-swatch legend to the
// right of the name. HTML is allowed in L.control.layers overlay labels.
export function labelWithLegend(name, legendHtml) {
  return `${name} &nbsp; <span style="color:#888">${legendHtml}</span>`;
}

// Replace Leaflet's hover-to-expand / mouseleave-to-collapse layer-control
// behaviour with explicit click-to-toggle, and add a visible × button when
// expanded. Both apps apply this immediately after `.addTo(map)`.
export function tameLayerControl(control) {
  const container = control.getContainer();
  const toggle = container.querySelector('.leaflet-control-layers-toggle');

  // Suppress the mouseleave auto-collapse so the panel only closes via a
  // deliberate click. Nerfing `collapse` catches both the public method and
  // Leaflet's internal mouseleave binding (which routes through it in 1.9).
  const realCollapse = control.collapse.bind(control);
  control.collapse = () => control;
  control._collapse = () => {};

  // Replace the toggle-link's handler stack. Cloning the node strips every
  // event listener Leaflet attached (`focus`, touch click, etc.), then we
  // bind one click handler that toggles expand/collapse.
  let newToggle = toggle;
  if (toggle) {
    newToggle = toggle.cloneNode(true);
    toggle.parentNode.replaceChild(newToggle, toggle);
    L.DomEvent.on(newToggle, 'click', (e) => {
      L.DomEvent.stop(e);
      if (container.classList.contains('leaflet-control-layers-expanded')) {
        realCollapse();
      } else {
        control.expand();
      }
    });
    L.DomEvent.disableClickPropagation(newToggle);
  }

  // Explicit close icon, shown by CSS only when the panel is expanded.
  const closeBtn = L.DomUtil.create('button', 'leaflet-control-layers-close', container);
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close layers panel');
  closeBtn.innerHTML = '×';
  L.DomEvent.on(closeBtn, 'click', (e) => {
    L.DomEvent.stop(e);
    realCollapse();
  });
  L.DomEvent.disableClickPropagation(closeBtn);

  return control;
}

// --- Bus routes ----------------------------------------------------------
//
// `data` is the full baked bus-routes payload: { routes: {key: {...}}, stops: [...] }.
// `wantStop` is a predicate deciding which stops this corridor should show.
// Returns an object with:
//   - layer:    the L.LayerGroup to hand to L.control.layers
//   - setHover: (routeKeys: Set<string>|null) → styles the subset "hot" and
//               the rest "dim". Null restores the default all-equal style.
// The hover interaction is driven by the parent page.
export function busRoutesLayer(data, wantStop) {
  const stops = (data.stops || []).filter(wantStop);
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const routes = data.routes || {};

  // Which routes are relevant? Only routes with at least one in-corridor stop.
  const relevantRouteKeys = new Set();
  for (const s of stops) for (const k of s.routes) relevantRouteKeys.add(k);

  const group = L.layerGroup();
  const routePolylines = new Map();  // key → L.Polyline

  const DIM_STYLE = { opacity: 0.25, weight: 1.5 };
  const BASE_STYLE = { opacity: 0.55, weight: 2 };
  const HOT_STYLE  = { opacity: 0.95, weight: 4 };

  // Visual state has two orthogonal inputs: `pinnedKey` (sticky, click to
  // toggle) and `hoverKeys` (transient, hover). Hover wins over pinned
  // while active so the user can preview a different route without losing
  // the pinned one.
  let pinnedKey = null;
  let hoverKeys = null;

  function applyStyles() {
    const emphasise = hoverKeys ?? (pinnedKey ? new Set([pinnedKey]) : null);
    if (!emphasise) {
      for (const pl of routePolylines.values()) pl.setStyle(BASE_STYLE);
      return;
    }
    for (const [key, pl] of routePolylines) {
      pl.setStyle(emphasise.has(key) ? HOT_STYLE : DIM_STYLE);
      if (emphasise.has(key)) pl.bringToFront();
    }
  }

  for (const key of relevantRouteKeys) {
    const r = routes[key];
    // r.geometry is a multi-polyline: array of segments. Leaflet accepts
    // nested arrays and renders them as one layer, multiple visual lines.
    if (!r || !Array.isArray(r.geometry) || r.geometry.length === 0) continue;
    const pl = L.polyline(r.geometry, {
      color: r.colour || '#555',
      ...BASE_STYLE,
      lineCap: 'round', lineJoin: 'round',
      // Stops the map's click handler from firing when the user clicks on
      // the overlay itself (otherwise clicks on routes drop measurement pins).
      bubblingMouseEvents: false,
    });
    pl.bindTooltip(
      `<b>${escapeHtml(r.ref || '')}</b>${r.operator ? ' · ' + escapeHtml(r.operator) : ''}` +
      `${r.from || r.to ? `<br>${escapeHtml(r.from || '')} → ${escapeHtml(r.to || '')}` : ''}`,
      { sticky: true, direction: 'top' },
    );
    pl.on('mouseover', () => { hoverKeys = new Set([key]); applyStyles(); });
    pl.on('mouseout',  () => { hoverKeys = null; applyStyles(); });
    pl.on('click',     () => { pinnedKey = pinnedKey === key ? null : key; applyStyles(); });
    pl.addTo(group);
    routePolylines.set(key, pl);
  }

  // Stop markers (small, colour-neutral — the routes are the colourful bit).
  for (const s of stops) {
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 3, color: '#444', weight: 1, fillColor: '#fff', fillOpacity: 0.9,
      bubblingMouseEvents: false,
    });
    const serving = s.routes.map((k) => routes[k]?.ref).filter(Boolean);
    const html =
      `<div class="pop">` +
        `<div class="pop-name">${s.name ? escapeHtml(s.name) : '<em>bus stop</em>'}</div>` +
        `<div class="pop-meta">serves ${serving.length} route${serving.length === 1 ? '' : 's'}:` +
        ` ${serving.slice(0, 20).map(escapeHtml).join(', ')}${serving.length > 20 ? '…' : ''}</div>` +
      `</div>`;
    marker.bindPopup(html);
    marker.on('mouseover', () => { hoverKeys = new Set(s.routes); applyStyles(); });
    marker.on('mouseout',  () => { hoverKeys = null; applyStyles(); });
    marker.addTo(group);
  }

  function clearPinned() {
    if (pinnedKey == null) return;
    pinnedKey = null;
    applyStyles();
  }

  return { layer: group, clearPinned, nRoutes: routePolylines.size, nStops: stops.length };
}

export function busRoutesLegendHtml(paletteSample = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728']) {
  return paletteSample.map((c, i) =>
    `<span class="band-swatch" style="background:${c}${i ? ';margin-left:4px' : ''}"></span>`
  ).join('') + ' routes';
}
