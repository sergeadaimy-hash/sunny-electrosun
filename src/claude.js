const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
// knowledge facts retired 2026-05-10: rules now live entirely in src/prompts/system.md
const { formatWarehouseForPrompt, formatDatasheetKnowledgeForPrompt, listItems: listWarehouseItems } = require('./warehouse');
// datasheets retired from prompt 2026-05-10: now attached to warehouse items, looked up at send time
const security = require('./security');
const {
  validateAndFixHvBom,
  recordDropsForContact: recordHvDropsForContact,
  consumeDropsForContact: consumeHvDropsForContact,
  formatPriorDropsContext: formatHvPriorDropsContext
} = require('./hv_validator');

// Variant truth guard. Catches the recurring failure where the model asserts
// a SIZE+PHASE combo that doesn't exist in Warehouse Stock (e.g. "20kW
// single-phase is currently incoming, new shipment within 20 days" when the
// only 20kW we stock is the 3-phase SUN-20K-SG05LP3). Conservative: only
// flags when the reply combines (size, phase, stock-state) AND the combo is
// absent from the live warehouse AND the surrounding context isn't a negation
// ("we don't carry the 20kW single-phase", "stops at the 18kW", etc.).
function detectFabricatedVariant(text, contactId) {
  if (!text) return null;
  let items;
  try { items = listWarehouseItems(); }
  catch (err) {
    logger.warn('claude.reply.variant_guard_load_fail', { message: err.message });
    return null;
  }
  if (!items.length) return null;

  const sizeToPhases = new Map();
  for (const it of items) {
    const blob = [it.brand, it.model, it.notes, it.section].filter(Boolean).join(' ').toLowerCase();
    const sizes = new Set();
    const reSize = /(\d+(?:\.\d+)?)\s*k(?:w|va|wh)\b/gi;
    let mm;
    while ((mm = reSize.exec(blob)) !== null) sizes.add(mm[1]);

    const phases = new Set();
    if (/\b(single[\s-]?phase|1[\s-]?phase|1ph|1[\s-]?p\b|1\s+phase)\b/.test(blob)) phases.add('single');
    if (/\b(three[\s-]?phase|3[\s-]?phase|3ph|3[\s-]?p\b|3\s*phases?|3\s+phase)\b/.test(blob)) phases.add('three');
    if (/\bhv\b/.test(blob)) phases.add('hv');
    if (/\blv\b/.test(blob)) phases.add('lv');

    for (const s of sizes) {
      if (!sizeToPhases.has(s)) sizeToPhases.set(s, new Set());
      const set = sizeToPhases.get(s);
      for (const p of phases) set.add(p);
    }
  }

  const VARIANT_CLAIM_RE = /(\d+(?:\.\d+)?)\s*k(?:w|va|wh)\b[\s\w,-]{0,40}?\b(single[\s-]?phase|three[\s-]?phase|3[\s-]?phase|1[\s-]?phase|hv|lv)\b[\s\w,-]{0,60}?\b(is\s+(?:currently\s+)?)?(incoming|available|in\s+stock|on\s+order|out\s+of\s+stock|pre[\s-]?order|coming|new\s+shipment|currently)\b/gi;
  const flagged = [];
  let m;
  while ((m = VARIANT_CLAIM_RE.exec(text)) !== null) {
    const size = m[1];
    let phase = m[2].toLowerCase().replace(/[\s-]+/g, ' ').trim();
    if (/single|1\s*phase|1ph/.test(phase)) phase = 'single';
    else if (/three|3\s*phase|3ph/.test(phase)) phase = 'three';

    // Negation context skip: if the surrounding text is correcting / negating
    // (we don't carry, stops at, only in, three-phase only, etc.), allow it.
    const beforeStart = Math.max(0, m.index - 100);
    const context = text.slice(beforeStart, m.index + m[0].length).toLowerCase();
    if (/(don'?t\s+(have|carry|stock|sell)|doesn'?t\s+(have|carry|stock|sell|exist)|don'?t\s+have\s+a|do\s+not\s+(have|carry|stock|sell)|no\s+\d+\s*k|not\s+in\s+(stock|our|the|current)|isn'?t\s+(in|available)|not\s+available|stops?\s+at|only\s+(in\s+|comes\s+in\s+|available\s+in\s+)?(three|3|single|1|hv|lv)|three[\s-]?phase\s+only|hv\s+only|lv\s+only|3[\s-]?phase\s+only|single[\s-]?phase\s+only|1[\s-]?phase\s+only|currently\s+(out|don'?t)|we\s+don'?t|range\s+stops|lineup\s+stops|you'?re\s+right)/.test(context)) continue;

    const phaseSet = sizeToPhases.get(size);
    if (!phaseSet || !phaseSet.has(phase)) {
      flagged.push({ size, phase, match: m[0].slice(0, 120) });
    }
  }

  return flagged.length ? flagged : null;
}

const MODEL_CLASSIFIER = process.env.MODEL_CLASSIFIER || 'claude-opus-4-7';
const MODEL_REPLY = process.env.MODEL_REPLY || 'claude-opus-4-7';

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
  category: 'COLD',
  secondary_category: null,
  lead_temperature: 'COLD',
  buyer_experience: 'unknown',
  client_type: 'unknown',
  intent: 'other',
  language: 'english',
  confidence: 0,
  needs_escalation: false,
  escalation_type: null,
  suggested_question: null,
  follow_up_in_days: null,
  lead_data: {
    name: null, location: null, use_case: null, load_estimate: null, timeline: null,
    products_asked_about: null, brand_preference: null, budget_mentioned: null,
    experience_signal: null, previous_purchase: null
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
    { type: 'text', text: promptStore.get('classifier'), cache_control: { type: 'ephemeral' } }
  ];
  let warehouseSnap = '';
  try { warehouseSnap = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('claude.classify.warehouse_load_fail', { message: err.message });
  }
  if (warehouseSnap) {
    classifierSystem.push({ type: 'text', text: warehouseSnap, cache_control: { type: 'ephemeral' } });
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
  // Internal "[Datasheet sent: ...]" markers are DB-only labels; they should
  // never reach the model as if they were Sunny's words. If we leak them into
  // history, Opus pattern-matches and parrots them back to the next customer
  // who asks for a datasheet (sending the bracket label as a plain text
  // message instead of a PDF). Replace the entire content if it's just the
  // marker; strip the marker line otherwise.
  if (/^\s*\[Datasheet sent:[^\]]+\]\s*$/i.test(cleaned)) {
    cleaned = '[earlier datasheet was attached for this customer]';
  } else {
    cleaned = cleaned.replace(/^\s*\[Datasheet sent:[^\]]+\]\s*\n?/gim, '').trim();
  }
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
    { type: 'text', text: promptStore.get('system'), cache_control: { type: 'ephemeral' } }
  ];
  let warehouseBlock = '';
  try { warehouseBlock = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('claude.reply.warehouse_load_fail', { message: err.message });
  }
  if (warehouseBlock) {
    systemBlocks.push({ type: 'text', text: warehouseBlock, cache_control: { type: 'ephemeral' } });
  }
  if (!isCasualGreeting) {
    let datasheetBlock = '';
    try { datasheetBlock = formatDatasheetKnowledgeForPrompt(message, history); }
    catch (err) {
      logger.warn('claude.reply.datasheet_block_fail', { message: err.message });
    }
    if (datasheetBlock) {
      systemBlocks.push({ type: 'text', text: datasheetBlock });
      logger.info('claude.reply.datasheet_block_injected', {
        contactId: contact?.id,
        block_chars: datasheetBlock.length
      });
    }
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

  if (expertContext && !isCasualGreeting) {
    systemBlocks.push({ type: 'text', text: expertContext });
    logger.info('claude.reply.expert_context_injected', {
      contactId: contact?.id,
      context_chars: expertContext.length
    });
  } else if (expertContext && isCasualGreeting) {
    logger.info('claude.reply.expert_context_suppressed_for_greeting', {
      contactId: contact?.id
    });
  }

  if (contact?.id && !isCasualGreeting) {
    try {
      const priorDrops = consumeHvDropsForContact(contact.id);
      if (priorDrops && priorDrops.length) {
        const dropsBlock = formatHvPriorDropsContext(priorDrops);
        if (dropsBlock) {
          systemBlocks.push({ type: 'text', text: dropsBlock });
          logger.info('claude.reply.hv_prior_drops_injected', {
            contactId: contact.id,
            drop_count: priorDrops.length,
            reasons: priorDrops.map(d => d.reason)
          });
        }
      }
    } catch (err) {
      logger.warn('claude.reply.hv_prior_drops_inject_fail', { message: err.message });
    }
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
      max_tokens: 600,
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
          content: `${lastUserText}\n\n[System note: previous attempt censored numbers with asterisks. Give the ACTUAL figures from the warehouse stock block. The customer is explicitly asking for totals; this IS a price ask. Compute and write the real numbers.]`
        };
        const retry = await client().messages.create({
          model: MODEL_REPLY,
          max_tokens: 600,
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

    const PRICE_ASK_RE = /\b(how\s+much|prices?|pricing|costs?|naira|ngn|quotations?|quotes?|rates?|totals?|sum|altogether|all\s+together|grand\s+total|in\s+total|final\s+amount|invoices?|proformas?|how\s+many\s+naira|configure|configuration|sizing|recommend(ation)?|complete\s+system|full\s+system|required|bundle|kit|boq|bom|estimate|estimation|spec(s|ification)?s?)\b/i;
    const currentAsked = PRICE_ASK_RE.test(String(message || ''));
    let priorAsked = false;
    if (Array.isArray(history)) {
      const lastSixUser = history.filter(m => m && m.role === 'user').slice(-6);
      priorAsked = lastSixUser.some(m => PRICE_ASK_RE.test(String(m.content || '')));
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
          `SELECT body FROM messages WHERE direction = 'outbound' AND conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
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

    // Trailing-question guard, loosened 2026-05-10: only strip when the customer
    // sent a PURE acknowledgement ("ok", "noted", emoji-only) and Sunny is piling
    // on another question. Factual answers like "30kwh" or "Lagos" are allowed
    // to receive a natural follow-up question. 2026-05-11: gratitude messages
    // ("thank you", "thanks") are explicitly NOT pure acks for this purpose;
    // the gratitude expert context wants Sunny to ask "anything else I can help
    // with?", which is the right warm close. Skip the strip when the handler
    // signaled allowTrailingQuestion (gratitude flow).
    if (text && !options.allowTrailingQuestion) {
      const customerMsg = String(message || '').trim();
      const PURE_ACK_RE = /^(o+k+(ay|ey|wy)?|alright|noted|got\s*it|sure|fine|cool|nice|no\s*problem|np|👍|✅|done|gotcha|sounds\s*good|sg|👌|🆗|all\s*good|yep|yup|y(ea+|ah+))[\s.!?,]*$/i;
      const customerIsPureAck = customerMsg.length > 0 && PURE_ACK_RE.test(customerMsg);
      const replyEndsWithQuestion = /\?\s*$/.test(text);
      if (customerIsPureAck && replyEndsWithQuestion) {
        const sentences = text.split(/(?<=[.!])\s+/);
        const nonQuestionSentences = sentences.filter(s => !/\?\s*$/.test(s));
        if (nonQuestionSentences.length > 0) {
          const stripped = nonQuestionSentences.join(' ').trim();
          logger.warn('claude.reply.trailing_question_stripped', {
            contactId: contact?.id,
            customer_msg: customerMsg.slice(0, 80),
            reason: 'pure_ack_received',
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
          `SELECT body FROM messages WHERE direction = 'outbound' AND conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
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

    if (text) {
      const fabricatedVariants = detectFabricatedVariant(text, contact?.id);
      if (fabricatedVariants) {
        logger.warn('claude.reply.fabricated_variant_blocked', {
          contactId: contact?.id,
          fabricated: fabricatedVariants,
          original_reply: text.slice(0, 400)
        });
        text = "Let me confirm the exact availability of that configuration with the team and get back to you shortly.";
      }
    }

    // HV BOM math validator. Catches the failure modes the prompt cannot
    // reliably prevent (BOS-B clusters below the 7-module floor, more
    // clusters than the minimum needed, uneven splits). Invalid options are
    // silently dropped from the reply; if every option fails, the reply
    // falls back to a deflection so the customer never sees broken math.
    if (text) {
      const hv = validateAndFixHvBom(text);
      if (hv.changed) {
        if (hv.droppedAll) {
          logger.warn('claude.reply.hv_bom_all_options_invalid', {
            contactId: contact?.id,
            drops: hv.drops,
            original_reply: text.slice(0, 800)
          });
          text = "Let me confirm the exact configuration with the team and send you the options shortly.";
        } else {
          logger.warn('claude.reply.hv_bom_options_dropped', {
            contactId: contact?.id,
            drops: hv.drops,
            survivors: hv.survivors,
            original_reply: text.slice(0, 800),
            fixed_reply: hv.text.slice(0, 800)
          });
          text = hv.text;
        }
        if (contact?.id && Array.isArray(hv.drops) && hv.drops.length) {
          try { recordHvDropsForContact(contact.id, hv.drops); }
          catch (err) {
            logger.warn('claude.reply.hv_drops_record_fail', { message: err.message });
          }
        }
      }
    }

    // Defense: the internal "[Datasheet sent: ...]" marker is a DB-only label,
    // never sent to customers as text. If Opus generated one anyway (because
    // it leaked into history before the scrubber learned to strip it), block.
    if (text && /\[Datasheet\s+sent:[^\]]+\]/i.test(text)) {
      logger.warn('claude.reply.datasheet_marker_in_output_blocked', {
        contactId: contact?.id,
        original_reply: text.slice(0, 300)
      });
      text = "We don't have that specific datasheet on file. The team will share it shortly.";
    }

    // No-double-dashes guard. The owner banned em-dash, en-dash, and ASCII
    // "--" everywhere (permanent rule, 2026-04-26). The prompt repeats it but
    // the model still emits them, especially in BOM headers ("Option 1 — BOS-A")
    // and number ranges ("13–14kW"). Run AFTER the HV validator so its option
    // header regex (which expects em-dash) still matches.
    if (text) {
      const before = text;
      let cleaned = text
        // BOM option headers read best with a colon: "Option 1: BOS-B" beats
        // "Option 1, BOS-B". Special-case BEFORE the generic em/en-dash rule.
        .replace(/(\*{0,2}\s*Option\s+\d+)\s*[—–]\s*(BOS-[ABG])/gi, '$1: $2')
        // En-dash between digits is a number range, keep as single hyphen
        .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
        // Em-dash with surrounding spaces becomes ", "
        .replace(/\s*—\s*/g, ', ')
        // Bare em-dash (no spaces) becomes ","
        .replace(/—/g, ',')
        // En-dash with surrounding spaces becomes ", "
        .replace(/\s*–\s*/g, ', ')
        // Bare en-dash becomes "-"
        .replace(/–/g, '-')
        // ASCII double-dash with surrounding spaces becomes ", "
        .replace(/\s*--\s*/g, ', ')
        // Bare ASCII double-dash becomes "-"
        .replace(/--/g, '-')
        // Cleanup: collapse repeated commas, spaces, and stray comma-before-punct
        .replace(/,(\s*,)+/g, ',')
        .replace(/\s{2,}/g, ' ')
        .replace(/,\s*([.?!:;])/g, '$1')
        .replace(/\s+,/g, ',');
      if (cleaned !== before) {
        logger.warn('claude.reply.dashes_stripped', {
          contactId: contact?.id,
          em_count: (before.match(/—/g) || []).length,
          en_count: (before.match(/–/g) || []).length,
          dd_count: (before.match(/--/g) || []).length
        });
        text = cleaned;
      }
    }

    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    logger.error('claude.reply.error', { message: err.message });
    return { ok: false, text: null, error: err.message };
  }
}

module.exports = { classify, generateReply };
