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
const { buildStallFallbackText } = require('../src/handler');

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
