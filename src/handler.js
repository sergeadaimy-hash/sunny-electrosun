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
  getContactById
} = require('./memory');
const { runClassification } = require('./classifier');
const { generateReply } = require('./claude');
const { sendMessage, downloadMedia } = require('./whatsapp');
const { DB_PATH } = require('../db/init');
const { extractKnowledge, addKnowledgeEntry } = require('./knowledge');
const { answerOwnerQuestion } = require('./owner_qa');
const { transcribeAudio } = require('./transcribe');

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
  return await sendMessage(ownerPhone, lines.join('\n'));
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

  const classifierMessage = msgs.length > 1
    ? `[Customer sent ${msgs.length} messages back to back]\n${combinedText}`
    : combinedText;

  const classification = await runClassification(refreshedContact, priorHistory, classifierMessage);

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

  if (classification.needs_escalation) {
    const escalationType = classification.escalation_type || 'silent_query';
    logEvent(contact.id, 'escalated', {
      intent: classification.intent,
      escalation_type: escalationType,
      confidence: classification.confidence,
      batch_size: msgs.length
    });

    let pendingQueryId = null;
    if (escalationType === 'silent_query') {
      pendingQueryId = createPendingQuery({
        contactId: contact.id,
        customerMessageId: lastMsg.id,
        customerMessageText: combinedText,
        classifierIntent: classification.intent
      });
    }

    const alertSendRes = await notifyOwnerEscalation(refreshedContact, combinedText, classification, pendingQueryId);
    if (pendingQueryId && alertSendRes?.messageId) {
      setPendingQueryAlertId(pendingQueryId, alertSendRes.messageId);
    }

    const holding = pickHoldingReply(escalationType, combinedText);
    const sendRes = await sendMessage(lastMsg.from, holding);
    appendMessage(conversation.id, 'outbound', holding, {
      whatsapp_message_id: sendRes.messageId,
      intent: escalationType === 'hot_lead' ? 'hot_lead_handoff' : 'silent_query',
      language: classification.language
    });
    return;
  }

  const replyMessage = combinedText || '(customer sent attachments only, see images)';
  const reply = await generateReply(priorHistory, replyMessage, refreshedContact, attachments);
  if (!reply.ok || !reply.text) {
    const fallback = pickHoldingReply('silent_query', combinedText);
    const sendRes = await sendMessage(lastMsg.from, fallback);
    appendMessage(conversation.id, 'outbound', fallback, {
      whatsapp_message_id: sendRes.messageId,
      language: classification.language
    });
    logger.warn('handler.reply_fallback_used', { contactId: contact.id, batch_size: msgs.length });
    return;
  }

  const sendRes = await sendMessage(lastMsg.from, reply.text);
  appendMessage(conversation.id, 'outbound', reply.text, {
    whatsapp_message_id: sendRes.messageId,
    intent: classification.intent,
    language: classification.language
  });
  logger.info('handler.batch.replied', {
    contactId: contact.id,
    batch_size: msgs.length,
    reply_chars: reply.text.length
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

      let imageAttachment = null;
      let imageStorage = null;
      if (msg.kind === 'image') {
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

module.exports = { handleInbound, extractMessages, recoverOrphanedInbound };
