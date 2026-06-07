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
const { generateReply } = require('./claude');
const { sendMessage, downloadMedia, uploadMediaToMeta, sendDocument, sendImage } = require('./whatsapp');
const warehouse = require('./warehouse');
const { DB_PATH } = require('../db/init');
// owner teaching retired 2026-05-10: owner edits master prompt directly via admin Rules editor
const { answerOwnerQuestion } = require('./owner_qa');
const { transcribeAudio } = require('./transcribe');
const security = require('./security');
const { buildOwnerAlertText } = require('./owner_alert');
const ownerRouting = require('./owner_routing');

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
  '*Abuja Address*',
  '',
  'Office: Sunset Place, 141 Adetokunbo Ademola Cres, Wuse 2, Abuja',
  '',
  'Warehouse address: Plot 816, Gidado Idriss way Idu Industrial area FCT Abuja',
  '',
  'Contact:',
  'Charbel: 09068859213',
  'Patrick: 07041328055',
  '',
  '*Lagos Address:*',
  '',
  'Guardian Newspapers Ltd.',
  'RUTAM HOUSE',
  'Apapa-Oshodi Expressway, Isolo, P.M.B 1217, Oshodi',
  'Lagos, Nigeria.'
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
function detectBulkQuantity(text) {
  const m = BULK_ORDER_RE.exec(String(text || ''));
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 2 ? n : 0;
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

function buildExpertContext({ openPending, escalationJustCreated, isHot }) {
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
  const alertText = buildOwnerAlertText(contact, classification, escalationHeader(escalationType), message);
  const sendRes = await sendMessage(ownerPhone, alertText);
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

  const reply = await answerOwnerQuestion(ownerContact.id, msg.body);

  const sendRes = await sendMessage(msg.from, reply);
  appendMessage(ownerConv.id, 'outbound', reply, {
    whatsapp_message_id: sendRes.messageId,
    intent: 'owner_qa_reply'
  });
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

const MESSAGE_DEBOUNCE_MS = parseInt(process.env.MESSAGE_DEBOUNCE_MS || '6000', 10);
const PENDING_INBOUND = new Map();

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
    processCustomerBatch(entry).catch(err => {
      logger.error('handler.batch.process_fail', {
        contactId: key,
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
        const followText = buildOwnerAlertText(
          contact,
          classification,
          'FOLLOW-UP, same customer is still asking on the pending query.',
          safeCombinedText
        );
        followSendRes = await sendMessage(ownerPhone, followText);
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
      return m.body
        ? `[Customer sent an image with caption]: ${m.body}`
        : `[Customer sent an image with no caption]`;
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
  const gatherFirst =
    classification.needs_escalation &&
    !customerIsCasualConfirm &&
    !isBulkOrder &&
    !escalationsDisabled() &&
    ownerRouting.isSeriousOrHot(classification) &&
    !ownerRouting.routingInfoSufficient(classification);

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
  if (currentOpen && currentOpen.last_assistant_reply_at) {
    const sinceLastReplyMs = Date.now() - new Date(currentOpen.last_assistant_reply_at).getTime();
    if (Number.isFinite(sinceLastReplyMs) && sinceLastReplyMs < PENDING_QUERY_REPLY_SILENCE_MS) {
      logger.info('handler.followup_reply_suppressed_silence_cooldown', {
        contactId: contact.id,
        queryId: currentOpen.id,
        since_last_reply_ms: sinceLastReplyMs,
        cooldown_ms: PENDING_QUERY_REPLY_SILENCE_MS
      });
      try {
        logEvent(contact.id, 'silent_query_followup_suppressed', {
          queryId: currentOpen.id,
          since_last_reply_ms: sinceLastReplyMs
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
      isHot: false
    });
  } else if (escResult && escResult.escalationType === 'silent_query' && (escResult.freshPendingId || escResult.ownerNotified)) {
    expertContext = buildExpertContext({
      openPending: null,
      escalationJustCreated: true,
      isHot: false
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
    datasheetRequestedButNotSent
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
            isHot: false
          })
        : null;
      if (stallContext) {
        const reply2 = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
          expertContext: stallContext,
          datasheetRequestedButNotSent
        });
        if (reply2.ok && reply2.text && !security.detectStallLanguage(reply2.text)) {
          reply.text = reply2.text;
          logger.info('handler.stall_regenerated_with_expert_context', {
            contactId: contact.id,
            chars: reply2.text.length
          });
        } else {
          reply.text = 'Noted. Will share the figure once confirmed.';
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
  if (replyMentionsHotHandoff && !escalationsDisabled() && !gatherFirst) {
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

  if (replyMentionsHandoff && !escalationsDisabled() && !gatherFirst) {
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

  // Append the specialist (owner) wa.me link ONLY on HOT-lead handoff. The
  // 2026-05-15 owner feedback: appending the link on silent_query/pricing
  // replies (where Sunny is asking for the customer's number, or saying
  // "the team will check") is spammy and confuses the customer about who's
  // actually handling them. The link makes sense ONLY when the customer
  // explicitly committed (sent_account / pay-now phrasing) and we are
  // genuinely passing them to a specialist. Skip if the LLM already
  // produced a wa.me link itself.
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
  if ((isHotHandoffThisTurn || isBulkHandoffThisTurn) && !linkAlreadyInText) {
    // Point the customer at the SAME person the owner alert was routed to
    // (Abuja / Lagos sales, Charbel, or Patrick). Falls back to
    // SPECIALIST_DIRECT_LINK when no recipient was resolved this turn.
    const routedRecipientNumber = (escResult && escResult.recipientNumber) || null;
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
        ? (msg.body ? `[image] ${msg.body}` : '[image]')
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

async function recoverOrphanedInbound(maxAgeMinutes = 10) {
  const { getDb } = require('../db/init');
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  const orphans = db.prepare(`
    SELECT m.id AS msg_id, m.conversation_id, m.body, m.timestamp, m.whatsapp_message_id,
           c.contact_id, c.human_handled, ct.phone, ct.name AS contact_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE m.direction = 'inbound'
      AND m.timestamp >= ?
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
        WHERE m2.conversation_id = m.conversation_id
          AND m2.direction = 'outbound'
          AND m2.timestamp > m.timestamp
      )
      AND c.human_handled = 0
    ORDER BY m.timestamp ASC
  `).all(cutoff);

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

  let recovered = 0;
  for (const o of filtered) {
    try {
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
      recovered++;
    } catch (err) {
      logger.error('handler.recovery.fail', { msgId: o.msg_id, message: err.message });
    }
  }
  logger.info('handler.recovery.done', { recovered });
  return { recovered };
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
          AND m2.timestamp > m.timestamp
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

module.exports = {
  handleInbound,
  extractMessages,
  recoverOrphanedInbound,
  answerPendingForContact,
  autoReleaseStaleHumanConversations,
  retryFallbackReplies
};
