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

const HOT_TRIGGER_RE = /\b(want\s+to\s+pay|ready\s+to\s+pay|can\s+(i|we)\s+pay|may\s+(i|we)\s+pay|pay\s+(now|today|tomorrow|this\s+week)|i'?ll\s+pay|let\s+me\s+pay|paying\s+(now|today)|making\s+(the\s+)?payment|send\s+(me\s+)?(your\s+|the\s+)?account(\s+(number|details|info|name|bank))?|send\s+account|share\s+(your|the|account)\s+(account|bank)|account\s+(number|details|name|info)\s+(please|plz|pls|kindly)?|send\s+(me\s+)?(a\s+|the\s+)?proforma|send\s+(me\s+)?(an\s+|the\s+)?invoice|prepare\s+(the\s+|a\s+|an\s+)?(proforma|invoice|quotation)|issue\s+(me\s+)?(a\s+)?(proforma|invoice|quotation)|deposit\s+\d|\d+%\s+deposit|let'?s\s+(proceed|go\s+ahead|do\s+this)|go\s+ahead\s+with|i'?m\s+ready\s+to\s+(buy|order|pay|proceed)|i\s+am\s+ready\s+to\s+(buy|order|pay|proceed)|confirm\s+(the\s+)?order|place\s+(the\s+)?order|send\s+(your|the)\s+(engineer|team)|when\s+can\s+(you|your\s+team)\s+(install|come|deliver|visit)|ready\s+to\s+(order|buy|proceed)|i\s+want\s+to\s+(order|buy|proceed)|i'?ll\s+(order|buy|proceed)|book\s+(the\s+)?(installation|site\s+visit)|schedule\s+(the\s+)?(installation|site\s+visit)|i\s+(am\s+|will\s+)?proceed|going\s+to\s+pay|wanna\s+pay|wants?\s+to\s+pay|payment\s+now|book\s+now|order\s+now|picking\s+(it\s+)?up\s+(tomorrow|today|this\s+week|next\s+week|on\s+\w+)|i'?ll\s+(be\s+)?(picking|collecting|coming\s+to\s+pick)|i'?ll\s+come\s+(tomorrow|today|to\s+pick|to\s+collect)|coming\s+(tomorrow|today)\s+to\s+(pick|collect|pay)|my\s+name\s+is\s+\w+|name\s+is\s+\w+\s+\w+|(company|business)\s+name\s+is|is\s+my\s+(company|business)\s+name|the\s+(company|business)\s+name\s+is|register\s+(it\s+)?(under|in)\s+(my|the)\s+name|(make|put)\s+(the\s+)?(invoice|proforma|order)\s+(in|under)\s+(my|the)\s+name|make\s+(it|the\s+(invoice|proforma))\s+for\s+\w+\s+\w+)\b/i;

function hasHotTrigger(text) {
  return HOT_TRIGGER_RE.test(text || '');
}

// Dealer pricing signal: customer has self-identified as a dealer/reseller
// AND is asking for pricing (list, dealer rates, wholesale, volume pricing).
// This pattern routes to escalation_type='dealer_pricing' in handler.js,
// which has a dedicated header for the owner alert and a customer-side
// reply that promises the dealer team will follow up with volume tier
// pricing (no public price dump, no specialist wa.me link).
const DEALER_SELF_ID_RE = /\b(i\s*(am|m)\s+(a\s+|the\s+)?(dealer|reseller|distributor|integrator|importer|wholesaler)|for\s+(re)?sale|for\s+my\s+(shop|store|business)|samples?\s+in\s+my\s+shop|not\s+for\s+personal\s+use|for\s+commercial\s+use|trading\s+(in|with)\s+(deye|inverter|battery|solar))\b/i;
const PRICING_LIST_ASK_RE = /\b(price\s+list|pricing|dealer\s+(price|rate|pricing|cost)|wholesale|volume\s+pric|how\s+much|prices?\s+(for|of)|cost\s+of|i\s+want\s+(the\s+)?(price|pricing|list)|available.*(prices?|list)|send\s+me\s+(the\s+)?(price|pricing|list))\b/i;

function isDealerPricingAsk(text) {
  const t = String(text || '');
  return DEALER_SELF_ID_RE.test(t) && PRICING_LIST_ASK_RE.test(t);
}

const AFFIRMATION_RE = /^(yes|yea+h?|yep+|yup+|sure|ok+|okay+|of\s+course|sounds\s+good|let'?s\s+(do\s+(it|that|this)|go|proceed)|go\s+ahead|absolutely|definitely|i'?m\s+ready|ready|please\s+do|do\s+it|alright|all\s+right|fine|cool|great|good|na'?am|aye|na'?am)[\s.!,]*$/i;
// Leading-affirmation: customer's message STARTS with "yes" / "sure" / "ok" /
// etc. but then continues with more content (their name, pickup details). We
// still treat this as an affirmation if it follows a Sunny HOT prompt — the
// extra content is the customer doing the closing work for us.
const LEADING_AFFIRMATION_RE = /^(yes|yea+h?|yep+|yup+|sure|ok+|okay+|of\s+course|sounds\s+good|absolutely|definitely|i'?m\s+ready|alright|all\s+right|please\s+do|do\s+it|go\s+ahead)\b/i;
const HOT_PROMPT_FROM_SUNNY_RE = /\b(ready\s+to\s+pay|ready\s+to\s+proceed|shall\s+(i|we)\s+send\s+(the\s+)?account|best\s+price.*(ready|pay)|are\s+you\s+ready\s+to|shall\s+(i|we)\s+(book|schedule|proceed)|want\s+to\s+(proceed|order|book|place\s+(a|an|the)\s+(pre-?order|order)|pre-?order|secure\s+(a|the|one|your)|lock\s+(it|this|that)\s+in|reserve|grab|take\s+(it|one|the\s+unit))|happy\s+to\s+proceed|shall\s+we\s+(go\s+ahead|proceed)|confirm\s+(the\s+)?(order|payment)|proceed\s+with\s+(the\s+)?order|send\s+you\s+(the\s+)?account|payment\s+now|(would\s+you\s+like|want)\s+(a|an|the)?\s*(proforma|invoice|quotation)|like\s+a\s+(proforma|invoice|quotation)|pay\s+(now|tomorrow|today)\s+or|place\s+(a|an|the)\s+(pre-?order|order)|pre-?order\s+(to\s+)?(secure|reserve|lock|hold)|secure\s+(a|the|one|your)\s+(unit|order|spot|piece)|lock\s+(it|this|one|a\s+unit)\s+in|pickup\s+or\s+delivery|come\s+(in|over)\s+to\s+(pay|pick|collect)|when\s+can\s+(you|we)\s+(pay|pick|collect)|how\s+would\s+you\s+like\s+to\s+(pay|proceed))/i;

function isAffirmationAfterHotPrompt(history, body) {
  if (!Array.isArray(history) || history.length === 0) return false;
  const trimmed = String(body || '').trim();
  if (!trimmed) return false;
  // Two paths: short pure affirmation (<= 25 chars), or longer message that
  // STARTS with an affirmation token (the customer said "yes" plus their name,
  // their pickup plan, their company, etc.).
  const isPureAffirmation = trimmed.length <= 25 && AFFIRMATION_RE.test(trimmed);
  const isLeadingAffirmation = trimmed.length <= 200 && LEADING_AFFIRMATION_RE.test(trimmed);
  if (!isPureAffirmation && !isLeadingAffirmation) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant') {
      return HOT_PROMPT_FROM_SUNNY_RE.test(String(m.content || ''));
    }
  }
  return false;
}

const CLARIFICATION_RE = /^(\??\s*)?(for\s+what|why|how|huh|what|wat|what\?+|what\s+is\s+this(\s+message)?|what\s+do\s+you\s+mean|i\s+don'?t\s+understand|i\s+don'?t\s+get\s+(it|that)|come\s+again|please\s+repeat|repeat|explain|you\s+mean|are\s+you\s+(serious|kidding|sure)|ok\??|okay\??|hmm+|eh+|abeg|sorry\??|pardon\??)[\s.?!]*$/i;

function isClarificationMessage(text) {
  const t = (text || '').trim();
  return t.length <= 40 && CLARIFICATION_RE.test(t);
}

// Owner swapped classifier prompt on 2026-05-12 to a HOT/SERIOUS/COLD/
// DISQUALIFIED/REPEAT_CLIENT vocabulary that no longer emits a separate
// lead_temperature field. Downstream code (this file, src/handler.js, the
// admin UI, the contacts table) still expects HOT/WARM/COLD/DISQUALIFIED on
// lead_temperature. We derive it here so a single change in the prompt does
// not ripple through every consumer.
const CATEGORY_TO_TEMP = {
  HOT: 'HOT',
  SERIOUS: 'WARM',
  COLD: 'COLD',
  DISQUALIFIED: 'DISQUALIFIED',
  CLOSED: 'CLOSED',
  LOST: 'LOST'
};

function normalizeClassifierShape(result) {
  if (!result || typeof result !== 'object') return result;
  // Already in the legacy shape (lead_temperature present, category is C*). Leave it.
  if (result.lead_temperature && /^(HOT|WARM|COLD|DISQUALIFIED|CLOSED|LOST)$/.test(result.lead_temperature)) {
    return result;
  }
  const cat = String(result.category || '').toUpperCase();
  if (cat === 'REPEAT_CLIENT') {
    const sec = String(result.secondary_category || '').toUpperCase();
    result.lead_temperature = CATEGORY_TO_TEMP[sec] || 'WARM';
  } else if (CATEGORY_TO_TEMP[cat]) {
    result.lead_temperature = CATEGORY_TO_TEMP[cat];
  } else {
    result.lead_temperature = 'COLD';
  }
  return result;
}

async function runClassification(contact, history, message) {
  const body = bodyText(message);

  if (isCasualGreeting(body)) {
    logger.info('classifier.greeting_fastpath', {
      contactId: contact.id,
      message_preview: body
    });
    return {
      category: 'COLD',
      secondary_category: null,
      lead_temperature: 'COLD',
      buyer_experience: 'unknown',
      client_type: 'unknown',
      intent: 'greeting',
      language: 'english',
      confidence: 95,
      needs_escalation: false,
      escalation_type: null,
      suggested_question: null,
      follow_up_in_days: null,
      lead_data: {
        name: null, location: null, use_case: null, load_estimate: null,
        timeline: null, products_asked_about: null, brand_preference: null,
        budget_mentioned: null, experience_signal: null, previous_purchase: null
      }
    };
  }

  const result = normalizeClassifierShape(await classify(history, message));

  const affirmationToHotPrompt = isAffirmationAfterHotPrompt(history, body);
  if (affirmationToHotPrompt) {
    if (result.lead_temperature !== 'HOT' || !result.needs_escalation || result.escalation_type !== 'hot_lead') {
      logger.info('classifier.affirmation_after_hot_prompt_promoted_to_hot', {
        contactId: contact.id,
        original_temp: result.lead_temperature,
        message_preview: body.slice(0, 80)
      });
    }
    result.lead_temperature = 'HOT';
    result.needs_escalation = true;
    result.escalation_type = 'hot_lead';
  }

  // BACKSTOP: if the customer's CURRENT message contains a hard commitment
  // phrase ("send me account", "i want to pay", "ready to pay", "send proforma",
  // etc.), force HOT regardless of what the classifier returned and regardless
  // of what Sunny said previously. This catches the failure mode where the
  // classifier (Sonnet) demoted to WARM/SERIOUS, the affirmation-after-hot-
  // prompt check missed because Sunny's prior question didn't match the
  // HOT_PROMPT regex, and the open-pending-query follow-up path then swallowed
  // the HOT signal as a silent_query follow-up ping. A commitment phrase in
  // the customer's own words is a hard buy signal, never miss it.
  if (!affirmationToHotPrompt && hasHotTrigger(body)) {
    if (result.lead_temperature !== 'HOT' || !result.needs_escalation || result.escalation_type !== 'hot_lead') {
      logger.warn('classifier.commitment_phrase_force_promoted_to_hot', {
        contactId: contact.id,
        original_temp: result.lead_temperature,
        original_escalation_type: result.escalation_type,
        message_preview: body.slice(0, 120)
      });
    }
    result.lead_temperature = 'HOT';
    result.needs_escalation = true;
    result.escalation_type = 'hot_lead';
  }

  if (result.lead_temperature === 'HOT' && !result.needs_escalation) {
    logger.warn('classifier.hot_without_escalation_demoted_to_warm', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      message_preview: body.slice(0, 80)
    });
    result.lead_temperature = 'WARM';
  }

  if (result.lead_temperature === 'HOT' && !hasHotTrigger(body) && !affirmationToHotPrompt) {
    logger.warn('classifier.hot_without_commitment_phrase_demoted', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      message_preview: body.slice(0, 120)
    });
    result.lead_temperature = 'WARM';
    result.needs_escalation = false;
    result.escalation_type = null;
  }

  // Dealer-pricing promoter. Runs AFTER all HOT logic so a dealer who also
  // commits to pay ("send me account") still wins HOT routing. Otherwise, if
  // the customer self-identifies as a dealer/reseller AND asks for pricing
  // (list, dealer rates, wholesale, volume pricing), route to dealer_pricing
  // so the owner gets a DEALER-headed alert and the customer gets the dealer
  // team handoff context instead of the generic silent_query stall.
  if (
    result.escalation_type !== 'hot_lead' &&
    isDealerPricingAsk(body)
  ) {
    logger.info('classifier.dealer_pricing_promoted', {
      contactId: contact.id,
      original_escalation_type: result.escalation_type,
      original_needs_escalation: result.needs_escalation,
      message_preview: body.slice(0, 200)
    });
    result.needs_escalation = true;
    result.escalation_type = 'dealer_pricing';
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
