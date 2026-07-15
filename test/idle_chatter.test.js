'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  classifyLowValue,
  assessIdleChatter,
  IDLE_CHATTER_FREE_REPLIES,
} = require('../src/idle_chatter.js');

// classifyLowValue: what counts as an unproductive message

test('emoji-only messages are low value', () => {
  assert.equal(classifyLowValue('👍'), 'emoji_only');
  assert.equal(classifyLowValue('🌹🌹🌹🌹'), 'emoji_only');
  assert.equal(classifyLowValue('🤲'), 'emoji_only');
  assert.equal(classifyLowValue('😂😂 👌'), 'emoji_only');
  assert.equal(classifyLowValue('❤️'), 'emoji_only');
});

test('non-serviced-script chatter with no product content is low value', () => {
  assert.equal(classifyLowValue('صباح الخير كيف حالك هل انت بخير'), 'non_serviced_script');
  assert.equal(classifyLowValue('يا صديق جيب رسال عربي'), 'non_serviced_script');
  assert.equal(classifyLowValue('مرحب ياقال غليا'), 'non_serviced_script');
  assert.equal(classifyLowValue('سلام عليك كيف حالك هل انت بخير'), 'non_serviced_script');
});

test('non-Latin text naming a product or figure is NOT low value', () => {
  assert.equal(classifyLowValue('اريد Deye 16kW'), null);
  assert.equal(classifyLowValue('السعر 5,000,000 نيرة؟'), null);
  assert.equal(classifyLowValue('inverter محتاج'), null);
});

test('bare junk links are low value', () => {
  assert.equal(classifyLowValue('https://vm.tiktok.com/ZSX1rKeJp/'), 'bare_link');
  assert.equal(classifyLowValue('https://www.facebook.com/share/r/1EG255cxxU/'), 'bare_link');
  assert.equal(classifyLowValue('Xnxx-arabic.com'), 'bare_link');
  assert.equal(classifyLowValue('www.example.com'), 'bare_link');
});

test('a link with a real question attached is NOT a bare link', () => {
  assert.equal(classifyLowValue('https://example.com/inverter can you quote me this one?'), null);
});

test('punctuation-only and gibberish transcripts are low value', () => {
  assert.equal(classifyLowValue('........'), 'unintelligible');
  assert.equal(classifyLowValue('[voice note transcribed]: ........'), 'unintelligible');
  assert.equal(classifyLowValue('...'), 'unintelligible');
  assert.equal(classifyLowValue('[Customer sent a voice note that could not be transcribed]'), 'unintelligible');
});

test('normal English messages are NOT low value', () => {
  assert.equal(classifyLowValue('What is the warranty on Deye batteries?'), null);
  assert.equal(classifyLowValue('I need solar panels'), null);
  assert.equal(classifyLowValue('how much'), null);
});

test('pure greetings classify as courtesy (never muted without a junk streak)', () => {
  assert.equal(classifyLowValue('hello'), 'courtesy');
  assert.equal(classifyLowValue('Good morning'), 'courtesy');
  assert.equal(classifyLowValue('ok'), 'courtesy');
});

test('pidgin and serviced-language messages are NOT low value', () => {
  assert.equal(classifyLowValue('abeg how much for inverter'), null);
  assert.equal(classifyLowValue('wetin dey happen'), null);
});

test('a transcribed voice note with real content is NOT low value', () => {
  assert.equal(classifyLowValue('[voice note transcribed]: Assalamu alaikum I want to ask about solar'), null);
});

test('image markers are NOT low value', () => {
  assert.equal(classifyLowValue('[Customer sent an image with no caption]'), null);
  assert.equal(classifyLowValue('[Customer sent an image with caption]: my roof'), null);
});

test('empty and whitespace-only input is not classified (upstream handles it)', () => {
  assert.equal(classifyLowValue(''), null);
  assert.equal(classifyLowValue('   '), null);
  assert.equal(classifyLowValue(null), null);
});

// assessIdleChatter: when to go silent

function inbound(body, extra) { return Object.assign({ direction: 'inbound', body }, extra); }
function outbound(body, extra) { return Object.assign({ direction: 'outbound', body }, extra); }

test('default free replies is 1', () => {
  assert.equal(IDLE_CHATTER_FREE_REPLIES, 1);
});

test('bare junk link is muted immediately, even as the first message', () => {
  const res = assessIdleChatter({ text: 'Xnxx-arabic.com', priorMessages: [] });
  assert.equal(res.mute, true);
  assert.equal(res.reason, 'bare_link');
});

test('first low-value turn is NOT muted (Sunny gets one polite reply)', () => {
  const res = assessIdleChatter({ text: 'صباح الخير كيف حالك', priorMessages: [] });
  assert.equal(res.mute, false);
});

test('second consecutive low-value turn IS muted', () => {
  const prior = [
    inbound('سلام عليك كيف حالك'),
    outbound('Hello Sir, we reply in English only. How can we help you with your solar needs today?'),
  ];
  const res = assessIdleChatter({ text: 'شواخيار وصحتك اشتخت', priorMessages: prior });
  assert.equal(res.mute, true);
  assert.equal(res.reason, 'non_serviced_script');
});

test('emoji after a muted junk turn stays muted (streak keeps growing)', () => {
  const prior = [
    inbound('سلام عليك كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
    inbound('صباح الخير كيف حالك'),
    outbound('[silent skip: unproductive conversation, muted]', { intent: 'silent_skip' }),
  ];
  const res = assessIdleChatter({ text: '👍', priorMessages: prior });
  assert.equal(res.mute, true);
});

test('a substantive message in between resets the streak', () => {
  const prior = [
    inbound('صباح الخير كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
    inbound('What is the price of the Deye 16kW?'),
    outbound('The Deye SUN-16K is 3,000,000 NGN, Sir.'),
  ];
  const res = assessIdleChatter({ text: '❤️', priorMessages: prior });
  assert.equal(res.mute, false);
});

test('substantive current message is never muted regardless of prior streak', () => {
  const prior = [
    inbound('صباح الخير'),
    outbound('Hello Sir.'),
    inbound('🌹🌹🌹🌹'),
    outbound('[silent skip: unproductive conversation, muted]', { intent: 'silent_skip' }),
  ];
  const res = assessIdleChatter({ text: 'I need 3 inverters for my house in Abuja', priorMessages: prior });
  assert.equal(res.mute, false);
  assert.equal(res.reason, null);
});

test('reaction rows are ignored when counting the streak', () => {
  const prior = [
    inbound('صباح الخير كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
    inbound('[reacted: 👍]', { intent: 'reaction' }),
  ];
  const res = assessIdleChatter({ text: 'مساء الخير كيف حالك', priorMessages: prior });
  assert.equal(res.mute, true);
});

test('freeReplies option is honored', () => {
  const prior = [
    inbound('صباح الخير كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
  ];
  const res = assessIdleChatter({ text: '👍', priorMessages: prior, freeReplies: 3 });
  assert.equal(res.mute, false);
});

// 2026-07-15 leak regression: a live spam conversation kept getting replies
// because three message shapes classified as substantive AND reset the streak:
// (a) an Arabic TikTok share (URLs + "TikTok Lite" boilerplate pushed the
// Latin ratio over the bar), (b) a courtesy voice note ("Thank you so much"),
// (c) a transliterated-Arabic voice note ("Ya habibi, misal kheir...") which
// Whisper, pinned to English, romanizes into Latin script.

const TIKTOK_SHARE = 'شاهد مقطع الفيديو الخاص بـOneal! #TikTok https://vm.tiktok.com/ZSXhW7DfY/ تتم مشاركة هذا المنشور عبر TikTok Lite. نزل TikTok Lite للاستمتاع بمزيد من المنشورات: https://www.tiktok.com/tiktoklite';
const TRANSLIT_VOICE = '[voice note transcribed]: Ya habibi, misal kheir, ya habibi, misal kheir. Anta kuhisa, ya habibi, kif haalik, al-umurik sahwa al-afiha. Ya habibi, anta tqib, ya habibi, mishtaqeer. Walla, ana mishtaqe alik, mishtaqe alik.';

test('link share wrapped in non-serviced-script boilerplate is a bare link', () => {
  assert.equal(classifyLowValue(TIKTOK_SHARE), 'bare_link');
});

test('link with genuinely substantive Latin text around it is NOT low value', () => {
  assert.equal(classifyLowValue('Please check this datasheet https://example.com/deye.pdf and tell me the price'), null);
  assert.equal(classifyLowValue('My address is here https://maps.app.goo.gl/abc, can you deliver 4 panels?'), null);
});

test('transliterated Arabic chatter in Latin script is low value', () => {
  assert.equal(classifyLowValue(TRANSLIT_VOICE), 'non_serviced_script');
  assert.equal(classifyLowValue('ya habibi kif haalik ya habibi mishtaqe alik walla'), 'non_serviced_script');
});

test('Nigerian usage of single Arabic loanwords is NOT flagged', () => {
  assert.equal(classifyLowValue('Wallahi I go buy the inverter next week'), null);
  assert.equal(classifyLowValue('Alhamdulillah, the panels arrived safely, thank you'), null);
  assert.equal(classifyLowValue('Salam alaikum, I want to ask about solar for my shop'), null);
});

test('courtesy-only messages classify as courtesy', () => {
  assert.equal(classifyLowValue('[voice note transcribed]: Thank you so much. Thank you.'), 'courtesy');
  assert.equal(classifyLowValue('Good morning, how are you?'), 'courtesy');
  assert.equal(classifyLowValue('ok thank you'), 'courtesy');
});

test('courtesy with real content stays substantive', () => {
  assert.equal(classifyLowValue('Thank you, please send the proforma invoice'), null);
  assert.equal(classifyLowValue('Good morning, do you deliver to Kano?'), null);
});

test('courtesy after a junk streak stays muted (does not reset the mute)', () => {
  const prior = [
    inbound('صباح الخير كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
    inbound(TIKTOK_SHARE),
    outbound('[silent skip: unproductive conversation muted (bare_link)]', { intent: 'silent_skip' }),
  ];
  const res = assessIdleChatter({ text: '[voice note transcribed]: Thank you so much. Thank you.', priorMessages: prior });
  assert.equal(res.mute, true);
  assert.equal(res.reason, 'courtesy');
});

test('courtesy in a clean conversation is never muted', () => {
  const prior = [
    inbound('What is the price of the Deye 16kW?'),
    outbound('The Deye SUN-16K is 3,000,000 NGN, Sir.'),
  ];
  const res = assessIdleChatter({ text: 'Thank you so much', priorMessages: prior });
  assert.equal(res.mute, false);
});

test('greeting then greeting (no hard junk) is never muted', () => {
  const prior = [
    inbound('Hello'),
    outbound('Welcome to Electro-Sun...'),
  ];
  const res = assessIdleChatter({ text: 'Good morning', priorMessages: prior });
  assert.equal(res.mute, false);
});

test('transliterated voice chatter after a junk streak stays muted', () => {
  const prior = [
    inbound('صباح الخير كيف حالك'),
    outbound('Hello Sir, we reply in English only.'),
    inbound('يا قلب ان نخيك'),
    outbound('[silent skip: unproductive conversation muted (non_serviced_script)]', { intent: 'silent_skip' }),
  ];
  const res = assessIdleChatter({ text: TRANSLIT_VOICE, priorMessages: prior });
  assert.equal(res.mute, true);
});

test('full 2026-07-15 spam sequence never resets the streak', () => {
  const prior = [
    inbound('مرخين مصح الخيرا'),
    outbound('Good morning, Sir. How can I help you today?'),
    inbound('يا قلب ان نخيك'),
    outbound('[silent skip]', { intent: 'silent_skip' }),
    inbound('وسكرا كانيرا'),
    outbound('[silent skip]', { intent: 'silent_skip' }),
    inbound(TIKTOK_SHARE),
  ];
  const thanks = assessIdleChatter({ text: '[voice note transcribed]: Thank you so much. Thank you.', priorMessages: prior });
  assert.equal(thanks.mute, true);
  const habibi = assessIdleChatter({ text: TRANSLIT_VOICE, priorMessages: prior });
  assert.equal(habibi.mute, true);
});
