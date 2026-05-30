'use strict';

// Run with: node --test test/matcher.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  detectPhaseIntent,
  itemPhase,
  selectItemByQuery,
} = require('../src/warehouse');

// A slice of the real production warehouse (the 12kW/16kW/18kW inverters that
// reproduce the reported bug: a 3-phase request was answered with the
// single-phase 12kW datasheet).
const ITEMS = [
  { id: 8, brand: 'Deye', model: 'SUN-16K-SG01LP1-EU', notes: '', section: 'Inverter' },
  { id: 9, brand: 'Deye', model: 'SUN-12K-SG02LP1-EU-AM3-P', notes: '', section: 'Inverter' },
  { id: 10, brand: 'Deye', model: 'SUN-12K-SG04LP3-EU', notes: '', section: 'Inverter' },
  { id: 11, brand: 'Deye', model: 'SUN-18K-SG01LP1-EU-AM3-P', notes: '', section: 'inverter' },
];

const DS_OPTS = { hardSizeGate: false, singleFallbackNeedsSize: true };

test('detectPhaseIntent: three-phase wins when both phases mentioned', () => {
  assert.equal(detectPhaseIntent('I need the 12kw 3 phases sir not single phase'), 'three');
});

test('detectPhaseIntent: 3phase glued, no space', () => {
  assert.equal(detectPhaseIntent('send data sheet again for 3phase 12kw inverter'), 'three');
});

test('detectPhaseIntent: single phase', () => {
  assert.equal(detectPhaseIntent('the 12kw single phase one please'), 'single');
});

test('detectPhaseIntent: no phase mentioned', () => {
  assert.equal(detectPhaseIntent('send me the 16kw datasheet'), null);
});

test('itemPhase: LP3 model is three-phase', () => {
  assert.equal(itemPhase({ model: 'SUN-12K-SG04LP3-EU' }), 'three');
});

test('itemPhase: HP3 model is three-phase', () => {
  assert.equal(itemPhase({ model: 'SUN-80K-SG02HP3-EU-EM6- 3PHASE' }), 'three');
});

test('itemPhase: LP1 model is single-phase', () => {
  assert.equal(itemPhase({ model: 'SUN-12K-SG02LP1-EU-AM3-P' }), 'single');
});

test('itemPhase: battery has no phase', () => {
  assert.equal(itemPhase({ model: 'Deye BOS-A-PACK7.68' }), null);
});

test('THE BUG: 3-phase 12kw request resolves to the SG04LP3 item, not the SG02LP1', () => {
  const r = selectItemByQuery(ITEMS, 'No send me the data sheet again for 3phase 12kw inverter', '', DS_OPTS);
  assert.ok(r, 'expected a match');
  assert.equal(r.item.id, 10);
});

test('single-phase 12kw request resolves to the SG02LP1 item', () => {
  const r = selectItemByQuery(ITEMS, 'send datasheet for 12kw single phase inverter', '', DS_OPTS);
  assert.ok(r, 'expected a match');
  assert.equal(r.item.id, 9);
});

test('no phase given: 16kw datasheet still resolves by size alone (no regression)', () => {
  const r = selectItemByQuery(ITEMS, 'send me the 16kw datasheet', '', DS_OPTS);
  assert.ok(r, 'expected a match');
  assert.equal(r.item.id, 8);
});

test('phase intent can come from recent history when current msg omits it', () => {
  const r = selectItemByQuery(ITEMS, 'send the datasheet', 'i need the 12kw 3 phase not single phase', DS_OPTS);
  assert.ok(r, 'expected a match');
  assert.equal(r.item.id, 10);
});

// Full production catalog (all 23 warehouse items as of 2026-05-30) so the gate
// is exercised against the real sibling models, not just the 12kW cluster.
const PROD = [
  { id: 13, brand: 'Deye', model: 'SE-F5.12', notes: '', section: 'Batteries' },
  { id: 20, brand: 'Deye', model: 'BOS-A-PACK7.68', notes: '', section: 'Batteries' },
  { id: 24, brand: 'Deye', model: 'BOS-B-PACK-16-A3', notes: '', section: 'Batteries' },
  { id: 5, brand: 'Deye', model: 'SUN-20K-SG05LP3-EU-SM2', notes: '', section: 'Inverter' },
  { id: 8, brand: 'Deye', model: 'SUN-16K-SG01LP1-EU', notes: '', section: 'Inverter' },
  { id: 9, brand: 'Deye', model: 'SUN-12K-SG02LP1-EU-AM3-P', notes: '', section: 'Inverter' },
  { id: 10, brand: 'Deye', model: 'SUN-12K-SG04LP3-EU', notes: '', section: 'Inverter' },
  { id: 12, brand: 'Deye', model: 'SUN-6K-OG01LP1-EU-AM2', notes: '', section: 'Inverter' },
  { id: 15, brand: 'Deye', model: 'SUN-8K-SG05LP1-EU-SM2-P', notes: '', section: 'Inverter' },
  { id: 2, brand: 'Deye', model: 'SUN-80K-SG02HP3-EU-EM6- 3PHASE', notes: '', section: 'Inverters' },
  { id: 3, brand: 'Deye', model: 'SUN-50K-SG01HP3-EU-BM4', notes: '', section: 'inverter' },
  { id: 4, brand: 'Deye', model: 'SUN-30K-SG02HP3-EU-AM3 - 3PHASE', notes: '', section: 'inverter' },
  { id: 11, brand: 'Deye', model: 'SUN-18K-SG01LP1-EU-AM3-P', notes: '', section: 'inverter' },
  { id: 7, brand: 'Deye', model: 'SUN-16K-SG05LP3-EU SM2', notes: '', section: 'invetrer' },
];

test('FULL CATALOG: 3-phase 12kw -> SG04LP3 (#10)', () => {
  const r = selectItemByQuery(PROD, 'Plz send data sheet for 12kw 3phase?', '', DS_OPTS);
  assert.equal(r && r.item.id, 10);
});

test('FULL CATALOG: 16kw 3 phase -> SG05LP3 (#7), not the single-phase 16kw (#8)', () => {
  const r = selectItemByQuery(PROD, 'send me the 16kw 3 phase datasheet', '', DS_OPTS);
  assert.equal(r && r.item.id, 7);
});

test('FULL CATALOG: 16kw single phase -> SG01LP1 (#8), not the 3-phase 16kw (#7)', () => {
  const r = selectItemByQuery(PROD, 'send me the 16kw single phase datasheet', '', DS_OPTS);
  assert.equal(r && r.item.id, 8);
});

test('FULL CATALOG: 8kw with no 3-phase sibling does not send the single-phase sheet when 3-phase asked', () => {
  // Only an 8kW single-phase inverter exists. A three-phase request must not
  // silently send the single-phase sheet; return null so the LLM/escalation handles it.
  const r = selectItemByQuery(PROD, 'send the 8kw 3 phase datasheet', '', DS_OPTS);
  assert.equal(r, null);
});

test('FULL CATALOG: 8kw no phase given -> the single-phase 8kw sheet (#15)', () => {
  const r = selectItemByQuery(PROD, 'send the 8kw datasheet', '', DS_OPTS);
  assert.equal(r && r.item.id, 15);
});

test('FULL CATALOG: stale 3-phase in history does not block a fresh sized single-phase request', () => {
  // Customer earlier said "3 phase"; now asks for the 8kw (single-phase only).
  // Because the current message names a size, history phase is ignored -> sheet sent.
  const r = selectItemByQuery(PROD, 'now send me the 8kw datasheet', 'earlier we discussed a 30kw 3 phase', DS_OPTS);
  assert.equal(r && r.item.id, 15);
});
