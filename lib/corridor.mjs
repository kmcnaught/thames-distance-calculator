// Corridor interaction core: two pins (A/B) on a corridor (river or trail),
// click/drag to place, drag to refine, URL state round-trip. Owns pin
// markers, slot picking (empty-first, else nearest-to-tap), the
// tap-near-corridor gate, swap/clear ops. Measurement, highlight rendering
// and readout formatting stay with the caller — the module is agnostic
// about corridor shape.
//
// The browser-bound `createCorridor()` depends on the global `L` from
// Leaflet. The pure helpers (`pinsToQuery`, `parsePinsFromQuery`,
// `pickSlot`, `copyShareLink`, `defaultPinIcon`) are importable from Node
// for tests.

import { haversine } from './geo.mjs';

const DEFAULT_COLORS = { A: '#e11d48', B: '#0891b2' };

export function defaultPinIcon(letter, color) {
  return L.divIcon({
    className: 'corridor-pin',
    html: `<div style="background:${color};color:#fff;width:26px;height:26px;border-radius:50%;` +
          `display:flex;align-items:center;justify-content:center;font-weight:700;` +
          `box-shadow:0 2px 6px rgba(0,0,0,.3);border:2px solid #fff;">${letter}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

export function pinsToQuery({ A, B }) {
  const p = new URLSearchParams();
  const fmt = ([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (A) p.set('a', fmt(A));
  if (B) p.set('b', fmt(B));
  return p.toString();
}

export function parsePinsFromQuery(search) {
  const p = new URLSearchParams(search);
  const parse = (s) => {
    if (!s) return null;
    const [lat, lng] = s.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  };
  return { A: parse(p.get('a')), B: parse(p.get('b')) };
}

// Decide which slot a tap fills: an empty one first, else whichever
// existing pin is closer. Pure; exported for testing.
export function pickSlot(pins, target) {
  if (!pins.A) return 'A';
  if (!pins.B) return 'B';
  return haversine(target, pins.A.latlng) <= haversine(target, pins.B.latlng) ? 'A' : 'B';
}

export async function copyShareLink() {
  try { await navigator.clipboard.writeText(location.href); return true; }
  catch { return false; }
}

export function createCorridor({
  map,
  snap,                       // (target: [lat,lng]) => snapResult with .latlng + .off, or null
  colors = DEFAULT_COLORS,
  iconFactory = defaultPinIcon,
  tapSnapPx = 40,             // null to disable the tap-near-corridor gate
  showSnapLines = false,
  updateUrl = true,
  onChange,                   // ({ A, B }) => void after every state change
}) {
  const pins = { A: null, B: null };  // each: { latlng, snap, marker, snapLine }

  // batch() defers emit until the outermost call returns, so multi-step
  // operations (swap, restoreFromUrl) notify the caller and rewrite the URL
  // once instead of per intermediate step.
  let batchDepth = 0;
  let batchDirty = false;
  function batch(fn) {
    batchDepth++;
    try { fn(); } finally {
      batchDepth--;
      if (batchDepth === 0 && batchDirty) { batchDirty = false; emit(); }
    }
  }

  function state() {
    return {
      A: pins.A ? { latlng: pins.A.latlng, snap: pins.A.snap } : null,
      B: pins.B ? { latlng: pins.B.latlng, snap: pins.B.snap } : null,
    };
  }

  function emit() {
    if (batchDepth > 0) { batchDirty = true; return; }
    if (updateUrl) writeUrl();
    onChange?.(state());
  }

  function drawSnapLine(slot) {
    if (!showSnapLines) return;
    const p = pins[slot];
    if (!p) return;
    if (p.snapLine) { map.removeLayer(p.snapLine); p.snapLine = null; }
    p.snapLine = L.polyline([p.latlng, p.snap.latlng], {
      color: colors[slot], weight: 1.5, opacity: 0.55, dashArray: '3 5',
    }).addTo(map);
  }

  function setPin(slot, latlng) {
    const s = snap(latlng);
    if (!s) return;
    const prev = pins[slot];
    let marker = prev?.marker;
    if (!marker) {
      marker = L.marker(latlng, { icon: iconFactory(slot, colors[slot]), draggable: true, autoPan: true });
      marker.addTo(map);
      marker.on('drag', () => {
        const ll = marker.getLatLng();
        const target = [ll.lat, ll.lng];
        const ns = snap(target);
        if (!ns) return;
        pins[slot].latlng = target;
        pins[slot].snap = ns;
        drawSnapLine(slot);
        emit();
      });
    } else {
      marker.setLatLng(latlng);
    }
    pins[slot] = { latlng, snap: s, marker, snapLine: prev?.snapLine ?? null };
    drawSnapLine(slot);
    emit();
  }

  function clearPin(slot) {
    const p = pins[slot];
    if (!p) return;
    if (p.marker) map.removeLayer(p.marker);
    if (p.snapLine) map.removeLayer(p.snapLine);
    pins[slot] = null;
    emit();
  }

  function clearAll() {
    batch(() => { clearPin('A'); clearPin('B'); });
  }

  function swap() {
    if (!pins.A || !pins.B) return;
    batch(() => {
      const aLL = pins.A.latlng.slice();
      const bLL = pins.B.latlng.slice();
      clearPin('A'); clearPin('B');
      setPin('A', bLL);
      setPin('B', aLL);
    });
  }

  function writeUrl() {
    const qs = pinsToQuery({ A: pins.A?.latlng, B: pins.B?.latlng });
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url);
  }

  function restoreFromUrl() {
    const parsed = parsePinsFromQuery(location.search);
    batch(() => {
      if (parsed.A) setPin('A', parsed.A);
      if (parsed.B) setPin('B', parsed.B);
    });
    return parsed;
  }

  map.on('click', (ev) => {
    const target = [ev.latlng.lat, ev.latlng.lng];
    const s = snap(target);
    if (!s) return;
    if (tapSnapPx != null) {
      const sp = map.latLngToContainerPoint(L.latLng(s.latlng[0], s.latlng[1]));
      if (sp.distanceTo(ev.containerPoint) > tapSnapPx) return;
    }
    setPin(pickSlot(pins, target), target);
  });

  return {
    setPin,
    clearPin,
    clearAll,
    swap,
    getPins: state,
    restoreFromUrl,
  };
}
