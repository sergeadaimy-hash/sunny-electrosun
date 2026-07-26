'use strict';
// Run with: node --test test/sales_followup.test.js
//
// Pure-helper tests for the Sales Manager follow-up check-in (2026-07-26).
// No DB, no network: due-at math, the Africa/Lagos night guard, the
// re-engagement classifier, expiry, and the fixed message text.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  computeDueAt,
  isWithinSendWindow,
  isSubstantiveReengagement,
  shouldExpire,
  FOLLOWUP_TEXT
} = require('../src/sales_followup');

test('computeDueAt adds the delay in minutes and returns ISO', () => {
  const handoff = '2026-07-26T10:00:00.000Z';
  assert.strictEqual(computeDueAt(handoff, 180), '2026-07-26T13:00:00.000Z');
  assert.strictEqual(computeDueAt(handoff, 30), '2026-07-26T10:30:00.000Z');
});

test('isWithinSendWindow: Lagos is UTC+1, sends allowed 08:00-21:00 local', () => {
  // 08:30 Lagos = 07:30 UTC -> allowed
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 7, 30)), 8, 21, 'Africa/Lagos'), true);
  // 20:30 Lagos = 19:30 UTC -> allowed (still < 21)
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 19, 30)), 8, 21, 'Africa/Lagos'), true);
  // 21:30 Lagos = 20:30 UTC -> quiet
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 20, 30)), 8, 21, 'Africa/Lagos'), false);
  // 07:30 Lagos = 06:30 UTC -> quiet (before 8)
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 6, 30)), 8, 21, 'Africa/Lagos'), false);
  // 00:30 Lagos = 23:30 UTC prior day -> quiet
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 25, 23, 30)), 8, 21, 'Africa/Lagos'), false);
});

test('isWithinSendWindow: 08:00 boundary is inclusive, 21:00 boundary is exclusive', () => {
  // exactly 08:00 Lagos = 07:00 UTC
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 7, 0)), 8, 21, 'Africa/Lagos'), true);
  // exactly 21:00 Lagos = 20:00 UTC
  assert.strictEqual(isWithinSendWindow(new Date(Date.UTC(2026, 6, 26, 20, 0)), 8, 21, 'Africa/Lagos'), false);
});

test('isSubstantiveReengagement: a bare ack after the handoff is NOT re-engagement', () => {
  assert.strictEqual(isSubstantiveReengagement(['ok']), false);
  assert.strictEqual(isSubstantiveReengagement(['Okay thanks']), false);
  assert.strictEqual(isSubstantiveReengagement(['thank you']), false);
  assert.strictEqual(isSubstantiveReengagement(['noted']), false);
  assert.strictEqual(isSubstantiveReengagement(['🙏']), false); // folded hands emoji
  assert.strictEqual(isSubstantiveReengagement(['hello']), false);
  assert.strictEqual(isSubstantiveReengagement([]), false);
});

test('isSubstantiveReengagement: a real message with content IS re-engagement', () => {
  assert.strictEqual(isSubstantiveReengagement(['what is the price of the 16kwh?']), true);
  assert.strictEqual(isSubstantiveReengagement(['I need 3 more panels']), true);
  assert.strictEqual(isSubstantiveReengagement(['ok', 'can you also send the datasheet']), true);
  assert.strictEqual(isSubstantiveReengagement(['When is he calling me?']), true);
});

test('shouldExpire: true once the handoff is older than the max age', () => {
  const handoff = '2026-07-26T10:00:00.000Z';
  // 23h later -> not expired
  assert.strictEqual(shouldExpire(handoff, '2026-07-27T09:00:00.000Z', 1440), false);
  // 25h later -> expired
  assert.strictEqual(shouldExpire(handoff, '2026-07-27T11:00:00.000Z', 1440), true);
});

test('FOLLOWUP_TEXT is a clean English check-in with no double dashes and no URL', () => {
  assert.match(FOLLOWUP_TEXT, /Sales Manager/);
  assert.match(FOLLOWUP_TEXT, /anything else/i);
  assert.doesNotMatch(FOLLOWUP_TEXT, /[–—]|--/);
  assert.doesNotMatch(FOLLOWUP_TEXT, /https?:|wa\.me/);
});
