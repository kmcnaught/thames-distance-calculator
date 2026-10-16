// Mile / kilometre toggle shared by the river and path apps. The pure
// helpers (UNITS, inUnit, fmtDist, altUnit) are Node-importable; the
// `createUnitToggle` DOM wiring depends on a browser.

const M_PER_MILE = 1609.344;

export const UNITS = {
  mi: { perM: 1 / M_PER_MILE, label: 'mi' },
  km: { perM: 1 / 1000, label: 'km' },
};

export function inUnit(m, u) {
  return m * UNITS[u].perM;
}

export function fmtDist(m, dec = 2, u) {
  return inUnit(m, u).toFixed(dec) + ' ' + UNITS[u].label;
}

export function altUnit(u) {
  return u === 'mi' ? 'km' : 'mi';
}

// Hook a checkbox to a localStorage preference. Returns `{ activeUnit }`;
// callers listen for changes via the `onChange` callback (fires after
// localStorage is written, with the new unit as its only argument).
export function createUnitToggle({ checkbox, storageKey, onChange }) {
  try {
    checkbox.checked = localStorage.getItem(storageKey) === '1';
  } catch {}

  checkbox.addEventListener('change', () => {
    try { localStorage.setItem(storageKey, checkbox.checked ? '1' : '0'); } catch {}
    onChange?.(activeUnit());
  });

  function activeUnit() { return checkbox.checked ? 'km' : 'mi'; }
  return { activeUnit };
}
