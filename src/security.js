const logger = require('./utils/logger');

const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '15', 10);
const RATE_LIMIT_DAILY = parseInt(process.env.RATE_LIMIT_DAILY || '300', 10);
const MAX_SINGLE_MESSAGE_CHARS = parseInt(process.env.MAX_SINGLE_MESSAGE_CHARS || '2000', 10);
const MAX_COMBINED_BATCH_CHARS = parseInt(process.env.MAX_COMBINED_BATCH_CHARS || '4000', 10);
const ESCALATION_COOLDOWN_MS = parseInt(process.env.ESCALATION_COOLDOWN_MS || '1800000', 10);
const MAX_IMAGES_PER_DAY = parseInt(process.env.MAX_IMAGES_PER_DAY || '10', 10);

const rateLimitState = new Map();
const escalationState = new Map();
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
  checkImageQuota,
  logSecurityEvent,
  RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_DAILY,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_COMBINED_BATCH_CHARS,
  ESCALATION_COOLDOWN_MS,
  MAX_IMAGES_PER_DAY,
};
