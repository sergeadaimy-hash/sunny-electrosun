'use strict';
// Run with: node --test test/facts.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const { buildFactsMarkdown, looksLikePrice } = require('../src/facts');

test('empty facts render the no-facts sentinel', () => {
  const md = buildFactsMarkdown([]);
  assert.match(md, /Learned facts/);
  assert.match(md, /No confirmed facts yet/);
});

test('facts are numbered and edited_text wins over proposed_change', () => {
  const md = buildFactsMarkdown([
    { id: 1, proposed_change: 'We deliver to Abuja and Lagos.', edited_text: null },
    { id: 2, proposed_change: 'raw', edited_text: 'We give a 2-year warranty on inverters.' },
  ]);
  assert.match(md, /1\. We deliver to Abuja and Lagos\./);
  assert.match(md, /2\. We give a 2-year warranty on inverters\./);
  assert.doesNotMatch(md, /No confirmed facts yet/);
});

test('near-duplicate facts are dropped', () => {
  const md = buildFactsMarkdown([
    { id: 1, proposed_change: 'We deliver nationwide for a fee.' },
    { id: 2, proposed_change: 'we deliver nationwide for a fee.' },
  ]);
  const count = (md.match(/^\d+\. /gm) || []).length;
  assert.equal(count, 1);
});

// looksLikePrice is the safety net that keeps prices out of the facts block.
test('looksLikePrice flags real Naira amounts', () => {
  for (const s of [
    'The 16kWh battery is ₦4.2m',
    'It costs 4,200,000',
    'price is 4.2 million naira',
    'NGN 850000',
    'sells for 850000',
  ]) {
    assert.equal(looksLikePrice(s), true, 'should flag: ' + s);
  }
});

test('looksLikePrice does NOT flag ordinary non-price facts', () => {
  for (const s of [
    'We give a 2-year warranty on inverters.',
    'We deliver to Kano for a fee quoted per trip.',
    'BOS-A is 7.68kWh.',
    'Deye 16kW three phase is in stock.',
    'Minimum order is 10 units.',
    'Office is open 9am to 5pm.',
  ]) {
    assert.equal(looksLikePrice(s), false, 'should NOT flag: ' + s);
  }
});
