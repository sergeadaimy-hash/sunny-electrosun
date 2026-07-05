const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const promptStore = require('./prompt_store');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const { formatWarehouseForPrompt } = require('./warehouse');
const { getPlaybookText } = require('./playbook');
const { getFactsText } = require('./facts');
const auditStore = require('./audit_store');
const { sendMessage, sendTemplate } = require('./whatsapp');
const { getOrCreateContact, getActiveConversation, appendMessage } = require('./memory');

const MODEL_AUDIT = process.env.MODEL_AUDIT || 'claude-sonnet-5';
const AUDIT_MAX_CONVERSATIONS = parseInt(process.env.AUDIT_MAX_CONVERSATIONS || '60', 10);
const ADMIN_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://sunny-electrosun-production.up.railway.app').replace(/\/+$/, '');

const VALID_LANES = ['skill_lesson', 'knowledge_fact', 'engineering_note'];

// Fixed taxonomy the auditor must tag every finding with (see audit.md). Merging
// by this key is what collapses the same issue across many conversations into a
// single review card. Anything outside the list normalizes to 'other'.
const RULE_KEYS = new Set([
  'proactive_price', 'price_not_quoted', 'trailing_question', 'pushy_cta',
  'used_customer_name', 'proactive_phone', 'warehouse_revealed', 'stall_language',
  'invented_fact', 'wrong_variant', 'missing_datasheet_or_photo', 'language_mismatch',
  'handoff_link_leak', 'garbled_reply', 'missing_price_fact', 'other'
]);

// finding_type values that carry no merge signal (legacy/free-text). When a
// finding's type is one of these, the merge falls back to the topic-text key.
const GENERIC_FINDING_TYPES = new Set(['', 'none', 'rule_violation', 'knowledge_not_applied', 'other']);

function normalizeRuleKey(f) {
  const raw = String((f && (f.rule_key || f.finding_type || f.type)) || '').trim().toLowerCase();
  return RULE_KEYS.has(raw) ? raw : 'other';
}

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
      // Store the fixed rule_key in finding_type so the merge can group by it.
      finding_type: normalizeRuleKey(f),
      finding_text: findingText.slice(0, 1000),
      proposed_change: proposed.slice(0, 1000),
      cited_rule: (String(f.cited_rule || '').trim().slice(0, 300)) || null,
      cited_message: (String(f.cited_message || f.quote || '').trim().slice(0, 500)) || null
    });
    if (out.length >= 3) break;
  }
  return out;
}

// --- Finding de-duplication / merge --------------------------------------
//
// The nightly run can emit 100+ findings, many of which are the SAME lesson
// seen in different conversations ("trailing question after a short answer"
// over and over). The review UI groups them so the owner reviews one merged
// card per topic, not one per occurrence. Pure + exported for tests.

function normalizeTopicKey(f) {
  const base = String(
    (f && f.edited_text && f.edited_text.trim()) || (f && f.proposed_change) || (f && f.finding_text) || ''
  );
  return base
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function groupStatus(statuses) {
  if (!statuses || !statuses.length) return 'pending';
  if (statuses.every(s => s === 'applied')) return 'applied';
  if (statuses.every(s => s === 'approved' || s === 'applied')) return 'approved';
  return 'pending';
}

// Merge findings by lane + normalized topic. Rejected findings are dropped
// (they are gone, never shown again). Returns one group object per topic, in
// lane order then first-seen order, each carrying every underlying finding id
// so an approve/reject acts on the whole merged set at once.
// The merge key: prefer the fixed rule_key (stored in finding_type) so the same
// issue across many conversations collapses into one card. Fall back to the
// normalized topic text only for legacy/generic types that carry no rule_key
// (so old runs still group sensibly instead of all under "other").
function mergeKeyFor(f) {
  const ft = String((f && f.finding_type) || '').trim().toLowerCase();
  if (ft && !GENERIC_FINDING_TYPES.has(ft)) return ft;
  return normalizeTopicKey(f);
}

function groupFindings(findings) {
  const laneOrder = { skill_lesson: 0, knowledge_fact: 1, engineering_note: 2 };
  const map = new Map();
  for (const f of findings || []) {
    if (!f || f.status === 'rejected') continue;
    const key = String(f.lane) + '||' + mergeKeyFor(f);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        lane: f.lane,
        finding_type: f.finding_type || null,
        finding_text: f.finding_text,
        proposed_change: f.proposed_change,
        edited_text: f.edited_text || null,
        cited_rule: f.cited_rule || null,
        cited_message: f.cited_message || null,
        ids: [],
        conversation_ids: [],
        _statuses: []
      };
      map.set(key, g);
    }
    g.ids.push(f.id);
    g._statuses.push(f.status);
    if (f.conversation_id && !g.conversation_ids.includes(f.conversation_id)) {
      g.conversation_ids.push(f.conversation_id);
    }
    // Prefer an already-edited representative text if any member carries one.
    if (!g.edited_text && f.edited_text) g.edited_text = f.edited_text;
  }
  const groups = Array.from(map.values()).map(g => ({
    key: g.key,
    lane: g.lane,
    finding_type: g.finding_type,
    finding_text: g.finding_text,
    proposed_change: g.proposed_change,
    edited_text: g.edited_text,
    cited_rule: g.cited_rule,
    cited_message: g.cited_message,
    ids: g.ids,
    count: g.ids.length,
    conversation_ids: g.conversation_ids,
    status: groupStatus(g._statuses)
  }));
  groups.sort((a, b) => (laneOrder[a.lane] ?? 9) - (laneOrder[b.lane] ?? 9));
  return groups;
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

// Name + language of the permanent-delivery template (templates/
// nightly_audit_ping_en.json). The template is window-independent, so the ping
// lands even when the developer line has been silent for more than 24h.
const AUDIT_PING_TEMPLATE = process.env.AUDIT_PING_TEMPLATE || 'nightly_audit_ping_en';
const AUDIT_PING_TEMPLATE_LANG = process.env.AUDIT_PING_TEMPLATE_LANG || 'en';

// Pure: the WhatsApp template BODY parameters, in the order the template
// declares them ({{1}} total, {{2}} lessons, {{3}} facts, {{4}} code notes).
// Meta rejects blank variables, so every value is a non-empty string.
function buildAuditPingTemplateComponents(counts) {
  const c = counts || {};
  const v = n => String(n == null ? 0 : n);
  return [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: v(c.total) },
        { type: 'text', text: v(c.skill_lesson) },
        { type: 'text', text: v(c.knowledge_fact) },
        { type: 'text', text: v(c.engineering_note) }
      ]
    }
  ];
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
  const facts = getFactsText();
  if (facts && !/No confirmed facts yet/.test(facts)) blocks.push({ type: 'text', text: 'Existing learned facts (already confirmed; do not re-propose these):\n\n' + facts, cache_control: { type: 'ephemeral', ttl: '1h' } });
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
    thinking: { type: 'disabled' },
    system: rulesSystemBlocks,
    messages: [{ role: 'user', content: userBlock }]
  });
  if (resp.usage) recordUsage(MODEL_AUDIT, resp.usage, 'audit');
  const text = resp.content?.find(b => b.type === 'text')?.text || '';
  return parseAuditFindings(text, { runId, conversationId: conv.conversation_id, contactId: conv.contact_id });
}

// The audit "proposals waiting" ping goes to AUDIT_PING_WHATSAPP when set
// (useful while a developer is testing the audit), otherwise to the owner.
// This keeps the owner's other alerts (escalations, reports) on OWNER_WHATSAPP.
function auditPingRecipient() {
  return process.env.AUDIT_PING_WHATSAPP || process.env.OWNER_WHATSAPP || null;
}

async function sendOwnerAuditPing(runId, counts) {
  const pingPhone = auditPingRecipient();
  if (!pingPhone) return;
  const run = auditStore.getRun(runId);
  const text = buildOwnerAuditPing(run, counts);
  if (!text) return;
  try {
    // Prefer the approved template (window-independent so the ping is not
    // silently dropped outside the 24h window). Fall back to the free-form
    // text if the template send fails, which also covers the period while the
    // template is still PENDING approval. The DB row stores the readable text
    // either way.
    let sendRes = null;
    let via = 'template';
    try {
      sendRes = await sendTemplate(
        pingPhone,
        AUDIT_PING_TEMPLATE,
        AUDIT_PING_TEMPLATE_LANG,
        buildAuditPingTemplateComponents(counts)
      );
    } catch (err) {
      sendRes = { ok: false, error: err.message };
    }
    if (!sendRes || !sendRes.ok) {
      logger.warn('audit.ping_template_failed_falling_back', {
        template: AUDIT_PING_TEMPLATE,
        error: sendRes && sendRes.error
      });
      sendRes = await sendMessage(pingPhone, text);
      via = 'free_form';
    }
    logger.info('audit.ping_sent', { via, to_tail: String(pingPhone).slice(-4), messageId: sendRes && sendRes.messageId });
    const pingContact = getOrCreateContact(pingPhone, null);
    const pingConv = getActiveConversation(pingContact.id);
    appendMessage(pingConv.id, 'outbound', text, {
      whatsapp_message_id: sendRes && sendRes.messageId,
      intent: 'audit_summary_ping',
      language: 'english'
    });
  } catch (err) {
    logger.warn('audit.ping_fail', { message: err.message });
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
  buildAuditPingTemplateComponents,
  normalizeTopicKey,
  groupFindings,
  auditPingRecipient,
  runNightlyAudit
};
