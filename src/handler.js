const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');
const {
  getOrCreateContact,
  getActiveConversation,
  appendMessage,
  getRecentHistory,
  getMessageByWhatsappId,
  logEvent,
  createPendingQuery,
  setPendingQueryAlertId,
  findPendingByAlertId,
  resolvePendingQuery,
  getOpenPendingQueryForContact,
  touchPendingQueryAssistantReply,
  getContactById,
  getMessagesForConversation,
  updateContactFields
} = require('./memory');
const { runClassification } = require('./classifier');
const { generateReply, describeInboundImage } = require('./claude');
const { sendMessage, sendTemplate, downloadMedia, uploadMediaToMeta, sendDocument, sendImage } = require('./whatsapp');
const warehouse = require('./warehouse');
const { DB_PATH } = require('../db/init');
// owner teaching retired 2026-05-10: owner edits master prompt directly via admin Rules editor
const { answerOwnerQuestion } = require('./owner_qa');
const { transcribeAudio } = require('./transcribe');
const security = require('./security');
const { buildOwnerAlertText, buildOwnerAlertTemplateComponents } = require('./owner_alert');
const ownerRouting = require('./owner_routing');
const idleChatter = require('./idle_chatter');

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(path.dirname(DB_PATH), 'media');

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}

const HOT_LEAD_REPLY = "Noted. To proceed, you can continue directly with our Sales Manager on WhatsApp. They have the formal documents and final figures.";
const SILENT_QUERY_REPLY = "Noted. The team will get back to you shortly. In the meantime, you can also reach our Sales Manager on WhatsApp.";
const UNSUPPORTED_REPLY = "This number receives text messages only. Please type your question and the team will respond.";

// Lead-source tagging. ElectroLeads (a separate outreach agent, not in this
// repo) reaches leads from its own WhatsApp number with a template that carries
// a wa.me click-to-chat link into THIS number, pre-filling a fixed opener. A
// plain wa.me link leaves no referral metadata in the webhook (that only exists
// for Click-to-WhatsApp ads), so the only reliable signal is the opener text
// itself. We match it on the contact's message and tag lead_source once.
const ELECTROLEADS_OPENER = process.env.ELECTROLEADS_OPENER || "Hello Electrosun team, I'm reaching out for a quotation";

function normalizeForLeadMatch(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns 'electroleads' when the message contains the configured ElectroLeads
// opener (tolerant of case, punctuation, and surrounding text), else null.
function detectLeadSource(body) {
  const opener = normalizeForLeadMatch(ELECTROLEADS_OPENER);
  if (!opener) return null;
  const hay = normalizeForLeadMatch(body);
  if (!hay) return null;
  return hay.includes(opener) ? 'electroleads' : null;
}

const FALLBACK_DEDUP_MINUTES = parseInt(process.env.FALLBACK_DEDUP_MINUTES || '15', 10);

// Defensive timeout on open pending_queries rows. Without this, one early
// silent_query misclassification opens a row that routes every subsequent
// inbound through the follow-up loop until the owner manually resolves the
// row via [QID:N] tag. The auto-expire releases the contact back into the
// normal classification path after the timeout so the customer can be served
// even if the brother is unavailable. The window_monitor 24h Meta-window
// expiry is the OUTER bound; this is the much shorter INNER bound.
const PENDING_QUERY_AUTO_EXPIRE_MS = Math.max(1, parseInt(process.env.PENDING_QUERY_AUTO_EXPIRE_MINUTES || '30', 10)) * 60 * 1000;

// Follow-up reply silence cooldown. Once an assistant reply has been produced
// while a pending_queries row was already open (i.e. a follow-up turn, not
// the initial silent_query reply), suppress further LLM-generated replies on
// subsequent inbounds within this window. The owner still gets follow-up
// pings via notifyOwnerForEscalation; the customer just stops getting more
// "Could you share what you're sizing for?" loop messages.
const PENDING_QUERY_REPLY_SILENCE_MS = Math.max(1, parseInt(process.env.PENDING_QUERY_REPLY_SILENCE_MINUTES || '10', 10)) * 60 * 1000;

const CASUAL_CONFIRM_RE = /^(o+k+(ay|ey|wy)?|alright|noted|got\s*it|sure|fine|cool|nice|great|perfect|thanks|thank\s*you|tnx|ty|appreciate(d)?|cheers|no\s*problem|np|👍|🙏|❤️|✅|done|gotcha|sounds\s*good|sg|👌|🆗|all\s*good|yep|yup|y(ea+|ah+)|alright\s*then|great\s*thanks|thanks\s*a\s*lot|much\s*appreciated|noted\s*thanks|hmm+|h+mm|interesting|hmm+\s*interesting|wow|really|i\s*see|isee|oh|aha|ahaa|ahh|right|wow\s*ok|ok\s*cool|ok\s*sure|sure\s*thing)[.!?,\s]*$/i;
const PRODUCT_KEYWORDS_RE = /\b(kw|kva|kwh|panel|panels|battery|batteries|inverter|inverters|deye|jinko|ja|longi|sungrow|huawei|bos|hv|lv|hybrid|off\s*grid|on\s*grid|three\s*phase|single\s*phase|naira|ngn|price|cost|how\s*much|stock|available|quotation|invoice|proforma|brochure|datasheet|spec|kit|system)\b/i;
// Gratitude is its own flavor of casual confirmation: customer is thanking
// Sunny. Reply should be warm ("you're most welcome", "anytime") + a soft
// offer to keep helping, NOT the bare 6-word ack used for "ok"/"noted".
const GRATITUDE_RE = /\b(thanks?|thank\s*you|thnx|tnx|ty|thx|tysm|appreciate(d|s)?|much\s+appreciated|grateful|gracias|merci|shukran|🙏|❤️)\b/i;
function isCasualConfirmation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length > 40) return false;
  if (CASUAL_CONFIRM_RE.test(t)) return true;
  if (t.length <= 30 && !/\?/.test(t) && !PRODUCT_KEYWORDS_RE.test(t)) return true;
  return false;
}
function isGratitudeMessage(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  return GRATITUDE_RE.test(t);
}

const WELCOME_REPLY = [
  'Welcome To ElectroSun Global Services LTD',
  '',
  '*Abuja*',
  '',
  '📍 Office: https://maps.app.goo.gl/bQvqyaQRHLZ51RXz6?g_st=aw',
  '',
  '📍 Warehouse: https://maps.app.goo.gl/6zLRGrPwzBdQM7MEA?g_st=aw',
  '',
  'Contact:',
  'Charbel: 09068859213',
  'Patrick: 07041328055',
  '',
  '*Lagos*',
  '',
  '📍 Warehouse & Offices: https://maps.app.goo.gl/pQQk7H7uSeP7yRAs9?g_st=aw'
].join('\n');

const HANDLER_GREETING_RE = /^(hi+|hello+|hey+|hola|bonjour|salam|asalam|good\s+(morning|afternoon|evening|day)|gm|ga|ge|how\s+far|wetin\s+dey|sup|yo|howdy|greetings|hii?|test|testing)\b[\s!.?]*$/i;
function handlerIsGreeting(text) {
  const t = String(text || '').trim();
  return t.length > 0 && t.length <= 30 && HANDLER_GREETING_RE.test(t);
}
function escalationsDisabled() {
  return String(process.env.DISABLE_ESCALATIONS || '').toLowerCase() === 'true';
}

// --- Customer contact-number requests (owner directive 2026-06-07) ----------
// When a customer asks for a phone/contact line, share the REGIONAL SALES desk
// as a WhatsApp link only: Lagos -> Lagos Sales, Abuja -> Abuja Sales, unknown
// region -> ask which city first. NEVER share an owner number (Patrick/Charbel
// are the big-deal owners, not a regional desk). Deterministic so the LLM can't
// mislabel the number or pick the wrong one.
const CONTACT_REQUEST_RE = /\b(phone\s*(number|no|line)?|(your|the|a)\s+(number|line|contact)|number\s+to\s+(call|reach|contact)|to\s+call\b|call\s+(you|your\s+(team|office)|the\s+team)|how\s+(can|do|to)\s+(i\s+)?(reach|contact|call)|reach\s+(you|the\s+team|your\s+team|someone)|contact\s+(you|number|line|the\s+team|someone)|whats?app\s*(number|no|line|contact)?|hotline|customer\s+(care|service))\b/i;

function regionSalesNumberDigits(region) {
  if (region === 'lagos') return (process.env.SALES_LAGOS_WHATSAPP || '').replace(/\D/g, '') || null;
  if (region === 'abuja') return (process.env.SALES_ABUJA_WHATSAPP || '').replace(/\D/g, '') || null;
  return null;
}

function resolveContactRegion(classification, contact, text) {
  const rc = String((classification && classification.routing_region) || '').toLowerCase();
  if (rc === 'lagos' || rc === 'abuja') return rc;
  const blob = `${text || ''} ${(contact && contact.location) || ''}`.toLowerCase();
  if (/\blagos\b/.test(blob)) return 'lagos';
  if (/\babuja\b/.test(blob)) return 'abuja';
  return 'unknown';
}

// Region from CURRENT-conversation text only (no stored contact.location). Used
// to route a deal: we must not pick a sales desk from a stale location the
// customer set in a previous chat (2026-06-07: a returning test number had
// location=Abuja, so a Lagos-less deal wrongly routed to Abuja Sales). If the
// current conversation does not name a city, the region stays unknown and
// gather-first asks "Abuja or Lagos?".
function detectRegionInText(text) {
  const t = String(text || '').toLowerCase();
  if (/\blagos\b/.test(t)) return 'lagos';
  if (/\babuja\b/.test(t)) return 'abuja';
  return null;
}

// Build the deterministic reply for a contact-number request. Returns null when
// we have a region but its desk number is not configured (so the caller asks
// for the city instead of leaking nothing / an owner number).
function buildContactReply(region) {
  if (region === 'unknown') {
    return 'Are you in Abuja or Lagos? Let me know and I\'ll share the right sales line.';
  }
  const digits = regionSalesNumberDigits(region);
  if (!digits) return null;
  const city = region === 'lagos' ? 'Lagos' : 'Abuja';
  const prefill = encodeURIComponent('Hi, I was speaking with Electro-Sun and would like to continue.');
  return `You can reach our ${city} sales team here: https://wa.me/${digits}?text=${prefill}`;
}

// Topic-shift patterns: signals that the customer's new inbound is
// substantively different from a "still waiting on the team" follow-up. A
// match means the customer is engaging with a new product, identifying
// themselves, or asking a question answerable from Warehouse Stock. In any of
// those cases the right move is to auto-resolve the open pending_query and
// let the classifier + escalation logic run cleanly on the new message.
const TOPIC_SHIFT_PATTERNS = [
  /\bi\s*(am|m)\s+(a\s+|the\s+)?(dealer|reseller|distributor|integrator|installer|contractor|engineer|end\s*user)\b/i,
  /\bi\s*(am|m)\s+not\s+(an?\s+)?end\s*user\b/i,
  /\bfor\s+(re)?sale\b|\bfor\s+my\s+(shop|store|business)\b|\bsamples?\s+in\s+my\s+shop\b/i,
  /\bnot\s+for\s+personal\s+use\b|\bfor\s+commercial\s+use\b/i,
  /\b(in\s+stock|available|what\s+sizes|what\s+models|what\s+about|do\s+you\s+(have|carry|stock|sell))\b/i,
  /\b(available|what)\s+(batteries|inverters|panels|brands)\b/i,
  /\b\d+(\.\d+)?\s*(kw|kva|kwh)\b/i,
  /^\s*(residential|commercial|home|business|industrial|3\s*phase|single\s*phase|1\s*phase)[.,!?\s]*$/i,
  /\b(deye|sungrow|jinko|ja\s+solar|longi|huawei|trina|canadian\s+solar)\b/i
];

function isLikelyTopicShift(newMessage) {
  const text = String(newMessage || '').trim();
  if (!text || text.length < 4) return false;
  // Skip pure repetition or nag patterns: customer asking the same question
  // or pinging Sunny ("are you there"). Those should stay on the follow-up
  // path so the silence cooldown kicks in.
  if (/^(when|where|how|hello|hi+|are\s+you\s+there|still\s+waiting|still\s+there|any\s+update|update\s*\?)[?.\s!]*$/i.test(text)) return false;
  return TOPIC_SHIFT_PATTERNS.some(re => re.test(text));
}

function topicShiftAutoResolve(contactId, newMessageText) {
  const open = getOpenPendingQueryForContact(contactId);
  if (!open) return false;
  if (!isLikelyTopicShift(newMessageText)) return false;
  try {
    resolvePendingQuery(open.id, '[auto-resolved: topic shift in new inbound]');
    logEvent(contactId, 'silent_query_topic_shift_resolved', {
      queryId: open.id,
      message_preview: String(newMessageText || '').slice(0, 200)
    });
    logger.info('handler.pending_query_topic_shift_auto_resolved', {
      contactId,
      queryId: open.id,
      message_preview: String(newMessageText || '').slice(0, 200)
    });
    return true;
  } catch (err) {
    logger.warn('handler.pending_query_topic_shift_resolve_fail', {
      message: err.message,
      queryId: open.id
    });
    return false;
  }
}

// Parse a timestamp that might be in ISO 8601 format ("2026-05-15T14:00:00.000Z")
// OR SQLite's CURRENT_TIMESTAMP default format ("2026-05-15 14:00:00", no T,
// no Z, implicitly UTC). The application writes ISO via nowIso() but legacy
// rows inserted via the schema default may carry the SQLite shape and would
// otherwise return NaN on some Node builds, defeating the auto-expire guard.
function parsePendingTimestamp(ts) {
  if (!ts) return NaN;
  const direct = new Date(ts).getTime();
  if (Number.isFinite(direct)) return direct;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(ts))) {
    return new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  }
  return NaN;
}

// Returns the most recent open pending_query for the contact, OR null if no
// open row exists OR the open row has aged past PENDING_QUERY_AUTO_EXPIRE_MS
// (in which case it is auto-resolved as a side effect and null is returned).
// Use this everywhere routing decisions key off "is there a pending row".
function getOrAutoResolveStalePending(contactId) {
  const open = getOpenPendingQueryForContact(contactId);
  if (!open) return null;
  const createdMs = parsePendingTimestamp(open.created_at);
  if (!Number.isFinite(createdMs)) {
    logger.warn('handler.pending_query_created_at_unparseable', {
      contactId,
      queryId: open.id,
      created_at: open.created_at
    });
    return open;
  }
  const ageMs = Date.now() - createdMs;
  if (ageMs <= PENDING_QUERY_AUTO_EXPIRE_MS) return open;
  try {
    resolvePendingQuery(open.id, '[auto-expired: no owner action within PENDING_QUERY_AUTO_EXPIRE_MINUTES]');
    logEvent(contactId, 'silent_query_auto_expired', {
      queryId: open.id,
      age_ms: ageMs,
      timeout_ms: PENDING_QUERY_AUTO_EXPIRE_MS
    });
    logger.info('handler.pending_query_auto_expired', {
      contactId,
      queryId: open.id,
      age_minutes: Math.floor(ageMs / 60000),
      timeout_minutes: Math.floor(PENDING_QUERY_AUTO_EXPIRE_MS / 60000)
    });
    return null;
  } catch (err) {
    logger.warn('handler.pending_query_auto_expire_fail', {
      message: err.message,
      queryId: open.id
    });
    return open;
  }
}

// overrideNumber: when set (the recipient an alert was actually routed to:
// Abuja / Lagos sales desk, Charbel, or Patrick), the customer's direct line
// points at THAT person instead of the static SPECIALIST_DIRECT_LINK. Falls
// back to SPECIALIST_DIRECT_LINK when no recipient was resolved this turn.
function buildSpecialistLink(customerMessage, overrideNumber) {
  const source = (overrideNumber != null && String(overrideNumber).trim())
    ? String(overrideNumber)
    : (process.env.SPECIALIST_DIRECT_LINK || '');
  const num = source.replace(/\D/g, '');
  if (!num) return null;
  const topic = (customerMessage || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prefilled = topic
    ? `Hi, I was speaking with Electro-Sun and want to proceed: "${topic}"`
    : 'Hi, I was speaking with Electro-Sun and want to proceed.';
  return `https://wa.me/${num}?text=${encodeURIComponent(prefilled)}`;
}

function pickHoldingReply(escalationType, customerMessage) {
  const base = escalationType === 'hot_lead' ? HOT_LEAD_REPLY : SILENT_QUERY_REPLY;
  const link = buildSpecialistLink(customerMessage);
  if (link) return base + `\n\nDirect line to the Sales Manager: ${link}`;
  return base;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function buildDealerPricingContext() {
  return [
    '# Dealer pricing handoff context (treat as authoritative)',
    'The customer has self-identified as a dealer, reseller, distributor, or shop owner asking about products for resale, AND is asking for pricing (price list, dealer rates, volume pricing, samples for shop, etc.).',
    '',
    'Voice rules in this state:',
    '- Acknowledge the dealer ask in ONE short sentence, in the customer\'s own language. Examples: "Got it, dealer pricing.", "Understood, you\'re sourcing for resale.", "Noted, dealer enquiry."',
    '- Then say the dealer team will reach out shortly with volume tier pricing and the dealer rate sheet.',
    '- Do NOT quote any prices, even ranges. Dealer pricing is NOT public; it depends on volume and is negotiated case by case.',
    '- Do NOT promise a specific timeline ("within 24h", "by tomorrow"). Use "shortly" or "soon".',
    '- Use third person ("the dealer team", "our team"). No first-person stalls ("I will get back to you").',
    '- Two sentences max. No CTA tail.',
    '- Do NOT include any URL or phone number; the system does NOT append a Sales Manager link for dealer flows.',
    '- Do NOT ask further qualifying questions (the team will gather those when they reach out).'
  ].join('\n');
}

// Gather-first context: a serious lead needs one routing detail before the
// team is brought in. Tell Sunny to ask exactly one short question this turn,
// without handing off, naming the team, or emitting any link/number.
function buildGatherFirstContext(classification) {
  const cat = String((classification && classification.routing_category) || '').toLowerCase();
  const region = String((classification && classification.routing_region) || '').toLowerCase();
  const lines = [
    '# Routing context (treat as authoritative)',
    'This customer looks serious, but before the team is brought in you need ONE more detail. Acknowledge briefly, then ask ONE short, natural question this turn. Do NOT hand off yet, do NOT mention the team, the Sales Manager, or a specialist, and do NOT include any URL or phone number.'
  ];
  if (region !== 'abuja' && region !== 'lagos') {
    // Region is the detail we need most often (it decides which regional sales
    // desk gets the alert, and pickup vs delivery). Ask it whenever it is
    // unknown, regardless of whether the classifier pinned routing_category.
    lines.push('Missing detail: their location. Ask whether they are in Abuja or Lagos (this also tells us pickup vs delivery). Just that one question.');
  } else {
    lines.push('Missing detail: what they actually need. Ask briefly about the product or the system size they have in mind (for example the kW size, or whether it is a small home setup or a larger project). Just that one question.');
  }
  lines.push('Maximum 2 short sentences total.');
  return lines.join('\n');
}

// Bulk-order detection: an explicit countable quantity of 2 or more units of a
// product. "I need up to 34 units", "buy 10 panels", "20 pcs". Excludes power
// figures (650W, 12kW, 16kWh) because those are not unit counts. Used to drive
// the bulk-quote-plus-Sales-Manager flow (owner directive 2026-06-07).
const BULK_ORDER_RE = /\b(?:up\s+to\s+)?(\d{1,5})\s*(?:units?|pcs|pieces?|panels?|nos?|sets?|modules?|inverters?|batteries|battery|kits?|qty)\b/i;
// Glue-typo backstop (2026-06-08, B-#2): "30pcscof" (ken stone) ran "pcs"
// straight into the next word, so the trailing \b above failed and the bulk
// path was skipped. Only the low-collision units (no "set"/"no" prefixes) are
// allowed to be followed by letters, so "30 setup" / "30 nothing" do NOT match.
const BULK_ORDER_GLUE_RE = /\b(?:up\s+to\s+)?(\d{1,5})\s*(?:pcs|pieces?|units?|panels?|modules?)(?=[a-z])/i;
function detectBulkQuantity(text) {
  const s = String(text || '');
  const m = BULK_ORDER_RE.exec(s) || BULK_ORDER_GLUE_RE.exec(s);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 2 ? n : 0;
}

// Big-project-by-value detection (owner directive 2026-07-05). A large order
// must route to the OWNERS (Patrick/Charbel), not a regional desk, regardless of
// city. The classifier's routing_category=big_project tag is unreliable, so we
// read the actual money: the largest Naira figure mentioned in the customer's
// text OR in Sunny's own recent BOM/quote. Only figures explicitly tied to Naira
// (₦ / NGN / naira) or the word "million" count, so this never trips on a SKU
// number (SUN-50K), wattage (720W), or capacity (16kWh).
const BIG_PROJECT_NGN_THRESHOLD = (() => {
  const v = parseInt(process.env.BIG_PROJECT_NGN_THRESHOLD || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 15000000; // ₦15M (matches the large-order doctrine)
})();
// "41,292,000 NGN" / "₦41,292,000" / "NGN 5,700,000" (grouped or plain digits).
const NGN_GROUPED_RE = /(?:₦|\bngn\b|\bnaira\b)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:₦|\bngn\b|\bnaira\b)/gi;
// "41 million" / "41.29 million" / "₦41M" / "NGN 20 m" (M only when currency-adjacent).
const NGN_MILLION_SPELLED_RE = /([0-9]+(?:\.[0-9]+)?)\s*million\b/gi;
const NGN_MILLION_SUFFIX_RE = /(?:₦|\bngn\b|\bnaira\b)\s*([0-9]+(?:\.[0-9]+)?)\s*m\b|([0-9]+(?:\.[0-9]+)?)\s*m\s*(?:₦|\bngn\b|\bnaira\b)/gi;

function detectLargeOrderNgn(text) {
  const s = String(text || '');
  let max = 0;
  const bump = (raw, mult) => {
    const n = parseFloat(String(raw).replace(/,/g, '')) * (mult || 1);
    if (Number.isFinite(n) && n > max) max = n;
  };
  let m;
  NGN_GROUPED_RE.lastIndex = 0;
  while ((m = NGN_GROUPED_RE.exec(s)) !== null) bump(m[1] || m[2], 1);
  NGN_MILLION_SPELLED_RE.lastIndex = 0;
  while ((m = NGN_MILLION_SPELLED_RE.exec(s)) !== null) bump(m[1], 1000000);
  NGN_MILLION_SUFFIX_RE.lastIndex = 0;
  while ((m = NGN_MILLION_SUFFIX_RE.exec(s)) !== null) bump(m[1] || m[2], 1000000);
  return max;
}

function isBigProjectByValue(text) {
  return detectLargeOrderNgn(text) >= BIG_PROJECT_NGN_THRESHOLD;
}

// Bulk-order context: the customer named a product and a multi-unit quantity.
// Sunny quotes the per-unit price from warehouse stock, then offers the Sales
// Manager for the bulk price. The system appends the Sales Manager wa.me link
// (do not emit it here).
function buildBulkOrderContext(quantity) {
  const qty = quantity && quantity > 1 ? String(quantity) : 'that quantity';
  return [
    '# Bulk order context (treat as authoritative)',
    `The customer wants ${qty} units of a product they have named. They want pricing for a bulk purchase.`,
    '',
    'Voice rules in this state:',
    '- If the product is clear from the conversation, state its PER-UNIT price from the warehouse stock block (exact figure, Naira). Do NOT invent a price; if the exact product or variant is not in the warehouse block, do NOT quote, just say the Sales Manager will confirm.',
    `- Then add, in one short clause, that for ${qty} units the Sales Manager will confirm the best bulk price.`,
    '- Do NOT compute or quote a total for the full quantity yourself, and do NOT promise any discount or percentage. Bulk pricing is the Sales Manager\'s call.',
    '- If the product is NOT clear, ask which exact model they want, and mention the Sales Manager will handle the bulk quote. Just that.',
    '- Use third person for the handoff ("the Sales Manager"). No first-person stalls ("I will get back").',
    '- Do NOT include any URL or phone number; the system appends the Sales Manager contact link automatically.',
    '- Two short sentences max.'
  ].join('\n');
}

// Image body builders (2026-07-11 image-reading fix). The vision-model
// description travels in both the persisted DB body (so admin and FUTURE
// history turns know what the image showed) and the classifier input (so an
// image turn classifies on real content instead of a blind marker).
function buildImagePersistedBody(caption, description) {
  const base = caption ? `[image] ${caption}` : '[image]';
  return description ? `${base}\n[Image content: ${description}]` : base;
}

function buildImageCombinedPart(caption, description) {
  const base = caption
    ? `[Customer sent an image with caption]: ${caption}`
    : '[Customer sent an image with no caption]';
  return description ? `${base}\n[Image content: ${description}]` : base;
}

// Pending-query silence cooldown decision (extracted 2026-07-11). A turn that
// carries a fresh image attachment is NEVER suppressed: the image is new
// information, not a repeated "any update?" nag, and suppressing it was how a
// customer's "I mean this one" + product photo got total silence.
function shouldSuppressFollowupReply({ lastAssistantReplyAt, nowMs, silenceMs, hasImageAttachments }) {
  if (hasImageAttachments) return false;
  if (!lastAssistantReplyAt) return false;
  const sinceLastReplyMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - new Date(lastAssistantReplyAt).getTime();
  return Number.isFinite(sinceLastReplyMs) && sinceLastReplyMs < silenceMs;
}

function buildExpertContext({ openPending, escalationJustCreated, isHot, hasImage }) {
  if (isHot) {
    return [
      '# HOT lead handoff context (treat as authoritative)',
      'The customer has expressed clear intent to proceed (pay, deposit, order, install, ready to buy).',
      '',
      'Voice rules in this state:',
      '- Acknowledge their commitment in one short sentence, in the customer\'s own language.',
      '- Confirm the Sales Manager will reach out shortly with formal documents and figures.',
      '- Use third person ("the Sales Manager", "the team"). Do NOT use first-person stalls ("I will reach out", "let me confirm", "I will get back").',
      '- Do NOT quote new prices or specs that were not already discussed in this conversation.',
      '- Do NOT include any URL or phone number; the system appends the Sales Manager contact link automatically.',
      '- Two sentences max.'
    ].join('\n');
  }

  const lines = ['# Background context (DO NOT mention unless the customer explicitly references it)'];
  if (openPending) {
    const original = String(openPending.customer_message_text || '').replace(/\s+/g, ' ').slice(0, 200);
    lines.push(`There is a separate, unrelated question with the team about: "${original}". The team is handling that one offline. It is NOT your job to remind the customer about it.`);
  } else if (escalationJustCreated) {
    lines.push('A separate handoff to the team has just been triggered. Do NOT mention it in your reply.');
  } else {
    lines.push('A separate handoff to the team is in progress. Do NOT mention it in your reply.');
  }
  lines.push('');
  lines.push('How to reply RIGHT NOW:');
  lines.push('- Read the customer\'s CURRENT message and respond to THAT.');
  if (hasImage) {
    lines.push('- The customer attached an image to THIS message; it is included with the message as a real image you can see. Look at it and respond to what it actually shows. If a brand or model is clearly legible, you may match it against the warehouse stock block and answer under the normal pricing rules. If it is not legible or not in stock, say what you can see and ask ONE clarifying question. NEVER guess a model number, capacity, or spec from an unclear photo.');
  }
  lines.push('- ANSWER directly from the warehouse stock block and the owner-taught knowledge facts. Stock status (per Abuja and per Lagos), prices, and product options are in those blocks. Use them.');
  lines.push('- Do NOT say "the team will reach out", "the team will follow up", "the team is on it", "the Sales Manager will confirm", "the specialist will confirm", "we will share the figure shortly", "we will get back to you", or any variant. Those phrases are BANNED in this turn.');
  lines.push('- Do NOT echo back invented quantities, model numbers, prices, or order sizes (for example "100-unit order") that the customer has NOT actually said in their messages. If a prior outbound message of yours mentioned such a thing without the customer saying it, that was a mistake and you must NOT repeat it. Re-read the customer\'s actual messages to find what they actually want.');
  lines.push('- If the customer\'s current message is a casual remark or filler ("hmm", "interesting", "ok", "noted"), reply with one short phrase (e.g. "Got it.") and stop.');
  lines.push('- Only mention the separate handoff if the customer explicitly asks about its status (for example "any update?", "still waiting", "when will I hear back").');
  lines.push('- No URLs. No phone numbers. No wa.me links.');
  lines.push('- Maximum two short sentences. No bullet lists. No price-list dumps. Vary phrasing across replies.');
  return lines.join('\n');
}

function pickUnsupportedReply() {
  return UNSUPPORTED_REPLY;
}

function extractCallEvents(payload) {
  const out = [];
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (change.field !== 'calls') continue;
      const value = change.value || {};
      for (const call of value.calls || []) {
        out.push({
          id: call.id,
          from: call.from,
          status: call.status || null,
          event_type: call.event || null,
          timestamp: call.timestamp || null
        });
      }
    }
  }
  return out;
}

const CALL_AUTOREPLY = "Hello, this number isn't monitored for voice calls. Please send a text message and the Electro-Sun team will respond.";
const CALL_AUTOREPLY_MIN_INTERVAL_MS = 60 * 60 * 1000;
const CALL_AUTOREPLY_RECENT = new Map();

// Alert-only sales desks (Abuja / Lagos): Sunny notifies them of leads but does
// NOT converse with them (no relay, no Owner Q&A, per owner directive). Their
// inbound used to be dropped silently, so the team saw nothing in the admin and
// got no reply. Now: persist the message (so it shows under the desk's Owner
// Chat thread) and send a generic, throttled acknowledgement that takes no
// instruction. Throttle stops a chatty desk from getting the same ack repeatedly.
const ALERT_DESK_ACK = "Thanks. This line delivers Electro-Sun lead alerts and isn't monitored for replies. To act on a customer, please use the admin dashboard or contact the customer directly.";
const ALERT_DESK_ACK_MIN_INTERVAL_MS = 60 * 60 * 1000;
const ALERT_DESK_ACK_RECENT = new Map();

async function handleAlertOnlyMessage(msg) {
  // Persist the inbound so it is visible in the admin (Owner Chat -> the desk's
  // tab), even though Sunny will not act on it.
  let contact = null;
  let conversation = null;
  try {
    contact = getOrCreateContact(msg.from, msg.profileName);
    conversation = getActiveConversation(contact.id);
    appendMessage(conversation.id, 'inbound', msg.body || `[${msg.kind || 'message'}]`, {
      whatsapp_message_id: msg.id,
      intent: 'alert_desk_inbound'
    });
  } catch (err) {
    logger.warn('handler.alert_desk.persist_inbound_fail', { message: err.message, from_tail: String(msg.from || '').slice(-4) });
  }

  // Generic ack, throttled per desk so a back-and-forth doesn't spam the line.
  const lastAck = ALERT_DESK_ACK_RECENT.get(msg.from) || 0;
  const now = Date.now();
  if (now - lastAck < ALERT_DESK_ACK_MIN_INTERVAL_MS) {
    logger.info('handler.alert_desk.ack_throttled', { from_tail: String(msg.from || '').slice(-4) });
    return;
  }
  ALERT_DESK_ACK_RECENT.set(msg.from, now);
  try {
    const sendRes = await sendMessage(msg.from, ALERT_DESK_ACK);
    if (conversation) {
      appendMessage(conversation.id, 'outbound', ALERT_DESK_ACK, {
        whatsapp_message_id: sendRes && sendRes.messageId,
        intent: 'alert_desk_ack',
        language: 'english'
      });
    }
    logger.info('handler.alert_desk.ack_sent', { from_tail: String(msg.from || '').slice(-4) });
  } catch (err) {
    logger.warn('handler.alert_desk.ack_fail', { message: err.message, from_tail: String(msg.from || '').slice(-4) });
  }
}

async function handleCallEvent(call) {
  if (!call.from) return;
  const lastSent = CALL_AUTOREPLY_RECENT.get(call.from) || 0;
  const now = Date.now();
  if (now - lastSent < CALL_AUTOREPLY_MIN_INTERVAL_MS) {
    logger.info('handler.call.autoreply_throttled', { from: call.from });
    return;
  }
  CALL_AUTOREPLY_RECENT.set(call.from, now);
  try {
    const contact = getOrCreateContact(call.from, null);
    const conversation = getActiveConversation(contact.id);
    const sendRes = await sendMessage(call.from, CALL_AUTOREPLY);
    appendMessage(conversation.id, 'outbound', CALL_AUTOREPLY, {
      whatsapp_message_id: sendRes.messageId,
      intent: 'call_autoreply'
    });
    logEvent(contact.id, 'call_received', { call_id: call.id, status: call.status });
    logger.info('handler.call.autoreply_sent', { from: call.from, call_id: call.id });
  } catch (err) {
    logger.error('handler.call.fail', { from: call.from, message: err.message });
  }
}

// Meta delivery-status callbacks (sent / delivered / read / failed). These
// arrive on the same webhook as inbound messages but were previously dropped,
// so a `whatsapp.send.ok` (Meta ACCEPTED the call) gave false confidence about
// whether an alert actually reached the recipient's phone. Logging them surfaces
// the truth, especially the 24h-window silent drop, which shows up as a `failed`
// status with error code 131047 / 131026 ("re-engagement"/"message undeliverable").
function extractStatuses(payload) {
  const out = [];
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const s of value.statuses || []) {
        out.push({ id: s.id, status: s.status, recipient: s.recipient_id, errors: s.errors || [] });
      }
    }
  }
  return out;
}

function logDeliveryStatuses(payload) {
  let statuses = [];
  try { statuses = extractStatuses(payload); }
  catch (err) { logger.warn('handler.status.extract_fail', { message: err.message }); return; }
  for (const s of statuses) {
    const base = { messageId: s.id, status: s.status, to_tail: String(s.recipient || '').slice(-4) };
    if (s.status === 'failed' || (s.errors && s.errors.length)) {
      const e = (s.errors && s.errors[0]) || {};
      logger.warn('whatsapp.delivery.failed', {
        ...base,
        error_code: e.code,
        error_title: e.title,
        error_message: e.message || (e.error_data && e.error_data.details) || null
      });
    } else {
      logger.info('whatsapp.delivery.status', base);
    }
  }
}

function extractMessages(payload) {
  const out = [];
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const profileNameByPhone = {};
      for (const c of contacts) {
        if (c.wa_id) profileNameByPhone[c.wa_id] = c.profile?.name || null;
      }
      for (const msg of value.messages || []) {
        const base = {
          from: msg.from,
          id: msg.id,
          timestamp: msg.timestamp,
          type: msg.type,
          profileName: profileNameByPhone[msg.from] || null,
          replyToId: msg.context?.id || null
        };
        if (msg.type === 'text' && msg.text?.body) {
          out.push({ ...base, kind: 'text', body: msg.text.body });
        } else if (msg.type === 'image' && msg.image?.id) {
          out.push({
            ...base,
            kind: 'image',
            body: msg.image.caption || '',
            media: {
              id: msg.image.id,
              mimeType: msg.image.mime_type || 'image/jpeg',
              sha256: msg.image.sha256 || null
            }
          });
        } else if ((msg.type === 'audio' && msg.audio?.id) || (msg.type === 'voice' && msg.voice?.id)) {
          const a = msg.audio || msg.voice;
          out.push({
            ...base,
            kind: 'audio',
            body: '',
            media: {
              id: a.id,
              mimeType: a.mime_type || 'audio/ogg',
              sha256: a.sha256 || null
            }
          });
        } else if (msg.type === 'reaction') {
          // Emoji reaction (long-press 👍/❤️/🙏 on one of our messages). A
          // reaction is a passive acknowledgement, not a question. Persist it
          // for admin visibility but NEVER reply, otherwise Sunny nags the
          // customer with the "type your question" line for a thumbs-up.
          out.push({
            ...base,
            kind: 'reaction',
            body: msg.reaction?.emoji || '',
            reactedToId: msg.reaction?.message_id || null
          });
        } else if (msg.type === 'system') {
          // WhatsApp control notification (NOT a customer message): almost
          // always a "customer changed their phone number / security code"
          // event. It carries no question and no media. Persist it for admin
          // visibility but NEVER reply, otherwise Sunny answers a number-change
          // notice with the "this number receives text messages only" nag.
          out.push({
            ...base,
            kind: 'system',
            body: msg.system?.body || '',
            systemType: msg.system?.type || null,
            newWaId: msg.system?.wa_id || msg.system?.new_wa_id || null
          });
        } else {
          logger.info('webhook.message.unsupported_type', { type: msg.type, id: msg.id });
          out.push({ ...base, kind: 'unsupported' });
        }
      }
    }
  }
  return out;
}

const ADMIN_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://sunny-electrosun-production.up.railway.app').replace(/\/+$/, '');

const ESCALATION_HEADERS = {
  hot_lead: 'HOT LEAD, customer is ready to pay.',
  dealer_pricing: 'DEALER PRICING REQUEST, customer wants volume tier pricing.',
  negotiation: 'NEGOTIATION, customer is asking for a discount or counter-offer.',
  repeat_complex: 'REPEAT CLIENT, returning customer with a complex ask.',
  big_project: 'BIG PROJECT, 30kW+ install / EPC enquiry.',
  bulk_order: 'BULK ORDER, customer wants a multi-unit quantity, confirm bulk price.',
  live_agent: 'LIVE AGENT REQUEST, customer asked to speak with a person.',
  silent_query: 'FOLLOW-UP NEEDED, customer is waiting on a team answer.'
};

// Escalation types that should create a pending_queries row and route
// subsequent inbounds through the follow-up branch. silent_query is the
// historical default; dealer_pricing was added 2026-05-15 so dealer
// follow-ups get the same loop-prevention treatment plus a dealer-specific
// reply tone.
const PENDING_BACKED_ESCALATIONS = new Set(['silent_query', 'dealer_pricing']);

function escalationHeader(type) {
  return ESCALATION_HEADERS[type] || ESCALATION_HEADERS.silent_query;
}

function formatConversationBriefForOwner(contactId, maxTurns = 6) {
  try {
    const conv = getActiveConversation(contactId);
    if (!conv || !conv.id) return null;
    const rows = getMessagesForConversation(conv.id) || [];
    if (rows.length === 0) return null;
    const tail = rows.slice(-maxTurns);
    const briefLines = [];
    for (const r of tail) {
      const who = r.direction === 'inbound' ? 'Customer' : 'Sunny';
      let stamp = '';
      if (r.timestamp) {
        const d = new Date(r.timestamp.includes('T') ? r.timestamp : r.timestamp.replace(' ', 'T') + 'Z');
        if (!isNaN(d)) {
          stamp = `[${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}] `;
        }
      }
      const body = String(r.body || '').replace(/\s+/g, ' ').trim();
      const truncated = body.length > 220 ? body.slice(0, 217) + '...' : body;
      briefLines.push(`${stamp}${who}: ${truncated}`);
    }
    return briefLines.join('\n');
  } catch (err) {
    logger.warn('escalation.brief_build_fail', { message: err.message, contactId });
    return null;
  }
}

function buildAdminConversationLink(conversationId) {
  if (!conversationId) return null;
  return `${ADMIN_BASE_URL}/admin#conv=${conversationId}`;
}

const OWNER_ALERT_TEMPLATE = process.env.OWNER_ALERT_TEMPLATE || 'owner_escalation_alert_en';
const OWNER_ALERT_TEMPLATE_LANG = process.env.OWNER_ALERT_TEMPLATE_LANG || 'en';

// Send an owner / sales-desk alert. Prefer the approved template (window-
// independent, so Meta does not silently drop it when the recipient has been
// quiet for more than 24h), and fall back to the free-form text if the
// template send fails (which also covers the period while the template is
// still PENDING approval, or if OWNER_ALERT_TEMPLATE is unset/wrong). Mirrors
// src/audit.js > sendOwnerAuditPing. The readable free-form text is what the
// caller persists to the Owner Chat thread either way.
async function sendOwnerAlert(ownerPhone, alertText, components) {
  let sendRes = null;
  let via = 'template';
  if (components) {
    try {
      sendRes = await sendTemplate(ownerPhone, OWNER_ALERT_TEMPLATE, OWNER_ALERT_TEMPLATE_LANG, components);
    } catch (err) {
      sendRes = { ok: false, error: err.message };
    }
    if (!sendRes || !sendRes.ok) {
      logger.warn('escalation.alert_template_failed_falling_back', {
        template: OWNER_ALERT_TEMPLATE,
        error: sendRes && sendRes.error
      });
    }
  }
  if (!sendRes || !sendRes.ok) {
    sendRes = await sendMessage(ownerPhone, alertText);
    via = 'free_form';
  }
  logger.info('escalation.alert_sent', {
    via,
    to_tail: String(ownerPhone).slice(-4),
    messageId: sendRes && sendRes.messageId
  });
  return sendRes;
}

async function notifyOwnerEscalation(contact, message, classification, recipientPhone) {
  // recipientPhone is resolved once by the caller (after throttles pass) so the
  // Category 2 round-robin is not consumed by a throttled alert and the HOT
  // retry does not double-flip. Falls back to OWNER_WHATSAPP.
  const ownerPhone = recipientPhone || process.env.OWNER_WHATSAPP;
  if (!ownerPhone) {
    logger.warn('escalation.no_owner_phone');
    return null;
  }

  const rawType = classification && classification.escalation_type;
  const escalationType = ESCALATION_HEADERS[rawType] ? rawType : 'silent_query';

  // Concise brief, not a transcript (2026-06-06). The summary + client-facing
  // follow-up draft ride on the classifier output (classification.owner_brief
  // / owner_followup_draft); buildOwnerAlertText handles the fallbacks when
  // those are absent (synthetic classifications).
  const alertHeader = escalationHeader(escalationType);
  const alertText = buildOwnerAlertText(contact, classification, alertHeader, message);
  const alertComponents = buildOwnerAlertTemplateComponents(contact, classification, alertHeader, message);
  const sendRes = await sendOwnerAlert(ownerPhone, alertText, alertComponents);
  try {
    const ownerContact = getOrCreateContact(ownerPhone, null);
    const ownerConv = getActiveConversation(ownerContact.id);
    appendMessage(ownerConv.id, 'outbound', alertText, {
      whatsapp_message_id: sendRes && sendRes.messageId,
      intent: escalationType === 'hot_lead' ? 'escalation_alert_hot' : 'escalation_alert_silent',
      language: 'english'
    });
  } catch (err) {
    logger.warn('escalation.persist_owner_alert_fail', { message: err.message });
  }
  return sendRes;
}

async function handleOwnerReply(msg, pending) {
  if (pending.status !== 'pending') {
    logger.info('handler.owner_reply.already_resolved', { queryId: pending.id, status: pending.status });
    return;
  }

  const ownerContact = getOrCreateContact(msg.from, msg.profileName);
  const ownerConv = getActiveConversation(ownerContact.id);
  appendMessage(ownerConv.id, 'inbound', msg.body, {
    whatsapp_message_id: msg.id,
    intent: 'owner_reply_to_query'
  });

  const customer = getContactById(pending.contact_id);
  if (!customer) {
    logger.error('handler.owner_reply.customer_not_found', {
      queryId: pending.id,
      contactId: pending.contact_id
    });
    return;
  }

  const sendRes = await sendMessage(customer.phone, msg.body);
  if (!sendRes.ok) {
    logger.error('handler.owner_reply.customer_send_failed', {
      queryId: pending.id,
      customerPhone: customer.phone,
      status: sendRes.status
    });
    return;
  }

  const customerConv = getActiveConversation(customer.id);
  appendMessage(customerConv.id, 'outbound', msg.body, {
    whatsapp_message_id: sendRes.messageId,
    intent: 'owner_provided_answer'
  });

  resolvePendingQuery(pending.id, msg.body);

  const elapsedMs = Date.now() - new Date(pending.created_at).getTime();
  logEvent(customer.id, 'silent_query_resolved', {
    queryId: pending.id,
    by: 'owner',
    elapsed_ms: elapsedMs
  });
  logger.info('handler.owner_reply.routed', {
    queryId: pending.id,
    customerPhone: customer.phone,
    elapsedMs
  });
}

// --- Owner Q&A capability layer (2026-07-05 owner directive: the agent must
// answer ANYTHING the two owners ask, in detail: chat transcripts, datasheets,
// any data). Deterministic fast-paths run first (transcript send, datasheet
// send); everything else goes to the LLM with a "customer in focus" context
// block when the question references a specific customer.

const OWNER_DATASHEET_ASK_RE = /\b(data\s*sheet|datasheet|brochure|spec\s*sheet|specification\s*sheet|specs?\s*(sheet|pdf|file|document)|technical\s*(sheet|specs?)|product\s*(sheet|brochure|manual|guide|pdf)|user\s*(manual|guide))\b/i;
const OWNER_TRANSCRIPT_ASK_RE = /\b(?:send|show|share|give|forward|see|read|pull)\b[^.?!]{0,60}\b(?:chat|conversation|transcript|history|messages?)\b|\b(?:his|her|their)\s+(?:chat|conversation|messages?|history)\b|\bchat\s+transcript\b|\bfull\s+(?:chat|conversation)\b/i;

function extractCustomerPhoneDigits(text) {
  const team = new Set(ownerRouting.teamPhoneDigits());
  const matches = String(text || '').match(/\+?\d[\d\s-]{8,18}\d/g) || [];
  for (const m of matches) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 15 && !team.has(d)) return d;
  }
  return null;
}

function findCustomerContactByPhoneDigits(d) {
  if (!d) return null;
  const { getDb } = require('../db/init');
  const db = getDb();
  const tail = d.slice(-10);
  const rows = db.prepare(`SELECT * FROM contacts WHERE phone LIKE ? ORDER BY last_active DESC LIMIT 5`).all(`%${tail}`);
  const team = new Set(ownerRouting.teamPhoneDigits());
  for (const r of rows) {
    const rd = String(r.phone || '').replace(/\D/g, '');
    if (!team.has(rd)) return r;
  }
  return null;
}

// The most recent customer number mentioned anywhere in this owner's own
// thread (escalation alerts, Q&A replies, the owner's messages). Lets "send
// his chat" resolve to the hot lead Sunny just reported without re-typing the
// number.
function lastCustomerPhoneInOwnerThread(ownerConvId) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const rows = db.prepare(`SELECT body FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 25`).all(ownerConvId);
  for (const r of rows) {
    const d = extractCustomerPhoneDigits(r.body);
    if (d) return d;
  }
  return null;
}

function chunkText(text, maxLen = 3500) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

async function trySendDatasheetToOwner(msg, ownerConv) {
  if (!OWNER_DATASHEET_ASK_RE.test(msg.body || '')) return false;
  let match = null;
  try {
    match = warehouse.findItemDatasheetByQuery(msg.body, '');
  } catch (err) {
    logger.warn('handler.owner_qa.datasheet_lookup_fail', { message: err.message });
  }
  if (!match || !match.item || !match.item.datasheet_path) return false;
  const item = match.item;
  try {
    let mediaId = item.datasheet_meta_media_id;
    const fresh = mediaId && warehouse.isMetaMediaFresh(item.datasheet_meta_uploaded_at);
    if (!fresh) {
      mediaId = await uploadMediaToMeta(item.datasheet_path, item.datasheet_mime, item.datasheet_filename);
      warehouse.setItemDatasheetMetaCache(item.id, mediaId);
    }
    const caption = `${item.brand || ''} ${item.model || ''} datasheet`.trim();
    const docRes = await sendDocument(msg.from, mediaId, item.datasheet_filename, caption);
    appendMessage(ownerConv.id, 'outbound', `[Datasheet sent: ${caption}]`, {
      whatsapp_message_id: docRes.messageId,
      intent: 'owner_datasheet_sent'
    });
    logger.info('handler.owner_qa.datasheet_sent', { owner: msg.from, warehouse_item_id: item.id });
    return true;
  } catch (err) {
    logger.warn('handler.owner_qa.datasheet_send_fail', { message: err.message });
    return false;
  }
}

function buildCustomerFocusBlock(target) {
  const brief = formatConversationBriefForOwner(target.id, 30);
  return [
    `Customer: ${target.name || 'unknown name'} (${target.phone})`,
    `category=${target.category || 'n/a'}, temperature=${target.lead_temperature || 'n/a'}, client_type=${target.client_type || 'n/a'}, location=${target.location || 'n/a'}`,
    `products_asked_about=${target.products_asked_about || 'n/a'}, budget_mentioned=${target.budget_mentioned || 'n/a'}, last_active=${target.last_active || 'n/a'}`,
    '',
    'Recent conversation (oldest first):',
    brief || '(no messages found)'
  ].join('\n');
}

async function handleOwnerNonQueryMessage(msg) {
  const ownerContact = getOrCreateContact(msg.from, msg.profileName);
  const ownerConv = getActiveConversation(ownerContact.id);

  appendMessage(ownerConv.id, 'inbound', msg.body, {
    whatsapp_message_id: msg.id,
    intent: 'owner_question'
  });

  logger.info('handler.owner_qa.received', {
    ownerPhone: msg.from,
    preview: (msg.body || '').slice(0, 120)
  });

  // Fast-path 1: owner asks for a datasheet, send the actual file.
  if (await trySendDatasheetToOwner(msg, ownerConv)) return;

  // Resolve the customer this question is about: an explicit number in the
  // message wins; otherwise, for transcript-style asks, the last customer
  // number mentioned in this owner's thread (e.g. the hot lead just reported).
  const explicitDigits = extractCustomerPhoneDigits(msg.body);
  const wantsTranscript = OWNER_TRANSCRIPT_ASK_RE.test(msg.body || '');
  const targetDigits = explicitDigits || (wantsTranscript ? lastCustomerPhoneInOwnerThread(ownerConv.id) : null);
  const target = targetDigits ? findCustomerContactByPhoneDigits(targetDigits) : null;

  // Fast-path 2: owner asks for a chat/transcript, send it verbatim (chunked).
  if (wantsTranscript && target) {
    const brief = formatConversationBriefForOwner(target.id, 40);
    const head = `Chat with ${target.name || target.phone} (${target.phone}):`;
    const full = brief ? `${head}\n\n${brief}` : `${head}\n(No messages found.)`;
    for (const chunk of chunkText(full)) {
      const sendRes = await sendMessage(msg.from, chunk);
      appendMessage(ownerConv.id, 'outbound', chunk, {
        whatsapp_message_id: sendRes.messageId,
        intent: 'owner_transcript'
      });
    }
    logger.info('handler.owner_qa.transcript_sent', { owner: msg.from, target_contact_id: target.id });
    return;
  }

  // Everything else: Owner Q&A, with the referenced customer's details and
  // transcript injected so the model can answer in full detail.
  const extraContext = target ? buildCustomerFocusBlock(target) : null;
  const reply = await answerOwnerQuestion(ownerContact.id, msg.body, { extraContext });

  for (const chunk of chunkText(reply)) {
    const sendRes = await sendMessage(msg.from, chunk);
    appendMessage(ownerConv.id, 'outbound', chunk, {
      whatsapp_message_id: sendRes.messageId,
      intent: 'owner_qa_reply'
    });
  }
}

// Boot-time hygiene: team numbers (owners, sales desks, developer) must never
// carry lead tags. A team member who messaged Sunny before being configured in
// env (or via a non-text message before the 2026-07-05 guard) may have been
// classified as a lead; the admin header chips read the raw contact row, so
// Charbel showed as HOT/SERIOUS/RESIDENTIAL. Null the lead fields for every
// team contact. Idempotent, env-driven, runs at every boot.
function scrubTeamContactLeadTags() {
  const { getDb } = require('../db/init');
  const db = getDb();
  const team = new Set(ownerRouting.teamPhoneDigits());
  if (!team.size) return { scrubbed: 0 };
  const rows = db.prepare(`SELECT id, phone, category, lead_temperature, client_type FROM contacts`).all();
  let scrubbed = 0;
  for (const r of rows) {
    const d = String(r.phone || '').replace(/\D/g, '');
    if (!team.has(d)) continue;
    if (r.category == null && r.lead_temperature == null && r.client_type == null) continue;
    db.prepare(`UPDATE contacts SET category = NULL, lead_temperature = NULL, client_type = NULL WHERE id = ?`).run(r.id);
    scrubbed++;
    logger.info('handler.team_contact_lead_tags_scrubbed', { contactId: r.id, phone_tail: d.slice(-4) });
  }
  return { scrubbed };
}

async function handleUnsupported(msg) {
  const contact = getOrCreateContact(msg.from, msg.profileName);
  const conversation = getActiveConversation(contact.id);
  const language = contact.language || 'english';

  appendMessage(conversation.id, 'inbound', `[unsupported_${msg.type}]`, {
    whatsapp_message_id: msg.id,
    intent: 'unsupported_type'
  });

  logEvent(contact.id, 'unsupported_received', { type: msg.type, whatsappId: msg.id });

  const reply = pickUnsupportedReply();
  const sendRes = await sendMessage(msg.from, reply);
  appendMessage(conversation.id, 'outbound', reply, {
    whatsapp_message_id: sendRes.messageId,
    intent: 'unsupported_reply',
    language
  });
}

// Emoji reaction handler: store for admin visibility, never reply. A reaction
// (👍/❤️/🙏 long-pressed on one of our messages) is a passive acknowledgement,
// not a question, so it must not trigger the "type your question" nag.
async function handleReaction(msg) {
  const contact = getOrCreateContact(msg.from, msg.profileName);
  const conversation = getActiveConversation(contact.id);

  const emoji = msg.body || '';
  const body = emoji ? `[reacted: ${emoji}]` : '[reaction removed]';
  appendMessage(conversation.id, 'inbound', body, {
    whatsapp_message_id: msg.id,
    intent: 'reaction',
    reacted_to_wamid: msg.reactedToId || null
  });

  logEvent(contact.id, 'reaction_received', {
    emoji: emoji || null,
    reactedToId: msg.reactedToId || null,
    whatsappId: msg.id
  });
}

// WhatsApp `system` notification handler (e.g. customer changed their phone
// number / security code). Persist a marker for admin visibility, log the
// event, and NEVER reply. A system notice is not a customer question, so it
// must not trigger the "this number receives text messages only" nag.
async function handleSystemMessage(msg) {
  const contact = getOrCreateContact(msg.from, msg.profileName);
  const conversation = getActiveConversation(contact.id);

  const body = msg.body ? `[system: ${msg.body}]` : `[system notification: ${msg.systemType || 'event'}]`;
  appendMessage(conversation.id, 'inbound', body, {
    whatsapp_message_id: msg.id,
    intent: 'system_notification'
  });

  logEvent(contact.id, 'system_notification', {
    systemType: msg.systemType || null,
    newWaId: msg.newWaId || null,
    whatsappId: msg.id
  });
}

const MESSAGE_DEBOUNCE_MS = parseInt(process.env.MESSAGE_DEBOUNCE_MS || '6000', 10);
const PENDING_INBOUND = new Map();
// B-#1 instrumentation (2026-06-08): observe the double/triple-reply pattern.
// LOGGING ONLY, no behavior change. Each fired batch gets a sequence id and we
// record the gap since the previous batch for the same contact. If a contact
// gets two replies we can tell whether two batches fired (debounce window vs
// burst typing) or one batch produced two sends (a real double-fire bug).
let BATCH_SEQ = 0;
const LAST_BATCH_FIRED_AT = new Map();

function enqueueCustomerMessage(contact, conversation, msg, imageAttachment, imageStorage, persistedBody) {
  const key = contact.id;
  let entry = PENDING_INBOUND.get(key);
  if (!entry) {
    entry = { msgs: [], attachments: [], persistedBodies: [], contact, conversation, timer: null };
    PENDING_INBOUND.set(key, entry);
  }
  entry.contact = contact;
  entry.conversation = conversation;
  entry.msgs.push(msg);
  entry.persistedBodies.push(persistedBody);
  if (imageAttachment) entry.attachments.push(imageAttachment);
  if (imageStorage) entry.imageStorage = imageStorage;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    PENDING_INBOUND.delete(key);
    entry.batchId = ++BATCH_SEQ;
    const firedAt = Date.now();
    const prevFiredAt = LAST_BATCH_FIRED_AT.get(key);
    LAST_BATCH_FIRED_AT.set(key, firedAt);
    logger.info('handler.batch.fired', {
      contactId: key,
      batchId: entry.batchId,
      queue_size: entry.msgs.length,
      gap_since_last_fire_ms: prevFiredAt ? firedAt - prevFiredAt : null,
      debounce_ms: MESSAGE_DEBOUNCE_MS,
      first_msg: String((entry.msgs[0] && entry.msgs[0].body) || '').slice(0, 60),
      last_msg: String((entry.msgs[entry.msgs.length - 1] && entry.msgs[entry.msgs.length - 1].body) || '').slice(0, 60)
    });
    processCustomerBatch(entry)
      .then(() => {
        logger.info('handler.batch.completed', {
          contactId: key,
          batchId: entry.batchId,
          duration_ms: Date.now() - firedAt
        });
      })
      .catch(err => {
        logger.error('handler.batch.process_fail', {
          contactId: key,
          batchId: entry.batchId,
          message: err.message,
          stack: err.stack
        });
      });
  }, MESSAGE_DEBOUNCE_MS);

  logger.info('handler.batch.enqueued', {
    contactId: key,
    queue_size: entry.msgs.length,
    debounce_ms: MESSAGE_DEBOUNCE_MS
  });
}

async function notifyOwnerForEscalation({ contact, classification, safeCombinedText, lastMsg, batchSize, source }) {
  const escalationType = classification.escalation_type || 'silent_query';

  logEvent(contact.id, 'escalated', {
    intent: classification.intent,
    escalation_type: escalationType,
    confidence: classification.confidence,
    batch_size: batchSize,
    source: source || 'classifier'
  });

  // HOT flow auto-resolves any prior open silent_query (the customer is now
  // closing the deal, the older question is moot).
  if (escalationType === 'hot_lead') {
    try {
      const stale = getOpenPendingQueryForContact(contact.id);
      if (stale && stale.id) {
        resolvePendingQuery(stale.id, '[auto-resolved: HOT lead handoff fired]');
        logger.info('handler.escalation.pending_query_auto_resolved_by_hot', {
          contactId: contact.id,
          queryId: stale.id
        });
      }
    } catch (err) {
      logger.warn('handler.escalation.pending_query_auto_resolve_fail', { message: err.message });
    }
  }

  // For silent_query: if there's already an open pending query for this
  // contact, throttle follow-up pings via FOLLOWUP_COOLDOWN. Otherwise create
  // a fresh pending query AND fire a brand-new alert (subject to the
  // brand-new escalation cooldown).
  let freshPendingId = null;
  if (PENDING_BACKED_ESCALATIONS.has(escalationType)) {
    const existingOpen = getOrAutoResolveStalePending(contact.id);
    if (existingOpen && existingOpen.id) {
      const followThrottle = security.checkFollowupThrottle(contact.id);
      if (!followThrottle.allowed) {
        security.logSecurityEvent('followup_throttled', {
          contactId: contact.id,
          last_at: followThrottle.lastAt,
          cooldown_ms: followThrottle.cooldownMs,
          queryId: existingOpen.id,
          source: source || 'classifier'
        });
        return {
          openPending: existingOpen,
          freshPendingId: null,
          ownerNotified: false,
          escalationType,
          throttled: true
        };
      }
      // Send a brief follow-up ping rather than the full alert. Routes to the
      // same recipient as the original alert: a big-project case already has a
      // sticky owner (so resolveRecipient returns it without flipping), and a
      // daily sale is deterministic by region.
      const followRouted = ownerRouting.resolveRecipient(contact, classification);
      const ownerPhone = followRouted.number || process.env.OWNER_WHATSAPP;
      let followSendRes = null;
      if (ownerPhone) {
        // Same concise shape as the main alert, just a repeat-ping header.
        const followHeader = 'FOLLOW-UP, same customer is still asking on the pending query.';
        const followText = buildOwnerAlertText(contact, classification, followHeader, safeCombinedText);
        const followComponents = buildOwnerAlertTemplateComponents(
          contact,
          classification,
          followHeader,
          safeCombinedText
        );
        followSendRes = await sendOwnerAlert(ownerPhone, followText, followComponents);
        try {
          const ownerContact = getOrCreateContact(ownerPhone, null);
          const ownerConv = getActiveConversation(ownerContact.id);
          appendMessage(ownerConv.id, 'outbound', followText, {
            whatsapp_message_id: followSendRes && followSendRes.messageId,
            intent: 'escalation_followup_ping',
            language: 'english'
          });
        } catch (err) {
          logger.warn('escalation.persist_owner_followup_fail', { message: err.message });
        }
      }
      return {
        openPending: existingOpen,
        freshPendingId: null,
        ownerNotified: !!(followSendRes && followSendRes.ok),
        escalationType,
        recipientNumber: ownerPhone,
        recipientLabel: followRouted.label
      };
    }
  }

  // HOT leads have their own short throttle (60s default, configurable). Regular
  // 30-min throttle was eating real HOT alerts when a customer escalated twice
  // in the same conversation. A HOT signal must always reach the owner; the
  // 60s cap is only to defang back-to-back identical retries.
  if (escalationType === 'hot_lead') {
    const hotThrottle = security.checkHotEscalationThrottle(contact.id);
    if (!hotThrottle.allowed) {
      security.logSecurityEvent('hot_escalation_throttled', {
        contactId: contact.id,
        last_at: hotThrottle.lastAt,
        cooldown_ms: hotThrottle.cooldownMs,
        source: source || 'classifier'
      });
      return { openPending: null, freshPendingId: null, ownerNotified: false, escalationType, throttled: true };
    }
  } else {
    const escThrottle = security.checkEscalationThrottle(contact.id);
    if (!escThrottle.allowed) {
      security.logSecurityEvent('escalation_throttled', {
        contactId: contact.id,
        last_at: escThrottle.lastAt,
        cooldown_ms: escThrottle.cooldownMs,
        escalation_type: escalationType,
        source: source || 'classifier'
      });
      return { openPending: null, freshPendingId: null, ownerNotified: false, escalationType, throttled: true };
    }
  }

  // Create the pending_queries row for any pending-backed escalation type
  // (silent_query, dealer_pricing) so subsequent customer messages route
  // through the open-pending follow-up path (single ping per cooldown window)
  // instead of hammering the brother with brand-new alerts.
  if (PENDING_BACKED_ESCALATIONS.has(escalationType)) {
    try {
      freshPendingId = createPendingQuery({
        contactId: contact.id,
        customerMessageId: lastMsg && lastMsg.id,
        customerMessageText: safeCombinedText,
        classifierIntent: classification.intent || escalationType
      });
    } catch (err) {
      logger.warn('handler.escalation.create_pending_query_fail', { message: err.message, escalationType });
    }
  }

  // Resolve the recipient ONCE here, after all throttles passed, so a throttled
  // alert never consumes a Category 2 round-robin slot. The same number is
  // reused on the HOT retry below (no double-flip).
  const routed = ownerRouting.resolveRecipient(contact, classification);
  const recipientPhone = routed.number || process.env.OWNER_WHATSAPP;

  let alertSendRes = await notifyOwnerEscalation(contact, safeCombinedText, classification, recipientPhone);
  // HOT alerts get one retry after a short delay if the first send fails. A
  // missed HOT alert means the brother doesn't find out a customer is ready
  // to pay; that's a much worse outcome than a duplicate send.
  if ((!alertSendRes || !alertSendRes.ok) && escalationType === 'hot_lead') {
    logger.warn('handler.escalation.hot_alert_first_send_failed_retrying', {
      contactId: contact.id,
      first_status: alertSendRes && alertSendRes.status,
      first_error: alertSendRes && alertSendRes.error
    });
    await new Promise(r => setTimeout(r, 1500));
    alertSendRes = await notifyOwnerEscalation(contact, safeCombinedText, classification, recipientPhone);
  }
  const ownerNotified = !!(alertSendRes && alertSendRes.ok);
  if (!ownerNotified) {
    logger.error('handler.escalation.owner_alert_send_failed', {
      contactId: contact.id,
      escalation_type: escalationType,
      send_status: alertSendRes && alertSendRes.status,
      send_error: alertSendRes && alertSendRes.error
    });
  }
  if (freshPendingId && alertSendRes && alertSendRes.messageId) {
    try { setPendingQueryAlertId(freshPendingId, alertSendRes.messageId); }
    catch (err) { logger.warn('handler.escalation.set_alert_id_fail', { message: err.message }); }
  }

  return {
    openPending: null,
    freshPendingId,
    ownerNotified,
    escalationType,
    recipientNumber: recipientPhone,
    recipientLabel: routed.label
  };
}

async function processCustomerBatch(entry) {
  const { msgs, contact, conversation, attachments, persistedBodies } = entry;
  if (!msgs.length) return;

  const lastMsg = msgs[msgs.length - 1];
  const refreshedContact = { ...contact, ...readBackContact(contact.id) };
  const priorHistory = getRecentHistory(contact.id, 50);

  const combinedTextParts = msgs.map((m, i) => {
    if (m.kind === 'image') {
      return buildImageCombinedPart(m.body, m.imageDescription);
    }
    return m.body;
  });
  const combinedText = combinedTextParts.join('\n');

  logger.info('handler.batch.processing', {
    contactId: contact.id,
    batch_size: msgs.length,
    combined_preview: combinedText.slice(0, 200)
  });

  const batchTrunc = security.truncateBatch(combinedText);
  const safeCombinedText = batchTrunc.text;
  if (batchTrunc.truncated) {
    security.logSecurityEvent('batch_truncated', {
      contactId: contact.id,
      original_length: batchTrunc.original
    });
  }

  // Idle-chatter guard (owner directive 2026-07-11): unproductive turns
  // (non-serviced-script small talk, emoji volleys, bare junk links, dot
  // transcripts) get ONE polite reply per streak, then full silence. Bare junk
  // links never get a reply at all. Runs BEFORE the classifier so a muted turn
  // costs zero LLM calls. A substantive message instantly resets the streak,
  // so a real lead who finally asks about solar always wakes Sunny up.
  {
    const currentWamids = msgs.map(m => m && m.id).filter(Boolean);
    const chatterRes = maybeMuteIdleChatter(contact, conversation, currentWamids, safeCombinedText, attachments);
    if (chatterRes.muted) return;
  }

  // Fix C: detect substantive topic shift in the new inbound and auto-resolve
  // any open pending_query so the classifier and downstream escalation logic
  // see a clean state. Customers who pivot to a new question (dealer status,
  // a different product category, a specific kW size) while waiting on the
  // original query should be answered, not parked in the follow-up loop.
  topicShiftAutoResolve(contact.id, safeCombinedText);

  const classifierMessage = msgs.length > 1
    ? `[Customer sent ${msgs.length} messages back to back]\n${safeCombinedText}`
    : safeCombinedText;

  const classification = await runClassification(refreshedContact, priorHistory, classifierMessage);

  // Datasheet request fast-path: if customer asks for a datasheet/brochure/spec sheet,
  // attempt to match a Warehouse Stock item that has a PDF attached and send that file.
  // Falls through to normal LLM reply on no match or send failure.
  const DATASHEET_REQUEST_RE = /\b(data\s*sheet|datasheet|brochure|spec\s*sheet|specification\s*sheet|specs?\s*(sheet|pdf|file|document)|technical\s*(sheet|specs?)|product\s*(sheet|brochure|manual|guide|pdf)|user\s*(manual|guide))\b/i;
  const customerAskedForDatasheet = DATASHEET_REQUEST_RE.test(safeCombinedText);
  let datasheetSentThisTurn = false;
  if (customerAskedForDatasheet) {
    try {
      const recentText = (priorHistory || []).slice(-6).map(m => String(m.content || '')).join(' ');
      const productsAsked = String(refreshedContact.products_asked_about || '');
      const brandPref = String(refreshedContact.brand_preference || '');
      const enrichedHistory = [recentText, productsAsked, brandPref].filter(Boolean).join(' ');
      const match = warehouse.findItemDatasheetByQuery(safeCombinedText, enrichedHistory);
      logger.info('handler.datasheet.lookup', {
        contactId: contact.id,
        message_preview: safeCombinedText.slice(0, 120),
        match_found: !!(match && match.item),
        matched_item_id: match && match.item && match.item.id,
        matched_model: match && match.item && match.item.model,
        match_score: match && match.score,
        has_path: !!(match && match.item && match.item.datasheet_path),
        has_mime: !!(match && match.item && match.item.datasheet_mime),
        cached_media_id: !!(match && match.item && match.item.datasheet_meta_media_id)
      });
      if (match && match.item && match.item.datasheet_path) {
        const item = match.item;
        let mediaId = item.datasheet_meta_media_id;
        const fresh = mediaId && warehouse.isMetaMediaFresh(item.datasheet_meta_uploaded_at);
        if (!fresh) {
          try {
            mediaId = await uploadMediaToMeta(item.datasheet_path, item.datasheet_mime, item.datasheet_filename);
            warehouse.setItemDatasheetMetaCache(item.id, mediaId);
            logger.info('handler.datasheet.uploaded_to_meta', {
              contactId: contact.id,
              warehouse_item_id: item.id,
              meta_media_id_set: !!mediaId
            });
          } catch (uploadErr) {
            logger.error('handler.datasheet.upload_to_meta_failed', {
              contactId: contact.id,
              warehouse_item_id: item.id,
              filename: item.datasheet_filename,
              mime: item.datasheet_mime,
              path_exists: require('fs').existsSync(item.datasheet_path || ''),
              status: uploadErr.status,
              meta_response: uploadErr.metaResponse ? JSON.stringify(uploadErr.metaResponse).slice(0, 600) : null,
              message: uploadErr.message
            });
            throw uploadErr;
          }
        }
        const caption = `${item.brand} ${item.model} datasheet, from Electro-Sun`;
        const docRes = await sendDocument(lastMsg.from, mediaId, item.datasheet_filename, caption);
        if (docRes && docRes.ok) {
          const noteText = `[Datasheet sent: ${item.brand} ${item.model}]`;
          appendMessage(conversation.id, 'outbound', noteText, {
            whatsapp_message_id: docRes.messageId,
            intent: 'datasheet_sent',
            language: classification.language || 'english'
          });
          logger.info('handler.datasheet.sent', {
            contactId: contact.id,
            warehouse_item_id: item.id,
            score: match.score
          });
          datasheetSentThisTurn = true;
          return;
        }
        logger.warn('handler.datasheet.send_fail_fallback_to_text', {
          contactId: contact.id,
          warehouse_item_id: item.id,
          status: docRes && docRes.status,
          error: docRes && docRes.error,
          meta_response: docRes && JSON.stringify(docRes).slice(0, 400)
        });
      } else {
        logger.info('handler.datasheet.no_match', {
          contactId: contact.id,
          message_preview: safeCombinedText.slice(0, 120)
        });
      }
    } catch (err) {
      logger.error('handler.datasheet.error', {
        contactId: contact.id,
        message: err.message,
        stack: err.stack && err.stack.slice(0, 400)
      });
    }
  }

  // Photo request fast-path: customer asks for photos / pictures / images of an
  // item. Mirrors the datasheet fast-path: regex gate, size-token matcher, Meta
  // upload (with 25-day cache), send. Differences: sends up to PHOTO_SEND_CAP
  // images (default 3) ordered by sort_order, each as a WhatsApp image (not a
  // document), captions optional and rendered inline by WhatsApp.
  //
  // No-match path is louder than datasheets: send a short fallback to the
  // customer AND escalate as silent_query so the owner knows there's a photo
  // gap to fill. Returns early in both the success and the fallback case, so
  // Opus is never given a chance to invent a description of the product.
  // Genuine REQUEST for a product photo. Guard against two false positives seen in
  // production: (1) the customer SENT us an image (our synthetic "[Customer sent an
  // image]" marker literally contains the word "image"); (2) the customer only
  // MENTIONS a picture ("the picture showing in ur advert is 6kw"). So: skip when
  // the customer attached an image this turn, strip our own image markers, and
  // require a real request context (a request verb near the photo word, "photo
  // of/for/please", a bare "photo" message, or "what does it look like").
  const customerSentImage = Array.isArray(attachments) && attachments.length > 0;
  const photoText = String(safeCombinedText || '')
    .replace(/\[Customer sent (?:an image|\d+ images)[^\]]*\]:?/gi, ' ')
    .replace(/\[image\]/gi, ' ')
    .trim();
  const PHOTO_NOUN = '(?:photos?|pictures?|pics?|images?|snaps?)';
  const customerAskedForPhotos = !customerSentImage && (
    new RegExp(`\\b(?:send|share|show|forward|drop|attach|post|see|view|snap|have|got|get)\\b[^.?!]{0,24}\\b${PHOTO_NOUN}\\b`, 'i').test(photoText) ||
    new RegExp(`\\b${PHOTO_NOUN}\\b[^.?!]{0,12}\\b(?:of|for|please|pls|abeg|na)\\b`, 'i').test(photoText) ||
    new RegExp(`^\\s*(?:send\\s+|share\\s+|a\\s+|the\\s+|some\\s+|me\\s+)*${PHOTO_NOUN}\\s*\\??\\s*$`, 'i').test(photoText) ||
    /what\s+does\s+it\s+look\s+like/i.test(photoText) ||
    /how\s+does\s+it\s+look/i.test(photoText)
  );
  let photosSentThisTurn = false;
  if (customerAskedForPhotos) {
    try {
      const recentText = (priorHistory || []).slice(-6).map(m => String(m.content || '')).join(' ');
      const productsAsked = String(refreshedContact.products_asked_about || '');
      const brandPref = String(refreshedContact.brand_preference || '');
      const enrichedHistory = [recentText, productsAsked, brandPref].filter(Boolean).join(' ');
      const match = warehouse.findItemPhotosByQuery(safeCombinedText, enrichedHistory);
      logger.info('handler.photos.lookup', {
        contactId: contact.id,
        message_preview: safeCombinedText.slice(0, 120),
        match_found: !!(match && match.item && match.photos && match.photos.length),
        matched_item_id: match && match.item && match.item.id,
        matched_model: match && match.item && match.item.model,
        match_score: match && match.score,
        photo_count: match && match.photos ? match.photos.length : 0
      });
      if (match && match.item && match.photos && match.photos.length) {
        const item = match.item;
        let sentCount = 0;
        let lastSendFail = null;
        for (const photo of match.photos) {
          let mediaId = photo.meta_media_id;
          const fresh = mediaId && warehouse.isMetaMediaFresh(photo.meta_media_uploaded_at);
          if (!fresh) {
            try {
              mediaId = await uploadMediaToMeta(photo.file_path, photo.mime_type, photo.filename);
              warehouse.setPhotoMetaMediaCache(photo.id, mediaId);
              logger.info('handler.photos.uploaded_to_meta', {
                contactId: contact.id,
                warehouse_item_id: item.id,
                photo_id: photo.id,
                meta_media_id_set: !!mediaId
              });
            } catch (uploadErr) {
              logger.error('handler.photos.upload_to_meta_failed', {
                contactId: contact.id,
                warehouse_item_id: item.id,
                photo_id: photo.id,
                filename: photo.filename,
                mime: photo.mime_type,
                path_exists: require('fs').existsSync(photo.file_path || ''),
                status: uploadErr.status,
                meta_response: uploadErr.metaResponse ? JSON.stringify(uploadErr.metaResponse).slice(0, 600) : null,
                message: uploadErr.message
              });
              lastSendFail = uploadErr.message;
              continue;
            }
          }
          // Caption rule: per-photo caption if set; otherwise only the FIRST
          // image carries a "<brand> <model> photo, from Electro-Sun" caption
          // so the customer's chat has at least one label. Subsequent images
          // come captionless to avoid repetition.
          let caption;
          if (photo.caption && String(photo.caption).trim()) {
            caption = String(photo.caption).trim();
          } else if (sentCount === 0) {
            caption = `${item.brand} ${item.model} photo, from Electro-Sun`;
          } else {
            caption = undefined;
          }
          const imgRes = await sendImage(lastMsg.from, mediaId, caption);
          if (imgRes && imgRes.ok) {
            const noteText = `[Photo sent: ${item.brand} ${item.model}${caption ? ' — ' + caption : ''}]`;
            appendMessage(conversation.id, 'outbound', noteText, {
              whatsapp_message_id: imgRes.messageId,
              intent: 'photo_sent',
              language: classification.language || 'english'
            });
            sentCount++;
          } else {
            lastSendFail = imgRes && (imgRes.error || imgRes.status);
            logger.warn('handler.photos.send_fail', {
              contactId: contact.id,
              warehouse_item_id: item.id,
              photo_id: photo.id,
              status: imgRes && imgRes.status,
              error: imgRes && imgRes.error
            });
          }
        }
        if (sentCount > 0) {
          photosSentThisTurn = true;
          logger.info('handler.photos.sent', {
            contactId: contact.id,
            warehouse_item_id: item.id,
            sent_count: sentCount,
            requested_count: match.photos.length
          });
          return;
        }
        // Every photo failed to send. Fall through to the no-match fallback
        // below so the customer still gets a coherent reply (rather than
        // silence) and the owner gets pinged.
        logger.warn('handler.photos.all_sends_failed_falling_back_to_text', {
          contactId: contact.id,
          warehouse_item_id: item.id,
          last_error: lastSendFail
        });
      } else {
        logger.info('handler.photos.no_match', {
          contactId: contact.id,
          message_preview: safeCombinedText.slice(0, 120)
        });
      }

      // No-photo fallback: customer asked for photos but we either could not
      // match an item or the matched item has no photos on file. Send a short
      // text and escalate as silent_query so the owner can either send the
      // photos manually or upload them for the next request.
      const fallbackText = "I don't have a photo of that one on hand right now.";
      const sendRes = await sendMessage(lastMsg.from, fallbackText);
      appendMessage(conversation.id, 'outbound', fallbackText, {
        whatsapp_message_id: sendRes && sendRes.messageId,
        intent: 'photo_request_fallback',
        language: classification.language || 'english'
      });
      if (!escalationsDisabled()) {
        try {
          await notifyOwnerForEscalation({
            contact: refreshedContact,
            classification: {
              ...classification,
              needs_escalation: true,
              escalation_type: 'silent_query',
              intent: 'photo_request'
            },
            safeCombinedText,
            lastMsg,
            batchSize: msgs.length,
            source: 'photos_no_match'
          });
        } catch (notifyErr) {
          logger.error('handler.photos.notify_owner_fail', {
            contactId: contact.id,
            message: notifyErr.message
          });
        }
      }
      return;
    } catch (err) {
      logger.error('handler.photos.error', {
        contactId: contact.id,
        message: err.message,
        stack: err.stack && err.stack.slice(0, 400)
      });
      // On unexpected error, fall through to normal Opus reply rather than
      // leaving the customer in silence.
    }
  }

  // Welcome card fires on the FIRST customer message of each fresh conversation
  // (a new conversation row opens after the 24h rollover). If the first message
  // is a PURE greeting ("hi", "good morning"), we send the welcome card and
  // stop. If the first message carries a substantive question alongside the
  // greeting (or is a pure question with no greeting), we send the welcome card
  // AND fall through to generate a normal Opus reply so the customer's actual
  // question is answered in the same turn. Opus is told the welcome was just
  // sent via the welcomeJustSent context hint, so it skips greetings/addresses
  // and goes straight to the answer.
  const convMsgsForWelcome = getMessagesForConversation(conversation.id);
  const hasPriorOutboundInConv = convMsgsForWelcome.some(m => m && m.direction === 'outbound');
  let welcomeCardJustSent = false;

  if (!hasPriorOutboundInConv) {
    const firstMessageIsPureGreeting = handlerIsGreeting(combinedText);
    try {
      const sendRes = await sendMessage(lastMsg.from, WELCOME_REPLY);
      appendMessage(conversation.id, 'outbound', WELCOME_REPLY, {
        whatsapp_message_id: sendRes.messageId,
        intent: 'welcome',
        language: classification.language || 'english'
      });
      logger.info('handler.welcome_sent', {
        contactId: contact.id,
        phone: lastMsg.from,
        chars: WELCOME_REPLY.length,
        pure_greeting: firstMessageIsPureGreeting,
        will_continue_with_reply: !firstMessageIsPureGreeting
      });
      welcomeCardJustSent = true;
      if (firstMessageIsPureGreeting) return;
      // else: fall through and let the Opus reply path answer the question
      // the customer attached to the greeting.
    } catch (err) {
      logger.error('handler.welcome_send_fail', {
        contactId: contact.id,
        phone: lastMsg.from,
        message: err.message
      });
      // If the welcome failed to send, fall through to normal reply so the
      // customer at least gets an answer.
    }
  }

  if (handlerIsGreeting(combinedText)) {
    classification.needs_escalation = false;
    classification.escalation_type = null;
    if (classification.lead_temperature === 'HOT') classification.lead_temperature = 'COLD';
  }

  // Contact-number request fast-path (owner directive 2026-06-07). When the
  // customer asks for a phone/contact line, deterministically share the regional
  // sales desk as a WhatsApp link (Lagos -> Lagos Sales, Abuja -> Abuja Sales,
  // unknown -> ask the city). Never an owner number. Skipped for HOT leads (the
  // HOT handoff already appends the routed Sales Manager link) and for pure
  // greetings. Bypasses the LLM + wa.me-strip guard so the link survives.
  if (
    !handlerIsGreeting(combinedText) &&
    classification.escalation_type !== 'hot_lead' &&
    CONTACT_REQUEST_RE.test(safeCombinedText)
  ) {
    const region = resolveContactRegion(classification, refreshedContact, safeCombinedText);
    const contactReply = buildContactReply(region);
    if (contactReply) {
      try {
        const sendRes = await sendMessage(lastMsg.from, contactReply);
        appendMessage(conversation.id, 'outbound', contactReply, {
          whatsapp_message_id: sendRes.messageId,
          intent: 'contact_shared',
          language: classification.language || 'english'
        });
        logger.info('handler.contact_request.shared', {
          contactId: contact.id,
          region,
          has_number: region !== 'unknown'
        });
        return;
      } catch (err) {
        logger.error('handler.contact_request.send_fail', { contactId: contact.id, message: err.message });
        // fall through to normal reply on send failure
      }
    }
  }

  if (escalationsDisabled() && classification.needs_escalation) {
    logger.warn('handler.escalations_disabled_kill_switch_engaged', {
      contactId: contact.id,
      original_escalation_type: classification.escalation_type
    });
    classification.needs_escalation = false;
    classification.escalation_type = null;
  }

  // Region backfill (the classifier is unreliable at extracting routing_region).
  // If the customer's message or recent history clearly names a city, set it in
  // code so routing reaches the right desk instead of deferring to a city-ask or
  // falling back to the owner. 2026-06-07: "I want to pay for 6kw inverter and
  // pick from abuja" came back with routing_region:null, so a HOT lead deferred
  // (gather-first) instead of routing to Abuja Sales and got no direct line.
  {
    const regionRaw = String(classification.routing_region || '').toLowerCase();
    if (regionRaw !== 'abuja' && regionRaw !== 'lagos') {
      // CURRENT conversation only (current message + recent customer turns). We
      // deliberately do NOT use the stored contact.location: routing a deal off a
      // city the customer mentioned in a past chat picks the wrong sales manager.
      const histBlob = Array.isArray(priorHistory)
        ? priorHistory.filter(m => m && m.role === 'user').slice(-6).map(m => String(m.content || '')).join(' ')
        : '';
      const detected = detectRegionInText(`${safeCombinedText} ${histBlob}`);
      if (detected === 'abuja' || detected === 'lagos') {
        classification.routing_region = detected;
        logger.info('handler.routing_region_backfilled', { contactId: contact.id, region: detected });
      }
    }
  }

  // Deferred-handoff resume (gather-first). A prior turn deferred this lead's
  // alert to first ask for a routing detail (product/scale, or Abuja vs Lagos).
  // If that detail has now arrived, fire the owed escalation even though THIS
  // message alone may not re-trigger one, a bare "Lagos" carries no commitment
  // phrase and would otherwise be demoted to WARM/COLD and dropped.
  if (
    !escalationsDisabled() &&
    refreshedContact.deferred_handoff &&
    ownerRouting.hasRoutingInfo(classification)
  ) {
    const deferredType = refreshedContact.deferred_handoff;
    classification.needs_escalation = true;
    classification.escalation_type = deferredType;
    if (!ownerRouting.isSeriousOrHot(classification)) {
      classification.category = deferredType === 'hot_lead' ? 'HOT' : 'SERIOUS';
    }
    try {
      updateContactFields(contact.id, { deferred_handoff: null, deferred_handoff_at: null });
    } catch (err) {
      logger.warn('handler.escalation.deferred_handoff_clear_fail', { message: err.message });
    }
    refreshedContact.deferred_handoff = null;
    logger.info('handler.escalation.deferred_handoff_resumed', {
      contactId: contact.id,
      escalation_type: deferredType,
      routing_category: classification.routing_category,
      routing_region: classification.routing_region
    });
  }

  // Big-project-by-value routing (owner directive 2026-07-05). Read the actual
  // money being discussed, the customer's stated budget AND the total of any BOM
  // Sunny has already quoted in this conversation, and if it clears the
  // big-project threshold (₦15M), tag routing_category=big_project so it routes
  // to the OWNERS (Patrick/Charbel round-robin), never a regional desk, no matter
  // the city. The LLM classifier's own routing_category tag is unreliable; the
  // money is not. This is why Franck's ₦41M Cameroon BOM must reach an owner.
  {
    const assistantBlob = Array.isArray(priorHistory)
      ? priorHistory.filter(m => m && m.role === 'assistant').slice(-4).map(m => String(m.content || '')).join('\n')
      : '';
    if (isBigProjectByValue(`${safeCombinedText}\n${assistantBlob}`)) {
      if (classification.routing_category !== 'big_project') {
        logger.info('handler.big_project_by_value_routed_to_owner', {
          contactId: contact.id,
          ngn: detectLargeOrderNgn(`${safeCombinedText}\n${assistantBlob}`),
          threshold: BIG_PROJECT_NGN_THRESHOLD,
          prior_routing_category: classification.routing_category
        });
      }
      classification.routing_category = 'big_project';
    }
  }

  const isHotEscalation = !!(classification.needs_escalation && classification.escalation_type === 'hot_lead');
  // Casual-confirm gate ONLY applies to non-HOT messages. HOT was already vetted by
  // the classifier's HOT_TRIGGER_RE whitelist; a short "i want to pay" is not casual,
  // it is a commitment. Suppressing it here was eating every natural payment phrase.
  const customerIsCasualConfirm = !isHotEscalation && isCasualConfirmation(safeCombinedText);

  // Bulk-order detection (owner directive 2026-06-07): a customer naming a
  // product and a multi-unit quantity ("I need up to 34 units") wants a bulk
  // quote. Sunny quotes the per-unit price and offers the Sales Manager for the
  // bulk price, the owner is alerted, and the customer gets the routed Sales
  // Manager direct line. This is NOT casual and NOT a plain HOT commitment;
  // when it is not already a HOT lead, force a bulk_order escalation so the flow
  // routes and hands off instead of looping on a generic stall. Skip when
  // escalations are disabled.
  const bulkQuantity = detectBulkQuantity(safeCombinedText);
  const isBulkOrder = bulkQuantity >= 2 && !isHotEscalation && !customerIsCasualConfirm && !escalationsDisabled();
  if (isBulkOrder) {
    classification.needs_escalation = true;
    classification.escalation_type = 'bulk_order';
    logger.info('handler.bulk_order_detected', {
      contactId: contact.id,
      quantity: bulkQuantity,
      routing_category: classification.routing_category,
      message_preview: safeCombinedText.slice(0, 80)
    });
  }

  // Live-agent request (C1b, 2026-06-08, conv 2633 Ajay): an explicit ask to
  // reach a human ("connect me with a live agent") is a handoff request. Force
  // a routed escalation so it reaches the regional Sales Manager (gather-first
  // asks the city when region is unknown) instead of stalling with "let me know
  // and I'll flag it" and then doing nothing.
  const wantsLiveAgent = isLiveAgentRequest(safeCombinedText) && !isHotEscalation && !isBulkOrder && !customerIsCasualConfirm && !escalationsDisabled();
  if (wantsLiveAgent) {
    classification.needs_escalation = true;
    classification.escalation_type = 'live_agent';
    logger.info('handler.live_agent_request_detected', {
      contactId: contact.id,
      routing_region: classification.routing_region,
      message_preview: safeCombinedText.slice(0, 80)
    });
  }

  // Silent-skip rule: if the customer just sent a pure casual confirm AND
  // Sunny's most recent reply was ALREADY a warm-close phrase ("take your
  // time", "anytime", "I'll be here", "no rush"...), do not reply. The
  // customer is waiting for the specialist, not asking a new question.
  // Replying with another warm-close every time looks like Sunny isn't
  // listening.
  if (customerIsCasualConfirm) {
    try {
      const lastAssistant = Array.isArray(priorHistory)
        ? priorHistory.filter(m => m && m.role === 'assistant').slice(-1)[0]
        : null;
      if (lastAssistant) {
        const lastBody = String(lastAssistant.content || '').toLowerCase();
        const WARM_CLOSE_RE = /(take\s+your\s+time|anytime[,.]|whenever\s+you'?re\s+ready|no\s+rush|i'?ll\s+be\s+here|reach\s+out\s+whenever|just\s+let\s+me\s+know|i'?ll\s+be\s+(around|here|right\s+here)|alright,?\s+i'?ll|sure,?\s+take|sure\s+thing)/i;
        if (WARM_CLOSE_RE.test(lastBody)) {
          logger.info('handler.casual_confirm_after_warm_close_skipped', {
            contactId: contact.id,
            message_preview: safeCombinedText.slice(0, 40),
            prior_outbound_preview: lastBody.slice(0, 80)
          });
          // Close the turn in the DB so the orphan sweep does not re-queue
          // this message every 5 minutes (2026-07-06 cost runaway).
          persistSilentSkipMarker(conversation.id, '[silent skip: customer closed the chat politely, no reply needed]');
          return;
        }
      }
    } catch (err) {
      logger.warn('handler.casual_confirm_skip_check_fail', { message: err.message });
    }
  }

  // Gather-first: a SERIOUS/HOT lead would escalate, but we don't yet know
  // enough to route it (product/scale unknown, or a daily sale with no stated
  // city). Defer the alert this turn, remember it on the contact, and let the
  // reply ask the one missing detail. The deferred-handoff resume above fires
  // the owed alert once the customer supplies it.
  // Gather-first now applies to EVERY routed escalation (owner directive
  // 2026-06-07: only big projects go to the owners; all else goes to a regional
  // desk). So whenever an escalation lacks the region needed to pick a desk, ask
  // the city first instead of letting it fall back to the owner.
  // Ask the city ONCE. If we already asked on a prior turn (deferred_handoff is
  // set) and the customer still has not given a city, do NOT keep asking, let
  // the escalation route now: decideRecipient defaults a city-unknown lead to
  // the Abuja desk (owner directive 2026-06-08). This stops a serious lead from
  // looping on "Abuja or Lagos?" forever and never reaching a desk.
  const alreadyAskedCity = !!(refreshedContact && refreshedContact.deferred_handoff);
  // A HOT commitment NEVER waits for a city. A customer who used a commitment
  // phrase (name/phone for the invoice, "send account", "I want to pay", "please
  // share my details with the Sales Manager") is ready NOW; deferring that alert
  // to ask "Abuja or Lagos?" strands the lead when the region is unknown, and a
  // foreign / delivery lead (e.g. a Cameroon export) will never name a Nigerian
  // city, so gather-first loops into the void: no owner/sales alert, no handoff
  // backstop, no Sales Manager link. When the region is unknown, decideRecipient
  // already defaults the desk to Abuja (abujaConfigured), so a HOT lead still
  // routes to a real sales manager immediately. (SUN/Franck incident 2026-07-05:
  // ₦41M Cameroon big project gave name + phone + "share my details", got
  // "the Sales Manager will reach out shortly" but NOBODY was alerted and no
  // link was shared.)
  const gatherFirst =
    classification.needs_escalation &&
    !customerIsCasualConfirm &&
    !escalationsDisabled() &&
    !isHotEscalation &&
    !ownerRouting.routingInfoSufficient(classification) &&
    !alreadyAskedCity;

  // If we are escalating because we already asked the city once (now defaulting
  // to Abuja), clear the deferred flag so it does not also re-fire later.
  if (!gatherFirst && alreadyAskedCity && classification.needs_escalation && !customerIsCasualConfirm && !ownerRouting.routingInfoSufficient(classification)) {
    try {
      updateContactFields(contact.id, { deferred_handoff: null, deferred_handoff_at: null });
    } catch (err) {
      logger.warn('handler.escalation.deferred_clear_fail', { message: err.message });
    }
    refreshedContact.deferred_handoff = null;
    logger.info('handler.escalation.city_unanswered_defaulting_abuja', { contactId: contact.id });
  }

  let escResult = null;
  if (gatherFirst) {
    try {
      updateContactFields(contact.id, {
        deferred_handoff: classification.escalation_type || 'silent_query',
        deferred_handoff_at: new Date().toISOString()
      });
    } catch (err) {
      logger.warn('handler.escalation.gather_first_persist_fail', { message: err.message });
    }
    logger.info('handler.escalation.gather_first_deferred', {
      contactId: contact.id,
      escalation_type: classification.escalation_type,
      routing_category: classification.routing_category,
      routing_region: classification.routing_region
    });
  } else if (classification.needs_escalation && !customerIsCasualConfirm) {
    escResult = await notifyOwnerForEscalation({
      contact: refreshedContact,
      classification,
      safeCombinedText,
      lastMsg,
      batchSize: msgs.length,
      source: 'classifier'
    });
  } else if (classification.needs_escalation && customerIsCasualConfirm) {
    logger.info('handler.escalation_suppressed_casual_confirm', {
      contactId: contact.id,
      escalation_type: classification.escalation_type,
      message_preview: safeCombinedText.slice(0, 80)
    });
  }

  // During gather-first we are NOT handing off yet, so HOT handoff behaviors
  // (HOT expert context, wa.me link, handoff backstops) must stay off.
  const isHot = isHotEscalation && !gatherFirst;
  const currentOpen = isHot ? null : getOrAutoResolveStalePending(contact.id);

  // Reply-once-on-follow-up suppression. If a pending_queries row is open
  // AND we've already produced an assistant reply on a prior turn while it
  // was open, suppress further LLM-generated replies for
  // PENDING_QUERY_REPLY_SILENCE_MS. The owner alert path still fires
  // (handled inside notifyOwnerForEscalation as a follow-up ping), the
  // customer just stops getting more "Could you share..." stalls.
  const turnHasImages = Array.isArray(attachments) && attachments.length > 0;
  if (currentOpen) {
    const suppress = shouldSuppressFollowupReply({
      lastAssistantReplyAt: currentOpen.last_assistant_reply_at,
      nowMs: Date.now(),
      silenceMs: PENDING_QUERY_REPLY_SILENCE_MS,
      hasImageAttachments: turnHasImages
    });
    if (suppress) {
      logger.info('handler.followup_reply_suppressed_silence_cooldown', {
        contactId: contact.id,
        queryId: currentOpen.id,
        cooldown_ms: PENDING_QUERY_REPLY_SILENCE_MS
      });
      try {
        logEvent(contact.id, 'silent_query_followup_suppressed', {
          queryId: currentOpen.id,
          last_assistant_reply_at: currentOpen.last_assistant_reply_at
        });
      } catch (err) {
        logger.warn('handler.followup_suppress_log_fail', { message: err.message });
      }
      return;
    }
  }

  const customerIsGratitude = customerIsCasualConfirm && isGratitudeMessage(safeCombinedText);
  let expertContext = null;
  if (gatherFirst) {
    expertContext = buildGatherFirstContext(classification);
  } else if (isHot) {
    expertContext = buildExpertContext({ isHot: true });
  } else if (
    classification.needs_escalation &&
    classification.escalation_type === 'dealer_pricing'
  ) {
    expertContext = buildDealerPricingContext();
  } else if (isBulkOrder) {
    expertContext = buildBulkOrderContext(bulkQuantity);
  } else if (customerIsGratitude) {
    expertContext = [
      '# Gratitude context (treat as authoritative)',
      'The customer just thanked you ("thank you", "thanks", "appreciate it", etc.). React with warmth, then offer to keep helping. Do NOT default to a flat "Got it." here; that reads cold after a thank-you.',
      '',
      'Voice rules in this state:',
      '- Reply with ONE warm welcome phrase, then an open offer of further help. Vary the wording across replies; do not repeat the exact same line twice.',
      '- Good shapes (pick ONE, do not list them all):',
      '  - "You\'re most welcome. Anything else I can help with?"',
      '  - "Anytime. Anything else you need?"',
      '  - "My pleasure. Is there anything else I can help you with?"',
      '  - "Happy to help. Anything else on your mind?"',
      '  - "Glad to help. Anything else you\'d like to know?"',
      '- Maximum 2 short sentences. No paragraph.',
      '- Do NOT mention prices, quantities, the team, the Sales Manager, the catalog, stock, follow-ups, or any handoff. The customer is not asking for more info; they\'re closing a thread warmly.',
      '- Do NOT include any URL, phone number, or wa.me link.',
      '- Match the customer\'s language if non-English (e.g. respond in the language they used).',
      '- Do NOT bring up earlier topics or prior pending questions.'
    ].join('\n');
  } else if (customerIsCasualConfirm) {
    expertContext = [
      '# Casual confirmation context (treat as authoritative)',
      'The customer just sent a short acknowledgement (e.g. "ok", "noted", "alright", "no problem"). They are closing a thread or pausing. React warmly, leave the door open, do NOT push.',
      '',
      'Voice rules in this state:',
      '- Reply with ONE short warm phrase. Vary the wording across replies; do NOT default to "Got it." every time.',
      '- Good shapes (pick ONE that fits):',
      '  - "Sure, take your time."',
      '  - "No problem, no rush."',
      '  - "Anytime, just let me know."',
      '  - "Sure thing. Reach out whenever you\'re ready."',
      '  - "Alright, I\'ll be here whenever you need."',
      '  - "Noted, take your time."',
      '  - "Sounds good."',
      '  - A single matching emoji like 👍 (only if the customer\'s own message was very minimal).',
      '- Maximum 1 short sentence (or a small two-clause phrase). No paragraph.',
      '- Do NOT pile on a follow-up question. The customer is closing, not asking.',
      '- Do NOT mention prices, quantities, the team, the Sales Manager, the catalog, stock, follow-ups, or any handoff.',
      '- Do NOT include any URL, phone number, or wa.me link.',
      '- Do NOT bring up earlier topics in this conversation.',
      '- Match the customer\'s language if non-English.'
    ].join('\n');
  } else if (currentOpen) {
    expertContext = buildExpertContext({
      openPending: currentOpen,
      escalationJustCreated: !!(escResult && escResult.freshPendingId),
      isHot: false,
      hasImage: turnHasImages
    });
  } else if (escResult && escResult.escalationType === 'silent_query' && (escResult.freshPendingId || escResult.ownerNotified)) {
    expertContext = buildExpertContext({
      openPending: null,
      escalationJustCreated: true,
      isHot: false,
      hasImage: turnHasImages
    });
  }

  const replyMessage = safeCombinedText || '(customer sent attachments only, see images)';
  let finalExpertContext = expertContext;
  if (welcomeCardJustSent) {
    const welcomeContext = [
      'WELCOME-ALREADY-SENT context:',
      'A welcome card with our Abuja office, Abuja warehouse, Lagos office addresses and our phone contacts was just sent to this customer as the previous outbound message of this same turn.',
      'Do NOT greet again. Do NOT repeat any address or phone number. Do NOT say "welcome" or "hello".',
      'Answer the customer\'s actual question directly in 1 to 2 short sentences. If a qualifier is needed to advance the sale (size, phase, location, quantity), ask ONE — never two.'
    ].join('\n');
    finalExpertContext = finalExpertContext
      ? welcomeContext + '\n\n' + finalExpertContext
      : welcomeContext;
  }
  // B9 hint: customer asked for a datasheet but the fast-path did NOT send
  // one (no match found OR Meta upload/send failed). Tell generateReply so
  // the post-generation guard there can rewrite any "the datasheet is
  // attached" hallucination into a safe "team will share shortly" message.
  const datasheetRequestedButNotSent = customerAskedForDatasheet && !datasheetSentThisTurn;
  const reply = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
    expertContext: finalExpertContext,
    allowTrailingQuestion: customerIsGratitude,
    datasheetRequestedButNotSent,
    topicTags: classification.topic_tags
  });
  if (!reply.ok || !reply.text) {
    try {
      const { getDb } = require('../db/init');
      const db = getDb();
      const recent = db.prepare(
        `SELECT body, created_at FROM messages
           WHERE direction = 'outbound'
             AND intent IN ('silent_query','hot_lead_handoff','fallback_ack')
             AND conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
           ORDER BY id DESC LIMIT 1`
      ).get(contact.id);
      if (recent) {
        const ageMs = Date.now() - new Date(recent.created_at).getTime();
        if (Number.isFinite(ageMs) && ageMs < FALLBACK_DEDUP_MINUTES * 60 * 1000) {
          logger.warn('handler.reply_fallback_suppressed_recent_duplicate', {
            contactId: contact.id,
            age_ms: ageMs,
            error: reply.error || null
          });
          return;
        }
      }
    } catch (err) {
      logger.warn('handler.reply_fallback_dedup_check_fail', { message: err.message });
    }

    const fallback = pickHoldingReply(isHot ? 'hot_lead' : 'silent_query', safeCombinedText);
    const sendRes = await sendMessage(lastMsg.from, fallback);
    appendMessage(conversation.id, 'outbound', fallback, {
      whatsapp_message_id: sendRes.messageId,
      intent: isHot ? 'hot_lead_handoff' : 'fallback_ack',
      language: classification.language
    });
    logger.warn('handler.reply_fallback_used', {
      contactId: contact.id,
      batch_size: msgs.length,
      error: reply.error || null
    });
    return;
  }

  if (!escalationsDisabled() && !expertContext) {
    const stallHit = security.detectStallLanguage(reply.text);
    if (stallHit) {
      security.logSecurityEvent('stall_language_detected', {
        contactId: contact.id,
        pattern: stallHit.pattern,
        reply_preview: reply.text.slice(0, 200)
      });
      // R3 (2026-06-08): a presence / impatience check ("Is anyone here to
      // respond?") is not a query. Reassure the customer; never escalate or
      // stall on it (conv 2599 escalated this to Patrick + replied about a
      // non-existent figure).
      if (isPresenceOrImpatienceCheck(safeCombinedText) || isPresenceOrImpatienceCheck(lastMsg)) {
        reply.text = "Yes, I'm here. How can I help you with your solar needs?";
        logger.info('handler.stall_presence_check_reassured', { contactId: contact.id });
      }
      // R1 (2026-06-08): not enough to route yet (region unknown and not a big
      // project). Do NOT ping the owner from the stall path; ask the city
      // first, mirroring the classifier escalation's gather-first guard.
      // Without this, region-unknown stalls fall straight to the general owner
      // (Patrick), violating "owners handle big projects only" (conv ken stone,
      // Lanre routed to Patrick instead of a regional desk).
      else if (!ownerRouting.routingInfoSufficient(classification)) {
        try {
          updateContactFields(contact.id, {
            deferred_handoff: classification.escalation_type || 'silent_query',
            deferred_handoff_at: new Date().toISOString()
          });
        } catch (err) {
          logger.warn('handler.stall_gather_first_persist_fail', { message: err.message });
        }
        const gatherCtx = buildGatherFirstContext(classification);
        const reply2 = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
          expertContext: gatherCtx,
          datasheetRequestedButNotSent,
          topicTags: classification.topic_tags
        });
        reply.text = (reply2.ok && reply2.text)
          ? reply2.text
          : 'Are you in Abuja or Lagos? That way the team can sort you out quickly.';
        logger.info('handler.stall_gather_first_deferred', {
          contactId: contact.id,
          routing_region: classification.routing_region,
          routing_category: classification.routing_category
        });
      }
      // Enough to route: escalate to the routed recipient and regenerate.
      else {
        const stallClassification = {
          ...classification,
          needs_escalation: true,
          escalation_type: 'silent_query'
        };
        const stallEsc = await notifyOwnerForEscalation({
          contact: refreshedContact,
          classification: stallClassification,
          safeCombinedText,
          lastMsg,
          batchSize: msgs.length,
          source: 'stall_guard'
        });
        const stallOpen = getOpenPendingQueryForContact(contact.id);
        const stallContext = (stallOpen || stallEsc.freshPendingId || stallEsc.ownerNotified)
          ? buildExpertContext({
              openPending: stallOpen,
              escalationJustCreated: !!stallEsc.freshPendingId,
              isHot: false,
              hasImage: turnHasImages
            })
          : null;
        if (stallContext) {
          const reply2 = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
            expertContext: stallContext,
            datasheetRequestedButNotSent,
            topicTags: classification.topic_tags
          });
          if (reply2.ok && reply2.text && !security.detectStallLanguage(reply2.text)) {
            reply.text = reply2.text;
            logger.info('handler.stall_regenerated_with_expert_context', {
              contactId: contact.id,
              chars: reply2.text.length
            });
          } else {
            // Context-aware ack: only mention "the figure" when the open query
            // (or the customer's own message) is actually a price ask. Otherwise
            // a neutral line (conv 2599, 2026-06-08 audit).
            const stallCtx = (stallOpen && stallOpen.customer_message) || safeCombinedText || lastMsg;
            reply.text = buildStallFallbackText(stallCtx);
            logger.warn('handler.stall_regen_failed_used_generic_ack', {
              contactId: contact.id,
              pattern: stallHit.pattern
            });
          }
        } else {
          reply.text = 'Noted. The team is on it.';
          logger.warn('handler.stall_replaced_no_alert', {
            contactId: contact.id,
            pattern: stallHit.pattern
          });
        }
      }
    }
  }

  let outboundText = reply.text;
  // HOT-handoff markers: language Sunny ONLY uses when the customer is in the
  // HOT-lead-handoff flow ("account details and final figures", "send you the
  // account", etc.). When any of these appear in the reply, the owner MUST
  // receive a hot_lead alert — even if a silent_query follow-up ping already
  // went out this turn. This is the bug that let "Yes send me account" get
  // routed as a follow-up on an old silent_query instead of a fresh HOT.
  const HOT_HANDOFF_REPLY_RE = /\b(account\s+details\s+and\s+(final\s+)?figures|formal\s+documents\s+and\s+(final\s+)?figures|reach\s+out\s+(shortly|soon)\s+with\s+(the\s+)?account|share\s+the\s+account|send\s+(you\s+)?the\s+account|(specialist|sales\s+manager|sales\s+team|team)\s+(will|is|can)\s+(handle|handling|process|processing|manage|managing)\s+(the\s+)?(payment|order|invoice))/i;
  // STRICT INVARIANT: any time Sunny promises a team follow-up in text, the
  // owner MUST get an alert with the customer's wa.me link. Otherwise the
  // customer waits for a reply that never gets escalated. This regex matches
  // every common shape of that promise.
  const HANDOFF_REPLY_RE = new RegExp([
    // "Team will / can / may / is [action]" + many action verbs
    '\\b(a|the|our|one\\s+of\\s+our)\\s+(sales\\s+managers?|specialists?|engineers?|sales\\s+representatives?|sales\\s+reps?|team\\s+members?|team)\\s+(will|can|may|is|are|would)\\s+(reach(ing)?\\s+out|follow(ing)?\\s+up|contact|be\\s+in\\s+touch|get\\s+back|come\\s+back|reconnect|provide|deliver|send|prepare|review|reach|confirm|call|connect|look\\s+(into|at)|check|investigate|verify|clarify|sort|revert|share|update|let\\s+you\\s+know|respond|reply)',
    // First-person "I'll / let me check with the team"
    '(i\'?ll|i\\s+will|let\\s+me|i\\s+can)\\s+(check|confirm|verify|reach\\s+out\\s+to|ask|consult|speak\\s+(to|with)|flag|forward|share|escalate|raise)\\s+(.{0,40})?(the\\s+team|my\\s+team|our\\s+team|the\\s+specialist|the\\s+sales\\s+manager|the\\s+experts?|with\\s+the\\s+team)',
    // "Flag this for them / for the team"
    'flag\\s+(it|that|this)\\s+(for|to|with)\\s+(them|the\\s+team|the\\s+specialist|the\\s+sales\\s+manager|the\\s+experts?)',
    // "Forward / escalate / raise this with the team"
    '(forward|escalate|raise|share|pass)\\s+(it|that|this).{0,40}(the\\s+team|them|the\\s+specialist|the\\s+sales\\s+manager|the\\s+experts?)',
    // "Team is on it" / "team will revert"
    'the\\s+team\\s+(is\\s+on\\s+(it|that)|will\\s+revert|will\\s+circle\\s+back|will\\s+take\\s+a\\s+look)',
    // HOT-handoff specific phrases (kept from original)
    'account\\s+details\\s+and\\s+(final\\s+)?figures',
    'formal\\s+documents\\s+and\\s+(final\\s+)?figures',
    'reach\\s+out\\s+(shortly|soon)\\s+with\\s+(the\\s+)?account',
    'share\\s+the\\s+account',
    'send\\s+(you\\s+)?the\\s+account',
    '(specialist|sales\\s+manager|sales\\s+team|team)\\s+(will|is|can)\\s+(handle|handling|process|processing|manage|managing)\\s+(the\\s+)?(payment|order|invoice)',
    // "Get back to you" general (paired with shortly/soon/asap)
    'get\\s+back\\s+to\\s+you\\s+(shortly|soon|with|once|as\\s+soon)',
    'will\\s+get\\s+back\\s+to\\s+you'
  ].join('|'), 'i');
  const replyMentionsHandoff = HANDOFF_REPLY_RE.test(outboundText);
  const replyMentionsHotHandoff = HOT_HANDOFF_REPLY_RE.test(outboundText);
  const linkAlreadyInText = /https?:\/\/wa\.me\//i.test(outboundText);

  // HOT handoff backstop: if the reply contains HOT-specific handoff language
  // and no hot_lead alert has fired this turn, force one. This runs BEFORE the
  // generic backstop and is NOT satisfied by a silent_query follow-up ping
  // having fired earlier — a HOT signal outranks a silent_query follow-up.
  if (replyMentionsHotHandoff && !escalationsDisabled()) {
    const hotAlertAlreadyFiredThisTurn = !!(
      escResult &&
      escResult.ownerNotified &&
      escResult.escalationType === 'hot_lead'
    );
    if (!hotAlertAlreadyFiredThisTurn) {
      logger.warn('handler.hot_handoff_in_reply_owner_alert', {
        contactId: contact.id,
        had_expert_context: !!expertContext,
        original_esc_type: escResult && escResult.escalationType,
        original_owner_notified: escResult && escResult.ownerNotified,
        reply_preview: outboundText.slice(0, 200)
      });
      const hotHandoffClassification = {
        ...classification,
        needs_escalation: true,
        escalation_type: 'hot_lead'
      };
      try {
        const hotEsc = await notifyOwnerForEscalation({
          contact: refreshedContact,
          classification: hotHandoffClassification,
          safeCombinedText,
          lastMsg,
          batchSize: msgs.length,
          source: 'hot_handoff_in_reply'
        });
        if (hotEsc && hotEsc.ownerNotified) {
          classification.needs_escalation = true;
          classification.escalation_type = 'hot_lead';
          // Refresh escResult so the generic handoff backstop below sees the
          // HOT alert as already-fired and skips firing a duplicate generic one.
          escResult = hotEsc;
        }
      } catch (err) {
        logger.warn('handler.hot_handoff_in_reply_alert_fail', {
          contactId: contact.id,
          message: err.message
        });
      }
    }
  }

  if (replyMentionsHandoff && !escalationsDisabled()) {
    const ownerAlreadyNotifiedThisTurn = !!(escResult && (escResult.ownerNotified || escResult.freshPendingId));
    if (!ownerAlreadyNotifiedThisTurn) {
      logger.info('handler.handoff_in_reply_owner_alert', {
        contactId: contact.id,
        had_expert_context: !!expertContext,
        reply_preview: outboundText.slice(0, 200)
      });
      const handoffClassification = {
        ...classification,
        needs_escalation: true,
        escalation_type: isHot ? 'hot_lead' : 'silent_query'
      };
      try {
        const handoffEsc = await notifyOwnerForEscalation({
          contact: refreshedContact,
          classification: handoffClassification,
          safeCombinedText,
          lastMsg,
          batchSize: msgs.length,
          source: 'handoff_in_reply'
        });
        // Make sure the escalatedThisTurn flag downstream sees this so the
        // customer reply gets the wa.me specialist link appended. Also surface
        // the resolved recipient so the link points at whoever was routed.
        if (handoffEsc && handoffEsc.ownerNotified) {
          classification.needs_escalation = true;
          if (!classification.escalation_type) classification.escalation_type = isHot ? 'hot_lead' : 'silent_query';
          if (!escResult || !escResult.ownerNotified) escResult = handoffEsc;
        }
      } catch (err) {
        logger.warn('handler.handoff_in_reply_alert_fail', {
          contactId: contact.id,
          message: err.message
        });
      }
    }
  }

  // STRICT INVARIANT (owner directive 2026-07-05): Sunny must NEVER refer the
  // customer to the Sales Manager (or "a specialist") without BOTH (a) an
  // owner/desk alert firing this turn and (b) his direct line appended below.
  // The generic HANDOFF_REPLY_RE above misses shapes like "the Sales Manager is
  // the right person to handle this" (no action verb), so this catches ANY
  // mention of the Sales Manager / specialist and forces an escalation when none
  // has fired yet, routed by the same rules (a big project reaches an owner).
  // Runs regardless of gather-first: naming the Sales Manager IS a handoff, so
  // the "ask the city first" deferral no longer applies. Closes the dead-end
  // where Sunny promised a handoff but nobody was told (Franck 2026-07-05).
  const replyRefersToSalesManager = /sales\s+manager|specialist/i.test(outboundText);
  if (replyRefersToSalesManager && !escalationsDisabled()) {
    const ownerAlreadyNotifiedThisTurn = !!(escResult && (escResult.ownerNotified || escResult.freshPendingId));
    if (!ownerAlreadyNotifiedThisTurn) {
      logger.warn('handler.sales_manager_referral_forced_escalation', {
        contactId: contact.id,
        had_expert_context: !!expertContext,
        was_gather_first: gatherFirst,
        reply_preview: outboundText.slice(0, 200)
      });
      const smEscType = (classification.escalation_type && classification.escalation_type !== 'none')
        ? classification.escalation_type
        : (isHot ? 'hot_lead' : 'silent_query');
      const smClassification = { ...classification, needs_escalation: true, escalation_type: smEscType };
      try {
        const smEsc = await notifyOwnerForEscalation({
          contact: refreshedContact,
          classification: smClassification,
          safeCombinedText,
          lastMsg,
          batchSize: msgs.length,
          source: 'sales_manager_referral'
        });
        if (smEsc && (smEsc.ownerNotified || smEsc.freshPendingId)) {
          classification.needs_escalation = true;
          if (!classification.escalation_type || classification.escalation_type === 'none') {
            classification.escalation_type = smEscType;
          }
          escResult = smEsc;
          // We deferred this turn (gather-first) but then named the Sales
          // Manager, so the deferral is stale: we HAVE alerted. Clear it so the
          // resume path does not double-fire later.
          if (gatherFirst && refreshedContact && refreshedContact.deferred_handoff) {
            try {
              updateContactFields(contact.id, { deferred_handoff: null, deferred_handoff_at: null });
            } catch (e) {
              logger.warn('handler.sales_manager_referral_deferred_clear_fail', { contactId: contact.id, message: e.message });
            }
            refreshedContact.deferred_handoff = null;
          }
        }
      } catch (err) {
        logger.warn('handler.sales_manager_referral_escalation_fail', { contactId: contact.id, message: err.message });
      }
    }
  }

  // Append the specialist (owner) wa.me link. HOT-lead / bulk / live-agent
  // handoffs always carry it; since 2026-07-05 ANY reply that names the Sales
  // Manager / specialist carries it too (the invariant above guarantees an
  // escalation routed this turn, so the link points at the right desk). Skip
  // only if the LLM already produced a wa.me link itself.
  const isHotHandoffThisTurn = !!(
    classification.needs_escalation &&
    classification.escalation_type === 'hot_lead' &&
    !gatherFirst
  );
  // Bulk orders also get the Sales Manager direct line (owner directive
  // 2026-06-07): the customer is offered the bulk quote, so the link is useful,
  // not spammy.
  const isBulkHandoffThisTurn = !!(
    classification.needs_escalation &&
    classification.escalation_type === 'bulk_order' &&
    !gatherFirst
  );
  // A live-agent request that has a known region (so it routed, not gather-first)
  // gets the routed Sales Manager direct line, that IS connecting them (C1b).
  const isLiveAgentHandoffThisTurn = !!(
    classification.needs_escalation &&
    classification.escalation_type === 'live_agent' &&
    !gatherFirst
  );
  // Recompute AFTER the Sales-Manager-referral invariant so the link points at
  // whoever that forced escalation routed to (owner for a big project, Abuja /
  // Lagos desk otherwise). Falls back to SPECIALIST_DIRECT_LINK if unresolved.
  const routedRecipientNumber = (escResult && escResult.recipientNumber) || null;
  // Owner directive (2026-07-05): whenever Sunny NAMES the Sales Manager / a
  // specialist, the customer MUST get a direct WhatsApp line, no matter the
  // region or gather-first state. The invariant above already guaranteed the
  // parallel escalation, so this simply always attaches the line on a mention.
  const isReferralHandoffThisTurn = replyRefersToSalesManager;
  if ((isHotHandoffThisTurn || isBulkHandoffThisTurn || isLiveAgentHandoffThisTurn || isReferralHandoffThisTurn) && !linkAlreadyInText) {
    // Point the customer at the SAME person the owner alert was routed to
    // (Abuja / Lagos sales, Charbel, or Patrick). Falls back to
    // SPECIALIST_DIRECT_LINK when no recipient was resolved this turn.
    const link = buildSpecialistLink(safeCombinedText, routedRecipientNumber);
    if (link) {
      outboundText = `${outboundText}\n\nDirect line to the Sales Manager: ${link}`;
    }
  }

  const sendRes = await sendMessage(lastMsg.from, outboundText);
  appendMessage(conversation.id, 'outbound', outboundText, {
    whatsapp_message_id: sendRes.messageId,
    intent: isHot ? 'hot_lead_handoff' : (expertContext ? 'silent_query_followup' : classification.intent),
    language: classification.language
  });
  // Touch the open pending_query's last_assistant_reply_at so that subsequent
  // inbounds within PENDING_QUERY_REPLY_SILENCE_MS get suppressed by the
  // reply-once-on-follow-up guard above. Covers two cases:
  //   (1) currentOpen was already set when the turn started (follow-up reply
  //       on an existing pending row).
  //   (2) The pending row was created THIS turn by notifyOwnerForEscalation
  //       (first dealer_pricing or silent_query turn). currentOpen was null
  //       when read at the top, but escResult.freshPendingId now points at
  //       the freshly-created row that needs touching too.
  const pendingIdToTouch = (currentOpen && currentOpen.id) || (escResult && escResult.freshPendingId) || null;
  if (pendingIdToTouch) {
    try {
      touchPendingQueryAssistantReply(pendingIdToTouch);
    } catch (err) {
      logger.warn('handler.touch_pending_assistant_reply_fail', {
        contactId: contact.id,
        queryId: pendingIdToTouch,
        message: err.message
      });
    }
  }
  logger.info('handler.batch.replied', {
    contactId: contact.id,
    batch_size: msgs.length,
    reply_chars: outboundText.length,
    expert_context_used: !!expertContext,
    is_hot: isHot
  });
}

async function handleInbound(payload) {
  // Delivery-status callbacks (delivered / read / failed) ride the same webhook.
  // Log them so we can see whether an alert actually reached the phone, not just
  // that Meta accepted it. Status-only payloads carry no messages and return below.
  logDeliveryStatuses(payload);

  try {
    const calls = extractCallEvents(payload);
    for (const call of calls) {
      await handleCallEvent(call);
    }
  } catch (err) {
    logger.warn('handler.call_event.error', { message: err.message });
  }

  const messages = extractMessages(payload);
  if (!messages.length) return;

  for (const msg of messages) {
    try {
      if (msg.id) {
        const existing = getMessageByWhatsappId(msg.id);
        if (existing) {
          logger.info('handler.idempotent_skip', { whatsappId: msg.id });
          continue;
        }
      }

      if (msg.kind === 'reaction') {
        await handleReaction(msg);
        continue;
      }

      if (msg.kind === 'system') {
        await handleSystemMessage(msg);
        continue;
      }

      if (msg.kind === 'unsupported') {
        await handleUnsupported(msg);
        continue;
      }

      // Alert-only recipients (Abuja / Lagos sales desks): Sunny sends them
      // lead alerts but does NOT converse with them. Persist their message for
      // admin visibility and send a generic, throttled ack (no relay, no Owner
      // Q&A, no classification) so the line is not a black hole.
      if (ownerRouting.isAlertOnly(msg.from)) {
        await handleAlertOnlyMessage(msg);
        continue;
      }

      // Full owners (Patrick + Charbel): reply-relay to a QID, or Owner Q&A.
      // NEVER let an owner message fall through to the customer pipeline: a
      // non-text owner message (voice note, image) used to slip past the
      // kind==='text' guard and get classified as a lead, which is how Charbel
      // ended up tagged HOT/SERIOUS/RESIDENTIAL (2026-07-05).
      if (ownerRouting.isFullOwner(msg.from)) {
        if (msg.replyToId) {
          const pending = findPendingByAlertId(msg.replyToId);
          if (pending) {
            await handleOwnerReply(msg, pending);
            continue;
          }
        }
        if (msg.kind === 'text') {
          await handleOwnerNonQueryMessage(msg);
          continue;
        }
        // Owner voice note: transcribe and treat as an Owner Q&A question.
        if (msg.kind === 'audio' && msg.media?.id) {
          try {
            const dl = await downloadMedia(msg.media.id);
            const trx = await transcribeAudio(dl.buffer, dl.mimeType);
            if (trx.ok && trx.text) {
              await handleOwnerNonQueryMessage({ ...msg, kind: 'text', body: trx.text });
              continue;
            }
          } catch (err) {
            logger.warn('handler.owner_voice.fail', { message: err.message });
          }
        }
        // Any other owner media: persist for admin visibility, no reply, no
        // classification, and absolutely no customer pipeline.
        try {
          const ownerContact = getOrCreateContact(msg.from, msg.profileName);
          const ownerConv = getActiveConversation(ownerContact.id);
          appendMessage(ownerConv.id, 'inbound', `[owner sent ${msg.kind || msg.type || 'media'}]`, {
            whatsapp_message_id: msg.id,
            intent: 'owner_media'
          });
        } catch (err) {
          logger.warn('handler.owner_media_persist_fail', { message: err.message });
        }
        continue;
      }

      if (!ownerRouting.isFullOwner(msg.from)) {
        const provisionalContact = getOrCreateContact(msg.from, msg.profileName);
        const rl = security.checkRateLimit(provisionalContact.id);
        if (!rl.allowed) {
          security.logSecurityEvent('rate_limit_blocked', {
            contactId: provisionalContact.id,
            phone: msg.from,
            reason: rl.reason,
            count: rl.count
          });
          continue;
        }
      }

      let imageAttachment = null;
      let imageStorage = null;
      let imageQuotaBlocked = false;
      if (msg.kind === 'image') {
        const provisionalContact = getOrCreateContact(msg.from, msg.profileName);
        const iq = security.checkImageQuota(provisionalContact.id);
        if (!iq.allowed) {
          security.logSecurityEvent('image_quota_exceeded', {
            contactId: provisionalContact.id,
            count: iq.count
          });
          imageQuotaBlocked = true;
          const caption = msg.body || '';
          msg.body = caption || '[image attached, daily image-processing quota reached]';
          msg.kind = 'text';
        }
      }

      if (msg.kind === 'image' && !imageQuotaBlocked) {
        try {
          ensureMediaDir();
          const dl = await downloadMedia(msg.media.id);
          const ext = extForMime(dl.mimeType);
          const savePath = path.join(MEDIA_DIR, `${msg.media.id}.${ext}`);
          fs.writeFileSync(savePath, dl.buffer);
          imageStorage = { path: savePath, mime: dl.mimeType };
          imageAttachment = {
            type: 'image',
            mimeType: dl.mimeType,
            base64: dl.buffer.toString('base64')
          };
          logger.info('handler.image.saved', { mediaId: msg.media.id, path: savePath, sizeBytes: dl.buffer.length });
          // Describe the image so the text-only classifier, the owner alerts,
          // and future history turns can see what it shows (2026-07-11
          // image-reading fix). Best-effort: on failure the pipeline falls
          // back to the blind "[Customer sent an image]" marker.
          try {
            const desc = await describeInboundImage(imageAttachment, msg.body || '');
            if (desc) {
              msg.imageDescription = desc;
              logger.info('handler.image.described', { mediaId: msg.media.id, description_preview: desc.slice(0, 120) });
            } else {
              logger.warn('handler.image.describe_empty', { mediaId: msg.media.id });
            }
          } catch (err) {
            logger.warn('handler.image.describe_fail', { mediaId: msg.media.id, message: err.message });
          }
        } catch (err) {
          logger.error('handler.image.download_fail', { mediaId: msg.media.id, message: err.message });
        }
      }

      let audioStorage = null;
      let audioTranscript = null;
      if (msg.kind === 'audio') {
        try {
          ensureMediaDir();
          const dl = await downloadMedia(msg.media.id);
          const ext = (dl.mimeType?.split('/')[1] || 'ogg').split(';')[0];
          const savePath = path.join(MEDIA_DIR, `${msg.media.id}.${ext}`);
          fs.writeFileSync(savePath, dl.buffer);
          audioStorage = { path: savePath, mime: dl.mimeType };
          logger.info('handler.audio.saved', { mediaId: msg.media.id, path: savePath, sizeBytes: dl.buffer.length });
          const trx = await transcribeAudio(dl.buffer, dl.mimeType);
          if (trx.ok && trx.text) {
            audioTranscript = trx.text;
            logger.info('handler.audio.transcribed', { mediaId: msg.media.id, chars: trx.text.length });
            msg.body = trx.text;
            msg.kind = 'text';
          } else {
            logger.warn('handler.audio.transcribe_fail', { mediaId: msg.media.id, error: trx.error });
            msg.body = '[Customer sent a voice note that could not be transcribed]';
            msg.kind = 'text';
          }
        } catch (err) {
          logger.error('handler.audio.download_fail', { mediaId: msg.media.id, message: err.message });
          msg.body = '[Customer sent a voice note]';
          msg.kind = 'text';
        }
      }

      const contact = getOrCreateContact(msg.from, msg.profileName);
      const conversation = getActiveConversation(contact.id);

      // Tag the lead source once, the first time we see the ElectroLeads opener.
      // Never overwrite an already-set source.
      if (!contact.lead_source) {
        const src = detectLeadSource(msg.body);
        if (src) {
          try {
            updateContactFields(contact.id, { lead_source: src });
            contact.lead_source = src;
            logEvent(contact.id, 'lead_source_tagged', { source: src, whatsappId: msg.id });
            logger.info('handler.lead_source.tagged', { contactId: contact.id, source: src });
          } catch (err) {
            logger.warn('handler.lead_source.tag_fail', { contactId: contact.id, message: err.message });
          }
        }
      }

      const trunc = security.truncateInbound(msg.body);
      if (trunc.truncated) {
        security.logSecurityEvent('inbound_truncated', {
          contactId: contact.id,
          original_length: trunc.original
        });
        msg.body = trunc.text;
      }

      const injectionMatches = security.detectInjectionAttempt(msg.body);
      if (injectionMatches) {
        security.logSecurityEvent('injection_attempt_detected', {
          contactId: contact.id,
          patterns: injectionMatches,
          preview: String(msg.body || '').slice(0, 200)
        });
      }

      const persistedBody = msg.kind === 'image'
        ? buildImagePersistedBody(msg.body, msg.imageDescription)
        : (audioTranscript ? `[voice note transcribed]: ${audioTranscript}` : msg.body);

      appendMessage(conversation.id, 'inbound', persistedBody, {
        whatsapp_message_id: msg.id,
        media_path: imageStorage?.path || audioStorage?.path || null,
        media_mime: imageStorage?.mime || audioStorage?.mime || null
      });

      if (conversation.human_handled) {
        logger.info('handler.human_handled_skip', {
          contactId: contact.id,
          conversationId: conversation.id
        });
        continue;
      }

      enqueueCustomerMessage(contact, conversation, msg, imageAttachment, imageStorage, persistedBody);
    } catch (err) {
      logger.error('handler.process_message_error', {
        from: msg.from,
        id: msg.id,
        message: err.message,
        stack: err.stack
      });
    }
  }
}

function readBackContact(contactId) {
  const { getDb } = require('../db/init');
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) || {};
}

// Persist a non-sent outbound marker on a turn where Sunny DELIBERATELY stays
// silent (e.g. the warm-close casual-confirm skip). Without it the orphan sweep
// sees "customer inbound with no outbound after it" and re-queues the same
// message every 5 minutes for the whole lookback window, burning a classifier
// call per pass (the 2026-07-06 cost runaway). The marker is never sent to the
// customer; it only closes the turn in the DB.
// Idle-chatter mute (owner directive 2026-07-11): stop replying to
// unproductive conversations. The pure detection lives in src/idle_chatter.js;
// this wrapper reads the conversation's prior rows (excluding the current
// batch, which is already persisted by the time the batch fires), and on mute
// writes the silent_skip marker so the orphan sweep never re-queues the turn.
// A turn carrying an image attachment is never muted: the customer may be
// showing a roof, a load, or a product.
function maybeMuteIdleChatter(contact, conversation, currentBatchWamids, combinedText, attachments) {
  try {
    if (Array.isArray(attachments) && attachments.length > 0) {
      return { muted: false, reason: null };
    }
    const currentIds = new Set((currentBatchWamids || []).filter(Boolean));
    const priorMessages = getMessagesForConversation(conversation.id)
      .filter(row => !currentIds.has(row.whatsapp_message_id));
    const res = idleChatter.assessIdleChatter({ text: combinedText, priorMessages });
    if (!res.mute) {
      return { muted: false, reason: res.reason, priorStreak: res.priorStreak };
    }
    persistSilentSkipMarker(conversation.id, `[silent skip: unproductive conversation muted (${res.reason})]`);
    logEvent(contact.id, 'idle_chatter_muted', {
      reason: res.reason,
      prior_streak: res.priorStreak,
      message_preview: String(combinedText || '').slice(0, 80)
    });
    logger.info('handler.idle_chatter.muted', {
      contactId: contact.id,
      conversationId: conversation.id,
      reason: res.reason,
      prior_streak: res.priorStreak,
      message_preview: String(combinedText || '').slice(0, 80)
    });
    return { muted: true, reason: res.reason, priorStreak: res.priorStreak };
  } catch (err) {
    logger.warn('handler.idle_chatter.check_fail', { message: err.message });
    return { muted: false, reason: null };
  }
}

function persistSilentSkipMarker(conversationId, note) {
  try {
    return appendMessage(conversationId, 'outbound', note || '[silent skip: no reply needed]', {
      intent: 'silent_skip'
    });
  } catch (err) {
    logger.warn('handler.silent_skip_marker_fail', { conversationId, message: err.message });
    return null;
  }
}

// Backstop for any intentional-silence path we forget to mark: the sweep gives
// each message at most this many re-queue attempts, then leaves it alone.
const ORPHAN_RECOVERY_MAX_ATTEMPTS = parseInt(process.env.ORPHAN_RECOVERY_MAX_ATTEMPTS || '2', 10);
const orphanRecoveryAttempts = new Map();

function resetOrphanRecoveryAttempts() {
  orphanRecoveryAttempts.clear();
}

async function recoverOrphanedInbound(maxAgeMinutes = 10, opts = {}) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  // minAgeMinutes: skip messages younger than this, so the periodic sweep never
  // races a turn that is still inside the debounce window or mid-LLM. The boot
  // call keeps 0 (nothing is processing at boot).
  const minAgeMinutes = opts.minAgeMinutes || 0;
  const youngest = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();

  const orphans = db.prepare(`
    SELECT m.id AS msg_id, m.conversation_id, m.body, m.timestamp, m.whatsapp_message_id,
           c.contact_id, c.human_handled, ct.phone, ct.name AS contact_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE m.direction = 'inbound'
      AND m.timestamp >= ?
      AND m.timestamp <= ?
      AND (m.intent IS NULL OR m.intent != 'reaction')
      AND m.body NOT LIKE '[reacted:%'
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
        WHERE m2.conversation_id = m.conversation_id
          AND m2.direction = 'outbound'
          AND m2.timestamp >= m.timestamp
      )
      AND c.human_handled = 0
    ORDER BY m.timestamp ASC
    LIMIT 30
  `).all(cutoff, youngest);

  if (!orphans.length) {
    logger.info('handler.recovery.no_orphans');
    return { recovered: 0 };
  }

  // Never re-queue owner/sales-desk numbers as customer inbound.
  const filtered = orphans.filter(o =>
    !ownerRouting.isFullOwner(o.phone) && !ownerRouting.isAlertOnly(o.phone)
  );
  logger.info('handler.recovery.orphans_found', {
    total: orphans.length,
    filtered: filtered.length,
    cutoff_minutes: maxAgeMinutes
  });

  // opts.enqueue lets tests observe re-queues without firing the real
  // debounce + classify pipeline. Production always uses the default.
  const enqueue = typeof opts.enqueue === 'function' ? opts.enqueue : (o) => {
    const synth = {
      from: o.phone,
      profileName: o.contact_name || null,
      kind: 'text',
      body: o.body || '',
      id: o.whatsapp_message_id || `recovered:${o.msg_id}`,
      replyToId: null,
      media: null
    };
    const contact = getOrCreateContact(synth.from, synth.profileName);
    const conversation = getActiveConversation(contact.id);
    enqueueCustomerMessage(contact, conversation, synth, null, null, synth.body);
  };

  // Crude bound so the attempt map cannot grow forever; entries only matter
  // within the sweep's lookback window anyway.
  if (orphanRecoveryAttempts.size > 5000) orphanRecoveryAttempts.clear();

  let recovered = 0;
  let capped = 0;
  for (const o of filtered) {
    const attempts = orphanRecoveryAttempts.get(o.msg_id) || 0;
    if (attempts >= ORPHAN_RECOVERY_MAX_ATTEMPTS) {
      capped++;
      continue;
    }
    try {
      orphanRecoveryAttempts.set(o.msg_id, attempts + 1);
      enqueue(o);
      recovered++;
    } catch (err) {
      logger.error('handler.recovery.fail', { msgId: o.msg_id, message: err.message });
    }
  }
  if (capped) {
    logger.info('handler.recovery.attempts_capped', { capped, max_attempts: ORPHAN_RECOVERY_MAX_ATTEMPTS });
  }
  logger.info('handler.recovery.done', { recovered });
  return { recovered, capped };
}

async function answerPendingForContact(contactId) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const latest = db.prepare(`
    SELECT m.id AS msg_id, m.body, m.whatsapp_message_id, m.timestamp,
           c.id AS conversation_id, ct.phone, ct.name AS contact_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.contact_id = ?
      AND m.direction = 'inbound'
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
        WHERE m2.conversation_id = m.conversation_id
          AND m2.direction = 'outbound'
          AND m2.timestamp >= m.timestamp
      )
    ORDER BY m.timestamp DESC
    LIMIT 1
  `).get(contactId);

  if (!latest) {
    logger.info('handler.answer_pending.no_pending', { contactId });
    return { processed: false };
  }

  try {
    const synth = {
      from: latest.phone,
      profileName: latest.contact_name || null,
      kind: 'text',
      body: latest.body || '',
      id: latest.whatsapp_message_id || `recovered:${latest.msg_id}`,
      replyToId: null,
      media: null
    };
    const contact = getOrCreateContact(synth.from, synth.profileName);
    const conversation = getActiveConversation(contact.id);
    enqueueCustomerMessage(contact, conversation, synth, null, null, synth.body);
    logger.info('handler.answer_pending.queued', {
      contactId,
      conversationId: latest.conversation_id,
      msgId: latest.msg_id
    });
    return { processed: true, queued_msg_id: latest.msg_id };
  } catch (err) {
    logger.error('handler.answer_pending.fail', { contactId, message: err.message });
    return { processed: false, error: err.message };
  }
}

// Ghost sweep (owner directive 2026-06-08): a lead that was asked "Abuja or
// Lagos?" (deferred_handoff set) but never answered with a city sits unrouted.
// After thresholdMinutes, route it to the Abuja desk (the configured default
// via decideRecipient's region-unknown branch) and clear the flag, so a silent
// non-responder still reaches a sales manager. Routes ONLY, does not message
// the customer again. Throttling / open-pending follow-up is handled inside
// notifyOwnerForEscalation. Cleared flag means a contact is swept at most once.
async function routeStaleDeferredHandoffs(thresholdMinutes = 5) {
  if (escalationsDisabled()) return { routed: 0, skipped: 'escalations_disabled' };
  const { getDb } = require('../db/init');
  const db = getDb();
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  // Floor at 24h ago: a lead that has sat unanswered longer than a day is dead,
  // not worth alerting a desk now (and avoids a first-run flood if a backlog of
  // old deferred flags exists). Cap the batch per run as a further backstop.
  const floor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT id, phone, location, category, lead_temperature,
           client_type, products_asked_about, deferred_handoff, deferred_handoff_at
    FROM contacts
    WHERE deferred_handoff IS NOT NULL
      AND deferred_handoff_at IS NOT NULL
      AND deferred_handoff_at < ?
      AND deferred_handoff_at > ?
    ORDER BY deferred_handoff_at ASC
    LIMIT 30
  `).all(cutoff, floor);

  let routed = 0;
  for (const c of rows) {
    try {
      const lastIn = db.prepare(`
        SELECT body FROM messages
        WHERE direction = 'inbound'
          AND conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
        ORDER BY id DESC LIMIT 1
      `).get(c.id);
      const customerMsg = (lastIn && lastIn.body) || '';
      const classification = {
        needs_escalation: true,
        escalation_type: c.deferred_handoff || 'silent_query',
        category: c.category || 'SERIOUS',
        lead_temperature: c.lead_temperature || 'WARM',
        routing_category: 'unknown',
        routing_region: 'unknown',
        products_asked_about: c.products_asked_about || null,
        owner_brief: null
      };
      const contact = { id: c.id, phone: c.phone, location: c.location };
      await notifyOwnerForEscalation({
        contact,
        classification,
        safeCombinedText: customerMsg,
        lastMsg: { from: c.phone },
        batchSize: 1,
        source: 'stale_deferred_sweep'
      });
      updateContactFields(c.id, { deferred_handoff: null, deferred_handoff_at: null });
      routed++;
      logger.info('handler.stale_deferred_routed', {
        contactId: c.id,
        escalation_type: classification.escalation_type,
        threshold_min: thresholdMinutes
      });
    } catch (err) {
      logger.warn('handler.stale_deferred_route_fail', { contactId: c.id, message: err.message });
    }
  }
  if (routed) logger.info('handler.stale_deferred_sweep.done', { routed, threshold_min: thresholdMinutes });
  return { routed };
}

async function autoReleaseStaleHumanConversations(thresholdMinutes = 15) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

  const stale = db.prepare(`
    SELECT c.id AS conversation_id, c.contact_id, c.human_handled_at,
           (SELECT MAX(m.timestamp) FROM messages m
            WHERE m.conversation_id = c.id
              AND m.direction = 'outbound'
              AND m.intent = 'human_manual_reply') AS last_human_reply_at,
           (SELECT MAX(m.timestamp) FROM messages m
            WHERE m.conversation_id = c.id
              AND m.direction = 'inbound') AS last_inbound_at
    FROM conversations c
    WHERE c.human_handled = 1
  `).all();

  let released = 0;
  for (const row of stale) {
    const lastHumanAction = row.last_human_reply_at || row.human_handled_at;
    if (!lastHumanAction || lastHumanAction >= cutoff) continue;

    db.prepare('UPDATE conversations SET human_handled = 0, human_handled_at = NULL WHERE id = ?')
      .run(row.conversation_id);
    logEvent(row.contact_id, 'conversation_auto_released', {
      conversationId: row.conversation_id,
      last_human_action: lastHumanAction,
      threshold_minutes: thresholdMinutes
    });
    logger.info('handler.auto_release.fired', {
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      last_human_action: lastHumanAction,
      last_inbound: row.last_inbound_at,
      threshold_minutes: thresholdMinutes
    });

    if (row.last_inbound_at && row.last_inbound_at > lastHumanAction) {
      try {
        await answerPendingForContact(row.contact_id);
      } catch (err) {
        logger.error('handler.auto_release.answer_fail', {
          conversationId: row.conversation_id,
          message: err.message
        });
      }
    }
    released++;
  }
  if (released > 0) {
    logger.info('handler.auto_release.done', { released, threshold_minutes: thresholdMinutes });
  }
  return { released };
}

async function retryFallbackReplies({ maxAgeMinutes = 120 } = {}) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  const badOutbounds = db.prepare(`
    SELECT m.id AS bad_id, m.conversation_id, m.timestamp AS bad_at, m.intent,
           c.contact_id, ct.phone, ct.name AS contact_name, c.human_handled
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE m.direction = 'outbound'
      AND m.intent IN ('silent_query','fallback_ack','hot_lead_handoff')
      AND m.timestamp >= ?
    ORDER BY m.timestamp ASC
  `).all(cutoff);

  const seenContacts = new Set();
  let queued = 0;
  let skipped = 0;
  const details = [];

  for (const row of badOutbounds) {
    if (seenContacts.has(row.contact_id)) {
      skipped++;
      continue;
    }
    seenContacts.add(row.contact_id);

    if (row.human_handled) {
      skipped++;
      details.push({ contactId: row.contact_id, skipped: 'human_handled' });
      continue;
    }

    const inbound = db.prepare(`
      SELECT id, body, whatsapp_message_id, timestamp
      FROM messages
      WHERE conversation_id = ?
        AND direction = 'inbound'
        AND timestamp <= ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(row.conversation_id, row.bad_at);

    if (!inbound) {
      skipped++;
      details.push({ contactId: row.contact_id, skipped: 'no_inbound_before_bad_reply' });
      continue;
    }

    try {
      const synth = {
        from: row.phone,
        profileName: row.contact_name || null,
        kind: 'text',
        body: inbound.body || '',
        id: inbound.whatsapp_message_id || `recovered:${inbound.id}`,
        replyToId: null,
        media: null
      };
      const contact = getOrCreateContact(synth.from, synth.profileName);
      const conversation = getActiveConversation(contact.id);
      enqueueCustomerMessage(contact, conversation, synth, null, null, synth.body);
      queued++;
      details.push({
        contactId: row.contact_id,
        bad_intent: row.intent,
        retried_inbound_id: inbound.id
      });
    } catch (err) {
      skipped++;
      logger.warn('handler.retry_fallback.queue_fail', {
        contactId: row.contact_id,
        message: err.message
      });
    }
  }

  logger.info('handler.retry_fallback.done', {
    max_age_minutes: maxAgeMinutes,
    bad_outbound_count: badOutbounds.length,
    contacts_queued: queued,
    skipped
  });

  return {
    bad_outbound_count: badOutbounds.length,
    contacts_queued: queued,
    skipped,
    details
  };
}

// Last-resort acknowledgement for the stall guard: when the LLM keeps stalling
// even after the awaiting-expert regeneration, send a short ack. The previous
// hard-coded "Noted. Will share the figure once confirmed." was nonsensical for
// non-price conversations (conv 2599: customer asked "Is anyone here to
// respond?" and got a line about "the figure"). Only keep the figure phrasing
// when the context is genuinely a price ask; otherwise stay neutral.
// A presence / impatience check ("is anyone here?", "you there?", "hello?")
// is NOT a query that needs a team answer. The stall guard must not escalate
// it to the owner nor stall on it; Sunny should just reassure the customer
// it is here (R3, 2026-06-08 audit, conv 2599).
const PRESENCE_CHECK_RE = /\b(?:is\s+(?:any\s*one|some\s*one|any\s*body|some\s*body)\s+(?:there|here|around|available|online|to\s+respond)|are\s+you\s+(?:there|here|online|available|around)|any\s*body\s+(?:there|here)|any\s*one\s+(?:there|here|to\s+respond)|you\s+there|is\s+this\s+(?:thing\s+)?(?:on|working|live)|who\s+am\s+i\s+(?:chatting|speaking|talking))\b/i;
function isPresenceOrImpatienceCheck(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (PRESENCE_CHECK_RE.test(t)) return true;
  // A bare "hello?" / "hellooo??" with a question mark and nothing else.
  if (/^(?:hi+|hey+|hello+|helo+|yoo+)\s*\?+$/i.test(t)) return true;
  return false;
}

// An explicit request to reach a human / live agent (C1b, 2026-06-08, conv
// 2633 Ajay: "Connect me with a live agent" got no escalation). This is a
// handoff request and must route to the regional Sales Manager. "call me" /
// "your number" are deliberately NOT here, the contact-request fast-path
// already handles those.
const LIVE_AGENT_RE = /\b(?:live\s+(?:agent|chat|person|rep)|human\s+(?:agent|being|rep|support)?|real\s+(?:person|human|agent|human\s+being)|(?:speak|talk|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|someone|some\s*body)?(?:human|person|agent|rep(?:resentative)?|staff|sales|your\s+team|a\s+person)?|connect\s+(?:me\s+)?(?:to|with)\s+(?:a\s+|an\s+)?(?:human|person|agent|someone|live|rep(?:resentative)?|sales|your\s+team|a\s+real)|customer\s+(?:care|service|support)|agent\s+please)\b/i;
function isLiveAgentRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return LIVE_AGENT_RE.test(t);
}

function buildStallFallbackText(contextText) {
  const PRICE_CTX_RE = /\b(how\s+much|prices?|pricing|costs?|naira|ngn|quotations?|quotes?|rates?|figure|amount|totals?|invoices?|proformas?|\d+\s*(?:units?|pcs|pieces?|panels?|sets?|modules?))\b/i;
  if (PRICE_CTX_RE.test(String(contextText || ''))) {
    return 'Noted. Will share the figure once confirmed.';
  }
  return 'Noted, the team will get back to you on this shortly.';
}

module.exports = {
  handleInbound,
  extractMessages,
  recoverOrphanedInbound,
  persistSilentSkipMarker,
  maybeMuteIdleChatter,
  buildImagePersistedBody,
  buildImageCombinedPart,
  shouldSuppressFollowupReply,
  buildExpertContext,
  resetOrphanRecoveryAttempts,
  scrubTeamContactLeadTags,
  extractCustomerPhoneDigits,
  chunkText,
  answerPendingForContact,
  autoReleaseStaleHumanConversations,
  routeStaleDeferredHandoffs,
  retryFallbackReplies,
  buildStallFallbackText,
  isPresenceOrImpatienceCheck,
  detectBulkQuantity,
  detectLargeOrderNgn,
  isBigProjectByValue,
  BIG_PROJECT_NGN_THRESHOLD,
  isLiveAgentRequest,
  detectLeadSource
};
