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
const { recoverOrphanedInbound, answerPendingForContact, retryFallbackReplies } = require('../src/handler');
const datasheetsModule = require('../src/datasheets');
const { getTodayStats, getBudgetCents, getMonthStats } = require('../src/cost_tracker');
const {
  listKnowledge,
  setKnowledgeStatus,
  updateKnowledgeText,
  deleteKnowledge,
  addKnowledgeEntry,
  findOverlapGroups,
  getKnowledgeStats,
  rejectLegacyFacts
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
const warehouseModule = require('../src/warehouse');
const promptStore = require('../src/prompt_store');
const auditStore = require('../src/audit_store');
const { rebuildAndCommitPlaybook } = require('../src/playbook');
const { groupFindings, runNightlyAudit } = require('../src/audit');

// Guards a manual audit run from being double-triggered while one is in flight.
let _manualAuditRunning = false;
const ownerRouting = require('../src/owner_routing');
const {
  listItems: listWarehouseItems,
  addItem: addWarehouseItem,
  updateItem: updateWarehouseItem,
  deleteItem: deleteWarehouseItem,
  setStock: setWarehouseStock,
  adjustQuantity: adjustWarehouseQuantity,
  setDatasheet: setWarehouseDatasheet,
  removeDatasheet: removeWarehouseDatasheet,
  listPhotosForItem: listWarehousePhotos,
  addPhotoForItem: addWarehousePhoto,
  updatePhotoForItem: updateWarehousePhoto,
  removePhotoForItem: removeWarehousePhoto,
  getPhotoById: getWarehousePhotoById
} = warehouseModule;

const router = express.Router();

// Endpoints the inbox-only role is allowed to reach. Anything not listed here
// returns 403 for that role, so the restriction is enforced on the server and
// not merely hidden in the UI. Each entry is { method, test(path) }.
const INBOX_ALLOWED = [
  { method: 'GET', test: (p) => p === '/whoami' },
  { method: 'GET', test: (p) => p === '/inbox' },
  { method: 'GET', test: (p) => p === '/stats/today' },
  { method: 'GET', test: (p) => p === '/queries/pending' },
  { method: 'GET', test: (p) => /^\/conversations\/\d+$/.test(p) },
  { method: 'POST', test: (p) => /^\/conversations\/\d+\/handle$/.test(p) },
  { method: 'POST', test: (p) => /^\/conversations\/\d+\/release$/.test(p) },
  { method: 'POST', test: (p) => /^\/conversations\/\d+\/send-reply$/.test(p) }
];

function inboxRoleAllows(method, urlPath) {
  return INBOX_ALLOWED.some((r) => r.method === method && r.test(urlPath));
}

router.use((req, res, next) => {
  const apiKey = req.get('X-API-Key') || (req.query && req.query.key);
  if (!process.env.API_KEY) {
    logger.warn('api.no_key_configured');
    return res.status(503).json({ error: 'API_KEY not configured on server' });
  }

  if (apiKey === process.env.API_KEY) {
    req.role = 'admin';
    return next();
  }

  const inboxKey = process.env.INBOX_API_KEY;
  if (inboxKey && apiKey === inboxKey) {
    req.role = 'inbox';
    // req.path strips the /api mount prefix and the query string.
    if (!inboxRoleAllows(req.method, req.path)) {
      logger.warn('api.inbox_role_forbidden', { method: req.method, path: req.path });
      return res.status(403).json({ error: 'forbidden for this account' });
    }
    return next();
  }

  return res.status(401).json({ error: 'invalid api key' });
});

// Lets the page discover which role the presented key has, so it can hide the
// non-inbox tabs for the inbox-only account.
router.get('/whoami', (req, res) => {
  res.json({ role: req.role || 'admin' });
});

function parseInt32(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/contacts', (req, res) => {
  const db = getDb();
  const { category, from, to } = req.query;
  // Default page is 50; the admin UI requests larger pages explicitly. The
  // hard cap is high (10000) so a single page can load the entire address
  // book without losing contacts in the UI. The DB itself never deletes
  // contacts, so all rows are reachable.
  const limit = Math.min(10000, parseInt32(req.query.limit, 50));
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

// Export every contact as a single-sheet .xlsx. Defined BEFORE /contacts/:id so
// the literal "export" path is not captured by the :id param route. Pulls all
// rows (no pagination) ordered like the Contacts tab. exceljs is required lazily
// so a missing dependency only breaks this endpoint, not the whole dashboard.
router.get('/contacts/export', async (req, res) => {
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch (err) {
    return res.status(500).json({ error: 'exceljs not installed on the server' });
  }
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM contacts ORDER BY last_active DESC NULLS LAST, id DESC'
    ).all();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sunny';
    wb.created = new Date();
    const ws = wb.addWorksheet('Contacts');
    ws.columns = [
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Category', key: 'category', width: 12 },
      { header: 'Lead temperature', key: 'lead_temperature', width: 16 },
      { header: 'Client type', key: 'client_type', width: 14 },
      { header: 'Language', key: 'language', width: 12 },
      { header: 'Location', key: 'location', width: 18 },
      { header: 'Use case', key: 'use_case', width: 24 },
      { header: 'Load estimate', key: 'load_estimate', width: 16 },
      { header: 'Timeline', key: 'timeline', width: 14 },
      { header: 'Products asked about', key: 'products_asked_about', width: 26 },
      { header: 'Brand preference', key: 'brand_preference', width: 16 },
      { header: 'Budget mentioned', key: 'budget_mentioned', width: 16 },
      { header: 'Lead source', key: 'lead_source', width: 16 },
      { header: 'First seen', key: 'first_seen', width: 22 },
      { header: 'Last active', key: 'last_active', width: 22 },
      { header: 'Notes', key: 'notes', width: 30 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Keep phone numbers as text so Excel never rounds them or drops the leading +.
    ws.getColumn('phone').numFmt = '@';

    for (const r of rows) {
      ws.addRow({
        phone: r.phone == null ? '' : String(r.phone),
        name: r.name || '',
        category: r.category || '',
        lead_temperature: r.lead_temperature || '',
        client_type: r.client_type || '',
        language: r.language || '',
        location: r.location || '',
        use_case: r.use_case || '',
        load_estimate: r.load_estimate || '',
        timeline: r.timeline || '',
        products_asked_about: r.products_asked_about || '',
        brand_preference: r.brand_preference || '',
        budget_mentioned: r.budget_mentioned || '',
        lead_source: r.lead_source || '',
        first_seen: r.first_seen || '',
        last_active: r.last_active || '',
        notes: r.notes || ''
      });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="electrosun-contacts-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'export failed: ' + err.message });
    else res.end();
  }
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
  // HOT deals active in the window (today, for the header badge). Counts a
  // contact as hot when either the classifier category or the lead_temperature
  // is HOT and they have been active within the window. Replaces the old
  // all-time "pending queries" header figure, which grew stale and unrealistic.
  // Team numbers (owners + sales desks) are excluded: they are not leads, and a
  // colleague who messaged Sunny before being configured may carry a stale HOT
  // row.
  const team = ownerRouting.teamPhoneDigits();
  const teamPlaceholders = team.length ? team.map(() => '?').join(',') : null;
  const hot = db.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE (UPPER(COALESCE(lead_temperature,'')) = 'HOT' OR UPPER(COALESCE(category,'')) = 'HOT') AND last_active >= ? AND last_active < ?"
    + (teamPlaceholders ? ` AND phone NOT IN (${teamPlaceholders})` : '')
  ).get(from, to, ...team).n;

  return { from, to, inbound, outbound, new_contacts: newContacts, escalations, hot, by_category: byCategory };
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
  // Fire-and-forget: re-process the latest unanswered customer message so Sunny replies on release
  answerPendingForContact(conv.contact_id).catch(err => {
    console.error('release.answer_pending_fail', { contactId: conv.contact_id, message: err.message });
  });
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

router.get('/owner-chat', (req, res) => {
  // The team numbers Sunny routes alerts to (Patrick, Charbel, Abuja Sales,
  // Lagos Sales). The UI renders one tab per recipient; ?label= selects which
  // thread to show. Defaults to the first configured recipient (Patrick).
  const recipients = ownerRouting.configuredRecipients();
  if (!recipients.length) return res.json({ contact: null, messages: [], recipients: [], active_label: null });

  const requested = String(req.query.label || '').toLowerCase();
  const active = recipients.find(r => r.label === requested) || recipients[0];

  const limit = parseInt32(req.query.limit, 200);
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE phone = ? LIMIT 1').get(active.phone);
  if (!contact) {
    return res.json({ contact: null, messages: [], recipients, active_label: active.label });
  }
  const rawMessages = db.prepare(`
    SELECT m.id, m.conversation_id, m.direction, m.body, m.intent, m.language,
           m.timestamp, m.media_path, m.media_mime, m.whatsapp_message_id, m.reacted_to_wamid
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(contact.id, limit);
  rawMessages.reverse();
  res.json({ contact, messages: rawMessages, recipients, active_label: active.label });
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
    status: 'active',
    replaceIfDuplicate: true
  });
  res.json({ ok: true, id });
});

router.get('/knowledge/overlaps', (req, res) => {
  try {
    const groups = findOverlapGroups();
    res.json({ count: groups.length, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/knowledge/stats', (req, res) => {
  try {
    const stats = getKnowledgeStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/knowledge/refresh', (req, res) => {
  try {
    const stats = getKnowledgeStats();
    logger.info('api.knowledge.refresh', {
      active_count: stats.active_count,
      overlap_groups: stats.overlap_groups,
      prompt_block_chars: stats.prompt_block_chars
    });
    res.json({ ok: true, refreshed_at: new Date().toISOString(), stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/knowledge/cleanup-legacy', (req, res) => {
  try {
    const result = rejectLegacyFacts();
    const stats = getKnowledgeStats();
    res.json({ ok: true, ...result, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

router.get('/warehouse', (req, res) => {
  try {
    res.json({ items: listWarehouseItems() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/warehouse/items', (req, res) => {
  try {
    const id = addWarehouseItem(req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    updateWarehouseItem(id, req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/warehouse/items/:id', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    deleteWarehouseItem(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/stock/:location', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const location = String(req.params.location || '').toLowerCase();
  try {
    setWarehouseStock(id, location, req.body || {});
    res.json({ ok: true, id, location });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/stock/:location/adjust', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const location = String(req.params.location || '').toLowerCase();
  const delta = parseInt32(req.body?.delta, 0);
  try {
    adjustWarehouseQuantity(id, location, delta);
    res.json({ ok: true, id, location, delta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/datasheet', express.json({ limit: '20mb' }), (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const filename = String(req.body?.filename || '').trim();
    const mimeType = String(req.body?.mime_type || '').trim();
    const base64 = String(req.body?.base64 || '');
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!mimeType) return res.status(400).json({ error: 'mime_type required' });
    if (!base64) return res.status(400).json({ error: 'base64 file content required' });
    setWarehouseDatasheet(id, { filename, mimeType, base64 });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/warehouse/items/:id/datasheet', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    removeWarehouseDatasheet(id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/warehouse/items/:id/datasheet/download', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const item = warehouseModule.getItem(id);
    if (!item || !item.datasheet_path) return res.status(404).json({ error: 'no datasheet attached' });
    res.setHeader('Content-Type', item.datasheet_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + (item.datasheet_filename || 'datasheet').replace(/"/g, '') + '"');
    require('fs').createReadStream(item.datasheet_path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/staple', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const value = !!(req.body && req.body.is_staple);
    warehouseModule.setStaple(id, value);
    res.json({ ok: true, id, is_staple: value });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/datasheet/reextract', async (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const text = await warehouseModule.extractDatasheetTextForItem(id);
    if (text === null) return res.status(404).json({ error: 'no datasheet attached or file missing' });
    res.json({ ok: true, id, chars: (text || '').length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-item Photos: list, upload one (base64), update caption/sort_order,
// archive (soft) or hard-delete with ?hard=1. The GET /warehouse response
// already inlines active photos per item, but this list endpoint is useful
// for an admin-only "show archived" view if/when added.
router.get('/warehouse/items/:id/photos', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const photos = listWarehousePhotos(id, { includeArchived });
    res.json({ count: photos.length, photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/photos', express.json({ limit: '8mb' }), (req, res) => {
  const id = parseInt32(req.params.id, 0);
  try {
    const filename = String(req.body?.filename || '').trim();
    const mimeType = String(req.body?.mime_type || '').trim();
    const base64 = String(req.body?.base64 || '');
    const caption = req.body?.caption == null ? null : String(req.body.caption);
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!mimeType) return res.status(400).json({ error: 'mime_type required' });
    if (!base64) return res.status(400).json({ error: 'base64 file content required' });
    const photo = addWarehousePhoto(id, { filename, mimeType, base64, caption });
    res.json({ ok: true, id, photo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/warehouse/items/:id/photos/:photoId', (req, res) => {
  const photoId = parseInt32(req.params.photoId, 0);
  try {
    const photo = updateWarehousePhoto(photoId, req.body || {});
    res.json({ ok: true, photo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/warehouse/items/:id/photos/:photoId', (req, res) => {
  const photoId = parseInt32(req.params.photoId, 0);
  try {
    const hard = req.query.hard === '1' || req.query.hard === 'true';
    const removed = removeWarehousePhoto(photoId, { hard });
    if (!removed) return res.status(404).json({ error: 'photo not found' });
    res.json({ ok: true, photoId, hard });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Binary fetch for admin thumbnail rendering. Auth still applies (the
// router-wide middleware accepts ?key= so <img src> tags work).
router.get('/warehouse/photos/:photoId/file', (req, res) => {
  const photoId = parseInt32(req.params.photoId, 0);
  try {
    const photo = getWarehousePhotoById(photoId);
    if (!photo || !photo.file_path) return res.status(404).json({ error: 'photo not found' });
    if (!require('fs').existsSync(photo.file_path)) return res.status(404).json({ error: 'photo file missing on disk' });
    res.setHeader('Content-Type', photo.mime_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    require('fs').createReadStream(photo.file_path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nightly self-improvement audit endpoints (admin-only)

router.get('/audit/runs', (req, res) => {
  try {
    res.json({ runs: auditStore.listRuns(parseInt32(req.query.limit, 30)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit/runs/:id', (req, res) => {
  try {
    const id = parseInt32(req.params.id, 0);
    const run = auditStore.getRun(id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    const findings = auditStore.getFindingsForRun(id);
    res.json({ run, findings, groups: groupFindings(findings) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/audit/findings/:id/status', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const status = String(req.body?.status || '').trim();
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved|rejected|pending' });
  }
  const editedText = typeof req.body?.edited_text === 'string' ? req.body.edited_text : undefined;
  try {
    auditStore.setFindingStatus(id, status, editedText);
    res.json({ ok: true, id, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batch approve a merged group: mark every underlying finding approved (with the
// owner's edited text, if any), then immediately apply + deploy. The deploy is
// the learned-playbook rebuild + GitHub commit (Railway auto-redeploys on push),
// and is only run when the batch contains at least one skill_lesson (the other
// lanes have no automated target, so they are recorded only). Returns the deploy
// outcome so the UI can show "applied & deployed".
router.post('/audit/approve', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt32(n, 0)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const editedText = typeof req.body?.edited_text === 'string' ? req.body.edited_text : undefined;
  try {
    let hasLesson = false;
    for (const id of ids) {
      const f = auditStore.getFinding(id);
      if (!f) continue;
      if (f.lane === 'skill_lesson') hasLesson = true;
      auditStore.setFindingStatus(id, 'approved', editedText);
    }
    let applied = 0;
    let deployed = false;
    let commit = null;
    if (hasLesson) {
      const result = await rebuildAndCommitPlaybook();
      applied = result.applied || 0;
      commit = result.commit || null;
      deployed = !!(commit && commit.committed);
    }
    res.json({ ok: true, approved: ids.length, has_lesson: hasLesson, applied, deployed, commit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch reject a merged group: every underlying finding is marked rejected and
// will never be shown again (groupFindings drops rejected rows).
router.post('/audit/reject', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt32(n, 0)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  try {
    for (const id of ids) auditStore.setFindingStatus(id, 'rejected');
    res.json({ ok: true, rejected: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/audit/apply', async (req, res) => {
  try {
    const result = await rebuildAndCommitPlaybook();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger an audit run now (does not wait for the 21:00 cron). Runs in
// the background because a full run takes minutes; the new run row appears in
// the list immediately as 'running' and flips to 'done' when finished.
router.post('/audit/run', (req, res) => {
  if (_manualAuditRunning) {
    return res.status(409).json({ error: 'an audit run is already in progress' });
  }
  const windowHours = Math.min(Math.max(parseInt32(req.body?.window_hours, 24) || 24, 1), 168);
  _manualAuditRunning = true;
  Promise.resolve()
    .then(() => runNightlyAudit({ windowHours }))
    .then(r => logger.info('audit.manual_run_done', r))
    .catch(err => logger.error('audit.manual_run_fail', { message: err.message }))
    .finally(() => { _manualAuditRunning = false; });
  res.json({ ok: true, started: true, window_hours: windowHours });
});

router.get('/brain', (req, res) => {
  promptStore.invalidate();
  const rules = promptStore.getAll();
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
  const todayStats = getTodayStats();
  const monthStats = getMonthStats();
  const budgetCents = getBudgetCents();
  const spending = {
    today_usd: (todayStats.total_cents / 100).toFixed(2),
    month: monthStats.month,
    month_usd: (monthStats.total_cents / 100).toFixed(2),
    month_reply_calls: monthStats.reply_calls,
    month_classifier_calls: monthStats.classifier_calls,
    month_active_days: monthStats.days,
    daily_budget_usd: budgetCents !== null ? (budgetCents / 100).toFixed(2) : null
  };
  res.json({ rules, models, config, spending });
});

router.post('/prompts/:name', express.json({ limit: '1mb' }), async (req, res) => {
  const name = String(req.params.name || '');
  if (!promptStore.ALLOWED.includes(name)) {
    return res.status(400).json({ error: 'unknown prompt: ' + name });
  }
  const content = req.body && typeof req.body.content === 'string' ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: 'content (string) required' });

  let writeOk = false;
  try {
    promptStore.write(name, content);
    writeOk = true;
  } catch (err) {
    return res.status(500).json({ error: 'write failed: ' + err.message });
  }

  const result = { ok: true, name, saved_locally: true, committed: false };

  const repo = process.env.GITHUB_REPO || 'sergeadaimy-hash/sunny-electrosun';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    result.git_error = 'GITHUB_TOKEN env var is not set; edit applies to this container only and will be lost on next git redeploy.';
    return res.json(result);
  }

  try {
    const filePath = 'src/prompts/' + name + '.md';
    const apiBase = 'https://api.github.com/repos/' + repo + '/contents/' + filePath;
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sunny-electrosun-admin'
    };

    const getRes = await fetch(apiBase + '?ref=' + encodeURIComponent(branch), { headers });
    let sha = null;
    if (getRes.ok) {
      const meta = await getRes.json();
      sha = meta.sha;
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      throw new Error('GitHub GET ' + getRes.status + ': ' + t.slice(0, 200));
    }

    const putBody = {
      message: 'admin: edit ' + filePath + ' via Sunny console',
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody)
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error('GitHub PUT ' + putRes.status + ': ' + t.slice(0, 300));
    }
    const putJson = await putRes.json();
    result.committed = true;
    result.commit_sha = putJson.commit && putJson.commit.sha;
    result.html_url = putJson.content && putJson.content.html_url;
    logger.info('api.prompts.committed', { name, commit_sha: result.commit_sha });
  } catch (err) {
    logger.warn('api.prompts.commit_fail', { name, message: err.message });
    result.git_error = err.message;
  }

  res.json(result);
});

router.post('/prompts/deploy', async (req, res) => {
  const hookUrl = process.env.RAILWAY_DEPLOY_HOOK_URL;
  const token = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  // Path 1: legacy deploy hook URL (kept for backwards compat)
  if (hookUrl) {
    try {
      const r = await fetch(hookUrl, { method: 'POST' });
      if (r.ok) {
        logger.info('api.prompts.deploy_triggered', { via: 'hook' });
        return res.json({ ok: true, message: 'Deploy triggered via hook. New container live in 30-60 seconds.' });
      }
      const t = await r.text();
      logger.warn('api.prompts.deploy_hook_failed', { status: r.status, body: t.slice(0, 200) });
    } catch (err) {
      logger.warn('api.prompts.deploy_hook_error', { message: err.message });
    }
  }

  // Path 2: Railway GraphQL API (project token)
  if (token && serviceId && environmentId) {
    try {
      const query = 'mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }';
      const r = await fetch('https://backboard.railway.app/graphql/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ query, variables: { serviceId, environmentId } })
      });
      const j = await r.json().catch(() => ({}));
      if (j.errors) {
        const msg = (j.errors[0] && j.errors[0].message) || JSON.stringify(j.errors).slice(0, 200);
        return res.json({ ok: false, message: 'Railway API error: ' + msg });
      }
      logger.info('api.prompts.deploy_triggered', { via: 'graphql' });
      return res.json({ ok: true, message: 'Deploy triggered via Railway API. New container live in 30-60 seconds.' });
    } catch (err) {
      logger.error('api.prompts.deploy_graphql_fail', { message: err.message });
      return res.json({ ok: false, message: 'Deploy failed: ' + err.message });
    }
  }

  // Path 3: nothing configured. Save already auto-redeploys (Railway watches main).
  return res.json({
    ok: false,
    message: 'No deploy token configured. Either set RAILWAY_TOKEN to a project token (Railway → Project Settings → Tokens), or just press Save above — pushing to main auto-redeploys Railway.'
  });
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

router.post('/recover-orphans', async (req, res) => {
  const minutes = parseInt(req.query.minutes || req.body?.minutes || '60', 10);
  try {
    const result = await recoverOrphanedInbound(minutes);
    res.json({ ok: true, minutes, ...result });
  } catch (err) {
    logger.error('api.recover_orphans.fail', { message: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/retry-fallbacks', async (req, res) => {
  const minutes = parseInt(req.query.minutes || req.body?.minutes || '120', 10);
  try {
    const result = await retryFallbackReplies({ maxAgeMinutes: minutes });
    res.json({ ok: true, minutes, ...result });
  } catch (err) {
    logger.error('api.retry_fallbacks.fail', { message: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/datasheets', (req, res) => {
  try {
    const includeArchived = String(req.query.archived || '') === '1';
    const sheets = datasheetsModule.listDatasheets({ includeArchived });
    res.json({ count: sheets.length, datasheets: sheets });
  } catch (err) {
    logger.error('api.datasheets.list.fail', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post('/datasheets', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const label = String(req.body?.label || '').trim();
    const keywords = String(req.body?.keywords || '').trim();
    const filename = String(req.body?.filename || '').trim();
    const mimeType = String(req.body?.mime_type || '').trim();
    const base64 = String(req.body?.base64 || '');
    if (!label) return res.status(400).json({ error: 'label required' });
    if (!filename) return res.status(400).json({ error: 'filename required' });
    if (!mimeType) return res.status(400).json({ error: 'mime_type required' });
    if (!base64) return res.status(400).json({ error: 'base64 file content required' });
    const id = datasheetsModule.addDatasheet({ label, keywords, filename, base64, mimeType });
    res.json({ ok: true, id });
  } catch (err) {
    logger.warn('api.datasheets.add.fail', { message: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.post('/datasheets/:id', (req, res) => {
  try {
    const id = parseInt32(req.params.id, 0);
    const updated = datasheetsModule.updateDatasheet(id, req.body || {});
    res.json({ ok: true, datasheet: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/datasheets/:id', (req, res) => {
  try {
    const id = parseInt32(req.params.id, 0);
    const hard = String(req.query.hard || '') === '1';
    const ok = datasheetsModule.deleteDatasheet(id, { hard });
    res.json({ ok });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/datasheets/:id/download', (req, res) => {
  try {
    const id = parseInt32(req.params.id, 0);
    const sheet = datasheetsModule.getDatasheetById(id);
    if (!sheet) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', sheet.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + sheet.filename.replace(/"/g, '') + '"');
    require('fs').createReadStream(sheet.file_path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
