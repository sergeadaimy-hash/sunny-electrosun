const logger = require('./utils/logger');

const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '15', 10);
const RATE_LIMIT_DAILY = parseInt(process.env.RATE_LIMIT_DAILY || '300', 10);
const MAX_SINGLE_MESSAGE_CHARS = parseInt(process.env.MAX_SINGLE_MESSAGE_CHARS || '2000', 10);
const MAX_COMBINED_BATCH_CHARS = parseInt(process.env.MAX_COMBINED_BATCH_CHARS || '4000', 10);
const ESCALATION_COOLDOWN_MS = parseInt(process.env.ESCALATION_COOLDOWN_MS || '1800000', 10);
const FOLLOWUP_COOLDOWN_MS = parseInt(process.env.FOLLOWUP_COOLDOWN_MS || '300000', 10);
// HOT leads have their own, much shorter throttle. Reason: the regular 30-min
// escalation cooldown was eating real HOT alerts when a customer escalated
// twice in the same conversation (typical pattern: customer asks a question,
// gets escalated, then commits to buy 5 minutes later -> the second HOT was
// silently swallowed). A HOT signal must always reach the owner. We keep a
// 60-second window only to defang back-to-back identical retries from the
// customer's side (network glitch, double-send, etc.).
const HOT_ESCALATION_COOLDOWN_MS = parseInt(process.env.HOT_ESCALATION_COOLDOWN_MS || '60000', 10);
const MAX_IMAGES_PER_DAY = parseInt(process.env.MAX_IMAGES_PER_DAY || '10', 10);

const rateLimitState = new Map();
const escalationState = new Map();
const hotEscalationState = new Map();
const followupState = new Map();
const imageState = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkRateLimit(contactId) {
  const now = Date.now();
  const today = todayKey();
  let state = rateLimitState.get(contactId);
  if (!state) {
    state = { messages: [], daily: { date: today, count: 0 } };
    rateLimitState.set(contactId, state);
  }
  if (state.daily.date !== today) {
    state.daily = { date: today, count: 0 };
  }
  state.messages = state.messages.filter(ts => now - ts < 60000);
  if (state.messages.length >= RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, reason: 'per_minute_exceeded', count: state.messages.length };
  }
  if (state.daily.count >= RATE_LIMIT_DAILY) {
    return { allowed: false, reason: 'daily_exceeded', count: state.daily.count };
  }
  state.messages.push(now);
  state.daily.count += 1;
  return { allowed: true };
}

function truncateInbound(text, max = MAX_SINGLE_MESSAGE_CHARS) {
  if (!text || typeof text !== 'string') return { text, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + ' [truncated]', truncated: true, original: text.length };
}

function truncateBatch(text, max = MAX_COMBINED_BATCH_CHARS) {
  if (!text || typeof text !== 'string') return { text, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + '\n[batch truncated]', truncated: true, original: text.length };
}

const INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|all|the|earlier)\s+(instructions|messages|rules|system|prompt|context)/i,
  /forget\s+(everything|previous|prior|all|the\s+rules|your\s+instructions)/i,
  /you\s+are\s+now\s+(a|an|the|free|unrestricted|no\s+longer)/i,
  /new\s+(instructions?|rules?|system\s+prompt)\s*[:.]/i,
  /reveal\s+your\s+(instructions|prompt|rules|system)/i,
  /print\s+your\s+(instructions|prompt|rules|system)/i,
  /repeat\s+(your|the)\s+(instructions|prompt|system|rules)/i,
  /show\s+me\s+your\s+(prompt|instructions|rules|system)/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /act\s+as\s+(if|though|a|an)/i,
  /\bDAN\s+mode\b/i,
  /jailbreak/i,
  /<\/?system\s*>/i,
  /<\/?instructions?\s*>/i,
  /\[INST\]|\[\/INST\]/i,
  /developer\s+mode/i,
  /override\s+(your|the)\s+(rules|instructions|system|prompt)/i,
  /disregard\s+(previous|prior|all|your)/i,
  /bypass\s+(your|the|all)\s+(rules|filters|guards)/i,
];

function detectInjectionAttempt(text) {
  if (!text) return null;
  const matches = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      matches.push(re.source);
      if (matches.length >= 3) break;
    }
  }
  return matches.length ? matches : null;
}

const PROMPT_LEAK_MARKERS = [
  'lagos sales floor',
  "electro-sun's whatsapp",
  'electro-suns whatsapp',
  'c1 through c5',
  'claude-opus-4',
  'system prompt',
  'classifier.md',
  'system.md',
  'owner_whatsapp',
  'specialist_direct_link',
  'you are sunny',
  'you are a classifier',
  'knowledge_prompt',
  'lead_temperature',
  'escalation_type',
  'hot_lead',
  'silent_query',
  'needs_escalation',
  'cache_control',
  'anthropic api',
];

function detectPromptLeak(replyText) {
  if (!replyText) return null;
  const lower = String(replyText).toLowerCase();
  const found = PROMPT_LEAK_MARKERS.filter(m => lower.includes(m));
  return found.length ? found : null;
}

function detectOwnerNumberLeak(replyText) {
  const ownerNumber = String(process.env.OWNER_WHATSAPP || '').replace(/\D/g, '');
  if (!ownerNumber || ownerNumber.length < 6) return false;
  if (!String(replyText || '').includes(ownerNumber)) return false;
  const wameRegex = new RegExp(`wa\\.me\\/${ownerNumber}`, 'i');
  return !wameRegex.test(replyText);
}

const PRICE_PATTERN_RE = /\b\d+(?:[.,]\d+)?\s*(?:M|m|k|K)?\s*NGN\b|\b\d+(?:[.,]\d+)?\s*[Mm]\b(?!\w)|\(\s*\d+(?:[.,]\d+)?\s*[kKmM]\s*\)/g;
const PHONE_PATTERN_RE = /\b(?:\+?234|0)\d{9,10}\b/g;

function countPricePatterns(text) {
  const m = String(text || '').match(PRICE_PATTERN_RE);
  return m ? m.length : 0;
}

function countPhonePatterns(text) {
  const m = String(text || '').match(PHONE_PATTERN_RE);
  return m ? m.length : 0;
}

function checkEscalationThrottle(contactId) {
  const now = Date.now();
  const state = escalationState.get(contactId);
  if (!state) {
    escalationState.set(contactId, { lastEscalationAt: now });
    return { allowed: true };
  }
  if (now - state.lastEscalationAt < ESCALATION_COOLDOWN_MS) {
    return { allowed: false, lastAt: state.lastEscalationAt, cooldownMs: ESCALATION_COOLDOWN_MS };
  }
  state.lastEscalationAt = now;
  return { allowed: true };
}

function checkHotEscalationThrottle(contactId) {
  const now = Date.now();
  const state = hotEscalationState.get(contactId);
  if (!state) {
    hotEscalationState.set(contactId, { lastAt: now });
    return { allowed: true };
  }
  if (now - state.lastAt < HOT_ESCALATION_COOLDOWN_MS) {
    return { allowed: false, lastAt: state.lastAt, cooldownMs: HOT_ESCALATION_COOLDOWN_MS };
  }
  state.lastAt = now;
  return { allowed: true };
}

function checkFollowupThrottle(contactId) {
  const now = Date.now();
  const state = followupState.get(contactId);
  if (!state) {
    followupState.set(contactId, { lastFollowupAt: now });
    return { allowed: true };
  }
  if (now - state.lastFollowupAt < FOLLOWUP_COOLDOWN_MS) {
    return { allowed: false, lastAt: state.lastFollowupAt, cooldownMs: FOLLOWUP_COOLDOWN_MS };
  }
  state.lastFollowupAt = now;
  return { allowed: true };
}

const STALL_PATTERNS = [
  /\b(let\s+me|i['']?ll|i\s+will|we['']?ll|we\s+will)\s+(check|confirm|verify|find\s+out|come\s+back|revert|get\s+back|share|send|forward|pass\s+(this|it|that)\s+(on|along)|consult|reach\s+out|circle\s+back|update|connect\s+you)/i,
  /\b(get\s+back\s+to\s+you|will\s+revert|will\s+come\s+back\s+to\s+you|circle\s+back\s+with\s+you|return\s+with\s+(the|a|an)\s+(answer|details|figure|quote|update|response))/i,
  /\b(one\s+of\s+our\s+|a\s+|the\s+|our\s+)?(sales\s+managers?|sales\s+engineers?|specialists?|engineers?|team\s+members?|sales\s+(representatives?|reps?)|account\s+managers?|colleagues?|sales\s+team|team)\s+(will|is\s+going\s+to|is)\s+(reach(ing)?\s+out|contact(ing)?|get(ting)?\s+in\s+touch|follow(ing)?\s+up|revert(ing)?|be\s+in\s+touch|reconnect(ing)?|come\s+back|provid(e|ing)|deliver(ing)?|send(ing)?|prepar(e|ing)|review(ing)?|confirm(ing)?|call(ing)?|connect(ing)?|reach|share|forward|update|handle|handling|process|processing|manage|managing)/i,
  /\bgive\s+me\s+a\s+(moment|second|minute|sec)\b/i,
  /\b(bear\s+with\s+me|hold\s+on|please\s+hold|one\s+moment\s+please)\b/i,
  /\b(allow\s+me\s+to|allow\s+us\s+to|let\s+us|kindly\s+allow\s+me)\s+(check|confirm|verify|find\s+out|reach\s+out|come\s+back|revert|update|consult)/i,
  /\b(the|our)\s+(team|sales\s+team)\s+(will|is\s+going\s+to)\s+(confirm|provide|deliver|send|handle|reach\s+out|prepare|review|come\s+back|reconfirm|update|check|verify|finalise|finalize|finalising|finalizing|work\s+on|sort|share|forward|process|manage|reach\s+back)/i,
  /\b(the|our)\s+(team|sales\s+team)\s+is\s+(checking|confirming|finalising|finalizing|reviewing|preparing|working\s+on|looking\s+into|sorting|verifying|on\s+it|processing|handling|managing|reaching\s+out)/i,
  /\b(a|the|our)\s+(specialists?|sales\s+managers?)\s+is\s+(checking|confirming|finalising|finalizing|reviewing|preparing|working\s+on|looking\s+into)/i,
  /\b(awaiting\s+(confirmation|feedback|response|approval)|pending\s+confirmation|consulting\s+with\s+(the\s+)?(team|specialist|sales\s+manager|supplier|engineer))/i,
  /\b(account\s+details\s+and\s+(final\s+)?figures|formal\s+documents\s+and\s+(final\s+)?figures|share\s+the\s+account|send\s+(you\s+)?the\s+account)/i,
  // Uncertainty / "stuck" language (owner directive 2026-07-05: when Sunny is
  // stuck on an unclear thing it must escalate, never leave the customer with a
  // dead "I'm not sure"). These route through the same stall-guard escalation.
  // The negative lookahead on "not sure/certain" excludes Sunny clarifying an
  // ambiguous customer message ("I'm not sure I understand / what you mean /
  // which model"), which is a legitimate one-question clarification, not a stall.
  /\b(i['´’]?m|i\s+am|we['´’]?re|we\s+are)\s+not\s+(sure|certain)\b(?!\s+(i|we|what|which|whether|if|how|when|where|why|who)\b)/i,
  /\b(i['´’]?m|i\s+am)\s+(a\s+bit\s+|somewhat\s+)?(unsure|uncertain)\b(?!\s+(i|we|what|which|whether|if|how|when|where|why|who)\b)/i,
  /\b(i|we)\s+(can['´’]?t|cannot|could\s+not|couldn['´’]?t|am\s+not\s+able\s+to|are\s+not\s+able\s+to|['´’]?m\s+unable\s+to|are\s+unable\s+to)\s+(confirm|verify|say\s+for\s+(sure|certain)|be\s+sure|be\s+certain|provide\s+(that|the)|answer\s+that|tell\s+you\s+(that|the|for))/i,
  /\b(i|we)\s+(don['´’]?t|do\s+not)\s+have\s+(that|the|this|those|enough)\s+(info|information|details?|answer|figure|data)\b/i,
  /\b(that['´’]?s|this\s+is)\s+not\s+something\s+i\s+can\s+(confirm|answer|help\s+with|provide|verify)\b/i,
];

function detectStallLanguage(replyText) {
  const text = String(replyText || '');
  if (!text) return null;
  for (const re of STALL_PATTERNS) {
    if (re.test(text)) {
      return { pattern: re.source };
    }
  }
  return null;
}

function checkImageQuota(contactId) {
  const today = todayKey();
  let state = imageState.get(contactId);
  if (!state || state.date !== today) {
    state = { date: today, count: 0 };
    imageState.set(contactId, state);
  }
  if (state.count >= MAX_IMAGES_PER_DAY) {
    return { allowed: false, count: state.count };
  }
  state.count += 1;
  return { allowed: true };
}

function logSecurityEvent(name, details) {
  logger.warn(`security.${name}`, details);
}

// API auth hardening (2026-07-12). safeKeyCompare hashes both sides so
// timingSafeEqual gets equal-length buffers; the per-IP failure throttle caps
// key-guessing. Only FAILED attempts count, so a legit admin behind the same
// proxy IP as an attacker is never locked out; the attacker's guesses just
// start returning 429.
const crypto = require('crypto');
const API_AUTH_MAX_FAILURES = parseInt(process.env.API_AUTH_MAX_FAILURES || '20', 10);
const API_AUTH_WINDOW_MS = parseInt(process.env.API_AUTH_WINDOW_MS || '600000', 10);
const API_AUTH_FAILURES = new Map();

function safeKeyCompare(provided, expected) {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function recordApiAuthFailure(ip, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const key = String(ip || 'unknown');
  let rec = API_AUTH_FAILURES.get(key);
  if (!rec || now - rec.first > API_AUTH_WINDOW_MS) {
    rec = { first: now, count: 0 };
    API_AUTH_FAILURES.set(key, rec);
  }
  rec.count += 1;
  // Opportunistic cleanup so the map cannot grow without bound.
  if (API_AUTH_FAILURES.size > 5000) {
    for (const [k, r] of API_AUTH_FAILURES) {
      if (now - r.first > API_AUTH_WINDOW_MS) API_AUTH_FAILURES.delete(k);
    }
  }
  return rec.count;
}

function checkApiAuthThrottle(ip, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rec = API_AUTH_FAILURES.get(String(ip || 'unknown'));
  if (!rec || now - rec.first > API_AUTH_WINDOW_MS) return { allowed: true, count: 0 };
  return { allowed: rec.count < API_AUTH_MAX_FAILURES, count: rec.count };
}

function resetApiAuthThrottle() {
  API_AUTH_FAILURES.clear();
}

module.exports = {
  checkRateLimit,
  truncateInbound,
  truncateBatch,
  detectInjectionAttempt,
  detectPromptLeak,
  detectOwnerNumberLeak,
  countPricePatterns,
  countPhonePatterns,
  checkEscalationThrottle,
  checkHotEscalationThrottle,
  checkFollowupThrottle,
  detectStallLanguage,
  checkImageQuota,
  logSecurityEvent,
  safeKeyCompare,
  recordApiAuthFailure,
  checkApiAuthThrottle,
  resetApiAuthThrottle,
  RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_DAILY,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_COMBINED_BATCH_CHARS,
  ESCALATION_COOLDOWN_MS,
  HOT_ESCALATION_COOLDOWN_MS,
  FOLLOWUP_COOLDOWN_MS,
  MAX_IMAGES_PER_DAY,
};
