# Sales Manager follow-up check-in

Date: 2026-07-26
Status: approved (design), pending implementation

## Problem

When Sunny hands a customer off to the Sales Manager ("the Sales Manager will reach out to you", plus the direct WhatsApp line), nobody closes the loop. If the Sales Manager never calls, or the customer is left waiting, ElectroSun loses the lead silently. The owner wants Sunny to proactively check back a few hours later: did the Sales Manager sort everything, and does the customer need anything else.

## Goal

A few hours after any Sales Manager handoff, Sunny sends the customer one gentle check-in asking whether the Sales Manager reached out and resolved things, and whether they need anything else. One message per handoff, skipped when it would interrupt an active thread or land in the middle of the night.

## Decisions (from the owner, 2026-07-26)

1. **Delay: 3 hours** after the handoff (tunable via env; the ask originally said 6, revised to 3).
2. **Night guard:** if the 3h mark lands outside **08:00-21:00 Africa/Lagos**, hold the send until the next morning (08:00).
3. **Skip if still active:** if the customer kept chatting substantively with Sunny after the handoff, do not send the check-in.
4. **Trigger on any Sales Manager handoff:** HOT lead, referral mention, bulk order, live-agent request, or info-gap "let me confirm with the team" handoff, i.e. any turn where Sunny appends the "Direct line to the Sales Manager" line.
5. **English-only message,** consistent with the existing canned-line policy (`HOT_LEAD_REPLY` / `SILENT_QUERY_REPLY` are English-only per the brother's directive). The customer may reply in any language; that reply flows through the normal pipeline and Sunny answers in their language.

## Non-goals

- No new admin UI. (Rows are visible in logs/events; a panel can come later if wanted.)
- No template message. The send is free-form inside the 24h window (guarded); a handoff is at most ~3h old at due time, comfortably inside the window even after an overnight hold.
- No LLM call to compose the message. Fixed English text keeps it deterministic and zero-cost.
- No re-nudge if the customer ignores the check-in. One and done per handoff.

## Architecture

Mirrors the existing `nudgeUnansweredPendingQueries` pattern: a dedicated table drained by the always-on `*/5` cron.

### Data model: new table `sales_followups`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `contact_id` | INTEGER | FK contacts |
| `conversation_id` | INTEGER | FK conversations (the conversation the handoff happened in) |
| `handoff_message_id` | TEXT | the outbound WhatsApp message id of the handoff reply (audit only, nullable) |
| `handoff_at` | TEXT | ISO 8601 |
| `due_at` | TEXT | ISO 8601 = `handoff_at + SALES_FOLLOWUP_DELAY_MINUTES` |
| `status` | TEXT | `pending` / `sent` / `skipped_reengaged` / `superseded` / `expired` |
| `language` | TEXT | customer language at handoff time (captured for the future; message is English for now) |
| `sent_at` | TEXT | ISO, set on send |
| `sent_message_id` | TEXT | WhatsApp id of the check-in, set on send |
| `created_at` | TEXT | ISO |
| `updated_at` | TEXT | ISO |

Index: `(status, due_at)` for the drain query.

Table created in `db/schema.sql`; also created idempotently in `db/init.js > applyMigrations` (`CREATE TABLE IF NOT EXISTS`) so existing production DBs pick it up on boot.

### Trigger (in `src/handler.js > processCustomerBatch`)

Right after the handoff reply is sent and persisted (just after `handler.js:2611-2616`, inside the `if (...HandoffThisTurn... && !linkAlreadyInText)` outcome), when a Sales Manager link was actually appended this turn:

1. Skip if `DISABLE_SALES_FOLLOWUP` or `DISABLE_ESCALATIONS`.
2. `supersedeOpenFollowupsForContact(contactId)` -> mark any existing `pending` row `superseded` (re-arm from the latest handoff).
3. `scheduleFollowup({ contactId, conversationId, handoffMessageId, handoffAt: now, dueAt: now + delay, language })`.

Wrapped in try/catch; a scheduling failure logs `handler.sales_followup.schedule_fail` and never breaks the customer reply.

We detect "a link was appended this turn" from the existing boolean `(isHotHandoffThisTurn || isBulkHandoffThisTurn || isLiveAgentHandoffThisTurn || isReferralHandoffThisTurn || isInfoGapHandoffThisTurn) && !linkAlreadyInText` and the fact that `buildSpecialistLink` returned a link. Reuse that computed condition; do not re-derive.

### Drain: `runSalesFollowups(opts)` on the `*/5` cron

Gated: returns early if `DISABLE_SALES_FOLLOWUP` or `DISABLE_ESCALATIONS`. Registered on the same always-on `*/5` block in `server.js` as auto-release / nudge, so it runs even under `DISABLE_NOTIFICATIONS=true`.

For each `pending` row with `due_at <= now` (capped `SALES_FOLLOWUP_PER_RUN_CAP`, default 20):

1. **Night guard.** `isWithinSendWindow(now, SALES_FOLLOWUP_SEND_START, SALES_FOLLOWUP_SEND_END, 'Africa/Lagos')` (defaults 8 and 21, i.e. send only when `8 <= hour < 21`). If false, leave the row `pending` (it sends on a later run once the window opens). No status change.
2. **Expiry.** If `shouldExpire(handoff_at, now, SALES_FOLLOWUP_MAX_AGE_MINUTES)` (default 1440), OR the contact's active conversation differs from `conversation_id` (rolled over), OR the last customer inbound is > 24h old (outside the free-form window): mark `expired`, skip.
3. **Human takeover.** If the conversation is `human_handled`: mark `skipped_reengaged`, skip.
4. **Re-engagement.** Load the contact's inbound messages after `handoff_at`. If `isSubstantiveReengagement(messages)` is true (any inbound with real content: a product token, a digit, a question mark, or length over a small threshold and not a pure ack/nag/greeting/reaction), mark `skipped_reengaged`, skip. A bare "ok" / "thanks" / emoji after the handoff does NOT count as re-engaged, so a customer who acknowledged and went quiet still gets the check-in.
5. **Send.** `sendMessage(contact.phone, FOLLOWUP_TEXT)`. On success: persist the outbound to the conversation (`intent='sales_followup'`), `markFollowupSent(id, messageId)`, `logEvent(contactId, 'sales_followup_sent', {...})`, log `handler.sales_followup.sent`. On send failure: log and leave `pending` for a later retry (bounded by the expiry check).

`opts.send` and `opts.now` are injectable for tests.

### Message text (English, no double dashes, address as "Sir", no URL)

> Hello Sir, just following up. Did the Sales Manager reach out and sort everything for you? Let me know if there's anything else you need.

Exported as a constant so tests assert on it.

## Module layout

New `src/sales_followup.js`:

- Pure helpers (unit-tested, no DB): `computeDueAt(handoffIso, delayMinutes)`, `isWithinSendWindow(nowDate, startHour, endHour, tz)`, `isSubstantiveReengagement(inboundBodies)`, `shouldExpire(handoffIso, nowIso, maxAgeMinutes)`, `FOLLOWUP_TEXT`.
- Store functions (tested against a temp DB, like `test/playbook_persistence.test.js`): `scheduleFollowup(...)`, `supersedeOpenFollowupsForContact(contactId)`, `findDueFollowups(nowIso, cap)`, `markFollowupSent(id, messageId, sentAtIso)`, `markFollowupStatus(id, status)`.
- `runSalesFollowups(opts)`: the orchestrator. It lives in `src/handler.js` (it needs `sendMessage`, `getActiveConversation`, `appendMessage`, `logEvent`, conversation/message reads already imported there), OR in `src/sales_followup.js` with those deps injected. Decision: put the orchestrator in `handler.js` next to `nudgeUnansweredPendingQueries` for consistency and to reuse its imports; keep all pure + store logic in `sales_followup.js`.

Timezone hour for the night guard: `Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false })`. Lagos is UTC+1 year-round (no DST), so the value is stable.

## Env vars (all defaulted, no config required to ship)

| Var | Default | Meaning |
|---|---|---|
| `SALES_FOLLOWUP_DELAY_MINUTES` | `180` | Delay from handoff to check-in (3h). |
| `SALES_FOLLOWUP_SEND_START` | `8` | Africa/Lagos hour sends may begin in the morning (inclusive). |
| `SALES_FOLLOWUP_SEND_END` | `21` | Africa/Lagos hour sends stop for the night (exclusive; quiet 21:00-08:00). |
| `SALES_FOLLOWUP_MAX_AGE_MINUTES` | `1440` | A due follow-up older than this is expired unsent (avoids stale/out-of-window sends). |
| `SALES_FOLLOWUP_PER_RUN_CAP` | `20` | Max sends per cron run. |
| `DISABLE_SALES_FOLLOWUP` | `false` | Kill switch. |

## Cron wiring (`server.js`, inside the existing `*/5` block)

Add a fourth try/catch calling `runSalesFollowups(...)`, logging `cron.sales_followup.done` when `sent > 0`, and a `cron.sales_followup.registered` line. No new schedule; reuse the always-on `*/5` cron.

## Emergent behavior (no extra code)

- The check-in re-opens the thread. If the customer replies "no one called me," the classifier treats it as a real query and re-alerts the routed desk through the normal escalation path.
- If the customer replies "yes all sorted, thanks," the normal warm-close / idle-chatter logic handles it.
- The proactive outbound is never re-armed as a new handoff (it does not append a Sales Manager link), and the orphan sweep ignores outbound rows, so no loops.

## Testing

- `test/sales_followup.test.js`: pure helpers (due-at math, send-window across midnight and the two boundaries, re-engagement classifier on acks vs substantive messages, expiry).
- `test/sales_followup_store.test.js` (or same file, temp DB): schedule -> find-due -> supersede -> mark-sent/expired lifecycle.
- `test/sales_followup_run.test.js` (or wiring in the handler test): `runSalesFollowups` with injected `send` and `now` covering night-hold, expiry, human-takeover skip, re-engagement skip, and a clean send; plus the kill switches.
- Full suite (`npm test`) stays green.

## Rollout

Ships behind defaults, no env change needed. `DISABLE_SALES_FOLLOWUP=true` is the instant off switch. Because it rides the always-on `*/5` cron, it works in production despite `DISABLE_NOTIFICATIONS=true`. Update `CLAUDE.md` (operational rules, env table, cron schedule, module table, schema) and `docs/session-history.md` on ship.
