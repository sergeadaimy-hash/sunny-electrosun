'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const security = require('../src/security.js');

test('uncertainty replies are caught so the guard can escalate (owner directive 2026-07-05)', () => {
  const stuck = [
    "I'm not sure about the exact price for that one.",
    'I am not certain that configuration is in stock.',
    "I'm unsure of the delivery timeline to Cameroon.",
    "I can't confirm the shipping cost from here.",
    'I cannot verify availability of that variant right now.',
    "I don't have that information on hand.",
    "We don't have enough details to quote that.",
    "That's not something I can confirm.",
  ];
  for (const r of stuck) {
    assert.ok(security.detectStallLanguage(r), `should flag: ${r}`);
  }
});

test('clarifying an ambiguous customer message is NOT a stall (no over-escalation)', () => {
  const clarify = [
    "I'm not sure I understand, could you tell me the kW size?",
    "I'm not sure what you mean by that.",
    "I'm not sure which model you're referring to.",
    'I am not certain whether you want single or three phase.',
  ];
  for (const r of clarify) {
    assert.equal(security.detectStallLanguage(r), null, `should NOT flag: ${r}`);
  }
});

test('a normal confident answer is not a stall', () => {
  assert.equal(security.detectStallLanguage('The Deye SE-F16 is 2,500,000 NGN, in stock in Abuja.'), null);
  assert.equal(security.detectStallLanguage('Yes, we carry the 12kW three-phase inverter.'), null);
});

test('existing first/third-person stalls still detected', () => {
  assert.ok(security.detectStallLanguage("Let me check with the team and get back to you."));
  assert.ok(security.detectStallLanguage('The Sales Manager will reach out shortly.'));
});
