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
  assert.equal(classifyLowValue('hello'), null);
  assert.equal(classifyLowValue('Good morning'), null);
  assert.equal(classifyLowValue('ok'), null);
  assert.equal(classifyLowValue('how much'), null);
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
