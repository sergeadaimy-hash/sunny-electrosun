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

const { detectDanglingFragment, buildKnownCustomerContext, detectFabricatedVariantFromItems } = require('../src/claude');
const { buildStallFallbackText, isPresenceOrImpatienceCheck, detectBulkQuantity, isLiveAgentRequest } = require('../src/handler');
const { buildRoutingSummary } = require('../src/owner_qa');

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

// ---------------------------------------------------------------------------
// C1b: explicit live-agent / human requests must be detected (then escalated)
// ---------------------------------------------------------------------------

test('live agent: explicit requests are detected', () => {
  // conv 2633 (Ajay): "Connect me with a live agent" got no escalation.
  assert.ok(isLiveAgentRequest('Connect me with a live agent'));
  assert.ok(isLiveAgentRequest('I want to speak to a human'));
  assert.ok(isLiveAgentRequest('can I talk to someone'));
  assert.ok(isLiveAgentRequest('real person please'));
  assert.ok(isLiveAgentRequest('connect me to your team'));
});

test('live agent: ordinary product/price messages are NOT live-agent requests', () => {
  assert.ok(!isLiveAgentRequest('I need Deye 5.3kwh'));
  assert.ok(!isLiveAgentRequest('How much is the 650w panel?'));
  assert.ok(!isLiveAgentRequest(''));
});

// ---------------------------------------------------------------------------
// O1: Owner Q&A must know routing is configured (not tell the owner to set it up)
// ---------------------------------------------------------------------------

test('routing summary: with desks configured, states routing is active and lists them', () => {
  // conv "Electro1" owner chat: Sunny wrongly told the owner the Abuja sales
  // forwarding "would need to be set up".
  const txt = buildRoutingSummary([
    { label: 'patrick', name: 'Patrick', phone: '2347041328055' },
    { label: 'abuja', name: 'Abuja Sales', phone: '2349169493087' },
    { label: 'lagos', name: 'Lagos Sales', phone: '2349111880000' }
  ]);
  assert.ok(/abuja/i.test(txt), 'mentions Abuja');
  assert.ok(/lagos/i.test(txt), 'mentions Lagos');
  assert.ok(/configured|active/i.test(txt), 'states routing is configured/active');
  assert.ok(!/needs?\s+(?:to\s+be\s+)?set\s+up/i.test(txt), 'does NOT say it needs setting up');
});

test('routing summary: a missing desk is flagged as not set, not silently dropped', () => {
  const txt = buildRoutingSummary([
    { label: 'patrick', name: 'Patrick', phone: '2347041328055' }
  ]);
  assert.ok(/abuja/i.test(txt) && /not set|fall back/i.test(txt), 'flags Abuja as not set');
});

// ---------------------------------------------------------------------------
// Names: Sunny must NOT receive the customer's name (owner directive: address
// as "sir", never read the WhatsApp profile name).
// ---------------------------------------------------------------------------

test('customer context: the name is never injected (normal turn)', () => {
  const ctx = buildKnownCustomerContext(
    { name: 'Babajide Samson', location: 'Abuja', use_case: 'home backup' },
    false
  );
  assert.ok(!/Babajide/i.test(ctx), 'must not leak the customer name');
  assert.ok(/Abuja/i.test(ctx), 'other known context still passes through');
});

test('customer context: the name is never injected (casual greeting)', () => {
  const ctx = buildKnownCustomerContext({ name: 'Ajay' }, true);
  assert.ok(!/Ajay/i.test(ctx), 'must not leak the customer name on a greeting');
});

// ---------------------------------------------------------------------------
// detectFabricatedVariantFromItems (the SUN-10K incident, 2026-06-27).
// A customer asked for "10kw"; Sunny offered a non-existent 10kW Deye SKU
// (relabeled from the real 12kW unit) and called it "available". The guard's
// stocked-size map was silently empty (its /Nkw/ regex never matched real
// "SUN-12K" SKUs) and its bridge regex broke on the ")" and "." in the quote,
// so the fabricated variant went through. These pin both fixes.
// ---------------------------------------------------------------------------
const WH_ITEMS = [
  { brand: 'Deye', model: 'SUN-16K-SG01LP1-EU', notes: '', section: 'Inverter' },      // 16 single
  { brand: 'Deye', model: 'SUN-12K-SG02LP1-EU-AM3-P', notes: '', section: 'Inverter' }, // 12 single
  { brand: 'Deye', model: 'SUN-12K-SG04LP3-EU', notes: '', section: 'Inverter' },        // 12 three
  { brand: 'Deye', model: 'SUN-18K-SG01LP1-EU-AM3-P', notes: '', section: 'inverter' },  // 18 single
  { brand: 'Deye', model: 'SUN-8K-SG05LP1-EU-SM2-P', notes: '', section: 'Inverter' },   // 8 single
  { brand: 'Deye', model: 'SUN-16K-SG05LP3-EU SM2', notes: '', section: 'inverter' },    // 16 three
  { brand: 'Deye', model: 'SE-F16', notes: 'LV', section: 'batteries' },                  // battery (no phase)
];

test('fabricated variant: flags the SUN-10K incident line (paren + price punctuation)', () => {
  const reply = 'Deye SUN-10K-SG02LP1-EU-AM3-P (10kW, 1-phase) is 2.35M NGN, available.';
  const flagged = detectFabricatedVariantFromItems(reply, WH_ITEMS);
  assert.ok(flagged, 'a 10kW 1-phase availability claim must be flagged (we stock no 10kW)');
  assert.equal(flagged[0].size, '10');
  assert.equal(flagged[0].phase, 'single');
});

test('fabricated variant: a real stocked size+phase is NOT flagged', () => {
  assert.equal(detectFabricatedVariantFromItems('The 12kW 1-phase is in stock.', WH_ITEMS), null);
  assert.equal(detectFabricatedVariantFromItems('We have the 16kW 3-phase available.', WH_ITEMS), null);
});

test('fabricated variant: a stocked size in a phase we do NOT carry IS flagged', () => {
  // We stock 18kW only in 1-phase, so an "18kW 3-phase available" claim is fake.
  const flagged = detectFabricatedVariantFromItems('The 18kW 3-phase is available.', WH_ITEMS);
  assert.ok(flagged);
  assert.equal(flagged[0].size, '18');
  assert.equal(flagged[0].phase, 'three');
});

test('fabricated variant: battery LV/HV availability lines are out of scope (no false positive)', () => {
  // "16" is also an inverter size, but a battery line has no single/three token,
  // so the guard must not fire on it.
  assert.equal(detectFabricatedVariantFromItems('SE-F16 (16kWh) LV pack is available.', WH_ITEMS), null);
});

test('fabricated variant: a negated/corrective line is allowed through', () => {
  const reply = "We don't carry a 10kW 1-phase. Available sizes: 8kW and 12kW.";
  assert.equal(detectFabricatedVariantFromItems(reply, WH_ITEMS), null);
});

test('fabricated variant: empty/no items returns null (guard inert without stock)', () => {
  assert.equal(detectFabricatedVariantFromItems('The 10kW 1-phase is available.', []), null);
  assert.equal(detectFabricatedVariantFromItems('', WH_ITEMS), null);
});
