const { classify } = require('./claude');
const { updateContactFields, logEvent } = require('./memory');
const logger = require('./utils/logger');

async function runClassification(contact, history, message) {
  const result = await classify(history, message);

  if (result.lead_temperature === 'HOT' && !result.needs_escalation) {
    logger.warn('classifier.hot_temperature_without_escalation_fixed', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type
    });
    result.needs_escalation = true;
    result.escalation_type = 'hot_lead';
  }

  const updates = {};
  if (result.language && !contact.language) updates.language = result.language;
  if (result.lead_data) {
    const ld = result.lead_data;
    if (ld.name && !contact.name) updates.name = ld.name;
    if (ld.location && !contact.location) updates.location = ld.location;
    if (ld.use_case && !contact.use_case) updates.use_case = ld.use_case;
    if (ld.load_estimate && !contact.load_estimate) updates.load_estimate = ld.load_estimate;
    if (ld.timeline && !contact.timeline) updates.timeline = ld.timeline;
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
