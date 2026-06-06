'use strict';

// Run with: node --test test/owner_alert.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildOwnerAlertText,
  buildOwnerFollowupLink,
  stripDashesForAlert,
  GENERIC_FOLLOWUP_DRAFT,
} = require('../src/owner_alert');

const HEADER = 'FOLLOW-UP NEEDED, customer is waiting on a team answer.';

const FULL_CONTACT = { id: 7, name: 'Prince Ajijedidun Kehinde', phone: '2348034455038' };
const FULL_CLASSIFICATION = {
  intent: 'feature_question',
  category: 'COLD',
  lead_temperature: 'COLD',
  owner_brief: 'Customer wants details on the Deye 6KW off-grid inverter.\nNo price or stock confirmed yet, needs a team reply.',
  owner_followup_draft: 'Hello, this is ElectroSun following up on your Deye 6KW off-grid inverter enquiry. How can we help you move forward?',
  lead_data: { products_asked_about: 'Deye 6KW Off-Grid Inverter' },
};

test('full alert: number only, no name, no transcript, no admin link', () => {
  const out = buildOwnerAlertText(FULL_CONTACT, FULL_CLASSIFICATION, HEADER);
  assert.ok(out.includes(HEADER), 'keeps header');
  assert.ok(out.includes('2348034455038'), 'shows number');
  assert.ok(!out.includes('Prince'), 'no customer name');
  assert.ok(!/Conversation so far/i.test(out), 'no transcript block');
  assert.ok(!/Latest message/i.test(out), 'no verbatim latest message block');
  assert.ok(!/Open in admin/i.test(out), 'no admin link');
  assert.ok(!/Category:|Temp:|Intent:/i.test(out), 'no signals line');
});

test('full alert: product line present and 2-line summary present', () => {
  const out = buildOwnerAlertText(FULL_CONTACT, FULL_CLASSIFICATION, HEADER);
  assert.ok(out.includes('Product: Deye 6KW Off-Grid Inverter'), 'product line');
  assert.ok(out.includes('Customer wants details on the Deye 6KW off-grid inverter.'), 'summary line 1');
  assert.ok(out.includes('needs a team reply.'), 'summary line 2');
});

test('full alert: wa.me link carries the URL-encoded follow-up draft', () => {
  const out = buildOwnerAlertText(FULL_CONTACT, FULL_CLASSIFICATION, HEADER);
  const m = out.match(/Follow up on WhatsApp: (https:\/\/wa\.me\/(\d+)\?text=(\S+))/);
  assert.ok(m, 'has wa.me link with text param');
  assert.equal(m[2], '2348034455038', 'link targets customer digits');
  assert.equal(decodeURIComponent(m[3]), FULL_CLASSIFICATION.owner_followup_draft, 'decoded text equals draft');
});

test('fallback: synthetic classification with no brief/draft/product', () => {
  const synthetic = { intent: 'photo_request', escalation_type: 'silent_query' };
  const out = buildOwnerAlertText({ id: 1, phone: '2347000000000' }, synthetic, HEADER);
  assert.ok(!/Product:/i.test(out), 'no product line when no product');
  assert.ok(/Customer needs a team answer on: photo request\./.test(out), 'generic summary from intent');
  const link = buildOwnerFollowupLink({ phone: '2347000000000' }, synthetic);
  assert.equal(decodeURIComponent(link.split('?text=')[1]), GENERIC_FOLLOWUP_DRAFT, 'generic opener');
});

test('fallback: intent "other" yields neutral topic', () => {
  const out = buildOwnerAlertText({ phone: '2347000000000' }, { intent: 'other' }, HEADER);
  assert.ok(/Customer needs a team answer on: their enquiry\./.test(out), 'neutral topic');
});

test('stripDashesForAlert removes em/en/double dashes', () => {
  assert.equal(stripDashesForAlert('a — b'), 'a, b');
  assert.equal(stripDashesForAlert('13–14kW'), '13-14kW');
  assert.equal(stripDashesForAlert('a -- b'), 'a, b');
});

test('draft with dashes is cleaned before encoding', () => {
  const c = { owner_followup_draft: 'Following up — on your order', lead_data: {} };
  const link = buildOwnerFollowupLink({ phone: '2347000000000' }, c);
  assert.equal(decodeURIComponent(link.split('?text=')[1]), 'Following up, on your order');
});
