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

// The team numbers Sunny actually routes alerts to, for the admin Owner Chat
// tab. Patrick is always present (OWNER_WHATSAPP). Each other desk is included
// only when its env var is set to a number distinct from Patrick's, so an
// unconfigured desk (which falls back to Patrick) does not show a duplicate
// thread. Order is stable: Patrick, Charbel, Abuja Sales, Lagos Sales.
function configuredRecipients() {
  const owner = process.env.OWNER_WHATSAPP || null;
  const out = [];
  const seen = new Set();
  const add = (label, name, phone) => {
    const d = digits(phone);
    if (!d || seen.has(d)) return;
    seen.add(d);
    out.push({ label, name, phone });
  };
  add('patrick', 'Patrick', owner);
  add('charbel', 'Charbel', process.env.OWNER_CHARBEL_WHATSAPP);
  add('abuja', 'Abuja Sales', process.env.SALES_ABUJA_WHATSAPP);
  add('lagos', 'Lagos Sales', process.env.SALES_LAGOS_WHATSAPP);
  return out;
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

// All team numbers (full owners + alert-only sales desks). These are NOT
// customers and must be excluded from lead / hot-lead / recent-contact stats
// and from the Owner Q&A snapshot. A team member who messaged Sunny before
// being configured here may still carry a stale HOT/SERIOUS contact row; this
// list filters them out at query time so the owner never sees himself or a
// colleague listed as a hot lead.
function teamPhoneDigits() {
  const out = [];
  const seen = new Set();
  for (const p of [
    process.env.OWNER_WHATSAPP,
    process.env.OWNER_CHARBEL_WHATSAPP,
    process.env.SALES_ABUJA_WHATSAPP,
    process.env.SALES_LAGOS_WHATSAPP
  ]) {
    const d = digits(p);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
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

// A lead worth topic-routing. Keys on the ACTUAL escalation signals, not just
// `category`: a commitment-phrase force-promotion (classifier.js) sets
// lead_temperature=HOT + escalation_type=hot_lead but leaves category=COLD, and
// that was sending every force-promoted HOT lead to the general owner with
// reason "not_serious_or_hot" instead of the regional desk (bug seen 2026-06-07,
// Adeyato). So also treat HOT/WARM temperature and any routing-worthy escalation
// type as serious.
const ROUTING_WORTHY_ESCALATIONS = ['hot_lead', 'bulk_order', 'negotiation', 'big_project', 'repeat_complex', 'live_agent'];
function isSeriousOrHot(classification) {
  const cat = String((classification && classification.category) || '').toUpperCase();
  if (cat === 'HOT' || cat === 'SERIOUS') return true;
  const temp = String((classification && classification.lead_temperature) || '').toUpperCase();
  if (temp === 'HOT' || temp === 'WARM') return true;
  const esc = String((classification && classification.escalation_type) || '').toLowerCase();
  return ROUTING_WORTHY_ESCALATIONS.includes(esc);
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
  // Every escalation is now routed (big project -> owners; everything else ->
  // regional desk). So routing is "sufficient" only when we can actually decide:
  // a big project, or a known region. Otherwise gather-first must ask the city.
  return hasRoutingInfo(classification);
}

// Whether the routing-determining details are present, INDEPENDENT of the
// current category. Used by the deferred-handoff resume: a follow-up like a
// bare "Lagos" may have been demoted to COLD, but if it now supplies the
// missing region we can still fire the owed alert.
function hasRoutingInfo(classification) {
  const cat = normalizeRoutingCategory(classification);
  if (cat === 'big_project') return true;
  // daily_sales OR unknown category: a known region is enough to route. Treating
  // unknown like daily keeps the classifier's flaky routing_category from
  // stranding a clearly-regional lead (it would otherwise sit unrouted and the
  // deferred-handoff resume would never fire). Big projects carry their own
  // signal and are caught above.
  return normalizeRegion(classification) !== 'unknown';
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
    lead_temperature: input && input.lead_temperature,
    escalation_type: input && input.escalation_type,
    routing_category: input && input.routing_category,
    routing_region: input && input.routing_region,
  };

  // Owner directive (2026-06-07): the owners (Patrick/Charbel) handle ONLY big
  // projects. Every other escalation, regardless of HOT/SERIOUS/COLD or
  // escalation type (daily sale, pricing question, silent_query, inquiry),
  // routes to the regional sales desk by the customer's location. There is no
  // "not serious enough, send to the owner" path anymore. Region-unknown is
  // handled by gather-first (ask Abuja or Lagos before alerting); the owner
  // fallback below is a last resort that should almost never be hit.
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

  // daily_sales OR unknown category: route by region. Unknown is treated like
  // daily because the classifier often leaves routing_category null on a clearly
  // regional sale; big projects are handled above. Region-unknown falls back to
  // the general owner (gather-first should have asked the city first).
  const region = normalizeRegion(classification);
  const known = cat === 'daily_sales' ? 'daily' : 'region';
  if (region === 'abuja') return { label: 'abuja', flipTo: null, stickySet: null, reason: `${known}_abuja` };
  if (region === 'lagos') return { label: 'lagos', flipTo: null, stickySet: null, reason: `${known}_lagos` };
  // Region unknown and not a big project. Owner directive (2026-06-08): default
  // a city-unknown lead to the Abuja desk rather than the owner, so it reaches a
  // sales manager instead of waiting forever or piling on Patrick. Only fall
  // back to the owner if the Abuja desk number is not configured.
  if (input && input.abujaConfigured) {
    return { label: 'abuja', flipTo: null, stickySet: null, reason: 'region_unknown_default_abuja' };
  }
  return { label: 'owner', flipTo: null, stickySet: null, reason: 'region_unknown_fallback' };
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
    lead_temperature: classification && classification.lead_temperature,
    escalation_type: classification && classification.escalation_type,
    routing_category: classification && classification.routing_category,
    routing_region: classification && classification.routing_region,
    stickyOwner,
    lastAssignee,
    abujaConfigured: !!numberForLabel('abuja'),
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
  configuredRecipients,
  teamPhoneDigits,
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
