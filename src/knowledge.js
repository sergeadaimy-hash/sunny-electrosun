const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');

const MODEL_TEACHER = process.env.MODEL_TEACHER || 'claude-opus-4-7';
const TEACHER_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'teacher.md'), 'utf8');

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

async function extractKnowledge(ownerMessage) {
  if (isOverBudget()) {
    logger.warn('knowledge.extract.budget_exceeded');
    return { facts: [], reply_to_owner: "I'm pausing teaching mode for the rest of the day to stay on budget. Try again tomorrow." };
  }

  const today = new Date().toISOString().slice(0, 10);
  const userBlock = `Today's date: ${today}\n\nOwner's message:\n${ownerMessage}\n\nReturn JSON now.`;

  try {
    const resp = await client().messages.create({
      model: MODEL_TEACHER,
      max_tokens: 600,
      system: [{ type: 'text', text: TEACHER_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userBlock }]
    });
    if (resp.usage) recordUsage(MODEL_TEACHER, resp.usage, 'teacher');
    const text = resp.content?.[0]?.text || '';
    const parsed = tryParseJson(text);
    if (!parsed) {
      logger.warn('knowledge.extract.parse_fail', { text: text.slice(0, 200) });
      return { facts: [], reply_to_owner: "I read your message but had trouble parsing it. Could you re-phrase the key fact?" };
    }
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    const reply = parsed.reply_to_owner || 'Got it.';
    return { facts, reply_to_owner: reply };
  } catch (err) {
    logger.error('knowledge.extract.error', { message: err.message });
    return { facts: [], reply_to_owner: "I had a hiccup processing that. Try again in a moment." };
  }
}

function normaliseForDedup(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim();
}

function findDuplicateActive(text, category) {
  const db = getDb();
  const norm = normaliseForDedup(text).slice(0, 120);
  if (!norm) return null;
  const rows = db.prepare(
    `SELECT id, extracted_fact, category FROM knowledge_entries WHERE status = 'active' AND category = ?`
  ).all(category || 'other');
  for (const r of rows) {
    const rn = normaliseForDedup(r.extracted_fact).slice(0, 120);
    if (!rn) continue;
    if (rn === norm) return r;
    if (rn.length > 30 && norm.length > 30) {
      const minLen = Math.min(rn.length, norm.length);
      const a = rn.slice(0, minLen);
      const b = norm.slice(0, minLen);
      if (a === b) return r;
    }
  }
  return null;
}

function addKnowledgeEntry({ sourceMessage, sourceMessageId, extractedFact, category, confidence, status = 'active', skipDedup = false }) {
  const db = getDb();
  if (!skipDedup && status === 'active') {
    const dup = findDuplicateActive(extractedFact, category);
    if (dup) return dup.id;
  }
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO knowledge_entries
       (source_message, source_message_id, extracted_fact, category, confidence, status, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sourceMessage,
    sourceMessageId || null,
    extractedFact,
    category || 'other',
    typeof confidence === 'number' ? confidence : null,
    status,
    ts,
    status === 'active' ? ts : null
  );
  return info.lastInsertRowid;
}

function getActiveKnowledge(limit = 200) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM knowledge_entries
     WHERE status = 'active'
     ORDER BY id DESC
     LIMIT ?`
  ).all(limit);
}

function listKnowledge(filter = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  if (filter.category) { where.push('category = ?'); params.push(filter.category); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(
    `SELECT * FROM knowledge_entries ${whereSql} ORDER BY id DESC LIMIT 500`
  ).all(...params);
}

function setKnowledgeStatus(id, status) {
  const db = getDb();
  const ts = new Date().toISOString();
  if (status === 'active') {
    db.prepare(
      `UPDATE knowledge_entries SET status = ?, approved_at = ?, rejected_at = NULL WHERE id = ?`
    ).run(status, ts, id);
  } else if (status === 'rejected') {
    db.prepare(
      `UPDATE knowledge_entries SET status = ?, rejected_at = ? WHERE id = ?`
    ).run(status, ts, id);
  } else {
    db.prepare(`UPDATE knowledge_entries SET status = ? WHERE id = ?`).run(status, id);
  }
}

function updateKnowledgeText(id, extractedFact, category) {
  const db = getDb();
  if (category) {
    db.prepare(`UPDATE knowledge_entries SET extracted_fact = ?, category = ? WHERE id = ?`)
      .run(extractedFact, category, id);
  } else {
    db.prepare(`UPDATE knowledge_entries SET extracted_fact = ? WHERE id = ?`)
      .run(extractedFact, id);
  }
}

function deleteKnowledge(id) {
  const db = getDb();
  db.prepare(`DELETE FROM knowledge_entries WHERE id = ?`).run(id);
}

const PROMPT_CHAR_BUDGET = parseInt(process.env.KNOWLEDGE_PROMPT_BUDGET_CHARS || '30000', 10);
const PROMPT_FACT_CAP = parseInt(process.env.KNOWLEDGE_PROMPT_MAX_FACTS || '500', 10);

function formatKnowledgeForPrompt() {
  const rows = getActiveKnowledge(PROMPT_FACT_CAP);
  if (!rows.length) return '';
  const byCategory = {};
  for (const r of rows) {
    const cat = r.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r.extracted_fact);
  }
  const lines = [];
  lines.push('# Owner-taught knowledge (treat as authoritative)');
  lines.push('These facts were taught to you by the Electro-Sun team or imported from past conversations. Quote them directly when relevant. They override earlier general guidance if they conflict.');
  lines.push('');
  const order = ['pricing', 'policy', 'product', 'sales', 'operations', 'warranty', 'customer', 'correction', 'other'];
  const seen = new Set();
  for (const cat of order) {
    if (!byCategory[cat]) continue;
    seen.add(cat);
    lines.push(`## ${cat.toUpperCase()}`);
    for (const f of byCategory[cat]) lines.push(`- ${f}`);
    lines.push('');
  }
  for (const cat of Object.keys(byCategory)) {
    if (seen.has(cat)) continue;
    lines.push(`## ${cat.toUpperCase()}`);
    for (const f of byCategory[cat]) lines.push(`- ${f}`);
    lines.push('');
  }
  let block = lines.join('\n').trim();
  if (block.length > PROMPT_CHAR_BUDGET) {
    block = block.slice(0, PROMPT_CHAR_BUDGET) + '\n\n[memory truncated to budget; see admin Knowledge tab for the full list]';
  }
  return block;
}

module.exports = {
  extractKnowledge,
  addKnowledgeEntry,
  getActiveKnowledge,
  listKnowledge,
  setKnowledgeStatus,
  updateKnowledgeText,
  deleteKnowledge,
  formatKnowledgeForPrompt
};
