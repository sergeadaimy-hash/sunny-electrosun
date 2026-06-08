'use strict';

// Run with: node --test test/reply_guards.test.js
//
// Regression tests for two production bugs found in the 2026-06-08 inbox audit:
//   Bug #1: price-strip left garbled fragments ("Available, per panel.",
//           "available at, which could work", "at would do the job") that the
//           dangling-fragment detector failed to catch, so they were sent to
//           customers instead of falling back to the generic line.
//   Bug #2: the stall-guard's last-resort fallback was hard-coded to
//           "Noted. Will share the figure once confirmed." even when the
//           conversation had nothing to do with a price/figure (e.g. the
//           customer asked "Is anyone here to respond?").
const { test } = require('node:test');
const assert = require('node:assert');

const { detectDanglingFragment } = require('../src/claude');
const { buildStallFallbackText, isPresenceOrImpatienceCheck, detectBulkQuantity } = require('../src/handler');

// ---------------------------------------------------------------------------
// Bug #1: dangling-fragment detection after a price strip
// ---------------------------------------------------------------------------

test('garble: "Available, per panel." (comma before per) is flagged', () => {
  // 8 leads got this exact fragment today (conv 2489/2579/2580/2584/2588/2598/2603/2608).
  assert.ok(detectDanglingFragment('Available, per panel. How many units are you looking at?'));
});

test('garble: "available at, which could work" (orphaned preposition + comma) is flagged', () => {
  // conv 2597 (Danputer)
  assert.ok(detectDanglingFragment('(SUN-6K-OG01LP1-EU-AM2) is 48V and available at, which could work'));
});

test('garble: "at would do the job" (preposition + modal) is flagged', () => {
  // conv 2597 (Danputer)
  assert.ok(detectDanglingFragment('1x SE-G5.3 (5.3kWh, 48V) at would do the job.'));
});

test('garble: existing "is per panel" copula+per still flagged (no regression)', () => {
  assert.ok(detectDanglingFragment('The Longi 650W monofacial is per panel'));
});

test('garble: existing bare copula "is, available" still flagged (no regression)', () => {
  assert.ok(detectDanglingFragment('The Deye SE-F16 is, available'));
});

test('no false positive: "looking at, Saheed?" is NOT flagged', () => {
  // conv 2602 — a perfectly valid sentence that must survive. "looking" is not
  // a price-introducing word, so the prep-orphan detector must not fire on "at,".
  assert.strictEqual(detectDanglingFragment('How many units are you looking at, Saheed?'), null);
  assert.strictEqual(detectDanglingFragment('Sure. How many units are you looking at?'), null);
});

test('no false positive: clean stripped sentence with real content survives', () => {
  // A valid strip that leaves real content must NOT be flagged.
  assert.strictEqual(detectDanglingFragment('The Deye SE-F16 is 7.68kWh, available.'), null);
});

test('no false positive: ordinary availability reply survives', () => {
  assert.strictEqual(detectDanglingFragment('Yes, the Longi 650W Hi-MO X10 is available. How many units are you looking at?'), null);
});

// ---------------------------------------------------------------------------
// Bug #2: stall-guard fallback text must not assume a "figure"
// ---------------------------------------------------------------------------

test('stall fallback: non-price context does NOT mention a figure', () => {
  // conv 2599 (Lanre): "Is anyone here to respond?" must not get "the figure".
  const txt = buildStallFallbackText('Is anyone here to respond?');
  assert.ok(!/figure/i.test(txt), 'should not mention a figure for a non-price message');
  assert.ok(txt.trim().length > 0);
});

test('stall fallback: price context keeps the figure phrasing', () => {
  const txt = buildStallFallbackText('how much is the 650w for 30 pieces');
  assert.ok(/figure/i.test(txt), 'a genuine price ask may keep the figure phrasing');
});

test('stall fallback: empty/undefined context is safe and neutral', () => {
  const txt = buildStallFallbackText('');
  assert.ok(!/figure/i.test(txt));
  assert.ok(txt.trim().length > 0);
});

// ---------------------------------------------------------------------------
// R3: presence / impatience checks must not be treated as escalatable queries
// ---------------------------------------------------------------------------

test('presence check: "Is anyone here to respond?" is detected', () => {
  // conv 2599 (Lanre): escalated to Patrick + got a "will share the figure" reply.
  assert.ok(isPresenceOrImpatienceCheck('Is anyone here to respond?'));
});

test('presence check: common variants are detected', () => {
  assert.ok(isPresenceOrImpatienceCheck('Are you there?'));
  assert.ok(isPresenceOrImpatienceCheck('you there?'));
  assert.ok(isPresenceOrImpatienceCheck('anybody there'));
  assert.ok(isPresenceOrImpatienceCheck('Hello? is this thing on'));
});

test('presence check: a real product/price question is NOT a presence check', () => {
  assert.ok(!isPresenceOrImpatienceCheck('How much is the 650w panel?'));
  assert.ok(!isPresenceOrImpatienceCheck('Do you have deye 10kva'));
  assert.ok(!isPresenceOrImpatienceCheck('If I am picking 30pcs, what cost?'));
});

test('presence check: empty input is safe', () => {
  assert.ok(!isPresenceOrImpatienceCheck(''));
  assert.ok(!isPresenceOrImpatienceCheck(undefined));
});

// ---------------------------------------------------------------------------
// B-#2: bulk-quantity detection must survive the "30pcscof" glue typo
// ---------------------------------------------------------------------------

test('bulk: "30pcscof" glue typo is still detected as 30', () => {
  // conv 2592 (ken stone): "If I am picking 30pcscof this PV modules..." was
  // missed because "pcs" ran straight into "cof", so the bulk path was skipped
  // and the lead stalled.
  assert.strictEqual(detectBulkQuantity('If I am picking 30pcscof this PV modules, at what cost'), 30);
});

test('bulk: clean quantity phrasings still detected', () => {
  assert.strictEqual(detectBulkQuantity('How much for about 30pcs?'), 30);
  assert.strictEqual(detectBulkQuantity('I need up to 34 units'), 34);
  assert.strictEqual(detectBulkQuantity('12pcs'), 12);
});

test('bulk: the ad opener "650W panels" is NOT misread as a bulk quantity', () => {
  assert.strictEqual(detectBulkQuantity("Hello Electro-Sun, I'm interested in the LONGi Hi-MO X10 650W panels."), 0);
});

test('bulk: a single unit and non-bulk phrasings return 0', () => {
  assert.strictEqual(detectBulkQuantity('just one panel'), 0);
  assert.strictEqual(detectBulkQuantity('I have a 30 setup running'), 0);
  assert.strictEqual(detectBulkQuantity(''), 0);
});
