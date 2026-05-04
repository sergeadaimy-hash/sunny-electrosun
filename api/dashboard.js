const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/init');
const logger = require('../src/utils/logger');
const {
  getRecentConversationsForInbox,
  getMessagesForConversation,
  getConversationById,
  setConversationHandled,
  getContactById,
  appendMessage,
  listPendingQueries,
  logEvent
} = require('../src/memory');
const { sendMessage } = require('../src/whatsapp');
const { getTodayStats, getBudgetCents } = require('../src/cost_tracker');
const {
  listKnowledge,
  setKnowledgeStatus,
  updateKnowledgeText,
  deleteKnowledge,
  addKnowledgeEntry
} = require('../src/knowledge');
const {
  getCatalog,
  addItem: addCatalogItem,
  updateItem: updateCatalogItem,
  deleteItem: deleteCatalogItem,
  addNote: addCatalogNote,
  updateNote: updateCatalogNote,
  deleteNote: deleteCatalogNote
} = require('../src/catalog');

const router = express.Router();

router.use((req, res, next) => {
  const apiKey = req.get('X-API-Key');
  if (!process.env.API_KEY) {
    logger.warn('api.no_key_configured');
    return res.status(503).json({ error: 'API_KEY not configured on server' });
  }
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
});

function parseInt32(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/contacts', (req, res) => {
  const db = getDb();
  const { category, from, to } = req.query;
  const limit = Math.min(200, parseInt32(req.query.limit, 50));
  const offset = parseInt32(req.query.offset, 0);

  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (from) { where.push('first_seen >= ?'); params.push(from); }
  if (to) { where.push('first_seen < ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts ${whereSql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM contacts ${whereSql} ORDER BY last_active DESC NULLS LAST, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, contacts: rows });
});

router.get('/contacts/:id', (req, res) => {
  const db = getDb();
  const id = parseInt32(req.params.id, 0);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return res.status(404).json({ error: 'not found' });

  const conversations = db.prepare(
    'SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC'
  ).all(id);

  const messages = db.prepare(`
    SELECT m.*
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ?
    ORDER BY m.id ASC
  `).all(id);

  const events = db.prepare(
    'SELECT * FROM events WHERE contact_id = ? ORDER BY id DESC LIMIT 50'
  ).all(id);

  res.json({ contact, conversations, messages, events });
});

router.get('/stats/today', (req, res) => {
  res.json(buildStats(startOfTodayIso(), new Date().toISOString()));
});

router.get('/stats/range', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (ISO)' });
  res.json(buildStats(from, to));
});

router.get('/reports/latest', (req, res) => {
  const db = getDb();
  const type = req.query.type || 'hourly';
  const row = db.prepare(
    'SELECT * FROM reports WHERE type = ? ORDER BY id DESC LIMIT 1'
  ).get(type);
  if (!row) return res.status(404).json({ error: 'no report yet' });
  res.json({ ...row, payload: safeParse(row.payload) });
});

router.get('/reports', (req, res) => {
  const db = getDb();
  const { from, to, type } = req.query;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('generated_at >= ?'); params.push(from); }
  if (to) { where.push('generated_at < ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM reports ${whereSql} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  res.json({ count: rows.length, reports: rows.map(r => ({ ...r, payload: safeParse(r.payload) })) });
});

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function buildStats(from, to) {
  const db = getDb();
  const inbound = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const outbound = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const newContacts = db.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE first_seen >= ? AND first_seen < ?"
  ).get(from, to).n;
  const escalations = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'escalated' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const byCategory = db.prepare(
    'SELECT category, COUNT(*) AS n FROM contacts GROUP BY category'
  ).all();

  return { from, to, inbound, outbound, new_contacts: newContacts, escalations, by_category: byCategory };
}

router.get('/inbox', (req, res) => {
  const limit = Math.min(200, parseInt32(req.query.limit, 50));
  const offset = parseInt32(req.query.offset, 0);
  const conversations = getRecentConversationsForInbox(limit, offset);
  res.json({ conversations, limit, offset });
});

router.get('/conversations/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const conversation = getConversationById(id);
  if (!conversation) return res.status(404).json({ error: 'not found' });
  const contact = getContactById(conversation.contact_id);
  const messages = getMessagesForConversation(id);
  res.json({ conversation, contact, messages });
});

router.post('/conversations/:id/handle', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const conv = getConversationById(id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  setConversationHandled(id, true);
  logEvent(conv.contact_id, 'conversation_handed_to_human', { conversationId: id });
  res.json({ ok: true, conversation_id: id, human_handled: true });
});

router.post('/conversations/:id/release', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const conv = getConversationById(id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  setConversationHandled(id, false);
  logEvent(conv.contact_id, 'conversation_returned_to_agent', { conversationId: id });
  res.json({ ok: true, conversation_id: id, human_handled: false });
});

router.post('/conversations/:id/send-reply', async (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 4000) return res.status(400).json({ error: 'text too long (max 4000 chars)' });

  const conv = getConversationById(id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const contact = getContactById(conv.contact_id);
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  try {
    const sendRes = await sendMessage(contact.phone, text);
    if (!sendRes.ok) {
      return res.status(502).json({ error: 'whatsapp send failed', status: sendRes.status, data: sendRes.data });
    }
    appendMessage(id, 'outbound', text, {
      whatsapp_message_id: sendRes.messageId,
      intent: 'human_manual_reply',
      language: contact.language || 'english'
    });
    if (!conv.human_handled) {
      setConversationHandled(id, true);
      logEvent(conv.contact_id, 'conversation_handed_to_human', { conversationId: id, by: 'send_reply' });
    }
    logger.info('admin.send_reply.ok', { conversationId: id, customerPhone: contact.phone });
    res.json({ ok: true, message_id: sendRes.messageId });
  } catch (err) {
    logger.error('admin.send_reply.error', { conversationId: id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/queries/pending', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pq.*, c.phone, c.name
    FROM pending_queries pq
    LEFT JOIN contacts c ON c.id = pq.contact_id
    WHERE pq.status = 'pending'
    ORDER BY pq.created_at ASC
  `).all();
  res.json({ count: rows.length, pending: rows });
});

router.get('/budget/today', (req, res) => {
  const stats = getTodayStats();
  const budgetCents = getBudgetCents();
  res.json({
    date: stats.date,
    spend_cents: stats.total_cents,
    spend_usd: (stats.total_cents / 100).toFixed(2),
    budget_cents: budgetCents,
    budget_usd: budgetCents !== null ? (budgetCents / 100).toFixed(2) : null,
    classifier_calls: stats.classifier_calls,
    reply_calls: stats.reply_calls,
    over_budget: budgetCents !== null && stats.total_cents >= budgetCents
  });
});

router.get('/knowledge', (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const rows = listKnowledge(filter);
  res.json({ count: rows.length, entries: rows });
});

router.post('/knowledge', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const category = String(req.body?.category || 'other').trim();
  const id = addKnowledgeEntry({
    sourceMessage: '(added manually via admin)',
    extractedFact: text,
    category,
    confidence: 100,
    status: 'active'
  });
  res.json({ ok: true, id });
});

router.post('/knowledge/:id/status', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const status = String(req.body?.status || '').trim();
  if (!['active', 'pending', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be active|pending|rejected' });
  }
  setKnowledgeStatus(id, status);
  res.json({ ok: true, id, status });
});

router.post('/knowledge/:id/edit', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const category = req.body?.category ? String(req.body.category).trim() : null;
  updateKnowledgeText(id, text, category);
  res.json({ ok: true, id });
});

router.delete('/knowledge/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  deleteKnowledge(id);
  res.json({ ok: true, id });
});

router.get('/catalog', (req, res) => {
  res.json(getCatalog());
});

router.post('/catalog/items', (req, res) => {
  try {
    const id = addCatalogItem(req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/catalog/items/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    updateCatalogItem(id, req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/catalog/items/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  deleteCatalogItem(id);
  res.json({ ok: true, id });
});

router.post('/catalog/notes', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const id = addCatalogNote(text);
  res.json({ ok: true, id });
});

router.post('/catalog/notes/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  updateCatalogNote(id, text);
  res.json({ ok: true, id });
});

router.delete('/catalog/notes/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  deleteCatalogNote(id);
  res.json({ ok: true, id });
});

router.get('/brain', (req, res) => {
  const root = path.join(__dirname, '..');
  const safeRead = (p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  };
  const rules = {
    system: safeRead(path.join(root, 'src', 'prompts', 'system.md')),
    classifier: safeRead(path.join(root, 'src', 'prompts', 'classifier.md')),
    teacher: safeRead(path.join(root, 'src', 'prompts', 'teacher.md'))
  };
  const models = {
    classifier: process.env.MODEL_CLASSIFIER || 'claude-opus-4-7',
    teacher: process.env.MODEL_TEACHER || 'claude-opus-4-7',
    owner_qa: process.env.MODEL_OWNER_QA || 'claude-opus-4-7',
    reply: process.env.MODEL_REPLY || 'claude-opus-4-7'
  };
  const config = {
    daily_budget_usd: process.env.DAILY_LLM_BUDGET_USD || null,
    db_path: process.env.DB_PATH || '(default db/sunny.db)',
    media_dir: process.env.MEDIA_DIR || '(default <db dir>/media)',
    log_to_file: process.env.LOG_TO_FILE || 'true',
    owner_whatsapp_set: !!process.env.OWNER_WHATSAPP,
    owner_whatsapp_tail: process.env.OWNER_WHATSAPP ? String(process.env.OWNER_WHATSAPP).slice(-4) : null,
    specialist_link_set: !!process.env.SPECIALIST_DIRECT_LINK,
    escalations_disabled: String(process.env.DISABLE_ESCALATIONS || '').toLowerCase() === 'true',
    waba_id: process.env.META_WABA_ID || null,
    graph_version: 'v21.0'
  };
  res.json({ rules, models, config });
});

router.get('/version', (req, res) => {
  res.json({
    git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || null,
    git_sha_short: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || '').slice(0, 7) || null,
    git_branch: process.env.RAILWAY_GIT_BRANCH || null,
    git_commit_message: (process.env.RAILWAY_GIT_COMMIT_MESSAGE || '').slice(0, 200) || null,
    deploy_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
    node_uptime_seconds: Math.floor(process.uptime()),
    server_time: new Date().toISOString()
  });
});

module.exports = router;
