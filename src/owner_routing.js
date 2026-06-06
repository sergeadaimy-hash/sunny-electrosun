'use strict';

// Topic-based owner alert routing (design: docs/superpowers/specs/
// 2026-06-06-owner-alert-routing-design.md).
//
// Split of responsibility:
//   - The LLM classifier judges the fuzzy inputs and emits routing_category /
//     routing_region.
//   - This module does the DETERMINISTIC assignment: thresholds, the strict
//     Charbel<->Patrick round-robin, sticky-per-case, and the three-tier
//     inbound recognition. Round-robin state must survive container restarts,
//     so it lives in the DB (routing_state table), never in the prompt.
//
// The pure core (decideRecipient / routingInfoSufficient / numberForLabel /
// tier checks) takes its state as plain values so it is unit-testable with no
// DB. resolveRecipient() is the thin DB-backed wrapper used by the handler.

const logger = require('./utils/logger');

// Label -> env var. Patrick is the EXISTING owner number; no separate var.
function numberForLabel(label) {
  const owner = process.env.OWNER_WHATSAPP || null;
  switch (label) {
    case 'patrick': return owner;
    case 'charbel': return process.env.OWNER_CHARBEL_WHATSAPP || owner;
    case 'abuja':   return process.env.SALES_ABUJA_WHATSAPP || owner;
    case 'lagos':   return process.env.SALES_LAGOS_WHATSAPP || owner;
    case 'owner':
    default:        return owner;
  }
}

function digits(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

// --- Three-tier inbound recognition ---------------------------------------

// Full owners (Patrick + Charbel): can reply-relay to a QID and use Owner Q&A.
function fullOwnerDigits() {
  return [process.env.OWNER_WHATSAPP, process.env.OWNER_CHARBEL_WHATSAPP]
    .filter(Boolean)
    .map(digits);
}

// Alert-only sinks (Abuja + Lagos sales): receive alerts, never conversed with.
function alertOnlyDigits() {
  return [process.env.SALES_ABUJA_WHATSAPP, process.env.SALES_LAGOS_WHATSAPP]
    .filter(Boolean)
    .map(digits);
}

function isFullOwner(from) {
  const d = digits(from);
  return !!d && fullOwnerDigits().includes(d);
}

function isAlertOnly(from) {
  const d = digits(from);
  if (!d) return false;
  // A full owner is never treated as alert-only, even if the same number were
  // mistakenly configured in both slots.
  if (fullOwnerDigits().includes(d)) return false;
  return alertOnlyDigits().includes(d);
}

// --- Category helpers ------------------------------------------------------

function isSeriousOrHot(classification) {
  const cat = String((classification && classification.category) || '').toUpperCase();
  return cat === 'HOT' || cat === 'SERIOUS';
}

function normalizeRoutingCategory(classification) {
  const v = String((classification && classification.routing_category) || '').toLowerCase();
  if (v === 'daily_sales' || v === 'daily') return 'daily_sales';
  if (v === 'big_project' || v === 'big') return 'big_project';
  return 'unknown';
}

function normalizeRegion(classification) {
  const v = String((classification && classification.routing_region) || '').toLowerCase();
  if (v === 'abuja') return 'abuja';
  if (v === 'lagos') return 'lagos';
  return 'unknown';
}

// True only when there is enough to route a SERIOUS/HOT lead that would
// escalate: category must be known, and a daily sale must know its region.
// Used by the gather-first guard (ask the customer before alerting).
function routingInfoSufficient(classification) {
  if (!isSeriousOrHot(classification)) return true; // not routed; general owner
  return hasRoutingInfo(classification);
}

// Whether the routing-determining details are present, INDEPENDENT of the
// current category. Used by the deferred-handoff resume: a follow-up like a
// bare "Lagos" may have been demoted to COLD, but if it now supplies the
// missing region we can still fire the owed alert.
function hasRoutingInfo(classification) {
  const cat = normalizeRoutingCategory(classification);
  if (cat === 'big_project') return true;
  if (cat === 'daily_sales') return normalizeRegion(classification) !== 'unknown';
  return false;
}

// --- Pure decision core ----------------------------------------------------
//
// input: {
//   category,            // classifier category (HOT/SERIOUS/COLD/...)
//   routing_category,    // daily_sales | big_project | unknown
//   routing_region,      // abuja | lagos | unknown
//   stickyOwner,         // 'patrick' | 'charbel' | null (contact's prior assignee)
//   lastAssignee,        // 'patrick' | 'charbel' | null (global round-robin state)
// }
// returns: { label, flipTo, stickySet, reason }
//   flipTo   = new value to write to routing_state.last_big_project_assignee, or null
//   stickySet = label to store on the contact for future big-project alerts, or null
function decideRecipient(input) {
  const classification = {
    category: input && input.category,
    routing_category: input && input.routing_category,
    routing_region: input && input.routing_region,
  };

  if (!isSeriousOrHot(classification)) {
    return { label: 'owner', flipTo: null, stickySet: null, reason: 'not_serious_or_hot' };
  }

  const cat = normalizeRoutingCategory(classification);

  if (cat === 'big_project') {
    const sticky = input && input.stickyOwner;
    if (sticky === 'patrick' || sticky === 'charbel') {
      return { label: sticky, flipTo: null, stickySet: null, reason: 'sticky' };
    }
    // Empty or Patrick -> Charbel; Charbel -> Patrick.
    const next = input && input.lastAssignee === 'charbel' ? 'patrick' : 'charbel';
    return { label: next, flipTo: next, stickySet: next, reason: 'round_robin' };
  }

  if (cat === 'daily_sales') {
    const region = normalizeRegion(classification);
    if (region === 'abuja') return { label: 'abuja', flipTo: null, stickySet: null, reason: 'daily_abuja' };
    if (region === 'lagos') return { label: 'lagos', flipTo: null, stickySet: null, reason: 'daily_lagos' };
    return { label: 'owner', flipTo: null, stickySet: null, reason: 'daily_region_unknown' };
  }

  return { label: 'owner', flipTo: null, stickySet: null, reason: 'category_unknown' };
}

// --- DB-backed state -------------------------------------------------------

function getLastAssignee() {
  try {
    const { getDb } = require('../db/init');
    const row = getDb()
      .prepare("SELECT value FROM routing_state WHERE key = 'last_big_project_assignee'")
      .get();
    return row && row.value ? row.value : null;
  } catch (err) {
    logger.warn('owner_routing.get_last_assignee_fail', { message: err.message });
    return null;
  }
}

function setLastAssignee(value) {
  try {
    const { getDb } = require('../db/init');
    getDb()
      .prepare(`INSERT INTO routing_state (key, value, updated_at)
                VALUES ('last_big_project_assignee', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(value, new Date().toISOString());
  } catch (err) {
    logger.warn('owner_routing.set_last_assignee_fail', { message: err.message, value });
  }
}

// Resolve the actual recipient number for an escalation, applying and
// persisting round-robin + sticky state. Falls back to OWNER_WHATSAPP for
// anything not routed or any unset number.
function resolveRecipient(contact, classification) {
  const stickyOwner = (contact && contact.assigned_big_project_owner) || null;
  const lastAssignee = getLastAssignee();

  const decision = decideRecipient({
    category: classification && classification.category,
    routing_category: classification && classification.routing_category,
    routing_region: classification && classification.routing_region,
    stickyOwner,
    lastAssignee,
  });

  if (decision.flipTo) setLastAssignee(decision.flipTo);

  if (decision.stickySet && stickyOwner !== decision.stickySet) {
    try {
      const { updateContactFields } = require('./memory');
      updateContactFields(contact.id, { assigned_big_project_owner: decision.stickySet });
    } catch (err) {
      logger.warn('owner_routing.set_sticky_fail', { message: err.message, contactId: contact && contact.id });
    }
  }

  const number = numberForLabel(decision.label);
  logger.info('owner_routing.resolved', {
    contactId: contact && contact.id,
    label: decision.label,
    reason: decision.reason,
    routing_category: classification && classification.routing_category,
    routing_region: classification && classification.routing_region,
    number_tail: number ? String(number).slice(-4) : null,
  });
  return { number, label: decision.label, reason: decision.reason };
}

module.exports = {
  numberForLabel,
  isFullOwner,
  isAlertOnly,
  isSeriousOrHot,
  routingInfoSufficient,
  hasRoutingInfo,
  decideRecipient,
  resolveRecipient,
  getLastAssignee,
  setLastAssignee,
};
