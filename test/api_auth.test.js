'use strict';
// Run with: node --test test/api_auth.test.js
//
// Guards the 2026-07-12 API auth hardening: the /api/* master-key middleware
// had no brute-force throttle (unlimited key guesses) and compared keys with
// plain === (timing-sensitive). Under test:
//   - security.safeKeyCompare: constant-time equality, safe on null/length
//     mismatch.
//   - security.recordApiAuthFailure / checkApiAuthThrottle: per-IP failed
//     attempt counting with a rolling window. Successful auth is NEVER
//     throttled (a flood of bad guesses behind a shared proxy IP must not
//     lock out the legit admin); only invalid keys are blocked after the cap.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const security = require('../src/security.js');

beforeEach(() => {
  security.resetApiAuthThrottle();
});

// safeKeyCompare

test('safeKeyCompare accepts an exact match', () => {
  assert.equal(security.safeKeyCompare('sk-abc-123', 'sk-abc-123'), true);
});

test('safeKeyCompare rejects a mismatch', () => {
  assert.equal(security.safeKeyCompare('sk-abc-124', 'sk-abc-123'), false);
});

test('safeKeyCompare rejects different lengths without throwing', () => {
  assert.equal(security.safeKeyCompare('short', 'a-much-longer-key'), false);
});

test('safeKeyCompare rejects null/undefined/empty inputs', () => {
  assert.equal(security.safeKeyCompare(null, 'key'), false);
  assert.equal(security.safeKeyCompare(undefined, 'key'), false);
  assert.equal(security.safeKeyCompare('', 'key'), false);
  assert.equal(security.safeKeyCompare('key', null), false);
  assert.equal(security.safeKeyCompare('', ''), false);
});

// per-IP failure throttle

test('an IP with no failures is allowed', () => {
  assert.equal(security.checkApiAuthThrottle('1.2.3.4').allowed, true);
});

test('an IP is blocked after the failure cap inside the window', () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 20; i++) security.recordApiAuthFailure('1.2.3.4', now + i);
  const res = security.checkApiAuthThrottle('1.2.3.4', now + 1000);
  assert.equal(res.allowed, false);
  assert.ok(res.count >= 20);
});

test('failures on one IP do not block another IP', () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 25; i++) security.recordApiAuthFailure('5.6.7.8', now + i);
  assert.equal(security.checkApiAuthThrottle('9.9.9.9', now + 1000).allowed, true);
});

test('the window rolls over: old failures stop counting', () => {
  const now = 1_800_000_000_000;
  for (let i = 0; i < 25; i++) security.recordApiAuthFailure('1.2.3.4', now);
  const afterWindow = now + 11 * 60 * 1000;
  assert.equal(security.checkApiAuthThrottle('1.2.3.4', afterWindow).allowed, true);
});
