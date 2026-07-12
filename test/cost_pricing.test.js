'use strict';
// Run with: node --test test/cost_pricing.test.js
//
// Guards the 2026-07-12 Haiku pricing correction ahead of the classifier
// switch to Haiku 4.5: the tracker's haiku row still carried Haiku 3.5 rates
// ($0.80/$4.00 per MTok); Haiku 4.5 bills $1.00/$5.00, cache read 0.1x,
// cache write 1.25x. Wrong rates silently under-report daily spend, which is
// exactly the number the budget guardrail and the owner's dashboard rely on.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(os.tmpdir(), 'sunny-pricing-test-' + process.pid + '.db');

const { calcCostCents } = require('../src/cost_tracker');

test('haiku 4.5 input bills at $1.00 per MTok', () => {
  assert.equal(calcCostCents('claude-haiku-4-5-20251001', { input_tokens: 1_000_000 }), 100);
});

test('haiku 4.5 output bills at $5.00 per MTok', () => {
  assert.equal(calcCostCents('claude-haiku-4-5-20251001', { output_tokens: 1_000_000 }), 500);
});

test('haiku 4.5 cache read bills at 0.1x input, cache write at 1.25x', () => {
  assert.equal(calcCostCents('claude-haiku-4-5-20251001', { cache_read_input_tokens: 1_000_000 }), 10);
  assert.equal(calcCostCents('claude-haiku-4-5-20251001', { cache_creation_input_tokens: 1_000_000 }), 125);
});

test('sonnet 4.6 rates unchanged (reply path untouched)', () => {
  assert.equal(calcCostCents('claude-sonnet-4-6', { input_tokens: 1_000_000 }), 300);
  assert.equal(calcCostCents('claude-sonnet-4-6', { output_tokens: 1_000_000 }), 1500);
});
