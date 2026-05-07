const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const { formatKnowledgeForPrompt } = require('./knowledge');
const { formatCatalogForPrompt } = require('./catalog');
const security = require('./security');

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
  needs_escalation: false,
  escalation_type: null,
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

function buildConversationState(history, currentMessage) {
  if (!Array.isArray(history) || history.length === 0) return null;

  const customerTurns = history.filter(m => m.role === 'user').map(m => String(m.content || ''));
  const sunnyTurns = history.filter(m => m.role === 'assistant').map(m => String(m.content || ''));

  const allCustomer = (customerTurns.join(' ') + ' ' + (currentMessage || '')).toLowerCase();
  const allSunny = sunnyTurns.join(' ').toLowerCase();

  const facts = [];

  const sizeMatches = allCustomer.match(/\b(\d{1,4})\s*(?:kw|kva|kilowatt)\b/gi) || [];
  if (sizeMatches.length) facts.push(`System size mentioned: ${[...new Set(sizeMatches.map(m => m.replace(/\s+/g, '')))].join(', ')}`);

  const kwhMatches = allCustomer.match(/\b(\d{1,4})\s*(?:kwh|kw\.h|kilowatt[-\s]?hour)\b/gi) || [];
  if (kwhMatches.length) facts.push(`Battery / energy mentioned: ${[...new Set(kwhMatches.map(m => m.replace(/\s+/g, '')))].join(', ')}`);

  const phaseMatch = /\b(single[\s-]?phase|three[\s-]?phase|3[\s-]?phase|1[\s-]?phase|3\s*phases?|3phases?)\b/i.exec(allCustomer);
  if (phaseMatch) facts.push(`Phase: ${phaseMatch[0].includes('1') || phaseMatch[0].toLowerCase().includes('single') ? 'single phase' : 'three phase'}`);

  const brandMatches = allCustomer.match(/\b(deye|sungrow|jinko|ja\s*solar|longi|huawei|pylontech|byd|tesla|fronius)\b/gi) || [];
  if (brandMatches.length) facts.push(`Brand mentioned: ${[...new Set(brandMatches.map(b => b.toLowerCase()))].join(', ')}`);

  const projectKeywords = /\b(hotel|factory|residential|home|house|business|office|shop|school|hospital|government|estate|building|warehouse|plant)\b/i;
  const projectMatch = projectKeywords.exec(allCustomer);
  if (projectMatch) facts.push(`Project type: ${projectMatch[0].toLowerCase()}`);

  const locKeywords = /\b(lagos|abuja|kano|ibadan|port harcourt|onitsha|enugu|kaduna|jos|benin city)\b/i;
  const locMatch = locKeywords.exec(allCustomer);
  if (locMatch) facts.push(`Location: ${locMatch[0]}`);

  const installerSignal = /\b(installer|reseller|dealer|wholesale|my client|my customer|the project|installation team)\b/i.test(allCustomer);
  const enduserSignal = /\b(my home|my house|for me|my own|my family|i live)\b/i.test(allCustomer);
  if (installerSignal) facts.push('Customer signal: installer');
  else if (enduserSignal) facts.push('Customer signal: end-user');

  const askedAlready = [];
  if (/are you (an? )?installer|installer or end[\s-]?user/i.test(allSunny)) askedAlready.push('installer-or-end-user');
  if (/single or three phase|how many phases/i.test(allSunny)) askedAlready.push('single-or-three-phase');
  if (/where (in nigeria|will|are you)|location|lagos or abuja/i.test(allSunny)) askedAlready.push('location');
  if (/how many (panels|batter|inverter|kw|kwh)|what.* daily kwh|appliances/i.test(allSunny)) askedAlready.push('load-or-quantity');
  if (/budget|how much (do|are) you/i.test(allSunny)) askedAlready.push('budget');
  if (/timeline|when (do you need|do you want|are you planning)/i.test(allSunny)) askedAlready.push('timeline');

  const customerOpenAsks = [];
  const lastCustomer = currentMessage || customerTurns[customerTurns.length - 1] || '';
  const sentences = String(lastCustomer).split(/[.!?\n]+/).filter(s => s.trim().length > 0);
  for (const s of sentences) {
    if (/\?$/.test(s.trim()) || /^\s*(can|could|do|does|is|are|will|would|should|how|what|when|where|why|which|who)\b/i.test(s.trim())) {
      customerOpenAsks.push(s.trim().slice(0, 120));
    }
  }

  const lines = [];
  if (facts.length) {
    lines.push('Facts the customer has shared:');
    for (const f of facts) lines.push(`  - ${f}`);
  }
  if (askedAlready.length) {
    lines.push('You have ALREADY asked the customer:');
    for (const a of askedAlready) lines.push(`  - ${a} (do NOT re-ask)`);
  }
  if (customerOpenAsks.length) {
    lines.push('Customer asks/questions to address in your reply:');
    for (const q of customerOpenAsks) lines.push(`  - "${q}"`);
  }

  if (!lines.length) return null;
  return '# Conversation state (computed from history; treat as authoritative)\n' + lines.join('\n') +
    '\n\nUSE THIS STATE: do not re-ask facts the customer already shared. Do not re-ask questions you have already asked. Address every customer ask listed above in your reply (combine into one short reply).';
}

async function generateReply(history, message, contact, attachments = [], options = {}) {
  if (isOverBudget()) {
    logger.warn('claude.reply.budget_exceeded');
    return { ok: false, text: null, error: 'budget_exceeded' };
  }

  const isCasualGreeting = isGreetingMsg(message);
  const expertContext = typeof options.expertContext === 'string' ? options.expertContext.trim() : '';

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

  if (!isCasualGreeting) {
    const stateBlock = buildConversationState(history, message);
    if (stateBlock) {
      systemBlocks.push({ type: 'text', text: stateBlock });
      logger.info('claude.reply.state_injected', {
        contactId: contact?.id,
        state_chars: stateBlock.length
      });
    }
  }

  if (expertContext) {
    systemBlocks.push({ type: 'text', text: expertContext });
    logger.info('claude.reply.expert_context_injected', {
      contactId: contact?.id,
      context_chars: expertContext.length
    });
  }

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
      max_tokens: 220,
      system: systemBlocks,
      messages
    }), 'generateReply');

    if (resp.usage) recordUsage(MODEL_REPLY, resp.usage, 'reply');
    let text = resp.content?.find(b => b.type === 'text')?.text?.trim() || '';

    if (text && /=\s*\*{3,}|\*{4,}\b/.test(text)) {
      logger.warn('claude.reply.censored_with_asterisks_detected', {
        contactId: contact?.id,
        original_reply: text.slice(0, 200)
      });
      try {
        const retryMessages = [...messages];
        const lastIdx = retryMessages.length - 1;
        const lastUser = retryMessages[lastIdx];
        const lastUserText = typeof lastUser.content === 'string' ? lastUser.content : message;
        retryMessages[lastIdx] = {
          role: 'user',
          content: `${lastUserText}\n\n[System note: previous attempt censored numbers with asterisks. Give the ACTUAL figures from the catalog. The customer is explicitly asking for totals; this IS a price ask. Compute and write the real numbers.]`
        };
        const retry = await client().messages.create({
          model: MODEL_REPLY,
          max_tokens: 220,
          system: systemBlocks,
          messages: retryMessages
        });
        if (retry.usage) recordUsage(MODEL_REPLY, retry.usage, 'reply_retry');
        const retryText = retry.content?.find(b => b.type === 'text')?.text?.trim() || '';
        if (retryText && !/=\s*\*{3,}|\*{4,}\b/.test(retryText)) {
          text = retryText;
          logger.info('claude.reply.retry_succeeded', { contactId: contact?.id, chars: text.length });
        }
      } catch (err) {
        logger.warn('claude.reply.retry_fail', { message: err.message });
      }
    }

    const PRICE_ASK_RE = /\b(how\s+much|prices?|pricing|costs?|naira|ngn|quotations?|quotes?|rates?|totals?|sum|altogether|all\s+together|grand\s+total|in\s+total|final\s+amount|invoices?|proformas?|how\s+many\s+naira)\b/i;
    const currentAsked = PRICE_ASK_RE.test(String(message || ''));
    let priorAsked = false;
    if (Array.isArray(history)) {
      const lastTwoUser = history.filter(m => m && m.role === 'user').slice(-2);
      priorAsked = lastTwoUser.some(m => PRICE_ASK_RE.test(String(m.content || '')));
    }
    const customerAskedPrice = currentAsked || priorAsked;
    if (text && !customerAskedPrice) {
      const priceRegex = /\s*(?:[(–—-]\s*)?\b\d+(?:[.,]\d+)?\s*(?:M|m|k|K)?\s*NGN\b[)]?|\s*(?:[(–—-]\s*)?\b\d+(?:[.,]\d+)?\s*[Mm]\b[)]?|\s*\(\s*\d+(?:[.,]\d+)?\s*[kK]\s*\)|\s*\(\s*\d+(?:[.,]\d+)?\s*[Mm]\s*\)/g;
      const priceMatches = text.match(priceRegex) || [];
      if (priceMatches.length >= 1) {
        const stripped = text.replace(priceRegex, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
        const hasDanglingLabel = /:\s*[.,;!?]/.test(stripped);
        logger.warn('claude.reply.prices_stripped', {
          contactId: contact?.id,
          customer_msg: String(message || '').slice(0, 100),
          original_reply: text.slice(0, 200),
          stripped_reply: stripped.slice(0, 200),
          price_matches: priceMatches.length,
          dangling_label: hasDanglingLabel
        });
        text = (!stripped || hasDanglingLabel)
          ? "Could you share more about your project so I can guide you better?"
          : stripped;
      }
    }

    if (contact?.id && text) {
      try {
        const { getDb } = require('../db/init');
        const db = getDb();
        const lastOutbound = db.prepare(
          `SELECT body FROM messages WHERE contact_id IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
           ORDER BY id DESC LIMIT 1`
        ).get(contact.id);
        if (lastOutbound && typeof lastOutbound.body === 'string') {
          const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
          if (norm(lastOutbound.body) === norm(text)) {
            logger.warn('claude.reply.duplicate_blocked', {
              contactId: contact.id,
              repeated_text: text.slice(0, 200)
            });
            text = "Apologies, let me re-read your last message. Could you clarify what specifically you need?";
          }
        }
      } catch (err) {
        logger.warn('claude.reply.dup_check_fail', { message: err.message });
      }
    }

    if (text) {
      const customerMsg = String(message || '').trim();
      const customerIsShortFactual = customerMsg.length > 0 && customerMsg.length <= 40 && !customerMsg.includes('?');
      const replyEndsWithQuestion = /\?\s*$/.test(text);
      if (customerIsShortFactual && replyEndsWithQuestion) {
        const sentences = text.split(/(?<=[.!])\s+/);
        const nonQuestionSentences = sentences.filter(s => !/\?\s*$/.test(s));
        if (nonQuestionSentences.length > 0) {
          const stripped = nonQuestionSentences.join(' ').trim();
          logger.warn('claude.reply.trailing_question_stripped', {
            contactId: contact?.id,
            customer_msg: customerMsg.slice(0, 80),
            original_reply: text.slice(0, 200),
            stripped_reply: stripped.slice(0, 200)
          });
          text = stripped;
        }
      }
    }

    if (text) {
      const leakedMarkers = security.detectPromptLeak(text);
      if (leakedMarkers) {
        security.logSecurityEvent('prompt_leak_blocked', {
          contactId: contact?.id,
          markers: leakedMarkers,
          original_reply: text.slice(0, 200)
        });
        text = "I can help with product questions, pricing, and orders. What do you need?";
      }
    }

    if (text && security.detectOwnerNumberLeak(text)) {
      security.logSecurityEvent('owner_number_leak_blocked', {
        contactId: contact?.id,
        original_reply: text.slice(0, 200)
      });
      text = "Could you tell me what you're looking for so I can help?";
    }

    if (text) {
      const phoneCount = security.countPhonePatterns(text);
      if (phoneCount >= 3) {
        security.logSecurityEvent('phone_list_dump_blocked', {
          contactId: contact?.id,
          phone_count: phoneCount,
          original_reply: text.slice(0, 200)
        });
        text = "Could you share what specifically you need so I can guide you?";
      }
    }

    if (text) {
      const CATALOG_DUMP_RE = /\b(price\s*list|all\s+(your\s+)?(prices|costs|products|models|inverters|batteries|panels|stock|items|kits)|list\s+(all|everything|your\s+(products|prices|stock))|show\s+me\s+(all|everything)|everything\s+you\s+(have|sell|stock|carry|do)|what\s+do\s+you\s+(have|sell|stock|carry)|your\s+(full\s+|whole\s+)?catalog|send\s+(me\s+)?(your\s+)?(price\s+)?list|give\s+me\s+a\s+(price\s+)?list|complete\s+list|full\s+list|all\s+the\s+(prices|costs)|(how\s+much|what(?:'s|\s+is)\s+the\s+cost|cost)\s+for\s+(everything|all|the\s+whole\s+(thing|set|setup|system|catalog)))\b/i;
      const customerWantsFullList = CATALOG_DUMP_RE.test(String(message || ''));
      const priceCount = security.countPricePatterns(text);
      if (customerWantsFullList && priceCount >= 3) {
        security.logSecurityEvent('catalog_enumeration_blocked', {
          contactId: contact?.id,
          price_count: priceCount,
          original_reply: text.slice(0, 200),
          reason: 'customer_asked_for_full_list'
        });
        text = "Could you tell me which model or system size you need? The team will quote that one.";
      }
    }

    if (contact?.id && text) {
      try {
        const { getDb } = require('../db/init');
        const db = getDb();
        const lastOutbound = db.prepare(
          `SELECT body FROM messages WHERE contact_id IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
           ORDER BY id DESC LIMIT 1`
        ).get(contact.id);
        if (lastOutbound && typeof lastOutbound.body === 'string') {
          const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
          if (norm(lastOutbound.body) === norm(text)) {
            logger.warn('claude.reply.post_override_duplicate_blocked', {
              contactId: contact.id,
              repeated_text: text.slice(0, 200)
            });
            text = "Could you clarify what specifically you need? The team will follow up with the right details.";
          }
        }
      } catch (err) {
        logger.warn('claude.reply.post_override_dup_check_fail', { message: err.message });
      }
    }

    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    logger.error('claude.reply.error', { message: err.message });
    return { ok: false, text: null, error: err.message };
  }
}

module.exports = { classify, generateReply };
