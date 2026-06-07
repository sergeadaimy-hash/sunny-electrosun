'use strict';

// Pure builders for the owner escalation alert. No DB, no WhatsApp, no env
// reads, so this is unit-testable in isolation (test/owner_alert.test.js) and
// shared by both alert paths in src/handler.js (the main escalation alert and
// the repeat follow-up ping).
//
// Format (decided 2026-06-06, see docs/superpowers/specs/2026-06-06-concise-
// owner-alerts-design.md): a short brief, NOT a transcript. Header, customer
// number only (no name), an optional Product line, a 2-line situation summary
// Sunny writes, and a wa.me link pre-filled with a client-facing follow-up
// opener the owner can send as-is.

const GENERIC_FOLLOWUP_DRAFT =
  'Hello, this is ElectroSun following up on your enquiry. How can we help you move forward?';

// Lightweight no-double-dashes cleanup for owner-brief / follow-up-draft text.
// The full reply guard lives in src/claude.js and only runs on customer
// replies; the follow-up draft never goes through that path (the owner sends
// it manually), so we mirror the essential dash rules here before display /
// URL-encoding.
function stripDashesForAlert(text) {
  if (!text) return text;
  return String(text)
    // En-dash between digits is a number range, keep as a single hyphen
    // (mirrors the reply-side guard in src/claude.js).
    .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[—–]/g, '-')
    .replace(/\s*--\s*/g, ', ')
    .replace(/--/g, '-')
    .replace(/,(\s*,)+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*([.?!:;])/g, '$1')
    .replace(/\s+,/g, ',')
    .trim();
}

function digitsOnly(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

// Product the case is about, when it is product-related. Sourced from the
// classifier's captured lead_data.products_asked_about (falls back to a
// top-level field if a synthetic classification puts it there). Returns null
// when there is no product, so the caller omits the Product line.
function productFromClassification(classification) {
  if (!classification) return null;
  const ld = classification.lead_data || {};
  const raw = ld.products_asked_about || classification.products_asked_about;
  if (!raw) return null;
  const s = String(raw).trim();
  return s || null;
}

// The 2-line summary Sunny writes. When the classifier owner_brief is absent
// (force-promoted HOT via a commitment phrase, or synthetic classifications on
// the stall-guard / photo-no-match paths that never run the classifier), build
// a real 2-phrase summary from the customer's actual message + product/topic
// instead of the bare generic "their enquiry" line. customerMessage is the
// combined inbound text the caller already has on hand.
function ownerBriefLine(classification, customerMessage) {
  const brief = classification && classification.owner_brief;
  if (brief && String(brief).trim()) {
    return stripDashesForAlert(String(brief).trim());
  }
  const intent = classification && classification.intent;
  const topic = intent && intent !== 'other' ? String(intent).replace(/_/g, ' ') : null;
  const msg = customerMessage ? String(customerMessage).replace(/\s+/g, ' ').trim() : '';
  if (msg) {
    const quoted = msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
    const second = topic ? `Needs a team answer on ${topic}.` : 'Needs a team answer.';
    return stripDashesForAlert(`Customer asked: "${quoted}". ${second}`);
  }
  return `Customer needs a team answer on: ${topic || 'their enquiry'}.`;
}

// wa.me deep link with the client-facing follow-up opener pre-filled in the
// compose box. Owner taps it, reviews, sends. Returns null with no number.
function buildOwnerFollowupLink(contact, classification) {
  const digits = digitsOnly(contact && contact.phone);
  if (!digits) return null;
  let draft = classification && classification.owner_followup_draft;
  draft = draft && String(draft).trim()
    ? stripDashesForAlert(String(draft).trim())
    : GENERIC_FOLLOWUP_DRAFT;
  return `https://wa.me/${digits}?text=${encodeURIComponent(draft)}`;
}

// Assemble the full alert text. headerText is resolved by the caller from
// ESCALATION_HEADERS so the typed header (HOT LEAD / FOLLOW-UP NEEDED / etc.)
// is preserved.
function buildOwnerAlertText(contact, classification, headerText, customerMessage) {
  const lines = [];
  lines.push(headerText);
  lines.push((contact && contact.phone) || 'unknown');

  const product = productFromClassification(classification);
  if (product) lines.push(`Product: ${product}`);

  lines.push('');
  lines.push(ownerBriefLine(classification, customerMessage));

  const link = buildOwnerFollowupLink(contact, classification);
  if (link) {
    lines.push('');
    lines.push(`Follow up on WhatsApp: ${link}`);
  }

  return lines.join('\n');
}

module.exports = {
  buildOwnerAlertText,
  buildOwnerFollowupLink,
  stripDashesForAlert,
  GENERIC_FOLLOWUP_DRAFT,
};
