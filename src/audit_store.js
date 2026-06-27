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

// Owner-confirmed general facts that should appear in the facts block Sunny reads.
// Approved or applied, lane knowledge_fact, EXCLUDING price findings (those live in
// Warehouse Stock only, never in the injected facts block). Approved alone makes a
// fact live; no separate apply step is needed.
function getActiveKnowledgeFacts() {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM audit_findings
     WHERE lane = 'knowledge_fact'
       AND status IN ('approved', 'applied')
       AND COALESCE(finding_type, '') != 'missing_price_fact'
     ORDER BY id ASC`
  ).all();
}

// Reclassify a finding's type. Used by the approve safety net to retag a
// price-looking general fact as 'missing_price_fact' so it is routed to Warehouse
// Stock instead of being injected as a fact.
function setFindingType(id, findingType) {
  const db = getDb();
  db.prepare(
    `UPDATE audit_findings SET finding_type = ?, updated_at = ? WHERE id = ?`
  ).run(findingType || null, new Date().toISOString(), id);
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
  getActiveSkillLessons, markApprovedSkillLessonsApplied,
  getActiveKnowledgeFacts, setFindingType
};
