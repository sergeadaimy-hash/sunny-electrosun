const { classify } = require('./claude');
const { updateContactFields, logEvent } = require('./memory');
const logger = require('./utils/logger');

async function runClassification(contact, history, message) {
  const result = await classify(history, message);

  if (result.lead_temperature === 'HOT' && !result.needs_escalation) {
    logger.warn('classifier.hot_without_escalation_demoted_to_warm', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      message_preview: String(message?.body || '').slice(0, 80)
    });
    result.lead_temperature = 'WARM';
  }

  if (result.needs_escalation && !result.escalation_type) {
    logger.warn('classifier.escalation_without_type_skipped', {
      contactId: contact.id,
      message_preview: String(message?.body || '').slice(0, 80)
    });
    result.needs_escalation = false;
  }

  const body = String(message?.body || '').trim();
  const looksLikeGreeting = body.length <= 20 && /^(hi|hello|hey|hola|bonjour|salam|asalam|good\s+(morning|afternoon|evening|day)|gm|ga|ge|how\s+far|wetin\s+dey|sup|yo)\b/i.test(body);
  if (result.needs_escalation && looksLikeGreeting) {
    logger.warn('classifier.greeting_escalation_blocked', {
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
