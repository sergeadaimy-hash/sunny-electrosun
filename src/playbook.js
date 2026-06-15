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
