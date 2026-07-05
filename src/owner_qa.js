const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const ownerRouting = require('./owner_routing');

const MODEL = process.env.MODEL_OWNER_QA || 'claude-sonnet-5';
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

// Owner-facing description of how lead routing is configured (O1, 2026-06-08).
// Sunny told the owner that forwarding leads to the Abuja sales contact "would
// need to be set up" when it is already configured and active. This factual
// block goes into the Owner Q&A snapshot so the model stops guessing.
function buildRoutingSummary(recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  const deskNames = list.filter(r => r.label === 'abuja' || r.label === 'lagos').map(r => r.name);
  const hasAbuja = list.some(r => r.label === 'abuja');
  const hasLagos = list.some(r => r.label === 'lagos');
  const lines = [];
  lines.push('Lead routing IS configured and active. Never tell the owner that routing is missing or that he must configure it.');
  lines.push('How it works: when a lead escalates, Sunny forwards it automatically. Big projects go to the owners (Patrick/Charbel, alternating). Every other escalation goes to the regional sales desk by city: an Abuja lead alerts the Abuja sales line, a Lagos lead alerts the Lagos sales line. The alert reaches that desk on its own WhatsApp number (not only this owner chat).');
  lines.push('If a lead has not yet given its city, Sunny asks "Abuja or Lagos?" first, so a lead with no city has NOT been forwarded yet, that is expected.');
  lines.push('Configured sales desks: ' + (deskNames.length ? deskNames.join(', ') : 'none set yet') + '.');
  if (!hasAbuja) lines.push('NOTE: the Abuja sales number (SALES_ABUJA_WHATSAPP) is NOT set, so Abuja leads currently fall back to the owner until it is added in the admin dashboard.');
  if (!hasLagos) lines.push('NOTE: the Lagos sales number (SALES_LAGOS_WHATSAPP) is NOT set, so Lagos leads currently fall back to the owner until it is added in the admin dashboard.');
  return lines.join('\n');
}

function buildOwnerSnapshot(ownerContactId) {
  const db = getDb();
  const todayStart = startOfTodayIso();
  const nowIso = new Date().toISOString();
  const dayAgo = isoMinus(24 * 60 * 60 * 1000);

  // Team numbers (owners + sales desks) are NOT customers. Exclude them from
  // every lead / hot-lead / recent-contact figure so the owner never sees
  // himself or a colleague reported as a hot lead (bug seen 2026-06-07:
  // Charbel, an owner, was listed as a SERIOUS+HOT lead in Abuja). Built as
  // reusable SQL fragments so each query below can opt in.
  const teamDigits = ownerRouting.teamPhoneDigits();
  const teamPh = teamDigits.length ? teamDigits.map(() => '?').join(',') : null;
  // For queries on the contacts table directly (alias-free or `phone` column).
  const notTeamContact = teamPh ? ` AND phone NOT IN (${teamPh})` : '';
  // For queries that LEFT JOIN contacts AS c.
  const notTeamJoined = teamPh ? ` AND (c.phone IS NULL OR c.phone NOT IN (${teamPh}))` : '';
  // For event counts with no join: filter by contact_id via subquery.
  const notTeamEvent = teamPh ? ` AND (contact_id IS NULL OR contact_id NOT IN (SELECT id FROM contacts WHERE phone IN (${teamPh})))` : '';

  const newContactsToday = db.prepare(
    `SELECT COUNT(*) AS n FROM contacts WHERE first_seen >= ?`
  ).get(todayStart).n;
  // Distinct customers who actually messaged today (the metric the owner cares
  // about for a status update, not raw message counts). Excludes team numbers.
  const customersToday = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT c.contact_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
       WHERE m.direction = 'inbound' AND m.timestamp >= ? AND m.timestamp < ?${teamPh ? ` AND ct.phone NOT IN (${teamPh})` : ''}
     )`
  ).get(todayStart, nowIso, ...teamDigits).n;
  const hotLeadsToday = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'escalated' AND timestamp >= ? AND payload LIKE '%hot_lead%'${notTeamEvent}`
  ).get(todayStart, ...teamDigits).n;
  const warmContacts = db.prepare(
    `SELECT COUNT(*) AS n FROM contacts WHERE lead_temperature = 'WARM' AND last_active >= ?${notTeamContact}`
  ).get(todayStart, ...teamDigits).n;
  const activeFactsCount = db.prepare(
    `SELECT COUNT(*) AS n FROM knowledge_entries WHERE status = 'active'`
  ).get().n;

  const hotLeadsRows = db.prepare(`
    SELECT e.timestamp, e.payload, c.phone, c.name, c.location
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.payload LIKE '%hot_lead%' AND e.timestamp >= ?${notTeamJoined}
    ORDER BY e.timestamp DESC
    LIMIT 10
  `).all(dayAgo, ...teamDigits).map(r => ({
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
    WHERE last_active >= ?${notTeamContact}
    ORDER BY last_active DESC
    LIMIT 20
  `).all(dayAgo, ...teamDigits);

  const recentEscalationsRows = db.prepare(`
    SELECT e.timestamp, e.payload, c.phone, c.name
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.timestamp >= ?${notTeamJoined}
    ORDER BY e.timestamp DESC
    LIMIT 15
  `).all(dayAgo, ...teamDigits).map(r => ({
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
      customers_reached_out: customersToday,
      new_contacts: newContactsToday,
      hot_leads_today: hotLeadsToday,
      warm_contacts_active_today: warmContacts,
      active_facts_in_memory: activeFactsCount
      // Deliberately NOT exposed for status updates: raw inbound/outbound message
      // counts and the all-time open-pending backlog (the stale "242 since May").
      // The owner wants today's customer + hot picture, not message volume or an
      // old backlog. Raw counts/pending remain queryable from the admin.
    },
    hot_leads: hotLeadsRows,
    pending_queries: pendingRows,
    recent_contacts: recentContactsRows,
    recent_escalations: recentEscalationsRows,
    owner_chat: ownerChat,
    lead_routing: buildRoutingSummary(ownerRouting.configuredRecipients())
  };
}

function safeIntentFromPayload(payload) {
  if (!payload) return null;
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return p.intent || null;
  } catch { return null; }
}

async function answerOwnerQuestion(ownerContactId, question, opts = {}) {
  if (isOverBudget()) {
    return "I'm pausing replies for the rest of the day to stay on budget. Try again tomorrow, or check the admin dashboard.";
  }

  const snapshot = buildOwnerSnapshot(ownerContactId);
  // extraContext: a "customer in focus" block (contact details + recent
  // transcript) pre-fetched by the handler when the owner's question names a
  // specific customer. Lets the model answer in full detail instead of
  // deflecting to the admin dashboard.
  const focus = opts && opts.extraContext
    ? `\n\nCustomer in focus (details and recent transcript fetched for this question):\n${opts.extraContext}`
    : '';
  const userBlock = `Snapshot of today's data and recent activity (JSON):\n\n${JSON.stringify(snapshot, null, 2)}${focus}\n\nOwner's question:\n${question}\n\nReply now in plain text.`;

  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: promptStore.get('owner_qa'), cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: userBlock }]
    });
    if (resp.usage) recordUsage(MODEL, resp.usage, 'owner_qa');
    const text = resp.content?.find(b => b.type === 'text')?.text?.trim() || '';
    return text || "I have the data but no answer text came back. Try the admin dashboard for the full view.";
  } catch (err) {
    logger.error('owner_qa.error', { message: err.message });
    return "I had a hiccup pulling the data. Try again, or open the admin dashboard at https://sunny-electrosun-production.up.railway.app/admin";
  }
}

module.exports = { buildOwnerSnapshot, answerOwnerQuestion, buildRoutingSummary };
