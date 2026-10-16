// Pure-function tests for lib/corridor.mjs. The DOM/Leaflet-bound bits
// (createCorridor itself) aren't exercised here — eyeball those in a
// browser. These guard the URL round-trip and the slot-picking logic that
// both apps route every click through.
//
// Usage: node scripts/test-corridor.mjs

import assert from 'node:assert/strict';

import { pinsToQuery, parsePinsFromQuery, pickSlot } from '../lib/corridor.mjs';

let fails = 0, total = 0;
function t(name, fn) {
  total++;
  try { fn(); console.log('✓', name); }
  catch (err) { fails++; console.log('✗', name, '\n  ', err.message); }
}

t('pinsToQuery with both pins', () => {
  const q = pinsToQuery({ A: [51.74370, -1.25570], B: [51.46300, -0.97600] });
  // URLSearchParams percent-encodes the comma.
  assert.equal(q, 'a=51.74370%2C-1.25570&b=51.46300%2C-0.97600');
});

t('pinsToQuery with only A', () => {
  assert.equal(pinsToQuery({ A: [51.74370, -1.25570], B: null }), 'a=51.74370%2C-1.25570');
});

t('pinsToQuery empty', () => {
  assert.equal(pinsToQuery({ A: null, B: null }), '');
});

t('pinsToQuery truncates to 5 decimals', () => {
  const q = pinsToQuery({ A: [51.123456789, -1.987654321], B: null });
  assert.equal(q, 'a=51.12346%2C-1.98765');
});

t('parsePinsFromQuery round-trip', () => {
  const original = { A: [51.74370, -1.25570], B: [51.46300, -0.97600] };
  const parsed = parsePinsFromQuery('?' + pinsToQuery(original));
  assert.deepEqual(parsed, original);
});

t('parsePinsFromQuery malformed A is null, valid B survives', () => {
  const p = parsePinsFromQuery('?a=foo&b=51.5,-1.0');
  assert.equal(p.A, null);
  assert.deepEqual(p.B, [51.5, -1.0]);
});

t('parsePinsFromQuery missing B is null', () => {
  const p = parsePinsFromQuery('?a=51.5,-1.0');
  assert.deepEqual(p.A, [51.5, -1.0]);
  assert.equal(p.B, null);
});

t('parsePinsFromQuery empty string', () => {
  assert.deepEqual(parsePinsFromQuery(''), { A: null, B: null });
});

t('pickSlot: empty A takes precedence', () => {
  assert.equal(pickSlot({ A: null, B: { latlng: [51, -1] } }, [52, 0]), 'A');
});

t('pickSlot: empty B when A set', () => {
  assert.equal(pickSlot({ A: { latlng: [51, -1] }, B: null }, [52, 0]), 'B');
});

t('pickSlot: nearest wins when both set', () => {
  const pins = { A: { latlng: [51, -1] }, B: { latlng: [51.5, -1] } };
  assert.equal(pickSlot(pins, [51.1, -1]), 'A');
  assert.equal(pickSlot(pins, [51.4, -1]), 'B');
});

t('pickSlot: equidistant tie goes to A', () => {
  const pins = { A: { latlng: [51, -1] }, B: { latlng: [51.5, -1] } };
  assert.equal(pickSlot(pins, [51.25, -1]), 'A');
});

if (fails) { console.log(`\n${fails}/${total} failed`); process.exit(1); }
console.log(`\n${total}/${total} passed`);
