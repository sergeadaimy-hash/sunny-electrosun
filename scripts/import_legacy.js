require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
const RUN_LLM = args.includes('--llm');
const DRY_RUN = args.includes('--dry');
const positional = args.filter(a => !a.startsWith('--'));
const SQL_PATH = positional[0] || '/Users/sergeadaimy/Downloads/localhost.sql';
const API_KEY = process.env.API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BASE = process.env.SUNNY_BASE_URL || 'https://sunny-electrosun-production.up.railway.app';
const MAX_LLM_CONVERSATIONS = parseInt(process.env.MAX_LLM_CONVERSATIONS || '80', 10);

if (!API_KEY) { console.error('API_KEY missing from .env'); process.exit(1); }
if (RUN_LLM && !ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY missing from .env'); process.exit(1); }

const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };

const AnthropicCtor = Anthropic.Anthropic || Anthropic.default || Anthropic;
const anthropic = RUN_LLM ? new AnthropicCtor({ apiKey: ANTHROPIC_KEY }) : null;

function unescapeSql(str) {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

function parseValuesRow(line) {
  const trimmed = line.trim().replace(/^\(/, '').replace(/\),?\s*;?$/, '').replace(/\)$/, '');
  const fields = [];
  let buf = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { buf += c; escape = false; continue; }
    if (c === '\\') { buf += c; escape = true; continue; }
    if (c === "'") { inStr = !inStr; buf += c; continue; }
    if (c === ',' && !inStr) {
      fields.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) fields.push(buf.trim());
  return fields.map(f => {
    if (f === 'NULL') return null;
    if (f.startsWith("'") && f.endsWith("'")) return unescapeSql(f.slice(1, -1));
    return f;
  });
}

function extractRowsForTable(sql, tableName) {
  const rows = [];
  const insertHeader = `INSERT INTO \`${tableName}\` `;
  const lines = sql.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith(insertHeader) && line.includes('VALUES')) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.startsWith('--') || line.startsWith('INSERT ')) { inBlock = false; continue; }
      if (line.trim().startsWith('(')) {
        try { rows.push(parseValuesRow(line)); } catch (err) {
          console.warn(`parse fail in ${tableName}:`, err.message, line.slice(0, 80));
        }
        if (line.trim().endsWith(';')) inBlock = false;
      }
    }
  }
  return rows;
}

function parseConversationMessages(field) {
  if (!field) return [];
  const segments = field.split(' :-: ');
  const messages = [];
  for (const seg of segments) {
    const parts = seg.split('::');
    if (parts.length < 3) continue;
    const direction = parts[0];
    const ts = parts[parts.length - 1];
    const body = parts.slice(1, -1).join('::');
    messages.push({
      role: direction === 'me' ? 'team' : 'customer',
      body,
      timestamp: ts
    });
  }
  return messages;
}

function isSubstantive(conv) {
  if (!conv.phone) return false;
  if ((conv.count || 0) < 4) return false;
  if (conv.category === 'Beginner') return false;
  return true;
}

function harvestPriceMentions(conversations) {
  const priceRefs = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(M|m|million|millions)\s*(?:NGN|Naira|naira|N|₦)?/g;
  const reK = /(\d+(?:\.\d+)?)\s*k\b/g;
  for (const conv of conversations) {
    for (const m of conv.parsedMessages) {
      if (m.role !== 'team') continue;
      const text = m.body || '';
      let match;
      while ((match = re.exec(text)) !== null) {
        const before = text.slice(Math.max(0, match.index - 50), match.index).trim();
        if (before.length > 5) priceRefs.add(`Past quote (${conv.lastDate.slice(0, 10)}): "${before}" was quoted at ${match[0]}`.replace(/\s+/g, ' ').slice(0, 240));
      }
      while ((match = reK.exec(text)) !== null) {
        const before = text.slice(Math.max(0, match.index - 50), match.index).trim();
        if (before.length > 5) priceRefs.add(`Past quote (${conv.lastDate.slice(0, 10)}): "${before}" was quoted at ${match[0]}`.replace(/\s+/g, ' ').slice(0, 240));
      }
    }
  }
  return [...priceRefs];
}

function sampleTeamReplyStyle(conversations, count = 30) {
  const examples = [];
  for (const conv of conversations) {
    for (const m of conv.parsedMessages) {
      if (m.role !== 'team') continue;
      const t = (m.body || '').trim();
      if (t.length >= 30 && t.length <= 260 && !t.startsWith('{') && !t.startsWith('[b]') && !t.startsWith('【b】')) {
        examples.push(t);
      }
    }
    if (examples.length >= count * 4) break;
  }
  examples.sort(() => Math.random() - 0.5);
  return examples.slice(0, count);
}

const LLM_PROMPT = `You are extracting durable business knowledge from a past WhatsApp sales conversation between Electro-Sun (the Nigerian solar dealer, marked "team:") and a customer ("customer:").

Return strict JSON only. No prose before or after.

{
  "facts": [
    { "category": "pricing|product|policy|sales|operations|customer", "text": "one fact in clean English, standalone, no pronouns referring outside this text", "confidence": 0-100 }
  ]
}

Rules:
- Only save facts that will help future replies (prices, products carried, policies, sales doctrine, common customer questions and how the team answered them, location patterns).
- Skip generic small talk.
- Quote prices in NGN exactly as the team said.
- Skip facts that are obvious or already in any catalog.
- Confidence < 60 means do NOT include.
- Maximum 4 facts per conversation.
- Never write em-dashes, en-dashes, or double-dashes.

Output JSON only.`;

async function llmExtract(conv) {
  const turns = conv.parsedMessages
    .map(m => (m.role === 'team' ? 'team: ' : 'customer: ') + (m.body || '').slice(0, 400))
    .join('\n');
  const userBlock = `Conversation summary on file: ${conv.factSummary || '(none)'}\n\nFull conversation:\n${turns}\n\nReturn JSON now.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: [{ type: 'text', text: LLM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userBlock }]
    });
    const text = resp.content?.[0]?.text || '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return [];
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return (parsed.facts || []).filter(f => f.text && (typeof f.confidence !== 'number' || f.confidence >= 60));
  } catch (err) {
    console.warn('  llm fail:', err.message);
    return [];
  }
}

async function postFact(text, category, source = 'legacy_import') {
  if (!text || text.length < 10) return null;
  if (DRY_RUN) {
    console.log(`  DRY [${category}] ${text.slice(0, 100)}`);
    return null;
  }
  try {
    const res = await axios.post(`${BASE}/api/knowledge`, { text, category }, { headers, timeout: 20000 });
    return res.data.id;
  } catch (err) {
    console.warn(`  POST fail [${category}]:`, err.response?.data || err.message);
    return null;
  }
}

async function main() {
  console.log(`Reading ${SQL_PATH}...`);
  const sql = fs.readFileSync(SQL_PATH, 'utf8');

  console.log('Parsing message_list...');
  const messageRows = extractRowsForTable(sql, 'message_list');
  console.log(`  ${messageRows.length} message_list rows`);

  console.log('Parsing ai_memory...');
  const aiRows = extractRowsForTable(sql, 'ai_memory');
  console.log(`  ${aiRows.length} ai_memory rows`);

  const conversations = messageRows.map(r => {
    const [sn, batch, phone, name, messages, count, lastDate, category, factSummary] = r;
    return {
      sn, batch, phone, name: name || null,
      rawMessages: messages || '',
      parsedMessages: parseConversationMessages(messages || ''),
      count: parseInt(count, 10) || 0,
      lastDate: lastDate || '',
      category: category || '',
      factSummary: factSummary || null
    };
  });

  const substantive = conversations.filter(isSubstantive);
  console.log(`  ${substantive.length} substantive conversations (skipping Beginner and short)`);

  let totalFacts = 0;

  console.log('\n=== Stage 1: ai_memory direct facts ===');
  for (const r of aiRows) {
    const [_id, scope, phone, _gid, gname, _cat, question, answer] = r;
    if (!question || !answer) continue;
    const subject = gname || phone || 'general';
    const text = `Past Q&A on ${subject}: question was "${(question || '').slice(0, 120)}"; team answer or summary: ${(answer || '').slice(0, 600)}`;
    const id = await postFact(text, 'customer');
    if (id) { totalFacts++; process.stdout.write('.'); }
  }
  console.log('');

  console.log('\n=== Stage 2: per-conversation fact_summary (top 150, deduped) ===');
  const ranked = substantive
    .filter(c => c.factSummary && c.factSummary.length > 30)
    .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
  const seenSummaries = new Set();
  const dedupedConvs = [];
  for (const conv of ranked) {
    const key = (conv.factSummary || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seenSummaries.has(key)) continue;
    seenSummaries.add(key);
    dedupedConvs.push(conv);
    if (dedupedConvs.length >= 150) break;
  }
  console.log(`  ${dedupedConvs.length} unique recent summaries (from ${ranked.length} candidates)`);
  let summaries = 0;
  for (const conv of dedupedConvs) {
    const subject = conv.name || `phone ${conv.phone}`;
    const text = `Past customer (${conv.lastDate.slice(0, 10)}, ${subject}, category ${conv.category}): ${conv.factSummary}`;
    const id = await postFact(text, 'customer');
    if (id) { totalFacts++; summaries++; if (summaries % 20 === 0) process.stdout.write(`(${summaries}) `); else process.stdout.write('.'); }
  }
  console.log(`\n  ${summaries} summaries posted`);

  console.log('\n=== Stage 3: pricing references from team replies ===');
  const priceRefs = harvestPriceMentions(substantive);
  console.log(`  ${priceRefs.length} unique pricing references found`);
  let priced = 0;
  for (const ref of priceRefs.slice(0, 80)) {
    const id = await postFact(ref, 'pricing');
    if (id) { totalFacts++; priced++; if (priced % 20 === 0) process.stdout.write(`(${priced}) `); else process.stdout.write('.'); }
  }
  console.log('');

  console.log('\n=== Stage 4: writing-style examples ===');
  const styleSamples = sampleTeamReplyStyle(substantive, 25);
  if (styleSamples.length) {
    const text = `Historical Electro-Sun team reply examples (use as a tone reference, not as authoritative current facts). The team writes short, direct, often clipped replies, sometimes with brief Pidgin or contractions. Examples:\n\n` +
      styleSamples.map((s, i) => `${i + 1}. "${s}"`).join('\n');
    const id = await postFact(text, 'sales');
    if (id) totalFacts++;
    console.log(`  posted style sample with ${styleSamples.length} examples`);
  }

  if (RUN_LLM) {
    console.log('\n=== Stage 5: LLM-extracted facts (Haiku per conversation) ===');
    const ranked = substantive
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0));
    const subset = ranked.slice(0, MAX_LLM_CONVERSATIONS);
    console.log(`  selecting top ${subset.length} most substantive conversations (by message count)`);
    let i = 0;
    for (const conv of subset) {
      i++;
      const facts = await llmExtract(conv);
      let convFacts = 0;
      for (const f of facts) {
        const text = `${f.text} (source: legacy conversation with ${conv.name || conv.phone}, ${conv.lastDate.slice(0, 10)})`;
        const id = await postFact(text, f.category || 'other');
        if (id) { totalFacts++; convFacts++; }
      }
      process.stdout.write(`[${i}/${subset.length}:${convFacts}] `);
      if (i % 25 === 0) console.log('');
    }
    console.log('');
  } else {
    console.log('\n(Skipping LLM extraction. Pass --llm to enable.)');
  }

  console.log(`\n=== Done. ${totalFacts} new facts posted. ===`);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
