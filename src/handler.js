const logger = require('./utils/logger');
const {
  getOrCreateContact,
  getActiveConversation,
  appendMessage,
  getRecentHistory,
  getMessageByWhatsappId,
  logEvent
} = require('./memory');
const { runClassification } = require('./classifier');
const { generateReply } = require('./claude');
const { sendMessage } = require('./whatsapp');

const HOLDING_REPLIES = {
  english: "Thanks for reaching out. Our engineer will follow up shortly.",
  pidgin: "Thanks o, our engineer go reach you soon.",
  hausa: "Na gode. Injiniyanmu zai tuntube ka nan ba da jimawa ba.",
  yoruba: "E se. Onise wa yoo kan si yin laipe.",
  igbo: "Daalu. Onye injinia anyi ga-akpoghachi gi n'oge na-adighi anya."
};

const UNSUPPORTED_REPLIES = {
  english: "Hi, I can only read text messages on this number. Please type your question and I'll help you right away.",
  pidgin: "Abeg, na text messages I fit read for this number. Just type your question and I go answer you sharp sharp.",
  hausa: "Sannu, sako na rubutu kawai nake iya karantawa a wannan lambar. Don Allah ka rubuto tambayarka, zan amsa nan take.",
  yoruba: "Pẹlẹ o, ọrọ kíkà nikan ni mo lè ka lori nọmba yi. Ẹ jọwọ kọ ìbéèrè yín, mo máa dáhùn ní kíákíá.",
  igbo: "Ndewo, naanị ozi ederede ka m nwere ike ịgụ na nọmba a. Biko dee ajụjụ gị, m ga-azaghachi ozugbo."
};

function pickHoldingReply(language) {
  return HOLDING_REPLIES[language] || HOLDING_REPLIES.english;
}

function pickUnsupportedReply(language) {
  return UNSUPPORTED_REPLIES[language] || UNSUPPORTED_REPLIES.english;
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
          profileName: profileNameByPhone[msg.from] || null
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

async function notifyOwnerEscalation(contact, message, classification) {
  const ownerPhone = process.env.OWNER_WHATSAPP;
  if (!ownerPhone) {
    logger.warn('escalation.no_owner_phone');
    return;
  }

  const lines = [
    'New escalation needed.',
    `Contact: ${contact.name || 'unknown'} (${contact.phone})`,
    `Category: ${classification.category}`,
    `Intent: ${classification.intent}`,
    `Confidence: ${classification.confidence}`,
    `Location: ${contact.location || 'unknown'}`,
    `Use case: ${contact.use_case || 'unknown'}`,
    '',
    'Last message:',
    message
  ];
  await sendMessage(ownerPhone, lines.join('\n'));
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

  const reply = pickUnsupportedReply(language);
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

      const contact = getOrCreateContact(msg.from, msg.profileName);
      const conversation = getActiveConversation(contact.id);
      const priorHistory = getRecentHistory(contact.id, 20);

      appendMessage(conversation.id, 'inbound', msg.body, {
        whatsapp_message_id: msg.id
      });

      const classification = await runClassification(contact, priorHistory, msg.body);

      const refreshedContact = { ...contact, ...readBackContact(contact.id) };

      if (classification.needs_escalation) {
        logEvent(contact.id, 'escalated', {
          intent: classification.intent,
          confidence: classification.confidence
        });
        await notifyOwnerEscalation(refreshedContact, msg.body, classification);
        const holding = pickHoldingReply(classification.language);
        const sendRes = await sendMessage(msg.from, holding);
        appendMessage(conversation.id, 'outbound', holding, {
          whatsapp_message_id: sendRes.messageId,
          intent: 'escalation_needed',
          language: classification.language
        });
        continue;
      }

      const reply = await generateReply(priorHistory, msg.body, refreshedContact);
      if (!reply.ok || !reply.text) {
        const fallback = pickHoldingReply(classification.language);
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
