'use strict';

// Regression suite for the 2026-08-01 ten-day audit. Each block names the live
// conversation that exposed the defect so a future reader can go re-read it.

const test = require('node:test');
const assert = require('node:assert');

const { detectDanglingFragment, isPriceAsk } = require('../src/claude');
const { detectPromptLeak } = require('../src/security');
const { isCasualConfirmation } = require('../src/handler');
const { decideRecipient } = require('../src/owner_routing');
const { mergeLeadTemperature } = require('../src/classifier');

// ---------------------------------------------------------------------------
// 1. Price-strip guard. 53 replies collapsed into the generic deflection and 7
//    shipped with a dangling connector. A customer who names a product AND a
//    size is asking for the price.
// ---------------------------------------------------------------------------

test('isPriceAsk treats a product-plus-size statement as a price ask', () => {
  // Live messages that produced "Could you share more about your project...".
  assert.equal(isPriceAsk("I'm looking for 20 kva 3 phase inverter"), true);
  assert.equal(isPriceAsk('Do you have 80kva deye inverter'), true);
  assert.equal(isPriceAsk('I need 30 kw inverter'), true);
  assert.equal(isPriceAsk('deye 16kwh lithium battery'), true);
  assert.equal(isPriceAsk('The 8kw inverter and the 16kwh battery is ok'), true);
  assert.equal(isPriceAsk('10kwt lithium and 7.5kva hybrid solar.'), true);
});

test('isPriceAsk still matches the explicit price words', () => {
  assert.equal(isPriceAsk('how much'), true);
  assert.equal(isPriceAsk('Prix'), true);
  assert.equal(isPriceAsk('Prix svp'), true);
  assert.equal(isPriceAsk('send me a quotation'), true);
});

test('a bare capacity figure is a price ask on its own', () => {
  // On a solar counter a capacity IS the product. All live messages that were
  // answered with the generic deflection.
  assert.equal(isPriceAsk('16kva set'), true);
  assert.equal(isPriceAsk('And 590w'), true);
  assert.equal(isPriceAsk('20 kW'), true);
  assert.equal(isPriceAsk('5kwh 48v'), true);
  // Spellings customers actually type, all from live threads.
  assert.equal(isPriceAsk('Am back for the inverter 6kwts'), true);
  assert.equal(isPriceAsk('620watt'), true);
  assert.equal(isPriceAsk('30kwa'), true);
  assert.equal(isPriceAsk('I need 10 kilowatt'), true);
});

test('isPriceAsk tolerates the way customers punctuate "how much"', () => {
  assert.equal(isPriceAsk('What is the warranty on LONGi solar panels? How.much'), true);
  assert.equal(isPriceAsk('howmuch'), true);
  assert.equal(isPriceAsk('How much?'), true);
});

test('isPriceAsk stays false for talk with no product and no price word', () => {
  assert.equal(isPriceAsk('good morning'), false);
  assert.equal(isPriceAsk('are you a bot'), false);
  assert.equal(isPriceAsk('where is your office'), false);
  assert.equal(isPriceAsk(''), false);
  assert.equal(isPriceAsk(null), false);
});

test('detectDanglingFragment catches a price connector at end of line', () => {
  // Live text: the strip removed the figure and left the "at" hanging.
  assert.equal(
    detectDanglingFragment('Closest sizes we carry: - SUN-8K-SG05LP1-EU-SM2-P (8kW, 1-phase hybrid, available) at'),
    'connector_eol'
  );
  assert.equal(detectDanglingFragment('Both are available, Sir. 6kW: SUN-6K-OG01LP1-EU-AM2 at'), 'connector_eol');
  assert.equal(detectDanglingFragment('Here are the prices for'), 'connector_eol');
  assert.equal(detectDanglingFragment("Here's the pricing for"), 'connector_eol');
});

test('detectDanglingFragment catches a connector at the end of an inner line', () => {
  const s = 'For 16kW, we have two options in stock: SUN-16K-SG01LP1-EU (single-phase) at\nSUN-16K-SG05LP3-EU-SM2 (three-phase)';
  assert.equal(detectDanglingFragment(s), 'connector_eol');
});

test('detectDanglingFragment leaves healthy prose alone', () => {
  assert.equal(detectDanglingFragment('The SE-F16 is available now.'), null);
  assert.equal(detectDanglingFragment('We are looking at the 8kW for you.'), null);
  assert.equal(detectDanglingFragment('Pickup is from Abuja or Lagos.'), null);
  assert.equal(detectDanglingFragment('Which size are you sizing for?'), null);
});

// ---------------------------------------------------------------------------
// 2. Reasoning leak. Four replies shipped Sunny's scratchpad to customers
//    (conv 6447 twice, 6572, 6778).
// ---------------------------------------------------------------------------

test('detectPromptLeak catches the reply-rules narration leaked in conv 6447', () => {
  const leaked = 'The customer is asking in French ("Coutera combien" = "How much will this cost"). '
    + 'Per the reply language rules, I must respond in English regardless.';
  assert.ok(detectPromptLeak(leaked));
});

test('detectPromptLeak catches the conv 6572 and 6778 narrations', () => {
  assert.ok(detectPromptLeak('Per the reply language rules, I can only respond in English for French. Let me answer correctly:'));
  assert.ok(detectPromptLeak('From the conversation state, the customer has mentioned 5kWh HV batteries.'));
});

test('detectPromptLeak catches first-person planning narration', () => {
  assert.ok(detectPromptLeak("I should offer our equivalent Deye components."));
  assert.ok(detectPromptLeak("I'll offer the Deye equivalents."));
});

test('detectPromptLeak leaves normal sales replies alone', () => {
  assert.equal(detectPromptLeak('The Deye SE-F16 (16kWh) is 2,380,000 NGN, available.'), null);
  assert.equal(detectPromptLeak('Let me confirm that with the team and get back to you.'), null);
  assert.equal(detectPromptLeak('I can help with that, Sir. Which size are you after?'), null);
  assert.equal(detectPromptLeak('Longi panels carry a 15-year materials warranty.'), null);
});

// ---------------------------------------------------------------------------
// 3. Silent-skip swallowing real messages. 70 warm-close skips, several of them
//    on genuine content.
// ---------------------------------------------------------------------------

test('isCasualConfirmation is false for short messages that carry real content', () => {
  assert.equal(isCasualConfirmation('I live in Port Harcourt'), false);
  assert.equal(isCasualConfirmation('May I have u name'), false);
  assert.equal(isCasualConfirmation('Hello good evening'), false);
  assert.equal(isCasualConfirmation('And 590w'), false);
  assert.equal(isCasualConfirmation('Abuja'), false);
  assert.equal(isCasualConfirmation('Lagos please'), false);
  assert.equal(isCasualConfirmation('Tchad'), false);
  assert.equal(isCasualConfirmation('2 units'), false);
});

test('isCasualConfirmation stays true for genuine closers', () => {
  assert.equal(isCasualConfirmation('Ok'), true);
  assert.equal(isCasualConfirmation('Okay.\nThanks'), true);
  assert.equal(isCasualConfirmation('thanks'), true);
  assert.equal(isCasualConfirmation('👍'), true);
  assert.equal(isCasualConfirmation('noted'), true);
  assert.equal(isCasualConfirmation('Alright then'), true);
  assert.equal(isCasualConfirmation('sure'), true);
});

// ---------------------------------------------------------------------------
// 4. Escalation load balance. Abuja took 205 alerts against Lagos's 41 because
//    every city-unknown lead defaulted to Abuja (owner, 2026-07-29).
// ---------------------------------------------------------------------------

test('a city-unknown lead alternates between the Abuja and Lagos desks', () => {
  const base = { category: 'SERIOUS', routing_region: 'unknown', abujaConfigured: true, lagosConfigured: true };
  const first = decideRecipient({ ...base, lastRegionalDesk: null });
  assert.equal(first.label, 'abuja');
  assert.equal(first.flipRegionalTo, 'abuja');

  const second = decideRecipient({ ...base, lastRegionalDesk: 'abuja' });
  assert.equal(second.label, 'lagos');
  assert.equal(second.flipRegionalTo, 'lagos');

  const third = decideRecipient({ ...base, lastRegionalDesk: 'lagos' });
  assert.equal(third.label, 'abuja');
});

test('a KNOWN region still routes to that desk and does not touch the rotation', () => {
  const abuja = decideRecipient({ category: 'SERIOUS', routing_region: 'abuja', abujaConfigured: true, lagosConfigured: true, lastRegionalDesk: 'abuja' });
  assert.equal(abuja.label, 'abuja');
  assert.equal(abuja.flipRegionalTo, null);

  const lagos = decideRecipient({ category: 'SERIOUS', routing_region: 'lagos', abujaConfigured: true, lagosConfigured: true, lastRegionalDesk: 'lagos' });
  assert.equal(lagos.label, 'lagos');
  assert.equal(lagos.flipRegionalTo, null);
});

test('city-unknown falls back to the single configured desk when only one is set', () => {
  const onlyAbuja = decideRecipient({ category: 'SERIOUS', routing_region: 'unknown', abujaConfigured: true, lagosConfigured: false, lastRegionalDesk: 'abuja' });
  assert.equal(onlyAbuja.label, 'abuja');

  const onlyLagos = decideRecipient({ category: 'SERIOUS', routing_region: 'unknown', abujaConfigured: false, lagosConfigured: true, lastRegionalDesk: 'lagos' });
  assert.equal(onlyLagos.label, 'lagos');

  const neither = decideRecipient({ category: 'SERIOUS', routing_region: 'unknown', abujaConfigured: false, lagosConfigured: false });
  assert.equal(neither.label, 'owner');
});

test('big projects still go to the owners, untouched by the regional rotation', () => {
  const d = decideRecipient({ category: 'HOT', routing_category: 'big_project', routing_region: 'unknown', abujaConfigured: true, lagosConfigured: true, lastAssignee: 'patrick' });
  assert.equal(d.label, 'charbel');
  assert.equal(d.flipTo, 'charbel');
});

// ---------------------------------------------------------------------------
// 5. lead_temperature read COLD for 98.8% of contacts because the newest
//    message overwrote the peak.
// ---------------------------------------------------------------------------

test('lead_temperature keeps the hottest value the contact ever reached', () => {
  assert.equal(mergeLeadTemperature('COLD', 'HOT'), 'HOT');
  assert.equal(mergeLeadTemperature('HOT', 'COLD'), 'HOT');
  assert.equal(mergeLeadTemperature('WARM', 'COLD'), 'WARM');
  assert.equal(mergeLeadTemperature('COLD', 'WARM'), 'WARM');
  assert.equal(mergeLeadTemperature('HOT', 'WARM'), 'HOT');
});

test('a terminal temperature always wins, so a closed or lost lead is never re-heated', () => {
  assert.equal(mergeLeadTemperature('HOT', 'CLOSED'), 'CLOSED');
  assert.equal(mergeLeadTemperature('HOT', 'LOST'), 'LOST');
  assert.equal(mergeLeadTemperature('HOT', 'DISQUALIFIED'), 'DISQUALIFIED');
  assert.equal(mergeLeadTemperature('CLOSED', 'HOT'), 'CLOSED');
  assert.equal(mergeLeadTemperature('DISQUALIFIED', 'WARM'), 'DISQUALIFIED');
});

test('mergeLeadTemperature handles missing values', () => {
  assert.equal(mergeLeadTemperature(null, 'WARM'), 'WARM');
  assert.equal(mergeLeadTemperature('WARM', null), 'WARM');
  assert.equal(mergeLeadTemperature(null, null), null);
  assert.equal(mergeLeadTemperature('nonsense', 'HOT'), 'HOT');
});
