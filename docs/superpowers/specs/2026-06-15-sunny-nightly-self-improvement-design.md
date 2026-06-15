# Sunny Nightly Self-Improvement (Audit plus Improvement Memory)

Design note. Date: 2026-06-15. Status: approved for build, pending spec review.

## Goal

Each night, Sunny audits the day's conversations against his own rules, knowledge, and stock, finds where his replies did not match what he should have said, and proposes improvements. The owner approves them on his phone; approved changes go live. Over time Sunny gets measurably stronger.

Two outcomes the owner asked for, in order: better sales and communication skill, and more business knowledge. Explicitly NOT a per-customer memory.

## Non-goals

- No per-customer memory across conversations (the owner rejected this directly).
- No autonomous changes. Every change is owner-approved before it affects a reply.
- Sunny never gains the ability to invent a price. Prices stay Warehouse-only.
- The audit does not edit code. Code issues are flagged for the builder, never auto-applied.

## Trigger and scope

- New cron at 21:00 Africa/Lagos.
- Gated by a dedicated env flag (proposed `ENABLE_NIGHTLY_AUDIT`, default off), independent of `DISABLE_NOTIFICATIONS`, so the owner can run the audit without re-enabling the old hourly/daily report crons.
- Scope per run: every conversation with at least one inbound message in the last 24h. Skip the owner thread and the sales-desk threads (`configuredRecipients()` in `src/owner_routing.js`).

## The four checks (per conversation)

1. Rule compliance. Compare each Sunny reply to `system.md` plus the live playbook. Flag violations: trailing question on a short factual answer, an unrequested price, the customer's name instead of "Sir", a wa.me leak, a first-person stall, and similar documented rules.
2. Knowledge application. Did he use the stock, price, datasheet, photo, or location he already had? Flag "had the answer, did not use it": stalled when the price was in Warehouse, deflected, or missed an available datasheet or photo.
3. Outcome. Look at chats that went silent right after a Sunny reply, chats where the human took over (`conversations.human_handled`), and escalations that sat unanswered (`pending_queries`). Diagnose the likely cause in the last few replies.
4. Recurring patterns and gaps. Across the whole day, cluster repeated questions and genuine no-answer cases.

Every finding MUST cite: the conversation id, the exact message (id plus a short snippet), and the specific rule or fact it was checked against. No finding may exist without a citation, so the owner can verify each one at a glance and the auditor cannot invent a vague problem.

## Signal sources (objective anchors, so the auditor is not free-judging)

- `conversations.human_handled` / `human_handled_at` (owner takeover).
- `pending_queries.status` open or expired (unanswered).
- `events` table (escalated and related events).
- `lead_temperature` moving to LOST or COLD; or no inbound for N hours after a Sunny reply (silent lead). N is configurable.
- Message-content cues from the customer ("that's wrong", "for what?", repeated asks, bare "?").
- Nice-to-have (Phase 3): guard-trip awareness (prices stripped, stall replaced, fabricated variant blocked). These currently live in logs, not the DB, so they are deferred.

## Three finding lanes (each goes to a different home)

- `skill_lesson` to the playbook: a new repo file `src/prompts/learned-playbook.md`, loaded by `prompt_store` and injected by `claude.js` next to `system.md`.
- `knowledge_fact` to the trusted stores: price and stock to the Warehouse table (the proposal links to the Warehouse editor or offers a one-tap create), policy to `system.md` (a suggested diff via the existing Rules editor push). Prices never enter any other way.
- `engineering_note` flagged for the builder only. No auto-apply, because a code or guard fix is the builder's call.

## The improvement loop (how he gets stronger every day, Phase 2)

- Lesson lifecycle. A lesson moves through statuses: proposed, active (testing), graduated (folded into `system.md`), retired or reworked. Reuse and extend `knowledge_entries.status` (active, superseded, rejected).
- Did-it-work recheck. Later audits check whether the problem a lesson targeted stopped recurring. Validated lessons become eligible to graduate; lessons that changed nothing are flagged for rework.
- Graduation. A lesson stable for K nights moves from the temporary playbook into permanent doctrine (`system.md`), and the playbook entry retires. The playbook stays small; the permanent floor rises.
- Merge and consolidation. Overlapping lessons collapse into one (reuse `findOverlapGroups`). The audit proposes merges for owner approval.
- Regression watch. A previously fixed problem that reappears is resurfaced at the top of the next review.
- Scorecard. A weekly trend on the audit tab: rule-breaks per 100 chats, count of unanswered questions, silent-lead rate, percent of replies that matched "what he should have said". Turns improvement into a visible number and shows plateaus.

## Storage model

- Pending proposals: new DB table `audit_findings` (id, audit_run_id, conversation_id, message_id, lane, type, finding_text, proposed_change, cited_rule, status [pending, approved, edited, rejected, applied], created_at, applied_at). On the `/data` volume.
- Run record: new DB table `audit_runs` (id, run_date, window_start, window_end, counts, scorecard JSON).
- Improvement memory (applied skill lessons): the repo file `src/prompts/learned-playbook.md`. Size-capped and de-duplicated. Newest wins on conflicts. Revertible via git.
- Apply approved: one action collects approved `skill_lesson` rows, writes them into `learned-playbook.md`, commits and pushes via the existing GitHub Contents API path, and triggers one Railway redeploy for the whole batch. `knowledge_fact` rows apply to Warehouse (DB write, no push) or queue a `system.md` edit. This is the owner's chosen "repo-backed, batched push" model.

## Approval flow (owner UX, Phase 1)

- 21:00 audit runs, writes one `audit_runs` row and many `audit_findings` rows, then DMs the owner "N proposals waiting" with a deep link (`PUBLIC_BASE_URL/admin#audit=<run_id>`), reusing the existing owner-alert and deep-link code.
- New admin "Nightly Audit" tab lists findings grouped by lane. Each shows the cited message, the cited rule, and the proposed change, with Approve / Edit / Reject. An "Apply approved" button does the batched apply (one push and redeploy for skill lessons).
- Admin-only (master key). The inbox role does not see this tab. New endpoints under `/api/audit/*`, master key only.

## Safety rails

- Owner-gated. Nothing is live without approval.
- Every finding cited and traceable to a real message and a real rule.
- Playbook size cap (env, for example `AUDIT_PLAYBOOK_MAX_LESSONS` and a char budget) plus dedup plus newest-wins plus git revert.
- Prices never enter through lessons; Warehouse only, owner-edited.
- Auditor runs on the cheaper model (Sonnet), bounded per-night cost, respects the daily budget guard.
- Dedicated enable flag, default off until soaked.

## Cost and scope

- Sonnet, roughly 0.01 to 0.02 USD per conversation, about 1 to 2 USD per night at current volume, scaling with chat count. The rules summary is cached.
- Only chats with activity; owner and sales-desk threads skipped.

## Reuse of existing code

- `src/knowledge.js`: dedup (`normaliseForDedup`, `findDuplicateActive`), supersede, `findOverlapGroups` (consolidation), `getKnowledgeStats`. Revive and extend for lessons.
- `src/reports.js` `generateDailyLearningReport`: replace its two placeholders ("pattern extraction with draft replies is on the roadmap", "self-generated learning questions are on the roadmap") with the real audit output.
- `src/prompt_store.js`: add `learned-playbook.md` as a managed prompt; `claude.js` injects it beside `system.md`.
- GitHub Contents API push (already used by the Rules editor Save) for the batched apply.
- Owner-alert and admin deep-link infrastructure for the proposals-waiting ping.

## Phases

- Phase 1 (core loop): the nightly audit (checks 1 to 3), `audit_runs` and `audit_findings` tables, the Nightly Audit tab, `skill_lesson` to playbook, batched apply and push, the owner ping. Lesson status proposed and active only.
- Phase 2 (knowledge plus compounding): check 4 (patterns and gaps), `knowledge_fact` routing to Warehouse and `system.md`, plus graduation, the did-it-work recheck, merge, regression watch, and the scorecard.
- Phase 3 (depth): guard-trip log signals, richer analytics, auto-merge proposals.

## Open questions and risks

- Enable flag vs `DISABLE_NOTIFICATIONS`: recommend a dedicated flag (settled above, confirm).
- "Silent lead" threshold: how many hours of no inbound after a Sunny reply counts as lost.
- Graduation criterion K: how many stable nights before a lesson becomes doctrine.
- `system.md` auto-edit safety: policy facts and graduations that touch the rulebook must always be an owner-confirmed diff, never a silent write.
- Playbook injection cost: it rides every customer reply, so the size cap is the real control. Keep it tight.
