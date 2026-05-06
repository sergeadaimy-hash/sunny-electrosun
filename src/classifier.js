const { classify } = require('./claude');
const { updateContactFields, logEvent } = require('./memory');
const logger = require('./utils/logger');

function bodyText(message) {
  if (typeof message === 'string') return message.trim();
  if (message && typeof message === 'object' && typeof message.body === 'string') return message.body.trim();
  return '';
}

const GREETING_RE = /^(hi+|hello+|hey+|hola|bonjour|salam|asalam|good\s+(morning|afternoon|evening|day)|gm|ga|ge|how\s+far|wetin\s+dey|sup|yo|howdy|greetings|hii?|test|testing)\b[\s!.?]*$/i;

function isCasualGreeting(text) {
  const t = (text || '').trim();
  return t.length <= 30 && GREETING_RE.test(t);
}

const HOT_TRIGGER_RE = /\b(want\s+to\s+pay|ready\s+to\s+pay|pay\s+(now|today|tomorrow|this\s+week)|i'?ll\s+pay|let\s+me\s+pay|paying\s+(now|today)|making\s+(the\s+)?payment|send\s+(me\s+)?(your|the|account)\s+(account|bank|details|number|info)|share\s+(your|the|account)\s+(account|bank)|account\s+(number|details)\s+please|send\s+(me\s+)?(a\s+)?proforma|send\s+(me\s+)?(an\s+)?invoice|issue\s+(me\s+)?(a\s+)?(proforma|invoice|quotation)|deposit\s+\d|\d+%\s+deposit|let'?s\s+(proceed|go\s+ahead|do\s+this)|go\s+ahead\s+with|i'?m\s+ready\s+to\s+(buy|order|pay|proceed)|i\s+am\s+ready\s+to\s+(buy|order|pay|proceed)|confirm\s+(the\s+)?order|place\s+(the\s+)?order|send\s+(your|the)\s+(engineer|team)|when\s+can\s+(you|your\s+team)\s+(install|come|deliver|visit)|ready\s+to\s+(order|buy|proceed)|i\s+want\s+to\s+(order|buy|proceed)|i'?ll\s+(order|buy|proceed)|book\s+(the\s+)?(installation|site\s+visit)|schedule\s+(the\s+)?(installation|site\s+visit))\b/i;

function hasHotTrigger(text) {
  return HOT_TRIGGER_RE.test(text || '');
}

const CLARIFICATION_RE = /^(\??\s*)?(for\s+what|why|how|huh|what|wat|what\?+|what\s+is\s+this(\s+message)?|what\s+do\s+you\s+mean|i\s+don'?t\s+understand|i\s+don'?t\s+get\s+(it|that)|come\s+again|please\s+repeat|repeat|explain|you\s+mean|are\s+you\s+(serious|kidding|sure)|ok\??|okay\??|hmm+|eh+|abeg|sorry\??|pardon\??)[\s.?!]*$/i;

function isClarificationMessage(text) {
  const t = (text || '').trim();
  return t.length <= 40 && CLARIFICATION_RE.test(t);
}

async function runClassification(contact, history, message) {
  const body = bodyText(message);

  if (isCasualGreeting(body)) {
    logger.info('classifier.greeting_fastpath', {
      contactId: contact.id,
      message_preview: body
    });
    return {
      category: 'C1',
      lead_temperature: 'COLD',
      client_type: 'unknown',
      intent: 'greeting',
      language: 'english',
      confidence: 95,
      needs_escalation: false,
      escalation_type: null,
      lead_data: {
        name: null, location: null, use_case: null, load_estimate: null,
        timeline: null, products_asked_about: null, brand_preference: null,
        budget_mentioned: null
      }
    };
  }

  const result = await classify(history, message);

  if (result.lead_temperature === 'HOT' && !result.needs_escalation) {
    logger.warn('classifier.hot_without_escalation_demoted_to_warm', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      message_preview: body.slice(0, 80)
    });
    result.lead_temperature = 'WARM';
  }

  if (result.lead_temperature === 'HOT' && !hasHotTrigger(body)) {
    logger.warn('classifier.hot_without_commitment_phrase_demoted', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      message_preview: body.slice(0, 120)
    });
    result.lead_temperature = 'WARM';
    result.needs_escalation = false;
    result.escalation_type = null;
  }

  if (result.needs_escalation && !result.escalation_type) {
    logger.warn('classifier.escalation_without_type_skipped', {
      contactId: contact.id,
      message_preview: body.slice(0, 80)
    });
    result.needs_escalation = false;
  }

  if (result.needs_escalation && isCasualGreeting(body)) {
    logger.warn('classifier.greeting_escalation_blocked', {
      contactId: contact.id,
      escalation_type: result.escalation_type,
      message_preview: body
    });
    result.needs_escalation = false;
    result.escalation_type = null;
    if (result.lead_temperature === 'HOT') result.lead_temperature = 'COLD';
  }

  if (result.needs_escalation && isClarificationMessage(body)) {
    logger.warn('classifier.clarification_escalation_blocked', {
      contactId: contact.id,
      escalation_type: result.escalation_type,
      message_preview: body
    });
    result.needs_escalation = false;
    result.escalation_type = null;
    if (result.lead_temperature === 'HOT') result.lead_temperature = 'COLD';
  }

  const updates = {};
  if (result.language && !contact.language) updates.language = result.language;

  if (result.lead_temperature) {
    updates.lead_temperature = result.lead_temperature;
  }

  if (result.client_type && result.client_type !== 'unknown' && !contact.client_type) {
    updates.client_type = result.client_type;
  }

  if (result.lead_data) {
    const ld = result.lead_data;
    if (ld.name && !contact.name) updates.name = ld.name;
    if (ld.location && !contact.location) updates.location = ld.location;
    if (ld.use_case && !contact.use_case) updates.use_case = ld.use_case;
    if (ld.load_estimate && !contact.load_estimate) updates.load_estimate = ld.load_estimate;
    if (ld.timeline && !contact.timeline) updates.timeline = ld.timeline;
    if (ld.products_asked_about && !contact.products_asked_about) updates.products_asked_about = ld.products_asked_about;
    if (ld.brand_preference && !contact.brand_preference) updates.brand_preference = ld.brand_preference;
    if (ld.budget_mentioned && !contact.budget_mentioned) updates.budget_mentioned = ld.budget_mentioned;
  }

  let categoryChanged = false;
  if (result.category && result.category !== contact.category) {
    updates.category = result.category;
    categoryChanged = true;
  }

  if (Object.keys(updates).length) {
    updateContactFields(contact.id, updates);
  }

  if (categoryChanged) {
    logEvent(contact.id, 'category_changed', {
      from: contact.category,
      to: result.category,
      confidence: result.confidence,
      lead_temperature: result.lead_temperature,
      escalation_type: result.escalation_type
    });
    logger.info('classifier.category_changed', {
      contactId: contact.id,
      from: contact.category,
      to: result.category,
      temp: result.lead_temperature,
      escalation_type: result.escalation_type
    });
  } else if (result.lead_temperature) {
    logger.info('classifier.no_category_change', {
      contactId: contact.id,
      category: result.category,
      temp: result.lead_temperature,
      escalation_type: result.escalation_type,
      needs_escalation: result.needs_escalation
    });
  }

  return result;
}

module.exports = { runClassification };
