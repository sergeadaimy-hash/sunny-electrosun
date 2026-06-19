'use strict';

// Run with: node --test test/extract_messages.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const { extractMessages } = require('../src/handler');

function wrap(message) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: message.from, profile: { name: 'Tester' } }],
              messages: [message]
            }
          }
        ]
      }
    ]
  };
}

test('text message extracts as kind text', () => {
  const out = extractMessages(wrap({ from: '234800', id: 'm1', type: 'text', text: { body: 'hi' } }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].body, 'hi');
});

test('image message extracts as kind image with media id', () => {
  const out = extractMessages(wrap({ from: '234800', id: 'm2', type: 'image', image: { id: 'img1', mime_type: 'image/png' } }));
  assert.equal(out[0].kind, 'image');
  assert.equal(out[0].media.id, 'img1');
  assert.equal(out[0].media.mimeType, 'image/png');
});

test('system message (number change) extracts as kind system, NOT unsupported', () => {
  const out = extractMessages(wrap({
    from: '2348052228322',
    id: 'm3',
    type: 'system',
    system: { body: 'User A changed from 234... to 234...', type: 'customer_changed_number', wa_id: '2348052228322' }
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'system');
  assert.notEqual(out[0].kind, 'unsupported');
  assert.equal(out[0].body, 'User A changed from 234... to 234...');
});

test('truly unsupported type (e.g. contacts) still extracts as unsupported', () => {
  const out = extractMessages(wrap({ from: '234800', id: 'm4', type: 'contacts', contacts: [{}] }));
  assert.equal(out[0].kind, 'unsupported');
});
