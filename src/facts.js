const auditStore = require('./audit_store');
const logger = require('./utils/logger');

// Owner-confirmed business facts learned from the nightly audit (knowledge_fact
// lane, minus prices). Mirrors the learned-playbook (Option A, 2026-06-26): read
// straight from the DB so an approved fact is live on the next reply and survives
// restarts with no file/GitHub dependency. Prices are deliberately NOT here; they
// live only in Warehouse Stock (project hard rule).

// Pure: render the facts markdown from a list of finding rows.
function buildFactsMarkdown(facts) {
  const header = [
    '# Learned facts (owner-confirmed)',
    '',
    'These are concrete business facts the Electro-Sun owner confirmed from the nightly self-audit. Treat them as true and current. They are NOT prices (prices come only from the warehouse stock block). If a fact is more specific than system.md, the fact wins.',
    ''
  ];
  if (!facts || !facts.length) {
    return header.concat(['(No confirmed facts yet.)', '']).join('\n');
  }
  const lines = header.slice();
  const seen = new Set();
  let n = 0;
  for (const f of facts) {
    const raw = (f.edited_text != null && f.edited_text !== '') ? f.edited_text : f.proposed_change;
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
    lines.push(`${n}. ${text}`);
  }
  lines.push('');
  return lines.join('\n');
}

// A token immediately after a digit run that means the number is a spec, not money.
const UNIT_AFTER = /^(kwh|kva|kw|wh|w|v|ah|a|kg|pcs|units?|years?|yrs?|yr|hrs?|am|pm|%)/i;

// Pure: does this text carry a Naira money signal? Used as the safety net so a
// price typed into a general-fact box is rerouted to Warehouse Stock instead of
// being injected as a "fact". Deliberately conservative: it must NOT flag normal
// facts that merely contain a number (warranty years, kWh specs, unit counts).
function looksLikePrice(text) {
  const s = String(text || '');
  if (/₦/.test(s)) return true;
  if (/\b(ngn|naira)\b/i.test(s)) return true;
  if (/\d{1,3}(,\d{3})+/.test(s)) return true;                 // 4,200,000
  if (/\b\d+(\.\d+)?\s*million\b/i.test(s)) return true;        // 4.2 million
  // A bare large integer (5+ digits) that is not glued to a unit reads as money.
  const re = /\d{5,}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const after = s.slice(m.index + m[0].length).replace(/^\s+/, '');
    if (!UNIT_AFTER.test(after)) return true;
  }
  return false;
}

// Build the facts block Sunny reads, straight from the DB. On any DB error return
// '' so a transient issue can never break a customer reply.
function getFactsText() {
  try {
    return buildFactsMarkdown(auditStore.getActiveKnowledgeFacts());
  } catch (err) {
    logger.warn('facts.db_read_fail', { message: err.message });
    return '';
  }
}

module.exports = { buildFactsMarkdown, looksLikePrice, getFactsText };
