# Design: teach Sunny missing facts in one click (knowledge_fact lane)

Date: 2026-06-27
Builds on: 2026-06-26 playbook-from-DB ("Option A"). Same DB-persistence pattern.
Owner decisions: handle BOTH fact kinds; price path = "Approach A" (shortcut + reminder, no auto-create).

## Goal

When the owner approves a nightly-audit `knowledge_fact` finding, the missing fact is
applied to the right place so Sunny stops repeating the mistake:
- a general fact (warranty, delivery area, policy) is taught to Sunny directly and read on
  every future reply, permanently;
- a missing price is routed to the Warehouse Stock tab (the single authoritative price
  source), where the owner types the number once and Sunny then knows it.

Out of scope: skill_lesson (already done), engineering_note (stays a developer note),
auto-creating Warehouse Stock rows.

## The two sub-types

The auditor already tags price findings with `rule_key = missing_price_fact` (stored in
`audit_findings.finding_type`). Everything else in the `knowledge_fact` lane is a general
fact. So the split is data-driven, no owner sorting needed.

## Hard-rule constraint (why prices are special)

Project hard rule: confirmed prices come from Warehouse Stock ONLY, never from owner-taught
knowledge (so a price can never be stale or contradicted). Therefore prices must NOT enter
the learned-facts block Sunny reads. They are routed to Warehouse Stock instead.

## Half 1: general facts -> a learned-facts block Sunny reads

Mirrors the learned-playbook (Option A): read from the DB, no file/GitHub dependency.

- `src/facts.js` (new):
  - `buildFactsMarkdown(facts)` (pure): numbered, dedup (first 120 chars), `edited_text`
    wins over `proposed_change`. Header "# Learned facts (owner-confirmed)". Empty list ->
    header + "(No confirmed facts yet.)".
  - `getFactsText()`: render `auditStore.getActiveKnowledgeFacts()` via
    `buildFactsMarkdown`; on DB error return '' (so a hiccup cannot break a reply).
  - `looksLikePrice(text)` (pure): true when the text carries a Naira money signal
    (currency marker ₦ / NGN / naira, a thousands-separated number like 4,200,000, a
    "<n> million/m" amount, or a bare integer >= 10000 not glued to a unit). Must NOT flag
    normal facts: "2-year warranty", "we deliver to Kano", "BOS-A is 7.68kWh", "Deye 16kW
    three phase", "10 units minimum".
- `src/audit_store.js`:
  - `getActiveKnowledgeFacts()`: `lane='knowledge_fact' AND status IN ('approved','applied')
    AND COALESCE(finding_type,'') != 'missing_price_fact'`, ordered by id. (Approved alone
    makes a fact live; no separate apply step needed.)
  - `setFindingType(id, type)`: used by the safety net to reclassify a price-looking general
    fact to `missing_price_fact`.
- `src/claude.js`: after the playbook block, inject the facts block when non-empty and not
  the "(No confirmed facts yet.)" sentinel. Logs `claude.reply.facts_injected`.
- `src/audit.js > buildRulesSystemBlocks`: also inject the facts block ("already confirmed;
  do not re-propose") so the auditor stops re-finding known facts.

## Half 2: missing prices -> Warehouse Stock shortcut (Approach A)

- Approving a price finding marks it `approved` (acknowledged); it is NEVER injected.
- The Sorted card shows an "Add in Warehouse Stock" chip plus an "Open Warehouse Stock"
  button that calls the existing `switchView('view-warehouse')`. The card keeps showing the
  finding text / the customer's cited words so the owner knows what to price.
- Once the owner adds the price in Warehouse Stock, Sunny reads it on the next reply (already
  wired via `formatWarehouseForPrompt`). No new injection.

## Safety net (price can never land in the facts block)

In `POST /api/audit/approve`, for a `knowledge_fact` id whose effective confirmed text
(`edited_text` if the owner edited it, else `proposed_change`) `looksLikePrice(...)`:
reclassify its `finding_type` to `missing_price_fact` before marking approved. It is then
excluded from `getActiveKnowledgeFacts()` and shown as a price item. Result: a price typed
into a general-fact box is rerouted to Warehouse Stock, never injected.

## Endpoint changes: POST /api/audit/approve

Iterate ids; per finding by lane:
- `skill_lesson` -> approve; set `hasLesson` (unchanged playbook rebuild afterwards).
- `knowledge_fact` -> compute `isPrice = finding_type==='missing_price_fact' ||
  looksLikePrice(effectiveText)`; if price, reclassify (when needed) + approve + set
  `hasPrice`; else approve + set `hasFact`.
- `engineering_note` -> approve (recorded), no flags.
Response adds `has_fact`, `has_price`; `persisted = hasLesson || hasFact` (both are durable
in the DB). Existing `has_lesson`, `applied`, `deployed`, `commit` unchanged.

## Admin UI (public/admin.html)

- Live approve chip from response flags: `has_lesson` -> "Learned & saved";
  `has_price` -> "Add in Warehouse Stock"; `has_fact` -> "Sunny learned this";
  else "Approved (recorded)".
- Sorted re-render chip by lane + finding_type (same mapping), and price items render the
  "Open Warehouse Stock" button.
- Reuses the existing `switchView('view-warehouse')` for the button.

## Testing (TDD)

- `test/facts.test.js` (pure): `buildFactsMarkdown` empty/numbered/edited-wins/dedup;
  `looksLikePrice` true cases (₦4.2m, 4,200,000, 4.2 million naira, NGN 850000, 850000) and
  false cases (2-year warranty, deliver to Kano, 7.68kWh, Deye 16kW three phase, 10 units).
- `test/facts_persistence.test.js` (real temp DB): an approved general fact appears in
  `getFactsText()`; a pending one does not; a `missing_price_fact` is excluded; empty renders
  the no-facts sentinel.
- Full suite stays green.

## Files touched

New: `src/facts.js`, `test/facts.test.js`, `test/facts_persistence.test.js`.
Edited: `src/audit_store.js`, `src/claude.js`, `src/audit.js`, `api/dashboard.js`,
`public/admin.html`, plus docs (CLAUDE.md, session-history, memory).
