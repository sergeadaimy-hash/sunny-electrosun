const { getDb } = require('../db/init');

const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function getOrCreateContact(phone, name = null) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  if (row) return row;

  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO contacts (phone, name, first_seen, last_active) VALUES (?, ?, ?, ?)'
  ).run(phone, name, ts, ts);
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
}

function updateContactFields(contactId, fields) {
  const db = getDb();
  const allowed = [
    'name', 'category', 'lead_temperature', 'client_type', 'language',
    'location', 'use_case', 'load_estimate', 'timeline',
    'products_asked_about', 'brand_preference', 'budget_mentioned',
    'notes', 'last_active'
  ];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined && fields[key] !== null) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (!updates.length) return;
  values.push(contactId);
  db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function getActiveConversation(contactId) {
  const db = getDb();
  const latest = db.prepare(
    "SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1"
  ).get(contactId);

  if (latest && latest.last_message_at) {
    const lastMs = new Date(latest.last_message_at).getTime();
    if (Date.now() - lastMs < CONVERSATION_WINDOW_MS) {
      return latest;
    }
  } else if (latest && !latest.last_message_at) {
    return latest;
  }

  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO conversations (contact_id, status, started_at, last_message_at) VALUES (?, ?, ?, ?)'
  ).run(contactId, 'active', ts, ts);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}

function appendMessage(conversationId, direction, body, meta = {}) {
  const db = getDb();
  const { intent = null, language = null, whatsapp_message_id = null } = meta;

  if (whatsapp_message_id) {
    const existing = db.prepare(
      'SELECT id FROM messages WHERE whatsapp_message_id = ?'
    ).get(whatsapp_message_id);
    if (existing) return { id: existing.id, duplicate: true };
  }

  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO messages (conversation_id, direction, body, intent, language, whatsapp_message_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(conversationId, direction, body, intent, language, whatsapp_message_id, ts);

  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);

  const conv = db.prepare('SELECT contact_id FROM conversations WHERE id = ?').get(conversationId);
  if (conv) {
    db.prepare('UPDATE contacts SET last_active = ? WHERE id = ?').run(ts, conv.contact_id);
  }

  return { id: info.lastInsertRowid, duplicate: false };
}

function getRecentHistory(contactId, limit = 20) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.direction, m.body, m.timestamp
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(contactId, limit);

  rows.reverse();

  const messages = [];
  for (const r of rows) {
    const role = r.direction === 'inbound' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content += '\n' + r.body;
    } else {
      messages.push({ role, content: r.body });
    }
  }
  return messages;
}

function logEvent(contactId, type, payload = null) {
  const db = getDb();
  const payloadStr = payload ? JSON.stringify(payload) : null;
  db.prepare('INSERT INTO events (contact_id, type, payload, timestamp) VALUES (?, ?, ?, ?)').run(contactId, type, payloadStr, nowIso());
}

function getMessageByWhatsappId(whatsappMessageId) {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE whatsapp_message_id = ?').get(whatsappMessageId);
}

function createPendingQuery({ contactId, customerMessageId, customerMessageText, classifierIntent }) {
  const db = getDb();
  const ts = nowIso();
  const info = db.prepare(
    `INSERT INTO pending_queries
       (contact_id, customer_message_id, customer_message_text, classifier_intent, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(contactId, customerMessageId || null, customerMessageText || null, classifierIntent || null, ts);
  return info.lastInsertRowid;
}

function setPendingQueryAlertId(queryId, alertMessageId) {
  if (!alertMessageId) return;
  const db = getDb();
  db.prepare('UPDATE pending_queries SET alert_message_id = ? WHERE id = ?').run(alertMessageId, queryId);
}

function findPendingByAlertId(alertMessageId) {
  if (!alertMessageId) return null;
  const db = getDb();
  return db.prepare(
    "SELECT * FROM pending_queries WHERE alert_message_id = ? AND status = 'pending' LIMIT 1"
  ).get(alertMessageId) || null;
}

function resolvePendingQuery(queryId, ownerReplyText) {
  const db = getDb();
  db.prepare(
    "UPDATE pending_queries SET status = 'resolved', resolved_at = ?, owner_reply_text = ? WHERE id = ?"
  ).run(nowIso(), ownerReplyText, queryId);
}

function listPendingQueries() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM pending_queries WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();
}

function findPendingQueriesNeedingWarning(warnAfterIso) {
  const db = getDb();
  return db.prepare(`
    SELECT pq.*, c.phone AS customer_phone, c.name AS customer_name
    FROM pending_queries pq
    LEFT JOIN contacts c ON c.id = pq.contact_id
    WHERE pq.status = 'pending'
      AND pq.expiring_warning_sent_at IS NULL
      AND pq.created_at <= ?
    ORDER BY pq.created_at ASC
  `).all(warnAfterIso);
}

function markPendingQueryWarned(queryId) {
  const db = getDb();
  db.prepare('UPDATE pending_queries SET expiring_warning_sent_at = ? WHERE id = ?')
    .run(nowIso(), queryId);
}

function findExpiredPendingQueries(expiredBeforeIso) {
  const db = getDb();
  return db.prepare(`
    SELECT pq.*, c.phone AS customer_phone, c.name AS customer_name
    FROM pending_queries pq
    LEFT JOIN contacts c ON c.id = pq.contact_id
    WHERE pq.status = 'pending'
      AND pq.created_at <= ?
    ORDER BY pq.created_at ASC
  `).all(expiredBeforeIso);
}

function markPendingQueryExpired(queryId) {
  const db = getDb();
  db.prepare("UPDATE pending_queries SET status = 'expired' WHERE id = ?").run(queryId);
}

function getContactById(contactId) {
  const db = getDb();
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) || null;
}

function getConversationById(conversationId) {
  const db = getDb();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) || null;
}

function setConversationHandled(conversationId, handled) {
  const db = getDb();
  const ts = handled ? nowIso() : null;
  db.prepare('UPDATE conversations SET human_handled = ?, human_handled_at = ? WHERE id = ?')
    .run(handled ? 1 : 0, ts, conversationId);
}

function getRecentConversationsForInbox(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT
      conv.id AS conversation_id,
      conv.contact_id,
      conv.status,
      conv.human_handled,
      conv.human_handled_at,
      conv.last_message_at,
      c.phone, c.name, c.category, c.lead_temperature, c.client_type, c.location,
      (SELECT body FROM messages WHERE conversation_id = conv.id ORDER BY id DESC LIMIT 1) AS last_message_body,
      (SELECT direction FROM messages WHERE conversation_id = conv.id ORDER BY id DESC LIMIT 1) AS last_message_direction,
      (SELECT COUNT(*) FROM pending_queries pq WHERE pq.contact_id = c.id AND pq.status = 'pending') AS pending_queries_count
    FROM conversations conv
    JOIN contacts c ON c.id = conv.contact_id
    ORDER BY conv.last_message_at DESC NULLS LAST
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getMessagesForConversation(conversationId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, body, intent, language, whatsapp_message_id, timestamp
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(conversationId);
}

module.exports = {
  getOrCreateContact,
  updateContactFields,
  getActiveConversation,
  appendMessage,
  getRecentHistory,
  logEvent,
  getMessageByWhatsappId,
  createPendingQuery,
  setPendingQueryAlertId,
  findPendingByAlertId,
  resolvePendingQuery,
  listPendingQueries,
  findPendingQueriesNeedingWarning,
  markPendingQueryWarned,
  findExpiredPendingQueries,
  markPendingQueryExpired,
  getContactById,
  getConversationById,
  setConversationHandled,
  getRecentConversationsForInbox,
  getMessagesForConversation,
  CONVERSATION_WINDOW_MS
};
