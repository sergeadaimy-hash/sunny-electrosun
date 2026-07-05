'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  detectLargeOrderNgn,
  isBigProjectByValue,
  BIG_PROJECT_NGN_THRESHOLD,
} = require('../src/handler.js');

test('threshold defaults to 15,000,000 NGN', () => {
  assert.equal(BIG_PROJECT_NGN_THRESHOLD, 15000000);
});

test('parses the grouped BOM total from Sunny\'s own quote (Franck 41.29M)', () => {
  const bom = 'Equipment Total: 41,292,000 NGN (excl. racks and cables)';
  assert.equal(detectLargeOrderNgn(bom), 41292000);
  assert.equal(isBigProjectByValue(bom), true);
});

test('takes the MAX figure across a multi-line BOM', () => {
  const bom = [
    '1 x SUN-50K-SG01HP3-EU-BM4, 5,700,000 NGN',
    '8 x BOS-B-PACK-16-A3, 21,600,000 NGN',
    '68 x Jinko 720W, 11,492,000 NGN',
    'Equipment Total: 41,292,000 NGN',
  ].join('\n');
  assert.equal(detectLargeOrderNgn(bom), 41292000);
});

test('handles ₦ symbol and million shorthand', () => {
  assert.equal(detectLargeOrderNgn('my budget is ₦20,000,000'), 20000000);
  assert.equal(detectLargeOrderNgn('around 20 million naira'), 20000000);
  assert.equal(detectLargeOrderNgn('NGN 18M for the full system'), 18000000);
  assert.equal(isBigProjectByValue('around 18 million'), true);
});

test('a normal small quote is NOT a big project', () => {
  assert.equal(detectLargeOrderNgn('The Deye SE-F16 (16kWh) is 2,500,000 NGN'), 2500000);
  assert.equal(isBigProjectByValue('The Deye SE-F16 (16kWh) is 2,500,000 NGN'), false);
  assert.equal(isBigProjectByValue('Jinko 720W panel is 169,000 NGN per panel'), false);
});

test('does NOT trip on SKU numbers, wattage, or capacity (no currency)', () => {
  // SUN-50K, 720W, 16kWh, 10 units, 50kW: none are Naira figures.
  assert.equal(detectLargeOrderNgn('SUN-50K-SG01HP3, 720W panels, 16kWh battery, 50kW inverter, 10 units'), 0);
  assert.equal(isBigProjectByValue('I need a 50kW three-phase inverter and 16kWh storage'), false);
  // bare "3 m cable" must not read as 3,000,000 (M only counts when currency-adjacent)
  assert.equal(detectLargeOrderNgn('run a 3 m cable to the array'), 0);
});

test('empty / no amount returns 0', () => {
  assert.equal(detectLargeOrderNgn(''), 0);
  assert.equal(detectLargeOrderNgn('hello, is anyone there?'), 0);
});
