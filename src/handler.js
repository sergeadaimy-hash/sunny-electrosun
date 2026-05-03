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
const { sendMessage } = require('./whatsapp');

const HOT_LEAD_REPLY = "Great. One of our specialists will reach out to you shortly to finalise the details and send the formal documents.";
const SILENT_QUERY_REPLY = "Let me confirm the exact spec or price and get back to you in a few minutes.";
const UNSUPPORTED_REPLY = "Hello, this number receives text messages only. Please type your question and I'll get back to you right away.";

function pickHoldingReply(escalationType) {
  if (escalationType === 'hot_lead') return HOT_LEAD_REPLY;
  return SILENT_QUERY_REPLY;
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
      if (ownerPhone && msg.from === ownerPhone && msg.replyToId) {
        const pending = findPendingByAlertId(msg.replyToId);
        if (pending) {
          await handleOwnerReply(msg, pending);
          continue;
        }
      }

      const contact = getOrCreateContact(msg.from, msg.profileName);
      const conversation = getActiveConversation(contact.id);
      const priorHistory = getRecentHistory(contact.id, 20);

      appendMessage(conversation.id, 'inbound', msg.body, {
        whatsapp_message_id: msg.id
      });

      const classification = await runClassification(contact, priorHistory, msg.body);

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
            customerMessageText: msg.body,
            classifierIntent: classification.intent
          });
        }

        const alertSendRes = await notifyOwnerEscalation(refreshedContact, msg.body, classification, pendingQueryId);
        if (pendingQueryId && alertSendRes?.messageId) {
          setPendingQueryAlertId(pendingQueryId, alertSendRes.messageId);
          logger.info('handler.silent_query.created', {
            queryId: pendingQueryId,
            alertMessageId: alertSendRes.messageId,
            customerPhone: contact.phone
          });
        }

        const holding = pickHoldingReply(escalationType);
        const sendRes = await sendMessage(msg.from, holding);
        appendMessage(conversation.id, 'outbound', holding, {
          whatsapp_message_id: sendRes.messageId,
          intent: escalationType === 'hot_lead' ? 'hot_lead_handoff' : 'silent_query',
          language: classification.language
        });
        continue;
      }

      const reply = await generateReply(priorHistory, msg.body, refreshedContact);
      if (!reply.ok || !reply.text) {
        const fallback = pickHoldingReply('silent_query');
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
