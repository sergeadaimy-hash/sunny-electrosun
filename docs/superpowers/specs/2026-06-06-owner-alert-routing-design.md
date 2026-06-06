# Topic-based owner alert routing (4 recipients)

Date: 2026-06-06
Status: design (pending user review, then awaiting the 4 real numbers)
Builds on: 2026-06-06-concise-owner-alerts-design.md (the concise alert format).

## Problem

Today every owner alert goes to a single number (`OWNER_WHATSAPP`, the
brother). ElectroSun now has a team. Alerts should go to the right person
based on the lead's category and scale, and the two big-project owners should
share the load rather than both getting every alert.

## Routing logic (owner-supplied 2026-06-06)

Applies ONLY to leads classified SERIOUS or HOT. COLD, DISQUALIFIED, and
REPEAT_CLIENT alerts keep going to the general owner (`OWNER_WHATSAPP`),
unchanged.

### Step 1, category (Category 2 wins, checked first)

- **Category 2, Big Project**, if ANY ONE is true:
  - it is an HV system, OR
  - system size is greater than 20 kW, OR
  - deal value is greater than ₦15,000,000.
- **Category 1, Daily Sales**, only if ALL are true:
  - size is 20 kW or less, AND
  - value is ₦15,000,000 or less, AND
  - it is NOT an HV system.
- If size and value disagree (e.g. 15 kW but ₦18M), Category 2 wins.

### Step 2, assignment

- **Category 1 -> by location:** Abuja lead -> Abuja sales contact; Lagos lead
  -> Lagos sales contact.
- **Category 2 -> strict round-robin between Patrick and Charbel, location
  ignored:** last assignee was Patrick or empty -> assign Charbel, then record
  Charbel; last was Charbel -> assign Patrick, then record Patrick. Produces
  Charbel, Patrick, Charbel, ... (Patrick = `OWNER_WHATSAPP`.)
- One lead -> exactly one category -> exactly one contact. Never both, never a
  split.

## Two confirmed behavioral rules

1. **Same alert triggers as today.** The routing does NOT change WHEN Sunny
   alerts an owner (still: ready-to-pay / unanswered question / discount ask).
   It only changes WHO receives the alert. No new proactive-alert volume.
2. **Gather details before alerting, always.** Sunny must know enough to route
   before any routed alert fires:
   - product/scale, enough to decide Category 1 vs 2, AND
   - for Category 1, the region (Abuja or Lagos).
   If a required detail is missing, Sunny asks the customer one short question
   and does NOT escalate that turn. This holds even for a ready-to-pay HOT
   lead (the handoff fires the next turn, once Sunny has what it needs). For a
   daily sale with no stated city, Sunny asks "Abuja or Lagos?".

## Architecture: hybrid, LLM judges, code assigns

The round-robin and thresholds must be deterministic and survive container
restarts, so they live in CODE, not the prompt. (Same principle already used
for the HV BOM validator: a code guard beats prompt repetition. An LLM cannot
reliably keep a round-robin counter across stateless chats.)

### Classifier (LLM) emits new fields
Added to `classifier.md` output and `FALLBACK_CLASSIFICATION`:
- `routing_category`: `daily_sales` | `big_project` | `unknown`.
  The classifier applies the Step 1 rules. `unknown` when it cannot yet tell
  (missing product/scale/value/HV).
- `routing_region`: `abuja` | `lagos` | `unknown` (from the conversation).
- `routing_signals` (optional, for transparency/logging): `{ is_hv, size_kw,
  deal_value }` with nulls where unknown.

Only required when the lead is SERIOUS or HOT (else null).

### New module `src/owner_routing.js` (pure + a thin DB seam)
Deterministic Step 2. Exposed functions:
- `resolveRecipient(contact, classification)` -> `{ number, ownerLabel,
  category, reason }` or a `needsInfo` result (see below). Pure decision given
  the inputs plus the round-robin/sticky state passed in (so the core is
  unit-testable without a DB).
- `routingInfoSufficient(classification)` -> boolean. False when the lead is
  SERIOUS/HOT, an alert would fire, and either `routing_category === 'unknown'`
  or (`daily_sales` AND `routing_region === 'unknown'`). When false, the
  handler suppresses the alert and asks first.
- Round-robin + sticky helpers backed by the DB (see Persistence).

The numbers come from env (config). Patrick is the EXISTING `OWNER_WHATSAPP`
(`2347041328055`), so no new var for him. Three new vars:
- `OWNER_CHARBEL_WHATSAPP` = `2349068859213` (full second owner)
- `SALES_ABUJA_WHATSAPP`   = `2349169493087` (alert-only)
- `SALES_LAGOS_WHATSAPP`   = `2349111880000` (alert-only)
Any unset number falls back to `OWNER_WHATSAPP`, so the feature is safe to ship
before the numbers are configured (everything routes to Patrick until set).

### Three tiers of recognized numbers
- **Full owners** = `OWNER_WHATSAPP` (Patrick) + `OWNER_CHARBEL_WHATSAPP`
  (Charbel). They receive routed alerts AND Sunny treats their inbound like the
  owner today: a reply quoting a `[QID:N]` alert relays to the customer
  (`handleOwnerReply`), other text routes to Owner Q&A
  (`handleOwnerNonQueryMessage` / `answerOwnerQuestion`). Charbel gets the same
  capabilities as Patrick.
- **Alert-only recipients** = `SALES_ABUJA_WHATSAPP` + `SALES_LAGOS_WHATSAPP`.
  They RECEIVE alerts only. Sunny does NOT converse with them: inbound from
  these numbers is ignored (logged + dropped, no customer reply, no Q&A,
  no reply-relay). They contact the customer themselves via the wa.me
  follow-up link in the alert.
- **Customers** = everyone else (unchanged pipeline).

### Persistence (survives Railway restarts)
- **Round-robin state:** a new tiny table `routing_state(key TEXT PRIMARY KEY,
  value TEXT, updated_at TEXT)`, row `last_big_project_assignee` =
  `charbel` | `patrick`. Idempotent migration in `db/init.js`.
- **Sticky per case:** a new contact column `assigned_big_project_owner`
  (`charbel` | `patrick` | null). On a Category 2 alert: if the contact already
  has an assignee, reuse it (the case stays with that owner for follow-ups and
  the eventual HOT handoff); otherwise round-robin, store it on the contact,
  and flip `last_big_project_assignee`. Category 1 needs no sticky storage
  because region routing is already deterministic and stable.

### Handler wiring (`src/handler.js`)
In `notifyOwnerForEscalation` / the escalation decision point:
1. If lead is NOT SERIOUS/HOT -> send to `OWNER_WHATSAPP` as today (no change).
2. If SERIOUS/HOT but `routingInfoSufficient` is false -> do NOT alert. Build
   an `expertContext` block instructing Sunny to ask the one missing detail
   (product/scale, or "Abuja or Lagos?"), and let `generateReply` answer. The
   alert fires on a later turn once the detail arrives.
3. If sufficient -> `resolveRecipient` picks the number; send the (concise)
   alert there instead of to `OWNER_WHATSAPP`. The follow-up-ping path resolves
   to the same recipient (sticky), so repeat pings reach the assigned owner.

### Multi-owner inbound recognition (three tiers)
Owner identity is currently `msg.from === OWNER_WHATSAPP`. Replace with three
sets built from env in `src/owner_routing.js`:
- `isFullOwner(from)` -> `OWNER_WHATSAPP` or `OWNER_CHARBEL_WHATSAPP`. These
  route to `handleOwnerReply` (QID relay) / `handleOwnerNonQueryMessage`
  (Owner Q&A) exactly as the single owner does today. Charbel == Patrick in
  capability.
- `isAlertOnly(from)` -> `SALES_ABUJA_WHATSAPP` or `SALES_LAGOS_WHATSAPP`.
  Inbound from these is dropped: log `handler.inbound.alert_only_ignored` and
  return. No classification, no reply, no Q&A. They reach the customer via the
  alert's wa.me link, not through Sunny.
- Everyone else -> customer pipeline (unchanged).
Phone comparison is digits-only on both sides (strip non-digits) so formatting
differences (`+234 ...` vs `234...`) match.

## Meta constraint (unchanged, but matters more with 4 numbers)
Alerts are still free-form messages, so each recipient must have messaged
Sunny within the last 24h or the alert is silently dropped. With 4 numbers this
is 4 windows to keep open. Recommended follow-up (separate work): move owner
alerts to an approved Meta template so delivery is guaranteed regardless of
window. Flagged, not in this scope.

## Out of scope
- The Meta template migration for guaranteed delivery.
- Any change to customer-facing reply content beyond the gather-first question.
- Per-salesperson Owner Q&A access restrictions.

## Testing
- `owner_routing` unit tests (pure core, no DB):
  - Category 2 triggers: HV alone, >20kW alone, >₦15M alone, and a size/value
    conflict (15kW + ₦18M -> Category 2).
  - Category 1 only when all three conditions hold.
  - Round-robin sequence given a starting `last_big_project_assignee`:
    empty -> Charbel -> Patrick -> Charbel.
  - Sticky: a contact with `assigned_big_project_owner` set reuses it and does
    NOT flip the counter.
  - Region routing: abuja -> Abuja number, lagos -> Lagos number.
  - Fallbacks: unset env numbers -> `OWNER_WHATSAPP`; COLD lead -> not routed.
  - `routingInfoSufficient`: false for SERIOUS/HOT with unknown category, false
    for daily_sales with unknown region, true otherwise.
- Existing `npm test` (node:test) suite remains green.

## Open inputs still needed from Patrick
1. The 4 actual phone numbers (Abuja desk, Lagos desk, Charbel, Patrick).
2. Confirmation that each will keep its WhatsApp window open, or a decision to
   move to a Meta template.
3. The precise contact names/labels if they should appear anywhere.
