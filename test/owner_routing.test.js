'use strict';

// Run with: node --test test/owner_routing.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  decideRecipient,
  isSeriousOrHot,
  routingInfoSufficient,
  hasRoutingInfo,
  numberForLabel,
  configuredRecipients,
  teamPhoneDigits,
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

test('daily sale with unknown region is a last-resort owner fallback', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'daily_sales', routing_region: 'unknown' });
  assert.equal(d.label, 'owner');
  assert.equal(d.reason, 'region_unknown_fallback');
});

// --- Fallbacks -------------------------------------------------------------

test('a COLD big project still goes to the owners (big = owner regardless of temp)', () => {
  // Owner directive 2026-06-07: owners handle big projects only, but ANY big
  // project reaches them, even a COLD-toned one.
  const d = decideRecipient({ category: 'COLD', routing_category: 'big_project', lastAssignee: null });
  assert.equal(d.label, 'charbel');
});

test('a COLD daily lead with a region routes to the desk, NOT the owner', () => {
  // The core fix: small / non-HOT leads must reach the regional desk, never the owner.
  assert.equal(decideRecipient({ category: 'COLD', escalation_type: 'silent_query', routing_category: 'daily_sales', routing_region: 'lagos' }).label, 'lagos');
  assert.equal(decideRecipient({ category: 'COLD', escalation_type: 'silent_query', routing_region: 'abuja' }).label, 'abuja');
});

test('region unknown (non-big) is a last-resort owner fallback (gather-first should prevent it)', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'unknown' });
  assert.equal(d.label, 'owner');
  assert.equal(d.reason, 'region_unknown_fallback');
});

test('region unknown defaults to the Abuja desk when Abuja is configured (owner directive 2026-06-08)', () => {
  // Owner directive: a city-unknown lead should go to Abuja, not the owner.
  const d = decideRecipient({ category: 'SERIOUS', escalation_type: 'silent_query', routing_category: 'unknown', abujaConfigured: true });
  assert.equal(d.label, 'abuja');
  assert.equal(d.reason, 'region_unknown_default_abuja');
});

test('region unknown still falls back to owner when Abuja is NOT configured', () => {
  const d = decideRecipient({ category: 'SERIOUS', routing_category: 'daily_sales', routing_region: 'unknown', abujaConfigured: false });
  assert.equal(d.label, 'owner');
});

test('unknown category WITH a region routes to that desk (treated like daily)', () => {
  assert.equal(decideRecipient({ category: 'HOT', routing_category: 'unknown', routing_region: 'lagos' }).label, 'lagos');
  assert.equal(decideRecipient({ category: 'SERIOUS', routing_category: 'unknown', routing_region: 'abuja' }).label, 'abuja');
});

test('force-promoted HOT (category COLD, temp HOT, escalation hot_lead) is routed, not dumped to owner', () => {
  // Regression for 2026-06-07 (Adeyato): commitment-phrase promotion left
  // category COLD, so the old category-only gate sent it to the general owner.
  const lead = { category: 'COLD', lead_temperature: 'HOT', escalation_type: 'hot_lead', routing_category: 'daily_sales', routing_region: 'lagos' };
  assert.equal(isSeriousOrHot(lead), true, 'signal-based: HOT temp / hot_lead escalation counts');
  assert.equal(decideRecipient(lead).label, 'lagos', 'routes to the Lagos desk, not the owner');
});

test('bulk_order escalation counts as serious for routing', () => {
  assert.equal(isSeriousOrHot({ category: 'COLD', escalation_type: 'bulk_order' }), true);
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

test('insufficient: any escalation lacking region+category must gather the city', () => {
  // New model: a COLD/silent_query lead with no region is NOT sufficient; it must
  // ask the city so it can reach a desk (never the owner).
  assert.equal(routingInfoSufficient({ category: 'COLD', routing_category: 'unknown' }), false);
  assert.equal(routingInfoSufficient({ category: 'COLD', routing_region: 'lagos' }), true);
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

test('hasRoutingInfo: unknown category needs a region (none -> false, region -> true)', () => {
  assert.equal(hasRoutingInfo({ routing_category: 'unknown' }), false);
  assert.equal(hasRoutingInfo({ routing_category: 'unknown', routing_region: 'lagos' }), true);
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

test('teamPhoneDigits: all team numbers, deduped, digits-only', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '+234 704 132 8055';
  process.env.OWNER_CHARBEL_WHATSAPP = '2349068859213';
  process.env.SALES_ABUJA_WHATSAPP = '2349169493087';
  process.env.SALES_LAGOS_WHATSAPP = '2349068859213'; // dup of Charbel
  const t = teamPhoneDigits();
  assert.deepEqual(t, ['2347041328055', '2349068859213', '2349169493087'], 'normalized + deduped');
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

test('developer line: DEVELOPER_WHATSAPP is recognized as a full owner (Owner Q&A, not a lead)', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  delete process.env.OWNER_CHARBEL_WHATSAPP;
  process.env.DEVELOPER_WHATSAPP = '966502392650';
  assert.equal(isFullOwner('966502392650'), true, 'developer routes to Owner Q&A');
  assert.equal(isFullOwner('+966 50 239 2650'), true, 'digits-insensitive');
  assert.equal(isAlertOnly('966502392650'), false, 'developer is not an alert-only desk');
  process.env = saved;
});

test('developer line: DEVELOPER_WHATSAPP is excluded from lead stats via teamPhoneDigits', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  delete process.env.OWNER_CHARBEL_WHATSAPP;
  delete process.env.SALES_ABUJA_WHATSAPP;
  delete process.env.SALES_LAGOS_WHATSAPP;
  process.env.DEVELOPER_WHATSAPP = '966502392650';
  assert.ok(teamPhoneDigits().includes('966502392650'), 'developer counted as team, not a customer');
  process.env = saved;
});

test('developer line: unset DEVELOPER_WHATSAPP changes nothing', () => {
  const saved = { ...process.env };
  process.env.OWNER_WHATSAPP = '2347041328055';
  delete process.env.DEVELOPER_WHATSAPP;
  assert.equal(isFullOwner('966502392650'), false, 'no developer configured -> ordinary customer');
  process.env = saved;
});
