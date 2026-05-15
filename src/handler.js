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
  getContactById,
  getMessagesForConversation
} = require('./memory');
const { runClassification } = require('./classifier');
const { generateReply } = require('./claude');
const { sendMessage, downloadMedia, uploadMediaToMeta, sendDocument } = require('./whatsapp');
const warehouse = require('./warehouse');
const { DB_PATH } = require('../db/init');
// owner teaching retired 2026-05-10: owner edits master prompt directly via admin Rules editor
const { answerOwnerQuestion } = require('./owner_qa');
const { transcribeAudio } = require('./transcribe');
const security = require('./security');

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

const HOT_LEAD_REPLY = "Noted. To proceed, you can continue directly with our specialist on WhatsApp. They have the formal documents and final figures.";
const SILENT_QUERY_REPLY = "Noted. The team will get back to you shortly. In the meantime, you can also reach our specialist on WhatsApp.";
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

// Returns the most recent open pending_query for the contact, OR null if no
// open row exists OR the open row has aged past PENDING_QUERY_AUTO_EXPIRE_MS
// (in which case it is auto-resolved as a side effect and null is returned).
// Use this everywhere routing decisions key off "is there a pending row".
function getOrAutoResolveStalePending(contactId) {
  const open = getOpenPendingQueryForContact(contactId);
  if (!open) return null;
  const createdMs = new Date(open.created_at).getTime();
  if (!Number.isFinite(createdMs)) return open;
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

function buildSpecialistLink(customerMessage) {
  const num = (process.env.SPECIALIST_DIRECT_LINK || '').replace(/\D/g, '');
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
  if (link) return base + `\n\nDirect line to the specialist: ${link}`;
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

function buildExpertContext({ openPending, escalationJustCreated, isHot }) {
  if (isHot) {
    return [
      '# HOT lead handoff context (treat as authoritative)',
      'The customer has expressed clear intent to proceed (pay, deposit, order, install, ready to buy).',
      '',
      'Voice rules in this state:',
      '- Acknowledge their commitment in one short sentence, in the customer\'s own language.',
      '- Confirm a specialist will reach out shortly with formal documents and figures.',
      '- Use third person ("the specialist", "the team"). Do NOT use first-person stalls ("I will reach out", "let me confirm", "I will get back").',
      '- Do NOT quote new prices or specs that were not already discussed in this conversation.',
      '- Do NOT include any URL or phone number; the system appends the specialist contact link automatically.',
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
  lines.push('- Do NOT say "the team will reach out", "the team will follow up", "the team is on it", "the specialist will confirm", "we will share the figure shortly", "we will get back to you", or any variant. Those phrases are BANNED in this turn.');
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
  negotiation: 'NEGOTIATION, customer is asking for a discount or counter-offer.',
  repeat_complex: 'REPEAT CLIENT, returning customer with a complex ask.',
  big_project: 'BIG PROJECT, 30kW+ install / EPC enquiry.',
  silent_query: 'FOLLOW-UP NEEDED, customer is waiting on a team answer.'
};

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

async function notifyOwnerEscalation(contact, message, classification) {
  const ownerPhone = process.env.OWNER_WHATSAPP;
  if (!ownerPhone) {
    logger.warn('escalation.no_owner_phone');
    return null;
  }

  const rawType = classification && classification.escalation_type;
  const escalationType = ESCALATION_HEADERS[rawType] ? rawType : 'silent_query';
  const customerWaLink = contact.phone
    ? `https://wa.me/${String(contact.phone).replace(/\D+/g, '')}`
    : null;

  const customerConv = getActiveConversation(contact.id);
  const adminLink = customerConv && customerConv.id ? buildAdminConversationLink(customerConv.id) : null;
  const brief = formatConversationBriefForOwner(contact.id, 6);

  const signals = [];
  if (classification && classification.category) signals.push(`Category: ${classification.category}`);
  if (classification && classification.lead_temperature) signals.push(`Temp: ${classification.lead_temperature}`);
  if (classification && classification.intent) signals.push(`Intent: ${classification.intent}`);

  const lines = [];
  lines.push(escalationHeader(escalationType));
  lines.push(`Customer: ${contact.name || 'unknown'} (${contact.phone})`);
  if (signals.length) lines.push(signals.join(' | '));
  lines.push('');
  lines.push('Latest message:');
  lines.push(message);
  if (brief) {
    lines.push('');
    lines.push('Conversation so far:');
    lines.push(brief);
  }
  if (adminLink) {
    lines.push('');
    lines.push(`Open in admin: ${adminLink}`);
  }
  if (customerWaLink) {
    lines.push(`Open WhatsApp chat: ${customerWaLink}`);
  }

  const alertText = lines.join('\n');
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
  if (escalationType === 'silent_query') {
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
          escalationType: 'silent_query',
          throttled: true
        };
      }
      // Send a brief follow-up ping rather than the full alert.
      const ownerPhone = process.env.OWNER_WHATSAPP;
      let followSendRes = null;
      if (ownerPhone) {
        const waLink = contact.phone ? `https://wa.me/${String(contact.phone).replace(/\D+/g, '')}` : null;
        const followConv = getActiveConversation(contact.id);
        const followAdminLink = followConv && followConv.id ? buildAdminConversationLink(followConv.id) : null;
        const followBrief = formatConversationBriefForOwner(contact.id, 6);
        const followLines = [
          'FOLLOW-UP, same customer is still asking on the pending query.',
          `Customer: ${contact.name || 'unknown'} (${contact.phone})`,
          '',
          'Latest message:',
          safeCombinedText
        ];
        if (followBrief) {
          followLines.push('');
          followLines.push('Conversation so far:');
          followLines.push(followBrief);
        }
        if (followAdminLink) {
          followLines.push('');
          followLines.push(`Open in admin: ${followAdminLink}`);
        }
        if (waLink) {
          followLines.push(`Open WhatsApp chat: ${waLink}`);
        }
        const followText = followLines.join('\n');
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
        escalationType: 'silent_query'
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

  // Create the pending_queries row for silent_query so subsequent customer
  // messages route through the open-pending follow-up path (single ping per
  // cooldown window) instead of hammering the brother with brand-new alerts.
  if (escalationType === 'silent_query') {
    try {
      freshPendingId = createPendingQuery({
        contactId: contact.id,
        customerMessageId: lastMsg && lastMsg.id,
        customerMessageText: safeCombinedText,
        classifierIntent: classification.intent || 'silent_query'
      });
    } catch (err) {
      logger.warn('handler.escalation.create_pending_query_fail', { message: err.message });
    }
  }

  let alertSendRes = await notifyOwnerEscalation(contact, safeCombinedText, classification);
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
    alertSendRes = await notifyOwnerEscalation(contact, safeCombinedText, classification);
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
    escalationType
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

  const classifierMessage = msgs.length > 1
    ? `[Customer sent ${msgs.length} messages back to back]\n${safeCombinedText}`
    : safeCombinedText;

  const classification = await runClassification(refreshedContact, priorHistory, classifierMessage);

  // Datasheet request fast-path: if customer asks for a datasheet/brochure/spec sheet,
  // attempt to match a Warehouse Stock item that has a PDF attached and send that file.
  // Falls through to normal LLM reply on no match or send failure.
  const DATASHEET_REQUEST_RE = /\b(data\s*sheet|datasheet|brochure|spec\s*sheet|specification\s*sheet|specs?\s*(sheet|pdf|file|document)|technical\s*(sheet|specs?)|product\s*(sheet|brochure|manual|guide|pdf)|user\s*(manual|guide))\b/i;
  if (DATASHEET_REQUEST_RE.test(safeCombinedText)) {
    try {
      const recentText = (priorHistory || []).slice(-6).map(m => String(m.content || '')).join(' ');
      const productsAsked = String(refreshedContact.products_asked_about || '');
      const brandPref = String(refreshedContact.brand_preference || '');
      const enrichedHistory = [recentText, productsAsked, brandPref].filter(Boolean).join(' ');
      const match = warehouse.findItemDatasheetByQuery(safeCombinedText, enrichedHistory);
      if (match && match.item && match.item.datasheet_path) {
        const item = match.item;
        let mediaId = item.datasheet_meta_media_id;
        const fresh = mediaId && warehouse.isMetaMediaFresh(item.datasheet_meta_uploaded_at);
        if (!fresh) {
          mediaId = await uploadMediaToMeta(item.datasheet_path, item.datasheet_mime, item.datasheet_filename);
          warehouse.setItemDatasheetMetaCache(item.id, mediaId);
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
          return;
        }
        logger.warn('handler.datasheet.send_fail_fallback_to_text', {
          contactId: contact.id,
          warehouse_item_id: item.id,
          status: docRes && docRes.status
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
        message: err.message
      });
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

  if (escalationsDisabled() && classification.needs_escalation) {
    logger.warn('handler.escalations_disabled_kill_switch_engaged', {
      contactId: contact.id,
      original_escalation_type: classification.escalation_type
    });
    classification.needs_escalation = false;
    classification.escalation_type = null;
  }

  const isHotEscalation = !!(classification.needs_escalation && classification.escalation_type === 'hot_lead');
  // Casual-confirm gate ONLY applies to non-HOT messages. HOT was already vetted by
  // the classifier's HOT_TRIGGER_RE whitelist; a short "i want to pay" is not casual,
  // it is a commitment. Suppressing it here was eating every natural payment phrase.
  const customerIsCasualConfirm = !isHotEscalation && isCasualConfirmation(safeCombinedText);

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

  let escResult = null;
  if (classification.needs_escalation && !customerIsCasualConfirm) {
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

  const isHot = isHotEscalation;
  const currentOpen = isHot ? null : getOrAutoResolveStalePending(contact.id);
  const customerIsGratitude = customerIsCasualConfirm && isGratitudeMessage(safeCombinedText);
  let expertContext = null;
  if (isHot) {
    expertContext = buildExpertContext({ isHot: true });
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
      '- Do NOT mention prices, quantities, the team, the specialist, the catalog, stock, follow-ups, or any handoff. The customer is not asking for more info; they\'re closing a thread warmly.',
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
      '- Do NOT mention prices, quantities, the team, the specialist, the catalog, stock, follow-ups, or any handoff.',
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
  const reply = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
    expertContext: finalExpertContext,
    allowTrailingQuestion: customerIsGratitude
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
          expertContext: stallContext
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
  const HOT_HANDOFF_REPLY_RE = /\b(account\s+details\s+and\s+(final\s+)?figures|formal\s+documents\s+and\s+(final\s+)?figures|reach\s+out\s+(shortly|soon)\s+with\s+(the\s+)?account|share\s+the\s+account|send\s+(you\s+)?the\s+account|(specialist|sales\s+team|team)\s+(will|is|can)\s+(handle|handling|process|processing|manage|managing)\s+(the\s+)?(payment|order|invoice))/i;
  // STRICT INVARIANT: any time Sunny promises a team follow-up in text, the
  // owner MUST get an alert with the customer's wa.me link. Otherwise the
  // customer waits for a reply that never gets escalated. This regex matches
  // every common shape of that promise.
  const HANDOFF_REPLY_RE = new RegExp([
    // "Team will / can / may / is [action]" + many action verbs
    '\\b(a|the|our|one\\s+of\\s+our)\\s+(specialists?|engineers?|sales\\s+representatives?|sales\\s+reps?|team\\s+members?|team)\\s+(will|can|may|is|are|would)\\s+(reach(ing)?\\s+out|follow(ing)?\\s+up|contact|be\\s+in\\s+touch|get\\s+back|come\\s+back|reconnect|provide|deliver|send|prepare|review|reach|confirm|call|connect|look\\s+(into|at)|check|investigate|verify|clarify|sort|revert|share|update|let\\s+you\\s+know|respond|reply)',
    // First-person "I'll / let me check with the team"
    '(i\'?ll|i\\s+will|let\\s+me|i\\s+can)\\s+(check|confirm|verify|reach\\s+out\\s+to|ask|consult|speak\\s+(to|with)|flag|forward|share|escalate|raise)\\s+(.{0,40})?(the\\s+team|my\\s+team|our\\s+team|the\\s+specialist|the\\s+experts?|with\\s+the\\s+team)',
    // "Flag this for them / for the team"
    'flag\\s+(it|that|this)\\s+(for|to|with)\\s+(them|the\\s+team|the\\s+specialist|the\\s+experts?)',
    // "Forward / escalate / raise this with the team"
    '(forward|escalate|raise|share|pass)\\s+(it|that|this).{0,40}(the\\s+team|them|the\\s+specialist|the\\s+experts?)',
    // "Team is on it" / "team will revert"
    'the\\s+team\\s+(is\\s+on\\s+(it|that)|will\\s+revert|will\\s+circle\\s+back|will\\s+take\\s+a\\s+look)',
    // HOT-handoff specific phrases (kept from original)
    'account\\s+details\\s+and\\s+(final\\s+)?figures',
    'formal\\s+documents\\s+and\\s+(final\\s+)?figures',
    'reach\\s+out\\s+(shortly|soon)\\s+with\\s+(the\\s+)?account',
    'share\\s+the\\s+account',
    'send\\s+(you\\s+)?the\\s+account',
    '(specialist|sales\\s+team|team)\\s+(will|is|can)\\s+(handle|handling|process|processing|manage|managing)\\s+(the\\s+)?(payment|order|invoice)',
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
        // customer reply gets the wa.me specialist link appended.
        if (handoffEsc && handoffEsc.ownerNotified) {
          classification.needs_escalation = true;
          if (!classification.escalation_type) classification.escalation_type = isHot ? 'hot_lead' : 'silent_query';
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
    classification.escalation_type === 'hot_lead'
  );
  if (isHotHandoffThisTurn && !linkAlreadyInText) {
    const link = buildSpecialistLink(safeCombinedText);
    if (link) {
      outboundText = `${outboundText}\n\nDirect line to the specialist: ${link}`;
    }
  }

  const sendRes = await sendMessage(lastMsg.from, outboundText);
  appendMessage(conversation.id, 'outbound', outboundText, {
    whatsapp_message_id: sendRes.messageId,
    intent: isHot ? 'hot_lead_handoff' : (expertContext ? 'silent_query_followup' : classification.intent),
    language: classification.language
  });
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

      const ownerPhone = process.env.OWNER_WHATSAPP;
      if (ownerPhone && msg.from === ownerPhone) {
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

      const ownerPhoneForRl = process.env.OWNER_WHATSAPP;
      if (!ownerPhoneForRl || msg.from !== ownerPhoneForRl) {
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

  const ownerPhone = process.env.OWNER_WHATSAPP;
  const filtered = orphans.filter(o => !ownerPhone || o.phone !== ownerPhone);
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
