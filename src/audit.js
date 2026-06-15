const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const promptStore = require('./prompt_store');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const { formatWarehouseForPrompt } = require('./warehouse');
const { getPlaybookText } = require('./playbook');
const auditStore = require('./audit_store');
const { sendMessage } = require('./whatsapp');
const { getOrCreateContact, getActiveConversation, appendMessage } = require('./memory');

const MODEL_AUDIT = process.env.MODEL_AUDIT || 'claude-sonnet-4-6';
const AUDIT_MAX_CONVERSATIONS = parseInt(process.env.AUDIT_MAX_CONVERSATIONS || '60', 10);
const ADMIN_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://sunny-electrosun-production.up.railway.app').replace(/\/+$/, '');

const VALID_LANES = ['skill_lesson', 'knowledge_fact', 'engineering_note'];

const AnthropicCtor = Anthropic.Anthropic || Anthropic.default || Anthropic;
let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function tryParseJson(text) {
  if (!text) return null;
  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function isAuditableContact(contact, { ownerPhone, deskPhones } = {}) {
  if (!contact || !contact.phone) return false;
  const p = digitsOnly(contact.phone);
  if (!p) return false;
  if (ownerPhone && p === digitsOnly(ownerPhone)) return false;
  const desks = Array.isArray(deskPhones) ? deskPhones : [];
  for (const d of desks) {
    if (d && p === digitsOnly(d)) return false;
  }
  return true;
}

function summarizeSignals({ conversation, contact, pendingQueries, messages } = {}) {
  const open = (pendingQueries || []).filter(q => q.status === 'pending' || q.status === 'expired');
  let endedSilent = false;
  if (messages && messages.length) {
    const last = messages[messages.length - 1];
    endedSilent = !!(last && last.direction === 'outbound');
  }
  return {
    human_handled: !!(conversation && conversation.human_handled),
    open_pending_count: open.length,
    lead_temperature: (contact && contact.lead_temperature) || null,
    ended_silent: endedSilent
  };
}

function buildAuditTranscript(messages, maxChars = 6000) {
  const lines = [];
  for (const m of messages || []) {
    const who = m.direction === 'inbound' ? 'Customer' : 'Sunny';
    const body = String(m.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!body) continue;
    lines.push(`[${who}] ${body}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n(transcript truncated)';
  return out;
}

function parseAuditFindings(text, ctx = {}) {
  const parsed = tryParseJson(text);
  if (!parsed) return [];
  const arr = Array.isArray(parsed.findings) ? parsed.findings : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const lane = String(f.lane || '').trim();
    if (!VALID_LANES.includes(lane)) continue;
    const findingText = String(f.finding_text || f.problem || '').trim();
    const proposed = String(f.proposed_change || f.lesson || f.fact || '').trim();
    if (!findingText || !proposed) continue;
    out.push({
      run_id: ctx.runId || null,
      conversation_id: ctx.conversationId || null,
      contact_id: ctx.contactId || null,
      lane,
      finding_type: (String(f.finding_type || f.type || '').trim().slice(0, 60)) || null,
      finding_text: findingText.slice(0, 1000),
      proposed_change: proposed.slice(0, 1000),
      cited_rule: (String(f.cited_rule || '').trim().slice(0, 300)) || null,
      cited_message: (String(f.cited_message || f.quote || '').trim().slice(0, 500)) || null
    });
    if (out.length >= 10) break;
  }
  return out;
}

function buildOwnerAuditPing(run, counts) {
  const total = counts.total || 0;
  if (total === 0) return null;
  const link = `${ADMIN_BASE_URL}/admin#audit=${run.id}`;
  return [
    `Nightly audit done. ${total} proposal${total === 1 ? '' : 's'} waiting.`,
    `Lessons: ${counts.skill_lesson || 0}, Facts: ${counts.knowledge_fact || 0}, Code notes: ${counts.engineering_note || 0}.`,
    `Review and approve: ${link}`
  ].join('\n');
}

function deskPhonesFromEnv() {
  return [
    process.env.SALES_ABUJA_WHATSAPP,
    process.env.SALES_LAGOS_WHATSAPP,
    process.env.SPECIALIST_DIRECT_LINK
  ].filter(Boolean);
}

function selectConversationsInWindow(windowStart, windowEnd) {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT conv.id AS conversation_id, conv.contact_id, conv.human_handled,
           c.phone, c.name, c.lead_temperature
    FROM conversations conv
    JOIN messages m ON m.conversation_id = conv.id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE m.direction = 'inbound'
      AND m.timestamp >= ? AND m.timestamp < ?
    ORDER BY conv.id DESC
  `).all(windowStart, windowEnd);
}

function messagesForConversation(conversationId, limit = 60) {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, body, intent, timestamp
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(conversationId, limit);
}

function pendingQueriesForContact(contactId) {
  const db = getDb();
  return db.prepare(`SELECT id, status FROM pending_queries WHERE contact_id = ?`).all(contactId);
}

function buildRulesSystemBlocks() {
  const blocks = [
    { type: 'text', text: promptStore.get('audit'), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Sunny current rulebook (system.md):\n\n' + promptStore.get('system'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
  let wh = '';
  try { wh = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('audit.warehouse_load_fail', { message: err.message });
  }
  if (wh) blocks.push({ type: 'text', text: 'Current warehouse stock and prices:\n\n' + wh, cache_control: { type: 'ephemeral', ttl: '1h' } });
  const pb = getPlaybookText();
  if (pb) blocks.push({ type: 'text', text: 'Existing learned playbook (already approved; do not re-propose these):\n\n' + pb, cache_control: { type: 'ephemeral', ttl: '1h' } });
  return blocks;
}

async function auditOneConversation(conv, runId, rulesSystemBlocks) {
  const messages = messagesForConversation(conv.conversation_id);
  if (!messages.length) return [];
  const contact = { phone: conv.phone, name: conv.name, lead_temperature: conv.lead_temperature };
  const pending = pendingQueriesForContact(conv.contact_id);
  const signals = summarizeSignals({ conversation: conv, contact, pendingQueries: pending, messages });
  const transcript = buildAuditTranscript(messages);
  const userBlock = [
    'Audit this single conversation.',
    '',
    'Signals detected (objective):',
    `- Owner took over: ${signals.human_handled ? 'YES' : 'no'}`,
    `- Open unanswered queries: ${signals.open_pending_count}`,
    `- Lead temperature: ${signals.lead_temperature || 'unknown'}`,
    `- Ended on a Sunny message with no customer reply: ${signals.ended_silent ? 'YES' : 'no'}`,
    '',
    'Transcript:',
    transcript,
    '',
    'Return JSON now.'
  ].join('\n');

  const resp = await client().messages.create({
    model: MODEL_AUDIT,
    max_tokens: 1200,
    system: rulesSystemBlocks,
    messages: [{ role: 'user', content: userBlock }]
  });
  if (resp.usage) recordUsage(MODEL_AUDIT, resp.usage, 'audit');
  const text = resp.content?.[0]?.text || '';
  return parseAuditFindings(text, { runId, conversationId: conv.conversation_id, contactId: conv.contact_id });
}

async function sendOwnerAuditPing(runId, counts) {
  const ownerPhone = process.env.OWNER_WHATSAPP;
  if (!ownerPhone) return;
  const run = auditStore.getRun(runId);
  const text = buildOwnerAuditPing(run, counts);
  if (!text) return;
  try {
    const sendRes = await sendMessage(ownerPhone, text);
    const ownerContact = getOrCreateContact(ownerPhone, null);
    const ownerConv = getActiveConversation(ownerContact.id);
    appendMessage(ownerConv.id, 'outbound', text, {
      whatsapp_message_id: sendRes && sendRes.messageId,
      intent: 'audit_summary_ping',
      language: 'english'
    });
  } catch (err) {
    logger.warn('audit.owner_ping_fail', { message: err.message });
  }
}

async function runNightlyAudit({ windowHours = 24, nowIso } = {}) {
  const end = nowIso || new Date().toISOString();
  const start = new Date(new Date(end).getTime() - windowHours * 3600 * 1000).toISOString();
  const runDate = end.slice(0, 10);

  if (isOverBudget()) {
    logger.warn('audit.budget_exceeded_skip');
    return { skipped: true, reason: 'over_budget' };
  }

  const runId = auditStore.createRun({ runDate, windowStart: start, windowEnd: end });
  const counts = { skill_lesson: 0, knowledge_fact: 0, engineering_note: 0, total: 0 };
  let audited = 0;
  try {
    const ownerPhone = process.env.OWNER_WHATSAPP;
    const deskPhones = deskPhonesFromEnv();
    const all = selectConversationsInWindow(start, end);
    const targets = all
      .filter(conv => isAuditableContact({ phone: conv.phone }, { ownerPhone, deskPhones }))
      .slice(0, AUDIT_MAX_CONVERSATIONS);

    const rulesBlocks = buildRulesSystemBlocks();

    for (const conv of targets) {
      if (isOverBudget()) { logger.warn('audit.budget_exceeded_midrun'); break; }
      try {
        const findings = await auditOneConversation(conv, runId, rulesBlocks);
        for (const f of findings) {
          auditStore.insertFinding(f);
          counts[f.lane] = (counts[f.lane] || 0) + 1;
          counts.total += 1;
        }
      } catch (err) {
        logger.warn('audit.conversation_fail', { conversation_id: conv.conversation_id, message: err.message });
      }
      audited += 1;
    }

    auditStore.finishRun(runId, { conversationsAudited: audited, findingsCount: counts.total, scorecard: null });
    await sendOwnerAuditPing(runId, counts);
    logger.info('audit.done', { runId, audited, findings: counts.total });
    return { runId, audited, findings: counts.total, counts };
  } catch (err) {
    auditStore.failRun(runId, err.message);
    logger.error('audit.run_fail', { runId, message: err.message });
    return { runId, error: err.message };
  }
}

module.exports = {
  MODEL_AUDIT,
  VALID_LANES,
  isAuditableContact,
  summarizeSignals,
  buildAuditTranscript,
  parseAuditFindings,
  buildOwnerAuditPing,
  runNightlyAudit
};
