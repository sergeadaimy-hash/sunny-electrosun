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

module.exports = {
  MODEL_AUDIT,
  VALID_LANES,
  isAuditableContact,
  summarizeSignals,
  buildAuditTranscript,
  parseAuditFindings,
  buildOwnerAuditPing
};
