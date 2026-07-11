'use strict';

// Idle-chatter guard (owner directive 2026-07-11): conversations that are pure
// social chatter (Arabic-script small talk, emoji volleys, junk links, dot
// transcripts) were getting a paid classify + reply on every turn, forever.
// This module is the pure, DB-free core: it decides whether the CURRENT
// inbound is low-value and whether the conversation has already used up its
// polite replies, so the handler can skip the whole LLM pipeline silently.
//
// Deliberately conservative: anything with a product word, a digit, a real
// question, or ordinary Latin-script text is NOT low-value. The five serviced
// languages (English, Pidgin, Hausa, Yoruba, Igbo) are all Latin script, so
// the script check cannot misfire on them.

const IDLE_CHATTER_FREE_REPLIES = parseInt(process.env.IDLE_CHATTER_FREE_REPLIES || '1', 10);

// Latin product / commerce tokens that mark a message as substantive even when
// the surrounding text is in a non-serviced script.
const PRODUCT_TOKEN_RE = /(solar|invert|batter|panel|deye|jinko|longi|sungrow|felicity|price|cost|quote|proforma|invoice|naira|ngn|kwh?|kva|watt|volt|charg|install|generat|hybrid|lithium|mppt|bos-|sun-|datasheet|warranty|deliver)/i;

const URL_RE = /(https?:\/\/\S+|www\.\S+|\b[\w-]+\.(?:com|net|org|info|io|me|co|ng|ly|tv|xyz|site|online|link|shop|app|biz)\b(?:\/\S*)?)/gi;

const VOICE_PREFIX = '[voice note transcribed]:';
const VOICE_FAIL_MARKER_RE = /^\[customer sent a voice note that could not be transcribed\]/i;
const IMAGE_MARKER_RE = /^\[customer sent an image/i;

function classifyLowValue(text) {
  let t = String(text || '').trim();
  if (!t) return null;

  // Image markers: a customer sending a picture may be showing us their roof,
  // their load, or a product. Never treat as chatter.
  if (IMAGE_MARKER_RE.test(t)) return null;

  // Failed voice transcription marker: unintelligible. The first one earns a
  // "please type your question" reply; repeats fall under the streak.
  if (VOICE_FAIL_MARKER_RE.test(t)) return 'unintelligible';

  // Transcribed voice notes: judge the transcript itself.
  if (t.toLowerCase().startsWith(VOICE_PREFIX)) {
    t = t.slice(VOICE_PREFIX.length).trim();
    if (!t) return 'unintelligible';
  }

  // Bare link: one or more URLs with nothing substantive around them.
  const withoutUrls = t.replace(URL_RE, ' ');
  if (withoutUrls !== t.replace(/\s+/g, ' ')) {
    const leftoverWordChars = (withoutUrls.match(/[\p{L}\p{N}]/gu) || []).length;
    if (leftoverWordChars < 4) return 'bare_link';
  }

  const hasPictographic = /\p{Extended_Pictographic}/u.test(t);
  const strippedOfSymbols = t.replace(/[\p{Extended_Pictographic}\p{P}\p{S}\p{Cf}\s️‍]/gu, '');

  // Emoji / symbol volley: nothing left once pictographs and punctuation go.
  if (!strippedOfSymbols && hasPictographic) return 'emoji_only';

  // Dots, dashes, stray punctuation ("........" transcripts).
  if (!strippedOfSymbols) return 'unintelligible';

  // Non-serviced-script chatter: predominantly non-Latin letters, no digits,
  // no product tokens. Serviced languages are all Latin script.
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length >= 2 && !/\d/.test(t) && !PRODUCT_TOKEN_RE.test(t)) {
    const latinCount = letters.filter(ch => /\p{Script=Latin}/u.test(ch)).length;
    if (latinCount / letters.length < 0.3) return 'non_serviced_script';
  }

  return null;
}

function isReactionRow(row) {
  if (!row) return true;
  if (row.intent === 'reaction') return true;
  const body = String(row.body || '');
  return body.startsWith('[reacted:') || body.startsWith('[reaction removed]');
}

// Decide whether to go silent on the current inbound.
// priorMessages: the conversation's rows in chronological order, EXCLUDING the
// current batch. Only { direction, body, intent } are read.
function assessIdleChatter({ text, priorMessages, freeReplies } = {}) {
  const reason = classifyLowValue(text);

  // Count the trailing streak of consecutive low-value customer turns.
  // Outbound rows (including silent_skip markers) and reactions are skipped;
  // the first substantive inbound breaks the streak.
  let priorStreak = 0;
  const rows = Array.isArray(priorMessages) ? priorMessages : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.direction !== 'inbound') continue;
    if (isReactionRow(row)) continue;
    if (classifyLowValue(row.body)) {
      priorStreak++;
    } else {
      break;
    }
  }

  if (!reason) return { mute: false, reason: null, priorStreak };

  // Junk links never earn a reply (owner decision 2026-07-11).
  if (reason === 'bare_link') return { mute: true, reason, priorStreak };

  const allowance = Number.isFinite(freeReplies) ? freeReplies : IDLE_CHATTER_FREE_REPLIES;
  return { mute: priorStreak >= allowance, reason, priorStreak };
}

module.exports = {
  classifyLowValue,
  assessIdleChatter,
  IDLE_CHATTER_FREE_REPLIES,
};
