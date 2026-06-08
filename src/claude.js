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

// BOM reply cleanup. Catches three recurring leaks the prompt cannot
// reliably prevent on its own:
//   (a) internal section / decision-tree references leaking to the customer
//       ("§9.0 Check 2: load is 13kW (≤ 20kW), so LV is the default")
//   (b) the model listing dropped options inline ("Option 2: SE-G6.1 Not in
//       our current stock, skipped") instead of dropping them silently
//   (c) BOM lines and Option headers glued together with no line breaks
//
// Runs after the dash-strip so option headers are already in colon form
// ("Option 1: SE-F16"). Returns the cleaned reply and a summary of what
// was touched so the caller can log it.
function cleanupBomReply(text) {
  if (!text || typeof text !== 'string') return { text, changed: false, reasons: [] };
  const before = text;
  const reasons = [];
  let out = text;

  // (a1) Strip "§9.0 Check 2: load is X (≤ Y), so LV is the default."-style
  // doctrine leaks. These come straight out of the decision tree section.
  // Match aggressively across the whole sentence.
  const docPattern1 = /§\s*9(?:\.\d+|LV(?:\.\d+)?|HV(?:\.\d+)?)?(?:\s+Check\s+\d+)?[:\s][^\n.?!]*[.?!]?/gi;
  if (docPattern1.test(out)) {
    out = out.replace(docPattern1, '');
    reasons.push('section_ref_stripped');
  }

  // (a2) "Check N:" / "Step N:" labels even without a §9 prefix.
  const checkStep = /\b(?:Check|Step)\s+\d+\s*[:.\-—–]\s*[^\n.?!]{0,160}[.?!]?/gi;
  if (checkStep.test(out)) {
    out = out.replace(checkStep, '');
    reasons.push('check_step_stripped');
  }

  // (a3) Parenthetical sizing reasoning. Catches "(≤ 20kW)", "(≤ 32 packs)",
  // "(<= 10 inverters)", "(≥ 50kWh)", AND unit-less variants the model now
  // emits like "(≤ 10 ✓)" / "(≤ 32 ✓)" / "(= 10, on the limit ✓)".
  const parenReasoning = /\s*\(\s*[≤≥<>=]+\s*\d+(?:\.\d+)?[^()]*?[✓✗]?\s*\)/gi;
  if (parenReasoning.test(out)) {
    out = out.replace(parenReasoning, '');
    reasons.push('paren_reasoning_stripped');
  }

  // (a5) Sizing math lines containing ceil(...). The model has been writing
  // "Inverters: ceil(50 ÷ 20) = 3 × SUN-20K" / "Packs SE-F16: ceil(400 ÷ 16)
  // = 25 packs" inline. Any line that contains a ceil() call IS internal
  // math, never a customer-facing fact. Drop the whole line.
  const calcLine = /^[^\n]*\bceil\s*\([^)\n]*\)[^\n]*$/gim;
  if (calcLine.test(out)) {
    out = out.replace(calcLine, '');
    reasons.push('calc_line_stripped');
  }

  // (a6) Internal-process labels. Model sometimes echoes prompt headings
  // like "**LV Pre-send checklist:**", "**Sizing logic:**", "**Floor
  // check:**", "**Inverter count:**". These are §9 doctrine markers and
  // must never reach the customer.
  const internalLabels = /\*{0,2}\s*(?:LV\s+|HV\s+)?(?:Pre[-\s]send\s+checklist|Sizing\s+logic|Pack[-\s]pool\s+check|Floor\s+check|Phase\s+check|BOM\s+emit|Inverter\s+count|Total\s+packs|Total\s+modules|Min(?:imum)?\s+clusters|Equal\s+modules\s+per\s+inverter|Tie[-\s]break)\s*:?\s*\*{0,2}\s*/gi;
  if (internalLabels.test(out)) {
    out = out.replace(internalLabels, '');
    reasons.push('internal_label_stripped');
  }

  // (a7) Meta-narration phrases the model uses to "think out loud" before
  // emitting the BOM. "Running the configuration now.", "Only SE-F16
  // survives.", "Walk through the math". Apply ALL patterns.
  const narrationPatterns = [
    /\bRunning\s+the\s+(?:configuration|sizing|math|numbers)[^\n.?!]*[.?!]?/gi,
    /\bOnly\s+(?:SE-[FG][\d.]+(?:\s*Pro)?|BOS-[ABG][A-Z0-9.-]*)\s+(?:survives|fits|passes)[^\n.?!]*[.?!]?/gi,
    /\bFor\s+each\s+(?:battery\s+)?(?:pack|series)[^\n.?!]*[.?!]?/gi,
    /\bWalk(?:ing)?\s+through\s+the\s+(?:math|sizing|configuration)[^\n.?!]*[.?!]?/gi,
    /\bLet\s+me\s+(?:compute|calculate|run)[^\n.?!]*[.?!]?/gi
  ];
  let narrationStripped = false;
  for (const re of narrationPatterns) {
    if (re.test(out)) {
      out = out.replace(re, '');
      narrationStripped = true;
    }
  }
  if (narrationStripped) reasons.push('narration_stripped');

  // (a4) "so LV is the default" / "LV is the default" / "small-app default" /
  // "decision tree" / "LV ceilings hold/break". Apply ALL patterns, not just
  // the first match (the previous `break` caused later patterns to be
  // skipped and leaks slipped through).
  const defaultPhrases = [
    /,?\s*so\s+(?:LV|HV)\s+is\s+the\s+default\.?/gi,
    /\b(?:LV|HV)\s+is\s+the\s+(?:small[-\s]app(?:lication)?\s+)?default\.?/gi,
    /\bsmall[-\s]app(?:lication)?\s+default\b/gi,
    /\bdecision\s+tree\b/gi,
    /\b(?:LV|HV)\s+ceilings?\s+(?:hold|break|fit|fail)\b[^\n.?!]*[.?!]?/gi,
    /\bload\s+is\s+\d+\s*kW[^\n.?!]*default[^\n.?!]*[.?!]?/gi
  ];
  let defaultStripped = false;
  for (const re of defaultPhrases) {
    if (re.test(out)) {
      out = out.replace(re, '');
      defaultStripped = true;
    }
  }
  if (defaultStripped) reasons.push('default_phrase_stripped');

  // (b) Strip inline "Option N: SKU (skipped / not in stock / dropped)" lines.
  // Dropped options must be invisible to the customer.
  const skippedOption = /\*{0,2}\s*Option\s+\d+:?\s*\*{0,2}\s*[A-Z][\w.-]*(?:\s+Pro)?[\s,.\-—–]{0,6}(?:Not\s+in\s+(?:our\s+)?(?:current\s+)?stock|skipped|dropped|unavailable|unviable|not\s+(?:viable|available|in\s+stock))[^\n.]*\.?/gi;
  if (skippedOption.test(out)) {
    out = out.replace(skippedOption, '');
    reasons.push('skipped_option_stripped');
  }

  // (b2) Dropped-pack/series lines WITHOUT "Option N:" wrapper. Catches the
  // newer leak shape "SE-F12: ceil(400 ÷ 12) = 34 packs → exceeds 32 cap,
  // dropped silently." and "BOS-B: 6 modules → fails minimum, dropped."
  const droppedSku = /\b(?:SE-[FG][\d.]+(?:\s*Pro)?|BOS-[ABG][A-Z0-9.-]*)\s*:\s*[^.\n]*?(?:dropped|exceeds|fails|silent(?:ly)?|cap(?!acity)|minimum|floor)[^\n.]*\.?/gi;
  if (droppedSku.test(out)) {
    out = out.replace(droppedSku, '');
    reasons.push('dropped_sku_stripped');
  }

  // (b3) Pre-send checklist survivor rows. The model echoes lines like
  // "SE-F16: 25 packs, 3 inverters ✓" or "BOS-A: 26 modules, 2 clusters ✓"
  // straight from §9LV.8 / §9HV.8. These restate what the BOM card already
  // shows below, in checklist format. Strip them.
  const checklistRow = /\b(?:SE-[FG][\d.]+(?:\s*Pro)?|BOS-[ABG][A-Z0-9.-]*)\s*:\s*\d+\s+(?:packs?|modules?)\b[^\n]*[✓✗][^\n.]*\.?/gi;
  if (checklistRow.test(out)) {
    out = out.replace(checklistRow, '');
    reasons.push('checklist_row_stripped');
  }

  // (c1) Trim recommendation reasoning. Keep "Recommended: Option N" plus
  // an optional ": SKU" tail. Drop everything after but preserve any
  // closing markdown asterisks (so WhatsApp bold formatting stays paired).
  const recReasoning = /(\*{0,2}\s*Recommended:?\s*\*{0,2}\s*Option\s+\d+(?:\s*:\s*[A-Z][\w.-]+(?:\s+Pro)?)?\s*\*{0,2})[^\n]*/gi;
  let trimmed = false;
  out = out.replace(recReasoning, (m, kept) => {
    if (m.length > kept.length) trimmed = true;
    return kept + '.';
  });
  if (trimmed) reasons.push('rec_reasoning_trimmed');

  // (c2) Force blank line before "Option N:" and "Recommended:" headers when
  // glued to the preceding sentence. Protect "Recommended: Option N" from
  // being split: that's a single recommendation phrase, not a new option.
  const REC_MARK = '\x00REC_OPT\x00';
  out = out.replace(
    /(\*{0,2}\s*Recommended\s*:\s*\*{0,2})\s+(\*{0,2}\s*Option\s+\d+\s*:)/gi,
    '$1' + REC_MARK + '$2'
  );
  out = out.replace(/(\S)[ \t]+(\*{0,2}\s*Option\s+\d+\s*:)/g, '$1\n\n$2');
  out = out.replace(/(\S)[ \t]+(\*{0,2}\s*Recommended\s*:)/gi, '$1\n\n$2');
  out = out.replace(new RegExp(REC_MARK, 'g'), ' ');
  // (c3) Force newline before BOM body labels when glued to the previous
  // line ("Cables: battery comm bus + AC tie Option 2: ..." case after the
  // skipped-option strip leaves a "Cables: ... " trailing space).
  out = out.replace(
    /(\S)[ \t]+(\*{0,2}\s*(?:Inverter|Battery|Parallel\s+kit|Cables|Cluster\s+split|Control\s+Box|Racks)\s*:)/g,
    '$1\n$2'
  );
  if (out !== before) reasons.push('line_breaks_inserted');

  // (d) Final cleanup. Drop orphan punctuation lines, leftover comma+dash
  // glue from stripped narration ("., - For 50kW..."), repeated whitespace,
  // and collapse 3+ newlines.
  out = out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    // lines that are only punctuation/dashes
    .replace(/^\s*[-.,;:*•]+[\s.,;:*•-]*$/gm, '')
    // line ENDS with comma/colon/semicolon + dash (residue from stripped narration)
    .replace(/[,;:]\s*[-–—]\s*$/gm, '')
    // line STARTS with leftover punctuation cluster from stripped narration
    // ("- ., - For ..." after stripping "Only SE-F16 survives."). Require
    // at least one of .,;: in the cluster so legitimate bullet lines like
    // "- Battery: SE-F16" are NOT stripped.
    .replace(/(^|\n)[ \t]*-?\s*[,;:.][\s,;:.\-–—]*(?=[A-Za-z*])/g, '$1')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  return { text: out, changed: out !== before, reasons };
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
  owner_brief: null,
  owner_followup_draft: null,
  routing_category: null,
  routing_region: null,
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
    { type: 'text', text: promptStore.get('classifier'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
  let warehouseSnap = '';
  try { warehouseSnap = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('claude.classify.warehouse_load_fail', { message: err.message });
  }
  if (warehouseSnap) {
    classifierSystem.push({ type: 'text', text: warehouseSnap, cache_control: { type: 'ephemeral', ttl: '1h' } });
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
  /^Our specialist will confirm.*$/i,
  /^Noted\.?\s*The Sales Manager will follow up.*$/i,
  /^The Sales Manager will confirm.*$/i,
  /^The Sales Manager will be with you shortly.*$/i
];

function scrubHistoryContent(text) {
  if (typeof text !== 'string') return text;
  let cleaned = text
    .replace(/https?:\/\/wa\.me\/[^\s)]+/gi, '')
    .replace(/Direct line to the (?:specialist|Sales Manager):?[^\n]*/gi, '')
    .replace(/If you'd like to reach our (?:specialist|Sales Manager) directly now:?[^\n]*/gi, '')
    .replace(/For urgent matters,? direct line to the (?:specialist|Sales Manager):?[^\n]*/gi, '')
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

  const contextBlock = buildKnownCustomerContext(contact, isCasualGreeting);

  const systemBlocks = [
    { type: 'text', text: promptStore.get('system'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
  let warehouseBlock = '';
  try { warehouseBlock = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('claude.reply.warehouse_load_fail', { message: err.message });
  }
  if (warehouseBlock) {
    systemBlocks.push({ type: 'text', text: warehouseBlock, cache_control: { type: 'ephemeral', ttl: '1h' } });
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

    // A quantity / buying-intent statement counts as a price ask too (owner
    // directive 2026-06-07): when a customer names a product and a quantity
    // ("I need up to 34 units", "buy 10 panels"), they want the price. Without
    // this, the strip below nuked the quote and Sunny looped on a generic
    // "could you share more about your project" (Lanre Ajeigbe screenshot).
    const PRICE_ASK_RE = /\b(how\s+much|prices?|pricing|costs?|naira|ngn|quotations?|quotes?|rates?|totals?|sum|altogether|all\s+together|grand\s+total|in\s+total|final\s+amount|invoices?|proformas?|how\s+many\s+naira|configure|configuration|sizing|recommend(ation)?|complete\s+system|full\s+system|required|bundle|kit|boq|bom|estimate|estimation|spec(s|ification)?s?|buy|purchase|order|\d+\s*(?:units?|pcs|pieces?|panels?|nos?|sets?|modules?|inverters?|batteries|kits?|qty)|up\s+to\s+\d+)\b/i;
    const currentAsked = PRICE_ASK_RE.test(String(message || ''));
    let priorAsked = false;
    if (Array.isArray(history)) {
      const lastSixUser = history.filter(m => m && m.role === 'user').slice(-6);
      priorAsked = lastSixUser.some(m => PRICE_ASK_RE.test(String(m.content || '')));
    }
    const customerAskedPrice = currentAsked || priorAsked;
    if (text && !customerAskedPrice) {
      // Widened price regex (B7 fix): the previous \d+(?:[.,]\d+)? body only
      // captured "850,000 NGN" but missed the leading "1," in
      // "1,850,000 NGN", so the strip left an orphan "Price: 1," in the
      // output (Emmanuel screenshot 2026-05-16). The new body
      // \d{1,3}(?:,\d{3})*(?:\.\d+)? handles Nigerian thousands-comma
      // formatting plus the M/k/K abbreviated forms.
      const priceRegex = /\s*(?:[(–—-]\s*)?\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:M|m|k|K)?\s*NGN\b[)]?|\s*(?:[(–—-]\s*)?\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[Mm]\b[)]?|\s*\(\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[kK]\s*\)|\s*\(\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[Mm]\s*\)/g;
      const priceMatches = text.match(priceRegex) || [];
      if (priceMatches.length >= 1) {
        const stripped = text.replace(priceRegex, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
        // Dangling-label detection. Catches:
        //   (a) "label: ." pattern (original colon + punct)
        //   (b) "...promo price of." trailing-preposition pattern
        //   (c) NEW: "Price:" / "Cost:" / "Total:" at end of line with no
        //       content after the colon (Emmanuel screenshot case)
        //   (d) NEW: "Price: <orphan digit>," shape, e.g. "Price: 1," left
        //       behind by an under-matched price regex (defensive backstop
        //       in case the regex misses an edge case)
        const danglingKind = detectDanglingFragment(stripped);
        const hasDanglingLabel = !!danglingKind;
        logger.warn('claude.reply.prices_stripped', {
          contactId: contact?.id,
          customer_msg: String(message || '').slice(0, 100),
          original_reply: text.slice(0, 200),
          stripped_reply: stripped.slice(0, 200),
          price_matches: priceMatches.length,
          dangling_label: hasDanglingLabel,
          dangling_kind: danglingKind
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

    // CTA-tail guard. Strips a trailing call-to-action question like "Want to
    // proceed?", "Should I send the account?", "Are you ready to pay?",
    // "Would you like to wait or pre-order?". The prompt forbids them but the
    // model still emits them. Skip the strip when the customer explicitly
    // asked for guidance ("what do you recommend", "I'm ready to pay",
    // "send me the account") because then a CTA closer is appropriate.
    if (text && !options.allowTrailingQuestion) {
      const customerMsg = String(message || '').trim();
      const GUIDANCE_ASK_RE = /\b(recommend|suggest|advise|advice|what\s+do\s+you\s+(?:think|recommend)|what\s+would\s+you|which\s+is\s+better|best\s+for\s+me|help\s+me\s+(?:choose|decide|pick)|ready\s+to\s+(?:buy|pay|proceed|order)|i\s+want\s+to\s+pay|i'?ll\s+take\s+it|i'?m\s+ready|let'?s\s+(?:proceed|go|do\s+it)|sign\s+me\s+up|send\s+(?:me\s+)?(?:the\s+)?(?:account|proforma|invoice|details)|where\s+do\s+i\s+pay|how\s+do\s+i\s+pay)\b/i;
      if (!GUIDANCE_ASK_RE.test(customerMsg)) {
        const CTA_TAIL_RE = new RegExp(
          '\\s*(?:' +
          'Want\\s+to\\s+(?:proceed|order|pre-?order|wait|confirm|buy|pay|put|reserve|lock|secure)|' +
          'Want\\s+(?:me|us|the\\s+team)\\s+to\\s+(?:send|share|prepare|process|put|reach|contact|reserve|hold|set|arrange|put\\s+aside|lock)|' +
          'Would\\s+you\\s+(?:like|prefer)\\s+(?:to\\s+|me\\s+to\\s+|us\\s+to\\s+)?(?:proceed|order|pre-?order|wait|confirm|pay|send|share|prepare|reserve|hold|lock)|' +
          'Should\\s+I\\s+(?:send|share|prepare|process|reserve|hold|put)|' +
          'Shall\\s+I\\s+(?:send|share|prepare|process|reserve|hold|put|confirm|proceed)|' +
          'Do\\s+you\\s+want\\s+(?:to\\s+(?:proceed|order|pre-?order|wait|confirm|pay|lock|reserve)|(?:me|us)\\s+to\\s+(?:send|share|prepare|reserve|hold))|' +
          'Are\\s+you\\s+ready\\s+(?:to\\s+)?(?:proceed|pay|order|confirm|move)|' +
          'Ready\\s+to\\s+(?:proceed|pay|order|confirm|move)' +
          ')[^.?!]{0,200}\\?\\s*$',
          'i'
        );
        if (CTA_TAIL_RE.test(text)) {
          const stripped = text.replace(CTA_TAIL_RE, '').trim();
          if (stripped) {
            logger.warn('claude.reply.cta_tail_stripped', {
              contactId: contact?.id,
              customer_msg: customerMsg.slice(0, 80),
              original_reply: text.slice(0, 300),
              stripped_reply: stripped.slice(0, 300)
            });
            text = stripped;
          }
        }
      }
    }

    // B9 guard: datasheet hallucination. If the customer asked for a
    // datasheet but the handler's fast-path did NOT actually send one
    // (no warehouse match, or Meta upload/send failed), the LLM tends to
    // claim "the system is attaching it now" / "the datasheet is on file
    // and will be attached" / "datasheet is attached". Both are lies;
    // nothing actually got sent. Replace with a safe, honest message.
    if (text && options.datasheetRequestedButNotSent) {
      const datasheetTopic = /\b(?:data\s*sheet|datasheet|brochure|spec\s*sheet|technical\s*sheet)\b/i;
      const sendingClaim = /\b(?:attach(?:ed|ing|es)?|on\s*file|is\s*attached|will\s*attach|auto[-\s]?attach(?:es|ed|ing)?|automatically\s*attach(?:es|ed|ing)?|coming\s*through|on\s*its\s+way|sending\s+(?:it|now|shortly)|system\s+(?:will|is|auto)\s*(?:send|attach)|i'?ll\s+(?:send|attach)|am\s+attaching)\b/i;
      // The hallucination can put the topic and the sending claim in either
      // order ("the datasheet is attached" OR "the system auto-attaches the
      // datasheet"). Require both somewhere in the reply, not adjacent.
      if (datasheetTopic.test(text) && sendingClaim.test(text)) {
        logger.warn('claude.reply.datasheet_hallucination_blocked', {
          contactId: contact?.id,
          customer_msg: String(message || '').slice(0, 120),
          original_reply: text.slice(0, 250)
        });
        text = "We don't have that datasheet ready to send on the spot. The team will share it with you shortly.";
      }
    }

    // B8 guard: "asks for info already given". If the customer's CURRENT
    // message contains a specific kW/kVA/kWh size AND the reply asks them
    // again for size/storage/kW/system size, replace with a deflection that
    // acknowledges the size instead. Catches the Buchi screenshot pattern:
    //   Customer: "How much is 20kw batteries?"
    //   Sunny: "Could you share what you're sizing for? Residential,
    //           commercial, a specific kW size or storage target."
    // (the customer just gave the size; Sunny asks for size again).
    if (text) {
      const customerMsg = String(message || '');
      const sizeMatch = customerMsg.match(/\b(\d+(?:\.\d+)?\s*(?:kva|kw|kwh))\b/i);
      const customerNamedSize = !!sizeMatch;
      const replyAsksForSize = /\b(?:specific\s+(?:kw|size|kva|kwh)|storage\s+target|what\s+(?:kw|size|capacity|storage|are\s+you\s+sizing)|which\s+(?:kw|size|capacity|system\s+size)|what\s+(?:product|model|system\s+size)\s+are\s+you|sizing\s+for[\?:]?\s+(?:residential|commercial))\b/i.test(text);
      if (customerNamedSize && replyAsksForSize) {
        const namedSize = sizeMatch[1].replace(/\s+/g, '');
        logger.warn('claude.reply.asks_for_size_already_given', {
          contactId: contact?.id,
          customer_named_size: namedSize,
          customer_msg: customerMsg.slice(0, 120),
          original_reply: text.slice(0, 200)
        });
        text = `Noted, ${namedSize}. The team will pull the closest matching options from stock and share shortly.`;
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

    // SKU-list dump guard. Catches the failure mode where the model
    // enumerates the entire Deye inventory ("Here's what we have in stock:
    // SUN-8K..., SUN-12K..., SUN-16K..., SUN-20K..., SE-F5.12, SE-F16,
    // BOS-G-PACK..., BOS-A-PACK..., BOS-B-PACK..."), regardless of how the
    // customer phrased it. §19 forbids reciting Warehouse Stock; this is the
    // code-level backstop. Legitimate BOMs (3-option HV cards, multi-pack LV
    // cards) are exempt because they carry "Option N:" structure.
    if (text) {
      const inverterSet = new Set(
        (text.match(/\bSUN-\d+(?:\.\d+)?K\b/gi) || []).map(s => s.toUpperCase())
      );
      const batterySet = new Set(
        (text.match(/\b(?:BOS-[ABG][A-Z0-9.-]*|SE-[FG][\d.]+(?:\s*Pro)?)\b/gi) || []).map(s => s.toUpperCase())
      );
      const optionHeaderCount = (text.match(/\*?\s*Option\s+\d+\s*[:—–-]/gi) || []).length;
      const inverterDump = inverterSet.size >= 4;
      const batteryDump = batterySet.size >= 4;
      const totalDump = (inverterSet.size + batterySet.size) >= 6;
      if (optionHeaderCount === 0 && (inverterDump || batteryDump || totalDump)) {
        security.logSecurityEvent('sku_list_dump_blocked', {
          contactId: contact?.id,
          inverter_sku_count: inverterSet.size,
          battery_sku_count: batterySet.size,
          inverter_skus: Array.from(inverterSet).slice(0, 20),
          battery_skus: Array.from(batterySet).slice(0, 20),
          original_reply: text.slice(0, 400)
        });
        text = "Could you share what you're sizing for? Residential, commercial, a specific kW size or storage target. That way the team can point you at the right setup.";
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
        // "Option 1, BOS-B". Handles HV series (BOS-A/B/G) AND LV packs (SE-F,
        // SE-G, or any other SKU starting with a capital letter). Special-case
        // BEFORE the generic em/en-dash rule.
        .replace(/(\*{0,2}\s*Option\s+\d+)\s*[—–]\s*([A-Z])/g, '$1: $2')
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

    // BOM cleanup, FINAL pass. Strips internal section refs, decision-tree
    // reasoning, skipped-option lines, recommendation reasoning, and forces
    // blank lines around Option N / Recommended headers. Doctrine leaks
    // from the §9 LV/HV configurator have repeatedly slipped past the
    // prompt rules; this is the deterministic backstop.
    if (text) {
      const cleanup = cleanupBomReply(text);
      if (cleanup.changed) {
        logger.warn('claude.reply.bom_cleanup_applied', {
          contactId: contact?.id,
          reasons: cleanup.reasons,
          original_reply: text.slice(0, 800),
          cleaned_reply: cleanup.text.slice(0, 800)
        });
        text = cleanup.text;
      }
    }

    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    logger.error('claude.reply.error', { message: err.message });
    return { ok: false, text: null, error: err.message };
  }
}

// Detects a dangling/garbled fragment left behind after the price-dump guard
// strips a price from a reply. Returns the matched kind (string) or null.
// ONLY meaningful on text that has already had a price stripped: callers run it
// post-strip, so the false-positive surface is small. Catalogued from the
// 2026-05-16 + 2026-06-07 + 2026-06-08 inbox audits.
function detectDanglingFragment(stripped) {
  if (!stripped) return null;
  const s = String(stripped);
  // (a) "label: ." colon + punctuation
  if (/:\s*[.,;!?]/.test(s)) return 'colon';
  // (b) "price of/at/for/is ." trailing preposition after a price word
  if (/\b(?:price|cost|rate|figure|amount|total|sum|quote|charge|fee)\s+(?:of|at|for|is)\s*[.,;!?]/i.test(s)) return 'preposition';
  // (c) "Price:" at end-of-line with no content
  if (/\b(?:price|cost|rate|figure|amount|total|sum|quote|charge|fee)\s*:\s*(?:$|\n|\*)/im.test(s)) return 'label_eol';
  // (d) "Price: 1," orphan digit
  if (/\b(?:price|cost|rate|figure|amount|total|sum|quote|charge|fee)\s*:\s*\d{1,4}\s*[,.]\s*(?:$|\n|\*)/im.test(s)) return 'orphan_digit';
  // (e) "Total: =" / "Cost: ," math scaffolding
  if (/\b(?:price|cost|rate|figure|amount|total|sum|quote|charge|fee)\s*:\s*[^a-zA-Z\n]{1,30}(?:$|\n|\*)/im.test(s)) return 'math_fragment';
  // (f) orphaned "per <unit>" left when the price before it was stripped.
  //     The clause-start class now includes a COMMA (2026-06-08): "Available,
  //     per panel." was the most common garble of the day and a comma, not a
  //     period, preceded "per".
  if (/\b(?:is|are|was|were|at|of|for|costs?|priced?|sells?|goes?\s+for|starts?\s+(?:at|from))\s+per\s+\w+/i.test(s)) return 'per_unit';
  if (/(?:^|[.,;:!?]\s+)per\s+\w+/i.test(s)) return 'per_unit';
  // (g) bare copula/cost verb immediately before punctuation
  if (/\b(?:is|are|was|were|costs?|priced?|sells?)\s*(?:[,.;:!?]|$)/i.test(s)) return 'copula';
  // (h) NEW (2026-06-08): orphaned preposition where a price was stripped.
  //     "available at, which could work" / "is at." / "only for," — a status/
  //     copula word, then a preposition, then punctuation. "looking at, Saheed"
  //     is NOT caught because "looking" is not a price-introducing word.
  if (/\b(?:available|priced?|is|are|was|were|costs?|goes?|sells?|starts?|only|just)\s+(?:at|for|from|of)\s*(?:[,.;:!?]|$)/i.test(s)) return 'prep_orphan';
  // (i) NEW (2026-06-08): "at would do the job" — a preposition directly
  //     followed by a modal/verb, which only happens when a price between them
  //     was stripped. Valid English almost never has "at would/will/...".
  if (/\b(?:at|for)\s+(?:would|will|could|should|do|does)\b/i.test(s)) return 'prep_orphan';
  return null;
}

// Builds the "# Known about this customer" system block injected before each
// reply. The customer's NAME is deliberately NOT included (owner directive
// 2026-06-08: never address customers by name, never read the WhatsApp profile
// name; system.md instructs Sunny to use "sir"). The name is still captured in
// the DB / admin, just not handed to the reply model.
function buildKnownCustomerContext(contact, isCasualGreeting) {
  const contextLines = [];
  if (!isCasualGreeting) {
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
  }
  if (!contextLines.length && !isCasualGreeting) return '';
  const greetingNote = isCasualGreeting
    ? '\n(Customer just sent a casual greeting. Reply with a short greeting and a fresh qualifying opener. Do NOT bring up any prior products, prior categories, or prior context unless the customer references them.)'
    : '';
  if (!contextLines.length && !greetingNote) return '';
  return `\n\n# Known about this customer\n${contextLines.join('\n')}${greetingNote}`;
}

module.exports = { classify, generateReply, detectDanglingFragment, buildKnownCustomerContext };
