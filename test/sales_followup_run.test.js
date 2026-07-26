'use strict';
// Run with: node --test test/sales_followup_run.test.js
//
// Orchestrator: runSalesFollowups drains due rows and sends the check-in, with
// injected send + now. Covers clean send, night-hold, expiry, human-takeover,
// re-engagement, stale-window, and the kill switches. Real temp DB.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'sunny-salesfollowup-run-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
delete process.env.DISABLE_SALES_FOLLOWUP;
delete process.env.DISABLE_ESCALATIONS;

const { initDb, getDb } = require('../db/init');
const store = require('../src/sales_followup');

const NOW = '2026-07-26T12:00:00.000Z';   // Lagos 13:00 -> inside send window
const NIGHT = '2026-07-26T23:00:00.000Z'; // Lagos 00:00 -> quiet hours

function makeSend() {
  const calls = [];
  let n = 0;
  const send = async (to, text) => { calls.push({ to, text }); return { ok: true, messageId: 'wamid.OUT' + (++n) }; };
  return { send, calls };
}

function seed({ human = 0, lastInboundIso = '2026-07-26T09:00:00.000Z', afterHandoffInbound = [], handoffAt = '2026-07-26T09:00:00.000Z', dueAt = '2026-07-26T12:00:00.000Z' } = {}) {
  const db = getDb();
  const c = db.prepare("INSERT INTO contacts (phone, name) VALUES (?, ?)").run('234700' + Math.floor(Math.random() * 1e6), 'Test');
  const contactId = c.lastInsertRowid;
  const cv = db.prepare("INSERT INTO conversations (contact_id, status, human_handled, started_at, last_message_at) VALUES (?, 'active', ?, ?, ?)")
    .run(contactId, human, '2026-07-26T08:00:00.000Z', lastInboundIso);
  const conversationId = cv.lastInsertRowid;
  // the inbound that triggered the handoff
  db.prepare("INSERT INTO messages (conversation_id, direction, body, timestamp) VALUES (?, 'inbound', ?, ?)")
    .run(conversationId, 'I want to buy the 16kwh', lastInboundIso);
  // the handoff reply (outbound)
  db.prepare("INSERT INTO messages (conversation_id, direction, body, timestamp) VALUES (?, 'outbound', ?, ?)")
    .run(conversationId, 'The Sales Manager will reach out.', handoffAt);
  // any customer messages AFTER the handoff
  for (const b of afterHandoffInbound) {
    db.prepare("INSERT INTO messages (conversation_id, direction, body, timestamp) VALUES (?, 'inbound', ?, ?)")
      .run(conversationId, b, '2026-07-26T11:00:00.000Z');
  }
  const id = store.scheduleFollowup({ contactId, conversationId, handoffMessageId: 'wamid.HAND', handoffAt, dueAt, language: 'english' });
  return { contactId, conversationId, id };
}

before(() => { initDb(); });
beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM sales_followups').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM contacts').run();
  delete process.env.DISABLE_SALES_FOLLOWUP;
  delete process.env.DISABLE_ESCALATIONS;
});
after(() => {
  try { getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch {} }
});

test('a clean due follow-up is sent, marked sent, and the outbound is persisted', async () => {
  const { id, conversationId } = seed();
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].text, /Sales Manager/);
  assert.strictEqual(store.getFollowupById(id).status, 'sent');
  const out = getDb().prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND intent = 'sales_followup'").get(conversationId);
  assert.strictEqual(out.n, 1);
});

test('during quiet hours nothing is sent and the row stays pending', async () => {
  const { id } = seed();
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NIGHT });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'pending');
});

test('a handoff older than the max age is expired, not sent', async () => {
  // handoff 25h before now, due already; maxAge default 1440 (24h)
  const { id } = seed({ handoffAt: '2026-07-25T11:00:00.000Z', dueAt: '2026-07-25T14:00:00.000Z', lastInboundIso: '2026-07-25T11:00:00.000Z' });
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'expired');
});

test('a human-handled conversation is skipped', async () => {
  const { id } = seed({ human: 1 });
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'skipped_reengaged');
});

test('a substantive customer reply after the handoff skips the check-in', async () => {
  const { id } = seed({ afterHandoffInbound: ['what is the price of the 16kwh?'] });
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'skipped_reengaged');
});

test('a bare ack after the handoff still gets the check-in', async () => {
  const { id } = seed({ afterHandoffInbound: ['ok thanks'] });
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(store.getFollowupById(id).status, 'sent');
});

test('a conversation whose last inbound is older than 24h is expired (out of window)', async () => {
  const { id } = seed({ handoffAt: '2026-07-26T09:00:00.000Z', lastInboundIso: '2026-07-25T09:00:00.000Z' });
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'expired');
});

test('DISABLE_SALES_FOLLOWUP short-circuits the run', async () => {
  const { id } = seed();
  process.env.DISABLE_SALES_FOLLOWUP = 'true';
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'pending');
  assert.ok(res.skipped);
});

test('DISABLE_ESCALATIONS short-circuits the run', async () => {
  const { id } = seed();
  process.env.DISABLE_ESCALATIONS = 'true';
  const { send, calls } = makeSend();
  const res = await store.runSalesFollowups({ send, now: NOW });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(store.getFollowupById(id).status, 'pending');
  assert.ok(res.skipped);
});
