'use strict';
// Run with: node --test test/orphan_recovery.test.js
//
// Guards the 2026-07-06 cost-runaway fix: the */5 orphan sweep was re-queuing
// the same deliberately-unanswered messages (warm-close casual confirms) every
// 5 minutes for 6 hours, burning a classifier call per message per sweep.
// Two mechanisms under test:
//   1. persistSilentSkipMarker writes a non-sent outbound row (intent
//      'silent_skip') so an intentional-silence turn no longer looks like an
//      unanswered customer to recoverOrphanedInbound.
//   2. recoverOrphanedInbound caps re-queue attempts per message (default 2),
//      so any future silent path we forget cannot loop all day.
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// Must set DB_PATH before requiring anything that pulls in db/init, because
// the path is captured at module load.
const TMP_DB = path.join(os.tmpdir(), 'sunny-orphan-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { initDb, getDb } = require('../db/init');
const { getOrCreateContact, getActiveConversation, appendMessage } = require('../src/memory');
const handler = require('../src/handler');

function wipeMessages() {
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM contacts').run();
}

let seq = 0;
function seedOrphan() {
  seq += 1;
  const contact = getOrCreateContact(`23480000000${String(seq).padStart(2, '0')}`, `Test Customer ${seq}`);
  const conversation = getActiveConversation(contact.id);
  const inbound = appendMessage(conversation.id, 'inbound', 'Ok', {
    whatsapp_message_id: `wamid.test.${process.pid}.${seq}`
  });
  return { contact, conversation, inbound };
}

before(() => {
  initDb();
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM contacts').run();
});

test('persistSilentSkipMarker writes an outbound silent_skip row', () => {
  assert.equal(typeof handler.persistSilentSkipMarker, 'function', 'persistSilentSkipMarker not exported yet');
  const { conversation } = seedOrphan();
  const res = handler.persistSilentSkipMarker(conversation.id, '[silent skip: test]');
  assert.ok(res && res.id, 'marker row id returned');
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(res.id);
  assert.equal(row.direction, 'outbound');
  assert.equal(row.intent, 'silent_skip');
  assert.equal(row.whatsapp_message_id, null, 'marker is never a real send');
});

test('an inbound followed by a silent_skip marker is not swept as an orphan', async () => {
  assert.equal(typeof handler.resetOrphanRecoveryAttempts, 'function', 'retry-cap API not implemented yet');
  handler.resetOrphanRecoveryAttempts();
  wipeMessages();
  const { conversation } = seedOrphan();
  handler.persistSilentSkipMarker(conversation.id, '[silent skip: test]');

  const enqueued = [];
  const res = await handler.recoverOrphanedInbound(360, {
    minAgeMinutes: 0,
    enqueue: (o) => enqueued.push(o)
  });
  assert.equal(enqueued.length, 0, 'silent-skipped turn must not be re-queued');
  assert.equal(res.recovered, 0);
});

test('a genuine orphan is re-queued via the injected enqueue', async () => {
  assert.equal(typeof handler.resetOrphanRecoveryAttempts, 'function', 'retry-cap API not implemented yet');
  handler.resetOrphanRecoveryAttempts();
  wipeMessages();
  const { contact } = seedOrphan();

  const enqueued = [];
  const res = await handler.recoverOrphanedInbound(360, {
    minAgeMinutes: 0,
    enqueue: (o) => enqueued.push(o)
  });
  assert.equal(res.recovered, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].contact_id, contact.id);
});

test('repeated sweeps re-queue the same message at most twice', async () => {
  assert.equal(typeof handler.resetOrphanRecoveryAttempts, 'function', 'retry-cap API not implemented yet');
  handler.resetOrphanRecoveryAttempts();
  wipeMessages();
  seedOrphan();

  const enqueued = [];
  for (let i = 0; i < 5; i++) {
    await handler.recoverOrphanedInbound(360, {
      minAgeMinutes: 0,
      enqueue: (o) => enqueued.push(o)
    });
  }
  assert.equal(enqueued.length, 2, 'attempt cap must stop the sweep loop');
});

test('resetOrphanRecoveryAttempts clears the attempt counters', async () => {
  assert.equal(typeof handler.resetOrphanRecoveryAttempts, 'function', 'retry-cap API not implemented yet');
  handler.resetOrphanRecoveryAttempts();
  wipeMessages();
  seedOrphan();

  const enqueued = [];
  const opts = { minAgeMinutes: 0, enqueue: (o) => enqueued.push(o) };
  await handler.recoverOrphanedInbound(360, opts);
  await handler.recoverOrphanedInbound(360, opts);
  await handler.recoverOrphanedInbound(360, opts);
  assert.equal(enqueued.length, 2);

  handler.resetOrphanRecoveryAttempts();
  await handler.recoverOrphanedInbound(360, opts);
  assert.equal(enqueued.length, 3, 'reset allows a fresh attempt');
});
