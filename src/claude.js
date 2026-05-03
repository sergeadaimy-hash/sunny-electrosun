const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');

const MODEL_CLASSIFIER = 'claude-haiku-4-5';
const MODEL_REPLY = 'claude-sonnet-4-6';

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
  category: 'explorer',
  intent: 'other',
  language: 'english',
  confidence: 0,
  needs_escalation: true,
  lead_data: { name: null, location: null, use_case: null, load_estimate: null, timeline: null }
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
  const userBlock = `Conversation history:\n${formatHistoryAsText(history)}\n\nLatest customer message:\n${message}\n\nReturn JSON now.`;

  const callOnce = () => withRetry(() => client().messages.create({
    model: MODEL_CLASSIFIER,
    max_tokens: 400,
    system: [{ type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userBlock }]
  }), 'classify');

  let parsed = null;
  for (let i = 0; i < 2; i++) {
    try {
      const resp = await callOnce();
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

function ensureAlternating(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n' + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function generateReply(history, message, contact) {
  const contextLines = [];
  if (contact?.name) contextLines.push(`Customer name: ${contact.name}`);
  if (contact?.location) contextLines.push(`Known location: ${contact.location}`);
  if (contact?.use_case) contextLines.push(`Use case: ${contact.use_case}`);
  if (contact?.load_estimate) contextLines.push(`Load: ${contact.load_estimate}`);
  if (contact?.timeline) contextLines.push(`Timeline: ${contact.timeline}`);
  if (contact?.category) contextLines.push(`Current category: ${contact.category}`);
  const contextBlock = contextLines.length
    ? `\n\n# Known about this customer\n${contextLines.join('\n')}`
    : '';

  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
  ];
  if (contextBlock) systemBlocks.push({ type: 'text', text: contextBlock });

  const messages = ensureAlternating([
    ...history,
    { role: 'user', content: message }
  ]);

  try {
    const resp = await withRetry(() => client().messages.create({
      model: MODEL_REPLY,
      max_tokens: 600,
      system: systemBlocks,
      messages
    }), 'generateReply');

    const text = resp.content?.find(b => b.type === 'text')?.text?.trim() || '';
    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    logger.error('claude.reply.error', { message: err.message });
    return { ok: false, text: null, error: err.message };
  }
}

module.exports = { classify, generateReply };
