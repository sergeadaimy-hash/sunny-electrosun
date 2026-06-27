'use strict';
// Run with: node --test test/facts_persistence.test.js
//
// Proves the missing-facts loop end to end against a real temp DB: an approved
// general fact is read into the facts block Sunny sees; a pending one is not; a
// price fact (missing_price_fact) is excluded so prices never enter the block.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'sunny-facts-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { initDb, getDb } = require('../db/init');
const auditStore = require('../src/audit_store');
const { getFactsText } = require('../src/facts');

function insertFact({ finding_type, proposed_change, status, edited_text }) {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO audit_findings
       (run_id, conversation_id, contact_id, lane, finding_type, finding_text,
        proposed_change, cited_rule, cited_message, status, edited_text, created_at, updated_at)
     VALUES (?, ?, ?, 'knowledge_fact', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, null, null, finding_type || null, 'x', proposed_change, null, null, status, edited_text || null, ts, ts);
  return info.lastInsertRowid;
}

before(() => {
  initDb();
  getDb().prepare('DELETE FROM audit_findings').run();
});

after(() => {
  try { getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch {}
  }
});

test('an approved general fact is read into the facts block', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  insertFact({ finding_type: 'other', proposed_change: 'We give a 2-year warranty on inverters.', status: 'approved' });
  const md = getFactsText();
  assert.match(md, /2-year warranty on inverters/);
  assert.doesNotMatch(md, /No confirmed facts yet/);
});

test('a pending fact is NOT in the block', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  insertFact({ finding_type: 'other', proposed_change: 'This fact is still pending review.', status: 'pending' });
  const md = getFactsText();
  assert.doesNotMatch(md, /still pending review/);
  assert.match(md, /No confirmed facts yet/);
});

test('a price fact (missing_price_fact) is excluded from the facts block', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  insertFact({ finding_type: 'missing_price_fact', proposed_change: 'Add the price of the Deye 16kW HV inverter.', status: 'approved' });
  const md = getFactsText();
  assert.doesNotMatch(md, /Deye 16kW HV inverter/);
  assert.match(md, /No confirmed facts yet/);
});

test('setFindingType reclassifies a finding (safety-net path)', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  const id = insertFact({ finding_type: 'other', proposed_change: 'It costs 4,200,000.', status: 'approved' });
  // Before reclassify it would show as a fact; after, it is treated as a price.
  assert.match(getFactsText(), /4,200,000/);
  auditStore.setFindingType(id, 'missing_price_fact');
  assert.doesNotMatch(getFactsText(), /4,200,000/);
});
