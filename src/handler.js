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

const HOT_LEAD_REPLY = "Great. One of our specialists will reach out to you shortly to finalise the details and send the formal documents.";
const SILENT_QUERY_REPLY = "Our specialist will confirm the exact figure for you shortly.";
const UNSUPPORTED_REPLY = "Hello, this number receives text messages only. Please type your question and I'll get back to you right away.";

function buildSpecialistLink(customerMessage) {
  const num = (process.env.SPECIALIST_DIRECT_LINK || '').replace(/\D/g, '');
  if (!num) return null;
  const topic = (customerMessage || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prefilled = topic
    ? `Hi, I was speaking with Electro-Sun and have a question: "${topic}"`
    : 'Hi, I was speaking with Electro-Sun and have an urgent question.';
  return `https://wa.me/${num}?text=${encodeURIComponent(prefilled)}`;
}

function pickHoldingReply(escalationType, customerMessage) {
  const base = escalationType === 'hot_lead' ? HOT_LEAD_REPLY : SILENT_QUERY_REPLY;
  const link = buildSpecialistLink(customerMessage);
  if (!link) return base;
  if (escalationType === 'hot_lead') {
    return base + `\n\nIf you'd like to reach our specialist directly now: ${link}`;
  }
  return base + `\n\nFor urgent matters you can also reach our specialist directly: ${link}`;
}

function pickUnsupportedReply() {
  return UNSUPPORTED_REPLY;
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

const OWNER_NON_REPLY_MESSAGE = [
  "Hi. I am keeping owner-mode replies minimal for now while we tune the teaching workflow.",
  "",
  "To manage facts, prices, or the catalog, use the admin dashboard:",
  "https://sunny-electrosun-production.up.railway.app/admin",
  "",
  "To reply to a specific customer, long-press the alert message I sent you for that conversation and reply there. Your reply will be relayed to the customer automatically."
].join('\n');

async function handleOwnerNonQueryMessage(msg) {
  const ownerContact = getOrCreateContact(msg.from, msg.profileName);
  const ownerConv = getActiveConversation(ownerContact.id);

  appendMessage(ownerConv.id, 'inbound', msg.body, {
    whatsapp_message_id: msg.id,
    intent: 'owner_message_no_action'
  });

  logger.info('handler.owner_non_query.received', {
    ownerPhone: msg.from,
    preview: (msg.body || '').slice(0, 120)
  });

  const sendRes = await sendMessage(msg.from, OWNER_NON_REPLY_MESSAGE);
  appendMessage(ownerConv.id, 'outbound', OWNER_NON_REPLY_MESSAGE, {
    whatsapp_message_id: sendRes.messageId,
    intent: 'owner_redirect_ack'
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

async function handleInbound(payload) {
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

      const contact = getOrCreateContact(msg.from, msg.profileName);
      const conversation = getActiveConversation(contact.id);
      const priorHistory = getRecentHistory(contact.id, 50);

      const persistedBody = msg.kind === 'image'
        ? (msg.body ? `[image] ${msg.body}` : '[image]')
        : msg.body;

      appendMessage(conversation.id, 'inbound', persistedBody, {
        whatsapp_message_id: msg.id,
        media_path: imageStorage?.path || null,
        media_mime: imageStorage?.mime || null
      });

      if (conversation.human_handled) {
        logger.info('handler.human_handled_skip', {
          contactId: contact.id,
          conversationId: conversation.id
        });
        continue;
      }

      const classifierMessage = msg.kind === 'image'
        ? (msg.body
            ? `[Customer sent an image with caption]: ${msg.body}`
            : `[Customer sent an image with no caption]`)
        : msg.body;

      const classification = await runClassification(contact, priorHistory, classifierMessage);

      const refreshedContact = { ...contact, ...readBackContact(contact.id) };

      if (classification.needs_escalation) {
        const escalationType = classification.escalation_type || 'silent_query';
        logEvent(contact.id, 'escalated', {
          intent: classification.intent,
          escalation_type: escalationType,
          confidence: classification.confidence
        });

        let pendingQueryId = null;
        if (escalationType === 'silent_query') {
          pendingQueryId = createPendingQuery({
            contactId: contact.id,
            customerMessageId: msg.id,
            customerMessageText: persistedBody,
            classifierIntent: classification.intent
          });
        }

        const alertSendRes = await notifyOwnerEscalation(refreshedContact, persistedBody, classification, pendingQueryId);
        if (pendingQueryId && alertSendRes?.messageId) {
          setPendingQueryAlertId(pendingQueryId, alertSendRes.messageId);
          logger.info('handler.silent_query.created', {
            queryId: pendingQueryId,
            alertMessageId: alertSendRes.messageId,
            customerPhone: contact.phone
          });
        }

        const holding = pickHoldingReply(escalationType, msg.body);
        const sendRes = await sendMessage(msg.from, holding);
        appendMessage(conversation.id, 'outbound', holding, {
          whatsapp_message_id: sendRes.messageId,
          intent: escalationType === 'hot_lead' ? 'hot_lead_handoff' : 'silent_query',
          language: classification.language
        });
        continue;
      }

      const replyMessage = msg.kind === 'image' && !msg.body
        ? '(customer sent an image without a caption, see image attached)'
        : msg.body;
      const replyAttachments = imageAttachment ? [imageAttachment] : [];
      const reply = await generateReply(priorHistory, replyMessage, refreshedContact, replyAttachments);
      if (!reply.ok || !reply.text) {
        const fallback = pickHoldingReply('silent_query', msg.body);
        const sendRes = await sendMessage(msg.from, fallback);
        appendMessage(conversation.id, 'outbound', fallback, {
          whatsapp_message_id: sendRes.messageId,
          language: classification.language
        });
        logger.warn('handler.reply_fallback_used', { contactId: contact.id });
        continue;
      }

      const sendRes = await sendMessage(msg.from, reply.text);
      appendMessage(conversation.id, 'outbound', reply.text, {
        whatsapp_message_id: sendRes.messageId,
        intent: classification.intent,
        language: classification.language
      });
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

module.exports = { handleInbound, extractMessages };
