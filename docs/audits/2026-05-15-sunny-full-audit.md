# Sunny full system audit, 2026-05-15

**Status**: read-only reference. No code changed. No prompts edited. No commits made by this audit. The deliverable is this document plus the roadmap at the end.

**Scope**: full system. The §9 LV/HV battery configurator gets the deepest read, but the audit also covers the classifier, the four fixes just pushed to fix the silent_query loop, the code-level guards, the knowledge foundation, and the agent's claimed-vs-actual capabilities.

**Method**: three parallel research agents (one on §9 doctrine, one on code foundation, one on agent capabilities) read the live files end to end. Findings consolidated here. The previous audit document was deleted earlier today during the silent_query-loop rollback; this replaces and extends it.

**Live state at audit time**: commit `71ae786` on `origin/main` (after the four loop-fix commits were pushed). Schema migration for `pending_queries.last_assistant_reply_at` will run automatically on the next container boot.

---

## Executive summary

Sunny is past the prototype stage. The pipeline is well structured, the guards are deep, and the schema is clean. What's holding the agent back is **drift between the prompt's promises and the code's actual behavior**, plus a **§9 doctrine that has been rewritten so many times** (eight rewrites in seven days per CLAUDE.md) that internal contradictions have accumulated faster than they get reconciled.

Three things would lift quality the most:

1. **Stop the prompt from promising things the code doesn't deliver.** Section 16 lists four dynamic context blocks (Datasheet Knowledge, Negotiation, Big Project, Active Promos). Only one is real. The other three make the model expect inputs it never gets, and the model fills the gap by improvising.

2. **Finish the escalation routing matrix.** HOT and silent_query are end to end. `dealer_pricing` (just shipped) is also end to end except the classifier doesn't know about it. `negotiation`, `repeat_complex`, and `big_project` are documented as if they work but only get an alert header; the customer-facing reply context falls through to the wrong default.

3. **Reconcile the §9 doctrine to itself.** §9LV.6 says four lines per BOM card; §19 demands six lines for every BOM card. §5 shows a price line; §9 says no prices by default. The 150/360 worked example in §9HV.9 uses a 12+11 split which §19 explicitly forbids. The model picks a side and looks inconsistent.

There is also one **active bug from today's just-pushed fixes**: the silence cooldown does not start on the first `dealer_pricing` turn because the variable that controls the marking was captured before the new pending row was created. The fix is small but real.

The four fixes pushed today (auto-expire, reply-once, topic-shift, dealer routing) are correct in principle and handle the screenshot loop cleanly. Two of them have edge cases (legacy `created_at` format, first-dealer-turn capture order) that need a follow-up commit. None of them introduce new live risk; all of them improve the current loop behavior.

---

## Critical bugs (likely to manifest in production this week)

### B1. First dealer_pricing turn does not start the silence cooldown

In `src/handler.js`, the `currentOpen` variable is captured at line 1039 by reading the open pending row at that point. For a brand-new dealer_pricing escalation, the pending row is created INSIDE `notifyOwnerForEscalation` at around line 1021 (the call site for the silent_query / dealer_pricing branch). By the time `currentOpen` is read at 1039, the new row exists in DB but the helper function `getOrAutoResolveStalePending` was called BEFORE the row was created on the FIRST turn, so it returned null. The touch call at line 1402 then checks `if (currentOpen && currentOpen.id)` and skips. Result: `last_assistant_reply_at` is never set on the new dealer pending row, and the next dealer inbound (e.g. "When?") gets a fresh LLM reply, not the silence cooldown.

**What this means for you**: the dealer-routing fix announces silence-after-first-reply behavior, but for dealers the silence does NOT actually start. The customer can still get 2-3 follow-up stalls before any of the protections kick in.

**Fix shape**: re-read `currentOpen` after `notifyOwnerForEscalation` runs (or, more cleanly, change the touch to also use `freshPendingId` from the escResult).

### B2. Legacy `pending_queries.created_at` values can be non-ISO and exempt the auto-expire

`src/handler.js > getOrAutoResolveStalePending` parses `open.created_at` with `new Date(...)`. The application writes ISO timestamps. But SQLite's `CURRENT_TIMESTAMP` default produces `YYYY-MM-DD HH:MM:SS` (no `T`, no `Z`). Older rows that were inserted via the schema default would be in this format. `new Date("2026-05-10 14:00:00")` parses inconsistently across environments; on some Node builds it returns NaN. In that case the auto-expire helper returns the row unchanged (the if-branch can't fire), so the contact stays trapped in the loop forever.

**What this means for you**: the auto-expire (Fix A) protects new pending rows but cannot protect rows that were already open BEFORE the fix shipped. If any contact had a stuck pending row at the moment of the push, they may stay stuck.

**Fix shape**: a one-time SQL migration that normalises existing `created_at` to ISO via `strftime`, OR a fallback ISO parser in the helper, OR a startup script that closes all open pending rows older than 24h.

### B3. §9HV.9 has a worked example that violates §19 hard never

Line 722 of `system.md` (in the 150kW / 360kWh worked example) shows `BOS-A: 46 modules across 2 inverters = 23 each → 2 clusters of 12+11 per inverter`. §19 line 1016 says `Never split clusters unevenly. 24 BOS-A on 2 inverters → 16+16, not 21+11`. The worked example is doing exactly the thing the hard never bans.

**What this means for you**: the model trains on the worked example. When it produces a real BOM, it will sometimes mirror this 12+11 split. The HV validator at the code level will then drop the option (which is correct), and the customer sees fewer options than they should. Owner has to verify whether uneven splits within one inverter are actually allowed, or whether the example needs to be rewritten to 12+12.

### B4. §9HV.9 200kWh BOS-G worked example undercounts racks

Line 734: `39 modules → 3 clusters of 13 → 3 × 3U-RACK`. Per §9HV.3, a BOS-G cluster of 13 to 16 modules needs **2 × 3U-RACK** (the rack only holds 12 modules). 3 clusters × 2 racks = 6 racks. The example says 3.

**What this means for you**: this is a flat math error in the doctrine. The model will sometimes copy 3 instead of 6 into customer BOMs. The owner ends up short-shipping racks. This is exactly the kind of doctrine error the rack-line validator (mentioned in the previous audit) would catch in code, but the validator was never written.

### B5. §19 line 1014 forces a 6-line BOM template, but §9LV.6 only has 4 lines

§19 hard never: "Never send a BOM card without all six lines (Inverter / Battery / Cluster split / Control Box / Racks / Cables)". §9LV.6 template lists four lines (Inverter / Battery / Parallel kit / Cables). LV has no clusters, no Control Box, and no Racks (those are HV constructs).

**What this means for you**: when the model produces an LV BOM, it will sometimes invent fake `Cluster split: N/A` or `Racks: N/A` lines to obey the §19 rule. Customers see confusing entries. Or the model omits them and the BOM cleanup function may flag the card as malformed.

### B6. §9.0 Check 5 customer-facing template contains a §19 forbidden token

Line 297 includes the phrase "32-pack ceiling" as part of the customer-facing message. §19 line 1006 explicitly forbids the model from saying "32-pack ceiling" to the customer.

**What this means for you**: §9 itself is teaching the model a phrase that §19 forbids. The model emits the phrase, the cleanup function probably catches it, the customer sees an awkward gap in the reply.

---

## §9 LV/HV configurator findings

The §9 doctrine spans lines 246 to 793 of `system.md`. It is the largest single section by a wide margin. Findings here are organized by sub-area.

### S1. §9.0 decision tree

- **S1a**: Customers who name an HV-only inverter SKU by model code (e.g. "SUN-50K-SG01HP3") should route directly to HV. §9HV.1 says so. §9.0 Check 1 does NOT have a branch for this; it only catches the words "HV / high voltage / 48 V". Per §9.0 line 250 ("§9.0 wins on conflict"), the §9HV.1 trigger loses. Result: a customer naming an HV-only model by code may land in Check 2 (peak load) and get LV recommended. This is rare today but accuracy matters.

- **S1b**: 1-phase site with no LV inverter that fits → Check 4 routes to HV → but HV is 3-phase only (line 575). Dead-end. No branch handles "phase impossible".

- **S1c**: Phase-match Check 3 is sound for all existing LV inverter variants (every kW size exists in both 1-phase and 3-phase), so S1b is a corner case. Worth a guard rail anyway.

### S2. §9LV consistency

- **S2a**: Step 1 of §9LV.4 mentions a 1.25× headroom rule on continuous load. **No worked example shows it being applied.** The model has no template for when peak vs continuous matters.

- **S2b**: Tie-break rule says "lowest count wins". The 30kW / 50kWh worked example shows `3 × SUN-12K` as the primary result alongside `(or 2 × SUN-16K or 2 × SUN-20K)`. The tie-break rule says 2 × SUN-16K or 2 × SUN-20K should be the recommendation. The example violates its own rule.

- **S2c**: The strict-minimum override (when customer says "at least", "minimum", "no less than", force ceiling instead of 2% tolerance) is documented in CLAUDE.md as having shipped, but is **NOT in the current §9LV.4 text**. The rule was dropped during one of the §9 rewrites and never re-added.

- **S2d**: §9LV.4 Step 5 says the BOM emits "inverters, packs, parallel/comm kit, cables, BOS." But the §9LV.6 template has NO "BOS" line. Either "BOS" is leftover terminology that should be removed from Step 5, or the template is missing the line.

### S3. §9HV consistency

- **S3a** (already in critical bugs as B3): 150/360 worked example uses 12+11 splits that §19 forbids.
- **S3b** (already in critical bugs as B4): 200kWh BOS-G example undercounts racks.
- **S3c**: BOS-B rack hardware is "confirmed with the team" placeholder. §9HV.6 template requires a "Racks:" line. Neither §9HV.3 nor §9HV.6 specifies what wording the customer sees when BOS-B is recommended. The model will improvise.
- **S3d**: §9HV.4 "no HV fits at all" fallback is written as a path but has no worked example. The model has no template for what to say to the customer in that case.

### S4. Rack rules

The BOS-A rack-picking algorithm (7-10 → RACK11, 11-13 → RACK14, 14-16 → RACK14+RACK11, 17-21 → 2×RACK14) is fully written down in §9HV.3 lines 589 to 593. Good.

BOS-G cluster-to-rack mapping (≤12 → 1× 3U-RACK, 13-16 → 2× 3U-RACK with still 1 PDU) is also fully written. Good.

The B4 example bug is the only inconsistency.

### S5. BOM output discipline

- §9.X.5 (a subsection I had suggested adding in the deleted audit) does **not exist**. The output-discipline rules are still scattered across §9LV.6, §9LV.7, §9HV.6, §9HV.7, and §19. The 2026-05-15 BOM cleanup function in `src/claude.js` catches most leaks, but adding new tokens to forbid is a multi-place edit.

- The cleanup function in `src/claude.js > cleanupBomReply` does NOT catch the `→ floor N = X kWh` arrow notation that appears in §9HV.9 worked examples. A model that copies that token verbatim would leak it to the customer.

### S6. §5 vs §9 disagreement

- The §5 BOM example shows a `Total: [figure] NGN` line. §9LV.6 and §9HV.6 explicitly forbid prices in BOM by default. The model sees two precedents and picks one inconsistently.
- §5 uses `Batteries:` (plural). §9HV.6 uses `Battery:` (singular). Minor cosmetic drift.

### S7. Voice drift in §9 customer-facing templates

- §9.0 Check 4 reply ("For your load and storage, a high-voltage system is the cleaner fit") is clean direct English, no Nigerian flavor.
- §9.0 Check 5 fallback uses "ceiling", "isn't buildable", "the configuration", technical-register words that §4 says to avoid in customer-facing voice.
- §9LV.6 / §9HV.6 BOM template opening line "For [X] kW / [Y] kWh, here are your options:" has no `Sir` or `Oga` allowance. Tension with §4 Nigerian voice rules.

### S8. Dead and ghost references

- "Datasheet Knowledge block" still ghost-referenced in §5 (line 148), §11 (894), §17 (906), §19 (991), §20 (1030). Per CLAUDE.md the standalone block was retired 2026-05-10; datasheets now flow per-item. The prompt is misleading the model about a block that may or may not exist (the code actually still injects this block via `warehouse.formatDatasheetKnowledgeForPrompt`, but only for items with extracted text, so the prompt's claim about "specs from the block" is technically true but flaky).
- "Optimal module count" (retired) and SE-G5.1 Pro (retired) are correctly absent from §9.
- The "> 50 kWh → HV" gravestone was already cleaned during the silent_query loop fix.

---

## Escalation routing matrix (the biggest single gap)

Six escalation types exist in the system. Only two are fully wired. The matrix below shows where each type is handled. Rows are escalation types; columns are the seven places routing decisions are made.

| Type | Classifier prompt | Code promoter | Handler branch | Reply context | Header | wa.me link | Pending row |
|---|---|---|---|---|---|---|---|
| `hot_lead` | yes | yes | yes (60s throttle, retry on fail) | yes | yes | yes | no |
| `silent_query` | yes | partial | yes | yes | yes | no | yes |
| `dealer_pricing` | **NO** | yes | yes | yes | yes | no | yes |
| `negotiation` | yes | no | partial (default path) | **NO** (uses wrong default) | yes | no | no |
| `repeat_complex` | yes | no | partial (default path) | **NO** | yes | no | no |
| `big_project` | **NO** | no | partial (header only) | **NO** | yes | no | no |

What this means for you:

- `hot_lead`: production-grade.
- `silent_query`: production-grade.
- `dealer_pricing`: works because the regex catches the standard phrasings. **Will miss dealers who self-identify in non-standard wording** (e.g. "I source these for my installation business") because the LLM classifier was never told `dealer_pricing` is a valid output.
- `negotiation`: the alert header reaches the owner. The customer reply context is the GENERIC "awaiting expert" block which explicitly says "do NOT say the team will follow up". For negotiation, the right reply IS "let me check with the team about the figure". The wrong default makes Sunny answer negotiation pushes with deflection language that ignores the negotiation.
- `repeat_complex`: same situation as negotiation. Brother gets the alert, customer gets the wrong-shaped reply.
- `big_project`: the header exists but no code path emits this value. Brother will never see a BIG PROJECT alert because nothing creates one.

---

## Foundation findings

### F1. The four just-pushed fixes are correct in principle

`3c233ab` (auto-expire), `e294f77` (reply-once), `18a026d` (topic-shift), `71ae786` (dealer routing) all wire into the pipeline cleanly. The interaction order (topic-shift before classifier, auto-expire on `getOrAutoResolveStalePending` calls, silence cooldown after both) is correct. The 8-message screenshot loop from this morning would NOT recur with these fixes in place.

### F2. The four fixes have two real edge cases (B1 and B2 above)

Both addressable in small follow-up commits.

### F3. `processCustomerBatch` is 592 lines, `generateReply` is 518 lines

Both are the central hot paths. Adding any new behavior to them requires reasoning about 6 to 10 interacting branches. The B1 capture-order bug above is exactly the kind of thing that happens when a function gets too large to hold in mind. Recommend splitting `processCustomerBatch` into named phases (intake → classify → route → context → generate → validate → send → persist) before adding any more behavior.

### F4. Five in-memory Maps have no LRU cap or periodic sweep

`rateLimitState`, `escalationState`, `hotEscalationState`, `followupState`, `imageState` in `security.js`, plus `_lastDropsByContact` in `hv_validator.js`, plus `CALL_AUTOREPLY_RECENT` in `handler.js`. Each grows by one entry per unique contact and never shrinks. On Railway's hobby plan with a long-uptime container, this is a slow but real memory leak. Not catastrophic for 30 days; will eventually OOM.

### F5. New env knobs are undocumented

`PENDING_QUERY_AUTO_EXPIRE_MINUTES` (default 30) and `PENDING_QUERY_REPLY_SILENCE_MINUTES` (default 10) are not in `.env.example` and not mentioned in CLAUDE.md's env var table. A new operator has no way to know they exist. Worse, malformed values (e.g. `PENDING_QUERY_AUTO_EXPIRE_MINUTES=abc`) parse to NaN and silently disable the protection.

### F6. Owner alert delivery is silently fragile

If `OWNER_WHATSAPP` is wrong, or the brother hasn't messaged Sunny within the last 24h (Meta's free-form messaging window), every alert goes out as "ok=false" with no retry beyond the one HOT-only retry. The customer is still escalated; brother sees nothing. There is no SMTP fallback, no second retry, no observability tag distinguishing "send returned not-ok" from "did not deliver".

### F7. Code-vs-prompt drift on the wa.me link

CLAUDE.md says "customer-side wa.me link is auto-appended on BOTH hot_lead and silent_query escalations". The code at `handler.js:1378-1387` appends ONLY on `hot_lead` (this was deliberately changed in `0592c8a` on 2026-05-15 to fix spam complaints). The CLAUDE.md sentence in the project-rules section was never updated to match.

### F8. No committed tests

`package.json` has only `start`, `dev`, `db:init`. Zero test files. All "verifications" mentioned in commit messages are throwaway `node -e` snippets. The two highest-leverage modules (`hv_validator.js` and `cleanupBomReply`) are pure-logic string-in/string-out: ideal candidates for a 10-fixture committed test suite that would catch regressions across §9 prompt rewrites.

### F9. Schema and migrations are clean

The `pending_queries.last_assistant_reply_at` column added in `e294f77` is correctly wired (schema.sql, db/init.js migrations, memory.js read via `SELECT *`, handler.js read and write). One minor cosmetic drift: `warehouse_items.is_staple` exists only in the migration list, not in `schema.sql`. Fresh installs work; the schema file is just incomplete. Worth aligning so the schema file remains the source of truth.

---

## Knowledge foundation findings

### K1. Prompt files are reloaded with no validation

`prompt_store.js` caches prompts for 30 seconds and busts the cache on admin Save. If an accidental empty Save happens (e.g. the textarea selected and emptied), the next classifier and reply calls run with an empty system prompt and the model emits nonsense. There is no shape validator at load time.

### K2. "Datasheet Knowledge block" works for PDFs only

`pdf-parse` extracts text from PDFs. PNG / JPG / WEBP datasheets store empty `datasheet_text`. The Warehouse Stock block still shows "Datasheet on file: yes", so when a customer asks "what's the depth of discharge?", the model says "let me confirm" even though the brother uploaded the actual answer as an image. The file gets sent on a datasheet request, but specs questions in chat have no source.

### K3. "Owner-taught knowledge facts" references are dead

Several places in expert-context blocks (`buildExpertContext`) reference "owner-taught knowledge facts". The function that injected these (`knowledge.formatKnowledgeForPrompt`) was retired 2026-05-10. The references in the prompt and in expert-context strings still tell the model to use them. The model has nothing to use.

### K4. Conversation state regex is English-only

`buildConversationState` extracts size (kW/kVA/kWh), phase, brand, location from arbitrary customer text using English regex. A Pidgin customer typing "ten kay double yu" or "ten kw o" gets no size extraction. The model then asks for size again even though the customer said it.

### K5. HOT trigger regex is English-only

`HOT_TRIGGER_RE` in `classifier.js:18` is a ~1.5KB English-only alternation. Pidgin "I go pay tomorrow", Hausa "Zan biya yau", Yoruba "Mo fẹ́ san" don't match. A customer ready to commit in a non-English phrasing gets misclassified.

### K6. Owner Q&A snapshot is missing business-metrics fields

The snapshot (`owner_qa.js:130-146`) covers: today's inbound/outbound counts, HOT leads, pending_queries, recent contacts, escalations, owner-chat. It does NOT cover: revenue / closed deals (no closed-deals table), conversion rate (no funnel), top-oldest pending queries with age, per-product demand, per-language breakdown, day-over-day comparison. Brother can't ask "how much revenue did Sunny help close this week?" because the data isn't there.

---

## Customer-facing voice findings

### V1. Live failures map to known patterns

The 8-message screenshot loop from this morning (AWGU PERPETUAL CHINEMEREM, RESELLER) has two root causes:
- The silent_query loop, fixed by the four pushed commits this afternoon.
- The dealer-pricing routing, partially fixed (the LLM classifier is still blind to dealer self-identification; only the regex catches it).

### V2. Voice rules in §4 are clean

The Nigerian English flavor (Okay sir, No wahala, Ehen, Sharp sharp, Carry go) is well documented and matches the §4 voice rules. The "Sir" / "Oga" rule is correctly limited to once-per-reply.

### V3. BOM cards do not let the Nigerian voice in

§9LV.6 and §9HV.6 templates are strict and have no opening hook. A customer-facing BOM looks like a spec sheet, not a Lagos counter rep talking. This is partly intentional (BOMs need to be scannable) but worth a deliberate choice: should the opening line be allowed to say "Oga, for [X] kW / [Y] kWh:"?

---

## Open questions for the brother

These are things only the owner can answer. They affect doctrine accuracy. Please confirm each one when you get a chance.

1. **BOS-A 17-21 modules → 2× RACK14**: is this still the rack hardware in stock, or has Deye introduced a single larger rack?

2. **BOS-B rack hardware**: is there a confirmed BOS-B rack SKU yet, or still "confirmed with team"? If confirmed, what wording should the customer see on the Racks line of a BOM?

3. **BOS-G 13-16 modules per cluster → 2× 3U-RACK**: the 200 kWh worked example in §9HV.9 says 3 × 3U-RACK for 39 modules in 3 clusters of 13. By the rule it should be 6 racks. Which is correct in reality?

4. **150/360 BOS-A "12+11 split within one inverter"**: is uneven splitting within a single inverter allowed, or should the example be rewritten to 12+12 (which would require 24 modules per inverter, not 23)?

5. **§9LV.6 template (4 lines) vs §19 line 1014 (6 lines required)**: which is authoritative for LV BOMs?

6. **§5 example with `Total: [figure] NGN` line vs §9 "no prices in BOM by default"**: which wins? Do BOMs ever include a total price?

7. **§9LV.4 Step 5 mentions "BOS" in the emit list but §9LV.6 template has no BOS line**: is "BOS" supposed to mean Balance of System (separate line item), leftover HV phrasing, or something else?

8. **§9LV.4 Step 1 "1.25× headroom on continuous load"**: when only "peak load" is given by the customer, should the model apply 1.25× to peak, skip headroom, or ask the customer to split peak vs continuous?

9. **Strict-minimum override** (customer says "at least", "minimum", "no less than" → force ceiling): per CLAUDE.md this rule was meant to ship but isn't in the current §9LV.4. Should it be added back?

10. **Tie-break rule example**: 30 kW / 50 kWh worked example shows 3 × SUN-12K. The tie-break rule says lowest count wins, so 2 × SUN-16K or 2 × SUN-20K should be the recommendation. Should the example be rewritten?

11. **HV is 3-phase only**: if a 1-phase site fails LV's phase-match check, the tree currently sends them to HV (which can't serve 1-phase). Should there be a dedicated "1-phase site needs scope reduction" branch?

12. **Customer names an HV-only SKU by model code** (e.g. "SUN-50K-SG01HP3"): §9.0 Check 1 only checks for the words "HV / high voltage / 48 V". Should it also catch model codes?

13. **`negotiation` reply context**: when a customer pushes for a discount, the right Sunny reply is "let me check with the team about the figure". The current code uses the wrong default. Confirm the right shape so I can build it.

14. **`big_project` is in the alert headers but no code path emits it**: do you actually want this routing, or should we remove the header entry to reduce the lie?

15. **Active Promos**: do you want this to be a real feature (admin tab, DB-backed, injected when active) or should §13 be deleted from the prompt?

---

## Roadmap

Each item is tagged with severity, effort, safety, and status.

- **Severity**: CRITICAL = currently breaking customer conversations; IMPORTANT = degrading quality but not breaking; POLISH = nice-to-have.
- **Effort**: SMALL = under 1 hour; MEDIUM = 1 to 4 hours; LARGE = multi-session.
- **Safety**: SAFE = purely defensive, no live-behavior risk; CARE = touches doctrine or routing, needs testing; RISKY = architectural, needs design first.
- **Status**: NEW = not started; PARTIAL = the four loop fixes covered part; DONE = already shipped this session.

### Tier 1, fix the live bugs (CRITICAL)

1. **B1: re-read `currentOpen` after `notifyOwnerForEscalation` so the silence cooldown actually starts on the first dealer_pricing turn.** Severity CRITICAL. Effort SMALL. Safety SAFE. Status NEW. One-line code fix in `processCustomerBatch`.

2. **B2: normalise legacy `pending_queries.created_at` to ISO, or add a fallback parser.** Severity CRITICAL. Effort SMALL. Safety SAFE. Status NEW. A one-time SQL UPDATE or a robust parser in `getOrAutoResolveStalePending`.

3. **B3: rewrite the 150/360 BOS-A worked example in §9HV.9 to obey the §19 even-split rule (12+12 per inverter, not 12+11), OR amend the §19 rule to allow uneven within-inverter splits.** Severity CRITICAL (model copies this pattern). Effort SMALL. Safety CARE (doctrine change). Status NEW. Depends on owner answer to Open Question 4.

4. **B4: fix the 200kWh BOS-G worked example in §9HV.9 to say 6 × 3U-RACK, not 3.** Severity CRITICAL (model under-counts racks). Effort SMALL. Safety SAFE (correcting a math error). Status NEW. Depends on owner confirmation that the rule is right (Open Question 3).

5. **B5: reconcile the §19 line 1014 6-line rule with the §9LV.6 4-line template.** Severity CRITICAL. Effort SMALL. Safety CARE (doctrine change). Status NEW. Depends on owner answer to Open Question 5.

6. **B6: rewrite the §9.0 Check 5 customer-facing template to remove the forbidden "32-pack ceiling" phrase.** Severity IMPORTANT (cleanup function probably catches but creates awkward output). Effort SMALL. Safety SAFE.

### Tier 2, fill the routing matrix (IMPORTANT)

7. **Wire `negotiation` reply context.** Add `buildNegotiationContext()` in `handler.js` (mirroring the dealer-pricing pattern). Reply shape: "Acknowledge the push, third-person 'the sales lead will reach out about the figure', no public figures, two sentences max." Severity IMPORTANT. Effort SMALL. Safety SAFE.

8. **Wire `repeat_complex` reply context.** Add `buildRepeatComplexContext()`. Reply shape: "Welcome them back by name if known, acknowledge the brother handles repeat clients personally, the team will reach out." Severity IMPORTANT. Effort SMALL. Safety SAFE.

9. **Decide on `big_project`: build it or kill it.** Either add a code-side promoter for load ≥ 30kW + commercial keywords, or remove `big_project` from `ESCALATION_HEADERS` to stop lying. Severity IMPORTANT. Effort SMALL (kill) or MEDIUM (build). Safety SAFE.

10. **Add `dealer_pricing` to the classifier.md schema enum.** Right now only the regex catches dealers; the LLM is blind. Severity IMPORTANT. Effort SMALL. Safety CARE (prompt change).

11. **Clean up dead prompt references.** Remove "Datasheet Knowledge block" from §5, §11, §17, §19, §20 (or rename to "per-item datasheet" to match reality). Remove `negotiation` and `big_project` blocks from §16 if the routing isn't being built. Severity IMPORTANT. Effort SMALL. Safety SAFE.

12. **Decide on `Active Promos`: build it or kill it.** Severity IMPORTANT (no failure today, will fail first time someone wants a promo). Effort SMALL (kill) or LARGE (build with admin tab + DB). Safety SAFE.

### Tier 3, §9 doctrine cleanup (IMPORTANT)

13. **Add the strict-minimum override back to §9LV.4 and §9HV.4.** Per CLAUDE.md, "at least / minimum / no less than" should force ceiling. The rule was lost in a rewrite. Severity IMPORTANT. Effort SMALL.

14. **Fix the §9LV.4 tie-break example.** Rewrite 30kW / 50kWh to show 2 × SUN-16K (or 2 × SUN-20K) as the recommended option, not 3 × SUN-12K. Severity IMPORTANT. Effort SMALL.

15. **Add a "no HV fits at all" worked example to §9HV.9.** Severity POLISH. Effort SMALL.

16. **Specify BOS-B rack-line wording.** Right now §9HV.3 says "confirmed with team" but §9HV.6 demands a Racks line. The model improvises. Severity IMPORTANT. Effort SMALL. Depends on owner Open Question 2.

17. **Reconcile §5 BOM example with §9 no-prices rule.** Either drop the `Total:` line from §5 or document that BOMs can include a total. Severity IMPORTANT. Effort SMALL.

18. **Add `→ floor N` arrow notation to the BOM cleanup function in `claude.js`.** This token appears in §9HV.9 internal examples and could leak. Severity POLISH. Effort SMALL.

### Tier 4, knowledge foundation (IMPORTANT)

19. **Add OCR fallback for image datasheets.** PNG / JPG / WEBP currently store empty `datasheet_text`. A Tesseract pass (or Anthropic vision extract) would let the model answer spec questions for image-only sheets. Severity IMPORTANT. Effort MEDIUM. Safety SAFE.

20. **Document `PENDING_QUERY_AUTO_EXPIRE_MINUTES` and `PENDING_QUERY_REPLY_SILENCE_MINUTES` in `.env.example` and CLAUDE.md.** Severity IMPORTANT. Effort SMALL. Safety SAFE.

21. **Add SMTP fallback to owner alert delivery.** When `notifyOwnerEscalation` returns ok=false, fire an email via the existing nodemailer setup. Severity IMPORTANT. Effort MEDIUM. Safety SAFE.

22. **Add Pidgin / Hausa / Yoruba phrasings to `HOT_TRIGGER_RE` and `buildConversationState` size extraction.** Severity IMPORTANT. Effort MEDIUM. Safety SAFE.

23. **Add prompt-shape validator at load time.** Reject an empty or under-100-character system.md / classifier.md and fall back to the previous good version. Severity IMPORTANT. Effort SMALL. Safety SAFE.

### Tier 5, architectural and observability (POLISH for now, IMPORTANT later)

24. **Split `processCustomerBatch` into named phases.** intake / classify / route / context / generate / validate / send / persist. Severity POLISH (the bugs come from the size). Effort LARGE. Safety RISKY.

25. **Add an LRU cap and periodic sweep to the seven in-memory Maps.** `rateLimitState`, `escalationState`, `hotEscalationState`, `followupState`, `imageState`, `_lastDropsByContact`, `CALL_AUTOREPLY_RECENT`. Severity POLISH (won't OOM in 30 days). Effort SMALL. Safety SAFE.

26. **Commit a test suite for the pure-logic modules.** `hv_validator.js` and `cleanupBomReply` are ideal candidates. Five test files (HV validator, BOM cleanup, classifier safety nets, pending-query lifecycle, security guards) per the foundation agent's recommendation. Severity POLISH but high payoff. Effort MEDIUM. Safety SAFE.

27. **Build the §9 worked-references crib sheet OUT of the live prompt.** Move §9LV.9 + §9HV.9 (69 lines) into `docs/internal_sizing_crib.md`. Stops the model from copying internal tokens into customer replies. Severity IMPORTANT. Effort MEDIUM. Safety CARE (doctrine change).

28. **Add a `closed_deals` table and admin-side flow for marking conversions.** Brother needs revenue attribution. Severity IMPORTANT for business value, not for current operations. Effort LARGE. Safety SAFE.

29. **Add a customer-side notification when pending_query expires at 24h.** Currently the customer is left in silence forever. Severity IMPORTANT. Effort SMALL. Safety SAFE.

30. **Add a startup-time prompt-vs-code consistency check.** Assert that every battery series in `hv_validator.js`'s constants (`MODULE_KWH`) is mentioned by name in `system.md`. Catches the drift that happens when §9 is rewritten and the validator isn't. Severity POLISH. Effort SMALL. Safety SAFE.

---

## Notes on safe execution

Looking at the roadmap, here's how the items break down by safety:

- **SAFE items (purely defensive, no live behavior change)**: B1, B2, B4 (math fix), 7, 8, 9 (kill version), 11, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26, 28, 29, 30. These can be executed one at a time as individual commits without risk to ongoing conversations.

- **CARE items (touches doctrine or routing, needs testing)**: B3, B5, B6, 10, 13, 14, 16, 27. Each needs the owner to confirm the doctrine call and then a careful prompt or code edit. The risk is doctrine drift, not pipeline breakage.

- **RISKY items (architectural, needs design first)**: 24. Should be its own brainstorm round.

For the items that depend on owner confirmation (Open Questions 1-15), the doctrine call has to come first before any code or prompt edit. Most of these are small once the answer is known.

---

## What changed since the deleted earlier audit

The earlier audit (deleted during the silent_query loop rollback) covered roughly the same ground for prompts (overlaps in §9, CTA tails, dead refs, §18 worked-example contradictions). This audit:

- Adds the §9 technical-correctness deep dive (rack rules, sizing math, decision tree integrity, worked-example math errors).
- Adds the routing matrix that surfaces the negotiation / repeat_complex / big_project gaps.
- Audits the four loop fixes pushed this afternoon and identifies two real edge cases (B1, B2).
- Adds the knowledge foundation findings (OCR gap, language gap, owner Q&A field gaps).
- Re-states the earlier audit's prompt-side findings (§18 CTA tails, dead refs, §19 vs §9 conflict) in a tighter roadmap form.

Everything from the earlier audit's punch list is preserved in this roadmap.
