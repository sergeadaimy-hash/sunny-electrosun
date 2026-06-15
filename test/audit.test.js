'use strict';
// Run with: node --test test/audit.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  isAuditableContact,
  summarizeSignals,
  parseAuditFindings,
  buildOwnerAuditPing,
} = require('../src/audit');

test('isAuditableContact excludes the owner and desk numbers', () => {
  const cfg = { ownerPhone: '2347041328055', deskPhones: ['09111880000', '+234 706 000 0000'] };
  assert.equal(isAuditableContact({ phone: '+9665023926 50' }, cfg), true);
  assert.equal(isAuditableContact({ phone: '2347041328055' }, cfg), false);
  assert.equal(isAuditableContact({ phone: '0911 188 0000' }, cfg), false);
  assert.equal(isAuditableContact({ phone: '' }, cfg), false);
  assert.equal(isAuditableContact(null, cfg), false);
});

test('summarizeSignals flags ended_silent when last message is from Sunny', () => {
  const s = summarizeSignals({
    conversation: { human_handled: 1 },
    contact: { lead_temperature: 'WARM' },
    pendingQueries: [{ status: 'pending' }, { status: 'resolved' }],
    messages: [{ direction: 'inbound', body: 'hi' }, { direction: 'outbound', body: 'hello' }]
  });
  assert.equal(s.human_handled, true);
  assert.equal(s.open_pending_count, 1);
  assert.equal(s.lead_temperature, 'WARM');
  assert.equal(s.ended_silent, true);
});

test('summarizeSignals: not silent when customer replied last', () => {
  const s = summarizeSignals({
    conversation: {}, contact: {}, pendingQueries: [],
    messages: [{ direction: 'outbound', body: 'x' }, { direction: 'inbound', body: 'y' }]
  });
  assert.equal(s.ended_silent, false);
  assert.equal(s.human_handled, false);
});

test('parseAuditFindings keeps valid lanes and drops junk', () => {
  const text = JSON.stringify({ findings: [
    { lane: 'skill_lesson', finding_text: 'stalled', proposed_change: 'answer directly', cited_rule: 'no stalls', cited_message: 'let me check' },
    { lane: 'bogus_lane', finding_text: 'x', proposed_change: 'y' },
    { lane: 'knowledge_fact', finding_text: 'no price', proposed_change: 'add Sungrow 5kW price' },
    { lane: 'skill_lesson', finding_text: 'missing fields' }
  ] });
  const out = parseAuditFindings(text, { runId: 7, conversationId: 3, contactId: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].lane, 'skill_lesson');
  assert.equal(out[0].run_id, 7);
  assert.equal(out[0].conversation_id, 3);
  assert.equal(out[1].lane, 'knowledge_fact');
});

test('parseAuditFindings returns [] on unparseable text', () => {
  assert.deepEqual(parseAuditFindings('not json', {}), []);
});

test('buildOwnerAuditPing returns null when nothing to review', () => {
  assert.equal(buildOwnerAuditPing({ id: 1 }, { total: 0 }), null);
});

test('buildOwnerAuditPing includes the deep link and counts', () => {
  const msg = buildOwnerAuditPing({ id: 42 }, { total: 3, skill_lesson: 2, knowledge_fact: 1, engineering_note: 0 });
  assert.match(msg, /3 proposals waiting/);
  assert.match(msg, /#audit=42/);
});
