'use strict';

// Run with: node --test test/lead_source.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const { detectLeadSource } = require('../src/handler');

test('exact electroleads opener is tagged', () => {
  assert.equal(detectLeadSource("Hello Electrosun team, I'm reaching out for a quotation"), 'electroleads');
});

test('match is case / punctuation / whitespace insensitive', () => {
  assert.equal(detectLeadSource('hello   electrosun team i m reaching out for a quotation'), 'electroleads');
  assert.equal(detectLeadSource("HELLO ELECTROSUN TEAM, I'M REACHING OUT FOR A QUOTATION!"), 'electroleads');
});

test('opener with extra text around it still matches', () => {
  assert.equal(
    detectLeadSource("Hello Electrosun team, I'm reaching out for a quotation on a 5kw system"),
    'electroleads'
  );
});

test('unrelated message is not tagged', () => {
  assert.equal(detectLeadSource('Hi, how much is a Deye 5kw inverter?'), null);
  assert.equal(detectLeadSource('Hello'), null);
});

test('partial / reworded opener is not falsely tagged', () => {
  assert.equal(detectLeadSource('reaching out for a quotation'), null);
  assert.equal(detectLeadSource("Hello Electrosun team, I want to buy panels"), null);
});

test('empty / null input returns null', () => {
  assert.equal(detectLeadSource(''), null);
  assert.equal(detectLeadSource(null), null);
  assert.equal(detectLeadSource(undefined), null);
});
