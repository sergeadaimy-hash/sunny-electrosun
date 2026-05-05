const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const { formatKnowledgeForPrompt } = require('./knowledge');
const { formatCatalogForPrompt } = require('./catalog');

const MODEL_CLASSIFIER = process.env.MODEL_CLASSIFIER || 'claude-opus-4-7';
const MODEL_REPLY = process.env.MODEL_REPLY || 'claude-opus-4-7';

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8');
const CLASSIFIER_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'classifier.md'), 'utf8');


const AnthropicCtor = Anthropic.Anthropic || Anthropic.default || Anthropic;

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

async function withRetry(fn, label, maxAttempts = 3) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      const retriable = !status || status >= 500 || status === 429;
      logger.warn('claude.retry', { label, attempt, status, message: err.message, retriable });
      if (!retriable || attempt >= maxAttempts) break;
      const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

const FALLBACK_CLASSIFICATION = {
  category: 'unsorted',
  lead_temperature: 'COLD',
  client_type: 'unknown',
  intent: 'other',
  language: 'english',
  confidence: 0,
  needs_escalation: true,
  escalation_type: 'silent_query',
  lead_data: {
    name: null, location: null, use_case: null, load_estimate: null, timeline: null,
    products_asked_about: null, brand_preference: null, budget_mentioned: null
  }
};

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

function formatHistoryAsText(history) {
  if (!history || !history.length) return '(no prior messages)';
  return history.map(m => {
    const who = m.role === 'user' ? 'Customer' : 'Sunny';
    return `${who}: ${m.content}`;
  }).join('\n');
}

async function classify(history, message) {
  if (isOverBudget()) {
    logger.warn('claude.classify.budget_exceeded');
    return { ...FALLBACK_CLASSIFICATION };
  }

  const userBlock = `Conversation history:\n${formatHistoryAsText(history)}\n\nLatest customer message:\n${message}\n\nReturn JSON now.`;

  const classifierSystem = [
    { type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } }
  ];
  let catalogSnap = '';
  try { catalogSnap = formatCatalogForPrompt(); } catch (err) {
    logger.warn('claude.classify.catalog_load_fail', { message: err.message });
  }
  if (catalogSnap) {
    classifierSystem.push({ type: 'text', text: catalogSnap, cache_control: { type: 'ephemeral' } });
  }
  let knowSnap = '';
  try { knowSnap = formatKnowledgeForPrompt(); } catch (err) {
    logger.warn('claude.classify.knowledge_load_fail', { message: err.message });
  }
  if (knowSnap) {
    classifierSystem.push({ type: 'text', text: knowSnap, cache_control: { type: 'ephemeral' } });
  }

  const callOnce = () => withRetry(() => client().messages.create({
    model: MODEL_CLASSIFIER,
    max_tokens: 400,
    system: classifierSystem,
    messages: [{ role: 'user', content: userBlock }]
  }), 'classify');

  let parsed = null;
  let lastResp = null;
  for (let i = 0; i < 2; i++) {
    try {
      const resp = await callOnce();
      lastResp = resp;
      if (resp.usage) recordUsage(MODEL_CLASSIFIER, resp.usage, 'classifier');
      const text = resp.content?.[0]?.text || '';
      parsed = tryParseJson(text);
      if (parsed) break;
      logger.warn('claude.classify.parse_fail', { attempt: i + 1, text: text.slice(0, 200) });
    } catch (err) {
      logger.error('claude.classify.error', { attempt: i + 1, message: err.message });
    }
  }

  if (!parsed) {
    logger.warn('claude.classify.fallback');
    return { ...FALLBACK_CLASSIFICATION };
  }

  const out = { ...FALLBACK_CLASSIFICATION, ...parsed };
  out.lead_data = { ...FALLBACK_CLASSIFICATION.lead_data, ...(parsed.lead_data || {}) };
  if (typeof out.confidence !== 'number') out.confidence = 0;
  if (typeof out.needs_escalation !== 'boolean') {
    out.needs_escalation = out.confidence < 90;
  }
  return out;
}

const HISTORY_HOLDING_PATTERNS = [
  /^Noted\.?\s*A specialist will follow up.*$/i,
  /^A specialist will confirm the exact figure.*$/i,
  /^A specialist will be with you shortly.*$/i,
  /^Great\.?\s*One of our specialists.*$/i,
  /^Our specialist will confirm.*$/i
];

function scrubHistoryContent(text) {
  if (typeof text !== 'string') return text;
  let cleaned = text
    .replace(/https?:\/\/wa\.me\/[^\s)]+/gi, '')
    .replace(/Direct line to the specialist:?[^\n]*/gi, '')
    .replace(/If you'd like to reach our specialist directly now:?[^\n]*/gi, '')
    .replace(/For urgent matters,? direct line to the specialist:?[^\n]*/gi, '')
    .replace(/If you'd prefer to reach them directly now:?[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  for (const re of HISTORY_HOLDING_PATTERNS) {
    if (re.test(cleaned.split('\n')[0] || '')) {
      cleaned = '[earlier system holding message]';
      break;
    }
  }
  return cleaned || '[empty]';
}

function ensureAlternating(messages) {
  const out = [];
  for (const m of messages) {
    const content = m.role === 'assistant' ? scrubHistoryContent(m.content) : m.content;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n' + content;
    } else {
      out.push({ role: m.role, content });
    }
  }
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const REPLY_GREETING_RE = /^(hi+|hello+|hey+|hola|bonjour|salam|asalam|good\s+(morning|afternoon|evening|day)|gm|ga|ge|how\s+far|wetin\s+dey|sup|yo|howdy|greetings|hii?|test|testing)\b[\s!.?]*$/i;
function isGreetingMsg(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length <= 30 && REPLY_GREETING_RE.test(t);
}

async function generateReply(history, message, contact, attachments = []) {
  if (isOverBudget()) {
    logger.warn('claude.reply.budget_exceeded');
    return { ok: false, text: null, error: 'budget_exceeded' };
  }

  const isCasualGreeting = isGreetingMsg(message);

  const contextLines = [];
  if (!isCasualGreeting) {
    if (contact?.name) contextLines.push(`Customer name: ${contact.name}`);
    if (contact?.location) contextLines.push(`Known location: ${contact.location}`);
    if (contact?.use_case) contextLines.push(`Use case: ${contact.use_case}`);
    if (contact?.client_type) contextLines.push(`Client type: ${contact.client_type}`);
    if (contact?.load_estimate) contextLines.push(`Load: ${contact.load_estimate}`);
    if (contact?.timeline) contextLines.push(`Timeline: ${contact.timeline}`);
    if (contact?.category) contextLines.push(`Current category: ${contact.category}`);
    if (contact?.lead_temperature) contextLines.push(`Current temperature: ${contact.lead_temperature}`);
    if (contact?.products_asked_about) contextLines.push(`Products discussed: ${contact.products_asked_about}`);
    if (contact?.brand_preference) contextLines.push(`Brand preference: ${contact.brand_preference}`);
    if (contact?.budget_mentioned) contextLines.push(`Budget mentioned: ${contact.budget_mentioned}`);
  } else if (contact?.name) {
    contextLines.push(`Customer name: ${contact.name}`);
  }
  const contextBlock = contextLines.length
    ? `\n\n# Known about this customer\n${contextLines.join('\n')}${isCasualGreeting ? '\n(Customer just sent a casual greeting. Reply with a short greeting and a fresh qualifying opener. Do NOT bring up any prior products, prior categories, or prior context unless the customer references them.)' : ''}`
    : '';

  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
  ];
  let catalogBlock = '';
  try { catalogBlock = formatCatalogForPrompt(); } catch (err) {
    logger.warn('claude.reply.catalog_load_fail', { message: err.message });
  }
  if (catalogBlock) {
    systemBlocks.push({ type: 'text', text: catalogBlock, cache_control: { type: 'ephemeral' } });
  }
  let knowledgeBlock = '';
  try { knowledgeBlock = formatKnowledgeForPrompt(); } catch (err) {
    logger.warn('claude.reply.knowledge_load_fail', { message: err.message });
  }
  if (knowledgeBlock) {
    systemBlocks.push({ type: 'text', text: knowledgeBlock, cache_control: { type: 'ephemeral' } });
  }
  if (contextBlock) systemBlocks.push({ type: 'text', text: contextBlock });

  const effectiveHistory = isCasualGreeting ? [] : history;
  if (isCasualGreeting) {
    logger.info('claude.reply.greeting_clean_history', { contactId: contact?.id });
  }
  const messages = ensureAlternating([
    ...effectiveHistory,
    { role: 'user', content: message }
  ]);

  if (attachments && attachments.length && messages.length) {
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      const blocks = [];
      for (const a of attachments) {
        if (a.type === 'image' && a.base64 && a.mimeType) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mimeType, data: a.base64 }
          });
        }
      }
      blocks.push({ type: 'text', text: typeof last.content === 'string' ? last.content : message });
      last.content = blocks;
    }
  }

  try {
    const resp = await withRetry(() => client().messages.create({
      model: MODEL_REPLY,
      max_tokens: 180,
      system: systemBlocks,
      messages
    }), 'generateReply');

    if (resp.usage) recordUsage(MODEL_REPLY, resp.usage, 'reply');
    let text = resp.content?.find(b => b.type === 'text')?.text?.trim() || '';

    const customerAskedPrice = /\b(how\s+much|price|cost|naira|ngn|quotation|quote|rate)\b/i.test(String(message || ''));
    if (text && !customerAskedPrice) {
      const priceMatches = text.match(/\b\d+(?:[.,]\d+)?\s*(?:M|m|k|K)?\s*NGN\b|\b\d+(?:[.,]\d+)?\s*M\b/g) || [];
      if (priceMatches.length >= 2) {
        logger.warn('claude.reply.price_dump_blocked', {
          contactId: contact?.id,
          customer_msg: String(message || '').slice(0, 100),
          original_reply: text.slice(0, 200),
          price_matches: priceMatches.length
        });
        text = "What size or load are you sizing for? Single or three phase?";
      }
    }

    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    logger.error('claude.reply.error', { message: err.message });
    return { ok: false, text: null, error: err.message };
  }
}

module.exports = { classify, generateReply };
