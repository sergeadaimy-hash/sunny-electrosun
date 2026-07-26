'use strict';
// Run with: node --test test/sales_followup_store.test.js
//
// Store-layer lifecycle for sales_followups against a throwaway temp DB:
// schedule -> find-due -> supersede -> mark sent / status. DB_PATH must be set
// before requiring anything that pulls in db/init (path captured at load).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'sunny-salesfollowup-store-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { initDb, getDb } = require('../db/init');
const store = require('../src/sales_followup');

before(() => {
  initDb();
  getDb().prepare('DELETE FROM sales_followups').run();
});

after(() => {
  try { getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch {}
  }
});

function schedule(overrides = {}) {
  return store.scheduleFollowup(Object.assign({
    contactId: 1,
    conversationId: 10,
    handoffMessageId: 'wamid.ABC',
    handoffAt: '2026-07-26T10:00:00.000Z',
    dueAt: '2026-07-26T13:00:00.000Z',
    language: 'english'
  }, overrides));
}

test('scheduleFollowup inserts a pending row and returns its id', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const id = schedule();
  assert.ok(id > 0);
  const row = store.getFollowupById(id);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.contact_id, 1);
  assert.strictEqual(row.conversation_id, 10);
  assert.strictEqual(row.due_at, '2026-07-26T13:00:00.000Z');
});

test('findDueFollowups returns only pending rows already due, oldest first, capped', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const early = schedule({ dueAt: '2026-07-26T12:00:00.000Z' });
  const late = schedule({ dueAt: '2026-07-26T13:00:00.000Z' });
  const future = schedule({ dueAt: '2026-07-26T20:00:00.000Z' });

  const due = store.findDueFollowups('2026-07-26T13:30:00.000Z', 10);
  const ids = due.map(r => r.id);
  assert.deepStrictEqual(ids, [early, late]); // future excluded, ordered by due_at
  assert.ok(!ids.includes(future));

  const capped = store.findDueFollowups('2026-07-26T13:30:00.000Z', 1);
  assert.deepStrictEqual(capped.map(r => r.id), [early]);
});

test('supersedeOpenFollowupsForContact flips pending rows to superseded', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const a = schedule({ contactId: 7 });
  const b = schedule({ contactId: 7 });
  const other = schedule({ contactId: 99 });

  const n = store.supersedeOpenFollowupsForContact(7);
  assert.strictEqual(n, 2);
  assert.strictEqual(store.getFollowupById(a).status, 'superseded');
  assert.strictEqual(store.getFollowupById(b).status, 'superseded');
  assert.strictEqual(store.getFollowupById(other).status, 'pending');
  // A superseded row is no longer due.
  assert.strictEqual(store.findDueFollowups('2026-07-27T00:00:00.000Z', 10).some(r => r.contact_id === 7), false);
});

test('markFollowupSent records status, message id, and sent_at', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const id = schedule();
  store.markFollowupSent(id, 'wamid.SENT', '2026-07-26T13:05:00.000Z');
  const row = store.getFollowupById(id);
  assert.strictEqual(row.status, 'sent');
  assert.strictEqual(row.sent_message_id, 'wamid.SENT');
  assert.strictEqual(row.sent_at, '2026-07-26T13:05:00.000Z');
  // No longer picked up as due.
  assert.strictEqual(store.findDueFollowups('2026-07-27T00:00:00.000Z', 10).some(r => r.id === id), false);
});

test('markFollowupStatus can expire or skip a row', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const id = schedule();
  store.markFollowupStatus(id, 'skipped_reengaged');
  assert.strictEqual(store.getFollowupById(id).status, 'skipped_reengaged');
});

test('maybeScheduleSalesFollowup does nothing when no handoff happened', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  const id = store.maybeScheduleSalesFollowup({ handoffHappened: false, contactId: 3, conversationId: 30 });
  assert.strictEqual(id, null);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) n FROM sales_followups').get().n, 0);
});

test('maybeScheduleSalesFollowup schedules due_at = handoff + delay and re-arms prior pending rows', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  delete process.env.DISABLE_SALES_FOLLOWUP;
  delete process.env.DISABLE_ESCALATIONS;
  // An earlier still-pending follow-up for the same contact.
  const older = schedule({ contactId: 3 });
  const id = store.maybeScheduleSalesFollowup({
    handoffHappened: true, contactId: 3, conversationId: 30,
    handoffMessageId: 'wamid.NEW', language: 'english',
    now: '2026-07-26T10:00:00.000Z', delayMinutes: 180
  });
  assert.ok(id > 0);
  const row = store.getFollowupById(id);
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.handoff_at, '2026-07-26T10:00:00.000Z');
  assert.strictEqual(row.due_at, '2026-07-26T13:00:00.000Z'); // +180 min
  assert.strictEqual(store.getFollowupById(older).status, 'superseded'); // re-armed
});

test('maybeScheduleSalesFollowup is a no-op when the kill switch is on', () => {
  getDb().prepare('DELETE FROM sales_followups').run();
  process.env.DISABLE_SALES_FOLLOWUP = 'true';
  const id = store.maybeScheduleSalesFollowup({ handoffHappened: true, contactId: 3, conversationId: 30, now: '2026-07-26T10:00:00.000Z' });
  delete process.env.DISABLE_SALES_FOLLOWUP;
  assert.strictEqual(id, null);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) n FROM sales_followups').get().n, 0);
});
