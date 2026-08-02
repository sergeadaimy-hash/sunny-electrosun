'use strict';

// 2026-08-01 audit: on 2026-07-29 Sunny told Patrick that city-unknown leads
// were "still waiting on city confirmation before they get routed", and that it
// could not split alerts by desk. Neither was true. Gather-first was retired on
// 2026-07-19, and every alert has recorded its recipient desk since then.

const test = require('node:test');
const assert = require('node:assert');

const { buildRoutingSummary, buildDeskAlertBreakdown } = require('../src/owner_qa');

const BOTH_DESKS = [
  { label: 'patrick', name: 'Patrick', phone: '2347041328055' },
  { label: 'charbel', name: 'Charbel', phone: '2349068859213' },
  { label: 'abuja', name: 'Abuja Sales', phone: '2349169493087' },
  { label: 'lagos', name: 'Lagos Sales', phone: '2349111880000' },
];

test('the routing summary never claims a lead is held waiting for a city', () => {
  const s = buildRoutingSummary(BOTH_DESKS);
  assert.doesNotMatch(s, /has NOT been forwarded/i);
  assert.doesNotMatch(s, /asks "Abuja or Lagos\?" first/i);
  assert.doesNotMatch(s, /waiting on city/i);
});

test('the routing summary states that every escalation routes immediately', () => {
  const s = buildRoutingSummary(BOTH_DESKS);
  assert.match(s, /immediately|right away|without waiting/i);
});

test('the routing summary describes the city-unknown rotation between desks', () => {
  const s = buildRoutingSummary(BOTH_DESKS);
  // Must be about the CITY-UNKNOWN case, not the Patrick/Charbel big-project
  // rotation that the old copy already mentioned.
  const line = s.split('\n').find(l => /no city|city is unknown|without a city|city unknown/i.test(l));
  assert.ok(line, 'a line must cover the city-unknown case');
  assert.match(line, /altern|rotat|split|even/i);
  assert.match(line, /abuja/i);
  assert.match(line, /lagos/i);
});

test('with only one desk configured the summary says so instead of promising a rotation', () => {
  const s = buildRoutingSummary(BOTH_DESKS.filter(r => r.label !== 'lagos'));
  assert.match(s, /SALES_LAGOS_WHATSAPP/);
});

test('buildDeskAlertBreakdown counts alerts per desk from the recorded recipients', () => {
  const rows = [
    { alert_recipient_label: 'abuja' },
    { alert_recipient_label: 'abuja' },
    { alert_recipient_label: 'lagos' },
    { alert_recipient_label: 'patrick' },
    { alert_recipient_label: null },
  ];
  const out = buildDeskAlertBreakdown(rows);
  assert.equal(out.abuja, 2);
  assert.equal(out.lagos, 1);
  assert.equal(out.patrick, 1);
  assert.equal(out.unrecorded, 1);
  assert.equal(out.total, 5);
});

test('buildDeskAlertBreakdown handles an empty or missing list', () => {
  assert.deepEqual(buildDeskAlertBreakdown([]), { total: 0, unrecorded: 0 });
  assert.deepEqual(buildDeskAlertBreakdown(null), { total: 0, unrecorded: 0 });
});
