'use strict';
// Voice-call transcript store (2026-08-18). The Pipecat voice sidecar
// (voice/ folder) posts each finished call's transcript to
// POST /voice-transcript (server.js), which lands here. The admin Calls tab
// reads it back via GET /api/calls. A short outbound marker is appended to the
// caller's conversation so the inbox thread shows the call happened; the
// marker is OUTBOUND with no whatsapp_message_id, so the orphan sweep never
// re-queues it and nothing is sent to the customer.

const { getDb } = require('../db/init');
const { getOrCreateContact, getActiveConversation, appendMessage, logEvent } = require('./memory');
const logger = require('./utils/logger');

const VALID_STATUSES = ['completed', 'failed', 'missed', 'no_transcript'];
const MAX_TURNS = 400;
const MAX_TURN_CHARS = 4000;

// Normalize whatever the sidecar sends into [{role, content}] with only
// user/assistant roles and non-empty string content. Content arrays (LLM
// part lists) are flattened to their text parts.
function sanitizeTranscript(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
    if (!role) continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map(p => (p && typeof p === 'object' ? (p.text || '') : String(p || '')))
        .join(' ');
    }
    content = String(content || '').trim();
    if (!content) continue;
    out.push({ role, content: content.slice(0, MAX_TURN_CHARS) });
    if (out.length >= MAX_TURNS) break;
  }
  return out;
}

function formatCallDuration(seconds) {
  if (seconds == null) return null;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return null;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (mins <= 0) return `${rem}s`;
  return `${mins}m ${rem}s`;
}

function computeDurationSeconds(startedAt, endedAt) {
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  return Math.round((e - s) / 1000);
}

function parseTranscriptColumn(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordVoiceCall({ phone, wa_call_id, status, started_at, ended_at, transcript }) {
  const db = getDb();
  const digits = String(phone || '').replace(/\D/g, '');
  const clean = sanitizeTranscript(transcript);
  const now = new Date().toISOString();
  const st = VALID_STATUSES.includes(status)
    ? status
    : (clean.length ? 'completed' : 'no_transcript');
  const duration = computeDurationSeconds(started_at, ended_at);

  let contactId = null;
  let conversationId = null;
  if (digits) {
    try {
      const contact = getOrCreateContact(digits, null);
      contactId = contact.id;
      conversationId = getActiveConversation(contact.id).id;
    } catch (err) {
      logger.warn('voice_calls.contact_link_fail', { message: err.message, phone_tail: digits.slice(-4) });
    }
  }

  const callId = wa_call_id ? String(wa_call_id) : null;
  const existing = callId
    ? db.prepare('SELECT id FROM voice_calls WHERE wa_call_id = ?').get(callId)
    : null;

  let id;
  if (existing) {
    db.prepare(
      'UPDATE voice_calls SET status = ?, ended_at = ?, duration_seconds = ?, transcript = ? WHERE id = ?'
    ).run(st, ended_at || null, duration, JSON.stringify(clean), existing.id);
    id = existing.id;
  } else {
    const info = db.prepare(
      `INSERT INTO voice_calls
        (contact_id, phone, wa_call_id, status, started_at, ended_at, duration_seconds, transcript, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contactId,
      digits || String(phone || ''),
      callId,
      st,
      started_at || null,
      ended_at || null,
      duration,
      JSON.stringify(clean),
      now
    );
    id = Number(info.lastInsertRowid);

    if (conversationId) {
      const durText = formatCallDuration(duration);
      const marker = `[Voice call${durText ? ', ' + durText : ''}. Transcript in the admin Calls tab.]`;
      try {
        appendMessage(conversationId, 'outbound', marker, { intent: 'voice_call' });
      } catch (err) {
        logger.warn('voice_calls.marker_fail', { message: err.message, callRowId: id });
      }
    }
    if (contactId) {
      try {
        logEvent(contactId, 'voice_call_recorded', { call_row_id: id, wa_call_id: callId, duration_seconds: duration });
      } catch {}
    }
  }

  logger.info('voice_calls.recorded', {
    id,
    updated: !!existing,
    phone_tail: digits.slice(-4),
    turns: clean.length,
    duration_seconds: duration,
    status: st
  });
  const saved = getVoiceCallById(id);
  // Lets the caller (server.js) run one-shot side effects (escalation
  // assessment) only on the first insert, never on Meta-retry upserts.
  if (saved) saved.just_created = !existing;
  return saved;
}

function listVoiceCalls({ limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT vc.id, vc.contact_id, vc.phone, vc.wa_call_id, vc.status,
            vc.started_at, vc.ended_at, vc.duration_seconds, vc.created_at,
            vc.transcript,
            c.name AS contact_name, c.category, c.lead_temperature
     FROM voice_calls vc
     LEFT JOIN contacts c ON c.id = vc.contact_id
     ORDER BY vc.id DESC
     LIMIT ? OFFSET ?`
  ).all(Math.min(Number(limit) || 50, 500), Number(offset) || 0);
  return rows.map(r => {
    const turns = parseTranscriptColumn(r.transcript);
    const firstUser = turns.find(t => t.role === 'user');
    const { transcript, ...rest } = r;
    return {
      ...rest,
      transcript_turns: turns.length,
      preview: firstUser ? firstUser.content.slice(0, 140) : null,
      duration_text: formatCallDuration(r.duration_seconds)
    };
  });
}

function getVoiceCallById(id) {
  const db = getDb();
  const row = db.prepare(
    `SELECT vc.*, c.name AS contact_name, c.category, c.lead_temperature
     FROM voice_calls vc
     LEFT JOIN contacts c ON c.id = vc.contact_id
     WHERE vc.id = ?`
  ).get(id);
  if (!row) return null;
  return {
    ...row,
    transcript: parseTranscriptColumn(row.transcript),
    duration_text: formatCallDuration(row.duration_seconds)
  };
}

module.exports = {
  recordVoiceCall,
  listVoiceCalls,
  getVoiceCallById,
  sanitizeTranscript,
  formatCallDuration,
  computeDurationSeconds
};
