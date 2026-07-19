'use strict';
// Run with: node --test test/pending_nudge.test.js
//
// Unanswered-alert nudge (2026-07-19, Frank Emodiae follow-through gap):
// a pending query whose desk alert got no team reply is re-pinged ONCE to
// the same recipient after the threshold. Proven against a real temp DB
// with an injected send stub (no Meta calls).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'sunny-nudge-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.DISABLE_NOTIFICATIONS = 'true';
delete process.env.DISABLE_ESCALATIONS;

const { initDb, getDb } = require('../db/init');
const memory = require('../src/memory');
const handler = require('../src/handler');

let contactId;

function insertPending({ minutesAgo, recipient, label, text, status = 'pending', nudgedMinutesAgo = null }) {
  const db = getDb();
  const created = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const nudgedAt = nudgedMinutesAgo == null ? null : new Date(Date.now() - nudgedMinutesAgo * 60 * 1000).toISOString();
  const info = db.prepare(`
    INSERT INTO pending_queries
      (contact_id, customer_message_text, classifier_intent, status, created_at, alert_recipient_number, alert_recipient_label, nudge_sent_at)
    VALUES (?, ?, 'warranty_query', ?, ?, ?, ?, ?)
  `).run(contactId, text, status, created, recipient || null, label || null, nudgedAt);
  return info.lastInsertRowid;
}

before(() => {
  initDb();
  const c = memory.getOrCreateContact('2347080359803', 'Frank Emodiae');
  contactId = c.id;
});

after(() => {
  try { fs.unlinkSync(TMP_DB); } catch {}
});

test('setPendingQueryRecipient stores the routed desk on the row', () => {
  const qid = insertPending({ minutesAgo: 5, text: 'warranty?' });
  memory.setPendingQueryRecipient(qid, '2348000000001', 'abuja');
  const row = getDb().prepare('SELECT * FROM pending_queries WHERE id = ?').get(qid);
  assert.strictEqual(row.alert_recipient_number, '2348000000001');
  assert.strictEqual(row.alert_recipient_label, 'abuja');
});

test('a pending query past the threshold is nudged once, to the stored recipient', async () => {
  const qid = insertPending({
    minutesAgo: 150,
    recipient: '2348111111111',
    label: 'abuja',
    text: 'What is the warranty on LONGi solar panels?'
  });
  const sends = [];
  const send = async (to, text, components) => {
    sends.push({ to, text, components });
    return { ok: true, messageId: 'wamid.NUDGE.' + qid };
  };

  const res1 = await handler.nudgeUnansweredPendingQueries(120, { send });
  assert.ok(res1.nudged >= 1, 'first sweep nudges');
  const mine = sends.filter(s => s.to === '2348111111111');
  assert.strictEqual(mine.length, 1, 'nudge went to the stored desk number');
  assert.ok(/REMINDER/i.test(mine[0].text), 'text carries the reminder header');
  assert.ok(mine[0].text.includes(`[QID:${qid}]`), 'text carries the QID');
  assert.ok(mine[0].text.includes('warranty on LONGi'), 'text carries the original question');

  const row = getDb().prepare('SELECT * FROM pending_queries WHERE id = ?').get(qid);
  assert.ok(row.nudge_sent_at, 'row marked nudged');
  assert.strictEqual(row.alert_message_id, 'wamid.NUDGE.' + qid, 'reply-to mapping points at the nudge');

  // Second sweep: nothing new for this row.
  sends.length = 0;
  await handler.nudgeUnansweredPendingQueries(120, { send });
  assert.strictEqual(sends.filter(s => s.to === '2348111111111').length, 0, 'never nudged twice');
});

test('young, resolved, and already-nudged rows are not nudged', async () => {
  insertPending({ minutesAgo: 30, recipient: '2348222222222', text: 'too young' });
  insertPending({ minutesAgo: 300, recipient: '2348333333333', text: 'resolved', status: 'resolved' });
  insertPending({ minutesAgo: 300, recipient: '2348444444444', text: 'already nudged', nudgedMinutesAgo: 100 });
  const sends = [];
  const send = async (to, text) => { sends.push({ to, text }); return { ok: true, messageId: 'x' }; };
  await handler.nudgeUnansweredPendingQueries(120, { send });
  const targets = sends.map(s => s.to);
  assert.ok(!targets.includes('2348222222222'), 'young row skipped');
  assert.ok(!targets.includes('2348333333333'), 'resolved row skipped');
  assert.ok(!targets.includes('2348444444444'), 'already-nudged row skipped');
});

test('a failed send leaves the row un-nudged so the next sweep retries', async () => {
  const qid = insertPending({ minutesAgo: 200, recipient: '2348555555555', text: 'flaky send' });
  await handler.nudgeUnansweredPendingQueries(120, { send: async () => ({ ok: false, error: 'boom' }) });
  let row = getDb().prepare('SELECT nudge_sent_at FROM pending_queries WHERE id = ?').get(qid);
  assert.strictEqual(row.nudge_sent_at, null, 'not marked on failure');
  await handler.nudgeUnansweredPendingQueries(120, { send: async () => ({ ok: true, messageId: 'y' }) });
  row = getDb().prepare('SELECT nudge_sent_at FROM pending_queries WHERE id = ?').get(qid);
  assert.ok(row.nudge_sent_at, 'marked once a send succeeds');
});

test('kill switch: DISABLE_ESCALATIONS=true skips the sweep entirely', async () => {
  process.env.DISABLE_ESCALATIONS = 'true';
  try {
    insertPending({ minutesAgo: 500, recipient: '2348666666666', text: 'should not fire' });
    const sends = [];
    const res = await handler.nudgeUnansweredPendingQueries(120, { send: async (to) => { sends.push(to); return { ok: true, messageId: 'z' }; } });
    assert.strictEqual(res.nudged, 0);
    assert.strictEqual(sends.length, 0);
  } finally {
    delete process.env.DISABLE_ESCALATIONS;
  }
});
