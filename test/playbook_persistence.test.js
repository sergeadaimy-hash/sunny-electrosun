'use strict';
// Run with: node --test test/playbook_persistence.test.js
//
// Proves Option A: approved audit lessons are read straight from the database,
// so they are live on the next reply and survive restarts (the DB lives on a
// durable volume). We point the app at a throwaway temp DB, insert findings,
// and check what getPlaybookText() returns.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must set DB_PATH before requiring anything that pulls in db/init, because the
// path is captured at module load.
const TMP_DB = path.join(os.tmpdir(), 'sunny-playbook-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;

const { initDb, getDb } = require('../db/init');
const auditStore = require('../src/audit_store');
const { getPlaybookText } = require('../src/playbook');

function insertFinding({ lane, finding_text, proposed_change, status, edited_text }) {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO audit_findings
       (run_id, conversation_id, contact_id, lane, finding_type, finding_text,
        proposed_change, cited_rule, cited_message, status, edited_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, null, null, lane, null, finding_text, proposed_change, null, null, status, edited_text || null, ts, ts);
  return info.lastInsertRowid;
}

before(() => {
  initDb();
  // Clean slate in case a previous run left rows behind.
  getDb().prepare('DELETE FROM audit_findings').run();
});

after(() => {
  try { getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch {}
  }
});

test('an approved skill-lesson is read from the DB into the playbook', () => {
  insertFinding({
    lane: 'skill_lesson',
    finding_text: 'Sunny re-asked the city after the customer already said Abuja.',
    proposed_change: 'Never re-ask a fact the customer already gave in this chat.',
    status: 'approved'
  });
  const md = getPlaybookText();
  assert.match(md, /Never re-ask a fact the customer already gave/);
  assert.doesNotMatch(md, /No approved lessons yet/);
});

test('a pending (not yet approved) finding does NOT appear in the playbook', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  insertFinding({
    lane: 'skill_lesson',
    finding_text: 'unreviewed',
    proposed_change: 'This lesson is still pending review and must not be live.',
    status: 'pending'
  });
  const md = getPlaybookText();
  assert.doesNotMatch(md, /still pending review/);
  assert.match(md, /No approved lessons yet/);
});

test('edited text wins over the original proposal when read from the DB', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  insertFinding({
    lane: 'skill_lesson',
    finding_text: 'x',
    proposed_change: 'original wording',
    edited_text: 'owner reworded this lesson',
    status: 'approved'
  });
  const md = getPlaybookText();
  assert.match(md, /owner reworded this lesson/);
  assert.doesNotMatch(md, /original wording/);
});

test('an empty DB renders the no-lessons sentinel (reply guard skips injection)', () => {
  getDb().prepare('DELETE FROM audit_findings').run();
  const md = getPlaybookText();
  assert.match(md, /No approved lessons yet/);
});
