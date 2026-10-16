// Pure-function tests for lib/units.mjs. createUnitToggle is DOM-bound and
// not covered here — eyeball it in a browser.
//
// Usage: node scripts/test-units.mjs

import assert from 'node:assert/strict';

import { UNITS, inUnit, fmtDist, altUnit } from '../lib/units.mjs';

let fails = 0, total = 0;
function t(name, fn) {
  total++;
  try { fn(); console.log('✓', name); }
  catch (err) { fails++; console.log('✗', name, '\n  ', err.message); }
}

t('UNITS.mi exact ratio', () => {
  assert.equal(UNITS.mi.perM, 1 / 1609.344);
  assert.equal(UNITS.mi.label, 'mi');
});

t('UNITS.km exact ratio', () => {
  assert.equal(UNITS.km.perM, 1 / 1000);
  assert.equal(UNITS.km.label, 'km');
});

t('inUnit: 1 mile in miles', () => {
  assert.equal(inUnit(1609.344, 'mi'), 1);
});

t('inUnit: 1 km in km', () => {
  assert.equal(inUnit(1000, 'km'), 1);
});

t('fmtDist default precision', () => {
  assert.equal(fmtDist(1609.344, 2, 'mi'), '1.00 mi');
  assert.equal(fmtDist(1500, 2, 'km'), '1.50 km');
});

t('fmtDist custom precision', () => {
  assert.equal(fmtDist(1609.344, 3, 'mi'), '1.000 mi');
  assert.equal(fmtDist(1234, 1, 'km'), '1.2 km');
});

t('altUnit swaps', () => {
  assert.equal(altUnit('mi'), 'km');
  assert.equal(altUnit('km'), 'mi');
});

if (fails) { console.log(`\n${fails}/${total} failed`); process.exit(1); }
console.log(`\n${total}/${total} passed`);
