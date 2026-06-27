# Design: approved audit lessons persist by reading from the database

Date: 2026-06-26
Owner decision: "Option A" (read lessons from the database; no GitHub token needed).
Scope chosen: "Behavior lessons, done right" (the foundation fix only; facts and code-notes are out of scope for this change).

## Problem

When the owner approves a nightly-audit skill-lesson, it is written into the text file
`src/prompts/learned-playbook.md` and that file is what Sunny reads on every reply.
That file is rebuilt from GitHub on every container restart (Railway redeploy). If
`GITHUB_TOKEN` is not set on Railway (or the commit fails), the lesson exists only in the
running container's copy of the file and is wiped on the next restart, while the DB and the
admin panel still report it as "applied". Net effect: approved lessons can silently
disappear and Sunny stops obeying them.

Evidence: the committed `learned-playbook.md` in git is still "(No approved lessons yet.)"
with only its initial commit, despite the feature being live since 2026-06-15.

## Root cause

The thing Sunny reads (the playbook file) is ephemeral, but the real source of truth (the
`audit_findings` table, status `approved`/`applied`) already lives in the SQLite DB on the
Railway persistent volume (`/data/sunny.db`), which survives every restart.

## Decision (Option A)

`getPlaybookText()` builds the playbook markdown **directly from the database** instead of
reading the text file. The lessons are pulled via `auditStore.getActiveSkillLessons()`
(status `approved` or `applied`) and rendered with the existing pure
`buildPlaybookMarkdown()`.

Consequences:
- Approving a lesson sets its DB status to `approved`, which `getActiveSkillLessons()`
  already returns. So the lesson is live on the very next customer reply.
- Because the DB is on durable storage, the lesson survives every redeploy. No
  `GITHUB_TOKEN` required for persistence.
- The marking of `approved -> applied` and the GitHub commit become a best-effort
  history/backup only; neither is required for Sunny to keep obeying the lesson. They are
  left in place but their failure no longer loses the lesson.
- On any DB read error, `getPlaybookText()` falls back to the old file read so a transient
  DB issue cannot blank the playbook.

## Components touched

1. `src/playbook.js` — `getPlaybookText()` reads from the DB (the only required change).
2. `public/admin.html` — the "Sorted" chip wording stops implying a lesson might be
   temporary. An approved skill-lesson is permanently saved, so the chip reads
   "Learned & saved" (GitHub backup state shown only as a secondary detail).
3. `api/dashboard.js` `/audit/approve` — response signals that a skill-lesson is
   persisted in the DB regardless of the GitHub commit outcome.

## Out of scope (explicitly not in this change)

- Auto-applying `knowledge_fact` findings (missing prices/policies).
- Auto-applying `engineering_note` findings (code/guard bugs).
- Removing the GitHub commit path.

## Testing

- New `test/playbook_persistence.test.js` spins up a real temporary SQLite DB, inserts an
  approved skill-lesson, and asserts `getPlaybookText()` includes it; asserts a `pending`
  finding does NOT appear; asserts an empty DB renders the no-lessons sentinel (so the
  reply path's injection guard still skips correctly).
- The existing `buildPlaybookMarkdown` unit tests stay green.
