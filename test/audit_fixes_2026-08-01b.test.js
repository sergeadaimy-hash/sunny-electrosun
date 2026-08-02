'use strict';

// Second half of the 2026-08-01 audit regression suite: double replies, the
// unsupported-media nag, and duplicate Sales Manager check-ins.

const test = require('node:test');
const assert = require('node:assert');

const {
  DEBOUNCE_MS,
  batchIsSuperseded,
  shouldReplyToUnsupported,
  unsupportedReplyFor,
} = require('../src/handler');
const { isWithinFollowupCooldown } = require('../src/sales_followup');

// ---------------------------------------------------------------------------
// 1. Double replies. 122 of 138 bursts happened because the customer's second
//    message landed at a median of 8.9s against a 6s debounce window.
// ---------------------------------------------------------------------------

test('the debounce window is wide enough for how customers actually type', () => {
  // Measured p50 gap between a customer's back-to-back messages: 8.9s, p90 12.6s.
  assert.ok(DEBOUNCE_MS >= 12000, `debounce is ${DEBOUNCE_MS}ms, needs to cover the 12.6s p90 gap`);
});

// ---------------------------------------------------------------------------
// 2. The remaining 16 bursts: one message got two replies because a follow-up
//    arrived while the first batch was still inside its LLM call. The stale
//    reply must be dropped so the newer batch answers with full context
//    (conv 7003: "Sure, which product?" then 11s later the real 20kW answer).
// ---------------------------------------------------------------------------

test('a batch is superseded when the contact has newer messages already queued', () => {
  const entry = { contact: { id: 42 } };
  const pending = new Map([[42, { msgs: [{ body: 'How much is 20 kW?' }] }]]);
  assert.equal(batchIsSuperseded(entry, pending), true);
});

test('a batch is NOT superseded when nothing new is queued', () => {
  const entry = { contact: { id: 42 } };
  assert.equal(batchIsSuperseded(entry, new Map()), false);
  assert.equal(batchIsSuperseded(entry, new Map([[42, { msgs: [] }]])), false);
  assert.equal(batchIsSuperseded(entry, new Map([[99, { msgs: [{ body: 'other contact' }] }]])), false);
});

test('batchIsSuperseded never throws on a malformed entry', () => {
  assert.equal(batchIsSuperseded(null, new Map()), false);
  assert.equal(batchIsSuperseded({}, new Map()), false);
  assert.equal(batchIsSuperseded({ contact: {} }, new Map()), false);
});

// ---------------------------------------------------------------------------
// 3. Unsupported media. A customer sent an installation video captioned "Pls
//    rate my first time high voltage installation" and got "This number
//    receives text messages only." Another thread got that nag five times in a
//    row from stickers.
// ---------------------------------------------------------------------------

test('stickers never get the text-only nag', () => {
  assert.equal(shouldReplyToUnsupported('sticker', 0), false);
  assert.equal(shouldReplyToUnsupported('sticker', 3), false);
});

test('the nag is sent at most once per conversation', () => {
  assert.equal(shouldReplyToUnsupported('video', 0), true);
  assert.equal(shouldReplyToUnsupported('video', 1), false);
  assert.equal(shouldReplyToUnsupported('document', 0), true);
  assert.equal(shouldReplyToUnsupported('document', 2), false);
});

test('a video gets an answer that invites the customer to keep going', () => {
  const reply = unsupportedReplyFor('video');
  assert.match(reply, /video/i);
  // The old nag told the customer the number only takes text, which reads as a
  // brush-off when they just sent us their installation.
  assert.doesNotMatch(reply, /receives text messages only/i);
  assert.match(reply, /\?/, 'should invite the customer to continue');
});

test('other unsupported types keep the plain text-only line', () => {
  assert.match(unsupportedReplyFor('contacts'), /text/i);
  assert.match(unsupportedReplyFor('unsupported'), /text/i);
});

// ---------------------------------------------------------------------------
// 4. Duplicate Sales Manager check-ins. 12 of 63 recipients got 2 or 3.
//    Conv 6999 got the identical message at 07:00 and again at 10:25.
// ---------------------------------------------------------------------------

test('a second check-in inside the cooldown is suppressed', () => {
  const sent = '2026-08-01T07:00:00.000Z';
  assert.equal(isWithinFollowupCooldown(sent, '2026-08-01T10:25:00.000Z', 24), true);
  assert.equal(isWithinFollowupCooldown(sent, '2026-08-01T07:00:01.000Z', 24), true);
  assert.equal(isWithinFollowupCooldown(sent, '2026-08-02T06:59:00.000Z', 24), true);
});

test('a check-in is allowed again once the cooldown has passed', () => {
  const sent = '2026-08-01T07:00:00.000Z';
  assert.equal(isWithinFollowupCooldown(sent, '2026-08-02T07:00:01.000Z', 24), false);
  assert.equal(isWithinFollowupCooldown(sent, '2026-08-05T09:00:00.000Z', 24), false);
});

test('a contact who never got a check-in is never in cooldown', () => {
  assert.equal(isWithinFollowupCooldown(null, '2026-08-01T07:00:00.000Z', 24), false);
  assert.equal(isWithinFollowupCooldown(undefined, '2026-08-01T07:00:00.000Z', 24), false);
  assert.equal(isWithinFollowupCooldown('not-a-date', '2026-08-01T07:00:00.000Z', 24), false);
});
