'use strict';
// Voice-call transcript store (2026-08-18). Runs against a throwaway temp DB.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must set DB_PATH before requiring anything that pulls in db/init, because
// the path is captured at module load.
const TMP_DB = path.join(os.tmpdir(), 'sunny-voice-calls-test-' + process.pid + '.db');
process.env.DB_PATH = TMP_DB;
process.env.DISABLE_NOTIFICATIONS = 'true';

const { getDb } = require('../db/init');
const voiceCalls = require('../src/voice_calls');

after(() => {
  try { getDb().close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
});

test('sanitizeTranscript keeps only user/assistant turns with content', () => {
  const out = voiceCalls.sanitizeTranscript([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Good day, ' }, { type: 'text', text: 'Sir.' }] },
    { role: 'user', content: '   ' },
    { role: 'developer', content: 'nope' },
    null,
    { role: 'assistant' }
  ]);
  assert.deepStrictEqual(out, [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Good day,  Sir.' }
  ]);
});

test('formatCallDuration and computeDurationSeconds', () => {
  assert.strictEqual(voiceCalls.formatCallDuration(45), '45s');
  assert.strictEqual(voiceCalls.formatCallDuration(133), '2m 13s');
  assert.strictEqual(voiceCalls.formatCallDuration(null), null);
  assert.strictEqual(voiceCalls.formatCallDuration(-5), null);
  assert.strictEqual(
    voiceCalls.computeDurationSeconds('2026-08-18T10:00:00Z', '2026-08-18T10:02:13Z'),
    133
  );
  assert.strictEqual(voiceCalls.computeDurationSeconds('bad', '2026-08-18T10:02:13Z'), null);
  assert.strictEqual(
    voiceCalls.computeDurationSeconds('2026-08-18T10:05:00Z', '2026-08-18T10:00:00Z'),
    null
  );
});

test('recordVoiceCall stores the call, links the contact, and writes a thread marker', () => {
  const saved = voiceCalls.recordVoiceCall({
    phone: '+234 803 111 2233',
    wa_call_id: 'wacid.test.1',
    status: 'completed',
    started_at: '2026-08-18T10:00:00Z',
    ended_at: '2026-08-18T10:02:13Z',
    transcript: [
      { role: 'user', content: 'I need an inverter' },
      { role: 'assistant', content: 'Certainly possible, Sir. Which city are you in?' }
    ]
  });
  assert.ok(saved.id > 0);
  assert.strictEqual(saved.phone, '2348031112233');
  assert.strictEqual(saved.duration_seconds, 133);
  assert.strictEqual(saved.duration_text, '2m 13s');
  assert.strictEqual(saved.transcript.length, 2);
  assert.ok(saved.contact_id > 0);

  // Thread marker: outbound, intent voice_call, no whatsapp_message_id.
  const db = getDb();
  const marker = db.prepare(
    "SELECT * FROM messages WHERE intent = 'voice_call' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(marker, 'marker row exists');
  assert.strictEqual(marker.direction, 'outbound');
  assert.ok(marker.body.includes('2m 13s'));
  assert.strictEqual(marker.whatsapp_message_id, null);
});

test('recordVoiceCall upserts on the same wa_call_id without a second marker', () => {
  const first = voiceCalls.recordVoiceCall({
    phone: '2348031112233',
    wa_call_id: 'wacid.test.2',
    started_at: '2026-08-18T11:00:00Z',
    ended_at: '2026-08-18T11:00:30Z',
    transcript: [{ role: 'user', content: 'partial' }]
  });
  const second = voiceCalls.recordVoiceCall({
    phone: '2348031112233',
    wa_call_id: 'wacid.test.2',
    started_at: '2026-08-18T11:00:00Z',
    ended_at: '2026-08-18T11:01:00Z',
    transcript: [
      { role: 'user', content: 'partial' },
      { role: 'assistant', content: 'full reply' }
    ]
  });
  assert.strictEqual(second.id, first.id);
  assert.strictEqual(second.transcript.length, 2);
  const db = getDb();
  const markers = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE intent = 'voice_call'").get().n;
  assert.strictEqual(markers, 2, 'one marker per distinct call (tests 3 and 4)');
});

test('empty transcript is stored as no_transcript', () => {
  const saved = voiceCalls.recordVoiceCall({
    phone: '2348099998877',
    wa_call_id: 'wacid.test.3',
    started_at: '2026-08-18T12:00:00Z',
    ended_at: '2026-08-18T12:00:05Z',
    transcript: []
  });
  assert.strictEqual(saved.status, 'no_transcript');
  assert.deepStrictEqual(saved.transcript, []);
});

test('listVoiceCalls returns newest first with preview and no raw transcript', () => {
  const calls = voiceCalls.listVoiceCalls({ limit: 10 });
  assert.ok(calls.length >= 3);
  assert.ok(calls[0].id > calls[calls.length - 1].id);
  const withPreview = calls.find(c => c.wa_call_id === 'wacid.test.1');
  assert.strictEqual(withPreview.preview, 'I need an inverter');
  assert.strictEqual(withPreview.transcript_turns, 2);
  assert.strictEqual(withPreview.transcript, undefined);
});
