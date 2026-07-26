'use strict';
// Sales Manager follow-up check-in (2026-07-26).
//
// A few hours after Sunny hands a customer off to the Sales Manager (the
// "Direct line to the Sales Manager" line), Sunny sends ONE gentle check-in:
// did the Sales Manager reach out and sort everything, and do you need
// anything else. This module holds the pure helpers and the store/orchestrator
// pieces are added below. Design: docs/superpowers/specs/2026-07-26-sales-manager-followup-design.md
//
// The message is English-only, matching the existing canned-line policy
// (HOT_LEAD_REPLY / SILENT_QUERY_REPLY are English per the brother's directive).
// The customer may reply in any language; that reply flows through the normal
// pipeline and Sunny answers in their language.

const FOLLOWUP_TEXT =
  "Hello Sir, just following up. Did the Sales Manager reach out and sort everything for you? " +
  "Let me know if there's anything else you need.";

// Words that, on their own, mean the customer only acknowledged and went quiet.
// A message built entirely of these (plus emoji/punctuation) is NOT treated as
// re-engagement, so a customer who said "ok thanks" still gets the check-in.
const ACK_WORDS = new Set([
  'ok', 'okay', 'okey', 'k', 'kk', 'alright', 'aight',
  'thanks', 'thank', 'thankyou', 'ty', 'tnx', 'thx', 'you',
  'noted', 'cool', 'fine', 'great', 'good', 'sure', 'got', 'gotit',
  'understood', 'no', 'problem', 'np', 'nice', 'welcome', 'fantastic',
  'perfect', 'yes', 'yeah', 'yep', 'much', 'pls', 'please',
  'sir', 'oga', 'boss',
  'hello', 'hi', 'hey', 'morning', 'afternoon', 'evening'
]);

// due_at = handoff_at + delayMinutes, returned as an ISO 8601 string.
function computeDueAt(handoffIso, delayMinutes) {
  const base = new Date(handoffIso).getTime();
  return new Date(base + Math.max(0, Number(delayMinutes) || 0) * 60000).toISOString();
}

function localHour(date, tz) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false
  }).format(date);
  return parseInt(h, 10) % 24; // some ICU builds render midnight as '24'
}

// True when the current wall-clock hour in `tz` is within [startHour, endHour).
// Default 08:00 (inclusive) to 21:00 (exclusive) Africa/Lagos: no check-ins
// land in the middle of the night; a due follow-up simply waits for morning.
function isWithinSendWindow(now, startHour = 8, endHour = 21, tz = 'Africa/Lagos') {
  const h = localHour(now, tz);
  return h >= startHour && h < endHour;
}

// True if ANY inbound the customer sent after the handoff carries real content
// (a digit, a question, or words beyond a bare acknowledgement). A pure ack,
// greeting, nag, or emoji-only message returns false, so the customer still
// gets the check-in. `bodies` is an array of raw inbound message strings.
function isSubstantiveReengagement(bodies) {
  for (const raw of bodies || []) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    if (/\d/.test(s)) return true;   // any digit = real content (qty, size, price)
    if (/\?/.test(s)) return true;   // a question = the customer is actively asking
    const letters = s.toLowerCase().replace(/[^a-z\s]/g, ' ').trim(); // drop emoji/punct
    if (!letters) continue;          // emoji-only -> not re-engagement
    const words = letters.split(/\s+/).filter(Boolean);
    if (!words.every(w => ACK_WORDS.has(w))) return true;
  }
  return false;
}

// True once the handoff is older than maxAgeMinutes: too late to send a
// check-in that might land outside the WhatsApp free-form window.
function shouldExpire(handoffIso, nowIso, maxAgeMinutes) {
  const age = new Date(nowIso).getTime() - new Date(handoffIso).getTime();
  return age > Math.max(0, Number(maxAgeMinutes) || 0) * 60000;
}

// ---------------------------------------------------------------------------
// Store layer. Requires db/init lazily so the pure helpers above stay usable
// (and testable) without a database.
// ---------------------------------------------------------------------------

function db() {
  return require('../db/init').getDb();
}

function nowIso() {
  return new Date().toISOString();
}

function scheduleFollowup({ contactId, conversationId, handoffMessageId, handoffAt, dueAt, language }) {
  const ts = nowIso();
  const info = db().prepare(
    `INSERT INTO sales_followups
       (contact_id, conversation_id, handoff_message_id, handoff_at, due_at,
        status, language, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(contactId, conversationId, handoffMessageId || null, handoffAt, dueAt, language || null, ts, ts);
  return info.lastInsertRowid;
}

function getFollowupById(id) {
  return db().prepare('SELECT * FROM sales_followups WHERE id = ?').get(id);
}

// Pending rows whose due time has arrived, oldest first, capped.
function findDueFollowups(nowIsoStr, cap = 20) {
  const limit = Math.max(1, parseInt(cap, 10) || 20);
  return db().prepare(
    `SELECT * FROM sales_followups
      WHERE status = 'pending' AND due_at <= ?
      ORDER BY due_at ASC, id ASC
      LIMIT ?`
  ).all(nowIsoStr, limit);
}

// Re-arm: mark any still-pending follow-ups for this contact as superseded so
// only the latest handoff's row remains live. Returns how many were flipped.
function supersedeOpenFollowupsForContact(contactId) {
  const info = db().prepare(
    `UPDATE sales_followups SET status = 'superseded', updated_at = ?
      WHERE contact_id = ? AND status = 'pending'`
  ).run(nowIso(), contactId);
  return info.changes;
}

function markFollowupSent(id, messageId, sentAtIso) {
  db().prepare(
    `UPDATE sales_followups
        SET status = 'sent', sent_message_id = ?, sent_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(messageId || null, sentAtIso || nowIso(), nowIso(), id);
}

function markFollowupStatus(id, status) {
  db().prepare(
    'UPDATE sales_followups SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, nowIso(), id);
}

// Bodies of customer inbound messages sent AFTER the handoff, oldest first.
function getInboundBodiesAfter(conversationId, afterIso) {
  return db().prepare(
    `SELECT body FROM messages
      WHERE conversation_id = ? AND direction = 'inbound' AND timestamp > ?
      ORDER BY id ASC`
  ).all(conversationId, afterIso).map(r => r.body);
}

// ISO timestamp of the customer's most recent inbound in this conversation.
function getLastInboundAt(conversationId) {
  const row = db().prepare(
    `SELECT timestamp FROM messages
      WHERE conversation_id = ? AND direction = 'inbound'
      ORDER BY id DESC LIMIT 1`
  ).get(conversationId);
  return row ? row.timestamp : null;
}

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function isTrue(v) {
  return String(v).toLowerCase() === 'true';
}

// Called from the handler right after Sunny appends the "Direct line to the
// Sales Manager" line. Re-arms any earlier still-pending follow-up for this
// contact (so only the latest handoff is live) and schedules a fresh one due
// SALES_FOLLOWUP_DELAY_MINUTES later. Returns the new row id, or null when no
// handoff happened or a kill switch is on. Best-effort; the handler wraps the
// call in try/catch so a failure never breaks the customer reply.
function maybeScheduleSalesFollowup({ handoffHappened, contactId, conversationId, handoffMessageId, language, now, delayMinutes }) {
  if (!handoffHappened) return null;
  if (isTrue(process.env.DISABLE_SALES_FOLLOWUP)) return null;
  if (isTrue(process.env.DISABLE_ESCALATIONS)) return null;
  if (!contactId) return null;
  const handoffAt = (now ? new Date(now) : new Date()).toISOString();
  const delay = Number.isFinite(delayMinutes) ? delayMinutes : envInt('SALES_FOLLOWUP_DELAY_MINUTES', 180);
  const dueAt = computeDueAt(handoffAt, delay);
  supersedeOpenFollowupsForContact(contactId);
  return scheduleFollowup({ contactId, conversationId, handoffMessageId, handoffAt, dueAt, language });
}

// ---------------------------------------------------------------------------
// Orchestrator. Drained by the always-on */5 cron. opts.send and opts.now are
// injectable for tests; in production they default to whatsapp.sendMessage and
// the real clock.
// ---------------------------------------------------------------------------

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function runSalesFollowups(opts = {}) {
  if (isTrue(process.env.DISABLE_SALES_FOLLOWUP)) return { sent: 0, skipped: 'disabled' };
  if (isTrue(process.env.DISABLE_ESCALATIONS)) return { sent: 0, skipped: 'escalations_disabled' };

  const now = opts.now ? new Date(opts.now) : new Date();
  const nowMs = now.getTime();
  const nowIsoStr = now.toISOString();

  const startHour = envInt('SALES_FOLLOWUP_SEND_START', 8);
  const endHour = envInt('SALES_FOLLOWUP_SEND_END', 21);
  // Night guard applies to the whole run: outside the window we leave every due
  // row pending so it goes out once morning opens.
  if (!isWithinSendWindow(now, startHour, endHour, 'Africa/Lagos')) {
    return { sent: 0, skipped: 'quiet_hours' };
  }

  const cap = envInt('SALES_FOLLOWUP_PER_RUN_CAP', 20);
  const maxAge = envInt('SALES_FOLLOWUP_MAX_AGE_MINUTES', 1440);

  let rows = [];
  try { rows = findDueFollowups(nowIsoStr, cap); }
  catch (err) { return { sent: 0, error: err.message }; }
  if (!rows.length) return { sent: 0 };

  const memory = require('./memory');
  const logger = require('./utils/logger');
  const send = opts.send || (async (to, text) => require('./whatsapp').sendMessage(to, text));

  let sent = 0;
  for (const row of rows) {
    // Too old to safely send a free-form message.
    if (shouldExpire(row.handoff_at, nowIsoStr, maxAge)) { markFollowupStatus(row.id, 'expired'); continue; }

    let conv = null;
    try { conv = memory.getConversationById(row.conversation_id); } catch {}
    if (!conv) { markFollowupStatus(row.id, 'expired'); continue; }

    // A human took over: they are handling it, no bot check-in.
    if (conv.human_handled) { markFollowupStatus(row.id, 'skipped_reengaged'); continue; }

    // Outside the WhatsApp 24h free-form window: a free-form send would be
    // dropped by Meta, so drop the follow-up instead.
    const lastInbound = getLastInboundAt(row.conversation_id);
    if (!lastInbound || (nowMs - new Date(lastInbound).getTime()) > WINDOW_MS) {
      markFollowupStatus(row.id, 'expired'); continue;
    }

    // Customer is still actively chatting: skip the check-in.
    const bodies = getInboundBodiesAfter(row.conversation_id, row.handoff_at);
    if (isSubstantiveReengagement(bodies)) { markFollowupStatus(row.id, 'skipped_reengaged'); continue; }

    let contact = null;
    try { contact = memory.getContactById(row.contact_id); } catch {}
    if (!contact || !contact.phone) { markFollowupStatus(row.id, 'expired'); continue; }

    let res = null;
    try { res = await send(contact.phone, FOLLOWUP_TEXT); }
    catch (err) {
      logger.warn('handler.sales_followup.send_fail', { followupId: row.id, message: err.message });
      continue; // leave pending; the expiry check bounds retries
    }
    if (!res || !res.ok) {
      logger.warn('handler.sales_followup.send_not_ok', { followupId: row.id, error: res && res.error });
      continue;
    }

    markFollowupSent(row.id, res.messageId, nowIsoStr);
    try {
      memory.appendMessage(row.conversation_id, 'outbound', FOLLOWUP_TEXT, {
        whatsapp_message_id: res.messageId,
        intent: 'sales_followup',
        language: 'english'
      });
    } catch (err) {
      logger.warn('handler.sales_followup.persist_fail', { followupId: row.id, message: err.message });
    }
    try { memory.logEvent(row.contact_id, 'sales_followup_sent', { followupId: row.id }); } catch {}
    logger.info('handler.sales_followup.sent', { followupId: row.id, contactId: row.contact_id });
    sent++;
  }
  return { sent };
}

module.exports = {
  FOLLOWUP_TEXT,
  computeDueAt,
  isWithinSendWindow,
  isSubstantiveReengagement,
  shouldExpire,
  scheduleFollowup,
  getFollowupById,
  findDueFollowups,
  supersedeOpenFollowupsForContact,
  markFollowupSent,
  markFollowupStatus,
  getInboundBodiesAfter,
  getLastInboundAt,
  maybeScheduleSalesFollowup,
  runSalesFollowups
};
