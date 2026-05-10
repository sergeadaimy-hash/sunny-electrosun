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

function addKnowledgeEntry({ sourceMessage, sourceMessageId, extractedFact, category, confidence, status = 'active', skipDedup = false, replaceIfDuplicate = false }) {
  const db = getDb();
  if (status === 'active' && !skipDedup) {
    const dup = findDuplicateActive(extractedFact, category);
    if (dup) {
      if (!replaceIfDuplicate) return dup.id;
      const tsSup = new Date().toISOString();
      db.prepare(
        `UPDATE knowledge_entries SET status = 'superseded', rejected_at = ? WHERE id = ?`
      ).run(tsSup, dup.id);
      logger.info('knowledge.superseded', { old_id: dup.id, category: dup.category });
    }
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

const STOCK_STATUS_RE = /\b(out\s*of\s*stock|sold\s*out|in\s*stock|stock|arriving|new\s*batch|next\s*week|coming\s*soon|eta|expected|will\s*be\s*received|days|weeks|sold)\b/i;

const LEGACY_FACT_RE = /(legacy\s+conversation\s+with|past\s+customer\s*\(|past\s+q&a\s+on|\(source:\s*[^)]*20\d\d-\d\d-\d\d\s*\))/i;
function isLegacyFact(row) {
  const sm = String(row.source_message || '');
  const ef = String(row.extracted_fact || '');
  return LEGACY_FACT_RE.test(sm) || LEGACY_FACT_RE.test(ef);
}

function formatKnowledgeForPrompt() {
  const allRows = getActiveKnowledge(PROMPT_FACT_CAP);
  const rows = allRows.filter(r => !isLegacyFact(r));
  if (!rows.length) return '';

  const stockFacts = [];
  const otherByCategory = {};
  for (const r of rows) {
    const cat = r.category || 'other';
    if (STOCK_STATUS_RE.test(r.extracted_fact || '')) {
      stockFacts.push(r);
    } else {
      if (!otherByCategory[cat]) otherByCategory[cat] = [];
      otherByCategory[cat].push(r.extracted_fact);
    }
  }

  const lines = [];

  if (stockFacts.length) {
    lines.push('# CURRENT STOCK STATUS, READ THIS FIRST AND OBEY IT');
    lines.push('Every fact below is the live, authoritative state of the warehouse RIGHT NOW. It overrides the catalog block. If a customer asks about a product mentioned below, you MUST mention its current stock status in your reply. If a product below is out of stock, do NOT tell the customer it is available; do NOT invent a different ETA than the one stated. If a product below has a stated price, you MUST use that price and never make up a different one.');
    lines.push('');
    for (const f of stockFacts) {
      lines.push(`- ${f.extracted_fact}`);
    }
    lines.push('');
  }

  lines.push('# Owner-taught knowledge (treat as authoritative)');
  lines.push('These facts were taught to you by the Electro-Sun team or imported from past conversations. Quote them directly when relevant. They override earlier general guidance if they conflict.');
  lines.push('Facts inside each category are listed NEWEST FIRST. If two facts about the same product, brand, price, policy, or hours appear to conflict, the FIRST one (newest) is the truth and the older one is outdated. Use the newest one and ignore the older one.');
  lines.push('PRICE DISCIPLINE: When you quote a Naira / NGN figure, that figure MUST come from either the catalog block above or an active owner-taught fact. You are FORBIDDEN from inventing prices. If you do not have the price for the exact item the customer asked about, say "Let me check the latest figure for that one with the team" and STOP. Do not approximate, do not guess, do not interpolate.');
  lines.push('');

  const order = ['pricing', 'policy', 'product', 'sales', 'operations', 'warranty', 'customer', 'correction', 'other'];
  const seen = new Set();
  for (const cat of order) {
    if (!otherByCategory[cat]) continue;
    seen.add(cat);
    lines.push(`## ${cat.toUpperCase()}`);
    for (const f of otherByCategory[cat]) lines.push(`- ${f}`);
    lines.push('');
  }
  for (const cat of Object.keys(otherByCategory)) {
    if (seen.has(cat)) continue;
    lines.push(`## ${cat.toUpperCase()}`);
    for (const f of otherByCategory[cat]) lines.push(`- ${f}`);
    lines.push('');
  }

  let block = lines.join('\n').trim();
  if (block.length > PROMPT_CHAR_BUDGET) {
    block = block.slice(0, PROMPT_CHAR_BUDGET) + '\n\n[memory truncated to budget; see admin Knowledge tab for the full list]';
  }
  return block;
}

function findOverlapGroups() {
  const rows = getActiveKnowledge(PROMPT_FACT_CAP);
  const buckets = new Map();
  for (const r of rows) {
    const norm = normaliseForDedup(r.extracted_fact);
    if (!norm) continue;
    const words = norm.split(' ').filter(Boolean).slice(0, 8).join(' ');
    if (!words || words.length < 12) continue;
    const key = `${r.category || 'other'}::${words}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [];
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    items.sort((a, b) => (b.id || 0) - (a.id || 0));
    const [, prefix] = key.split('::');
    groups.push({
      category: items[0].category || 'other',
      prefix,
      newest_id: items[0].id,
      count: items.length,
      entries: items.map(it => ({
        id: it.id,
        extracted_fact: it.extracted_fact,
        created_at: it.created_at,
        is_newest: it.id === items[0].id
      }))
    });
  }
  groups.sort((a, b) => (b.newest_id || 0) - (a.newest_id || 0));
  return groups;
}

function rejectLegacyFacts() {
  const db = getDb();
  const ts = new Date().toISOString();
  const candidates = db.prepare(
    `SELECT id, source_message, extracted_fact, category FROM knowledge_entries
     WHERE status = 'active'
       AND (
         source_message LIKE '%legacy conversation with%' OR
         extracted_fact LIKE '%legacy conversation with%' OR
         extracted_fact LIKE '%(source: legacy%' OR
         extracted_fact LIKE '%Past customer (%' OR
         extracted_fact LIKE '%Past Q&A on%' OR
         extracted_fact LIKE '%(source: %20%5-%' OR
         extracted_fact LIKE '%(source: %20%6-%'
       )`
  ).all();
  let rejected = 0;
  const update = db.prepare(
    `UPDATE knowledge_entries SET status = 'rejected', rejected_at = ? WHERE id = ?`
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      update.run(ts, r.id);
      rejected++;
    }
  });
  tx(candidates);
  logger.info('knowledge.legacy_facts_rejected', { count: rejected });
  return {
    rejected_count: rejected,
    sample_ids: candidates.slice(0, 20).map(r => r.id)
  };
}

function getKnowledgeStats() {
  const db = getDb();
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM knowledge_entries GROUP BY status`
  ).all();
  const byStatus = {};
  for (const r of counts) byStatus[r.status] = r.n;
  const lastActive = db.prepare(
    `SELECT id, extracted_fact, category, created_at FROM knowledge_entries
     WHERE status = 'active' ORDER BY id DESC LIMIT 1`
  ).get();
  const promptBlock = formatKnowledgeForPrompt();
  return {
    by_status: byStatus,
    active_count: byStatus.active || 0,
    superseded_count: byStatus.superseded || 0,
    last_added: lastActive || null,
    prompt_block_chars: promptBlock.length,
    prompt_block_truncated: promptBlock.includes('[memory truncated to budget'),
    overlap_groups: findOverlapGroups().length
  };
}

module.exports = {
  extractKnowledge,
  addKnowledgeEntry,
  getActiveKnowledge,
  listKnowledge,
  setKnowledgeStatus,
  updateKnowledgeText,
  deleteKnowledge,
  formatKnowledgeForPrompt,
  findOverlapGroups,
  getKnowledgeStats,
  rejectLegacyFacts
};
