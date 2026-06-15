# Sunny Nightly Self-Improvement, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core nightly loop: at 21:00 Africa/Lagos, Sunny audits the day's conversations against his own rules and stock, writes proposed lessons and facts to a review queue, and the owner approves them on his phone, with approved skill-lessons committed to a repo-backed playbook that is injected into every future reply.

**Architecture:** A new gated cron calls `runNightlyAudit()` in `src/audit.js`, which selects active conversations, runs one cheap Sonnet call per conversation against a cached rules block (`audit.md` + `system.md` + warehouse + current playbook), and stores findings in two new SQLite tables (`audit_runs`, `audit_findings`). A new admin "Nightly Audit" tab (admin-only) lists findings with Approve / Edit / Reject; "Apply approved" rebuilds `src/prompts/learned-playbook.md` from all approved skill-lessons and commits it to GitHub via the existing Contents API flow (one push per apply). `claude.js` injects the playbook into the reply prompt.

**Tech Stack:** Node.js 20, Express, better-sqlite3, node-cron, @anthropic-ai/sdk (all already in `package.json`, no new dependencies). Tests use the built-in `node --test` runner. Model: `claude-sonnet-4-6` for the audit (recognized by the cost tracker, cheap).

**Scope note:** This plan is Phase 1 only (the core loop, finding lanes, review tab, playbook apply). Phase 2 (knowledge-fact routing to Warehouse / system.md, lesson graduation, did-it-work recheck, merge, regression watch, weekly scorecard) and Phase 3 (guard-trip log signals) are separate future plans. The design note is `docs/superpowers/specs/2026-06-15-sunny-nightly-self-improvement-design.md`.

**House rules that apply to every task:** No em-dash, en-dash, or `--` in any code, comment, prompt, or commit message (single hyphens in compounds and number ranges are fine). Never auto-deploy. Commits in these steps are local only; the human pushes manually.

---

## File map

Created:
- `src/audit_store.js` — DB CRUD for `audit_runs` and `audit_findings`.
- `src/github_commit.js` — reusable single-file GitHub Contents API commit (extracted from the inline prompt-save flow).
- `src/playbook.js` — build the playbook markdown from approved lessons, read it, and rebuild-and-commit.
- `src/audit.js` — the nightly audit engine plus pure helpers.
- `src/prompts/audit.md` — the auditor system prompt.
- `src/prompts/learned-playbook.md` — the injected playbook file (starts empty).
- `test/github_commit.test.js`, `test/playbook.test.js`, `test/audit.test.js` — unit tests for the pure logic.

Modified:
- `db/schema.sql` — two new `CREATE TABLE IF NOT EXISTS` blocks plus indexes.
- `src/prompt_store.js` — add `audit` and `learned-playbook` to `ALLOWED`.
- `src/claude.js` — inject the playbook block into `generateReply`.
- `api/dashboard.js` — four `/audit/*` endpoints.
- `public/admin.html` — the Nightly Audit tab (nav button, section, CSS, JS).
- `server.js` — the gated nightly cron.
- `.env.example` — document the new env vars.

---

## Task 1: Add the audit DB tables

**Files:**
- Modify: `db/schema.sql` (append after the `pending_queries` table block, around line 87)

- [ ] **Step 1: Append the two tables and indexes to `db/schema.sql`**

Add this block at the end of `db/schema.sql`:

```sql

-- Nightly self-improvement audit (2026-06-15). One row per nightly pass.
CREATE TABLE IF NOT EXISTS audit_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  conversations_audited INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  scorecard TEXT,
  error TEXT,
  created_at TEXT,
  finished_at TEXT
);

-- One row per proposal the audit produced.
CREATE TABLE IF NOT EXISTS audit_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  conversation_id INTEGER,
  contact_id INTEGER,
  lane TEXT NOT NULL,
  finding_type TEXT,
  finding_text TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  cited_rule TEXT,
  cited_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  edited_text TEXT,
  created_at TEXT,
  updated_at TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_findings_run ON audit_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON audit_findings(status);
```

- [ ] **Step 2: Run the idempotent init to create the tables**

Run: `node db/init.js`
Expected: prints `DB initialized at ...` and a `Tables:` line that now includes `audit_findings, audit_runs`.

- [ ] **Step 3: Verify the tables exist**

Run: `node -e "const {getDb}=require('./db/init'); const db=getDb(); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'audit_%'\").all());"`
Expected: `[ { name: 'audit_runs' }, { name: 'audit_findings' } ]` (order may vary).

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql
git commit -m "feat(audit): add audit_runs and audit_findings tables"
```

---

## Task 2: GitHub commit helper (extracted, reusable)

**Files:**
- Create: `src/github_commit.js`
- Test: `test/github_commit.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/github_commit.test.js`:

```js
'use strict';
// Run with: node --test test/github_commit.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  githubContentsUrl,
  encodeContentBase64,
  buildPutBody,
} = require('../src/github_commit');

test('githubContentsUrl builds the contents API path', () => {
  assert.equal(
    githubContentsUrl('owner/repo', 'src/prompts/learned-playbook.md'),
    'https://api.github.com/repos/owner/repo/contents/src/prompts/learned-playbook.md'
  );
});

test('encodeContentBase64 round-trips utf8', () => {
  const b64 = encodeContentBase64('hello world');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'hello world');
});

test('buildPutBody includes sha only when provided', () => {
  const withSha = buildPutBody({ content: 'x', branch: 'main', sha: 'abc', message: 'm' });
  assert.equal(withSha.sha, 'abc');
  assert.equal(withSha.branch, 'main');
  assert.equal(withSha.message, 'm');
  assert.equal(Buffer.from(withSha.content, 'base64').toString('utf8'), 'x');

  const noSha = buildPutBody({ content: 'x', branch: 'main', sha: null, message: 'm' });
  assert.equal('sha' in noSha, false);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test test/github_commit.test.js`
Expected: FAIL with `Cannot find module '../src/github_commit'`.

- [ ] **Step 3: Implement `src/github_commit.js`**

Create `src/github_commit.js`:

```js
const logger = require('./utils/logger');

function githubContentsUrl(repo, filePath) {
  return 'https://api.github.com/repos/' + repo + '/contents/' + filePath;
}

function encodeContentBase64(content) {
  return Buffer.from(String(content), 'utf8').toString('base64');
}

function buildPutBody({ content, branch, sha, message }) {
  const body = {
    message,
    content: encodeContentBase64(content),
    branch
  };
  if (sha) body.sha = sha;
  return body;
}

// Commit a single file to the configured GitHub repo via the Contents API.
// Mirrors the inline flow in api/dashboard.js POST /prompts/:name so the apply
// path uses the same mechanism. Returns { committed, commit_sha?, html_url?,
// git_error? }. Throws only on an unexpected GitHub error after a token exists.
async function commitFileToGitHub({ filePath, content, message }) {
  const repo = process.env.GITHUB_REPO || 'sergeadaimy-hash/sunny-electrosun';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;
  const result = { committed: false };

  if (!token) {
    result.git_error = 'GITHUB_TOKEN env var is not set; change applies to this container only and will be lost on next git redeploy.';
    return result;
  }

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sunny-electrosun-admin'
  };
  const apiBase = githubContentsUrl(repo, filePath);

  const getRes = await fetch(apiBase + '?ref=' + encodeURIComponent(branch), { headers });
  let sha = null;
  if (getRes.ok) {
    const meta = await getRes.json();
    sha = meta.sha;
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    throw new Error('GitHub GET ' + getRes.status + ': ' + t.slice(0, 200));
  }

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPutBody({ content, branch, sha, message }))
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error('GitHub PUT ' + putRes.status + ': ' + t.slice(0, 300));
  }
  const putJson = await putRes.json();
  result.committed = true;
  result.commit_sha = putJson.commit && putJson.commit.sha;
  result.html_url = putJson.content && putJson.content.html_url;
  logger.info('github_commit.ok', { filePath, commit_sha: result.commit_sha });
  return result;
}

module.exports = { githubContentsUrl, encodeContentBase64, buildPutBody, commitFileToGitHub };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test test/github_commit.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/github_commit.js test/github_commit.test.js
git commit -m "feat(audit): reusable GitHub Contents API single-file commit helper"
```

---

## Task 3: audit_store (DB layer)

**Files:**
- Create: `src/audit_store.js`

- [ ] **Step 1: Implement `src/audit_store.js`**

Create `src/audit_store.js`:

```js
const { getDb } = require('../db/init');

const VALID_STATUS = ['pending', 'approved', 'rejected', 'applied'];

function createRun({ runDate, windowStart, windowEnd }) {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO audit_runs (run_date, window_start, window_end, status, created_at)
     VALUES (?, ?, ?, 'running', ?)`
  ).run(runDate, windowStart, windowEnd, ts);
  return info.lastInsertRowid;
}

function finishRun(id, { conversationsAudited, findingsCount, scorecard, status = 'done' }) {
  const db = getDb();
  db.prepare(
    `UPDATE audit_runs
     SET status = ?, conversations_audited = ?, findings_count = ?, scorecard = ?, finished_at = ?
     WHERE id = ?`
  ).run(
    status,
    conversationsAudited || 0,
    findingsCount || 0,
    scorecard ? JSON.stringify(scorecard) : null,
    new Date().toISOString(),
    id
  );
}

function failRun(id, errorMessage) {
  const db = getDb();
  db.prepare(
    `UPDATE audit_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?`
  ).run(String(errorMessage || '').slice(0, 500), new Date().toISOString(), id);
}

function insertFinding(finding) {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO audit_findings
       (run_id, conversation_id, contact_id, lane, finding_type, finding_text,
        proposed_change, cited_rule, cited_message, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    finding.run_id,
    finding.conversation_id || null,
    finding.contact_id || null,
    finding.lane,
    finding.finding_type || null,
    finding.finding_text,
    finding.proposed_change,
    finding.cited_rule || null,
    finding.cited_message || null,
    ts, ts
  );
  return info.lastInsertRowid;
}

function listRuns(limit = 30) {
  const db = getDb();
  return db.prepare(`SELECT * FROM audit_runs ORDER BY id DESC LIMIT ?`).all(limit);
}

function getRun(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM audit_runs WHERE id = ?`).get(id) || null;
}

function getFindingsForRun(runId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM audit_findings WHERE run_id = ? ORDER BY
       CASE lane WHEN 'skill_lesson' THEN 0 WHEN 'knowledge_fact' THEN 1 ELSE 2 END,
       id ASC`
  ).all(runId);
}

function getFinding(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM audit_findings WHERE id = ?`).get(id) || null;
}

function setFindingStatus(id, status, editedText) {
  if (!VALID_STATUS.includes(status)) throw new Error('invalid status: ' + status);
  const db = getDb();
  const ts = new Date().toISOString();
  if (typeof editedText === 'string') {
    db.prepare(
      `UPDATE audit_findings SET status = ?, edited_text = ?, updated_at = ? WHERE id = ?`
    ).run(status, editedText, ts, id);
  } else {
    db.prepare(
      `UPDATE audit_findings SET status = ?, updated_at = ? WHERE id = ?`
    ).run(status, ts, id);
  }
}

// Every skill-lesson that should appear in the live playbook: approved (awaiting
// apply) plus already-applied. Pending and rejected are excluded.
function getActiveSkillLessons() {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM audit_findings
     WHERE lane = 'skill_lesson' AND status IN ('approved', 'applied')
     ORDER BY id ASC`
  ).all();
}

function markApprovedSkillLessonsApplied() {
  const db = getDb();
  const ts = new Date().toISOString();
  const info = db.prepare(
    `UPDATE audit_findings SET status = 'applied', applied_at = ?, updated_at = ?
     WHERE lane = 'skill_lesson' AND status = 'approved'`
  ).run(ts, ts);
  return info.changes;
}

module.exports = {
  VALID_STATUS,
  createRun, finishRun, failRun,
  insertFinding, listRuns, getRun,
  getFindingsForRun, getFinding, setFindingStatus,
  getActiveSkillLessons, markApprovedSkillLessonsApplied
};
```

- [ ] **Step 2: Smoke-test the CRUD against the real DB**

Run:
```bash
node -e "
const s = require('./src/audit_store');
const runId = s.createRun({ runDate: '2026-06-15', windowStart: 'a', windowEnd: 'b' });
s.insertFinding({ run_id: runId, conversation_id: 1, contact_id: 1, lane: 'skill_lesson', finding_type: 'rule_violation', finding_text: 'asked a trailing question', proposed_change: 'after a short factual answer, acknowledge and stop', cited_rule: 'no trailing questions', cited_message: 'ok' });
s.finishRun(runId, { conversationsAudited: 1, findingsCount: 1 });
console.log('run:', s.getRun(runId));
console.log('findings:', s.getFindingsForRun(runId).length);
const fid = s.getFindingsForRun(runId)[0].id;
s.setFindingStatus(fid, 'approved');
console.log('active lessons:', s.getActiveSkillLessons().length);
console.log('applied:', s.markApprovedSkillLessonsApplied());
"
```
Expected: prints a run object with `status: 'done'`, `findings: 1`, `active lessons: 1`, `applied: 1`.

- [ ] **Step 3: Clean up the smoke-test rows**

Run:
```bash
node -e "const {getDb}=require('./db/init'); const db=getDb(); db.exec(\"DELETE FROM audit_findings; DELETE FROM audit_runs;\"); console.log('cleared');"
```
Expected: `cleared`.

- [ ] **Step 4: Commit**

```bash
git add src/audit_store.js
git commit -m "feat(audit): audit_runs and audit_findings store"
```

---

## Task 4: playbook builder and apply

**Files:**
- Create: `src/playbook.js`
- Create: `src/prompts/learned-playbook.md`
- Modify: `src/prompt_store.js` (line 6, the `ALLOWED` array)
- Test: `test/playbook.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/playbook.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test test/playbook.test.js`
Expected: FAIL with `Cannot find module '../src/playbook'`.

- [ ] **Step 3: Implement `src/playbook.js`**

Create `src/playbook.js`:

```js
const promptStore = require('./prompt_store');
const auditStore = require('./audit_store');
const { commitFileToGitHub } = require('./github_commit');
const logger = require('./utils/logger');

const PLAYBOOK_NAME = 'learned-playbook';
const PLAYBOOK_FILE_PATH = 'src/prompts/learned-playbook.md';

// Pure: render the playbook markdown from a list of lesson rows.
// Each lesson: { proposed_change, edited_text? }.
function buildPlaybookMarkdown(lessons) {
  const header = [
    '# Learned playbook (owner-approved lessons)',
    '',
    'These lessons were proposed by the nightly self-audit and approved by the Electro-Sun owner. Treat them as doctrine on top of the rules in system.md. Each one corrects a real mistake found in a past conversation. If two lessons conflict, the later (higher-numbered) one wins.',
    ''
  ];
  if (!lessons || !lessons.length) {
    return header.concat(['(No approved lessons yet.)', '']).join('\n');
  }
  const lines = header.slice();
  const seen = new Set();
  let n = 0;
  for (const l of lessons) {
    const raw = (l.edited_text != null && l.edited_text !== '') ? l.edited_text : l.proposed_change;
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
    lines.push(`${n}. ${text}`);
  }
  lines.push('');
  return lines.join('\n');
}

function getPlaybookText() {
  return promptStore.get(PLAYBOOK_NAME) || '';
}

// Rebuild from all active skill-lessons, write locally (cache-busts), commit to
// GitHub, then flip approved -> applied. Returns a summary.
async function rebuildAndCommitPlaybook() {
  const lessons = auditStore.getActiveSkillLessons();
  const content = buildPlaybookMarkdown(lessons);
  promptStore.write(PLAYBOOK_NAME, content);
  let commit = { committed: false };
  try {
    commit = await commitFileToGitHub({
      filePath: PLAYBOOK_FILE_PATH,
      content,
      message: 'audit: apply approved learned-playbook lessons'
    });
  } catch (err) {
    logger.warn('playbook.commit_fail', { message: err.message });
    commit = { committed: false, git_error: err.message };
  }
  const applied = auditStore.markApprovedSkillLessonsApplied();
  logger.info('playbook.rebuilt', { lessons: lessons.length, applied, committed: !!commit.committed });
  return { content_chars: content.length, lessons: lessons.length, applied, commit };
}

module.exports = {
  PLAYBOOK_NAME,
  PLAYBOOK_FILE_PATH,
  buildPlaybookMarkdown,
  getPlaybookText,
  rebuildAndCommitPlaybook
};
```

- [ ] **Step 4: Create the initial playbook file**

Create `src/prompts/learned-playbook.md` with this exact content:

```markdown
# Learned playbook (owner-approved lessons)

These lessons were proposed by the nightly self-audit and approved by the Electro-Sun owner. Treat them as doctrine on top of the rules in system.md. Each one corrects a real mistake found in a past conversation. If two lessons conflict, the later (higher-numbered) one wins.

(No approved lessons yet.)
```

- [ ] **Step 5: Register the two new prompt names in `src/prompt_store.js`**

In `src/prompt_store.js` line 6, change:

```js
const ALLOWED = ['system', 'classifier', 'owner_qa'];
```

to:

```js
const ALLOWED = ['system', 'classifier', 'owner_qa', 'audit', 'learned-playbook'];
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `node --test test/playbook.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Verify the playbook reads through prompt_store**

Run: `node -e "console.log(require('./src/playbook').getPlaybookText().slice(0,40))"`
Expected: prints `# Learned playbook (owner-approved less` (no `prompt_store.read_fail` warning).

- [ ] **Step 8: Commit**

```bash
git add src/playbook.js src/prompts/learned-playbook.md src/prompt_store.js test/playbook.test.js
git commit -m "feat(audit): learned playbook builder, file, and prompt_store registration"
```

---

## Task 5: audit pure helpers

**Files:**
- Create: `src/audit.js` (pure helpers only in this task; the engine is added in Task 6)
- Test: `test/audit.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/audit.test.js`:

```js
'use strict';
// Run with: node --test test/audit.test.js
const { test } = require('node:test');
const assert = require('node:assert');

const {
  isAuditableContact,
  summarizeSignals,
  parseAuditFindings,
  buildOwnerAuditPing,
} = require('../src/audit');

test('isAuditableContact excludes the owner and desk numbers', () => {
  const cfg = { ownerPhone: '2347041328055', deskPhones: ['09111880000', '+234 706 000 0000'] };
  assert.equal(isAuditableContact({ phone: '+9665023926 50' }, cfg), true);
  assert.equal(isAuditableContact({ phone: '2347041328055' }, cfg), false);
  assert.equal(isAuditableContact({ phone: '0911 188 0000' }, cfg), false);
  assert.equal(isAuditableContact({ phone: '' }, cfg), false);
  assert.equal(isAuditableContact(null, cfg), false);
});

test('summarizeSignals flags ended_silent when last message is from Sunny', () => {
  const s = summarizeSignals({
    conversation: { human_handled: 1 },
    contact: { lead_temperature: 'WARM' },
    pendingQueries: [{ status: 'pending' }, { status: 'resolved' }],
    messages: [{ direction: 'inbound', body: 'hi' }, { direction: 'outbound', body: 'hello' }]
  });
  assert.equal(s.human_handled, true);
  assert.equal(s.open_pending_count, 1);
  assert.equal(s.lead_temperature, 'WARM');
  assert.equal(s.ended_silent, true);
});

test('summarizeSignals: not silent when customer replied last', () => {
  const s = summarizeSignals({
    conversation: {}, contact: {}, pendingQueries: [],
    messages: [{ direction: 'outbound', body: 'x' }, { direction: 'inbound', body: 'y' }]
  });
  assert.equal(s.ended_silent, false);
  assert.equal(s.human_handled, false);
});

test('parseAuditFindings keeps valid lanes and drops junk', () => {
  const text = JSON.stringify({ findings: [
    { lane: 'skill_lesson', finding_text: 'stalled', proposed_change: 'answer directly', cited_rule: 'no stalls', cited_message: 'let me check' },
    { lane: 'bogus_lane', finding_text: 'x', proposed_change: 'y' },
    { lane: 'knowledge_fact', finding_text: 'no price', proposed_change: 'add Sungrow 5kW price' },
    { lane: 'skill_lesson', finding_text: 'missing fields' }
  ] });
  const out = parseAuditFindings(text, { runId: 7, conversationId: 3, contactId: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].lane, 'skill_lesson');
  assert.equal(out[0].run_id, 7);
  assert.equal(out[0].conversation_id, 3);
  assert.equal(out[1].lane, 'knowledge_fact');
});

test('parseAuditFindings returns [] on unparseable text', () => {
  assert.deepEqual(parseAuditFindings('not json', {}), []);
});

test('buildOwnerAuditPing returns null when nothing to review', () => {
  assert.equal(buildOwnerAuditPing({ id: 1 }, { total: 0 }), null);
});

test('buildOwnerAuditPing includes the deep link and counts', () => {
  const msg = buildOwnerAuditPing({ id: 42 }, { total: 3, skill_lesson: 2, knowledge_fact: 1, engineering_note: 0 });
  assert.match(msg, /3 proposals waiting/);
  assert.match(msg, /#audit=42/);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test test/audit.test.js`
Expected: FAIL with `Cannot find module '../src/audit'`.

- [ ] **Step 3: Create `src/audit.js` with the pure helpers and the requires the engine will need**

Create `src/audit.js`:

```js
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/init');
const promptStore = require('./prompt_store');
const logger = require('./utils/logger');
const { recordUsage, isOverBudget } = require('./cost_tracker');
const { formatWarehouseForPrompt } = require('./warehouse');
const { getPlaybookText } = require('./playbook');
const auditStore = require('./audit_store');
const { sendMessage } = require('./whatsapp');
const { getOrCreateContact, getActiveConversation, appendMessage } = require('./memory');

const MODEL_AUDIT = process.env.MODEL_AUDIT || 'claude-sonnet-4-6';
const AUDIT_MAX_CONVERSATIONS = parseInt(process.env.AUDIT_MAX_CONVERSATIONS || '60', 10);
const ADMIN_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://sunny-electrosun-production.up.railway.app').replace(/\/+$/, '');

const VALID_LANES = ['skill_lesson', 'knowledge_fact', 'engineering_note'];

const AnthropicCtor = Anthropic.Anthropic || Anthropic.default || Anthropic;
let _client = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function tryParseJson(text) {
  if (!text) return null;
  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function isAuditableContact(contact, { ownerPhone, deskPhones } = {}) {
  if (!contact || !contact.phone) return false;
  const p = digitsOnly(contact.phone);
  if (!p) return false;
  if (ownerPhone && p === digitsOnly(ownerPhone)) return false;
  const desks = Array.isArray(deskPhones) ? deskPhones : [];
  for (const d of desks) {
    if (d && p === digitsOnly(d)) return false;
  }
  return true;
}

function summarizeSignals({ conversation, contact, pendingQueries, messages } = {}) {
  const open = (pendingQueries || []).filter(q => q.status === 'pending' || q.status === 'expired');
  let endedSilent = false;
  if (messages && messages.length) {
    const last = messages[messages.length - 1];
    endedSilent = !!(last && last.direction === 'outbound');
  }
  return {
    human_handled: !!(conversation && conversation.human_handled),
    open_pending_count: open.length,
    lead_temperature: (contact && contact.lead_temperature) || null,
    ended_silent: endedSilent
  };
}

function buildAuditTranscript(messages, maxChars = 6000) {
  const lines = [];
  for (const m of messages || []) {
    const who = m.direction === 'inbound' ? 'Customer' : 'Sunny';
    const body = String(m.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!body) continue;
    lines.push(`[${who}] ${body}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n(transcript truncated)';
  return out;
}

function parseAuditFindings(text, ctx = {}) {
  const parsed = tryParseJson(text);
  if (!parsed) return [];
  const arr = Array.isArray(parsed.findings) ? parsed.findings : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const lane = String(f.lane || '').trim();
    if (!VALID_LANES.includes(lane)) continue;
    const findingText = String(f.finding_text || f.problem || '').trim();
    const proposed = String(f.proposed_change || f.lesson || f.fact || '').trim();
    if (!findingText || !proposed) continue;
    out.push({
      run_id: ctx.runId || null,
      conversation_id: ctx.conversationId || null,
      contact_id: ctx.contactId || null,
      lane,
      finding_type: (String(f.finding_type || f.type || '').trim().slice(0, 60)) || null,
      finding_text: findingText.slice(0, 1000),
      proposed_change: proposed.slice(0, 1000),
      cited_rule: (String(f.cited_rule || '').trim().slice(0, 300)) || null,
      cited_message: (String(f.cited_message || f.quote || '').trim().slice(0, 500)) || null
    });
    if (out.length >= 10) break;
  }
  return out;
}

function buildOwnerAuditPing(run, counts) {
  const total = counts.total || 0;
  if (total === 0) return null;
  const link = `${ADMIN_BASE_URL}/admin#audit=${run.id}`;
  return [
    `Nightly audit done. ${total} proposal${total === 1 ? '' : 's'} waiting.`,
    `Lessons: ${counts.skill_lesson || 0}, Facts: ${counts.knowledge_fact || 0}, Code notes: ${counts.engineering_note || 0}.`,
    `Review and approve: ${link}`
  ].join('\n');
}

module.exports = {
  MODEL_AUDIT,
  VALID_LANES,
  isAuditableContact,
  summarizeSignals,
  buildAuditTranscript,
  parseAuditFindings,
  buildOwnerAuditPing
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test test/audit.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/audit.js test/audit.test.js
git commit -m "feat(audit): pure helpers for contact filtering, signals, parsing, owner ping"
```

---

## Task 6: audit engine and prompt

**Files:**
- Create: `src/prompts/audit.md`
- Modify: `src/audit.js` (add the engine and export `runNightlyAudit`)

- [ ] **Step 1: Create the auditor prompt `src/prompts/audit.md`**

Create `src/prompts/audit.md`:

```markdown
# You are Sunny's nightly self-auditor

You review ONE past WhatsApp conversation between Sunny (the Electro-Sun sales agent, shown as "Sunny") and a customer ("Customer"). Your job is to find places where Sunny's replies did not match what he should have said, given his own rules and the stock he already had. You do not talk to the customer. You only produce findings.

You are given, in the system context above this message:
- Sunny's current rulebook (system.md).
- The current warehouse stock and prices.
- The existing learned playbook (lessons already approved). Do NOT re-propose anything already covered there.

You are given, in the user message: objective signals detected for this conversation, and the full transcript.

## What to check

1. Rule compliance. Did any Sunny reply break a rule in the rulebook? Examples: a trailing question after a short factual answer, quoting a price the customer did not ask for, using the customer's name instead of "Sir", leaking a wa.me link or an owner number, a first-person stall like "let me check and revert".
2. Knowledge application. Did Sunny fail to use something he already had? Examples: the price or stock was in the warehouse block but he stalled or deflected; a datasheet or location was available but he never gave it.
3. Outcome. If the signals say the owner took over, a query went unanswered, or the chat ended on a Sunny message with no customer reply, look at the last few Sunny turns and explain what likely lost the customer.

## Three lanes

Tag every finding with exactly one lane:
- skill_lesson: a generalizable rule that would make Sunny better next time. Write proposed_change as a short imperative rule, not a comment about this one chat. Example: "When the customer asks for the cheapest option, name the entry-level in-stock model by name instead of deflecting."
- knowledge_fact: a concrete business fact Sunny was missing (a price, a stock state, a policy). Write proposed_change as the fact to add. Do NOT invent the value; if the value is unknown, say what needs to be filled in.
- engineering_note: a code or guard problem the owner's developer should look at (for example, a garbled reply a guard should have caught). Write proposed_change as a short note to the developer.

## Output

Return ONLY valid JSON, no prose, no markdown fences:

{
  "findings": [
    {
      "lane": "skill_lesson",
      "finding_type": "knowledge_not_applied",
      "finding_text": "Customer asked the price of the 16kW; it was in stock with a price, but Sunny said he would check with the team.",
      "proposed_change": "When the customer asks the price of an item that is in the warehouse block with a price, quote that price directly instead of stalling.",
      "cited_rule": "Pricing discipline: quote from the warehouse block when asked",
      "cited_message": "let me confirm the figure with the team"
    }
  ]
}

## Hard rules

- Be conservative. Only raise a finding you can justify with a citation. If the conversation was handled correctly, return {"findings": []}.
- Every finding MUST include cited_rule (the rule or fact you checked against) and cited_message (a short exact quote from the transcript).
- Never invent a price, spec, or fact. For a missing price, the lane is knowledge_fact and proposed_change states what the owner must fill in.
- Never write em-dashes, en-dashes, or double-dashes. Use commas, periods, or parentheses.
- At most 10 findings for this conversation. Prefer the most important ones.
```

- [ ] **Step 2: Add the engine to `src/audit.js`**

In `src/audit.js`, insert the following functions immediately BEFORE the `module.exports = {` line:

```js
function deskPhonesFromEnv() {
  return [
    process.env.SALES_ABUJA_WHATSAPP,
    process.env.SALES_LAGOS_WHATSAPP,
    process.env.SPECIALIST_DIRECT_LINK
  ].filter(Boolean);
}

function selectConversationsInWindow(windowStart, windowEnd) {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT conv.id AS conversation_id, conv.contact_id, conv.human_handled,
           c.phone, c.name, c.lead_temperature
    FROM conversations conv
    JOIN messages m ON m.conversation_id = conv.id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE m.direction = 'inbound'
      AND m.timestamp >= ? AND m.timestamp < ?
    ORDER BY conv.id DESC
  `).all(windowStart, windowEnd);
}

function messagesForConversation(conversationId, limit = 60) {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, body, intent, timestamp
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(conversationId, limit);
}

function pendingQueriesForContact(contactId) {
  const db = getDb();
  return db.prepare(`SELECT id, status FROM pending_queries WHERE contact_id = ?`).all(contactId);
}

function buildRulesSystemBlocks() {
  const blocks = [
    { type: 'text', text: promptStore.get('audit'), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Sunny current rulebook (system.md):\n\n' + promptStore.get('system'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
  let wh = '';
  try { wh = formatWarehouseForPrompt(); } catch (err) {
    logger.warn('audit.warehouse_load_fail', { message: err.message });
  }
  if (wh) blocks.push({ type: 'text', text: 'Current warehouse stock and prices:\n\n' + wh, cache_control: { type: 'ephemeral', ttl: '1h' } });
  const pb = getPlaybookText();
  if (pb) blocks.push({ type: 'text', text: 'Existing learned playbook (already approved; do not re-propose these):\n\n' + pb, cache_control: { type: 'ephemeral', ttl: '1h' } });
  return blocks;
}

async function auditOneConversation(conv, runId, rulesSystemBlocks) {
  const messages = messagesForConversation(conv.conversation_id);
  if (!messages.length) return [];
  const contact = { phone: conv.phone, name: conv.name, lead_temperature: conv.lead_temperature };
  const pending = pendingQueriesForContact(conv.contact_id);
  const signals = summarizeSignals({ conversation: conv, contact, pendingQueries: pending, messages });
  const transcript = buildAuditTranscript(messages);
  const userBlock = [
    'Audit this single conversation.',
    '',
    'Signals detected (objective):',
    `- Owner took over: ${signals.human_handled ? 'YES' : 'no'}`,
    `- Open unanswered queries: ${signals.open_pending_count}`,
    `- Lead temperature: ${signals.lead_temperature || 'unknown'}`,
    `- Ended on a Sunny message with no customer reply: ${signals.ended_silent ? 'YES' : 'no'}`,
    '',
    'Transcript:',
    transcript,
    '',
    'Return JSON now.'
  ].join('\n');

  const resp = await client().messages.create({
    model: MODEL_AUDIT,
    max_tokens: 1200,
    system: rulesSystemBlocks,
    messages: [{ role: 'user', content: userBlock }]
  });
  if (resp.usage) recordUsage(MODEL_AUDIT, resp.usage, 'audit');
  const text = resp.content?.[0]?.text || '';
  return parseAuditFindings(text, { runId, conversationId: conv.conversation_id, contactId: conv.contact_id });
}

async function sendOwnerAuditPing(runId, counts) {
  const ownerPhone = process.env.OWNER_WHATSAPP;
  if (!ownerPhone) return;
  const run = auditStore.getRun(runId);
  const text = buildOwnerAuditPing(run, counts);
  if (!text) return;
  try {
    const sendRes = await sendMessage(ownerPhone, text);
    const ownerContact = getOrCreateContact(ownerPhone, null);
    const ownerConv = getActiveConversation(ownerContact.id);
    appendMessage(ownerConv.id, 'outbound', text, {
      whatsapp_message_id: sendRes && sendRes.messageId,
      intent: 'audit_summary_ping',
      language: 'english'
    });
  } catch (err) {
    logger.warn('audit.owner_ping_fail', { message: err.message });
  }
}

async function runNightlyAudit({ windowHours = 24, nowIso } = {}) {
  const end = nowIso || new Date().toISOString();
  const start = new Date(new Date(end).getTime() - windowHours * 3600 * 1000).toISOString();
  const runDate = end.slice(0, 10);

  if (isOverBudget()) {
    logger.warn('audit.budget_exceeded_skip');
    return { skipped: true, reason: 'over_budget' };
  }

  const runId = auditStore.createRun({ runDate, windowStart: start, windowEnd: end });
  const counts = { skill_lesson: 0, knowledge_fact: 0, engineering_note: 0, total: 0 };
  let audited = 0;
  try {
    const ownerPhone = process.env.OWNER_WHATSAPP;
    const deskPhones = deskPhonesFromEnv();
    const all = selectConversationsInWindow(start, end);
    const targets = all
      .filter(conv => isAuditableContact({ phone: conv.phone }, { ownerPhone, deskPhones }))
      .slice(0, AUDIT_MAX_CONVERSATIONS);

    const rulesBlocks = buildRulesSystemBlocks();

    for (const conv of targets) {
      if (isOverBudget()) { logger.warn('audit.budget_exceeded_midrun'); break; }
      try {
        const findings = await auditOneConversation(conv, runId, rulesBlocks);
        for (const f of findings) {
          auditStore.insertFinding(f);
          counts[f.lane] = (counts[f.lane] || 0) + 1;
          counts.total += 1;
        }
      } catch (err) {
        logger.warn('audit.conversation_fail', { conversation_id: conv.conversation_id, message: err.message });
      }
      audited += 1;
    }

    auditStore.finishRun(runId, { conversationsAudited: audited, findingsCount: counts.total, scorecard: null });
    await sendOwnerAuditPing(runId, counts);
    logger.info('audit.done', { runId, audited, findings: counts.total });
    return { runId, audited, findings: counts.total, counts };
  } catch (err) {
    auditStore.failRun(runId, err.message);
    logger.error('audit.run_fail', { runId, message: err.message });
    return { runId, error: err.message };
  }
}
```

- [ ] **Step 3: Add `runNightlyAudit` to the exports of `src/audit.js`**

Change the `module.exports` block at the end of `src/audit.js` to:

```js
module.exports = {
  MODEL_AUDIT,
  VALID_LANES,
  isAuditableContact,
  summarizeSignals,
  buildAuditTranscript,
  parseAuditFindings,
  buildOwnerAuditPing,
  runNightlyAudit
};
```

- [ ] **Step 4: Re-run the unit tests to confirm nothing broke**

Run: `node --test test/audit.test.js`
Expected: PASS, 7 tests (the engine additions do not change the pure helpers).

- [ ] **Step 5: Smoke-test the engine wiring without calling the model**

This confirms the module loads, the SQL parses, and selection runs against the real DB. It does NOT call Anthropic (we pass a window in the far past so zero conversations match, so no model call and no owner ping fire).

Run:
```bash
node -e "
const a = require('./src/audit');
a.runNightlyAudit({ windowHours: 1, nowIso: '2000-01-01T00:00:00.000Z' })
  .then(r => { console.log('result:', r); })
  .catch(e => { console.error('ERROR', e); process.exit(1); });
"
```
Expected: `result: { runId: <n>, audited: 0, findings: 0, counts: {...} }`. No Anthropic call, no error.

- [ ] **Step 6: Clean up the smoke-test run row**

Run:
```bash
node -e "const {getDb}=require('./db/init'); const db=getDb(); db.exec('DELETE FROM audit_runs WHERE conversations_audited = 0'); console.log('cleared empty runs');"
```
Expected: `cleared empty runs`.

- [ ] **Step 7: Commit**

```bash
git add src/audit.js src/prompts/audit.md
git commit -m "feat(audit): nightly audit engine and auditor prompt"
```

---

## Task 7: Inject the playbook into replies

**Files:**
- Modify: `src/claude.js` (the `generateReply` system-block assembly, around line 546-548)

- [ ] **Step 1: Add the playbook require near the other requires at the top of `src/claude.js`**

Find the existing `const { recordUsage, isOverBudget } = require('./cost_tracker');` line (`src/claude.js:5`) and add directly after it:

```js
const { getPlaybookText } = require('./playbook');
```

- [ ] **Step 2: Inject the playbook block right after the system prompt block**

In `src/claude.js`, find this exact block (around line 546-548):

```js
  const systemBlocks = [
    { type: 'text', text: promptStore.get('system'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
```

Insert immediately after it:

```js
  try {
    const playbookText = getPlaybookText();
    if (playbookText && playbookText.trim() && !/No approved lessons yet/.test(playbookText)) {
      systemBlocks.push({ type: 'text', text: playbookText, cache_control: { type: 'ephemeral', ttl: '1h' } });
      logger.info('claude.reply.playbook_injected', { contactId: contact?.id, chars: playbookText.length });
    }
  } catch (err) {
    logger.warn('claude.reply.playbook_load_fail', { message: err.message });
  }
```

(The `No approved lessons yet` guard keeps the empty starter file from adding a useless block and burning a cache slot.)

- [ ] **Step 3: Verify the module still loads and the function is intact**

Run: `node -e "const c = require('./src/claude'); console.log(typeof c.generateReply)"`
Expected: `function`.

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: all suites pass (existing matcher and reply-guard suites plus the three new audit suites).

- [ ] **Step 5: Commit**

```bash
git add src/claude.js
git commit -m "feat(audit): inject learned playbook into reply prompt"
```

---

## Task 8: Audit API endpoints

**Files:**
- Modify: `api/dashboard.js` (add requires near the other `../src` requires around line 40, and add four routes)

- [ ] **Step 1: Add the requires**

In `api/dashboard.js`, after the line `const promptStore = require('../src/prompt_store');` (`api/dashboard.js:40`), add:

```js
const auditStore = require('../src/audit_store');
const { rebuildAndCommitPlaybook } = require('../src/playbook');
```

- [ ] **Step 2: Add the four routes**

Add these routes in `api/dashboard.js` directly before the `GET /brain` route (around `api/dashboard.js:779`). They are admin-only automatically (the master key passes the middleware; the inbox role is not on the `INBOX_ALLOWED` whitelist, so it gets 403).

```js
// ---- Nightly self-improvement audit (admin-only) ----

router.get('/audit/runs', (req, res) => {
  try {
    res.json({ runs: auditStore.listRuns(parseInt32(req.query.limit, 30)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit/runs/:id', (req, res) => {
  try {
    const id = parseInt32(req.params.id, 0);
    const run = auditStore.getRun(id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json({ run, findings: auditStore.getFindingsForRun(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/audit/findings/:id/status', (req, res) => {
  const id = parseInt32(req.params.id, 0);
  const status = String(req.body?.status || '').trim();
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved|rejected|pending' });
  }
  const editedText = typeof req.body?.edited_text === 'string' ? req.body.edited_text : undefined;
  try {
    auditStore.setFindingStatus(id, status, editedText);
    res.json({ ok: true, id, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/audit/apply', async (req, res) => {
  try {
    const result = await rebuildAndCommitPlaybook();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the dashboard router still loads**

Run: `node -e "require('./api/dashboard'); console.log('dashboard ok')"`
Expected: `dashboard ok` (no throw).

- [ ] **Step 4: Manual endpoint smoke test (server running locally)**

Start the server in one terminal (`npm start`), then in another run (replace `YOUR_API_KEY` with the local `API_KEY` from `.env`):

```bash
curl -s -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/audit/runs
```
Expected: `{"runs":[]}` (or any existing runs). A call with no key returns `{"error":"invalid api key"}` with HTTP 401.

- [ ] **Step 5: Commit**

```bash
git add api/dashboard.js
git commit -m "feat(audit): admin API endpoints for runs, findings, and apply"
```

---

## Task 9: Admin "Nightly Audit" tab

**Files:**
- Modify: `public/admin.html` (nav bar ~line 1838, a new `<section>` under `<main>`, a `<style>` addition, and the JS near the other load functions and the boot block)

- [ ] **Step 1: Add the nav button**

In `public/admin.html`, change the nav block (`public/admin.html:1838-1844`) to add the Nightly Audit button:

```html
      <nav class="nav-tabs" id="nav-tabs">
        <button class="active" data-view="view-inbox">Inbox</button>
        <button data-view="view-contacts">Contacts</button>
        <button data-view="view-owner">Owner Chat</button>
        <button data-view="view-warehouse">Warehouse Stock</button>
        <button data-view="view-knowledge">Knowledge</button>
        <button data-view="view-audit">Nightly Audit</button>
      </nav>
```

- [ ] **Step 2: Add the section markup**

In `public/admin.html`, add this section under `<main>`, directly after the `view-knowledge` section's closing `</section>` (search for `id="view-knowledge"` to find it):

```html
      <section id="view-audit" class="view">
        <div class="audit-wrap">
          <div class="audit-sidebar">
            <h3>Audit runs</h3>
            <div id="audit-runs"><div class="wh-empty">Loading...</div></div>
          </div>
          <div class="audit-main">
            <div id="audit-findings"><div class="wh-empty">Select a run.</div></div>
          </div>
        </div>
      </section>
```

- [ ] **Step 3: Add the CSS**

In `public/admin.html`, add this inside the existing `<style>` block (anywhere before `</style>`):

```css
.audit-wrap { display: flex; gap: 16px; padding: 16px; }
.audit-sidebar { width: 200px; flex: 0 0 auto; }
.audit-sidebar h3 { margin: 0 0 8px; font-size: 13px; color: #555; }
.audit-main { flex: 1 1 auto; min-width: 0; }
.audit-run-btn { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px; border: 1px solid #ddd; background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; }
.audit-run-btn.active { background: #DCF8C6; border-color: #25D366; }
.audit-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #fff; }
.audit-card.status-approved { border-left: 4px solid #25D366; }
.audit-card.status-rejected { border-left: 4px solid #c0392b; opacity: 0.6; }
.audit-card.status-applied { border-left: 4px solid #888; }
.audit-lane { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 6px; }
.audit-problem, .audit-proposed, .audit-rule, .audit-quote { font-size: 13px; margin-bottom: 6px; line-height: 1.4; }
.audit-edit { background: #f6f6f6; padding: 2px 4px; border-radius: 4px; display: inline-block; min-width: 60px; }
.audit-actions { margin-top: 8px; }
.audit-actions button, .audit-apply-bar button { padding: 6px 12px; margin-right: 8px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; font-size: 13px; }
.audit-approve { background: #DCF8C6; }
.audit-reject { background: #fde0dc; }
.audit-apply-bar { margin-top: 16px; padding-top: 12px; border-top: 1px solid #eee; }
#audit-apply-btn { background: #25D366; color: #fff; border-color: #25D366; font-weight: 600; }
```

- [ ] **Step 4: Add the JS**

In `public/admin.html`, add this block near the other `loadX` functions (for example right after the `loadWarehouse` / `renderWarehouse` functions, around `public/admin.html:3046`):

```javascript
// ---- Nightly Audit tab ----
let auditLoaded = false;
let auditRuns = [];
let currentAuditRunId = null;

async function loadAudit() {
  try {
    const data = await apiFetch('/audit/runs?limit=30');
    auditRuns = data.runs || [];
    auditLoaded = true;
    renderAuditRuns();
    if (currentAuditRunId) {
      loadAuditRun(currentAuditRunId);
    } else if (auditRuns.length) {
      loadAuditRun(auditRuns[0].id);
    } else {
      document.getElementById('audit-findings').innerHTML = '<div class="wh-empty">No audit runs yet.</div>';
    }
  } catch (err) {
    document.getElementById('audit-runs').innerHTML = '<div class="wh-empty">Error: ' + escapeHtml(err.message) + '</div>';
  }
}

function renderAuditRuns() {
  const root = document.getElementById('audit-runs');
  if (!auditRuns.length) {
    root.innerHTML = '<div class="wh-empty">No runs.</div>';
    return;
  }
  root.innerHTML = auditRuns.map(r =>
    '<button class="audit-run-btn' + (r.id === currentAuditRunId ? ' active' : '') + '" data-run="' + r.id + '">' +
    escapeHtml(r.run_date || ('run ' + r.id)) + ' (' + (r.findings_count || 0) + ')' +
    '</button>'
  ).join('');
  root.querySelectorAll('.audit-run-btn').forEach(b => {
    b.addEventListener('click', () => loadAuditRun(parseInt(b.dataset.run, 10)));
  });
}

async function loadAuditRun(runId) {
  currentAuditRunId = runId;
  renderAuditRuns();
  const root = document.getElementById('audit-findings');
  root.innerHTML = '<div class="wh-empty">Loading...</div>';
  try {
    const data = await apiFetch('/audit/runs/' + runId);
    renderAuditFindings(data.run, data.findings || []);
  } catch (err) {
    root.innerHTML = '<div class="wh-empty">Error: ' + escapeHtml(err.message) + '</div>';
  }
}

function renderAuditFindings(run, findings) {
  const root = document.getElementById('audit-findings');
  if (!findings.length) {
    root.innerHTML = '<div class="wh-empty">No proposals in this run.</div>';
    return;
  }
  const laneLabel = { skill_lesson: 'Skill lesson', knowledge_fact: 'Knowledge fact', engineering_note: 'Code note' };
  const blocks = findings.map(f => {
    const text = (f.edited_text != null && f.edited_text !== '') ? f.edited_text : f.proposed_change;
    const convLink = f.conversation_id ? '<a href="#conv=' + f.conversation_id + '">open chat</a>' : '';
    return '' +
      '<div class="audit-card status-' + escapeHtml(f.status) + '" data-id="' + f.id + '">' +
      '<div class="audit-lane">' + escapeHtml(laneLabel[f.lane] || f.lane) + ' &middot; ' + escapeHtml(f.status) + '</div>' +
      '<div class="audit-problem"><b>Problem:</b> ' + escapeHtml(f.finding_text) + '</div>' +
      '<div class="audit-proposed"><b>Proposed:</b> <span contenteditable="true" class="audit-edit">' + escapeHtml(text) + '</span></div>' +
      (f.cited_rule ? '<div class="audit-rule"><b>Checked vs:</b> ' + escapeHtml(f.cited_rule) + '</div>' : '') +
      (f.cited_message ? '<div class="audit-quote"><b>Message:</b> "' + escapeHtml(f.cited_message) + '" ' + convLink + '</div>' : (convLink ? '<div class="audit-quote">' + convLink + '</div>' : '')) +
      '<div class="audit-actions">' +
      '<button class="audit-approve" data-id="' + f.id + '">Approve</button>' +
      '<button class="audit-reject" data-id="' + f.id + '">Reject</button>' +
      '</div></div>';
  });
  blocks.push('<div class="audit-apply-bar"><button id="audit-apply-btn">Apply approved (push live)</button></div>');
  root.innerHTML = blocks.join('');
  root.querySelectorAll('.audit-approve').forEach(b => b.addEventListener('click', () => setAuditStatus(b.dataset.id, 'approved', b)));
  root.querySelectorAll('.audit-reject').forEach(b => b.addEventListener('click', () => setAuditStatus(b.dataset.id, 'rejected', b)));
  document.getElementById('audit-apply-btn').addEventListener('click', applyApprovedAudit);
}

async function setAuditStatus(id, status, btn) {
  const card = btn.closest('.audit-card');
  const editEl = card ? card.querySelector('.audit-edit') : null;
  const body = { status };
  if (status === 'approved' && editEl) body.edited_text = editEl.textContent.trim();
  try {
    await apiFetch('/audit/findings/' + id + '/status', { method: 'POST', body: JSON.stringify(body) });
    loadAuditRun(currentAuditRunId);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function applyApprovedAudit() {
  const btn = document.getElementById('audit-apply-btn');
  btn.disabled = true;
  btn.textContent = 'Applying...';
  try {
    const res = await apiFetch('/audit/apply', { method: 'POST', body: '{}' });
    const pushed = res.commit && res.commit.committed;
    alert('Applied ' + (res.applied || 0) + ' lessons. ' + (pushed ? 'Pushed to GitHub; Railway will redeploy.' : 'Saved on this server only (no GitHub token).'));
    loadAuditRun(currentAuditRunId);
  } catch (err) {
    alert('Apply failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply approved (push live)';
  }
}

function parseAuditIdFromHash() {
  const h = String(window.location.hash || '');
  const m = h.match(/(?:^|[#&])audit=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function openAuditFromHashIfAny() {
  const id = parseAuditIdFromHash();
  if (id) {
    currentAuditRunId = id;
    switchView('view-audit');
    loadAudit();
  }
}

window.addEventListener('hashchange', openAuditFromHashIfAny);
```

- [ ] **Step 5: Wire the tab into `switchView`**

In `public/admin.html`, inside the `switchView` function (`public/admin.html:2150-2170`), add this branch alongside the other view branches:

```javascript
  if (viewId === 'view-audit' && !auditLoaded) {
    loadAudit();
  }
```

- [ ] **Step 6: Call the audit deep-link parser on boot**

In `public/admin.html`, in the boot block where `openConvFromHashIfAny()` is called after the first `refreshAll()` (`public/admin.html:3709-3712`), add `openAuditFromHashIfAny();` right after `openConvFromHashIfAny();`:

```javascript
  refreshAll().then(() => {
    refreshTimer = setInterval(refreshAll, 15000);
    openConvFromHashIfAny();
    openAuditFromHashIfAny();
  }).catch(() => {
    showLogin();
  });
```

- [ ] **Step 7: Manual UI verification**

With the server running and at least one audit run present (use Task 11 to generate one, or insert a test row), open `http://localhost:3000/admin`, log in with the master API key, and click the "Nightly Audit" tab.
Expected: the runs list loads on the left, clicking a run shows its findings on the right with Approve / Edit / Reject and an "Apply approved" button. Logging in with the inbox key (if configured) must NOT show the Nightly Audit tab at all.

- [ ] **Step 8: Commit**

```bash
git add public/admin.html
git commit -m "feat(audit): admin Nightly Audit review tab"
```

---

## Task 10: Register the gated nightly cron

**Files:**
- Modify: `server.js` (require near line 12-20, cron registration near line 207, inside the `if (require.main === module)` block)
- Modify: `.env.example`

- [ ] **Step 1: Add the require**

In `server.js`, after the line `const { runWindowScan } = require('./src/window_monitor');` (`server.js:20`), add:

```js
const { runNightlyAudit } = require('./src/audit');
```

- [ ] **Step 2: Register the cron, gated by its own flag**

In `server.js`, immediately AFTER the window-scan registration line `logger.info('cron.window_scan.registered', ...)` (`server.js:207`) and BEFORE the `if (notificationsDisabled()) {` report block, add:

```js
  // Nightly self-improvement audit (2026-06-15). Gated by its OWN flag so it can
  // run even while DISABLE_NOTIFICATIONS=true (which silences the legacy reports).
  // Default OFF until soaked.
  if (String(process.env.ENABLE_NIGHTLY_AUDIT || '').toLowerCase() === 'true') {
    cron.schedule('0 21 * * *', async () => {
      try {
        logger.info('cron.nightly_audit.start');
        const res = await runNightlyAudit({ windowHours: 24 });
        logger.info('cron.nightly_audit.done', res);
      } catch (err) {
        logger.error('cron.nightly_audit.error', { message: err.message });
      }
    }, { timezone: 'Africa/Lagos' });
    logger.info('cron.nightly_audit.registered', { interval: '0 21 * * *', tz: 'Africa/Lagos' });
  } else {
    logger.info('cron.nightly_audit.disabled', { reason: 'ENABLE_NIGHTLY_AUDIT not true' });
  }
```

- [ ] **Step 3: Document the env vars in `.env.example`**

Append to `.env.example`:

```
# Nightly self-improvement audit (Phase 1). Off by default.
ENABLE_NIGHTLY_AUDIT=false
# Audit model (cheap; must be a prefix the cost tracker knows: claude-sonnet-4-6).
MODEL_AUDIT=claude-sonnet-4-6
# Max conversations audited per nightly run (cost guard).
AUDIT_MAX_CONVERSATIONS=60
```

- [ ] **Step 4: Verify the server boots and logs the cron decision**

Run: `node -e "process.env.ENABLE_NIGHTLY_AUDIT='false'; require('./server'); setTimeout(()=>process.exit(0), 500);"`
Expected: among the boot logs, a `cron.nightly_audit.disabled` line. (Re-running with `ENABLE_NIGHTLY_AUDIT='true'` would instead log `cron.nightly_audit.registered`.) Stop the process if it keeps the port open.

- [ ] **Step 5: Commit**

```bash
git add server.js .env.example
git commit -m "feat(audit): gated nightly cron at 21:00 Africa/Lagos"
```

---

## Task 11: End-to-end verification on real data

This task runs the whole loop once, by hand, against the local DB. It calls Anthropic, so it costs a few cents. It does not enable the cron.

- [ ] **Step 1: Confirm prerequisites**

Confirm `.env` has `ANTHROPIC_API_KEY` set and the local DB has at least one customer conversation with inbound messages in the last 24h. If the local DB is empty, this step will report `audited: 0`, which still proves the pipeline runs without error; the real validation happens against production data after deploy.

- [ ] **Step 2: Run one audit pass manually**

Run:
```bash
node -e "
require('dotenv').config();
require('./src/audit').runNightlyAudit({ windowHours: 24 })
  .then(r => { console.log('AUDIT RESULT:', JSON.stringify(r)); process.exit(0); })
  .catch(e => { console.error('ERROR', e); process.exit(1); });
"
```
Expected: `AUDIT RESULT: {"runId":<n>,"audited":<k>,"findings":<m>,"counts":{...}}`. If `OWNER_WHATSAPP` is set and findings were produced, an owner WhatsApp ping is sent (this is real; only run when that is acceptable, or temporarily comment the owner number for the test).

- [ ] **Step 3: Inspect the findings in the DB**

Run:
```bash
node -e "const {getDb}=require('./db/init'); const db=getDb(); console.log(db.prepare('SELECT id, lane, finding_type, substr(finding_text,1,60) AS problem, status FROM audit_findings ORDER BY id DESC LIMIT 10').all());"
```
Expected: rows with sensible `lane` and `problem` values, all `status: 'pending'`.

- [ ] **Step 4: Verify the review and apply loop via the API (server running)**

Start `npm start`, then with the master key:

```bash
# list runs
curl -s -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/audit/runs
# view the latest run's findings (use the run id from above)
curl -s -H "X-API-Key: YOUR_API_KEY" http://localhost:3000/api/audit/runs/RUN_ID
# approve one skill_lesson finding (use a real finding id)
curl -s -X POST -H "X-API-Key: YOUR_API_KEY" -H "Content-Type: application/json" -d '{"status":"approved"}' http://localhost:3000/api/audit/findings/FINDING_ID/status
# apply approved (rebuilds the playbook file; commits only if GITHUB_TOKEN is set)
curl -s -X POST -H "X-API-Key: YOUR_API_KEY" -H "Content-Type: application/json" -d '{}' http://localhost:3000/api/audit/apply
```
Expected: the apply response is `{"ok":true,"content_chars":...,"lessons":N,"applied":N,"commit":{...}}`, and the approved finding flips to `applied`.

- [ ] **Step 5: Confirm the playbook now injects into replies**

Run:
```bash
node -e "console.log(require('./src/playbook').getPlaybookText())"
```
Expected: the approved lesson appears as a numbered item (no longer the empty starter text). On the next customer reply, `claude.js` logs `claude.reply.playbook_injected`.

- [ ] **Step 6: Reset local test state if desired**

If this was only a local dry run, optionally clear the test rows so they do not confuse the first real run:
```bash
node -e "const {getDb}=require('./db/init'); const db=getDb(); db.exec('DELETE FROM audit_findings; DELETE FROM audit_runs;'); console.log('cleared');"
```
Then restore the empty playbook file content (the starter text) and commit if it changed.

---

## Task 12: Update project memory and docs

Per the standing project rule (update CLAUDE.md and session history after every meaningful change; do not auto-push).

- [ ] **Step 1: Add a session-history entry**

In `docs/session-history.md`, add a dated entry (newest first) summarizing Phase 1: the nightly audit (`src/audit.js`), the two tables, the playbook (`src/playbook.js` + `src/prompts/learned-playbook.md`), the reusable GitHub commit helper (`src/github_commit.js`), the four `/api/audit/*` endpoints, the admin Nightly Audit tab, and the `ENABLE_NIGHTLY_AUDIT` gated cron. Note it is OFF by default and Phase 2 and 3 are pending.

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, add the new env vars (`ENABLE_NIGHTLY_AUDIT`, `MODEL_AUDIT`, `AUDIT_MAX_CONVERSATIONS`) to the kill-switches table, add `src/audit.js`, `src/audit_store.js`, `src/playbook.js`, `src/github_commit.js` to the code-modules table, add the `audit_runs` and `audit_findings` tables to the schema section, and add the Nightly Audit tab to the Admin UI section. Note the playbook injection as a new system block in the reply pipeline.

- [ ] **Step 3: Run the full suite one last time**

Run: `npm test`
Expected: all suites green (matcher, reply_guards, github_commit, playbook, audit).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/session-history.md docs/superpowers/
git commit -m "docs(audit): record Phase 1 nightly self-improvement loop"
```

---

## Deployment notes (for the human, after the plan is built and reviewed)

- Set the new env vars on Railway when ready to go live: `ENABLE_NIGHTLY_AUDIT=true`, `MODEL_AUDIT=claude-sonnet-4-6`, and optionally `AUDIT_MAX_CONVERSATIONS`. `GITHUB_TOKEN` must already be set for the Apply-approved push to commit (it is the same token the Rules editor uses).
- The owner must have an open 24h WhatsApp window for the nightly ping to arrive in the main chat, the same constraint as the existing owner alerts.
- Keep `ENABLE_NIGHTLY_AUDIT=false` until a manual `runNightlyAudit` dry run on production data looks right.
- Phase 2 (knowledge-fact routing to Warehouse and system.md, lesson graduation, did-it-work recheck, merge, regression watch, weekly scorecard) and Phase 3 (guard-trip log signals) are separate plans.

---

## Self-review notes

- Spec coverage: nightly 21:00 cron (Task 10), four checks via the auditor prompt (Task 6, checks 1 to 3; check 4 pattern-mining is Phase 2 per the spec), citation requirement (audit.md hard rules + `cited_rule`/`cited_message` columns), three lanes (Task 5 `VALID_LANES`, Task 9 labels), approve on phone (Task 9), batched apply with one push (Task 4 `rebuildAndCommitPlaybook` + Task 8 `/audit/apply`), playbook injection (Task 7), owner ping with deep link (Task 6 `sendOwnerAuditPing` + Task 5 `buildOwnerAuditPing`), admin-only gating (Task 8 relies on the default-admin middleware), dedicated enable flag (Task 10), Sonnet model (Task 5/6 `MODEL_AUDIT`), cost guard via `isOverBudget` and `AUDIT_MAX_CONVERSATIONS` (Task 6). Knowledge-fact APPLY routing to Warehouse/system.md is intentionally Phase 2; in Phase 1 knowledge_fact and engineering_note findings are captured and reviewable but only skill_lesson findings flow to the playbook on apply.
- Placeholder scan: no TBD/TODO; every code step shows complete code; every command shows expected output.
- Type/name consistency: `runNightlyAudit`, `rebuildAndCommitPlaybook`, `getPlaybookText`, `getActiveSkillLessons`, `markApprovedSkillLessonsApplied`, `setFindingStatus`, `buildOwnerAuditPing`, `parseAuditFindings`, `isAuditableContact`, `commitFileToGitHub` are used consistently across tasks and match their definitions.
