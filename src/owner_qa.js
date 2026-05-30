const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');

const MODEL = process.env.MODEL_OWNER_QA || 'claude-opus-4-7';
const promptStore = require('./prompt_store');

const AnthropicCtor = Anthropic.Anthropic || Anthropic.default || Anthropic;
let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isoMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function buildOwnerSnapshot(ownerContactId) {
  const db = getDb();
  const todayStart = startOfTodayIso();
  const nowIso = new Date().toISOString();
  const dayAgo = isoMinus(24 * 60 * 60 * 1000);

  const inboundToday = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND timestamp >= ? AND timestamp < ?`
  ).get(todayStart, nowIso).n;
  const outboundToday = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND timestamp >= ? AND timestamp < ?`
  ).get(todayStart, nowIso).n;
  const newContactsToday = db.prepare(
    `SELECT COUNT(*) AS n FROM contacts WHERE first_seen >= ?`
  ).get(todayStart).n;
  const hotLeadsToday = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'escalated' AND timestamp >= ? AND payload LIKE '%hot_lead%'`
  ).get(todayStart).n;
  const warmContacts = db.prepare(
    `SELECT COUNT(*) AS n FROM contacts WHERE lead_temperature = 'WARM' AND last_active >= ?`
  ).get(todayStart).n;
  const pendingCount = db.prepare(
    `SELECT COUNT(*) AS n FROM pending_queries WHERE status = 'pending'`
  ).get().n;
  const activeFactsCount = db.prepare(
    `SELECT COUNT(*) AS n FROM knowledge_entries WHERE status = 'active'`
  ).get().n;

  const hotLeadsRows = db.prepare(`
    SELECT e.timestamp, e.payload, c.phone, c.name, c.location
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.payload LIKE '%hot_lead%' AND e.timestamp >= ?
    ORDER BY e.timestamp DESC
    LIMIT 10
  `).all(dayAgo).map(r => ({
    time: r.timestamp,
    name: r.name || 'unknown',
    phone: r.phone,
    location: r.location || null,
    intent: safeIntentFromPayload(r.payload)
  }));

  const pendingRows = db.prepare(`
    SELECT pq.id, pq.created_at, pq.customer_message_text, pq.classifier_intent, c.phone, c.name
    FROM pending_queries pq
    LEFT JOIN contacts c ON c.id = pq.contact_id
    WHERE pq.status = 'pending'
    ORDER BY pq.created_at ASC
    LIMIT 10
  `).all().map(r => ({
    queryId: r.id,
    time: r.created_at,
    name: r.name || 'unknown',
    phone: r.phone,
    customer_message: (r.customer_message_text || '').slice(0, 200),
    intent: r.classifier_intent
  }));

  const recentContactsRows = db.prepare(`
    SELECT phone, name, category, lead_temperature, client_type, location, last_active
    FROM contacts
    WHERE last_active >= ?
    ORDER BY last_active DESC
    LIMIT 20
  `).all(dayAgo);

  const recentEscalationsRows = db.prepare(`
    SELECT e.timestamp, e.payload, c.phone, c.name
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.timestamp >= ?
    ORDER BY e.timestamp DESC
    LIMIT 15
  `).all(dayAgo).map(r => ({
    time: r.timestamp,
    name: r.name || 'unknown',
    phone: r.phone,
    type: r.payload && r.payload.includes('hot_lead') ? 'hot_lead' : 'silent_query',
    intent: safeIntentFromPayload(r.payload)
  }));

  let ownerChat = [];
  if (ownerContactId) {
    ownerChat = db.prepare(`
      SELECT m.direction, m.body, m.intent, m.timestamp
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.contact_id = ?
      ORDER BY m.id DESC
      LIMIT 30
    `).all(ownerContactId).reverse().map(r => ({
      from: r.direction === 'inbound' ? 'owner' : 'sunny',
      text: r.body,
      intent: r.intent,
      time: r.timestamp
    }));
  }

  return {
    today: {
      date: todayStart.slice(0, 10),
      inbound: inboundToday,
      outbound: outboundToday,
      new_contacts: newContactsToday,
      hot_leads: hotLeadsToday,
      warm_contacts_active: warmContacts,
      pending_queries: pendingCount,
      active_facts_in_memory: activeFactsCount
    },
    hot_leads: hotLeadsRows,
    pending_queries: pendingRows,
    recent_contacts: recentContactsRows,
    recent_escalations: recentEscalationsRows,
    owner_chat: ownerChat
  };
}

function safeIntentFromPayload(payload) {
  if (!payload) return null;
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return p.intent || null;
  } catch { return null; }
}

async function answerOwnerQuestion(ownerContactId, question) {
  if (isOverBudget()) {
    return "I'm pausing replies for the rest of the day to stay on budget. Try again tomorrow, or check the admin dashboard.";
  }

  const snapshot = buildOwnerSnapshot(ownerContactId);
  const userBlock = `Snapshot of today's data and recent activity (JSON):\n\n${JSON.stringify(snapshot, null, 2)}\n\nOwner's question:\n${question}\n\nReply now in plain text.`;

  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 600,
      system: [{ type: 'text', text: promptStore.get('owner_qa'), cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: userBlock }]
    });
    if (resp.usage) recordUsage(MODEL, resp.usage, 'owner_qa');
    const text = resp.content?.[0]?.text?.trim() || '';
    return text || "I have the data but no answer text came back. Try the admin dashboard for the full view.";
  } catch (err) {
    logger.error('owner_qa.error', { message: err.message });
    return "I had a hiccup pulling the data. Try again, or open the admin dashboard at https://sunny-electrosun-production.up.railway.app/admin";
  }
}

module.exports = { buildOwnerSnapshot, answerOwnerQuestion };
