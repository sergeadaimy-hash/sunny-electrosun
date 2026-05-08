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
  getContactById
} = require('./memory');
const { runClassification } = require('./classifier');
const { generateReply } = require('./claude');
const { sendMessage, downloadMedia, uploadMediaToMeta, sendDocument } = require('./whatsapp');
const datasheetsModule = require('./datasheets');
const { DB_PATH } = require('../db/init');
const { extractKnowledge, addKnowledgeEntry } = require('./knowledge');
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

const HOT_LEAD_REPLY = "Noted. A specialist will follow up with you shortly with the formal documents and final figures.";
const SILENT_QUERY_REPLY = "A specialist will confirm the exact figure for you shortly.";
const UNSUPPORTED_REPLY = "This number receives text messages only. Please type your question and the team will respond.";

const WELCOME_REPLY = [
  'Welcome to Electro-Sun Global Services',
  '',
  '*Abuja Address*',
  '',
  'Office: Sunset Place, 141 Adetokunbo Ademola Cres, Wuse 2, Abuja',
  '',
  'Warehouse address: Plot 816, Gidado Idriss Way, Idu Industrial Area, FCT Abuja',
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
  if (escalationType === 'hot_lead') {
    const link = buildSpecialistLink(customerMessage);
    if (link) return HOT_LEAD_REPLY + `\n\nDirect line to the specialist: ${link}`;
    return HOT_LEAD_REPLY;
  }
  return SILENT_QUERY_REPLY;
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

  const lines = ['# Awaiting expert input (treat as authoritative)'];
  if (openPending) {
    const createdMs = new Date(openPending.created_at).getTime();
    const elapsed = formatElapsed(Date.now() - createdMs);
    const original = String(openPending.customer_message_text || '').replace(/\s+/g, ' ').slice(0, 200);
    lines.push(`There is an OPEN question already with the human team about: "${original}".`);
    lines.push(`Wait time so far: ${elapsed}. The team has been pinged again about this customer\'s latest message.`);
  } else if (escalationJustCreated) {
    lines.push('This message has just been escalated to the human team. They have been pinged.');
  } else {
    lines.push('A specialist is being looped in on this question.');
  }
  lines.push('');
  lines.push('Voice rules in this state:');
  lines.push('- First decide: is the customer FOLLOWING UP on the open query (e.g. "when?", "any update?", references the same product/quantity), or PIVOTING to a new topic (different product, different size, location, general info, asking for batteries when the open query was about panels)?');
  lines.push('- IF FOLLOWING UP: acknowledge what they JUST wrote in their own language. Confirm the team has the question and is working on it. Use third person ("the team", "the specialist"). Do NOT use first-person stalls ("I will check", "let me confirm", "I will revert", "I will get back to you"). If they are frustrated, briefly acknowledge the wait without over-apologizing, then reassure. If asked "when?", be honest: "as soon as the team confirms".');
  lines.push('- IF PIVOTING TO A NEW TOPIC: ANSWER THE NEW TOPIC DIRECTLY from your catalog and prompt knowledge. Do NOT just say "Noted" or "Noted on the batteries". Do NOT make the customer wait for the old query to resolve before helping them on a new question. Pair the answer with ONE qualifying question (e.g. "What capacity?", "Single or three phase?", "Home or business?"). If they ask about a category we sell ("I want batteries", "show me inverters"), mention what we carry without prices ("We have BOS-G 5.12kWh, BOS-A 7.68kWh, BOS-B Pro 16kWh, what capacity do you need?") or qualify their use case. Briefly mention the open query at the end ONLY if it is still relevant to what they just said; otherwise leave it alone, the team will reach out separately.');
  lines.push('- Do NOT invent prices, specs, install dates, or fixed turnaround times.');
  lines.push('- Two sentences max in either branch. No bullet lists. No catalog price dumps. Vary phrasing across replies; do not send the exact same sentence twice in a row.');
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

async function notifyOwnerEscalation(contact, message, classification, pendingQueryId) {
  const ownerPhone = process.env.OWNER_WHATSAPP;
  if (!ownerPhone) {
    logger.warn('escalation.no_owner_phone');
    return null;
  }

  const isHot = classification.escalation_type === 'hot_lead';
  const tag = pendingQueryId ? ` [QID:${pendingQueryId}]` : '';
  const header = isHot
    ? `HOT LEAD, action needed now.${tag}`
    : `Lead query, please confirm.${tag}`;

  const lines = [
    header,
    `Contact: ${contact.name || 'unknown'} (${contact.phone})`,
    `Category: ${classification.category || 'unsorted'}`,
    `Temperature: ${classification.lead_temperature || 'unknown'}`,
    `Client type: ${classification.client_type || 'unknown'}`,
    `Intent: ${classification.intent}`,
    `Confidence: ${classification.confidence}`,
    `Location: ${contact.location || 'unknown'}`,
    '',
    'Customer message:',
    message,
    '',
    isHot
      ? 'Reply directly to the customer in WhatsApp to take over.'
      : 'REPLY to THIS message with the answer. The team will deliver it to the customer automatically.'
  ];
  const alertText = lines.join('\n');
  const sendRes = await sendMessage(ownerPhone, alertText);
  try {
    const ownerContact = getOrCreateContact(ownerPhone, null);
    const ownerConv = getActiveConversation(ownerContact.id);
    appendMessage(ownerConv.id, 'outbound', alertText, {
      whatsapp_message_id: sendRes && sendRes.messageId,
      intent: isHot ? 'escalation_alert_hot' : 'escalation_alert_silent',
      language: 'english'
    });
  } catch (err) {
    logger.warn('escalation.persist_owner_alert_fail', {
      message: err.message,
      qid: pendingQueryId
    });
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

  const openPending = getOpenPendingQueryForContact(contact.id);

  if (openPending) {
    const followThrottle = security.checkFollowupThrottle(contact.id);
    let ownerNotified = false;
    if (followThrottle.allowed) {
      const ownerPhone = process.env.OWNER_WHATSAPP;
      if (ownerPhone) {
        const followUp = [
          `Follow-up on [QID:${openPending.id}], same customer is still asking.`,
          `Contact: ${contact.name || 'unknown'} (${contact.phone})`,
          '',
          'New customer message:',
          safeCombinedText,
          '',
          `REPLY to the original [QID:${openPending.id}] alert with the answer.`
        ].join('\n');
        const followSendRes = await sendMessage(ownerPhone, followUp);
        try {
          const ownerContact = getOrCreateContact(ownerPhone, null);
          const ownerConv = getActiveConversation(ownerContact.id);
          appendMessage(ownerConv.id, 'outbound', followUp, {
            whatsapp_message_id: followSendRes && followSendRes.messageId,
            intent: 'escalation_followup_ping',
            language: 'english'
          });
        } catch (err) {
          logger.warn('escalation.persist_owner_followup_fail', {
            message: err.message,
            qid: openPending.id
          });
        }
        ownerNotified = true;
      }
      logger.info('handler.escalation.followup_to_open_query', {
        contactId: contact.id,
        query_id: openPending.id,
        source: source || 'classifier'
      });
    } else {
      security.logSecurityEvent('followup_throttled', {
        contactId: contact.id,
        query_id: openPending.id,
        last_at: followThrottle.lastAt,
        cooldown_ms: followThrottle.cooldownMs
      });
    }
    return { openPending, freshPendingId: null, ownerNotified, escalationType };
  }

  const escThrottle = security.checkEscalationThrottle(contact.id);
  if (!escThrottle.allowed) {
    security.logSecurityEvent('escalation_throttled', {
      contactId: contact.id,
      last_at: escThrottle.lastAt,
      cooldown_ms: escThrottle.cooldownMs,
      source: source || 'classifier'
    });
    return { openPending: null, freshPendingId: null, ownerNotified: false, escalationType, throttled: true };
  }

  let pendingQueryId = null;
  if (escalationType === 'silent_query') {
    pendingQueryId = createPendingQuery({
      contactId: contact.id,
      customerMessageId: lastMsg.id,
      customerMessageText: safeCombinedText,
      classifierIntent: classification.intent
    });
  }

  const alertSendRes = await notifyOwnerEscalation(contact, safeCombinedText, classification, pendingQueryId);
  if (pendingQueryId && alertSendRes?.messageId) {
    setPendingQueryAlertId(pendingQueryId, alertSendRes.messageId);
  }

  return {
    openPending: null,
    freshPendingId: pendingQueryId,
    ownerNotified: !!alertSendRes,
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

  // Datasheet request fast-path: if customer is asking for a datasheet/brochure/spec sheet
  // AND we can match a stored datasheet by keyword, upload to Meta (cached) and send the document.
  const DATASHEET_REQUEST_RE = /\b(data\s*sheet|datasheet|brochure|spec\s*sheet|specification\s*sheet|specs?\s*(sheet|pdf|file|document)|technical\s*(sheet|specs?)|product\s*(sheet|brochure|manual|guide|pdf)|user\s*(manual|guide))\b/i;
  if (DATASHEET_REQUEST_RE.test(safeCombinedText)) {
    try {
      const recentText = (priorHistory || []).slice(-6).map(m => String(m.content || '')).join(' ');
      const match = datasheetsModule.findDatasheetByQuery(safeCombinedText, recentText);
      if (match && match.sheet) {
        const sheet = match.sheet;
        let mediaId = sheet.meta_media_id;
        if (!datasheetsModule.isMetaMediaFresh(sheet)) {
          mediaId = await uploadMediaToMeta(sheet.file_path, sheet.mime_type, sheet.filename);
          datasheetsModule.setMetaMediaCache(sheet.id, mediaId);
        }
        const caption = `${sheet.label} — datasheet from Electro-Sun`;
        const docRes = await sendDocument(lastMsg.from, mediaId, sheet.filename, caption);
        if (docRes && docRes.ok) {
          const noteText = `[Datasheet sent: ${sheet.label}]`;
          appendMessage(conversation.id, 'outbound', noteText, {
            whatsapp_message_id: docRes.messageId,
            intent: 'datasheet_sent',
            language: classification.language || 'english'
          });
          logger.info('handler.datasheet.sent', {
            contactId: contact.id,
            datasheet_id: sheet.id,
            label: sheet.label,
            score: match.score
          });
          return;
        }
        logger.warn('handler.datasheet.send_fail_fallback_to_text', {
          contactId: contact.id,
          datasheet_id: sheet.id,
          status: docRes && docRes.status
        });
        // fall through to normal reply path so customer at least gets text
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
      // fall through to normal reply
    }
  }

  if (handlerIsGreeting(combinedText)) {
    classification.needs_escalation = false;
    classification.escalation_type = null;
    if (classification.lead_temperature === 'HOT') classification.lead_temperature = 'COLD';

    const hasPriorOutbound = Array.isArray(priorHistory) && priorHistory.some(m => m && m.role === 'assistant');
    if (!hasPriorOutbound) {
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
          chars: WELCOME_REPLY.length
        });
        return;
      } catch (err) {
        logger.error('handler.welcome_send_fail', {
          contactId: contact.id,
          phone: lastMsg.from,
          message: err.message
        });
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

  let escResult = null;
  if (classification.needs_escalation) {
    escResult = await notifyOwnerForEscalation({
      contact: refreshedContact,
      classification,
      safeCombinedText,
      lastMsg,
      batchSize: msgs.length,
      source: 'classifier'
    });
  }

  const isHot = !!(classification.needs_escalation && classification.escalation_type === 'hot_lead');
  const currentOpen = isHot ? null : getOpenPendingQueryForContact(contact.id);
  let expertContext = null;
  if (isHot) {
    expertContext = buildExpertContext({ isHot: true });
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
  const reply = await generateReply(priorHistory, replyMessage, refreshedContact, attachments, {
    expertContext
  });
  if (!reply.ok || !reply.text) {
    const fallback = pickHoldingReply(isHot ? 'hot_lead' : 'silent_query', safeCombinedText);
    const sendRes = await sendMessage(lastMsg.from, fallback);
    appendMessage(conversation.id, 'outbound', fallback, {
      whatsapp_message_id: sendRes.messageId,
      intent: isHot ? 'hot_lead_handoff' : 'silent_query',
      language: classification.language
    });
    logger.warn('handler.reply_fallback_used', { contactId: contact.id, batch_size: msgs.length });
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
          reply.text = 'Noted. The team is on it.';
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
  const HANDOFF_REPLY_RE = /\b((a|the|our|one\s+of\s+our)\s+(specialists?|engineers?|sales\s+representatives?|sales\s+reps?|team\s+members?|team)\s+(will|is)\s+(reach(ing)?\s+out|follow(ing)?\s+up|contact|be\s+in\s+touch|get\s+back|come\s+back|reconnect|provide|deliver|send|prepare|review|reach|confirm|call|connect)|account\s+details\s+and\s+(final\s+)?figures|formal\s+documents\s+and\s+(final\s+)?figures|reach\s+out\s+(shortly|soon)\s+with\s+(the\s+)?account|share\s+the\s+account|send\s+(you\s+)?the\s+account|(specialist|sales\s+team|team)\s+(will|is)\s+(handle|handling|process|processing|manage|managing)\s+(the\s+)?(payment|order|invoice))/i;
  const replyMentionsHandoff = HANDOFF_REPLY_RE.test(outboundText);
  const linkAlreadyInText = /https?:\/\/wa\.me\//i.test(outboundText);

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
        await notifyOwnerForEscalation({
          contact: refreshedContact,
          classification: handoffClassification,
          safeCombinedText,
          lastMsg,
          batchSize: msgs.length,
          source: 'handoff_in_reply'
        });
      } catch (err) {
        logger.warn('handler.handoff_in_reply_alert_fail', {
          contactId: contact.id,
          message: err.message
        });
      }
    }
  }

  if ((isHot || replyMentionsHandoff) && !linkAlreadyInText) {
    const link = buildSpecialistLink(safeCombinedText);
    if (link) {
      outboundText = `${outboundText}\n\nDirect line to the specialist: ${link}`;
      if (!isHot) {
        logger.info('handler.handoff_link_appended_no_hot', {
          contactId: contact.id,
          reply_preview: outboundText.slice(0, 200)
        });
      }
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

module.exports = {
  handleInbound,
  extractMessages,
  recoverOrphanedInbound,
  answerPendingForContact,
  autoReleaseStaleHumanConversations
};
