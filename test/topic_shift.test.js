const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISABLE_NOTIFICATIONS = 'true';
const { isLikelyTopicShift } = require('../src/handler');

// Regression for the 2026-07-17 Frank Emodiae silence: warranty question
// opened a pending query, then "640w is how much" and "I need 10 pieces"
// were swallowed by the pending-query silence cooldown because neither
// matched a topic-shift pattern. A price ask, a wattage, or a quantity is a
// substantive buying signal and must auto-resolve the stale pending query.

test('Frank regression: "640w is how much" is a topic shift', () => {
  assert.strictEqual(isLikelyTopicShift('640w is how much'), true);
});

test('Frank regression: "I need 10 pieces" is a topic shift', () => {
  assert.strictEqual(isLikelyTopicShift('I need 10 pieces'), true);
});

test('price asks are topic shifts', () => {
  assert.strictEqual(isLikelyTopicShift('how much is the 16kw'), true);
  assert.strictEqual(isLikelyTopicShift('what is the price'), true);
  assert.strictEqual(isLikelyTopicShift('send me a quote'), true);
  assert.strictEqual(isLikelyTopicShift('cost of the battery please'), true);
});

test('wattage and quantity signals are topic shifts', () => {
  assert.strictEqual(isLikelyTopicShift('do you have 720 watts'), true);
  assert.strictEqual(isLikelyTopicShift('give me 5 units'), true);
  assert.strictEqual(isLikelyTopicShift('i want 20 pcs'), true);
  assert.strictEqual(isLikelyTopicShift('i will take 3'), true);
});

test('existing patterns still hold: sizes, brands, stock asks', () => {
  assert.strictEqual(isLikelyTopicShift('do you have 12kw in stock'), true);
  assert.strictEqual(isLikelyTopicShift('what about Longi panels'), true);
});

test('pure nags and pings still stay on the follow-up path', () => {
  assert.strictEqual(isLikelyTopicShift('any update?'), false);
  assert.strictEqual(isLikelyTopicShift('still waiting'), false);
  assert.strictEqual(isLikelyTopicShift('when?'), false);
  assert.strictEqual(isLikelyTopicShift('hello'), false);
  assert.strictEqual(isLikelyTopicShift('are you there'), false);
});

test('short or empty messages are never topic shifts', () => {
  assert.strictEqual(isLikelyTopicShift(''), false);
  assert.strictEqual(isLikelyTopicShift('ok'), false);
  assert.strictEqual(isLikelyTopicShift(null), false);
});
