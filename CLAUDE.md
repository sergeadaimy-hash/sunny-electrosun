# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

Detailed session-by-session changelog lives in `docs/session-history.md`. That file is the audit trail for "what shipped when and why"; this file is the always-true reference for what is currently in the codebase and what rules govern Sunny's behavior.

## Current launch status (rebuild in progress, 2026-05-13 Beirut)

Phase 1 (Setup), Phase 2 (Local end-to-end test), Phase 3 (Tune), Phase 5 (Cloud deploy) are closed.

**Session of 2026-05-13** tuned `src/prompts/system.md` with three owner-supplied refinements (no full prompt swap; targeted edits inside the existing v3 file). The pre-tune v3 was snapshotted to `docs/archive/system-v3-hv-configurator-2026-05-13.md` (518 lines, matches commit `bc4d1d4` on origin/main).

1. *Nigerian address forms in §4 (Voice and tone).* Sunny may now use "Sir" or "Oga" when the customer's name is not yet known. Rules: once per reply, drop them as soon as the customer shares a name, never stack ("Sir Oga"). Examples added inline.
2. *§9 Engineering principles tightened to match the owner's latest HV configurator spec.* Conflicts and overlaps with the previous v3 content resolved as follows:
   - *HV trigger* changed from "≥30kW inverter pulls system into HV" to "project needs more than 50 kWh of storage" as the third proactive HV trigger. The other two triggers (customer says HV, customer names an HV product) unchanged. Decision flow rewritten to match.
   - *BOS-G range* widened from 5–12 to 5–16 modules per cluster (PDU max is 16; 13–16 modules need 2 racks).
   - *BOS-B minimum* lifted from 5 to 7 modules per cluster, on both 30/50K and 80K inverter pairings. New hard rule: drop BOS-B silently if math gives <7 per cluster, use BOS-A or BOS-G instead.
   - *New "Clustering and racking rules" subsection* added: fewest clusters; balanced splits (24 → 12+12 not 16+8); multi-inverter setups split batteries evenly (32 BOS-A on 2 inverters → 16+16 not 21+11); 1 PDU per cluster; rack rule (≤12 = 1 rack, 13–16 = 2 racks, 17–21 BOS-A on 80K only = 2 racks).
   - *HV selection logic* rewritten as a 6-step flow ending in BOM card output. Includes a "Quick sanity checks" subsection (BOS-B ≥7?, BOS-G ≤16 with right rack count?, multi-inverter split even?, 1 PDU per cluster?).
   - *§5 HV BOM shape example* updated to comply: BOM cards now include a "Cluster split" line, and the 50kW/80kWh example replaces the old BOS-B (5 modules, would now be dropped) with BOS-G (16 modules, 2 racks); BOS-A example fixed to 1 PDU + 1 rack (was 2 PDU + 1 rack).
   - *§19 Hard nevers* gained four new entries to match: HV trigger rule restated; BOS-B never <7; never split clusters unevenly; never miscount racks (≤12 = 1 rack, 13+ = 2 racks, 1 PDU per cluster always).
3. *§9 Optimal module count subsection added* (driven by a live failure case where Sunny picked 14 BOS-A modules for a 100 kWh target — overshooting by 7.5% and dragging in an extra PDU). New rule: for each series, compute BOTH the upper count (ceil) and the lower count (floor). Prefer the lower count when (a) undershoot is ≤3% of target, OR (b) the upper count would force an extra cluster, rack, or inverter that the lower count avoids. The lower count must still meet the series minimum per cluster. Strict-minimum wording from the customer ("at least", "minimum", "no less than") overrides the rule and forces upper. Section includes four worked examples (100 kWh / 95 kWh / 80 kWh / 120 kWh) marked as internal-only. Step 2 of HV selection logic rewritten to call out the rule. *§19 Hard nevers* gained one matching entry: never blindly ceil; apply Optimal module count. *Quick sanity checks* gained an "Did I apply Optimal module count?" first bullet.

Live commit: `e3d361f` (pushed 2026-05-13 morning Beirut).

**Same day, second push (2026-05-13 late morning Beirut)** addressed three live-test failures the brother flagged:

A. *Welcome card swallowed the customer's first-turn question.* Live case: customer wrote "Good morning, Is 16kwh Deye lithium battery available?" — Sunny sent only the hardcoded welcome card and ignored the question. Root cause: `src/handler.js > processCustomerBatch` always sent the welcome card and `return`ed on the first message of every fresh conversation, regardless of whether the message had substantive content beyond the greeting. Fix: detect `firstMessageIsPureGreeting = handlerIsGreeting(combinedText)`. If TRUE → keep current behavior (welcome card, then return). If FALSE → send the welcome card AND fall through to the Opus reply path. A new `welcomeCardJustSent` flag bubbles into the `generateReply` call as an `expertContext` prefix: "WELCOME-ALREADY-SENT context: A welcome card with our addresses and contacts was just sent. Do NOT greet again. Do NOT repeat any address or phone number. Answer the customer's actual question directly in 1 to 2 short sentences." Net effect on the brother's case: customer now gets TWO outbound messages on first turn (welcome card + direct answer to "Is 16kWh Deye battery available?").

B. *BOS-B card shown at 5 modules per cluster.* Live case: 160 kWh BOM offered BOS-B as Option 2 at 10 modules in 2 clusters (5 per cluster) — violates BOS-B min 7. The rule was already in §9 four places (table notes, selection logic step 4, sanity checks, hard never) but the model bypassed it. Strengthened by adding a "STOP — pre-flight checks before sending ANY HV BOM" block at the top of §9 (right after the section intro, before the inverter table) listing the six most-violated rules numbered with explicit instructions to drop the card if any fails. BOS-B min 7 is rule #1.

C. *BOS-G option in BOM omitted the rack count and pricing.* Live case: BOS-G card listed Inverter / Battery / PDU but no Racks line. §5 BOM template already required a Racks line, but the model dropped it. Strengthened the BOM card spec in §5: every card MUST include all six lines (Inverter, Battery, Cluster split, Control Box, Racks, Cables) in order. Per-line price math (unit × qty) is now required when prices are in Warehouse Stock, with explicit fallback wording when rack pricing isn't on file: "Racks (19″): N (rack pricing confirmed with the team)". §19 hard nevers gained a matching entry banning BOM cards without a Racks line. Pre-flight rule #2 in §9 reiterates.

Live commits: `a52b0be` (welcome + BOM rules) and `c31006f` (archive cleanup) pushed 2026-05-13.

**Same day, third push (2026-05-13 early afternoon Beirut)** addressed a per-series rack mapping error. Live case: 13 BOS-A modules in one cluster, Sunny said "Racks (19″): 2 × 550k = 1.10M NGN" — but 13 BOS-A modules fit in 1× BOS-A-RACK14 (one rack, 550k NGN). The generic "13+ modules = 2 racks" rule from the previous prompt was a BOS-G assumption that doesn't apply to BOS-A. The brother specified the rack facts:

- 3U rack is BOS-G only (NOT BOS-A, NOT BOS-B).
- BOS-A uses two specific rack SKUs: BOS-A-RACK11 (11 batteries + 1 PDU) and BOS-A-RACK14 (13 batteries + 1 PDU).
- BOS-B rack hardware not yet specified (treated as "confirmed with team").

Changes in `src/prompts/system.md`:
- New §9 subsection *Rack rules by series* with explicit per-series rack tables (3U for BOS-G, RACK11/RACK14 for BOS-A, "confirmed with team" for BOS-B).
- §9 series table notes column now points at the rack hardware per series.
- §9 *Clustering rules* rule #5 rewritten to point at the per-series rack table and explicitly forbid the generic "13+ = 2 racks" rule for BOS-A.
- §9 *STOP — pre-flight checks* rule #4 rewritten to enumerate per-series rack rules.
- §9 *HV selection logic* step 5 rewritten the same way.
- §9 *Quick sanity checks* gained a BOS-A-specific check ("RACK11 for ≤11, RACK14 for 12–13, 2× RACK11 for 14–22? NOT 3U.").
- §9 *Optimal module count* worked examples refreshed: the 100 kWh BOS-A case now correctly shows upper-14 needing 2× RACK11 vs lower-13 needing 1× RACK14, so rule (b) now also fires alongside (a). The 95 kWh case shows both upper-13 and lower-12 fitting in 1× RACK14 (no rack saved).
- §5 BOM template *Racks* line now requires the explicit SKU for BOS-A and "Racks (3U): N" wording for BOS-G; BOS-B uses "Racks: N (rack hardware confirmed with the team)".
- §5 example BOM cards updated: BOS-A 11-module option shows "Racks: 1× BOS-A-RACK11", BOS-G 16-module option shows "Racks (3U): 2".
- §19 hard never about rack counts rewritten to point at the per-series table and explicitly forbid 3U for BOS-A.

This push is uncommitted on local main. Serge will push.

**Same day, fourth tune (2026-05-13 afternoon Beirut), pending Serge push:** swapped §9 entirely with the owner-supplied "Deye HV Inverter & Battery Configurator v2" content. The previous §9 + §5 HV BOM shape + related §19 nevers were snapshotted to `docs/archive/system-hv-section-2026-05-13-before-configurator-v2.md`.

Material changes in this swap (vs the just-shipped state):

- *Optimal module count rule RETIRED.* Sizing now uses pure ceil(total kWh ÷ module kWh) plus even cluster balancing. The earlier "round down within 3%" optimization is gone. Per the owner's worked reference: 230 kWh BOS-A → 30 modules round to 32 (balanced 8+8+8+8), not 28 or 29.
- *BOS-A rack capacities updated.* BOS-A-RACK11 holds 10 batteries + 1 PDU (was 11). BOS-A-RACK14 holds 13 batteries + 1 PDU (unchanged).
- *BOS-A rack picking rule rewritten.* 7-10 modules → 1× RACK11, 11-13 modules → 1× RACK14, 14-16 modules → 1× RACK14 + 1× RACK11, 17-21 modules → 2× RACK14. Previously: 1× RACK11 for 1-11 / 1× RACK14 for 12-13 / 2× RACK11 for 14-22.
- *BOS-G module SKU named:* BOS-G-PACK 5.1 (51.2 V, 100 Ah, LiFePO4). BOS-G rack SKU named: 3U-RACK.
- *Inverter table gains a Battery voltage column* (160 to 700/800/1000 V) and a footnote on three-phase 380/400 V, 50/60 Hz, IP65, up-to-10 parallel.
- *BOM output format simplified.* No per-line price math in BOM cards. Prices remain governed by §6 (quote only on explicit ask).
- *New §9.9 worked reference* (100 kW / 230 kWh, 2× 50K) embedded as an internal sanity check across BOS-A / BOS-B / BOS-G with recommended option.
- *§19 cleaned:* dropped the "Never blindly use ceil" never (Optimal module count retired). Rack-counting never rewritten with the new BOS-A sizing guide.

This tune is uncommitted on local main, waiting on the user's push.

**Session of 2026-05-12 (evening, third push of the day)** swapped `src/prompts/system.md` to v3 with owner-supplied HV configurator content from the new "Deye HV Battery Selection" spec. The v2 distributor-counter prompt was archived to `docs/archive/system-v2-distributor-counter-2026-05-12.md`. Changes are confined to three sections, nothing else in the file touched:

- §5 Reply length and rhythm: added a second structured-reply shape, the *HV BOM card format*. Used when the customer asks for HV sizing. Format: one project-confirmation line, one BOM card per viable battery series (Inverter / Battery / Control Box / Racks / Cables), one-line recommendation. The existing generic "~50kW" example stays for non-HV configs.
- §9 Engineering principles: rewrote with concrete Deye HV product limits inlined instead of delegating everything to Datasheet Knowledge. New content: HV vs LV gate clarified ("HV vs LV is determined by the inverter selection, NEVER by battery capacity"; ≥30kW = HV, <30kW = LV). New inverter capacity table (SUN-30K/50K/80K with cluster inputs + max charge/discharge amps). New battery series table (BOS-G/A/B with module size + Min-Max per cluster, differentiated by paired inverter). New 5-step sizing logic replaces the old 4-step verification. New rules: drop unviable series silently, don't show calculations unless asked, parallel inverters only with the SAME model.
- §19 Hard nevers: added two entries. "Never show sizing math/cluster calculations/step-by-step reasoning in the reply unless the customer asks how you sized it." "Never offer or quote an HV battery option that violates the Min-Max range — drop it silently, don't announce it."

Live commit on origin/main BEFORE this prompt change: `1f2ef50` (datasheet marker fix). The HV configurator commit is local-only pending Serge's push.

**Earlier same day (late afternoon)** patched two recurring production bugs the brother flagged from live tests: (1) Sunny invented size+phase combos that don't exist in the warehouse ("20kW single-phase incoming within 20 days" when only 20kW 3-phase is stocked), and (2) HOT-lead alerts to the owner silently dropped on `notifyOwnerForEscalation` whenever an open `pending_queries` row existed (the second escalation got routed as a silent_query follow-up ping instead of a fresh `escalation_alert_hot`). Pending commit (uncommitted on local main; Serge will push):

- `src/prompts/system.md` section 8 (Stock) extended with a strict VARIANT rule and an ETA discipline rule. Variant rule: if a SIZE+PHASE / SIZE+VOLTAGE combo doesn't have a matching row in Warehouse Stock, do NOT say it's incoming and do NOT invent an ETA; state the closest combo we DO carry. ETA rule: only quote ETAs that appear VERBATIM in `coming_note` / `eta_date` for the matched item; if no ETA on file, say "incoming" alone with no day count, no week phrase, no "soon", no "shortly". Section 19 (Hard nevers) gained two matching items.
- `src/classifier.js` got an unconditional HOT promotion: if the customer's CURRENT message body contains a `HOT_TRIGGER_RE` commitment phrase ("send me account", "i want to pay", "pay now", "send proforma", etc.), promote to HOT regardless of what the Sonnet classifier returned and regardless of what Sunny said previously. Logged as `classifier.commitment_phrase_force_promoted_to_hot`. Backstop covers the failure mode where the prior-Sunny-question regex `HOT_PROMPT_FROM_SUNNY_RE` missed (e.g. "Want to place a pre-order to secure a unit?" wasn't in the regex, so a "Yes send me account" affirmation didn't promote). Also widened `HOT_PROMPT_FROM_SUNNY_RE` to include "place a pre-order", "secure a unit", "lock it in", "want to (place|secure|reserve)", "pickup or delivery", "how would you like to pay", etc.
- `src/security.js` added `HOT_ESCALATION_COOLDOWN_MS` (default 60s, env override `HOT_ESCALATION_COOLDOWN_MS`) and `checkHotEscalationThrottle(contactId)`. HOT escalations now use the 60s throttle instead of the 30-min `ESCALATION_COOLDOWN_MS`. Reason: the regular cooldown was eating real HOT alerts when a customer escalated twice in the same 30-min window. A HOT signal must always reach the owner; the 60s cap is only to defang back-to-back identical retries.
- `src/handler.js > notifyOwnerForEscalation`: HOT routes through `checkHotEscalationThrottle` (60s), non-HOT through the regular 30-min throttle. HOT alerts also get one automatic retry after 1.5s if the first Meta send fails (`handler.escalation.hot_alert_first_send_failed_retrying`).
- `src/handler.js > processCustomerBatch` reply backstop: split into `HOT_HANDOFF_REPLY_RE` (HOT-specific markers like "account details and final figures", "send you the account") and the existing `HANDOFF_REPLY_RE` (generic team-follow-up markers). HOT backstop runs FIRST and is NOT satisfied by a silent_query follow-up ping having fired this turn — it requires `escResult.escalationType === 'hot_lead'` AND `ownerNotified=true`. If a HOT marker is in the reply and no hot_lead alert has fired this turn, fire one (source `hot_handoff_in_reply`). This is the bug that let "Yes send me account" get demoted to a silent-query follow-up ping on an old QID instead of escalating as a fresh HOT.
- `src/claude.js > detectFabricatedVariant`: new code-level guard. For every (size + phase + stock-state) claim in the generated reply, verify a matching row exists in `warehouse_items` (matching BOTH the size and the phase/voltage). If no match AND the surrounding context isn't a negation ("we don't have", "stops at", "only in three-phase", etc.), the reply is replaced with "Let me confirm the exact availability of that configuration with the team and get back to you shortly." Logs `claude.reply.fabricated_variant_blocked`. The deflection contains "get back to you shortly", which the existing reply-handoff backstop in `handler.js` then catches and escalates as silent_query so the owner is alerted, the customer gets a sane reply, and Sunny never communicates the hallucinated combo.

**Earlier same day (2026-05-12 midday)** swapped both master prompts to owner-supplied versions and enriched owner escalation alerts. Latest commit on origin/main as of midday: `d89ca2c`. Three commits at that point:

- `ce8df82` Classifier prompt swap to HOT/SERIOUS/COLD/DISQUALIFIED/REPEAT_CLIENT vocabulary. Old C1-C5 schema archived at `docs/archive/classifier-v1-c1-to-c5-2026-05-12.md`. New `normalizeClassifierShape` in `src/classifier.js` derives the legacy `lead_temperature` from the new `category` (SERIOUS→WARM) so every downstream consumer keeps working without changes. Greeting fast-path and `FALLBACK_CLASSIFICATION` updated to new shape.
- `192a161` System reply prompt swap to "distributor counter rep v2". Old version archived at `docs/archive/system-v1-19sections-2026-05-12.md`. Key shifts: install discussion strict-refused under 30kW; 30kW+ routes to specialist for EPC; ALL negotiation escalates to human; HV defaults flipped to LV-first for residential; WARM renamed to SERIOUS.
- `d89ca2c` Owner escalation alerts now include typed headers (HOT/NEGOTIATION/REPEAT/BIG-PROJECT/FOLLOW-UP), customer signals, latest message, 6-turn conversation brief, an admin deep-link of the form `<PUBLIC_BASE_URL>/admin#conv=<id>`, and the customer wa.me link. New env var `PUBLIC_BASE_URL` (defaults to the Railway URL when unset). Admin SPA auto-selects the linked conversation on hash change.

Code adaptation backlog (new prompts reference these but the code does not yet honor them):
- Routing for `escalation_type='negotiation'` / `'repeat_complex'` / `'big_project'` currently falls through the silent_query pending-queries flow (header label is correct via `ESCALATION_HEADERS`, but routing is generic).
- `Active Promos`, `Big project context`, structured `Datasheet Knowledge` injection blocks not yet built.
- `contacts.category` rows now mix C1-C5 (legacy) with HOT/SERIOUS/COLD (new). Admin filters for C* still work for legacy rows.

**Earlier in the rebuild** (2026-05-10 session, per `docs/archive/agent-redesign-roadmap-2026-05-09.md`): see commit `88d5a84` and the seven-step summary archived in `memory/project_pickup_2026-05-10.md`. Highlights:

1. **Warehouse Stock** is now the single source of truth for stock + price + datasheets. New top-level admin tab with per-item Abuja/Lagos panels (state in_stock/incoming/out_of_stock, quantity +/-, coming note, ETA date) and a per-item datasheet PDF upload. `formatWarehouseForPrompt()` replaces the catalog block in Sunny's prompt. Catalog table preserved but its prompt block is no longer injected.
2. **Knowledge tab stripped** to two sub-panels: **Rules** (editable per-prompt textareas with Save = git commit+push via GitHub Contents API, Deploy = Railway GraphQL `serviceInstanceRedeploy`) and **Models & config**. Live facts, Catalog, Datasheets sub-panels and the owner-DM teaching path retired. `teacher.md` dropped from the editor. Doctrine now lives entirely inside `system.md`.
3. **system.md restructured into 19 single-purpose sections** (407 lines, down from 621). Sections are: 1 Identity, 2 Posture, 3 Voice and tone, 4 Reply length and rhythm, 5 Pricing rules, 6 Negotiation forbidden, 7 Stock and availability, 8 Solar engineering, 9 Locations/pickup/delivery, 10 Escalation, 11 Dynamic context blocks, 12 Conversation state, 13 Multi-idea + anti-repeat, 14 How to read the customer, 15 Industry knowledge, 16 Worked examples, 17 Hard nevers, 18 Punctuation, 19 When unsure. Each section is editable independently from admin.
4. **Voice softened** to "warm Lagos salesman" tone. Brief acknowledgements ("Got it", "Glad to help", "Sure") explicitly allowed. Empty hype + AI-speak still banned. Reply-length cap loosened from "max 2 sentences" to "1 to 3 sentences with one optional follow-up question." Code-level trailing-question guard now fires only on pure acknowledgements (ok/noted/thanks/emoji), not on factual answers like "30kwh" or "Lagos".
5. **Stock quantity privacy.** Section 7 rule + section 17 hard never: the per-warehouse unit count in the Warehouse Stock block is INTERNAL ONLY. Default reply for stock questions is "in stock" / "out of stock" / "incoming, ETA <date>" with no numbers. Quantity is shared ONLY when the customer's requested quantity exceeds available stock (to gate the deal).
6. **Datasheet matcher gates on customer-named size.** `findItemDatasheetByQuery` extracts numeric size tokens ("80kw", "12.5kva", "16kwh") and requires the warehouse item to share that size before matching. Legacy single-item fallback removed. If the requested datasheet isn't attached, Sunny falls through to a text reply rather than sending the wrong PDF.
7. **Owner alerts pared to HOT-only.** `notifyOwnerForEscalation` returns early for anything that isn't `escalation_type='hot_lead'`. No silent_query pings, no follow-up alerts, no stall-guard pings, no QID tags, no pending_queries row creation. Alert format simplified to 4 lines: header + customer name/phone + their last message verbatim + customer wa.me link.
8. **Customer-side wa.me link** is auto-appended on BOTH hot_lead and silent_query escalations (previously HOT-only). So the customer always has a one-tap path to reach the owner via `SPECIALIST_DIRECT_LINK`.

**Phase 5 is cloud-first** (Railway production). PM2 + named tunnel are no longer in the production path; PM2 stays in the repo as a local-dev fallback only. See `memory/project_cloud_first_decision.md`.

**Live state on Railway:**
- URL: https://sunny-electrosun-production.up.railway.app
- Volume `/data` mounts the SQLite DB at `/data/sunny.db`, media at `/data/media/`, and datasheets at `/data/datasheets/`.
- **NEW WABA `986225450549617`** ("Sunny-Electrosun"). Test WABA `1713234916358524` retired (Meta hard-locks test numbers to test WABAs; cannot be deleted). Migration completed 2026-05-08.
- **NEW production phone `+234 913 055 4747`** (phone_number_id `1143874562134501`). `code_verification_status: VERIFIED`, `platform_type: CLOUD_API`, `quality_rating: GREEN`, `name_status: PENDING_REVIEW` (display name "ELECTROSUN" awaiting Meta review, does not block sending; customers see raw number until approved).
- Cloud API registration PIN: `271828` (saved as `META_REGISTRATION_PIN` on Railway and local .env). Needed if Meta forces re-register.
- Templates re-submitted under new WABA: `owner_hourly_report_en` id `26625377877146589` PENDING, `follow_up_24h_en` id `1722973542453762` PENDING.
- `OWNER_WHATSAPP=2347041328055` (brother). Verified via `/version` → `owner_whatsapp_tail: "8055"`. **Important: brother must accept the chat from "Message Requests" the first time. Until accepted, alerts are delivered but sit in his Message Requests folder, not main chat list.**
- `SPECIALIST_DIRECT_LINK=+234 704 132 8055` (brother's number, used for wa.me handoff link on HOT replies).
- `DISABLE_NOTIFICATIONS=true` (kill switch ON: report crons don't register at boot). Customer pipeline + auto-release cron still active.
- `OPENAI_API_KEY` provided 2026-05-08 but currently INVALID (HTTP 401 from Whisper). Need fresh key with billing credit OR full-access non-project key. Voice notes fall back to "[Customer sent a voice note that could not be transcribed]" until fixed.
- Model assignments live on Railway (set 2026-05-09): `MODEL_REPLY=claude-opus-4-7` (customer-facing, where rule-following margin matters); `MODEL_CLASSIFIER`, `MODEL_TEACHER`, `MODEL_OWNER_QA` all set to `claude-sonnet-4-6` for ~50-60% cost reduction. Code-level fallback in `src/claude.js`/`src/knowledge.js`/`src/owner_qa.js` still defaults to `claude-opus-4-7` if any env override is removed. Plan: after Task #15 soak shows the new no-fake-team-paging and no-negotiation rules holding under load, consider flipping `MODEL_REPLY` to Sonnet too.
- `DAILY_LLM_BUDGET_USD=20`.
- `DISABLE_ESCALATIONS=false` (kill switch available, not engaged).
- `HUMAN_AUTO_RELEASE_MINUTES=15` (default; tunable).

**Source of truth:** https://github.com/sergeadaimy-hash/sunny-electrosun (private). Pushes from Claude's non-interactive shell hang on the credential prompt; Serge pushes manually with `git push` from his Terminal or `! git push` syntax in chat. Latest commit on origin/main: `88d5a84` (2026-05-10 evening Beirut).

**Resume plan:**
- Brother needs to accept the Sunny chat from his WhatsApp Message Requests folder so alert notifications surface in his main chat list.
- Fix OpenAI key: add billing credit at platform.openai.com, or generate fresh non-project key, then `railway variables --set "OPENAI_API_KEY=sk-..."` + `railway redeploy --yes`. Confirm via voice-note send to +234 913 055 4747; expect `transcribe.ok` log.
- Brother to upload datasheets via admin → Knowledge → Datasheets tab (PDF/PNG/JPG/WEBP up to 15MB). Once uploaded, Sunny auto-attaches the matching file when customer asks for "datasheet" / "brochure" / "specs".
- Brother's pending pricing data: Sungrow, JA, Longi, Jinko panels.
- Section 11 decisions still pending (working hours, location tags, currency, default warranty/delivery copy, after-hours reply, competitor pricing doctrine).
- Display name "ELECTROSUN" review with Meta (1-3 business days from 2026-05-08). After approval customers see "ELECTROSUN" instead of raw number.
- Task #15 48-hour soak with 3-5 testers.
- Code nice-to-haves: hot-lead alert with conversation summary; admin "approve to permanent fact" button on daily learning items; per-contact avatar color hashing; image inline rendering in admin; RAG-style fact retrieval if knowledge base exceeds the 500-fact cap; re-enable owner teaching from WhatsApp with intent disambiguation; rotate the OpenAI key currently exposed in chat transcript.

## Current operational rules and configuration

This section captures behavior rules and runtime config that are LIVE in the codebase right now. The deeper "why we shipped this" notes are in `docs/session-history.md`.

### Voice and reply discipline (enforced in `src/prompts/system.md`)

- **No double dashes anywhere.** Permanent user rule (2026-04-26). No em-dash, en-dash, or `--`. Applies to chat replies, prompts, code comments, commit messages, every artifact. CSS custom properties (`--cream`) are the only allowed exception.
- **No compliments, no AI-speak, no subjective phrases.** Banned: "Great", "Excellent", "Awesome", "Perfect", "I'd be happy to help", "I love that", "I understand", "I see", "Let me help you with that", "Feel free to", "Hope this helps", "Just to clarify", "Certainly", "indeed", "moreover", "delve". No unsolicited adjectives on the customer's project. Tone: Lagos sales floor.
- **HARD BAN on trailing questions.** When customer gives a short factual answer (≤40 chars, no `?`), Sunny acknowledges and STOPS. Never squeezes another question. Code-level guard in `src/claude.js` strips trailing question sentences if the prompt rule is violated.
- **Reply length: max 2 short sentences by default.** No bullet lists, no proactive education, no multi-paragraph essays. `max_tokens=600` in `src/claude.js` (raised from 220 on 2026-05-11 after a structured sizing reply got truncated mid-bullet; the prompt rule, not the cap, is what keeps replies short).
- **Pricing discipline.** No proactive prices. Only quote if customer explicitly asks ("how much", "price/prices/pricing", "cost/costs", "naira", "NGN", "quotation/quote", "rate", "total", "invoice", "proforma"). Quote ONLY the specific item asked, never adjacent products, never produce a price list. Code-level guard strips price patterns when customer didn't ask. The guard also looks back at the previous 2 customer messages so a follow-up like "what about the battery?" after a price ask is treated as continuing the pricing flow.
- **Catalog fidelity.** Use exact catalog model strings and capacities verbatim. Never invent kWh/kW figures, never swap between models (BOS-A is 7.68kWh; BOS-B Pro is 16kWh).
- **Engineering rules.** Inverters can ONLY be paralleled if SAME size, max 10 units. Valid: 7 x 50kW = 350kW. Invalid: 4 x 80kW + 1 x 30kW.
- **Phone numbers never proactive.** Patrick `07041328055`, Charbel `09068859213`, Lagos `0911 188 0000` only on explicit "call me" / "your number" / HOT lead.
- **Addresses ARE shared on location/branch/office/pickup/visit/warehouse questions.** Abuja office: Wuse 2. Abuja warehouse: Plot 816, Idu Industrial Area. Lagos office: Rutam House. Top-of-prompt "Electro-Sun locations" block, never pruned.
- **Pickup vs delivery.** When asked where to get the product: ask if pickup from Abuja warehouse, Lagos warehouse, or delivery (delivery fees excluded, charged separately).
- **Best-price scripted answer.** "Yes, this is our best price. Are you ready to pay now?" If yes → HOT lead. If no → acknowledge and stop pushing.
- **No wa.me URLs in replies.** System handles handoff via separate canned messages. `scrubHistoryContent()` strips wa.me URLs from prior assistant messages so Opus can't pattern-match on them.
- **Greetings get fresh greetings.** Empty conversation history sent to Opus, "Known about this customer" context block suppressed (except name). Don't anchor on prior products/categories/temperatures unless customer references them.
- **Prices source = catalog table.** Never quote a price from owner-taught knowledge or "Past quote" entries. Past quotes are historical only.

### Conversation-state engine (`src/claude.js > buildConversationState`)

Before each Opus reply call, `buildConversationState(history, currentMessage)` builds a structured world model and injects it as a system block:
- Facts the customer shared: system size (kW/kVA), battery kWh, phase, brand mentions, project type, location, installer-vs-end-user signal.
- Questions Sunny has ALREADY asked (do NOT re-ask): installer-or-end-user, phase, location, load/quantity, budget, timeline.
- Customer asks/questions in the current message: extracted by question-mark + question-word heuristics.

`src/prompts/system.md` has matching sections: "How to use the Conversation state block", "Handling messages with multiple ideas", "Anti-repeat rule".

### Code-level reply guards (`src/claude.js`)

After Opus generates a reply, before sending:
1. **Price-dump guard**: if neither the current message nor the previous 2 customer messages contain a price-ask keyword AND reply has at least 1 price pattern, STRIP price patterns. If the strip leaves dangling labels (e.g. "Deye 16kW:.") the reply falls back to "Could you share more about your project so I can guide you better?" instead of sending the gibberish. Logs `claude.reply.prices_stripped` with `dangling_label` flag.
2. **Repeat guard**: if new reply is byte-identical to the last outbound, overwrite with "Apologies, let me re-read your last message."
3. **Trailing-question strip**: if customer's last message is short factual (≤40 chars, no `?`) and reply ends with `?`, strip the trailing question sentence. Logs `claude.reply.trailing_question_stripped`.
4. **wa.me URL strip**: any wa.me link Opus emits gets removed.
5. **Prompt-leak detector** (`security.detectPromptLeak`): if the reply contains markers from the system prompt or internals (`Lagos sales floor`, `system prompt`, `claude-opus-4`, `OWNER_WHATSAPP`, `lead_temperature`, etc.), replace with a generic deflection. Logs `security.prompt_leak_blocked`.
6. **Owner-number leak detector** (`security.detectOwnerNumberLeak`): if the reply contains `OWNER_WHATSAPP` digits anywhere outside the canonical `wa.me/<number>` URL, replace with a generic deflection. Logs `security.owner_number_leak_blocked`.
7. **Phone-list-dump block**: if reply contains 3+ Nigerian-format phone numbers, replace with a deflection. Logs `security.phone_list_dump_blocked`.
8. **Catalog enumeration block**: if reply contains 5+ price patterns, replace with "Could you tell me which model or system size you need? I'll quote that one." Defends bulk catalog extraction. Logs `security.catalog_enumeration_blocked`.

### Security layer (`src/security.js`)

Single module exposing rate limits, length caps, injection-attempt detection, and output-side leak detection. All defaults configurable via env vars; all triggers logged with `security.*` keys for observability.

**Input-side guards (in `src/handler.js > handleInbound`):**
- `security.checkRateLimit(contactId)`: per-contact rate limit. Default 15 messages/minute (`RATE_LIMIT_PER_MINUTE`) and 300/day (`RATE_LIMIT_DAILY`). Owner is exempt. Blocked messages are dropped without persistence or reply. Logs `security.rate_limit_blocked`.
- `security.checkImageQuota(contactId)`: per-contact daily image-vision quota. Default 10/day (`MAX_IMAGES_PER_DAY`). When exceeded, the image is converted to a text marker so the message still flows, but vision is skipped. Logs `security.image_quota_exceeded`.
- `security.truncateInbound(text)`: caps single inbound message at 2000 chars (`MAX_SINGLE_MESSAGE_CHARS`). Logs `security.inbound_truncated`.
- `security.detectInjectionAttempt(text)`: scans for classic prompt-injection phrases ("ignore previous", "system prompt", "you are now", "DAN mode", `<system>` tags, etc.). Logs `security.injection_attempt_detected` with matched patterns. Detection is observability-only, does NOT block; Opus's own resistance plus the output-side leak detectors handle blocking.

**Batch-level guards (in `src/handler.js > processCustomerBatch`):**
- `security.truncateBatch(text)`: caps the combined debounced batch at 4000 chars (`MAX_COMBINED_BATCH_CHARS`). Logs `security.batch_truncated`.
- `security.checkEscalationThrottle(contactId)`: at most one BRAND-NEW escalation alert per contact per 30 minutes (`ESCALATION_COOLDOWN_MS`). Defends specialist-spam attacks against the brother's WhatsApp. Logs `security.escalation_throttled`.
- `security.checkFollowupThrottle(contactId)`: at most one FOLLOW-UP ping per contact per 5 minutes (`FOLLOWUP_COOLDOWN_MS`). Used by the open-pending-query path so the brother gets a heads-up when the same customer keeps pushing on an unresolved query, without flooding. Logs `security.followup_throttled`.
- `notifyOwnerForEscalation` (in `src/handler.js`, replaces the older `dispatchEscalation`): single entry point for OWNER-side notification. **No longer touches the customer reply.** Returns `{ openPending, freshPendingId, ownerNotified, escalationType, throttled }`. Behavior:
  1. If an open `pending_queries` row already exists for this contact (`getOpenPendingQueryForContact`), send a "Follow-up on [QID:N], same customer is still asking" message to the owner (throttled by `checkFollowupThrottle`), do NOT create a new pending_queries row, do NOT touch the main escalation throttle.
  2. If no open pending query, fall through to `checkEscalationThrottle`. If allowed, create the pending_queries row and send the regular alert.
  The customer reply is now ALWAYS produced by `generateReply` with an `expertContext` block (see below), never by a hard-coded canned line. Reason: the old canned-reply behavior made Sunny look like a robot when customers pushed back on an open query ("When?", "It's been a day"); each follow-up got the same word-for-word "A specialist will confirm the exact figure for you shortly." reply. The new flow lets the LLM react to the actual customer message under tight constraints (third person, no first-person stalls, no invented prices/ETAs).

**Output-side guards (in `src/claude.js > generateReply`):** see "Code-level reply guards" above, items 5-8.

**Stall-language guard (in `src/handler.js > processCustomerBatch`):** after `generateReply` returns, before sending, `security.detectStallLanguage(reply.text)` checks for first-person stall patterns ("let me check / I'll confirm / will revert / will get back to you / one of our sales engineers will reach out / give me a moment"). The guard only runs when no `expertContext` was already injected (i.e. the LLM was on a normal reply path and stalled anyway). If matched AND `DISABLE_ESCALATIONS=false`:
- Call `notifyOwnerForEscalation` with `escalation_type='silent_query'` and `source='stall_guard'` to ping the owner and create a pending_queries row (or follow up on an existing one).
- Re-call `generateReply` with the freshly built `expertContext` ("Awaiting expert input" block). If the regenerated reply is stall-free, send it.
- If regeneration fails or still stalls, send a single short generic ack: "Noted. The team is on it." Logs `handler.stall_regen_failed_used_generic_ack` or `handler.stall_replaced_no_alert`.
Reason: previously the stall-guard fell back to the canned `SILENT_QUERY_REPLY`, which is the very behavior we are trying to eliminate. Now the guard re-runs the LLM under explicit awaiting-expert constraints; the canned line only appears as a final last-resort ack when the LLM keeps refusing to honor the block.

**Expert context block (`buildExpertContext` in `src/handler.js`).** Built per turn, injected into `generateReply` as `options.expertContext`:
- HOT lead variant: tells Sunny the customer is ready to commit; instructs a one-sentence acknowledgement, third-person handoff to specialist, no URLs (system appends the wa.me link automatically).
- Awaiting-expert variant: lists the open pending query text, wait time so far ("3h 12m"), and voice rules (acknowledge what customer JUST wrote, third person, no first-person stalls, no invented prices/ETAs, empathize on frustration without over-apologizing, two sentences max, vary phrasing across replies).
The block is ALSO documented in `src/prompts/system.md` ("Dynamic context blocks the system may inject") so Sunny has a stable reference even if the per-turn block is somehow missing.

**HOT-lead wa.me link**: for HOT escalations, `processCustomerBatch` appends `\n\nDirect line to the specialist: <wa.me link>` to the LLM-generated reply text just before send. The link is built from `SPECIALIST_DIRECT_LINK` env var; the LLM is explicitly instructed not to produce URLs.

### Kill switches and runtime overrides (Railway env vars)

| Env var | Effect |
|---|---|
| `DISABLE_NOTIFICATIONS=true` | Cron schedules don't register at boot. No 2-hour reports, no daily report, no daily learning, no window-monitor scan. Customer pipeline unaffected. Logs `cron.all_schedules_skipped_at_boot` once. |
| `DISABLE_ESCALATIONS=true` | All escalations (hot_lead, silent_query) get demoted to normal Sonnet/Opus replies. Useful for testing without canned holding messages firing. |
| `MODEL_CLASSIFIER`, `MODEL_REPLY`, `MODEL_TEACHER`, `MODEL_OWNER_QA` | Override the four Opus defaults selectively. E.g. `MODEL_REPLY=claude-sonnet-4-6` to step back if budget tightens. |
| `MESSAGE_DEBOUNCE_MS` | Per-contact debounce window in ms (default 6000). When customer sends multiple messages back-to-back, classification + reply fires ONCE per window with combined input `[Customer sent N messages back to back]\nmsg1\nmsg2\nmsg3`. |
| `DAILY_LLM_BUDGET_USD` | Soft daily cap (currently 20). `src/cost_tracker.js > isOverBudget` short-circuits classify and generateReply to fallback paths when daily spend exceeds it. |
| `KNOWLEDGE_PROMPT_MAX_FACTS`, `KNOWLEDGE_PROMPT_BUDGET_CHARS` | Cap on how many active facts get injected into Sonnet/Opus prompt (default 500 facts, 30KB chars). |
| `WHISPER_MODEL` | OpenAI model for voice-note transcription (default `whisper-1`). |
| `OPENAI_API_KEY` | Required for voice-note transcription. PENDING: not yet set on Railway. |
| `MEDIA_DIR` | Where downloaded WhatsApp media is stored. Defaults to `<DB_PATH dirname>/media`, set to `/data/media` on Railway. |
| `SPECIALIST_DIRECT_LINK` | Digits-only WhatsApp number for the wa.me click-to-chat link appended to HOT lead replies. Currently set to brother's number. |
| `PUBLIC_BASE_URL` | Public base URL used to deep-link the owner into the admin inbox from escalation alerts. Format: `<PUBLIC_BASE_URL>/admin#conv=<conversation_id>`. No trailing slash. Defaults to `https://sunny-electrosun-production.up.railway.app` when unset. |
| `GITHUB_TOKEN` | Personal Access Token with `Contents: write` on the Sunny repo. Required for the Rules editor's Save button to commit + push edits. If unset, Save still writes to the running container's filesystem but the change is wiped on the next git redeploy. |
| `GITHUB_REPO` | `<owner>/<repo>` for the GitHub Contents API call. Defaults to `sergeadaimy-hash/sunny-electrosun`. |
| `GITHUB_BRANCH` | Branch to commit prompt edits to. Defaults to `main`. |
| `RAILWAY_TOKEN` | Railway Project Token (Project Settings → Tokens). The Rules editor's "Deploy to live" button uses this to call the Railway GraphQL API (`serviceInstanceRedeploy`) with the auto-injected `RAILWAY_SERVICE_ID` + `RAILWAY_ENVIRONMENT_ID`. If unset, the button suggests pressing Save instead (which pushes to main and auto-redeploys via Railway's GitHub integration). |
| `RAILWAY_DEPLOY_HOOK_URL` | Optional. Legacy deploy hook URL (older Railway UIs). Tried first if set. Recent Railway plans hide this feature, so most users should use `RAILWAY_TOKEN` instead. |
| `WAREHOUSE_DATASHEETS_DIR` | Where per-item datasheets are stored. Defaults to `<DB_PATH dirname>/warehouse_datasheets/`. On Railway: `/data/warehouse_datasheets/`. |
| `RATE_LIMIT_PER_MINUTE` | Per-contact message rate limit (default 15). Owner exempt. Blocked messages dropped without persistence or reply. |
| `RATE_LIMIT_DAILY` | Per-contact daily message cap (default 300). Owner exempt. |
| `MAX_SINGLE_MESSAGE_CHARS` | Per-message inbound truncation limit (default 2000). |
| `MAX_COMBINED_BATCH_CHARS` | Debounced batch truncation limit (default 4000). |
| `ESCALATION_COOLDOWN_MS` | Per-contact BRAND-NEW escalation cooldown for NON-HOT escalations only (default 1800000 = 30 minutes). HOT escalations have their own shorter throttle (see `HOT_ESCALATION_COOLDOWN_MS`). Repeat first-time triggers within the window demote to a normal reply. Does NOT apply when an open pending_queries row already exists for the contact (the follow-up channel takes over). |
| `HOT_ESCALATION_COOLDOWN_MS` | Per-contact HOT-lead alert cooldown (default 60000 = 60 seconds). Separate from the 30-min `ESCALATION_COOLDOWN_MS` because a HOT signal ("send me account", "i want to pay") must always reach the owner. The 60s cap only defangs back-to-back identical retries from the customer's side. |
| `FOLLOWUP_COOLDOWN_MS` | Per-contact follow-up-alert cooldown for the open-pending-query path (default 300000 = 5 minutes). Bounds how often the brother gets "same customer still asking on [QID:N]" pings. |
| `MAX_IMAGES_PER_DAY` | Per-contact daily image-vision quota (default 10). When exceeded, images flow through as text markers, vision is skipped. |

### Models, costs, and budget

- Code-level fallback default: `claude-opus-4-7` for all four call sites. Live Railway env (since 2026-05-09): only `MODEL_REPLY` runs Opus; classifier, teacher, and owner_qa run `claude-sonnet-4-6`.
- Cost reality on Opus: ~$0.025-$0.05 per message (vs ~$0.005 on Sonnet). At 500 messages/day that's $15-$25/day.
- Opus pricing per million tokens (cents, in `src/cost_tracker.js`): in 1500 / out 7500 / cache_read 150 / cache_write 1875.
- Sonnet pricing (kept for fallback): in 300 / out 1500 / cache_read 30 / cache_write 375.
- Haiku pricing (kept for fallback): in 80 / out 400 / cache_read 8 / cache_write 100.
- Per-day spend tracked in `daily_costs` table (cents, integers). One-time over-budget alert to owner via window-scan cron.

### New code modules and their roles

| File | Role |
|---|---|
| `src/owner_qa.js` + `src/prompts/owner_qa.md` | Owner Q&A mode. Brother WhatsApps Sunny questions about his data, gets answers from a live snapshot (today's stats, last 24h hot leads, pending queries, recent contacts, brother's own chat history, active facts count). |
| `src/knowledge.js` + `src/prompts/teacher.md` | Knowledge_entries CRUD + Haiku/Opus teaching extraction. Dedup at insert (normalised leading 120 chars per category). 500-fact / 30KB cap on prompt injection. |
| `src/catalog.js` | catalog_items + catalog_notes CRUD. `formatCatalogForPrompt()` exists but is NO LONGER injected into Sunny's prompt (retired 2026-05-10 in favor of warehouse stock). Catalog tab in admin still renders for legacy reference. |
| `src/warehouse.js` | warehouse_items + warehouse_stock (per-location: abuja / lagos). `formatWarehouseForPrompt()` is the authoritative stock + price block injected into both classifier and reply system blocks. CRUD via admin "Warehouse Stock" tab; each item auto-creates an Abuja stock row and a Lagos stock row on add. State is one of `in_stock` / `out_of_stock` / `incoming`; `incoming` rows can carry an ETA date and a coming_note quoted verbatim to customers. Per-item datasheet attachment: `setDatasheet`, `removeDatasheet`, `findItemDatasheetByQuery` (token-overlap on brand+model+notes+section). Files stored at `WAREHOUSE_DATASHEETS_DIR` (defaults to `<DB dir>/warehouse_datasheets/`). When a customer asks for a datasheet, `src/handler.js` looks up the matching warehouse item, uploads the file to Meta (cached 25 days), and sends it as a WhatsApp document. |
| `src/prompt_store.js` | Read/write/cache wrapper for the four prompt files (`system.md`, `classifier.md`, `teacher.md`, `owner_qa.md`). 30-second in-memory cache busted on every write. `claude.js`, `knowledge.js`, and `owner_qa.js` all source their system prompts via this store, so a Save in admin takes effect on the next customer message without a process restart. |
| `src/datasheets.js` | LEGACY 2026-05-10. The dedicated `datasheets` table + Meta upload helpers still exist but the admin sub-panel is removed and the prompt block is no longer injected. Datasheets now live on warehouse_items. The old datasheets table is preserved for migration; the brother can re-attach previously uploaded sheets onto warehouse rows. |
| `src/knowledge.js` | LEGACY 2026-05-10. Live facts panel was retired; doctrine now lives entirely in `src/prompts/system.md`. Module + endpoints kept so older facts can still be read; `formatKnowledgeForPrompt()` is no longer injected into Sunny's system blocks. |
| `src/cost_tracker.js` | `recordUsage` after every Anthropic response; `isOverBudget` short-circuit. |
| `src/window_monitor.js` | `*/30 * * * *` cron. Past 22h: one-time reminder to owner. Past 24h: marks status='expired' and alerts owner. Idempotent via `expiring_warning_sent_at`. |
| `src/transcribe.js` | OpenAI Whisper wrapper for voice-note transcription. Falls back to "[Customer sent a voice note that could not be transcribed]" if OPENAI_API_KEY missing. |
| `src/whatsapp.js > downloadMedia(mediaId)` | Two-step Meta media download (metadata GET → signed URL GET with auth, 25MB cap, 30s timeout). |
| `src/handler.js > handleOwnerNonQueryMessage` | Routes brother's WhatsApp messages to `answerOwnerQuestion`. Owner replies to alerts (`msg.replyToId` matching pending QID) still route via `handleOwnerReply`. |
| `src/handler.js > recoverOrphanedInbound(maxAgeMinutes)` | Scans inbound messages without a subsequent outbound reply (and not human_handled, not from owner) and re-queues them through the normal pipeline. Called 3s after `app.listen`. Default 10 minutes. Bug it fixes: in-memory debounce queue is wiped on container restart. |
| `src/handler.js` debounce queue | Per-contact in-memory queue, fires once per `MESSAGE_DEBOUNCE_MS` window. Persists each message to DB immediately for admin visibility. |
| `src/handler.js > handleUnsupported` (legacy) | Polite "text only" fallback for unsupported message types. Voice notes now flow through transcribe instead. |
| `src/handler.js` calls handler | When Meta delivers a `calls` webhook event, auto-sends "Hello, this number isn't monitored for voice calls. Please send a text message and the Electro-Sun team will respond." Throttled per-caller to once per hour. Logs `call_received`. Note: Meta's Calling API is in beta. |
| `src/handler.js > WELCOME_REPLY` constant | Hardcoded multi-line welcome card with Abuja office + warehouse, Lagos office, Charbel + Patrick contact lines. Sent verbatim on the very first greeting from a new contact (greeting branch detects `priorHistory` has no prior assistant message). Bypasses Opus and all output guards because the card includes Patrick's number which would trip the owner-number-leak detector if generated by the LLM. Subsequent greetings in the same conversation fall through to normal Opus reply. |
| `src/handler.js > answerPendingForContact(contactId)` | Finds the latest unanswered customer inbound for the contact and re-queues it through the normal debounce + classify + reply pipeline. Called by the manual `/release` endpoint AND by the auto-release cron when human_handled flips back to false. |
| `src/handler.js > autoReleaseStaleHumanConversations(thresholdMinutes)` | Scans `human_handled=1` conversations, computes `max(human_handled_at, last_human_reply_at)`, releases any conversation idle past the threshold, fires `conversation_auto_released` event, and calls `answerPendingForContact` for the released contact. Cron: every 5 min outside the `DISABLE_NOTIFICATIONS` gate. Tunable via `HUMAN_AUTO_RELEASE_MINUTES` env var. |
| `src/datasheets.js` (new) | Datasheet library. Files stored at `/data/datasheets/` on Railway volume. Schema: id, label, keywords, filename, file_path, mime_type, size_bytes, meta_media_id, meta_media_uploaded_at (Meta TTL 30 days; refresh after 25), status, created_at, updated_at. 15MB cap. Mime allow-list: pdf, png, jpeg, webp. Exposes `listDatasheets`, `getDatasheetById`, `addDatasheet` (base64 input), `updateDatasheet`, `deleteDatasheet` (soft archive default), `setMetaMediaCache`, `isMetaMediaFresh`, `findDatasheetByQuery` (token-overlap match against label+keywords), `formatDatasheetsForPrompt`. |
| `src/whatsapp.js > uploadMediaToMeta(filePath, mimeType, filename)` | Multipart POST to `/<phone-id>/media`, returns Meta media_id (cached on the datasheet row). |
| `src/whatsapp.js > sendDocument(to, mediaId, filename, caption)` | POST to `/messages` with type=document, native WhatsApp document message. |
| `src/handler.js` datasheet fast-path | In `processCustomerBatch` after classification, before greeting/escalation: `DATASHEET_REQUEST_RE` detects "datasheet"/"brochure"/"spec sheet"/"specifications"/"manual"/"product sheet"/"product brochure"/"product manual"/"user guide" etc. Calls `findDatasheetByQuery(message, last 6 history turns)`. On match: uploads to Meta if not cached, sends document, appends `[Datasheet sent: <label>]` outbound row with `intent='datasheet_sent'`, returns early. Falls through to normal reply on no match or send failure. Logs `handler.datasheet.sent` / `handler.datasheet.no_match` / `handler.datasheet.send_fail_fallback_to_text`. |
| `notifyOwnerEscalation` + follow-up ping in `notifyOwnerForEscalation` | Both branches now persist the outbound message to the owner's conversation via `appendMessage` (intents `escalation_alert_hot`, `escalation_alert_silent`, `escalation_followup_ping`). Owner Chat tab can render every Sunny→Owner message. Wrapped in try/catch so DB write failure logs `escalation.persist_owner_alert_fail` without breaking delivery. **Alert body (2026-05-12)** carries a typed header (HOT / NEGOTIATION / REPEAT / BIG-PROJECT / FOLLOW-UP), customer name+phone, classifier signals (category, lead_temperature, intent when present), the latest message verbatim, a 6-turn conversation brief from `formatConversationBriefForOwner`, an admin deep-link (`<PUBLIC_BASE_URL>/admin#conv=<conversation_id>`), and the customer wa.me click-to-chat link. Header label resolved via `ESCALATION_HEADERS` keyed on `escalation_type`; unknown types fall back to the silent_query header so new classifier escalation types degrade gracefully. |
| `formatConversationBriefForOwner(contactId, maxTurns)` (in `src/handler.js`) | Builds a compact `[HH:MM] Customer: ...\n[HH:MM] Sunny: ...` brief from the last N messages of the contact's active conversation. Each line truncated at 220 chars, multi-line bodies flattened to single line. Used inside both escalation alert builders. |
| `buildAdminConversationLink(conversationId)` (in `src/handler.js`) | Returns `${PUBLIC_BASE_URL}/admin#conv=<id>`. Default base falls back to the Railway production URL when `PUBLIC_BASE_URL` is unset. The admin SPA parses `#conv=<id>` on boot and on every `hashchange`, then calls `selectConversation(id)` to deep-link the inbox to that conversation. |
| Admin `Owner Chat` tab + `GET /api/owner-chat?limit=N` | Read-only conversation thread of every message between Sunny and OWNER_WHATSAPP, including escalation alerts, follow-up pings, and the brother's replies. Renders with the same `msgHtml()` bubble component as the inbox. Auto-refreshes every 15s. |
| Admin `Datasheets` sub-panel under Knowledge | Upload form (label + keywords + file), list with download/edit/archive per row. Client-side base64 encoding, 15MB pre-flight check, server-side mime allow-list. Auth supports `?key=` query param so the download link works directly from the browser. |

## Mission

Sunny is an AI-powered WhatsApp Account Manager for **ElectroSun**, a solar energy supply agency in Nigeria. Sunny answers every inbound WhatsApp message in the customer's own language, explains ElectroSun's services, qualifies leads, categorizes contacts, sends owner reports, and stores everything behind a clean REST API ready for a future web dashboard.

## Who is who

- **Project owner**: Serge (builder, technical lead). Currently testing as a customer from `+966 50 239 2650`.
- **End client**: Serge's brother, who runs ElectroSun. Owner WhatsApp `2347041328055`.
- **Production host**: Railway (cloud). Mac Mini was the original plan but was retired due to office power/internet reliability.
- **First production phone number**: ElectroSun's verified WhatsApp Business number (TBD at launch). Currently using Meta test number `+1 555 172 6906`.

## Tech stack (locked, do not deviate without asking)

- **Runtime**: Node.js 20+. Production runs on Railway (Linux container); local dev runs on macOS.
- **Framework**: Express.js.
- **Database**: SQLite via `better-sqlite3` (synchronous, single file at `db/sunny.db` locally, `/data/sunny.db` on Railway).
- **WhatsApp**: Meta WhatsApp Cloud API (official, NOT Twilio, NOT unofficial libs). Graph API version `v21.0`.
- **LLM**: Anthropic Claude API. All four call sites (`src/claude.js > classify`, `generateReply`; `src/knowledge.js > extractKnowledge`; `src/owner_qa.js > answerOwnerQuestion`) default to `claude-opus-4-7`. Override via `MODEL_*` env vars. Prompt caching enabled on system blocks via `cache_control: { type: 'ephemeral' }`.
- **Voice transcription**: OpenAI Whisper (`whisper-1` default, `WHISPER_MODEL` override).
- **Scheduler**: `node-cron`.
- **Email fallback**: `nodemailer` (used only if owner's WhatsApp report fails).
- **Process manager (local dev only)**: PM2 (`ecosystem.config.js`).
- **Tunnel for local webhook (dev only)**: Cloudflare Tunnel quick-tunnel or named tunnel.
- **Multipart upload for Whisper**: `form-data`.

Do not add any dependency that is not in the list above without explicit approval.

## Folder structure

```
sunny/
├── .env                         # NEVER commit. Real secrets live here.
├── .env.example                 # Reference of required keys.
├── .gitignore
├── package.json
├── server.js                    # Express app, cron registration, startup checks, orphan recovery call.
├── ecosystem.config.js          # PM2 process config (local dev only).
├── railway.json                 # Railway build/deploy config.
├── db/
│   ├── schema.sql               # Single source of truth for schema.
│   ├── init.js                  # WAL + foreign keys, idempotent migrations, optional seed-from-products.json on first boot.
│   └── sunny.db                 # Generated, gitignored. On Railway: /data/sunny.db.
├── src/
│   ├── webhook.js               # GET /webhook (Meta verify) + POST /webhook (signed inbound).
│   ├── whatsapp.js              # sendMessage, sendTemplate, downloadMedia.
│   ├── claude.js                # classify, generateReply, buildConversationState, scrubHistoryContent, code-level reply guards.
│   ├── classifier.js            # Wraps classify, updates contact, logs category_changed.
│   ├── memory.js                # Contacts + conversations + messages + events. ISO timestamps everywhere.
│   ├── handler.js               # handleInbound pipeline, debounce queue, owner routing, calls handler, unsupported handler.
│   ├── reports.js               # 2-hour + daily + daily-learning aggregation, WhatsApp + email send.
│   ├── window_monitor.js        # 23h/24h pending_queries scan.
│   ├── cost_tracker.js          # daily_costs ledger, recordUsage, isOverBudget.
│   ├── knowledge.js             # knowledge_entries CRUD, Haiku/Opus extractKnowledge, formatKnowledgeForPrompt.
│   ├── catalog.js               # catalog_items + catalog_notes CRUD, formatCatalogForPrompt.
│   ├── owner_qa.js              # answerOwnerQuestion (live snapshot Q&A for the brother).
│   ├── transcribe.js            # OpenAI Whisper wrapper.
│   ├── prompts/
│   │   ├── system.md            # Sunny's personality, voice rules, hard rules, locations block, conversation-state usage, engineering rules.
│   │   ├── classifier.md        # C1-C5 classification, lead_temperature, client_type, escalation rules.
│   │   ├── teacher.md           # Owner-DM-to-fact extraction prompt.
│   │   └── owner_qa.md          # Owner Q&A prompt with live snapshot context.
│   ├── knowledge/
│   │   └── products.json        # Seed source for catalog_items on first boot.
│   └── utils/
│       ├── logger.js            # Console + rotating file at logs/sunny.log (5MB rotations, 5 kept). Disabled when LOG_TO_FILE=false.
│       └── verifySignature.js   # HMAC-SHA256 of raw body using META_APP_SECRET.
├── api/
│   └── dashboard.js             # Express router mounted at /api. Requires X-API-Key header. /version is on the main app router (no auth).
├── public/
│   └── admin/                   # Single-page admin UI (HTML + JS + CSS, WhatsApp-style light theme).
├── scripts/
│   ├── seed.js                  # Demo data (still has old category names; cleanup pending).
│   ├── seed_hv_products.js      # 12 HV catalog items + 4 product facts (idempotent via dedup).
│   ├── seed_locations.js        # 7 location/contact facts.
│   ├── seed_doctrine.js         # 3 doctrine facts.
│   ├── import_legacy.js         # Parses brother's old MariaDB dump into facts.
│   ├── cleanup_past_quotes.js   # Marks legacy "Past quote" pricing facts as rejected.
│   ├── submit_templates.js      # POST templates to Meta.
│   ├── check_templates.js       # GET template approval status.
│   └── print_railway_env.js     # Produces Railway env-var block from .env with cloud overrides.
├── templates/
│   ├── owner_hourly_report_en.json
│   └── follow_up_24h_en.json
├── presentation/
│   └── sunny-overview.html      # Stakeholder-facing brochure.
├── docs/
│   └── session-history.md       # Chronological changelog (this file used to live in CLAUDE.md).
└── logs/                        # sunny.log, daily DB snapshots, PM2 logs.
```

The project folder path contains a space: `/Users/sergeadaimy/Desktop/Claude Projects/Sunny-Whatsapp Account Manager`. Always quote it in shell commands.

## How a message flows (the pipeline)

1. Customer sends WhatsApp text/image/voice/audio to ElectroSun's number.
2. Meta POSTs to `/webhook` with `X-Hub-Signature-256` header.
3. `src/webhook.js` reads the raw body (captured by an `express.json` `verify` callback so HMAC computation matches what Meta signed) and calls `verifyMetaSignature`. Mismatched signatures get a 403. Webhook returns 200 immediately, then processes asynchronously.
4. **Calls webhook event** (separate path): handler.js fires the auto-reply "this number isn't monitored for voice calls", throttled to once/hour per caller.
5. `handler.js > extractMessages` extracts text, image, audio. `handleInbound(payload)`:
   1. **Idempotency**: looks up `whatsapp_message_id` in `messages`. If already stored, skips.
   2. **Voice notes**: download from Meta, save to `MEDIA_DIR`, transcribe via Whisper, rewrite `msg.body` to transcript with `[voice note transcribed]:` prefix.
   3. **Images**: download from Meta, save to `MEDIA_DIR`, base64-encode, persist with `media_path` and `media_mime`. Classifier sees text marker `[Customer sent an image with caption]:`; Opus reply call sees the actual image as a vision input.
   4. `getOrCreateContact(phone, profileName)`.
   5. `getActiveConversation(contactId)` opens a new conversation if the last message was more than 24 hours ago. If `conversation.human_handled` is true, Sunny skips processing.
   6. **Owner routing**: messages from `OWNER_WHATSAPP` that match a pending `[QID:N]` go to `handleOwnerReply` (relays to customer). Other owner messages go to `handleOwnerNonQueryMessage` → `answerOwnerQuestion` (live snapshot Q&A).
   7. **Debounce queue**: per-contact in-memory queue. Persists each message to DB immediately for admin visibility. Classification + reply only fire ONCE per `MESSAGE_DEBOUNCE_MS` window with combined input `[Customer sent N messages back to back]\n...`.
   8. Reads prior history (last 50 messages), then `classifier.runClassification()` calls Opus, parses JSON, retries once on parse failure, falls back to `category=unsorted, lead_temperature=COLD, escalation_type=silent_query` if Claude fails entirely. Updates contact category, language, lead_data fields (only fills nulls, never overwrites).
   9. **Greeting fast-path**: if message matches greeting regex, return synthetic `{C1, COLD, no escalation, intent=greeting}` without calling Opus. Saves cost. Reply path then sends Opus EMPTY history (clean slate, no anchoring on prior products).
   10. **Branch A (escalation)**: logs `escalated`, alerts owner via WhatsApp (RED for hot_lead, YELLOW for silent_query, with `[QID:N]` tag and pending_queries row). Sends customer the canned `HOT_LEAD_REPLY` or `SILENT_QUERY_REPLY` (English). HOT also gets the wa.me specialist link. Demoted to normal reply when `DISABLE_ESCALATIONS=true`.
   11. **Branch B (auto-reply)**: `generateReply(history, message, contact, attachments)`. System prompt = `system.md` + locations block + conversation-state block + catalog block + active knowledge facts (capped) + "Known about this customer" context. Code-level guards (price-strip, repeat, trailing-question-strip, wa.me-strip) clean up the reply before send.
   12. Sends via `sendMessage`, persists outbound with returned WhatsApp message ID. `cost_tracker.recordUsage` after every Anthropic response.
6. **Cron jobs (only register at boot if `DISABLE_NOTIFICATIONS=false`)**:
   - `0 */2 * * *` (UTC) every 2 hours: 2-hour report, sends to owner.
   - `0 21 * * *` (Africa/Lagos) daily: 24h report, sends, snapshots DB.
   - `30 21 * * *` (Africa/Lagos) daily: daily learning report (unanswered queries, unsorted contacts, frequent inbound intents).
   - `*/30 * * * *` window monitor: 23h reminder + 24h expire on pending_queries; over-budget one-time alert.
7. **Startup**: `recoverOrphanedInbound(10)` runs 3s after `app.listen` to re-queue any orphaned inbound from the last 10 minutes.

## Database schema and conventions

Schema lives in `db/schema.sql`. Tables:
- **`contacts`**: phone, profile_name, category, language, lead_data fields (`name`, `location`, `use_case`, `load_estimate`, `timeline`), `lead_temperature`, `client_type`, `products_asked_about`, `brand_preference`, `budget_mentioned`, `expiring_warning_sent_at`, `last_active`.
- **`conversations`**: `contact_id`, `started_at`, `last_message_at`, `human_handled`, `human_handled_at`.
- **`messages`**: `whatsapp_message_id` (partial unique index for idempotency), `conversation_id`, `direction`, `body`, `kind`, `media_path`, `media_mime`, `created_at`.
- **`events`**: log of category_changed, escalated, silent_query_resolved, call_received, etc.
- **`reports`**: persisted hourly/daily/learning reports.
- **`pending_queries`**: silent-query workflow. `customer_contact_id`, `customer_message`, `alert_message_id`, `status` (open/resolved/expired), `created_at`, `resolved_at`, `expiring_warning_sent_at`.
- **`daily_costs`**: per-day spend in cents (integers, no float drift).
- **`knowledge_entries`**: owner-taught facts. `id`, `source_message`, `extracted_fact`, `category` (pricing/policy/product/sales/operations/warranty/customer/correction/other), `confidence`, `status` (active/rejected/draft), `created_at`, `approved_at`, `rejected_at`.
- **`catalog_items`**: `brand`, `model`, `price_naira`, `stock`, `notes`. Seeded from `src/knowledge/products.json` on first boot only. Legacy: no longer injected into the prompt as of 2026-05-10.
- **`catalog_notes`**: free-form catalog notes (PDU stacking limits, etc.). Legacy.
- **`warehouse_items`**: `section`, `brand`, `model`, `price_ngn`, `notes`, `sort_order`. Source of truth for what Electro-Sun sells.
- **`warehouse_stock`**: per-item × per-location stock row. Columns: `item_id`, `location` ('abuja' | 'lagos'), `state` ('in_stock' | 'out_of_stock' | 'incoming'), `quantity` (integer, default 0), `coming_note` (free text), `eta_date` (YYYY-MM-DD). UNIQUE(item_id, location). Two rows are auto-created per item (Abuja + Lagos) on insert.

Idempotent ALTER TABLE migrations live in `db/init.js > applyMigrations`.

**Timestamp convention**: every timestamp written by application code is an **ISO 8601 string** (`new Date().toISOString()`). Do NOT rely on SQLite's `CURRENT_TIMESTAMP` default for new rows because it produces `'YYYY-MM-DD HH:MM:SS'` (no `T`, no `Z`) which sorts wrong against ISO strings in range queries.

**Conversation rollover**: a new conversation row is opened if the latest one's `last_message_at` is older than `CONVERSATION_WINDOW_MS` (24 hours).

**History shape for Claude**: `getRecentHistory(contactId, limit=50)` returns `{role, content}` array with **alternating roles enforced**. Consecutive same-role messages are merged with newline joins. The Anthropic API requires alternation.

**Lead data merge rule**: classifier only fills lead fields when the existing value is null. Never overwrite a known value.

**Coercion safety**: `src/memory.js > updateContactFields` coerces arrays to comma-joined strings, plain objects to JSON, primitives via `String()`. Avoids better-sqlite3 spreading arrays into bind params and crashing.

## Environment variables

All listed in `.env.example`. Required at runtime:

| Key | Purpose |
|---|---|
| `META_VERIFY_TOKEN` | Random string. Must match the value pasted into Meta's webhook config. |
| `META_ACCESS_TOKEN` | Bearer token for Graph API. Permanent System User token in production. |
| `META_PHONE_NUMBER_ID` | Meta-issued ID for the sending number. Currently the test number; swap when brother provides production line. |
| `META_APP_SECRET` | Used to verify `X-Hub-Signature-256`. Must be set in production. |
| `META_WABA_ID` | WhatsApp Business Account ID. `1713234916358524`. |
| `ANTHROPIC_API_KEY` | Claude API key. |
| `OPENAI_API_KEY` | Whisper transcription. PENDING: not yet set on Railway. |
| `OWNER_WHATSAPP` | E.164 digits, currently `2347041328055`. Receives escalation alerts and reports. |
| `OWNER_EMAIL`, `SMTP_*` | Email fallback when WhatsApp report fails. Optional. |
| `PORT` | Express port. Defaults to 3000. |
| `API_KEY` | Required by `/api/*`. If unset, every API call returns 503. `/version` and `/health` bypass this. |
| `DB_PATH` | SQLite file location. `/data/sunny.db` on Railway. |
| `MEDIA_DIR` | Downloaded media location. Defaults to `<DB_PATH dirname>/media`. |
| `LOG_TO_FILE` | Default true. Set false on cloud PaaS to disable rotating-file logger and DB snapshot. |
| `DISABLE_NOTIFICATIONS` | When true, no cron schedules register at boot. |
| `DISABLE_ESCALATIONS` | When true, escalations get demoted to normal replies. |
| `MESSAGE_DEBOUNCE_MS` | Debounce window per contact. Default 6000. |
| `MODEL_CLASSIFIER`, `MODEL_REPLY`, `MODEL_TEACHER`, `MODEL_OWNER_QA` | Override Opus default selectively. |
| `WHISPER_MODEL` | OpenAI model. Default `whisper-1`. |
| `DAILY_LLM_BUDGET_USD` | Soft daily cap. Currently 20. |
| `KNOWLEDGE_PROMPT_MAX_FACTS`, `KNOWLEDGE_PROMPT_BUDGET_CHARS` | Active-fact injection cap. Defaults 500 / 30000. |
| `SPECIALIST_DIRECT_LINK` | Digits-only number for the wa.me link on HOT replies. |
| `PUBLIC_BASE_URL` | Base URL for the admin deep-link embedded in owner escalation alerts. Falls back to the Railway production URL. |

`server.js > startupSanityChecks()` logs warnings for missing critical keys at boot.

## Running locally

```bash
cd "/Users/sergeadaimy/Desktop/Claude Projects/Sunny-Whatsapp Account Manager"

# Initialize DB (idempotent, safe to re-run)
node db/init.js

# Optional: seed demo data for dashboard testing
node scripts/seed.js

# Run the server
npm start

# In a second terminal, expose the webhook publicly
cloudflared tunnel --url http://localhost:3000
```

The `cloudflared` quick-tunnel URL changes every restart. For production use a named tunnel with a stable hostname (we use Railway HTTPS URL instead).

**Local zombie warning**: before debugging "ghost" reports, always check `ps aux | grep node` for stale `npm start` processes that may be reading a cached `.env` and posting to Meta with old config. Set `DISABLE_NOTIFICATIONS=true` in local `.env` to prevent recurrence on accidental local starts.

## Cron schedule

Defined in `server.js`. **All schedules are skipped at boot when `DISABLE_NOTIFICATIONS=true`** (logs `cron.all_schedules_skipped_at_boot`).

- `0 */2 * * *` (UTC) every 2 hours: `generateHourlyReport()` then `sendOwnerReport(report)`.
- `0 21 * * *` (Africa/Lagos): `generateDailyReport()` then `sendOwnerReport(report)`, then `snapshotDb()`.
- `30 21 * * *` (Africa/Lagos): `generateDailyLearningReport()` then send.
- `*/30 * * * *`: `window_monitor.scan()` for 23h reminders, 24h expirations, over-budget alerts.

## Dashboard API

Mounted at `/api`. Every endpoint requires header `X-API-Key: <process.env.API_KEY>`. Returns 401 on mismatch, 503 if `API_KEY` is not set on the server. `/version` and `/health` are on the main app router (no auth).

Public:
- `GET /health` returns `{status, uptime_seconds, timestamp}`.
- `GET /version` returns `git_sha_short`, `git_branch`, `git_commit_message`, `deploy_id`, `escalations_disabled`, `notifications_disabled`, `owner_whatsapp_tail`, `node_uptime_seconds`. One-tap diagnostic.

Authed:
- `GET /api/contacts?category=&from=&to=&limit=&offset=`, `GET /api/contacts/:id`.
- `GET /api/stats/today`, `GET /api/stats/range?from=&to=`.
- `GET /api/reports/latest?type=hourly|daily`, `GET /api/reports?from=&to=&type=`.
- `GET /api/inbox`, `GET /api/conversations/:id`, `POST /api/conversations/:id/{handle, release, send-reply}`.
- `GET /api/queries/pending`, `GET /api/budget/today`.
- `GET /api/knowledge`, `POST /api/knowledge`, `POST /api/knowledge/:id/status`, `POST /api/knowledge/:id/edit`, `DELETE /api/knowledge/:id`.
- `GET /api/catalog`, `POST /api/catalog/items`, `POST /api/catalog/items/:id`, `DELETE /api/catalog/items/:id`, plus `/api/catalog/notes` CRUD.
- `GET /api/brain` returns model env values, runtime config (DB path, media dir, daily budget, WABA ID, graph version, owner_whatsapp_tail), and which env vars are set as booleans only. No secrets returned.
- `POST /api/recover-orphans?minutes=N` manual orphan recovery.

## Admin web UI

Mounted at `/admin`. Single-page HTML+JS+CSS, WhatsApp-style light theme (white surfaces, charcoal text, brand green as accent). Login with `API_KEY` (stored in localStorage).

- **Inbox**: WhatsApp-style two-pane (conversation list + thread). Gradient-green avatar circles with per-contact initials. White incoming bubbles, pastel green (`#DCF8C6`) outgoing, pastel violet for human-typed outgoing. Inline-bottom-right timestamps. Take-over and Return-to-agent buttons; manual reply auto-marks `human_handled` so Sunny stops auto-replying.
- **Contacts**: filterable contacts list with last-active and category.
- **Warehouse Stock**: top-level tab. Source of truth for stock + price + datasheets. One row per item (brand/model/section/price/notes) with two side-by-side panels (Abuja, Lagos). Each panel: state radios (In stock / Incoming / Out of stock), quantity with +/- buttons, coming note (free text), ETA date. Plus a per-item datasheet attachment (PDF/PNG/JPG/WEBP up to 15MB) that Sunny auto-sends when the customer asks for a datasheet/brochure/spec. Edits save instantly via REST and feed `formatWarehouseForPrompt()` on the very next reply.
- **Knowledge**: two sub-panels (Live facts / Catalog / Datasheets retired 2026-05-10).
  - Rules: editable per-prompt textareas for `system.md`, `classifier.md`, `owner_qa.md` (teacher.md retired from the editor 2026-05-10, owner no longer teaches Sunny via DMs; doctrine edits go directly into `system.md`). Each has a Save button (writes file via `src/prompt_store.js` and commits + pushes to GitHub via the Contents API if `GITHUB_TOKEN` is set). A global "Deploy to live" button calls Railway's GraphQL `serviceInstanceRedeploy` if `RAILWAY_TOKEN` is set. Sunny re-reads prompts on every classify/reply call (cached 30s, busted on Save), so saved prompts take effect on the next customer message without a restart.
  - Models & config: model IDs, runtime config, env-var booleans.

## Prompts: where to tune Sunny's voice

Four files, edited like English prose, no code changes needed (process restart picks up changes):

- `src/prompts/system.md`: Sunny's personality, voice rules, hard rules, locations block, engineering rules, conversation-state usage, worked-example dialogues.
- `src/prompts/classifier.md`: strict JSON schema, C1-C5 categories, lead_temperature definitions, escalation triggers.
- `src/prompts/teacher.md`: owner-DM-to-fact extraction rules.
- `src/prompts/owner_qa.md`: owner Q&A live-snapshot rules.

## Languages

Sunny detects from the customer's first message and replies in the same language by default:

- English (default fallback and the brother's "Always English" preference for canned holding replies).
- Nigerian Pidgin.
- Hausa.
- Yoruba.
- Igbo.

Multi-language detection still runs in classifier for data capture. `HOT_LEAD_REPLY` and `SILENT_QUERY_REPLY` constants in `src/handler.js` are English-only per brother's directive.

## Categories and escalation (current C1-C5 framework)

Source of truth is `src/prompts/classifier.md`. Classifier output:
- `category`: C1 (greeting/casual), C2 (product/price specific), C3 (sizing/general), C4, C5 (definitions in classifier.md).
- `lead_temperature`: HOT / WARM / COLD / DISQUALIFIED / CLOSED / LOST. HOT requires explicit commitment phrases (pay/account/proforma/deposit/install-date/proceed/order).
- `client_type`: end_user / installer / integrator / reseller / unknown.
- `escalation_type`: hot_lead / silent_query / none.

**Classification safety nets** (in `src/classifier.js`, all logged when triggered):
1. `classifier.hot_without_escalation_demoted_to_warm`: if Opus returns `lead_temperature=HOT` without `needs_escalation=true`, demote to WARM.
2. `classifier.hot_without_commitment_phrase_demoted`: if Opus returns HOT but the customer body contains NO explicit commitment keyword (pay, account number, proforma, invoice, quotation, deposit, let's proceed, i'm ready, confirm order, send your team, when can you install, ready to buy, site visit, etc.), demote HOT to WARM AND clear escalation. Whitelist regex is `HOT_TRIGGER_RE`. Reason: Opus once misclassified "I need solar panels" as HOT and the customer got the canned wa.me handoff prematurely.
3. `classifier.greeting_escalation_blocked`: if a casual greeting was misclassified as needing escalation, block it.
4. `classifier.clarification_escalation_blocked`: if the customer message is a short confusion/clarification reaction ("for what?", "what is this message?", "what do you mean?", "I don't understand", "huh?", etc., regex `CLARIFICATION_RE`), force `needs_escalation=false` and `escalation_type=null`. Reason: customer was getting the specialist canned reply for "for what?" and "what is this message?" — these are conversational repair, not handoff signals.

**Classifier fallback** (in `src/claude.js > FALLBACK_CLASSIFICATION`): when Opus parse fails / network error / retries exhaust, the synthetic classification is `category=unsorted, lead_temperature=COLD, needs_escalation=false, escalation_type=null`. Customer gets a normal Opus reply via `generateReply`, NOT the specialist canned reply. Reason: previously the fallback escalated by default, so any classifier hiccup spammed the specialist message.

**Default unsorted**: when uncertain or when the Opus classify call fails entirely, the synthetic classification is `category=unsorted, lead_temperature=COLD, client_type=unknown, needs_escalation=false, escalation_type=null`. The reply path then runs normally so Sunny attempts an answer instead of punting to specialist.

**Greeting fast-path**: greeting regex skips Opus and returns synthetic `{C1, COLD, no escalation}` to save cost.

**Sizing questions are NOT escalated.** General questions about how solar works, brand context, sizing, market price ranges, segment confirmations are answered, not silent_query'd. Only Electro-Sun specific facts (exact price for non-catalog brands, current stock, specific install date, complaints, warranty claims, custom designs) trigger escalation.

**Location/branch/address/pickup/warehouse questions are NEVER silent_query.** Sunny answers from the locations block.

## Hard rules (do not violate)

1. **No double dashes anywhere.** Permanent user preference (2026-04-26). No em-dash, en-dash, or `--`. Use commas, periods, colons, parentheses, semicolons. CSS custom properties (`--cream`) are the only allowed exception.
2. **Never invent specs, prices, model numbers, or timelines** in customer replies. Sunny escalates whenever uncertain. Confirmed prices in Naira only, sourced from the catalog table only.
3. **Never overwrite known lead data** with later guesses. Fill nulls only.
4. **Idempotency is mandatory** on `whatsapp_message_id`. Meta retries failed webhooks. Duplicate processing must be a silent skip.
5. **Webhook signature verification** is required in production.
6. **Do not auto-deploy or auto-commit** anything. Builder runs deploys manually.
7. **Ask before installing any dependency** not in the locked tech stack list above.
8. **Stay inside the 24-hour window** for free-form replies. Outside that window, only pre-approved Meta message templates can be sent.
9. **Never expose `API_KEY`, `META_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`** in logs, error responses, or any user-facing output. `railway variables` (no args) is BLOCKED in Claude's sandbox; use `--set` for writes and `/version` / `/api/brain` for reads.

## Build status

**Shipped and live on Railway**:
- Full pipeline (text + image + voice + calls + debounce + orphan recovery).
- Conversation-state engine, code-level reply guards, greeting fast-path, empty-history-on-greeting, wa.me-link ban, history scrub.
- Owner Q&A mode (brother's number).
- Knowledge ingestion with Haiku/Opus extraction, dedup, 500-fact cap.
- Catalog moved to DB, fully editable from admin (no developer push needed for price changes).
- Admin web UI (Inbox, Contacts, Knowledge with 4 sub-panels).
- Cost tracker + budget guardrail.
- Window monitor (23h/24h pending_queries).
- 2-hour, daily, daily-learning reports (currently silenced via `DISABLE_NOTIFICATIONS=true`).
- HV catalog seeded (12 items: Deye 30/50/80kW HV 3-phase + BOS-G/A/B Pro batteries + accessories).
- Locations + doctrine facts seeded.
- Legacy data import done; "Past quote" entries retired.
- Templates submitted to Meta (PENDING approval): `owner_hourly_report_en` id `3044946312362011`, `follow_up_24h_en` id `949981397673982`.
- Permanent System User token issued ("Sunny-Server", id `615889422441392`, no expiry).
- Meta business verification confirmed.

**Pending**:
- `OPENAI_API_KEY` on Railway (for Whisper transcription).
- Brother's pricing data (Sungrow, JA panels, Longi).
- Brother's Section 11 decisions (working hours, location tags, currency, default warranty/delivery copy, after-hours reply, competitor pricing doctrine).
- Brother's real WhatsApp business number (Task #17 full).
- Task #15 48-hour soak with 3-5 testers.
- Re-check Meta template approval status (`node scripts/check_templates.js`).
- Meta template re-submit if any are rejected.

## Deployment

**Production: Railway.** Deploy via:
- Auto-redeploy on push to main (preferred): `git push` from Serge's Terminal.
- Manual: `railway up --detach --ci` from the repo (uses local files, NOT git SHA, so `RAILWAY_GIT_COMMIT_SHA` will be null).
- Restart only: `railway redeploy --yes` (only when no build is in progress).
- Env var update: `railway variables --set KEY=VALUE`.
- Tail logs: `railway logs`.
- Status: `railway status`.

Project: `ample-laughter` / environment `production` / service `sunny-electrosun` / region us-west2 / 1 replica. Volume `sunny-electrosun-volume` mounted at `/data`. Hobby plan (verify in Settings → Billing).

**Local dev (PM2, optional)**:
```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 status`, `pm2 logs sunny`, `pm2 restart sunny`, `pm2 stop sunny`.

## Stakeholder-facing artifacts

- `presentation/sunny-overview.html`: single-file illustrated brochure for ElectroSun management. Self-contained, print-ready, no external dependencies. Open in any browser, or print to PDF for sharing. Reflects actual implemented behavior, not aspirational features.

## Cost guardrails

- **Opus everywhere** (classifier + reply + teacher + owner_qa): ~$0.025-$0.05 per message, 5-10x Sonnet pricing. At 500 messages/day that's $15-25/day or $450-750/month. Brother needs to confirm appetite. Use `MODEL_*` env overrides to step back to Sonnet/Haiku selectively if budget tightens.
- **Image vision** (Sonnet 4.6 path, kept as fallback): ~$0.01-$0.03 per image.
- **Whisper transcription**: ~$0.006/minute (~$0.005-$0.01 per typical voice note).
- **Storage**: ~200KB avg image, ~200MB/month at 1000 images. Volume is 1GB on Railway.
- `DAILY_LLM_BUDGET_USD=20` enforced via `cost_tracker.isOverBudget`. Exceeding it short-circuits to fallback paths.

## When in doubt

- If a behavior is ambiguous, **ask the project owner**. Do not guess.
- If a customer reply might invent facts (specs, prices, timelines, warranty terms, installation dates), escalate.
- If a code change requires a new dependency, **ask first**.
- If something looks like in-progress work or unfamiliar files, **investigate before deleting or overwriting**.
- Treat Meta retries, Claude rate limits, and SMTP failures as expected events, log them, do not crash.
- **Hard rule reminder**: before recommending or relying on a remembered fact (file path, function, key, URL), verify it still holds. The session-history file is a snapshot in time; the live code is authoritative.
- **Local zombie check**: when reports/messages appear that the cloud DB has no record of, run `ps aux | grep node` BEFORE explaining cloud data. Local `npm start` processes can post via the same Meta credentials with stale env.
