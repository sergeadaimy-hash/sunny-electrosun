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

// Build the playbook Sunny reads straight from the database (Option A,
// 2026-06-26). The approved/applied skill-lessons live in audit_findings on the
// Railway persistent volume, so they survive every restart with no GitHub token
// needed. An approved lesson is therefore live on the very next reply. If the DB
// read ever throws, fall back to the on-disk file so a transient DB hiccup can
// never blank the playbook.
function getPlaybookText() {
  try {
    const lessons = auditStore.getActiveSkillLessons();
    return buildPlaybookMarkdown(lessons);
  } catch (err) {
    logger.warn('playbook.db_read_fail_fallback_file', { message: err.message });
    return promptStore.get(PLAYBOOK_NAME) || '';
  }
}

// Rebuild from all active skill-lessons, write locally (cache-busts), commit to
// GitHub, then flip approved -> applied. Returns a summary.
async function rebuildAndCommitPlaybookCore() {
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

// Serialize rebuilds: approve-per-group can fire several /audit/approve calls
// close together, and each does a GET-sha-then-PUT GitHub commit. Overlapping
// commits race on the same file (stale sha -> 409 -> a lost lesson on the next
// redeploy). Chaining guarantees one rebuild+commit completes before the next
// starts, so every approved lesson lands in git.
let _rebuildChain = Promise.resolve();
function rebuildAndCommitPlaybook() {
  const next = _rebuildChain.then(rebuildAndCommitPlaybookCore, rebuildAndCommitPlaybookCore);
  // Keep the chain alive even if a run rejects, but do not let the chain's
  // stored promise reject unhandled.
  _rebuildChain = next.catch(() => {});
  return next;
}

module.exports = {
  PLAYBOOK_NAME,
  PLAYBOOK_FILE_PATH,
  buildPlaybookMarkdown,
  getPlaybookText,
  rebuildAndCommitPlaybook
};
