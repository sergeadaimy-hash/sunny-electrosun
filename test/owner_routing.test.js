'use strict';

// Run with: node --test test/owner_routing.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  decideRecipient,
  routingInfoSufficient,
  hasRoutingInfo,
  numberForLabel,
  configuredRecipients,
  isFullOwner,
  isAlertOnly,
} = require('../src/owner_routing');

// --- Category 2 (big project) ---------------------------------------------

test('big project: round-robin starts at Charbel when state empty', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'big_project', lastAssignee: null });
  assert.equal(d.label, 'charbel');
  assert.equal(d.flipTo, 'charbel');
  assert.equal(d.stickySet, 'charbel');
});

test('big project: after Charbel comes Patrick', () => {
  const d = decideRecipient({ category: 'SERIOUS', routing_category: 'big_project', lastAssignee: 'charbel' });
  assert.equal(d.label, 'patrick');
  assert.equal(d.flipTo, 'patrick');
});

test('big project: after Patrick comes Charbel', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'big_project', lastAssignee: 'patrick' });
  assert.equal(d.label, 'charbel');
});

test('big project: sticky owner is reused and does NOT flip the counter', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'big_project', lastAssignee: 'patrick', stickyOwner: 'charbel' });
  assert.equal(d.label, 'charbel');
  assert.equal(d.flipTo, null, 'no flip when sticky');
  assert.equal(d.stickySet, null);
  assert.equal(d.reason, 'sticky');
});

// --- Category 1 (daily sales by region) ------------------------------------

test('daily sale routes to Abuja desk', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'daily_sales', routing_region: 'abuja' });
  assert.equal(d.label, 'abuja');
});

test('daily sale routes to Lagos desk', () => {
  const d = decideRecipient({ category: 'SERIOUS', routing_category: 'daily_sales', routing_region: 'lagos' });
  assert.equal(d.label, 'lagos');
});

test('daily sale with unknown region falls back to general owner', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'daily_sales', routing_region: 'unknown' });
  assert.equal(d.label, 'owner');
  assert.equal(d.reason, 'daily_region_unknown');
});

// --- Fallbacks -------------------------------------------------------------

test('non serious/hot lead is not routed (general owner)', () => {
  const d = decideRecipient({ category: 'COLD', routing_category: 'big_project' });
  assert.equal(d.label, 'owner');
  assert.equal(d.reason, 'not_serious_or_hot');
});

test('unknown category falls back to general owner', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'unknown' });
  assert.equal(d.label, 'owner');
  assert.equal(d.reason, 'category_unknown');
});

// --- routingInfoSufficient (gather-first gate) -----------------------------

test('sufficient: serious/hot big project', () => {
  assert.equal(routingInfoSufficient({ category: 'HOT', routing_category: 'big_project' }), true);
});

test('insufficient: serious/hot with unknown category', () => {
  assert.equal(routingInfoSufficient({ category: 'HOT', routing_category: 'unknown' }), false);
});

test('insufficient: daily sale with unknown region', () => {
  assert.equal(routingInfoSufficient({ category: 'SERIOUS', routing_category: 'daily_sales', routing_region: 'unknown' }), false);
});

test('sufficient: cold lead never blocks (not routed)', () => {
  assert.equal(routingInfoSufficient({ category: 'COLD', routing_category: 'unknown' }), true);
});

// --- hasRoutingInfo (deferred-handoff resume gate, category-independent) ----

test('hasRoutingInfo: big project is always enough', () => {
  assert.equal(hasRoutingInfo({ routing_category: 'big_project' }), true);
});

test('hasRoutingInfo: daily needs a known region', () => {
  assert.equal(hasRoutingInfo({ routing_category: 'daily_sales', routing_region: 'lagos' }), true);
  assert.equal(hasRoutingInfo({ routing_category: 'daily_sales', routing_region: 'unknown' }), false);
});

test('hasRoutingInfo: works even when current category is COLD (demoted follow-up)', () => {
  // A bare "Lagos" reply classified COLD but carrying the region must still
  // satisfy the resume gate.
  assert.equal(hasRoutingInfo({ category: 'COLD', routing_category: 'daily_sales', routing_region: 'lagos' }), true);
});

test('hasRoutingInfo: unknown category is not enough', () => {
  assert.equal(hasRoutingInfo({ routing_category: 'unknown' }), false);
});

// --- numberForLabel + tier checks (env-driven) -----------------------------

test('numberForLabel maps labels to env, with OWNER_WHATSAPP fallback', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  process.env.OWNER_CHARBEL_WHATSAPP = '2349068859213';
  process.env.SALES_ABUJA_WHATSAPP = '2349169493087';
  process.env.SALES_LAGOS_WHATSAPP = '2349111880000';
  assert.equal(numberForLabel('patrick'), '2347041328055');
  assert.equal(numberForLabel('charbel'), '2349068859213');
  assert.equal(numberForLabel('abuja'), '2349169493087');
  assert.equal(numberForLabel('lagos'), '2349111880000');
  assert.equal(numberForLabel('owner'), '2347041328055');
  delete process.env.OWNER_CHARBEL_WHATSAPP;
  assert.equal(numberForLabel('charbel'), '2347041328055', 'unset charbel falls back to owner');
  process.env = saved;
});

test('configuredRecipients: all four when distinct numbers are set', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  process.env.OWNER_CHARBEL_WHATSAPP = '2349068859213';
  process.env.SALES_ABUJA_WHATSAPP = '2349169493087';
  process.env.SALES_LAGOS_WHATSAPP = '2349111880000';
  const recs = configuredRecipients();
  assert.deepEqual(recs.map(r => r.label), ['patrick', 'charbel', 'abuja', 'lagos']);
  assert.deepEqual(recs.map(r => r.name), ['Patrick', 'Charbel', 'Abuja Sales', 'Lagos Sales']);
  assert.equal(recs[2].phone, '2349169493087');
  process.env = saved;
});

test('configuredRecipients: unset desk is omitted (would duplicate Patrick)', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  delete process.env.OWNER_CHARBEL_WHATSAPP;
  delete process.env.SALES_ABUJA_WHATSAPP;
  delete process.env.SALES_LAGOS_WHATSAPP;
  const recs = configuredRecipients();
  assert.deepEqual(recs.map(r => r.label), ['patrick'], 'only Patrick when others unset');
  process.env = saved;
});

test('configuredRecipients: a desk equal to Patrick is deduped out', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  process.env.SALES_ABUJA_WHATSAPP = '2347041328055';
  delete process.env.OWNER_CHARBEL_WHATSAPP;
  delete process.env.SALES_LAGOS_WHATSAPP;
  const recs = configuredRecipients();
  assert.deepEqual(recs.map(r => r.label), ['patrick'], 'dup number not shown twice');
  process.env = saved;
});

test('tier checks: full owner vs alert-only vs customer, digits-insensitive', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  process.env.OWNER_CHARBEL_WHATSAPP = '2349068859213';
  process.env.SALES_ABUJA_WHATSAPP = '2349169493087';
  process.env.SALES_LAGOS_WHATSAPP = '2349111880000';
  assert.equal(isFullOwner('+234 704 132 8055'), true);
  assert.equal(isFullOwner('2349068859213'), true);
  assert.equal(isAlertOnly('+234 916 949 3087'), true);
  assert.equal(isAlertOnly('2349111880000'), true);
  assert.equal(isAlertOnly('2347041328055'), false, 'owner never alert-only');
  assert.equal(isFullOwner('2348000000000'), false, 'customer not owner');
  assert.equal(isAlertOnly('2348000000000'), false, 'customer not alert-only');
  process.env = saved;
});
