'use strict';
// Run with: node --test test/playbook.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const { buildPlaybookMarkdown } = require('../src/playbook');

test('empty playbook renders the no-lessons header', () => {
  const md = buildPlaybookMarkdown([]);
  assert.match(md, /Learned playbook/);
  assert.match(md, /No approved lessons yet/);
});

test('lessons are numbered and edited_text wins over proposed_change', () => {
  const md = buildPlaybookMarkdown([
    { id: 1, proposed_change: 'original lesson', edited_text: null },
    { id: 2, proposed_change: 'raw', edited_text: 'edited lesson' },
  ]);
  assert.match(md, /1\. original lesson/);
  assert.match(md, /2\. edited lesson/);
  assert.doesNotMatch(md, /No approved lessons yet/);
});

test('near-duplicate lessons are dropped', () => {
  const md = buildPlaybookMarkdown([
    { id: 1, proposed_change: 'Acknowledge and stop after a short answer' },
    { id: 2, proposed_change: 'acknowledge and stop after a short answer' },
  ]);
  const count = (md.match(/^\d+\. /gm) || []).length;
  assert.equal(count, 1);
});
