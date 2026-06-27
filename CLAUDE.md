# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

Detailed session-by-session changelog lives in `docs/session-history.md`. That file is the audit trail for "what shipped when and why"; this file is the always-true reference for what is currently in the codebase and what rules govern Sunny's behavior.

## Table of contents

1. [Current state](#current-state)
2. [Operational rules and configuration (LIVE in code)](#operational-rules-and-configuration-live-in-code)
3. [Mission](#mission)
4. [Who is who](#who-is-who)
5. [Tech stack (locked, do not deviate without asking)](#tech-stack-locked-do-not-deviate-without-asking)
6. [Folder structure](#folder-structure)
7. [How a message flows (the pipeline)](#how-a-message-flows-the-pipeline)
8. [Database schema and conventions](#database-schema-and-conventions)
9. [Environment variables](#environment-variables)
10. [Running locally](#running-locally)
11. [Cron schedule](#cron-schedule)
12. [Dashboard API](#dashboard-api)
13. [Admin web UI](#admin-web-ui)
14. [Prompts: where to tune Sunny's voice](#prompts-where-to-tune-sunnys-voice)
15. [Languages](#languages)
16. [Categories and escalation](#categories-and-escalation)
17. [Hard rules (do not violate)](#hard-rules-do-not-violate)
18. [Build status](#build-status)
19. [Deployment](#deployment)
20. [Stakeholder-facing artifacts](#stakeholder-facing-artifacts)
21. [Cost guardrails](#cost-guardrails)
22. [When in doubt](#when-in-doubt)

## Current state

Snapshot of what is live and what is pending. For per-session "why we shipped this" notes, read `docs/session-history.md` (chronological, newest first).

**Phase status.** Phase 1 (Setup), Phase 2 (Local end-to-end test), Phase 3 (Tune), Phase 5 (Cloud deploy) are closed. Phase 5 is cloud-first (Railway production); PM2 + named tunnel are local-dev only.

**Live state on Railway.**
- URL: https://sunny-electrosun-production.up.railway.app
- Volume `/data` mounts the SQLite DB at `/data/sunny.db`, media at `/data/media/`, datasheets at `/data/datasheets/`, per-item warehouse datasheets at `/data/warehouse_datasheets/`.
- **WABA `986225450549617`** ("Sunny-Electrosun"). Test WABA `1713234916358524` retired (Meta hard-locks test numbers to test WABAs; cannot be deleted). Migration completed 2026-05-08.
- **Production phone `+234 913 055 4747`** (phone_number_id `1143874562134501`). `code_verification_status: VERIFIED`, `platform_type: CLOUD_API`, `quality_rating: GREEN`, `name_status: PENDING_REVIEW` (display name "ELECTROSUN" awaiting Meta review, does not block sending; customers see raw number until approved).
- Cloud API registration PIN: `271828` (saved as `META_REGISTRATION_PIN` on Railway and local .env). Needed if Meta forces re-register.
- Templates on the live WABA (all APPROVED as of 2026-06-24): `owner_hourly_report_en` (UTILITY), `follow_up_24h_en` (MARKETING), `nightly_audit_ping_en` id `1738387983968228` (UTILITY), `owner_escalation_alert_en` id `1348312343392016` (MARKETING; Meta recategorized from the submitted UTILITY).
- **Owner/sales-desk escalation alerts now ride the `owner_escalation_alert_en` template (2026-06-24), so they deliver outside the 24h window.** `src/handler.js > sendOwnerAlert` sends the template first, falls back to free-form. Same classifier/routing as before (owners = big projects; Abuja/Lagos by region). All 4 routing numbers confirmed set on Railway. Delivery proven end to end (Patrick + developer line both `delivered`). NOTE: required a payment method on the WABA, without it template sends fail at delivery with Meta `131042 "Business eligibility payment issue"` (free-form in-window replies are unaffected); Serge added the card 2026-06-24 and it cleared.
- `OWNER_WHATSAPP=2347041328055` (brother). Verified via `/version` → `owner_whatsapp_tail: "8055"`. **Important: brother must accept the chat from "Message Requests" the first time. Until accepted, alerts are delivered but sit in his Message Requests folder, not main chat list.**
- `SPECIALIST_DIRECT_LINK=+234 704 132 8055` (brother's number, used for wa.me handoff link on HOT replies).
- `DISABLE_NOTIFICATIONS=true` (kill switch ON: report crons don't register at boot). Customer pipeline + auto-release cron still active.
- `OPENAI_API_KEY` FIXED + CONFIRMED 2026-05-29. New `sk-proj-` key (billing credit added) set on Railway, validated against OpenAI, and confirmed live: a real WhatsApp voice note was transcribed and Sunny answered the spoken question correctly. Note: key was pasted in chat, rotate later for hygiene.
- Model assignments live on Railway (set 2026-05-09): `MODEL_REPLY=claude-opus-4-7` (customer-facing, where rule-following margin matters); `MODEL_CLASSIFIER`, `MODEL_TEACHER`, `MODEL_OWNER_QA` all set to `claude-sonnet-4-6` for ~50-60% cost reduction. Code-level fallback in `src/claude.js` / `src/knowledge.js` / `src/owner_qa.js` still defaults to `claude-opus-4-7` if any env override is removed.
- `DAILY_LLM_BUDGET_USD=20`.
- `DISABLE_ESCALATIONS=false` (kill switch available, not engaged).
- `HUMAN_AUTO_RELEASE_MINUTES=15` (default; tunable).
- **Inbox-only team login LIVE (2026-06-01).** `INBOX_USER="Electrosun User"`, `INBOX_PASSWORD`, `INBOX_API_KEY` all set on Railway. Team member signs in at `/inbox` (or `/admin`) with username + password, is locked to the Inbox tab, server-enforced (403 on every non-inbox endpoint). Master `API_KEY` login unchanged (full admin). Credentials live in `~/Desktop/ElectroSun-Access-Credentials.md` (not in repo). Verified end-to-end in production.

**Source of truth:** https://github.com/sergeadaimy-hash/sunny-electrosun (private). Pushes from Claude's non-interactive shell hang on the credential prompt; Serge pushes manually with `git push` from his Terminal or `! git push` syntax in chat. Latest commit on main as of this snapshot: `ddd817f` (use `git log` for the live tip), pushed + deployed 2026-06-08. Most recent fixes (`ddd817f`): **city-unknown leads now default to the Abuja desk** (not the owner): `decideRecipient(abujaConfigured)` returns Abuja for region-unknown non-big escalations when the Abuja number is set; gather-first asks the city ONCE then routes to Abuja if still unanswered (answered-city leads still route to the named desk). And the **Sales Manager wa.me link is appended on ANY routed handoff that refers to the Sales Manager** (`isReferralHandoffThisTurn`), not just hot_lead/bulk/live_agent. A true ghost (no reply after the city question) is swept to Abuja after 5 min by `routeStaleDeferredHandoffs()` (commit `078d4f0`, on the always-on `*/5` cron; `STALE_HANDOFF_MINUTES`, 24h floor, 30/run cap, off when escalations disabled). Earlier 2026-06-08: Late-day screenshot fixes (`f1ab454`): **Owner Q&A now knows routing is configured** (`buildRoutingSummary()` injected as `snapshot.lead_routing`; stops Sunny telling the owner that Abuja-sales forwarding "needs to be set up" when it is live); **explicit live-agent requests escalate** (`isLiveAgentRequest()` -> `live_agent` routed escalation + Sales Manager link, fixes "Connect me with a live agent" being ignored); **product-interest openers state no price** (strengthened `system.md` so "I need Deye 5.3kwh" gets a clean availability + city reply, not the vague deflection); and **Sunny never uses customer names** (owner directive: address as "Sir"; the name was removed from the reply context via `buildKnownCustomerContext()` and the `system.md` addressing rule rewritten). Earlier 2026-06-08 commit: The 2026-06-08 session also shipped a routing audit + four fixes (`21db3dc`): **R1** the stall-guard escalation now respects gather-first (region-unknown stalls ask "Abuja or Lagos?" instead of falling to the general owner Patrick, the bug that misrouted ken stone/Lanre); **R3** `isPresenceOrImpatienceCheck()` short-circuits the stall guard for "is anyone here?"-type messages (reassure, no escalation); **R2** `runWindowScan({silent})` + an always-on window-scan cron expires stale `pending_queries` even when `DISABLE_NOTIFICATIONS=true` (the 253-row May backlog was suppressing fresh alerts via the follow-up-ping path); **B-#2** `BULK_ORDER_GLUE_RE` catches the "30pcscof" glue typo so bulk leads are not stalled. Still open: B-#1 double/triple replies (debounce-vs-burst timing, needs instrumentation). Earlier the same day: (a) **emoji reactions no longer trigger the "type your question" nag** (`9994adc`) — a WhatsApp reaction (`type: 'reaction'`) used to fall into the `unsupported` bucket; now `extractMessages` tags it `kind: 'reaction'`, `handleReaction` persists it silently, and the admin renders it as a badge on the target bubble (new `messages.reacted_to_wamid` column + `renderMessages()` in `public/admin.html`); and (b) after a live audit of all 34 customer threads, two reply-quality fixes (`6a7a427`): **price-strip garble** ("Available, per panel.", "available at, which", "at would do the job") now caught by the extracted, unit-tested `detectDanglingFragment()` in `src/claude.js` (comma added to the per-unit clause-start class + two `prep_orphan` detectors), and the **stall-guard last-resort ack** is now context-aware via `buildStallFallbackText()` in `src/handler.js` (only says "the figure" for genuine price context, else neutral). New `test/reply_guards.test.js`; suite 66/66. Still open (logged, not fixed): double/triple replies to one turn (debounce-window vs ad-opener timing). See `docs/session-history.md` 2026-06-08 entry. The 2026-06-07 session covered: routed customer link, real 2-phrase owner brief, 4-number Owner Chat tab, price-strip garble fix (`50b7e81`); header badge now "today's HOT leads" not all-time pending (`4218041`); owners/sales excluded from lead stats + Owner Q&A snapshot (`f16bfd6`); bulk-request loop fixed via `bulk_order` escalation = quote unit price + Sales Manager + routed direct line (`81a8b4f`); alert-only sales desks get a generic throttled ack + persisted inbound (`7465343`); region-routed customer contact-number as a wa.me link (`bb5ebef`); **owner routing rule finalized: owners (Patrick/Charbel) handle BIG PROJECTS ONLY, every other escalation routes to the Abuja/Lagos desk by region** (`8d1edae`, `1aa89d7`); region read from the CURRENT conversation only, never stale `contact.location`, gather-first asks "Abuja or Lagos?" when unknown (`8f5017b`, `a29d721`); Meta delivery-status logging (`5ef9d8c`); concise today-only Owner Q&A status replies (`6597f2e`). See `docs/session-history.md` 2026-06-07 entry for full detail. Use `git log --oneline` for the live tip. See `docs/session-history.md` for what each recent commit / push covers and `docs/audits/2026-05-15-sunny-full-audit.md` for the latest full audit.

**Resume plan.**
- ~~Brother needs to accept the Sunny chat from Message Requests~~ Patrick's chat is active and template alerts now deliver to him (`delivered`, 2026-06-24). Any NEW recipient who has never messaged the number should still send "hi" once so the first alert surfaces in their main list rather than as an unknown sender. The earlier "alerts silently dropped" symptom turned out to be the WABA billing gap (`131042`), now fixed.
- ~~Fix OpenAI key~~ DONE 2026-05-29 (new key set + redeployed + validated). Still pending: send a live test voice note to +234 913 055 4747 and confirm Sunny replies to the transcript (the stored inbound body should carry the `[voice note transcribed]:` prefix, not the "could not be transcribed" fallback).
- Brother to upload datasheets via admin → Warehouse Stock → per-item attachment (PDF/PNG/JPG/WEBP up to 15MB). Once uploaded, Sunny auto-attaches the matching file when customer asks for "datasheet" / "brochure" / "specs".
- Brother's pending pricing data: Sungrow, JA, Longi, Jinko panels.
- Section 11 decisions still pending (working hours, location tags, currency, default warranty/delivery copy, after-hours reply, competitor pricing doctrine).
- Display name "ELECTROSUN" review with Meta (1-3 business days from 2026-05-08). After approval customers see "ELECTROSUN" instead of raw number.
- Task #15 48-hour soak with 3-5 testers.
- Code nice-to-haves: hot-lead alert with conversation summary; admin "approve to permanent fact" button on daily learning items; per-contact avatar color hashing; image inline rendering in admin; RAG-style fact retrieval if knowledge base exceeds the 500-fact cap; re-enable owner teaching from WhatsApp with intent disambiguation; rotate the OpenAI key currently exposed in chat transcript.

**Code adaptation backlog** (new prompts reference these but the code does not yet honor them):
- Routing for `escalation_type='negotiation'` / `'repeat_complex'` / `'big_project'` currently falls through the silent_query pending-queries flow (header label is correct via `ESCALATION_HEADERS`, but routing is generic).
- `Active Promos`, `Big project context`, structured `Datasheet Knowledge` injection blocks not yet built.
- `contacts.category` rows now mix C1-C5 (legacy) with HOT/SERIOUS/COLD (new). Admin filters for C* still work for legacy rows.

## Operational rules and configuration (LIVE in code)

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
- **Contact-number requests are region-routed (2026-06-07).** When a customer explicitly asks for a phone/contact line, a deterministic fast-path in `src/handler.js` (`CONTACT_REQUEST_RE` -> `buildContactReply`) shares the REGIONAL SALES desk as a WhatsApp link only: Lagos -> Lagos Sales (`SALES_LAGOS_WHATSAPP`), Abuja -> Abuja Sales (`SALES_ABUJA_WHATSAPP`), unknown region -> ask Abuja or Lagos first. NEVER an owner number (Patrick/Charbel are big-deal owners, not regional desks). Skipped for HOT leads (HOT handoff already appends the routed Sales Manager link) and greetings. Bypasses the LLM + wa.me-strip guard so the link survives. This is a deliberate exception to "no wa.me URLs in replies", scoped to contact requests. The welcome card is unchanged.
- **Map pins (not written addresses) are shared on location/branch/office/pickup/visit/warehouse questions (2026-06-17 owner directive).** Sunny sends the Google Maps pin LINK, never a written address. Abuja office: `https://maps.app.goo.gl/bQvqyaQRHLZ51RXz6?g_st=aw`. Abuja warehouse: `https://maps.app.goo.gl/6zLRGrPwzBdQM7MEA?g_st=aw`. Lagos warehouse and offices: `https://maps.app.goo.gl/pQQk7H7uSeP7yRAs9?g_st=aw`. Live in `system.md` §10 (the locations block) + the worked example. These three map URLs are the ONLY URLs Sunny is allowed to send (deliberate exception to "no URLs in replies"; only the wa.me history scrub strips links, map links survive the output guards). The welcome card uses the same pins.
- **Pickup vs delivery.** When asked where to get the product: ask if pickup from Abuja warehouse, Lagos warehouse, or delivery (delivery fees excluded, charged separately).
- **Discount handling policy (2026-05-29).** Sunny has ZERO authority to set/offer/promise/hint at a discount and never names a percentage or discounted number. Two paths by order size (in `src/prompts/system.md` §7 + `classifier.md` negotiation rule):
  - *Small orders (1-2 items, or total under ₦15M):* decline warmly, no escalation. Scripted line: "Our prices are already fixed at discounted rates, so there's no further room on this one." Classifier sets `needs_escalation=false` for these (routine haggling does NOT ping the owner anymore).
  - *Large orders (over ₦15M total) where the customer seems serious about finalizing:* confirm they're ready to finalize now, judge if the ask is reasonable (~5% of item price max), then offer to raise it with the Sales Manager (no promise). Classifier escalates `escalation_type='negotiation'` (owner gets a NEGOTIATION alert; `expertContext` stays null so the §7 reply governs). A discount ask paired with a commitment phrase still classifies HOT.
  - The Sales Manager has final authority on all discounts.
- **"Sales Manager" is the customer-facing handoff title (2026-05-29).** Renamed from "specialist" across all customer-facing replies, the wa.me link label ("Direct line to the Sales Manager:"), and the LLM-instruction blocks. Internal names unchanged (`SPECIALIST_DIRECT_LINK` env var, `buildSpecialistLink()`, detection regexes now match BOTH "specialist" and "sales manager" so stall/handoff guards keep firing).
- **No wa.me URLs in replies.** System handles handoff via separate canned messages. `scrubHistoryContent()` strips wa.me URLs from prior assistant messages so Opus can't pattern-match on them.
- **Greetings get fresh greetings.** Empty conversation history sent to Opus, "Known about this customer" context block suppressed. Don't anchor on prior products/categories/temperatures unless customer references them.
- **Never address customers by name (2026-06-08 owner directive).** Sunny always uses "Sir" (or "Oga"), never the customer's name, never the WhatsApp profile name, even if the customer states their name. Enforced two ways: the name is no longer injected into the reply context (`buildKnownCustomerContext()` in `src/claude.js` omits it), and `src/prompts/system.md` "Addressing the customer" mandates "Sir". The name is still captured in the DB/admin for internal use.
- **Prices source = catalog table.** Never quote a price from owner-taught knowledge or "Past quote" entries. Past quotes are historical only.

### Conversation-state engine (`src/claude.js > buildConversationState`)

Before each Opus reply call, `buildConversationState(history, currentMessage)` builds a structured world model and injects it as a system block:
- Facts the customer shared: system size (kW/kVA), battery kWh, phase, brand mentions, project type, location, installer-vs-end-user signal.
- Questions Sunny has ALREADY asked (do NOT re-ask): installer-or-end-user, phase, location, load/quantity, budget, timeline.
- Customer asks/questions in the current message: extracted by question-mark + question-word heuristics.

`src/prompts/system.md` has matching sections: "How to use the Conversation state block", "Handling messages with multiple ideas", "Anti-repeat rule".

### Code-level reply guards (`src/claude.js`)

After Opus generates a reply, before sending:
1. **Price-dump guard**: if neither the current message nor the previous 2 customer messages contain a price-ask keyword AND reply has at least 1 price pattern, STRIP price patterns. If the strip leaves a dangling fragment the reply falls back to "Could you share more about your project so I can guide you better?" instead of sending the gibberish. Dangling detection lives in the exported, unit-tested `detectDanglingFragment(stripped)` (in `src/claude.js`, covered by `test/reply_guards.test.js`); it returns a `dangling_kind` or null. Kinds: `colon` ("Deye 16kW:."), `preposition` ("...price of."), `label_eol`, `orphan_digit`, `math_fragment`, `per_unit` (orphaned "per panel/unit"; the clause-start class includes a COMMA since 2026-06-08, which catches the most common garble "Available, per panel."), `copula` ("...is, available"), `prep_orphan` (2026-06-08: "available at, which" / "at would do the job", an orphaned preposition with no number; "looking at, Saheed?" is NOT flagged because "looking" is not a price-introducing word). Logs `claude.reply.prices_stripped` with `dangling_kind`.
2. **Repeat guard**: if new reply is byte-identical to the last outbound, overwrite with "Apologies, let me re-read your last message."
3. **Trailing-question strip**: if customer's last message is short factual (≤40 chars, no `?`) and reply ends with `?`, strip the trailing question sentence. Logs `claude.reply.trailing_question_stripped`.
4. **CTA-tail strip**: after the trailing-question strip, the CTA-tail guard removes trailing CTA-style closes ("Want to proceed?", "Should I send the account?", "Are you ready to pay?", "Would you like to wait or pre-order?", etc.). Skipped when the customer's last message carries a guidance/intent phrase (`recommend`, `suggest`, `i'?m ready`, `let's proceed`, `send (me) the account/proforma/invoice`, `where do i pay`, etc.) because CTA closes are appropriate then. Logs `claude.reply.cta_tail_stripped`.
5. **wa.me URL strip**: any wa.me link Opus emits gets removed.
6. **Prompt-leak detector** (`security.detectPromptLeak`): if the reply contains markers from the system prompt or internals (`Lagos sales floor`, `system prompt`, `claude-opus-4`, `OWNER_WHATSAPP`, `lead_temperature`, etc.), replace with a generic deflection. Logs `security.prompt_leak_blocked`.
7. **Owner-number leak detector** (`security.detectOwnerNumberLeak`): if the reply contains `OWNER_WHATSAPP` digits anywhere outside the canonical `wa.me/<number>` URL, replace with a generic deflection. Logs `security.owner_number_leak_blocked`.
8. **Phone-list-dump block**: if reply contains 3+ Nigerian-format phone numbers, replace with a deflection. Logs `security.phone_list_dump_blocked`.
9. **Catalog enumeration block**: if reply contains 5+ price patterns OR LIST-ASK intent + ≥3 price patterns, replace with "Could you tell me which model or system size you need? The team will quote that one." Defends bulk catalog extraction. Logs `security.catalog_enumeration_blocked`.
10. **SKU list dump block** (`sku_list_dump_blocked`): for non-BOM replies (no "Option N:" headers), if the reply lists 4+ distinct inverter SKUs OR 4+ distinct battery SKUs OR 6+ total SKUs, replace with: "Could you share what you're sizing for? Residential, commercial, a specific kW size or storage target. That way the team can point you at the right setup."
11. **Fabricated variant guard** (`detectFabricatedVariant`): for every (size + phase + stock-state) claim in the reply, verify a matching row exists in `warehouse_items`. If no match AND the context isn't a negation, the reply is replaced with "Let me confirm the exact availability of that configuration with the team and get back to you shortly." Logs `claude.reply.fabricated_variant_blocked`. **2026-06-27 fix (SUN-10K incident):** pure core extracted as `detectFabricatedVariantFromItems(text, items)` (exported + unit-tested in `test/reply_guards.test.js`). Three bugs fixed: (a) the stocked-size map was built with an inline `/Nkw/` regex that never matched real `SUN-12K`-style SKUs, so the map was silently EMPTY in production and the guard near-inert; it now reads sizes via `warehouse.extractSizeNumbers` (matches a bare `K`) and phase via `warehouse.itemPhase` (LP1->single, LP3/HP3->three); (b) the size->phase->stock bridge classes were `[\s\w,-]`, which broke on the `)` and `.` in "(10kW, 1-phase) is 2.35M NGN, available" so the claim never matched; widened to `[\s\w,.()/:%-]`; (c) scope restricted to inverter phases (single/three) so a battery LV/HV availability line never false-positives on a shared size number (e.g. "16kWh LV pack"). Returns null when the stocked-size map is empty (no stock loaded).
12. **HV BOM validator** (`hv_validator.validateAndFixHvBom`): pure-logic post-validator on every HV BOM. Options that violate min-clusters, the per-series floor (BOS-G ≥5, BOS-A ≥7, BOS-B ≥7), even-split, PDU-mismatch, or pair LV inverter with HV battery (`non_hv_inverter`) are silently stripped before send. Surviving options renumbered; framing line ("all three options") rewritten to match survivor count. On all-dropped: reply replaced with "Let me confirm the exact configuration with the team and send you the options shortly." Logs `claude.reply.hv_bom_options_dropped` / `claude.reply.hv_bom_all_options_invalid`. Per-contact validator feedback loop: drops recorded under contact id (TTL 10 min) and re-injected as a system block on the next turn to stop the model regenerating the same broken BOM.
13. **BOM cleanup pass** (`cleanupBomReply`): final pass after the HV validator. Strips §9.0 / §9LV.x / §9HV.x / "Check N:" / "Step N:" doctrine leaks; strips parenthetical sizing reasoning (`(≤ 20kW)`, `(≤ 32 packs)`); strips default-routing phrases ("so LV is the default", "small-app default"); strips inline "Option N: SKU (skipped|not in stock|dropped)" sentences (dropped options must be invisible); trims recommendation reasoning to bare `Recommended: Option N`; forces blank lines before BOM block headers and single newlines before glued body labels (Inverter:/Battery:/Cluster split:/Control Box:/Racks:/Cables:); strips `ceil(...)` math, `**Sizing logic:**` / `**Floor check:**` / `**Pre-send checklist:**` internal labels, narration ("Running the configuration now.", "Only SE-F16 survives.", "Let me compute"), dropped-SKU lines without "Option N:" prefix, checklist survivor rows. Logs `claude.reply.bom_cleanup_applied`.
14. **No-double-dashes output guard**: runs LAST. Special-case "Option N — BOS-X" → "Option N: BOS-X"; en-dash between digits stays as single hyphen (number ranges like "13-14kW"); em/en-dash with spaces becomes ", "; ASCII "--" becomes ", ". Cleanup passes for repeated commas, double spaces, stray comma-before-punctuation. Logs `claude.reply.dashes_stripped`.

### Security layer (`src/security.js`)

Single module exposing rate limits, length caps, injection-attempt detection, and output-side leak detection. All defaults configurable via env vars; all triggers logged with `security.*` keys for observability.

**Input-side guards (in `src/handler.js > handleInbound`):**
- `security.checkRateLimit(contactId)`: per-contact rate limit. Default 15 messages/minute (`RATE_LIMIT_PER_MINUTE`) and 300/day (`RATE_LIMIT_DAILY`). Owner is exempt. Blocked messages are dropped without persistence or reply. Logs `security.rate_limit_blocked`.
- `security.checkImageQuota(contactId)`: per-contact daily image-vision quota. Default 10/day (`MAX_IMAGES_PER_DAY`). When exceeded, the image is converted to a text marker so the message still flows, but vision is skipped. Logs `security.image_quota_exceeded`.
- `security.truncateInbound(text)`: caps single inbound message at 2000 chars (`MAX_SINGLE_MESSAGE_CHARS`). Logs `security.inbound_truncated`.
- `security.detectInjectionAttempt(text)`: scans for classic prompt-injection phrases ("ignore previous", "system prompt", "you are now", "DAN mode", `<system>` tags, etc.). Logs `security.injection_attempt_detected` with matched patterns. Detection is observability-only, does NOT block; Opus's own resistance plus the output-side leak detectors handle blocking.

**Batch-level guards (in `src/handler.js > processCustomerBatch`):**
- `security.truncateBatch(text)`: caps the combined debounced batch at 4000 chars (`MAX_COMBINED_BATCH_CHARS`). Logs `security.batch_truncated`.
- `security.checkEscalationThrottle(contactId)`: at most one BRAND-NEW non-HOT escalation alert per contact per 30 minutes (`ESCALATION_COOLDOWN_MS`). Defends specialist-spam attacks against the brother's WhatsApp. Logs `security.escalation_throttled`.
- `security.checkHotEscalationThrottle(contactId)`: at most one HOT escalation alert per contact per 60 seconds (`HOT_ESCALATION_COOLDOWN_MS`). Separate from the 30-min generic throttle because a HOT signal must always reach the owner; the 60s cap only defangs back-to-back identical retries.
- `security.checkFollowupThrottle(contactId)`: at most one FOLLOW-UP ping per contact per 5 minutes (`FOLLOWUP_COOLDOWN_MS`). Used by the open-pending-query path so the brother gets a heads-up when the same customer keeps pushing on an unresolved query, without flooding. Logs `security.followup_throttled`.
- `notifyOwnerForEscalation` (in `src/handler.js`, replaces the older `dispatchEscalation`): single entry point for OWNER-side notification. **No longer touches the customer reply.** Returns `{ openPending, freshPendingId, ownerNotified, escalationType, throttled }`. Behavior:
  1. If `escalation_type === 'hot_lead'`: route through `checkHotEscalationThrottle` (60s). Auto-retry once after 1.5s if first Meta send fails (`handler.escalation.hot_alert_first_send_failed_retrying`).
  2. Else if an open `pending_queries` row already exists for this contact (`getOpenPendingQueryForContact`): send a "Follow-up on [QID:N], same customer is still asking" message to the owner (throttled by `checkFollowupThrottle`), do NOT create a new pending_queries row, do NOT touch the main escalation throttle.
  3. Else: fall through to `checkEscalationThrottle`. If allowed, create the pending_queries row and send the regular alert.
  The customer reply is now ALWAYS produced by `generateReply` with an `expertContext` block (see below), never by a hard-coded canned line. Reason: the old canned-reply behavior made Sunny look like a robot when customers pushed back on an open query ("When?", "It's been a day"); each follow-up got the same word-for-word "A specialist will confirm the exact figure for you shortly." reply. The new flow lets the LLM react to the actual customer message under tight constraints (third person, no first-person stalls, no invented prices/ETAs).

**Output-side guards (in `src/claude.js > generateReply`):** see "Code-level reply guards" above, items 6-14.

**Stall-language guard (in `src/handler.js > processCustomerBatch`):** after `generateReply` returns, before sending, `security.detectStallLanguage(reply.text)` checks for first-person stall patterns ("let me check / I'll confirm / will revert / will get back to you / one of our sales engineers will reach out / give me a moment") and third-person handoff phrases ("the team will confirm", "a specialist will reach out", "team member will follow up"). The guard only runs when no `expertContext` was already injected (i.e. the LLM was on a normal reply path and stalled anyway). If matched AND `DISABLE_ESCALATIONS=false`, the guard now branches (R1/R3, 2026-06-08):
- **Presence/impatience check** (`isPresenceOrImpatienceCheck(text)`, e.g. "Is anyone here to respond?"): reply "Yes, I'm here. How can I help you with your solar needs?", NO escalation. Logs `handler.stall_presence_check_reassured`.
- **Region not yet known** (`!ownerRouting.routingInfoSufficient(classification)`, i.e. region unknown and not a big project): do NOT ping the owner. Set `deferred_handoff` and regenerate with `buildGatherFirstContext` ("Abuja or Lagos?"). This mirrors the classifier escalation path; without it, region-unknown stalls fell straight to the general owner (Patrick), the bug that misrouted ken stone/Lanre on 2026-06-08. Logs `handler.stall_gather_first_deferred`.
- **Otherwise** (enough to route): Call `notifyOwnerForEscalation` with `escalation_type='silent_query'` and `source='stall_guard'` to ping the routed recipient and create a pending_queries row (or follow up on an existing one).
- Re-call `generateReply` with the freshly built `expertContext` ("Awaiting expert input" block). If the regenerated reply is stall-free, send it.
- If regeneration fails or still stalls, send a short ack. When an alert/pending row exists, the ack text comes from `buildStallFallbackText(contextText)` (exported from `src/handler.js`, unit-tested): it keeps "Noted. Will share the figure once confirmed." ONLY when the context (open-query text or the customer's own message) is a genuine price ask, and returns a neutral "Noted, the team will get back to you on this shortly." otherwise. When no alert was created the ack is "Noted. The team is on it." Logs `handler.stall_regen_failed_used_generic_ack` or `handler.stall_replaced_no_alert`.
Reason: previously the stall-guard fell back to the canned `SILENT_QUERY_REPLY`, which is the very behavior we are trying to eliminate. Now the guard re-runs the LLM under explicit awaiting-expert constraints; the canned line only appears as a final last-resort ack when the LLM keeps refusing to honor the block. The figure-vs-neutral split (2026-06-08) fixes conv 2599, where "Is anyone here to respond?" got a reply about a non-existent "figure".

**Reply-handoff backstop (in `processCustomerBatch`):** split into `HOT_HANDOFF_REPLY_RE` (HOT-specific markers like "account details and final figures", "send you the account") and the generic `HANDOFF_REPLY_RE` (team-follow-up markers). HOT backstop runs FIRST and requires `escResult.escalationType === 'hot_lead'` AND `ownerNotified=true`. If a HOT marker appears in the reply and no hot_lead alert has fired this turn, fire one (source `hot_handoff_in_reply`). Prevents "Yes send me account" from being demoted to a silent-query follow-up ping on an old QID instead of escalating as a fresh HOT.

**Expert context block (`buildExpertContext` in `src/handler.js`).** Built per turn, injected into `generateReply` as `options.expertContext`:
- HOT lead variant: tells Sunny the customer is ready to commit; instructs a one-sentence acknowledgement, third-person handoff to specialist, no URLs (system appends the wa.me link automatically).
- Awaiting-expert variant: lists the open pending query text, wait time so far ("3h 12m"), and voice rules (acknowledge what customer JUST wrote, third person, no first-person stalls, no invented prices/ETAs, empathize on frustration without over-apologizing, two sentences max, vary phrasing across replies).
- Welcome-already-sent variant: when the welcome card just fired AND the customer's first message also contained a substantive question, prefix tells Sunny not to greet again, not to repeat any address or phone number, and to answer the question directly in 1 to 2 short sentences.
The block is ALSO documented in `src/prompts/system.md` ("Dynamic context blocks the system may inject") so Sunny has a stable reference even if the per-turn block is somehow missing.

**HOT-lead wa.me link**: ONLY for HOT escalations, `processCustomerBatch` appends `\n\nDirect line to the Sales Manager: <wa.me link>` to the LLM-generated reply text just before send. The link points at the SAME recipient the owner alert was routed to (2026-06-07): `notifyOwnerForEscalation` returns `recipientNumber`/`recipientLabel`, and `buildSpecialistLink(customerMessage, overrideNumber)` uses that routed number (Abuja sales / Lagos sales / Charbel / Patrick). Falls back to `SPECIALIST_DIRECT_LINK` when no recipient was resolved this turn. The LLM is explicitly instructed not to produce URLs. Silent_query, pricing_question, negotiation, and all other escalation types do NOT get the link (would be spammy).

### Kill switches and runtime overrides (Railway env vars)

| Env var | Effect |
|---|---|
| `DISABLE_NOTIFICATIONS=true` | Report crons don't register at boot (no 2-hour, daily, or daily-learning reports). Customer pipeline unaffected. Logs `cron.all_schedules_skipped_at_boot` once. **Exceptions that always run:** the auto-release cron, AND (since 2026-06-08, R2) the `*/30` window-scan, which runs in `{silent:true}` mode: it still expires stale `pending_queries` (so they don't suppress fresh routed alerts or inflate the open-query count) but sends no owner reminders/alerts. |
| `DISABLE_ESCALATIONS=true` | All escalations (hot_lead, silent_query) get demoted to normal Sonnet/Opus replies. Useful for testing without canned holding messages firing. |
| `MODEL_CLASSIFIER`, `MODEL_REPLY`, `MODEL_TEACHER`, `MODEL_OWNER_QA` | Override the four Opus defaults selectively. E.g. `MODEL_REPLY=claude-sonnet-4-6` to step back if budget tightens. |
| `MESSAGE_DEBOUNCE_MS` | Per-contact debounce window in ms (default 6000). When customer sends multiple messages back-to-back, classification + reply fires ONCE per window with combined input `[Customer sent N messages back to back]\nmsg1\nmsg2\nmsg3`. |
| `DAILY_LLM_BUDGET_USD` | Soft daily cap (currently 20). `src/cost_tracker.js > isOverBudget` short-circuits classify and generateReply to fallback paths when daily spend exceeds it. |
| `KNOWLEDGE_PROMPT_MAX_FACTS`, `KNOWLEDGE_PROMPT_BUDGET_CHARS` | Cap on how many active facts get injected into Sonnet/Opus prompt (default 500 facts, 30KB chars). |
| `WHISPER_MODEL` | OpenAI model for voice-note transcription (default `whisper-1`). |
| `WHISPER_LANGUAGE` | Source-language hint passed to Whisper (default `en`). Stops auto-detect from mis-transcribing accented English into Arabic/other. Set to empty string to restore auto-detect. |
| `OPENAI_API_KEY` | Required for voice-note transcription. Set + validated on Railway 2026-05-29. |
| `MEDIA_DIR` | Where downloaded WhatsApp media is stored. Defaults to `<DB_PATH dirname>/media`, set to `/data/media` on Railway. |
| `SPECIALIST_DIRECT_LINK` | Digits-only WhatsApp number for the wa.me click-to-chat link appended to HOT lead replies. Currently set to brother's number. |
| `PUBLIC_BASE_URL` | Public base URL used to deep-link the owner into the admin inbox from escalation alerts. Format: `<PUBLIC_BASE_URL>/admin#conv=<conversation_id>`. No trailing slash. Defaults to `https://sunny-electrosun-production.up.railway.app` when unset. |
| `GITHUB_TOKEN` | Personal Access Token with `Contents: write` on the Sunny repo. Required for the Rules editor's Save button to commit + push edits. If unset, Save still writes to the running container's filesystem but the change is wiped on the next git redeploy. |
| `GITHUB_REPO` | `<owner>/<repo>` for the GitHub Contents API call. Defaults to `sergeadaimy-hash/sunny-electrosun`. |
| `GITHUB_BRANCH` | Branch to commit prompt edits to. Defaults to `main`. |
| `RAILWAY_TOKEN` | Railway Project Token (Project Settings → Tokens). The Rules editor's "Deploy to live" button uses this to call the Railway GraphQL API (`serviceInstanceRedeploy`) with the auto-injected `RAILWAY_SERVICE_ID` + `RAILWAY_ENVIRONMENT_ID`. If unset, the button suggests pressing Save instead (which pushes to main and auto-redeploys via Railway's GitHub integration). |
| `RAILWAY_DEPLOY_HOOK_URL` | Optional. Legacy deploy hook URL (older Railway UIs). Tried first if set. Recent Railway plans hide this feature, so most users should use `RAILWAY_TOKEN` instead. |
| `WAREHOUSE_DATASHEETS_DIR` | Where per-item datasheets are stored. Defaults to `<DB_PATH dirname>/warehouse_datasheets/`. On Railway: `/data/warehouse_datasheets/`. |
| `WAREHOUSE_PHOTOS_DIR` | Where per-item product photos are stored. Defaults to `<DB_PATH dirname>/warehouse_photos/`. On Railway: `/data/warehouse_photos/`. |
| `PHOTO_MAX_BYTES` | Max bytes per uploaded product photo (default `5242880` = 5MB). |
| `PHOTO_SEND_CAP` | Max number of photos Sunny sends to a customer in a single photo-request (default `3`). Extra photos remain in admin for internal reference. |
| `RATE_LIMIT_PER_MINUTE` | Per-contact message rate limit (default 15). Owner exempt. Blocked messages dropped without persistence or reply. |
| `RATE_LIMIT_DAILY` | Per-contact daily message cap (default 300). Owner exempt. |
| `MAX_SINGLE_MESSAGE_CHARS` | Per-message inbound truncation limit (default 2000). |
| `MAX_COMBINED_BATCH_CHARS` | Debounced batch truncation limit (default 4000). |
| `ESCALATION_COOLDOWN_MS` | Per-contact BRAND-NEW escalation cooldown for NON-HOT escalations only (default 1800000 = 30 minutes). HOT escalations have their own shorter throttle (see `HOT_ESCALATION_COOLDOWN_MS`). Repeat first-time triggers within the window demote to a normal reply. Does NOT apply when an open pending_queries row already exists for the contact (the follow-up channel takes over). |
| `HOT_ESCALATION_COOLDOWN_MS` | Per-contact HOT-lead alert cooldown (default 60000 = 60 seconds). Separate from the 30-min `ESCALATION_COOLDOWN_MS` because a HOT signal ("send me account", "i want to pay") must always reach the owner. The 60s cap only defangs back-to-back identical retries from the customer's side. |
| `FOLLOWUP_COOLDOWN_MS` | Per-contact follow-up-alert cooldown for the open-pending-query path (default 300000 = 5 minutes). Bounds how often the brother gets "same customer still asking on [QID:N]" pings. |
| `MAX_IMAGES_PER_DAY` | Per-contact daily image-vision quota (default 10). When exceeded, images flow through as text markers, vision is skipped. |
| `HUMAN_AUTO_RELEASE_MINUTES` | Threshold for the auto-release cron. Default 15. Conversations with `human_handled=1` that have been idle past this threshold (max of `human_handled_at` and `last_human_reply_at`) are released back to Sunny. |
| `STALE_HANDOFF_MINUTES` | Ghost-sweep threshold (default 5). A lead asked "Abuja or Lagos?" that never answers with a city is routed to the Abuja desk after this many minutes (`routeStaleDeferredHandoffs`, on the `*/5` cron). 24h floor, 30/run cap, off when `DISABLE_ESCALATIONS=true`. |
| `META_REGISTRATION_PIN` | Cloud API registration PIN (current: `271828`). Needed if Meta forces re-register of the phone number. |
| `ELECTROLEADS_OPENER` | The fixed opener that the external ElectroLeads outreach agent pre-fills in its wa.me click-to-chat link (default `Hello Electrosun team, I'm reaching out for a quotation`). `detectLeadSource()` in `src/handler.js` normalizes (case/punctuation/whitespace) and matches it on a contact's inbound; on first match it sets `contacts.lead_source='electroleads'` (once, never overwritten). A plain wa.me link carries NO webhook referral metadata (that exists only for Click-to-WhatsApp Ads), so the opener text is the only available signal. Surfaced in admin Contacts ("Source" column + search) and the Excel export ("Lead source"). Change this value to retune detection without a code change. |
| `ENABLE_NIGHTLY_AUDIT` | When true, registers the nightly self-improvement audit cron (`0 21 * * *` Africa/Lagos). Independent of `DISABLE_NOTIFICATIONS`. Default off. |
| `MODEL_AUDIT` | Model for the nightly audit (default `claude-sonnet-4-6`; must be a prefix the cost tracker recognizes). |
| `AUDIT_MAX_CONVERSATIONS` | Max conversations audited per nightly run (default 60). |
| `AUDIT_PING_WHATSAPP` | Recipient of the nightly audit "proposals waiting" ping. Defaults to `OWNER_WHATSAPP`. Set to a developer number while testing so the owner is not pinged; the owner's other alerts stay on `OWNER_WHATSAPP`. Currently the developer line (`966502392650`). |
| `AUDIT_PING_TEMPLATE` / `AUDIT_PING_TEMPLATE_LANG` | Name + language of the approved Meta template used for the nightly ping (defaults `nightly_audit_ping_en` / `en`). `sendOwnerAuditPing` sends this template FIRST (window-independent, so it is not silently dropped outside the 24h window) and falls back to the free-form `buildOwnerAuditPing` text if the template send fails (which also covers the PENDING-approval period). Template id `1738387983968228`, submitted PENDING 2026-06-16 under the live WABA. Body vars: {{1}} total, {{2}} lessons, {{3}} facts, {{4}} code notes; static "Open admin" URL button. Reason: 2026-06-16 the free-form ping for run #1 (164 findings) was accepted by Meta but never delivered because the developer line was outside its 24h window. |
| `OWNER_ALERT_TEMPLATE` / `OWNER_ALERT_TEMPLATE_LANG` | Name + language of the Meta template used for owner / sales-desk escalation alerts (defaults `owner_escalation_alert_en` / `en`). `src/handler.js > sendOwnerAlert` sends this template FIRST (window-independent, so an alert to an owner or sales desk that has been silent >24h is not silently dropped) and falls back to the free-form `buildOwnerAlertText` if the template send fails (covers the PENDING-approval period, an unset/wrong env, or any Meta rejection). ONE template serves BOTH owner alerts AND sales-desk alerts AND the repeat follow-up ping, because all three share the same body with only the header line varying. Body vars: {{1}} header (HOT LEAD / FOLLOW-UP NEEDED / NEGOTIATION / BIG PROJECT / etc.), {{2}} customer phone, {{3}} product ("Not specified" when none), {{4}} single-line situation summary, {{5}} full `https://wa.me/...` follow-up link pre-filled with the draft. NO URL button: Meta rejects wa.me as a button destination (error_subcode 2388081), and a 5-var version was rejected for the parameters-to-words ratio (2388293) and for ending on a variable (2388299), so the final shape is 4 vars, product folded into {{3}}, link in body text {{4}}, fixed trailing sentence after it. Components built by `buildOwnerAlertTemplateComponents` in `src/owner_alert.js`. Template id `1348312343392016`, **APPROVED 2026-06-24** under the live WABA. Meta recategorized it UTILITY -> MARKETING on approval (reads the copy as promotional). **2026-06-27 ROOT CAUSE: the MARKETING category broke delivery, not just cost.** A FOLLOW-UP NEEDED alert sent to Patrick (`owner_escalation_alert_en` template, accepted by Meta with `whatsapp.template.ok` + messageId) was then dropped at delivery with `whatsapp.delivery.failed error_code 131049` ("This message was not delivered to maintain healthy ecosystem engagement.") = Meta's **per-user MARKETING-template frequency cap**. UTILITY templates are exempt. The "leave it MARKETING for cost" call (2026-06-24) is therefore reversed: it silently throttles operational alerts. **FIX IN FLIGHT:** new UTILITY template `owner_escalation_alert_v2_en` (same 4-var structure, so NO code change in `buildOwnerAlertTemplateComponents`) that KEEPS the wa.me one-tap link (owner directive 2026-06-27) but strips the promotional tone. Calibration that justifies keeping the link: on our own WABA `follow_up_24h_en` (no link, re-engagement tone) is MARKETING while `owner_hourly_report_en` (no link, transactional) is UTILITY, so Meta's classifier reacts to TONE, not only links. **RESOLVED 2026-06-27: v2 APPROVED as UTILITY by Meta, `OWNER_ALERT_TEMPLATE=owner_escalation_alert_v2_en` set on Railway (service redeployed), and proven end to end (a test send via v2 went `sent -> delivered -> read` on the developer line, no 131049).** Owner/sales alerts now escape both the 24h window AND the MARKETING frequency cap, link intact. WATCH: this holds only while Meta keeps v2 UTILITY; the wa.me link is the only remaining marketing-ish signal, so spot-check the live category with `check_templates.js` if alerts ever go quiet again. The old `owner_escalation_alert_en` (MARKETING) is left on the WABA unused as a fallback name. If Meta ever re-tags v2 MARKETING, the wa.me link is proven to be the trigger and the owner must choose link vs guaranteed delivery (admin-button fallback, the proven-UTILITY shape used by `nightly_audit_ping_en`). Test alert via `node scripts/send_test_escalation.js`. Status via `node scripts/check_templates.js`. |

### Models, costs, and budget

- Code-level fallback default: `claude-opus-4-7` for all four call sites. Live Railway env (since 2026-05-09): only `MODEL_REPLY` runs Opus; classifier, teacher, and owner_qa run `claude-sonnet-4-6`.
- Cost reality on Opus: ~$0.025-$0.05 per message (vs ~$0.005 on Sonnet). At 500 messages/day that's $15-$25/day.
- Opus pricing per million tokens (cents, in `src/cost_tracker.js`): in 1500 / out 7500 / cache_read 150 / cache_write 1875.
- Sonnet pricing (kept for fallback): in 300 / out 1500 / cache_read 30 / cache_write 375.
- Haiku pricing (kept for fallback): in 80 / out 400 / cache_read 8 / cache_write 100.
- Per-day spend tracked in `daily_costs` table (cents, integers). One-time over-budget alert to owner via window-scan cron.
- **Prompt cache TTL = 1 hour (2026-05-30).** All six `cache_control` blocks (classifier + reply in `src/claude.js`, `owner_qa.js`, legacy teacher in `knowledge.js`) carry `ttl: '1h'`. Reason: a May 1-30 cost analysis (`Sunny-Dev-Final` key) showed cache WRITES were 65% of the $331 month ($214), because the default 5-minute cache expires between sparse WhatsApp messages and rewrites the large system prompt at the 1.25x write premium nearly every turn. The 1h window (2x write price, but survives typical conversation gaps) converts most repeat writes into 0.1x reads. Pure billing change, zero effect on model/prompts/replies. Reversible by removing `ttl: '1h'`.

### Code modules and their roles

| File | Role |
|---|---|
| `src/owner_qa.js` + `src/prompts/owner_qa.md` | Owner Q&A mode. Brother WhatsApps Sunny questions about his data, gets answers from a live snapshot (today's stats, last 24h hot leads, pending queries, recent contacts, brother's own chat history, active facts count, AND `lead_routing` since 2026-06-08). `buildRoutingSummary(configuredRecipients())` produces the `lead_routing` block so Owner Q&A answers routing questions factually (routing is active, which Abuja/Lagos desks are set, how leads forward by city) instead of guessing that forwarding "needs to be set up". |
| `src/knowledge.js` + `src/prompts/teacher.md` | LEGACY 2026-05-10. Live facts panel was retired; doctrine now lives entirely in `src/prompts/system.md`. CRUD + endpoints kept so older facts can still be read; `formatKnowledgeForPrompt()` is no longer injected into Sunny's system blocks. Knowledge_entries CRUD + Haiku/Opus teaching extraction. Dedup at insert (normalised leading 120 chars per category). 500-fact / 30KB cap on prompt injection. |
| `src/catalog.js` | catalog_items + catalog_notes CRUD. `formatCatalogForPrompt()` exists but is NO LONGER injected into Sunny's prompt (retired 2026-05-10 in favor of warehouse stock). Catalog tab in admin still renders for legacy reference. |
| `src/warehouse.js` | warehouse_items + warehouse_stock (per-location: abuja / lagos). `formatWarehouseForPrompt()` is the authoritative stock + price block injected into both classifier and reply system blocks. CRUD via admin "Warehouse Stock" tab; each item auto-creates an Abuja stock row and a Lagos stock row on add. State is one of `in_stock` / `out_of_stock` / `incoming`; `incoming` rows can carry an ETA date and a coming_note quoted verbatim to customers. Per-item datasheet attachment: `setDatasheet`, `removeDatasheet`, `findItemDatasheetByQuery`. Files stored at `WAREHOUSE_DATASHEETS_DIR` (defaults to `<DB dir>/warehouse_datasheets/`). When a customer asks for a datasheet, `src/handler.js` looks up the matching warehouse item, uploads the file to Meta (cached 25 days), and sends it as a WhatsApp document. **Matcher core (2026-05-30):** both `findItemDatasheetByQuery` and `findItemPhotosByQuery` delegate to a shared DB-free `selectItemByQuery(items, message, recentText, opts)`: size gate -> **phase gate** -> token-overlap tiebreak -> single-candidate fallback. `detectPhaseIntent()` reads `single`/`three`/`null` from the message (three wins when both appear; history consulted only when the message names neither phase nor size); `itemPhase()` reads phase from the Deye model (`LP3`/`HP3` => three, `LP1` => single, batteries/racks => agnostic). A phase-qualified request is restricted to exactly the matching-phase items, and a request whose phase has no matching item returns null rather than send the opposite-phase sheet. `opts.hardSizeGate` (photos) / `opts.singleFallbackNeedsSize` (datasheets) preserve each matcher's prior behavior. Covered by `test/matcher.test.js` (`npm test`). |
| `src/prompt_store.js` | Read/write/cache wrapper for the four prompt files (`system.md`, `classifier.md`, `teacher.md`, `owner_qa.md`). 30-second in-memory cache busted on every write. `claude.js`, `knowledge.js`, and `owner_qa.js` all source their system prompts via this store, so a Save in admin takes effect on the next customer message without a process restart. |
| `src/datasheets.js` | LEGACY 2026-05-10. The dedicated `datasheets` table + Meta upload helpers still exist but the admin sub-panel is removed and the prompt block is no longer injected. Datasheets now live on warehouse_items. The old datasheets table is preserved for migration; the brother can re-attach previously uploaded sheets onto warehouse rows. Schema: id, label, keywords, filename, file_path, mime_type, size_bytes, meta_media_id, meta_media_uploaded_at (Meta TTL 30 days; refresh after 25), status, created_at, updated_at. 15MB cap. Mime allow-list: pdf, png, jpeg, webp. Exposes `listDatasheets`, `getDatasheetById`, `addDatasheet` (base64 input), `updateDatasheet`, `deleteDatasheet` (soft archive default), `setMetaMediaCache`, `isMetaMediaFresh`, `findDatasheetByQuery` (token-overlap match against label+keywords), `formatDatasheetsForPrompt`. |
| `src/cost_tracker.js` | `recordUsage` after every Anthropic response; `isOverBudget` short-circuit. `calcCostCents` bills each token type once at its own rate (input_tokens is already non-cached; cache_read and cache_write are separate fields). A 2026-05-21 fix removed a double-subtraction that was clamping cache-heavy calls to 0 cents and undercounting spend. `getTodayStats` / `getMonthStats` / `getMonthSpendCents` back the admin spending panel (month = `date LIKE 'YYYY-MM%'`, UTC). |
| `src/window_monitor.js` | `*/30 * * * *` cron via `runWindowScan(opts)`. Past 22h: one-time reminder to owner. Past 24h: marks status='expired' and alerts owner. Idempotent via `expiring_warning_sent_at`. `opts.silent` (2026-06-08) does the expiry only, with no owner reminders/alerts/budget warnings, so the cron can run under `DISABLE_NOTIFICATIONS=true` for hygiene without pinging the owner. |
| `src/transcribe.js` | OpenAI Whisper wrapper for voice-note transcription. Falls back to "[Customer sent a voice note that could not be transcribed]" if OPENAI_API_KEY missing. |
| `src/hv_validator.js` | Deterministic HV BOM validator. Engineering constants are the single source of truth (the prompt mirrors them in §9 but the code is authoritative): MODULE_KWH per series, SERIES_MIN_PER_CLUSTER (BOS-G: 5, BOS-A: 7, BOS-B: 7), MAX_PER_CLUSTER per (inverter, series), SERIES_PDU. Pipeline: `splitIntoOptionBlocks` → `parseOptionBlock` → `computeExpectedClusterSplit` → `validateOption` (drop on floor / too-many-clusters / uneven split / pdu-mismatch / `non_hv_inverter` for LV inverter paired with HV battery) → `rewriteFramingForSurvivorCount` → `validateAndFixHvBom` orchestrates. Exports `recordDropsForContact` / `consumeDropsForContact` / `formatPriorDropsContext` for the per-contact feedback loop. |
| `src/whatsapp.js > downloadMedia(mediaId)` | Two-step Meta media download (metadata GET → signed URL GET with auth, 25MB cap, 30s timeout). |
| `src/whatsapp.js > uploadMediaToMeta(filePath, mimeType, filename)` | Multipart POST to `/<phone-id>/media`, returns Meta media_id (cached on the datasheet / warehouse row). |
| `src/whatsapp.js > sendDocument(to, mediaId, filename, caption)` | POST to `/messages` with type=document, native WhatsApp document message. |
| `src/handler.js > handleOwnerNonQueryMessage` | Routes brother's WhatsApp messages to `answerOwnerQuestion`. Owner replies to alerts (`msg.replyToId` matching pending QID) still route via `handleOwnerReply`. |
| `src/handler.js > recoverOrphanedInbound(maxAgeMinutes)` | Scans inbound messages without a subsequent outbound reply (and not human_handled, not from owner) and re-queues them through the normal pipeline. Called 3s after `app.listen`. Default 10 minutes. Bug it fixes: in-memory debounce queue is wiped on container restart. |
| `src/handler.js` debounce queue | Per-contact in-memory queue, fires once per `MESSAGE_DEBOUNCE_MS` window. Persists each message to DB immediately for admin visibility. |
| `src/handler.js > handleUnsupported` (legacy) | Polite "text only" fallback for unsupported message types. Voice notes now flow through transcribe instead. Emoji reactions no longer reach this path (they get their own `handleReaction`). |
| `src/handler.js > handleReaction` (2026-06-08) | Handles WhatsApp emoji reactions (`type: 'reaction'`). Persists the reaction as an inbound row (`[reacted: <emoji>]` or `[reaction removed]`, intent `reaction`, with `reacted_to_wamid` = the targeted message's WhatsApp id), logs `reaction_received`, and replies with NOTHING. A reaction is a passive acknowledgement, not a question, so it must never trigger the "type your question" nag. `extractMessages` tags reactions `kind: 'reaction'`; the dispatch loop routes them here ahead of the `unsupported` branch (so owners reacting to alerts are silent too). Admin renders them as a badge on the target bubble via `renderMessages()`, not as standalone bubbles. |
| `src/handler.js` calls handler | When Meta delivers a `calls` webhook event, auto-sends "Hello, this number isn't monitored for voice calls. Please send a text message and the Electro-Sun team will respond." Throttled per-caller to once per hour. Logs `call_received`. Note: Meta's Calling API is in beta. |
| `src/handler.js > WELCOME_REPLY` constant | Hardcoded multi-line welcome card with Abuja office + warehouse Google Maps pin links, Lagos warehouse-and-offices pin link, Charbel + Patrick contact lines (addresses replaced by map pins 2026-06-17). Sent verbatim on the very first greeting from a new contact (greeting branch detects `priorHistory` has no prior assistant message). Bypasses Opus and all output guards because the card includes Patrick's number which would trip the owner-number-leak detector if generated by the LLM. If the first message is a pure greeting, the welcome card is sent and the turn returns. If the first message also contains a substantive question, the card is sent AND the Opus reply path runs with a `welcomeCardJustSent` expert-context prefix that suppresses re-greeting and address/phone repetition. Subsequent greetings in the same conversation fall through to normal Opus reply. |
| `src/handler.js > answerPendingForContact(contactId)` | Finds the latest unanswered customer inbound for the contact and re-queues it through the normal debounce + classify + reply pipeline. Called by the manual `/release` endpoint AND by the auto-release cron when human_handled flips back to false. |
| `src/handler.js > autoReleaseStaleHumanConversations(thresholdMinutes)` | Scans `human_handled=1` conversations, computes `max(human_handled_at, last_human_reply_at)`, releases any conversation idle past the threshold, fires `conversation_auto_released` event, and calls `answerPendingForContact` for the released contact. Cron: every 5 min outside the `DISABLE_NOTIFICATIONS` gate. Tunable via `HUMAN_AUTO_RELEASE_MINUTES` env var. |
| `src/handler.js > routeStaleDeferredHandoffs(thresholdMinutes)` | Ghost sweep (2026-06-08). Finds contacts with a `deferred_handoff` older than the threshold (default 5 min, `STALE_HANDOFF_MINUTES`) but within the last 24h, routes each to the Abuja desk (region-unknown default in `decideRecipient`), alerts that desk via `notifyOwnerForEscalation` (source `stale_deferred_sweep`), and clears the flag so each lead is swept once. Routes only, does not re-message the customer. Capped at 30/run; skipped when `DISABLE_ESCALATIONS=true`. On the always-on `*/5` cron next to auto-release. |
| `src/handler.js` datasheet fast-path | In `processCustomerBatch` after classification, before greeting/escalation: `DATASHEET_REQUEST_RE` detects "datasheet"/"brochure"/"spec sheet"/"specifications"/"manual"/"product sheet"/"product brochure"/"product manual"/"user guide" etc. Calls `findItemDatasheetByQuery(message, last 6 history turns)` against warehouse_items (size-token gated). On match: uploads to Meta if not cached, sends document, appends `[Datasheet sent: <label>]` outbound row with `intent='datasheet_sent'`, returns early. Falls through to normal reply on no match or send failure. Logs `handler.datasheet.sent` / `handler.datasheet.no_match` / `handler.datasheet.send_fail_fallback_to_text`. |
| `src/handler.js` photo fast-path | Runs immediately after the datasheet fast-path. Photo-request detection (2026-05-21 rewrite, replaced the loose `PHOTO_REQUEST_RE`): strips the synthetic `[Customer sent an image]` markers, then requires a real request context (request verb near a photo noun, "photo of/for/please", a bare "photo" message, or "what does it look like"); AND is skipped entirely when the customer attached an image this turn (`attachments.length > 0`). This killed two false positives: a customer SENDING an image ("Can it power it" + photo) and a customer MENTIONING one ("the picture in ur advert is 6kw"). Calls `warehouse.findItemPhotosByQuery(message, last 6 history turns + products_asked_about + brand_preference)` (size-token gated and HARD: if the customer named a size and no photo-bearing item carries it, no match so it never sends a wrong-size product photo; jpeg/png only). On match: loops over up to `PHOTO_SEND_CAP` photos (default 3) ordered by sort_order, uploads each to Meta if cache stale/missing (25-day TTL via `setPhotoMetaMediaCache`), sends each via `sendImage`, appends one `intent='photo_sent'` outbound row per send. Caption rule: per-photo caption if set, else only the FIRST image carries a "<brand> <model> photo, from Electro-Sun" caption (subsequent images come captionless to avoid repetition). Returns early on success. On no-match OR matched-item-has-no-photos: sends honest fallback text "I don't have a photo of that one on hand right now." (NO "team will share" promise, per owner directive 2026-05-21) and calls `notifyOwnerForEscalation` with synthetic `escalation_type='silent_query', intent='photo_request', source='photos_no_match'` (skipped when `DISABLE_ESCALATIONS=true`), then returns early so Opus never gets a chance to invent a product description. Logs `handler.photos.{lookup,uploaded_to_meta,upload_to_meta_failed,sent,send_fail,all_sends_failed_falling_back_to_text,no_match,notify_owner_fail,error}`. |
| `src/warehouse.js` photo helpers | `listPhotosForItem(itemId, {includeArchived})`, `getPhotoById(photoId)`, `addPhotoForItem(itemId, {filename, base64, mimeType, caption})` (writes file, INSERT row, returns photo), `updatePhotoForItem(photoId, {caption, sort_order})`, `removePhotoForItem(photoId, {hard})` (soft archive by default, hard with file unlink on opt-in), `setPhotoMetaMediaCache(photoId, mediaId)`, `findItemPhotosByQuery(message, recentText)` (mirrors `findItemDatasheetByQuery` size-token + token-overlap matcher, returns `{item, photos: photos.slice(0, PHOTO_SEND_CAP), score}` or `null`). `listItems()` extended to inline active photos per item so the admin UI gets them in one round-trip. |
| `src/whatsapp.js > sendImage(to, mediaId, caption)` | POST to `/messages` with `type: 'image'`, `image.id: mediaId`, optional `image.caption`. Mirrors `sendDocument` error handling. Logs `whatsapp.image.ok` / `whatsapp.image.fail`. |
| Admin `Warehouse Stock` per-item Photos panel | Below the Datasheet block in each item card. Grid of thumbnails (lazy-loaded via `GET /api/warehouse/photos/:photoId/file?key=...`). Per-thumb: caption input (saves on blur), up/down arrows to reorder (swap sort_order with neighbor), red × to soft-archive. "Upload" button with multi-file picker (image/jpg/png only; webp blocked because WhatsApp image messages reject it), 5MB pre-flight per file, sequential upload so one bad file doesn't abort the batch. Help text reminds the brother that only the first `PHOTO_SEND_CAP` photos (by position) go to customers. |
| `notifyOwnerEscalation` + follow-up ping in `notifyOwnerForEscalation` | Both branches persist the outbound message to the owner's conversation via `appendMessage` (intents `escalation_alert_hot`, `escalation_alert_silent`, `escalation_followup_ping`). Owner Chat tab can render every Sunny→Owner message. Wrapped in try/catch so DB write failure logs `escalation.persist_owner_alert_fail` without breaking delivery. **Alert body** is concise (built by `buildOwnerAlertText` in `src/owner_alert.js`, shipped 2026-06-06): a typed header (HOT / NEGOTIATION / REPEAT / BIG-PROJECT / FOLLOW-UP), the customer number only (no name, no transcript, no admin link), an optional `Product:` line from `lead_data.products_asked_about`, a 2-line situation summary (`classification.owner_brief`), and a `Follow up on WhatsApp:` wa.me link pre-filled with a client-facing opener (`classification.owner_followup_draft`) the owner can send as-is. **Brief fallback (2026-06-07):** when `owner_brief` is null (force-promoted HOT, or synthetic stall-guard/photo classifications), `ownerBriefLine` builds a real 2-phrase summary from the actual customer message (`Customer asked: "<msg, ≤180 chars>". Needs a team answer on <intent topic>.`); the generic "their enquiry" line only appears when no message is available either. Header label resolved via `ESCALATION_HEADERS` keyed on `escalation_type`; unknown types fall back to the silent_query header so new classifier escalation types degrade gracefully. (`formatConversationBriefForOwner` still exists but is no longer used in the alert body.) |
| `formatConversationBriefForOwner(contactId, maxTurns)` (in `src/handler.js`) | Builds a compact `[HH:MM] Customer: ...\n[HH:MM] Sunny: ...` brief from the last N messages of the contact's active conversation. Each line truncated at 220 chars, multi-line bodies flattened to single line. Used inside both escalation alert builders. |
| `buildAdminConversationLink(conversationId)` (in `src/handler.js`) | Returns `${PUBLIC_BASE_URL}/admin#conv=<id>`. Default base falls back to the Railway production URL when `PUBLIC_BASE_URL` is unset. The admin SPA parses `#conv=<id>` on boot and on every `hashchange`, then calls `selectConversation(id)` to deep-link the inbox to that conversation. |
| Admin `Owner Chat` tab + `GET /api/owner-chat?limit=N` | Read-only conversation thread of every message between Sunny and OWNER_WHATSAPP, including escalation alerts, follow-up pings, and the brother's replies. Renders with the same `msgHtml()` bubble component as the inbox. Auto-refreshes every 15s. |
| `src/audit.js` + `src/prompts/audit.md` | Nightly self-improvement audit. `runNightlyAudit()` selects the day's active conversations (excludes owner and sales desks), runs one Sonnet call each against a cached rules block (audit.md + system.md + warehouse + playbook), and writes findings (lanes: skill_lesson / knowledge_fact / engineering_note) to `audit_findings`. Pure helpers exported for tests. Off unless `ENABLE_NIGHTLY_AUDIT=true`. |
| `src/audit_store.js` | CRUD for `audit_runs` and `audit_findings` (create/finish/fail run, insert/list/get findings, set status, get active skill-lessons, mark applied). |
| `src/playbook.js` + `src/prompts/learned-playbook.md` | The owner-approved learned playbook injected into replies. `buildPlaybookMarkdown` (dedup, edited-text-wins, numbered). **`getPlaybookText()` reads the playbook STRAIGHT FROM THE DATABASE (2026-06-26, "Option A")**: it renders `auditStore.getActiveSkillLessons()` (status approved+applied) via `buildPlaybookMarkdown`, falling back to the on-disk `learned-playbook.md` only if the DB read throws. Because `audit_findings` lives on the Railway persistent volume (`/data/sunny.db`), an approved lesson is live on the very next reply AND survives every redeploy with NO `GITHUB_TOKEN` needed. This fixed the prior silent-loss bug where an approved lesson written only to the ephemeral file vanished on the next restart while the DB/admin still showed it "applied". `rebuildAndCommitPlaybook` (rebuild from approved skill-lessons, write file + best-effort GitHub commit, flip approved->applied) is now an optional backup/history path only; its failure no longer loses the lesson. Covered by `test/playbook_persistence.test.js` (real temp DB). |
| `src/facts.js` | The owner-confirmed learned-FACTS block injected into replies (2026-06-27, missing-facts one-click). `buildFactsMarkdown` (pure: numbered, dedup, edited-text-wins, "(No confirmed facts yet.)" sentinel when empty), `getFactsText()` reads `auditStore.getActiveKnowledgeFacts()` (knowledge_fact lane, status approved+applied, EXCLUDING `missing_price_fact`) straight from the DB (same Option-A persistence as the playbook; no file/GitHub), and `looksLikePrice(text)` (pure safety net: true on ₦/NGN/naira, thousands-separated numbers, "N million", or a bare 5+ digit integer not glued to a unit; deliberately does NOT flag "2-year warranty"/"7.68kWh"/"16kW"/"10 units"). Injected in `src/claude.js` right after the playbook block (guarded by the no-facts sentinel) and into `src/audit.js > buildRulesSystemBlocks` so the auditor does not re-propose confirmed facts. Prices NEVER enter this block (project hard rule: prices come only from Warehouse Stock). Covered by `test/facts.test.js` + `test/facts_persistence.test.js`. |
| `src/github_commit.js` | Reusable single-file GitHub Contents API commit (GET sha then PUT). Used by Apply-approved. |

## Mission

Sunny is an AI-powered WhatsApp Account Manager for **ElectroSun**, a solar energy supply agency in Nigeria. Sunny answers every inbound WhatsApp message in the customer's own language, explains ElectroSun's services, qualifies leads, categorizes contacts, sends owner reports, and stores everything behind a clean REST API ready for a future web dashboard.

## Who is who

- **Project owner**: Serge (builder, technical lead). Currently testing as a customer from `+966 50 239 2650`.
- **End client**: Serge's brother, who runs ElectroSun. Owner WhatsApp `2347041328055`.
- **Production host**: Railway (cloud). Mac Mini was the original plan but was retired due to office power/internet reliability.
- **First production phone number**: ElectroSun's verified WhatsApp Business number, currently `+234 913 055 4747` (phone_number_id `1143874562134501`).

## Tech stack (locked, do not deviate without asking)

- **Runtime**: Node.js 20+. Production runs on Railway (Linux container); local dev runs on macOS.
- **Framework**: Express.js.
- **Database**: SQLite via `better-sqlite3` (synchronous, single file at `db/sunny.db` locally, `/data/sunny.db` on Railway).
- **WhatsApp**: Meta WhatsApp Cloud API (official, NOT Twilio, NOT unofficial libs). Graph API version `v21.0`.
- **LLM**: Anthropic Claude API. All four call sites (`src/claude.js > classify`, `generateReply`; `src/knowledge.js > extractKnowledge`; `src/owner_qa.js > answerOwnerQuestion`) default to `claude-opus-4-7`. Override via `MODEL_*` env vars. Prompt caching enabled on system blocks via `cache_control: { type: 'ephemeral', ttl: '1h' }` (1-hour TTL since 2026-05-30; see Models, costs, and budget).
- **Voice transcription**: OpenAI Whisper (`whisper-1` default, `WHISPER_MODEL` override).
- **Scheduler**: `node-cron`.
- **Email fallback**: `nodemailer` (used only if owner's WhatsApp report fails).
- **Process manager (local dev only)**: PM2 (`ecosystem.config.js`).
- **Tunnel for local webhook (dev only)**: Cloudflare Tunnel quick-tunnel or named tunnel.
- **Multipart upload for Whisper**: `form-data`.
- **Excel export**: `exceljs` (Contacts tab "Export to Excel" button, .xlsx generation). Approved 2026-05-21.

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
│   ├── whatsapp.js              # sendMessage, sendTemplate, downloadMedia, uploadMediaToMeta, sendDocument.
│   ├── claude.js                # classify, generateReply, buildConversationState, scrubHistoryContent, code-level reply guards.
│   ├── classifier.js            # Wraps classify, updates contact, logs category_changed.
│   ├── memory.js                # Contacts + conversations + messages + events. ISO timestamps everywhere.
│   ├── handler.js               # handleInbound pipeline, debounce queue, owner routing, calls handler, unsupported handler.
│   ├── reports.js               # 2-hour + daily + daily-learning aggregation, WhatsApp + email send.
│   ├── window_monitor.js        # 23h/24h pending_queries scan.
│   ├── cost_tracker.js          # daily_costs ledger, recordUsage, isOverBudget.
│   ├── knowledge.js             # knowledge_entries CRUD, Haiku/Opus extractKnowledge, formatKnowledgeForPrompt (legacy injection).
│   ├── catalog.js               # catalog_items + catalog_notes CRUD, formatCatalogForPrompt (legacy injection).
│   ├── warehouse.js             # warehouse_items + warehouse_stock CRUD, formatWarehouseForPrompt (authoritative), datasheet attachments.
│   ├── owner_qa.js              # answerOwnerQuestion (live snapshot Q&A for the brother).
│   ├── transcribe.js            # OpenAI Whisper wrapper.
│   ├── hv_validator.js          # Deterministic HV BOM validator + per-contact prior-drops feedback loop.
│   ├── security.js              # Rate limits, throttles, injection-attempt + leak detection, stall-language guard.
│   ├── prompt_store.js          # Read/write/cache wrapper for the four prompt files.
│   ├── datasheets.js            # Legacy datasheets table + Meta upload helpers (preserved for migration).
│   ├── prompts/
│   │   ├── system.md            # Sunny's personality, voice rules, hard rules, locations block, conversation-state usage, engineering rules.
│   │   ├── classifier.md        # HOT/SERIOUS/COLD/DISQUALIFIED/REPEAT_CLIENT classification, lead_temperature, client_type, escalation rules.
│   │   ├── teacher.md           # Owner-DM-to-fact extraction prompt (legacy; not loaded into admin editor).
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
│   ├── session-history.md       # Chronological changelog (newest first).
│   ├── archive/                 # Snapshots of retired prompt versions for reference.
│   └── audits/                  # Periodic full audits of the agent state.
└── logs/                        # sunny.log, daily DB snapshots, PM2 logs.
```

The project folder path contains a space: `/Users/sergeadaimy/Desktop/Claude Projects/Sunny-Whatsapp Account Manager`. Always quote it in shell commands.

## How a message flows (the pipeline)

1. Customer sends WhatsApp text/image/voice/audio to ElectroSun's number.
2. Meta POSTs to `/webhook` with `X-Hub-Signature-256` header.
3. `src/webhook.js` reads the raw body (captured by an `express.json` `verify` callback so HMAC computation matches what Meta signed) and calls `verifyMetaSignature`. Mismatched signatures get a 403. Webhook returns 200 immediately, then processes asynchronously.
4. **Calls webhook event** (separate path): handler.js fires the auto-reply "this number isn't monitored for voice calls", throttled to once/hour per caller.
5. `handler.js > extractMessages` extracts text, image, audio, and emoji reactions (a `reaction` is tagged `kind: 'reaction'` and routed to `handleReaction`, which persists it silently and never replies). `handleInbound(payload)`:
   1. **Idempotency**: looks up `whatsapp_message_id` in `messages`. If already stored, skips.
   2. **Voice notes**: download from Meta, save to `MEDIA_DIR`, transcribe via Whisper, rewrite `msg.body` to transcript with `[voice note transcribed]:` prefix.
   3. **Images**: download from Meta, save to `MEDIA_DIR`, base64-encode, persist with `media_path` and `media_mime`. Classifier sees text marker `[Customer sent an image with caption]:`; Opus reply call sees the actual image as a vision input.
   4. `getOrCreateContact(phone, profileName)`.
   5. `getActiveConversation(contactId)` opens a new conversation if the last message was more than 24 hours ago. If `conversation.human_handled` is true, Sunny skips processing.
   6. **Owner routing**: messages from `OWNER_WHATSAPP` that match a pending `[QID:N]` go to `handleOwnerReply` (relays to customer). Other owner messages go to `handleOwnerNonQueryMessage` → `answerOwnerQuestion` (live snapshot Q&A).
   7. **Debounce queue**: per-contact in-memory queue. Persists each message to DB immediately for admin visibility. Classification + reply only fire ONCE per `MESSAGE_DEBOUNCE_MS` window with combined input `[Customer sent N messages back to back]\n...`.
   8. Reads prior history (last 50 messages), then `classifier.runClassification()` calls Opus, parses JSON, retries once on parse failure, falls back to `category=unsorted, lead_temperature=COLD, needs_escalation=false, escalation_type=null` if Claude fails entirely. Updates contact category, language, lead_data fields (only fills nulls, never overwrites).
   9. **Greeting fast-path**: if message matches greeting regex, return synthetic `{C1, COLD, no escalation, intent=greeting}` without calling Opus. Saves cost. Reply path then sends Opus EMPTY history (clean slate, no anchoring on prior products).
   10. **Welcome card**: first-ever turn for a brand-new contact sends `WELCOME_REPLY` verbatim. Pure greetings stop there; substantive first turns fall through to the Opus reply with a `welcomeCardJustSent` expert-context prefix.
   11. **Datasheet fast-path**: if `DATASHEET_REQUEST_RE` matches and `findItemDatasheetByQuery` (size-token gated) returns a hit, the warehouse item's datasheet is uploaded (if not cached) and sent as a WhatsApp document; returns early.
   11b. **Photo fast-path** (runs right after datasheet): if `PHOTO_REQUEST_RE` matches, looks up matching item via `findItemPhotosByQuery` (size-token gated; only items with active photos qualify). On hit, sends up to `PHOTO_SEND_CAP` photos (default 3, ordered by sort_order) inline via `sendImage`, uploading each to Meta if cache is stale (25-day TTL). On no-match OR matched-item-has-no-photos: sends short text fallback AND escalates as `silent_query` via `notifyOwnerForEscalation`. Returns early in both photo paths.
   12. **Branch A (escalation)**: `notifyOwnerForEscalation` runs (HOT throttle, follow-up ping for open pending, or fresh alert + pending_queries row). The customer-side reply is ALWAYS produced by `generateReply` with an `expertContext` block (HOT lead, awaiting-expert, or welcome-already-sent variant). HOT-only: append `Direct line to the Sales Manager: <wa.me link>` after the reply.
   13. **Branch B (auto-reply)**: `generateReply(history, message, contact, attachments)`. System prompt = `system.md` + locations block + conversation-state block + warehouse stock block + active knowledge facts (capped, legacy) + "Known about this customer" context. Output passes through guards 1-14 (see "Code-level reply guards"). Stall-language guard re-runs the LLM under awaiting-expert constraints if a first-person or third-person stall slipped through.
   14. Sends via `sendMessage`, persists outbound with returned WhatsApp message ID. `cost_tracker.recordUsage` after every Anthropic response.
6. **Cron jobs:**
   - Report crons (only register at boot if `DISABLE_NOTIFICATIONS=false`): `0 */2 * * *` (UTC) 2-hour report; `0 21 * * *` (Africa/Lagos) 24h report + DB snapshot; `30 21 * * *` (Africa/Lagos) daily learning report.
   - `*/30 * * * *` window scan (ALWAYS registers since 2026-06-08): `runWindowScan({ silent: notificationsDisabled() })`. When notifications are enabled it also sends the 22h reminder + 24h-expire alert + over-budget alert; when disabled it runs silent (expiry only).
   - `*/5 * * * *` (always, outside the `DISABLE_NOTIFICATIONS` gate) `autoReleaseStaleHumanConversations(HUMAN_AUTO_RELEASE_MINUTES)`.
7. **Startup**: `recoverOrphanedInbound(10)` runs 3s after `app.listen` to re-queue any orphaned inbound from the last 10 minutes.

## Database schema and conventions

Schema lives in `db/schema.sql`. Tables:
- **`contacts`**: phone, profile_name, category, language, lead_data fields (`name`, `location`, `use_case`, `load_estimate`, `timeline`), `lead_temperature`, `client_type`, `products_asked_about`, `brand_preference`, `budget_mentioned`, `lead_source` (e.g. `electroleads`, set by `detectLeadSource()` matching the `ELECTROLEADS_OPENER`), `expiring_warning_sent_at`, `last_active`.
- **`conversations`**: `contact_id`, `started_at`, `last_message_at`, `human_handled`, `human_handled_at`, `last_human_reply_at`.
- **`messages`**: `whatsapp_message_id` (partial unique index for idempotency), `conversation_id`, `direction`, `body`, `kind`, `media_path`, `media_mime`, `reacted_to_wamid` (for emoji-reaction rows: the `whatsapp_message_id` of the message the reaction was applied to; used to render the reaction as a badge on its target bubble), `intent`, `created_at`.
- **`events`**: log of category_changed, escalated, silent_query_resolved, call_received, conversation_auto_released, etc.
- **`reports`**: persisted hourly/daily/learning reports.
- **`pending_queries`**: silent-query workflow. `customer_contact_id`, `customer_message`, `alert_message_id`, `status` (open/resolved/expired), `created_at`, `resolved_at`, `expiring_warning_sent_at`.
- **`daily_costs`**: per-day spend in cents (integers, no float drift).
- **`knowledge_entries`**: owner-taught facts. `id`, `source_message`, `extracted_fact`, `category` (pricing/policy/product/sales/operations/warranty/customer/correction/other), `confidence`, `status` (active/rejected/draft), `created_at`, `approved_at`, `rejected_at`. Legacy: no longer injected into the prompt as of 2026-05-10.
- **`catalog_items`**: `brand`, `model`, `price_naira`, `stock`, `notes`. Seeded from `src/knowledge/products.json` on first boot only. Legacy: no longer injected into the prompt as of 2026-05-10.
- **`catalog_notes`**: free-form catalog notes (PDU stacking limits, etc.). Legacy.
- **`warehouse_items`**: `section`, `brand`, `model`, `price_ngn`, `notes`, `sort_order`, `datasheet_path`, `datasheet_meta_media_id`, `datasheet_meta_uploaded_at`. Source of truth for what Electro-Sun sells.
- **`warehouse_stock`**: per-item × per-location stock row. Columns: `item_id`, `location` ('abuja' | 'lagos'), `state` ('in_stock' | 'out_of_stock' | 'incoming'), `quantity` (integer, default 0), `coming_note` (free text), `eta_date` (YYYY-MM-DD). UNIQUE(item_id, location). Two rows are auto-created per item (Abuja + Lagos) on insert.
- **`warehouse_item_photos`**: per-item photo attachments (many per item). Columns: `id`, `item_id` (FK warehouse_items, ON DELETE CASCADE), `filename`, `file_path`, `mime_type`, `size_bytes`, `caption` (optional, max 280 chars), `sort_order`, `meta_media_id`, `meta_media_uploaded_at`, `status` ('active' | 'archived'), `created_at`, `updated_at`. Files stored under `WAREHOUSE_PHOTOS_DIR` (defaults to `<DB dir>/warehouse_photos/`, `/data/warehouse_photos/` on Railway). Allowed mimes: image/jpeg, image/png (webp removed 2026-05-21: WhatsApp Cloud API image messages reject webp, which is sticker-only; the matcher also filters out non-jpeg/png photos as a backstop). Max 5MB per photo (override via `PHOTO_MAX_BYTES`). When a customer asks for photos, the handler's photo fast-path sends up to `PHOTO_SEND_CAP` photos (default 3) inline as WhatsApp images, ordered by sort_order.
- **`datasheets`** (legacy): retained for migration; replaced by per-item attachments on warehouse_items.
- **`audit_runs`**: one row per nightly audit pass. `run_date`, `window_start`, `window_end`, `status`, `conversations_audited`, `findings_count`, `scorecard`, `error`, timestamps.
- **`audit_findings`**: one row per audit proposal. `run_id`, `conversation_id`, `contact_id`, `lane` (skill_lesson/knowledge_fact/engineering_note), `finding_type`, `finding_text`, `proposed_change`, `cited_rule`, `cited_message`, `status` (pending/approved/rejected/applied), `edited_text`, timestamps.

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
| `META_PHONE_NUMBER_ID` | Meta-issued ID for the sending number. Currently `1143874562134501` (Nigerian number). |
| `META_APP_SECRET` | Used to verify `X-Hub-Signature-256`. Must be set in production. |
| `META_WABA_ID` | WhatsApp Business Account ID. Currently `986225450549617`. |
| `META_REGISTRATION_PIN` | Cloud API registration PIN, currently `271828`. |
| `ANTHROPIC_API_KEY` | Claude API key. |
| `OPENAI_API_KEY` | Whisper transcription. Set + validated on Railway 2026-05-29. |
| `OWNER_WHATSAPP` | E.164 digits, currently `2347041328055`. Receives escalation alerts and reports. |
| `DEVELOPER_WHATSAPP` | Developer/internal line (2026-06-16), currently `966502392650` (Serge). Recognized as a full owner (`fullOwnerDigits()`), so messages from it route to Owner Q&A and it is excluded from lead stats (`teamPhoneDigits()`). NOT an escalation or round-robin recipient (those use `configuredRecipients()`/`numberForLabel()`, which this does not feed). Side effect: the customer reply pipeline can no longer be tested from this number; use another SIM to test as a customer. |
| `OWNER_EMAIL`, `SMTP_*` | Email fallback when WhatsApp report fails. Optional. |
| `PORT` | Express port. Defaults to 3000. |
| `API_KEY` | Required by `/api/*`. If unset, every API call returns 503. `/version` and `/health` bypass this. Master key = full admin role. |
| `INBOX_USER`, `INBOX_PASSWORD`, `INBOX_API_KEY` | Inbox-only team login (2026-06-01). When all three are set, a team member signs in at `/admin` or `/inbox` with username + password; `POST /inbox-login` validates them and returns `INBOX_API_KEY`. That key is tagged `role=inbox` by the `api/dashboard.js` auth middleware and is allowed ONLY on the inbox whitelist (`/whoami`, `/inbox`, `/stats/today`, `/queries/pending`, `/conversations/:id`, `…/handle`, `…/release`, `…/send-reply`); every other endpoint returns 403. The admin page calls `GET /api/whoami` after login and hides all non-Inbox tabs + the budget badge for the inbox role. `INBOX_API_KEY` MUST be a different secret from the master `API_KEY`. Restriction is server-enforced, not just UI hiding. Login is throttled (8 attempts / 10 min / IP). Leave all three blank to disable. |
| `DB_PATH` | SQLite file location. `/data/sunny.db` on Railway. |
| `MEDIA_DIR` | Downloaded media location. Defaults to `<DB_PATH dirname>/media`. |
| `LOG_TO_FILE` | Default true. Set false on cloud PaaS to disable rotating-file logger and DB snapshot. |
| `DISABLE_NOTIFICATIONS` | When true, no cron schedules register at boot (auto-release cron excluded). |
| `DISABLE_ESCALATIONS` | When true, escalations get demoted to normal replies. |
| `MESSAGE_DEBOUNCE_MS` | Debounce window per contact. Default 6000. |
| `MODEL_CLASSIFIER`, `MODEL_REPLY`, `MODEL_TEACHER`, `MODEL_OWNER_QA` | Override Opus default selectively. |
| `WHISPER_MODEL` | OpenAI model. Default `whisper-1`. |
| `DAILY_LLM_BUDGET_USD` | Soft daily cap. Currently 20. |
| `KNOWLEDGE_PROMPT_MAX_FACTS`, `KNOWLEDGE_PROMPT_BUDGET_CHARS` | Active-fact injection cap. Defaults 500 / 30000. |
| `SPECIALIST_DIRECT_LINK` | Digits-only number for the wa.me link on HOT replies. |
| `PUBLIC_BASE_URL` | Base URL for the admin deep-link embedded in owner escalation alerts. Falls back to the Railway production URL. |
| `HUMAN_AUTO_RELEASE_MINUTES` | Auto-release threshold for human_handled conversations. Default 15. |
| Other env vars (kill switches, throttles, paths) | See [Kill switches and runtime overrides](#kill-switches-and-runtime-overrides-railway-env-vars) above for the full extended table. |

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

Defined in `server.js`. **All schedules except auto-release are skipped at boot when `DISABLE_NOTIFICATIONS=true`** (logs `cron.all_schedules_skipped_at_boot`).

- `0 */2 * * *` (UTC) every 2 hours: `generateHourlyReport()` then `sendOwnerReport(report)`.
- `0 21 * * *` (Africa/Lagos): `generateDailyReport()` then `sendOwnerReport(report)`, then `snapshotDb()`.
- `30 21 * * *` (Africa/Lagos): `generateDailyLearningReport()` then send.
- `*/30 * * * *`: `runWindowScan({ silent })` for 24h expirations always (hygiene), plus 22h reminders + over-budget alerts when notifications are enabled. Registers regardless of `DISABLE_NOTIFICATIONS` (silent expiry-only when disabled).
- `*/5 * * * *` (always): `autoReleaseStaleHumanConversations(HUMAN_AUTO_RELEASE_MINUTES)` to flip stale human_handled conversations back to Sunny and re-queue the latest unanswered customer inbound.

## Dashboard API

Mounted at `/api`. Every endpoint requires header `X-API-Key: <process.env.API_KEY>`. Returns 401 on mismatch, 503 if `API_KEY` is not set on the server. `/version` and `/health` are on the main app router (no auth).

Public:
- `GET /health` returns `{status, uptime_seconds, timestamp}`.
- `GET /version` returns `git_sha_short`, `git_branch`, `git_commit_message`, `deploy_id`, `escalations_disabled`, `notifications_disabled`, `owner_whatsapp_tail`, `node_uptime_seconds`. One-tap diagnostic.

Authed:
- `GET /api/contacts?category=&from=&to=&limit=&offset=`, `GET /api/contacts/:id`.
- `GET /api/contacts/export` streams all contacts as a single-sheet `.xlsx` (exceljs). Defined before `/contacts/:id` so the literal path is not captured by the `:id` param route. Exports every row, ignores UI filters, phone column forced to text.
- `GET /api/stats/today`, `GET /api/stats/range?from=&to=`.
- `GET /api/reports/latest?type=hourly|daily`, `GET /api/reports?from=&to=&type=`.
- `GET /api/inbox`, `GET /api/conversations/:id`, `POST /api/conversations/:id/{handle, release, send-reply}`.
- `GET /api/queries/pending`, `GET /api/budget/today`.
- `GET /api/knowledge`, `POST /api/knowledge`, `POST /api/knowledge/:id/status`, `POST /api/knowledge/:id/edit`, `DELETE /api/knowledge/:id`.
- `GET /api/catalog`, `POST /api/catalog/items`, `POST /api/catalog/items/:id`, `DELETE /api/catalog/items/:id`, plus `/api/catalog/notes` CRUD.
- `GET /api/warehouse`, `POST /api/warehouse/items`, `POST /api/warehouse/items/:id`, `DELETE /api/warehouse/items/:id`, `POST /api/warehouse/items/:id/stock`, `POST /api/warehouse/items/:id/datasheet` (file upload), `DELETE /api/warehouse/items/:id/datasheet`.
- `GET /api/warehouse/items/:id/photos` (list, `?include_archived=1` to include archived), `POST /api/warehouse/items/:id/photos` (upload one base64 photo + optional caption), `POST /api/warehouse/items/:id/photos/:photoId` (update caption / sort_order), `DELETE /api/warehouse/items/:id/photos/:photoId` (soft archive, `?hard=1` to delete file). `GET /api/warehouse/photos/:photoId/file` serves the binary for admin thumbnails (auth via `X-API-Key` or `?key=` query).
- `GET /api/owner-chat?limit=N` returns the read-only thread of Sunny↔owner messages.
- `GET /api/prompts/:name`, `POST /api/prompts/:name` (save + optional git push + optional Railway redeploy).
- `GET /api/brain` returns model env values, runtime config (DB path, media dir, daily budget, WABA ID, graph version, owner_whatsapp_tail), a `spending` block (today_usd, month + month_usd, month reply/classifier call counts, month_active_days, daily_budget_usd), and which env vars are set as booleans only. No secrets returned. The admin Models & config panel renders the spending block at the top.
- `POST /api/recover-orphans?minutes=N` manual orphan recovery.

## Admin web UI

Mounted at `/admin`. Single-page HTML+JS+CSS, WhatsApp-style light theme (white surfaces, charcoal text, brand green as accent). Login with `API_KEY` (stored in localStorage).

- **Inbox**: WhatsApp-style two-pane (conversation list + thread). Gradient-green avatar circles with per-contact initials. White incoming bubbles, pastel green (`#DCF8C6`) outgoing, pastel violet for human-typed outgoing. Inline-bottom-right timestamps. Take-over and Return-to-agent buttons; manual reply auto-marks `human_handled` so Sunny stops auto-replying. Reply input preserves typed text + cursor + focus + scroll across the 15s polling re-renders. Emoji reactions render as a WhatsApp-style badge on the bottom corner of the message they were applied to (via `renderMessages()`), not as standalone bubbles; an out-of-window target falls back to a subtle centered note.
- **Contacts**: filterable contacts list with last-active and category. Page cap raised to 10000; true DB contact count surfaced (2026-05-15). "Export to Excel" button (top-right of toolbar) downloads every contact as a single-sheet `.xlsx` via `GET /api/contacts/export` (raw fetch with API key, blob download). Exports all rows regardless of on-screen filters.
- **Warehouse Stock**: top-level tab. Source of truth for stock + price + datasheets + photos. One row per item (brand/model/section/price/notes) with two side-by-side panels (Abuja, Lagos). Each panel: state radios (In stock / Incoming / Out of stock), quantity with +/- buttons, coming note (free text), ETA date. Plus a per-item datasheet attachment (PDF/PNG/JPG/WEBP up to 15MB) that Sunny auto-sends when the customer asks for a datasheet/brochure/spec. Plus a per-item Photos panel: thumbnail grid (multi-upload, JPG/PNG up to 5MB each; webp not allowed since WhatsApp can't send it as an image), per-thumb caption, reorder arrows, soft archive. Sunny auto-sends up to `PHOTO_SEND_CAP` (default 3) photos inline when the customer asks for photos/pictures/images of an item. Edits save instantly via REST and feed `formatWarehouseForPrompt()` on the very next reply.
- **Owner Chat**: read-only thread of every message between Sunny and a routed recipient. A pill tab-bar (2026-06-07) lets the admin switch between Patrick / Charbel / Abuja Sales / Lagos Sales (`configuredRecipients()` in `src/owner_routing.js`; only desks whose env number is set and distinct from Patrick's, deduped). `/owner-chat?label=<patrick|charbel|abuja|lagos>` returns `{ contact, messages, recipients, active_label }`; the tab bar hides when only one recipient is configured. Shows escalation alerts, follow-up pings, and that recipient's replies. Reuses `msgHtml()` so bubbles look identical to inbox. Auto-refreshes every 15s, preserving the selected tab.
- **Knowledge**: two sub-panels.
  - Rules: editable per-prompt textareas for `system.md`, `classifier.md`, `owner_qa.md` (teacher.md retired from the editor 2026-05-10; doctrine edits go directly into `system.md`). Each has a Save button (writes file via `src/prompt_store.js` and commits + pushes to GitHub via the Contents API if `GITHUB_TOKEN` is set). A global "Deploy to live" button calls Railway's GraphQL `serviceInstanceRedeploy` if `RAILWAY_TOKEN` is set. Sunny re-reads prompts on every classify/reply call (cached 30s, busted on Save), so saved prompts take effect on the next customer message without a restart.
  - Models & config: model IDs, runtime config, env-var booleans.
- **Nightly Audit**: admin-only tab (hidden from the inbox role). Findings are MERGED into one card per topic (2026-06-16): `groupFindings()` in `src/audit.js` collapses duplicates by lane + normalized topic, shown with an xN badge and all source chat links, so a 100+ finding run becomes a short review list. `GET /api/audit/runs/:id` returns both raw `findings` and merged `groups`. **Approve applies AND deploys in one click** (`POST /api/audit/approve {ids[],edited_text}`): the whole merged group is marked approved and, for skill_lesson groups the approved status alone makes the lesson live (it is read from the DB on the next reply, see `src/playbook.js`); `rebuildAndCommitPlaybook()` also rewrites `src/prompts/learned-playbook.md` and best-effort commits to GitHub as a backup. The card animates into a "Sorted" section with a **"Learned & saved"** chip for skill lessons (permanent via the DB regardless of the GitHub backup, 2026-06-26), or, for **`knowledge_fact` (missing facts), one-click apply (2026-06-27)**: a general fact (warranty, delivery, policy) is approved into the DB-backed learned-FACTS block (`src/facts.js`, read on the next reply, chip "Sunny learned this"), while a **missing-price** finding (auditor `rule_key=missing_price_fact`) is routed to Warehouse Stock and never injected (chip "Add in Warehouse Stock" + an "Open Warehouse Stock" button that calls `switchView('view-warehouse')`; the owner types the price in the one authoritative place and Sunny reads it via `formatWarehouseForPrompt`). Safety net: if the owner's confirmed text for a general fact `looksLikePrice(...)`, the approve endpoint reclassifies it to `missing_price_fact` so a price can never leak into the facts block. `engineering_note` stays "Approved (recorded)" (developer note, no automated target). The approve response includes `has_lesson`/`has_fact`/`has_price` and `persisted:true` for lessons + general facts. **Reject** (`POST /api/audit/reject {ids[]}`) removes the card from the page and the rows never reappear. Rebuilds are serialized (`src/playbook.js`) so concurrent approvals cannot race the GitHub commit. Reached from the owner ping via the `#audit=<run_id>` deep link. (Legacy per-id `POST /api/audit/findings/:id/status` and `POST /api/audit/apply` retained.)

## Prompts: where to tune Sunny's voice

Four files, edited like English prose, no code changes needed (process restart picks up changes; admin Save busts the 30s cache):

- `src/prompts/system.md`: Sunny's personality, voice rules, hard rules, locations block, engineering rules, conversation-state usage, worked-example dialogues.
- `src/prompts/classifier.md`: strict JSON schema, HOT/SERIOUS/COLD/DISQUALIFIED/REPEAT_CLIENT categories, lead_temperature definitions, escalation triggers.
- `src/prompts/teacher.md`: owner-DM-to-fact extraction rules (legacy, not loaded into admin editor).
- `src/prompts/owner_qa.md`: owner Q&A live-snapshot rules.

## Languages

Sunny detects from the customer's first message and replies in the same language by default:

- English (default fallback and the brother's "Always English" preference for canned holding replies).
- Nigerian Pidgin.
- Hausa.
- Yoruba.
- Igbo.

Multi-language detection still runs in classifier for data capture. `HOT_LEAD_REPLY` and `SILENT_QUERY_REPLY` constants in `src/handler.js` are English-only per brother's directive.

**Serviced-languages-only reply rule (2026-05-29).** `src/prompts/system.md` §4 constrains replies to the five serviced languages above. For ANY other language (Arabic, French, etc.) Sunny replies in English. Reason: a transcribed voice note came back in Arabic (Whisper mis-detected an accented English clip) and Sunny mirrored it; ElectroSun does not service Arabic.

**Whisper language pin (2026-05-29).** `src/transcribe.js` pins the transcription `language` to `en` by default (configurable via `WHISPER_LANGUAGE`; set it to empty string to restore auto-detect). Without the pin, Whisper auto-detected accented English voice notes as Arabic and produced Arabic (often garbled) transcripts. English is the right default given the customer base; Pidgin transcribes acceptably as English.

## Categories and escalation

Source of truth is `src/prompts/classifier.md`. Classifier output:
- `category`: HOT / SERIOUS / COLD / DISQUALIFIED / REPEAT_CLIENT (current schema, 2026-05-12). Legacy C1-C5 rows still readable; admin filters for both schemas.
- `lead_temperature`: HOT / WARM / COLD / DISQUALIFIED / CLOSED / LOST. HOT requires explicit commitment phrases (pay/account/proforma/deposit/install-date/proceed/order). SERIOUS in the new schema maps to WARM in `lead_temperature` for backwards compatibility.
- `client_type`: end_user / installer / integrator / reseller / unknown.
- `escalation_type`: hot_lead / silent_query / negotiation / repeat_complex / big_project / bulk_order / pricing_question / none. `bulk_order` (2026-06-07) is set in code (`handler.js > detectBulkQuantity`, threshold qty ≥ 2) when a non-HOT customer names a product + multi-unit quantity; it bypasses gather-first, quotes the per-unit price + offers the Sales Manager for the bulk price (`buildBulkOrderContext`), alerts the routed owner, and appends the routed Sales Manager direct line. (Routing for negotiation/repeat_complex/big_project still falls through silent_query flow; only the alert header label is differentiated.)

**Classification safety nets** (in `src/classifier.js`, all logged when triggered):
1. `classifier.hot_without_escalation_demoted_to_warm`: if Opus returns `lead_temperature=HOT` without `needs_escalation=true`, demote to WARM.
2. `classifier.hot_without_commitment_phrase_demoted`: if Opus returns HOT but the customer body contains NO explicit commitment keyword (pay, account number, proforma, invoice, quotation, deposit, let's proceed, i'm ready, confirm order, send your team, when can you install, ready to buy, site visit, etc.), demote HOT to WARM AND clear escalation. Whitelist regex is `HOT_TRIGGER_RE`. Reason: Opus once misclassified "I need solar panels" as HOT and the customer got the canned wa.me handoff prematurely.
3. `classifier.commitment_phrase_force_promoted_to_hot`: if the customer's CURRENT message body contains a `HOT_TRIGGER_RE` commitment phrase ("send me account", "i want to pay", "pay now", "send proforma", etc.), promote to HOT regardless of what the classifier returned. Backstop against the prior-Sunny-question regex `HOT_PROMPT_FROM_SUNNY_RE` missing a relevant Sunny-side prompt.
4. `classifier.greeting_escalation_blocked`: if a casual greeting was misclassified as needing escalation, block it.
5. `classifier.clarification_escalation_blocked`: if the customer message is a short confusion/clarification reaction ("for what?", "what is this message?", "what do you mean?", "I don't understand", "huh?", etc., regex `CLARIFICATION_RE`), force `needs_escalation=false` and `escalation_type=null`. Reason: customer was getting the specialist canned reply for "for what?" and "what is this message?" — these are conversational repair, not handoff signals.

**Classifier fallback** (in `src/claude.js > FALLBACK_CLASSIFICATION`): when Opus parse fails / network error / retries exhaust, the synthetic classification is `category=unsorted, lead_temperature=COLD, needs_escalation=false, escalation_type=null`. Customer gets a normal Opus reply via `generateReply`, NOT the specialist canned reply. Reason: previously the fallback escalated by default, so any classifier hiccup spammed the specialist message.

**Default unsorted**: when uncertain or when the Opus classify call fails entirely, the synthetic classification is `category=unsorted, lead_temperature=COLD, client_type=unknown, needs_escalation=false, escalation_type=null`. The reply path then runs normally so Sunny attempts an answer instead of punting to specialist.

**Greeting fast-path**: greeting regex skips Opus and returns synthetic `{C1, COLD, no escalation}` to save cost.

**Sizing questions are NOT escalated.** General questions about how solar works, brand context, sizing, market price ranges, segment confirmations are answered, not silent_query'd. Only Electro-Sun specific facts (exact price for non-catalog brands, current stock, specific install date, complaints, warranty claims, custom designs) trigger escalation.

**Location/branch/address/pickup/warehouse questions are NEVER silent_query.** Sunny answers from the locations block.

## Hard rules (do not violate)

1. **No double dashes anywhere.** Permanent user preference (2026-04-26). No em-dash, en-dash, or `--`. Use commas, periods, colons, parentheses, semicolons. CSS custom properties (`--cream`) are the only allowed exception.
2. **Never invent specs, prices, model numbers, or timelines** in customer replies. Sunny escalates whenever uncertain. Confirmed prices in Naira only, sourced from Warehouse Stock only.
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
- Conversation-state engine, code-level reply guards (14 layers including HV BOM validator + cleanup pass + dash strip), greeting fast-path, empty-history-on-greeting, wa.me-link ban, history scrub.
- Owner Q&A mode (brother's number).
- Knowledge ingestion with Haiku/Opus extraction, dedup, 500-fact cap (legacy; not currently injected).
- Catalog moved to DB (legacy). Warehouse Stock is the new source of truth, fully editable from admin (no developer push needed for stock/price/datasheet changes).
- Admin web UI (Inbox, Contacts, Warehouse Stock with per-item datasheets + photos, Owner Chat, Knowledge with Rules + Models sub-panels).
- Cost tracker + budget guardrail.
- Window monitor (23h/24h pending_queries) + auto-release cron for human_handled conversations.
- 2-hour, daily, daily-learning reports (currently silenced via `DISABLE_NOTIFICATIONS=true`).
- HV catalog seeded (12 items: Deye 30/50/80kW HV 3-phase + BOS-G/A/B Pro batteries + accessories). Warehouse-stock rows mirrored.
- Locations + doctrine facts seeded.
- Legacy data import done; "Past quote" entries retired.
- Templates submitted to Meta (PENDING approval): `owner_hourly_report_en` id `26625377877146589`, `follow_up_24h_en` id `1722973542453762`.
- Permanent System User token issued ("Sunny-Server", id `615889422441392`, no expiry).
- Meta business verification confirmed.
- Production WABA + Nigerian number migration complete (2026-05-08).

**Pending**:
- ~~`OPENAI_API_KEY` on Railway~~ DONE 2026-05-29: new key set + validated, awaiting live voice-note confirmation.
- Brother's pricing data (Sungrow, JA panels, Longi, Jinko).
- Brother's Section 11 decisions (working hours, location tags, currency, default warranty/delivery copy, after-hours reply, competitor pricing doctrine).
- Task #15 48-hour soak with 3-5 testers.
- Re-check Meta template approval status (`node scripts/check_templates.js`).
- Meta template re-submit if any are rejected.
- Display name "ELECTROSUN" Meta review (1-3 business days from 2026-05-08).
- Brother to accept Sunny chat from WhatsApp Message Requests folder.

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

- **Opus on reply only, Sonnet elsewhere** (since 2026-05-09): reply ~$0.025-$0.05 per message; classifier / teacher / owner_qa ~$0.005 per message on Sonnet. At 500 messages/day that's roughly $15-$25/day or $450-$750/month for the reply path alone. Use `MODEL_*` env overrides to step further back to Sonnet/Haiku selectively if budget tightens.
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
