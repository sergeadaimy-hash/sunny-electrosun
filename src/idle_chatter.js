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
// Matches both the classifier-input marker ("[Customer sent an image ...]")
// and the persisted DB body shape ("[image] <caption>").
const IMAGE_MARKER_RE = /^\[(customer sent an image|image\b)/i;

// Romanized-Arabic chatter (2026-07-15): Whisper is pinned to English, so an
// Arabic voice note comes back as Latin transliteration ("Ya habibi, misal
// kheir...") that the script-ratio check can never catch. Strong tokens are
// distinctly Levantine/Gulf chatter words; weak tokens only count alongside
// them. Common Nigerian loanwords (wallahi, alhamdulillah, salam alaikum) are
// protected by requiring TWO strong hits plus a high token ratio, and by the
// product/digit guard that runs first.
const ROMANIZED_STRONG_RE = /^(habibi|habibti|habib|yalla|shukran|sukran|marhaba|ahlan|khalas|akhi|ukhti|hayati|albi|mishtaq\w*|walla|wallah\w*)$/;
const ROMANIZED_WEAK_RE = /^(ya|ana|anta|enta|inta|kif|keef|kaif|kheir|khair|alik|aleik|alaik|shlonak|shu|wain|fi|mafi|tamam|misal|masa|sabah)$/;

// Courtesy-only messages (thanks, greetings, affection) with nothing else.
// These are normal from real customers, so they are only muted when the
// conversation is already inside a junk streak (see assessIdleChatter).
const COURTESY_PHRASE_RE = /\b(thank\s*(you|u)|thanks+|tanx|thank\s*god|you(\s*are|'?re)?\s*welcome|good\s*(morning|afternoon|evening|day|night)|how\s*are\s*(you|u|things)|how\s*far|i\s*(am|'?m)\s*(good|fine|okay|ok|great)|i\s*love\s*(you|u)(\s*so\s*much)?|god\s*bless(\s*you)?|well\s*done|take\s*care|good\s*?bye|bye+|hello+|hi+|hey+|ok(ay)?|alright|no\s*(problem|wahala)|you\s*too|same\s*to\s*you|so\s*much|very\s*much|sir|oga|boss|madam|ma|my\s*(dear|friend|brother|sister)|dear|please|abeg|and|also|too)\b/gi;

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

  // Messages carrying URLs: judge the text AROUND the links. A share-card
  // (TikTok/Facebook boilerplate, chatter around a link) is a junk link even
  // when the boilerplate itself is long; only genuinely substantive
  // surrounding text saves it. (2026-07-15: an Arabic TikTok share slipped
  // through because the URLs and "TikTok Lite" boilerplate inflated the
  // Latin-letter ratio.)
  const urls = t.match(URL_RE);
  if (urls && urls.length) {
    const remainder = t.replace(URL_RE, ' ').trim();
    const leftoverWordChars = (remainder.match(/[\p{L}\p{N}]/gu) || []).length;
    if (leftoverWordChars < 4) return 'bare_link';
    if (classifyBody(remainder)) return 'bare_link';
    return null;
  }

  return classifyBody(t);
}

// Classify URL-free message text. Returns a low-value kind or null.
function classifyBody(t) {
  const hasPictographic = /\p{Extended_Pictographic}/u.test(t);
  const strippedOfSymbols = t.replace(/[\p{Extended_Pictographic}\p{P}\p{S}\p{Cf}\s️‍]/gu, '');

  // Emoji / symbol volley: nothing left once pictographs and punctuation go.
  if (!strippedOfSymbols && hasPictographic) return 'emoji_only';

  // Dots, dashes, stray punctuation ("........" transcripts).
  if (!strippedOfSymbols) return 'unintelligible';

  // Any digit or product/commerce token marks the message substantive.
  if (/\d/.test(t) || PRODUCT_TOKEN_RE.test(t)) return null;

  const letters = t.match(/\p{L}/gu) || [];

  // Non-serviced-script chatter: predominantly non-Latin letters. Serviced
  // languages are all Latin script (real ones score near 1.0, so 0.5 is safe).
  if (letters.length >= 2) {
    const latinCount = letters.filter(ch => /\p{Script=Latin}/u.test(ch)).length;
    if (latinCount / letters.length < 0.5) return 'non_serviced_script';
  }

  // Transliterated-Arabic chatter in Latin script.
  const tokens = t.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  if (tokens.length >= 3) {
    const strong = tokens.filter(w => ROMANIZED_STRONG_RE.test(w)).length;
    const weak = tokens.filter(w => ROMANIZED_WEAK_RE.test(w)).length;
    if (strong >= 2 && (strong + weak) / tokens.length >= 0.3) return 'non_serviced_script';
  }

  // Courtesy-only: strip courtesy phrases; if nothing meaningful remains, the
  // message is pure politeness ("Thank you so much", "Good morning, how are
  // you?"). Muted only inside an existing junk streak.
  const withoutCourtesy = t.replace(COURTESY_PHRASE_RE, ' ');
  const courtesyLeftover = (withoutCourtesy.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters.length >= 2 && courtesyLeftover < 3) return 'courtesy';

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
  // the first substantive inbound breaks the streak. Courtesy turns extend a
  // streak (so "thank you" cannot reset a junk mute) but only hard junk
  // (script/emoji/link/unintelligible) makes the streak dangerous.
  let priorStreak = 0;
  let hardJunkInStreak = false;
  const rows = Array.isArray(priorMessages) ? priorMessages : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.direction !== 'inbound') continue;
    if (isReactionRow(row)) continue;
    const kind = classifyLowValue(row.body);
    if (kind) {
      priorStreak++;
      if (kind !== 'courtesy') hardJunkInStreak = true;
    } else {
      break;
    }
  }

  if (!reason) return { mute: false, reason: null, priorStreak };

  // Junk links never earn a reply (owner decision 2026-07-11).
  if (reason === 'bare_link') return { mute: true, reason, priorStreak };

  // Courtesy is normal from real customers (thanks after a quote, greetings).
  // It is muted only when the conversation is already inside a junk streak.
  const allowance = Number.isFinite(freeReplies) ? freeReplies : IDLE_CHATTER_FREE_REPLIES;
  if (reason === 'courtesy') {
    return { mute: priorStreak >= allowance && hardJunkInStreak, reason, priorStreak };
  }

  return { mute: priorStreak >= allowance, reason, priorStreak };
}

module.exports = {
  classifyLowValue,
  assessIdleChatter,
  IDLE_CHATTER_FREE_REPLIES,
};
