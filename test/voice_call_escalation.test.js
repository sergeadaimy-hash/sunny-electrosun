const test = require('node:test');
const assert = require('node:assert');

process.env.DISABLE_NOTIFICATIONS = 'true';
process.env.DISABLE_ESCALATIONS = 'true';

const { assessVoiceCallEscalation } = require('../src/handler');

test('caller asking for the sales manager escalates as live_agent with region', () => {
  const a = assessVoiceCallEscalation([
    { role: 'assistant', content: 'Good day, this is Sunny from Electro-Sun.' },
    { role: 'user', content: "I'm looking for a ten kilowatt inverter" },
    { role: 'user', content: 'Abuja site.' },
    { role: 'user', content: 'Can you connect me with the sales manager?' },
    { role: 'assistant', content: 'Of course, Sir. The Sales Manager will reach out on WhatsApp.' }
  ]);
  assert.strictEqual(a.shouldEscalate, true);
  assert.strictEqual(a.escalationType, 'live_agent');
  assert.strictEqual(a.region, 'abuja');
  assert.ok(a.brief.includes('PHONE CALL'));
  assert.ok(a.brief.includes('ten kilowatt inverter'));
});

test('payment commitment on a call escalates HOT', () => {
  const a = assessVoiceCallEscalation([
    { role: 'user', content: 'I want to pay for the Deye inverter, send me the account' }
  ]);
  assert.strictEqual(a.shouldEscalate, true);
  assert.strictEqual(a.escalationType, 'hot_lead');
});

test('a Sales Manager PROMISE by Sunny alone still escalates (never-silent invariant)', () => {
  const a = assessVoiceCallEscalation([
    { role: 'user', content: 'What is the warranty on the batteries in Lagos?' },
    { role: 'assistant', content: 'The Sales Manager will confirm that for you on WhatsApp, Sir.' }
  ]);
  assert.strictEqual(a.shouldEscalate, true);
  assert.strictEqual(a.escalationType, 'silent_query');
  assert.strictEqual(a.region, 'lagos');
});

test('an ordinary informational call does not escalate', () => {
  const a = assessVoiceCallEscalation([
    { role: 'user', content: 'What areas do you deliver to?' },
    { role: 'assistant', content: 'We supply nationwide, Sir, with pickup in Abuja and Lagos.' }
  ]);
  assert.strictEqual(a.shouldEscalate, false);
});

test('empty or assistant-only transcripts never escalate', () => {
  assert.strictEqual(assessVoiceCallEscalation([]).shouldEscalate, false);
  assert.strictEqual(assessVoiceCallEscalation(null).shouldEscalate, false);
  assert.strictEqual(
    assessVoiceCallEscalation([{ role: 'assistant', content: 'The Sales Manager will call.' }]).shouldEscalate,
    false
  );
});
