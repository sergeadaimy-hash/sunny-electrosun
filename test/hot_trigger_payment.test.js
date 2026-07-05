// HOT commitment-phrase coverage (2026-07-05 Solar Analyst incident):
// "I wanted to pay for the DEYE 5KWH" missed the force-promote because the
// regex knew "want to pay" / "wants to pay" but not "wanted to pay". A payment
// declaration in ANY common tense or phrasing must classify HOT.
const { test } = require('node:test');
const assert = require('node:assert');

const { hasHotTrigger } = require('../src/classifier');

test('past tense "wanted to pay" is a HOT trigger (Solar Analyst regression)', () => {
  assert.ok(hasHotTrigger('I wanted to pay for the DEYE 5KWH'));
});

test('batched multi-message body containing the payment line still triggers', () => {
  const combined = '[Customer sent 3 messages back to back]\nJello\nBoss ma\nI wanted to pay for the DEYE 5KWH';
  assert.ok(hasHotTrigger(combined));
});

test('other payment phrasings trigger HOT', () => {
  assert.ok(hasHotTrigger('I want to pay now'));
  assert.ok(hasHotTrigger('We would like to pay for the inverter'));
  assert.ok(hasHotTrigger('i wan pay'));
  assert.ok(hasHotTrigger('How do I pay?'));
  assert.ok(hasHotTrigger('Where can we pay'));
  assert.ok(hasHotTrigger('I will make the payment tomorrow morning'));
  assert.ok(hasHotTrigger('Account to pay into'));
});

test('non-commitment price talk does NOT trigger HOT', () => {
  assert.ok(!hasHotTrigger('How much is the Deye 5kWh battery?'));
  assert.ok(!hasHotTrigger('What is the price of Jinko 720W Solar Panel?'));
  assert.ok(!hasHotTrigger('Is the 5kwh available now'));
  assert.ok(!hasHotTrigger('Do you deliver to Ibadan?'));
});
