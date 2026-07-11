'use strict';
// Run with: node --test test/idle_chatter_wiring.test.js
//
// Guards the 2026-07-11 idle-chatter mute: unproductive conversations (Arabic
// small talk, emoji volleys, junk links, dot transcripts) must stop consuming
// classify + reply calls. The handler wiring under test:
//   maybeMuteIdleChatter(conversation, currentBatchWamids, combinedText, attachments)
// reads the conversation's prior rows (excluding the current batch), asks the
// pure idle_chatter core, and on mute persists a silent_skip marker so the
// orphan sweep never re-queues the turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'sunny-idle-chatter-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { initDb, getDb } = require('../db/init');
const { getOrCreateContact, getActiveConversation, appendMessage } = require('../src/memory');
const handler = require('../src/handler');

let seq = 0;
function seedConversation() {
  seq += 1;
  const contact = getOrCreateContact(`23481000000${String(seq).padStart(2, '0')}`, `Chatter Test ${seq}`);
  const conversation = getActiveConversation(contact.id);
  return { contact, conversation };
}

function persistInbound(conversationId, body, wamid) {
  return appendMessage(conversationId, 'inbound', body, { whatsapp_message_id: wamid });
}

before(() => {
  initDb();
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM contacts').run();
});

test('maybeMuteIdleChatter is exported', () => {
  assert.equal(typeof handler.maybeMuteIdleChatter, 'function');
});

test('second consecutive Arabic-chatter turn is muted and a silent_skip marker is written', () => {
  const { contact, conversation } = seedConversation();
  persistInbound(conversation.id, 'سلام عليك كيف حالك', `wamid.chat.${seq}.1`);
  appendMessage(conversation.id, 'outbound', 'Hello Sir, we reply in English only. How can we help you with your solar needs?', {});
  // Current turn: already persisted (pipeline persists before processing).
  const current = 'صباح الخير كيف حالك هل انت بخير';
  persistInbound(conversation.id, current, `wamid.chat.${seq}.2`);

  const res = handler.maybeMuteIdleChatter(contact, conversation, [`wamid.chat.${seq}.2`], current, []);
  assert.equal(res.muted, true);
  assert.equal(res.reason, 'non_serviced_script');

  const marker = getDb().prepare(
    "SELECT * FROM messages WHERE conversation_id = ? AND intent = 'silent_skip'"
  ).get(conversation.id);
  assert.ok(marker, 'silent_skip marker persisted');
});

test('first low-value turn is not muted (one polite reply allowed)', () => {
  const { contact, conversation } = seedConversation();
  const current = 'صباح الخير كيف حالك';
  persistInbound(conversation.id, current, `wamid.chat.${seq}.1`);
  const res = handler.maybeMuteIdleChatter(contact, conversation, [`wamid.chat.${seq}.1`], current, []);
  assert.equal(res.muted, false);
});

test('bare junk link is muted immediately even on first contact', () => {
  const { contact, conversation } = seedConversation();
  const current = 'Xnxx-arabic.com';
  persistInbound(conversation.id, current, `wamid.chat.${seq}.1`);
  const res = handler.maybeMuteIdleChatter(contact, conversation, [`wamid.chat.${seq}.1`], current, []);
  assert.equal(res.muted, true);
  assert.equal(res.reason, 'bare_link');
});

test('a turn with an image attachment is never muted', () => {
  const { contact, conversation } = seedConversation();
  persistInbound(conversation.id, 'صباح الخير', `wamid.chat.${seq}.1`);
  appendMessage(conversation.id, 'outbound', 'Hello Sir.', {});
  const current = '[Customer sent an image with no caption]';
  persistInbound(conversation.id, current, `wamid.chat.${seq}.2`);
  const res = handler.maybeMuteIdleChatter(contact, conversation, [`wamid.chat.${seq}.2`], current, [{ mime: 'image/jpeg' }]);
  assert.equal(res.muted, false);
});

test('a substantive message is never muted even after a junk streak', () => {
  const { contact, conversation } = seedConversation();
  persistInbound(conversation.id, 'صباح الخير', `wamid.chat.${seq}.1`);
  appendMessage(conversation.id, 'outbound', 'Hello Sir.', {});
  persistInbound(conversation.id, '🌹🌹🌹🌹', `wamid.chat.${seq}.2`);
  appendMessage(conversation.id, 'outbound', '[silent skip: unproductive conversation, muted]', { intent: 'silent_skip' });
  const current = 'I need a 16kW Deye inverter, what is the price?';
  persistInbound(conversation.id, current, `wamid.chat.${seq}.3`);
  const res = handler.maybeMuteIdleChatter(contact, conversation, [`wamid.chat.${seq}.3`], current, []);
  assert.equal(res.muted, false);
});
