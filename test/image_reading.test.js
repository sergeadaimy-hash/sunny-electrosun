'use strict';
// Run with: node --test test/image_reading.test.js
//
// Guards the 2026-07-11 image-reading fix (owner report: "he's not reading
// images"). Root cause was three layers: (1) the classifier only ever saw
// "[Customer sent an image ...]" markers, so image turns classified as
// silent_query; (2) the pending-query silence cooldown then suppressed the
// customer reply ENTIRELY (conv of contact 263, 08:47 2026-07-11: "I mean
// this one" + product photo, total silence); (3) the awaiting-expert context
// never told the model an image was attached. Fixes under test:
//   A. buildImagePersistedBody / buildImageCombinedPart carry a vision-model
//      description of the image into the DB body and the classifier input.
//   B. shouldSuppressFollowupReply never suppresses a turn that carries a
//      fresh image attachment.
//   C. buildExpertContext({ hasImage: true }) instructs the model to look at
//      the attached image, with strict no-guessing rules.
//   D. idle-chatter guard treats persisted "[image] ..." bodies as never
//      low-value (an Arabic caption on a photo must not count toward a mute).
const { test } = require('node:test');
const assert = require('node:assert');

const handler = require('../src/handler.js');
const { classifyLowValue } = require('../src/idle_chatter.js');

// A. Image body builders

test('persisted body without description keeps the legacy shape', () => {
  assert.equal(handler.buildImagePersistedBody('', null), '[image]');
  assert.equal(handler.buildImagePersistedBody('my roof', null), '[image] my roof');
});

test('persisted body carries the image description when available', () => {
  const b = handler.buildImagePersistedBody('I mean this one', 'A Deye SUN-8K-SG01LP1 inverter mounted on a wall.');
  assert.equal(b, '[image] I mean this one\n[Image content: A Deye SUN-8K-SG01LP1 inverter mounted on a wall.]');
});

test('combined classifier part without description keeps the legacy markers', () => {
  assert.equal(handler.buildImageCombinedPart('', null), '[Customer sent an image with no caption]');
  assert.equal(handler.buildImageCombinedPart('my roof', null), '[Customer sent an image with caption]: my roof');
});

test('combined classifier part carries the image description when available', () => {
  const p = handler.buildImageCombinedPart('I mean this one', 'A product listing screenshot showing a 6kW inverter.');
  assert.equal(p, '[Customer sent an image with caption]: I mean this one\n[Image content: A product listing screenshot showing a 6kW inverter.]');
});

// B. Silence-cooldown bypass for image turns

test('follow-up reply is suppressed inside the cooldown for a text-only turn', () => {
  const now = Date.parse('2026-07-11T08:47:56.000Z');
  const suppressed = handler.shouldSuppressFollowupReply({
    lastAssistantReplyAt: new Date(now - 2 * 60 * 1000).toISOString(),
    nowMs: now,
    silenceMs: 10 * 60 * 1000,
    hasImageAttachments: false
  });
  assert.equal(suppressed, true);
});

test('a turn carrying an image attachment is NEVER suppressed by the cooldown', () => {
  const now = Date.parse('2026-07-11T08:47:56.000Z');
  const suppressed = handler.shouldSuppressFollowupReply({
    lastAssistantReplyAt: new Date(now - 2 * 60 * 1000).toISOString(),
    nowMs: now,
    silenceMs: 10 * 60 * 1000,
    hasImageAttachments: true
  });
  assert.equal(suppressed, false);
});

test('outside the cooldown nothing is suppressed', () => {
  const now = Date.parse('2026-07-11T08:47:56.000Z');
  const suppressed = handler.shouldSuppressFollowupReply({
    lastAssistantReplyAt: new Date(now - 11 * 60 * 1000).toISOString(),
    nowMs: now,
    silenceMs: 10 * 60 * 1000,
    hasImageAttachments: false
  });
  assert.equal(suppressed, false);
});

test('missing or invalid last-reply timestamp never suppresses', () => {
  const now = Date.parse('2026-07-11T08:47:56.000Z');
  assert.equal(handler.shouldSuppressFollowupReply({ lastAssistantReplyAt: null, nowMs: now, silenceMs: 600000, hasImageAttachments: false }), false);
  assert.equal(handler.shouldSuppressFollowupReply({ lastAssistantReplyAt: 'not-a-date', nowMs: now, silenceMs: 600000, hasImageAttachments: false }), false);
});

// C. Image-aware expert context

test('awaiting-expert context mentions the attached image when hasImage is set', () => {
  const ctx = handler.buildExpertContext({ openPending: null, escalationJustCreated: true, hasImage: true });
  assert.match(ctx, /attached an image/i);
  assert.match(ctx, /never guess/i);
});

test('awaiting-expert context is unchanged when no image is attached', () => {
  const ctx = handler.buildExpertContext({ openPending: null, escalationJustCreated: true });
  assert.doesNotMatch(ctx, /attached an image/i);
});

test('HOT context stays image-free (handoff message, not an answer)', () => {
  const ctx = handler.buildExpertContext({ isHot: true, hasImage: true });
  assert.doesNotMatch(ctx, /attached an image/i);
});

// D. Idle-chatter guard: persisted image bodies are never low-value

test('persisted [image] bodies never count as low-value, even with an Arabic caption', () => {
  assert.equal(classifyLowValue('[image]'), null);
  assert.equal(classifyLowValue('[image] صورة المنتج المطلوب'), null);
  assert.equal(classifyLowValue('[image] my roof\n[Image content: a rooftop with 12 panels]'), null);
});
