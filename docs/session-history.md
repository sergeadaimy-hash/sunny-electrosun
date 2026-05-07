# Sunny session-by-session history

Chronological changelog of Sunny development sessions, extracted from CLAUDE.md on 2026-05-05 to keep the always-loaded working memory tight. Each session below is dated and appears in reverse chronological order (most recent first). Cross-reference commit hashes against `git log` for the actual code.

## 2026-05-07 morning Beirut — retire canned customer holding replies, route through LLM with expert-context block

**The bug Serge surfaced (screenshot at 9:44 GMT+3).** Sunny TEST conversation. Yesterday Sunny had sent "Let me confirm the exact figure for 100 x Jinko 580W and revert shortly." (a stall the previous session was supposed to have caught). This morning the customer came back: "Hi" then "You didnt answer me" then "When?" then "It's been 1 day". Each of those messages got the SAME reply word-for-word: "A specialist will confirm the exact figure for you shortly." Three identical robot replies in a row, with zero acknowledgement of what the customer actually said. Serge's diagnosis: "he's not reacting to the message he receives, lots of weakness" and asked for the eternal solution.

**Root cause.** The architecture itself, not a prompt-tuning miss. `dispatchEscalation` in `src/handler.js` had a hard-coded customer-side path: when an open `pending_queries` row existed (or after creating a fresh one), it ALWAYS sent `SILENT_QUERY_REPLY` / `HOT_LEAD_REPLY` to the customer regardless of the message they had just sent. The owner-ping side was correct (throttled follow-ups, fresh alerts), but the customer side was deaf. Yesterday's stall-guard fix had only attacked Sunny's invented stalls; it had reinforced the canned-line behavior instead of removing it. So when the customer pushed back ("When?", "It's been 1 day"), the classifier flagged each as `silent_query` (an open pending row exists), and dispatchEscalation parroted the same canned line every time.

**Fix shipped (this commit).** Trust the LLM with constraints, instead of hard-coding outputs.

Customer-side reply is now ALWAYS produced by `generateReply`, even when the conversation is in escalation:
- New `options.expertContext` parameter on `src/claude.js > generateReply`. If set, it is pushed as a system block alongside the conversation-state block.
- New `src/handler.js > buildExpertContext({ openPending, escalationJustCreated, isHot })` builds the block content per turn. Two variants:
  - "# HOT lead handoff context": tells Sunny to acknowledge the commitment briefly, confirm a specialist will reach out, third person, no first-person stalls, no URLs (system appends the wa.me link automatically).
  - "# Awaiting expert input": tells Sunny what the open query was about, how long the customer has been waiting (formatted "Xm" or "Yh Zm"), and the voice rules (react to the actual message, third person, no invented prices/ETAs, empathize with frustration without over-apologizing, two sentences max, vary phrasing across replies).
- `dispatchEscalation` was renamed to `notifyOwnerForEscalation`. It now ONLY handles the owner side (follow-up ping for open pending or fresh alert + pending_queries row creation). Returns `{ openPending, freshPendingId, ownerNotified, escalationType, throttled }` so the caller knows what context to build.
- `processCustomerBatch` was reworked: classify → call `notifyOwnerForEscalation` if needed → look up current open pending → build the appropriate `expertContext` (HOT block, awaiting-expert block, or null) → call `generateReply` with that context → run stall-guard → for HOT, append `\n\nDirect line to the specialist: <wa.me link>` to the LLM-produced text.
- Stall-guard rewritten: now only runs on the no-escalation path (when `expertContext` is null and Sunny still produced a first-person stall). Triggers the same owner-side escalation flow, then re-calls `generateReply` with the freshly-built awaiting-expert block. If regeneration fails or still stalls, sends a single short generic ack ("Noted. The team is on it.") instead of the long canned `SILENT_QUERY_REPLY`. Logs `handler.stall_regenerated_with_expert_context` (success path) or `handler.stall_regen_failed_used_generic_ack` (deep fallback).

`src/prompts/system.md` updates:
- New top-level section "Dynamic context blocks the system may inject" documents the two block variants and their voice rules. Acts as a stable reference if the per-turn block is ever absent.
- Old instructions that quoted the literal canned holding lines (lines 52, 138, 306, 326, 329, 418, 421, 430) were rewritten to point at the dynamic blocks. Removed Sunny's old guidance to send "Let me confirm the exact spec or price and get back to you in a few minutes." (that line is now exactly the kind of stall the regex catches).
- Added concrete example exchanges for both block types, including the customer follow-up case ("It's been a day. → Understood, the wait is fair. The team has been pinged again about your 8kW figure...").

`HOT_LEAD_REPLY` and `SILENT_QUERY_REPLY` constants stay in `src/handler.js` but are now only used as deep fallbacks (when `generateReply` itself errors out, e.g. Anthropic 5xx).

**Files touched:** `src/claude.js`, `src/handler.js`, `src/prompts/system.md`, `CLAUDE.md`, `docs/session-history.md`. Smoke tests: `node -e "require('./src/handler'); require('./src/claude');"` loads clean.

**Trade-off accepted.** The LLM has more freedom in the awaiting-expert path; in theory it could invent a price or fixed ETA. The existing guards still apply: price-strip (when customer didn't ask), prompt-leak detector, owner-number leak detector, phone-list-dump block, catalog-enumeration block, repeat-guard, trailing-question-strip, asterisk-censorship retry. The stall regex still runs as a final check on the no-escalation path. We accept this risk because the screenshot bug ("dumb robot parroting") was a hard launch-blocker per Serge's words.

## 2026-05-06 evening Beirut — re-page owner on follow-ups + stall-language guard

**The bug Serge surfaced.** Screenshot of a real Sunny TEST conversation: customer asked "What options you have?" → Sunny invented "We typically stock Jinko 580W and 590W panels" (Jinko panel wattages are not in the catalog, Opus hallucinated). Customer asked for the cost of 100 pieces → Sunny escalated correctly with `SILENT_QUERY_REPLY` ("A specialist will confirm the exact figure for you shortly.") and the brother got the [QID:N] alert. So far so good. Then customer kept pushing ("Which specialist? Give me the cost... I need to know the cost"). The brother got NOTHING for any of these follow-ups, but the customer received three Opus-invented stall replies: "One of our sales engineers will reach out shortly with the figures.", "Let me confirm the exact figure for 100 units and get back to you shortly.", "Let me confirm the exact figure for 100 x Jinko 580W and revert shortly." Customer waited for someone who was never paged.

**Root cause.** The 30-min `ESCALATION_COOLDOWN_MS` throttle in `src/security.js > checkEscalationThrottle` was demoting every follow-up escalation back to a normal Opus reply. The throttle's purpose is sound (defends against an attacker spamming alerts at the brother's WhatsApp), but it had no concept of "this contact already has an open pending_query, just FYI the brother that the customer is still asking." So Sunny fell back to Opus, and Opus invented "I'll check and revert" promises directly violating `system.md:218,225` ("do not stall... never leave the customer with just 'I'll get back to you'").

**Fix shipped (commit `50729dd`).** Two layers.

Layer 1, the open-pending-query side channel:
- New `getOpenPendingQueryForContact(contactId)` in `src/memory.js`.
- New `FOLLOWUP_COOLDOWN_MS` (default 5 min) and `checkFollowupThrottle` in `src/security.js`.
- Refactored `src/handler.js > processCustomerBatch` escalation block into a helper `dispatchEscalation`. Before applying the main 30-min throttle, the helper checks if a `pending_queries` row with `status='pending'` exists for this contact. If yes, it sends a "Follow-up on [QID:N], same customer is still asking. New customer message: ... REPLY to the original [QID:N] alert with the answer." ping to the owner (rate-limited at one per 5 min per contact via `checkFollowupThrottle`). It does NOT create a new pending_queries row and does NOT touch the main escalation throttle. The customer still gets the canned `SILENT_QUERY_REPLY`. The brother sees urgency rise on a query he already knows about.
- Brand-new escalations (no open pending) still go through the original 30-min throttle and `notifyOwnerEscalation`, unchanged.

Layer 2, the stall-language guard:
- New `detectStallLanguage(text)` in `src/security.js`. Patterns (case-insensitive): `(let me|I'll|I will|we'll|we will) (check|confirm|verify|find out|come back|revert|get back)`, `(get back to you|will revert|will come back to you|circle back with you)`, `(sales engineer(s)?|our team|our engineer(s)?|our sales|one of our (sales engineer(s)?|engineer(s)?|team)) will (reach out|contact|get in touch|follow up|revert)`, `give me a (moment|second|minute)`. The 12-case smoke test confirmed it catches the three exact replies from Serge's screenshot AND it does NOT match the canned `SILENT_QUERY_REPLY` ("A specialist will confirm...") or `HOT_LEAD_REPLY` ("Noted. A specialist will follow up...") since those are third-person.
- After `generateReply` returns, before sending, `processCustomerBatch` runs the stall detector. If matched and `DISABLE_ESCALATIONS=false`, it forces `escalation_type='silent_query'` on a synthetic classification and calls `dispatchEscalation` with `source='stall_guard'`. Customer gets the canned line, brother gets a follow-up or fresh alert. If main throttle blocks AND no open query exists, the stall is replaced with the canned `SILENT_QUERY_REPLY` and a `handler.stall_replaced_no_alert` warning is logged. The kill-switch path (`DISABLE_ESCALATIONS=true`) skips the stall guard entirely so testing without canned messages still works.

**Files touched:** `src/security.js`, `src/memory.js`, `src/handler.js`, `CLAUDE.md`. Tests in-process: `node -e "require('./src/security'); require('./src/memory'); require('./src/handler');"` loads clean. Stall detector smoke test: 12/12 cases pass.

**Verified live on Railway.** Deploy `c9472254-42c6-4675-913e-b9b86bd910ac`, container booted at 2026-05-06 17:03:33 UTC with `cron.all_schedules_skipped_at_boot` (kill switch honored) and `handler.recovery.no_orphans`. `/version` returns `git_sha_short: 50729dd`, `escalations_disabled: false` (stall guard armed), `notifications_disabled: true`, `owner_whatsapp_tail: "8055"`. Next time a customer pushes through an open query: watch `railway logs` for either `handler.escalation.followup_to_open_query` (layer 1) or `security.stall_language_detected` (layer 2).

**Open from this session, NOT addressed in this commit.** Sunny still invented "Jinko 580W and 590W" panel wattages in the first reply. The brand mention is allowed by `system.md:186,337` (we work with Jinko/JA/Longi) but the SPECIFIC wattages are made up. Brother's pricing data for Jinko/JA/Longi/Sungrow is still pending (per CLAUDE.md "Resume plan"). When that lands, add Jinko panels to the catalog and the wattage hallucination dies on its own. Until then, consider tightening `system.md` to forbid quoting any panel wattage that isn't in the catalog block.

## 2026-05-05 evening Beirut — conversation-state engine, voice + calls, orphan recovery, hard-ban on trailing questions

**Conversation-state engine (commit `4a35339`).** The architectural shift from patching individual bugs to giving Opus a structured world model. New `buildConversationState(history, currentMessage)` in `src/claude.js` extracts:
- Facts the customer shared: system size (kW/kVA), battery kWh, phase (single/three), brand mentions (Deye/Sungrow/JA/Longi/...), project type (hotel/factory/residential/...), location (Lagos/Abuja/...), installer-vs-end-user signal.
- Questions Sunny has ALREADY asked (do NOT re-ask): installer-or-end-user, single-or-three-phase, location, load/quantity, budget, timeline.
- Customer asks/questions in the current message: extracted by question-mark + question-word heuristics.

Injected as a system block before each Opus call. `src/prompts/system.md` has new sections: "How to use the Conversation state block", "Handling messages with multiple ideas" (multi-part asks), "Anti-repeat rule".

**Cascade fix (commit `7bc982e`).** Live failure: customer asked "Can I parallel different sizes of inverters?" → Sunny generated reply with sample-config prices → previous code-level guard OVERWROTE the entire reply with generic "What size or load are you sizing for?" → customer said "350kw 3phases" THREE times and got the same canned reply each time → escalated to silent_query.
- Replaced REPLACE-with-fallback with STRIP-prices-keep-rest.
- New no-repeat guard: if new reply is identical to last outbound, overwrite with "Apologies, let me re-read your last message."
- New "Answer YES/NO questions with YES or NO first" rule.

**Pricing discipline harden (commits `f2eac1d`, `7a110e5`).** Sunny was volunteering price lists on "I want inverters" or "do you have batteries". Two-layer fix: prompt rule with explicit allowlist of trigger phrases, plus code-level guard that strips price patterns when customer didn't ask. Memory: `feedback_sunny_pricing_discipline.md`.

**Inverter parallel engineering rule (commit `94c3e42`).** Live failure: Sunny suggested "4 x 80kW + 1 x 30kW" for 350kW which is INVALID. Same-size only, max 10 units. Saved both in system prompt AND knowledge_entries (id 824).

**Catalog fidelity rule (commit `21ec42c`).** Sunny said "BOS-A 16kWh" but BOS-A is 7.68kWh (BOS-B Pro is 16kWh). Also hallucinated "10.6kWh" not in catalog. Top-priority rule now forbids inventing capacities or swapping between models. Lists exact catalog strings Opus must use verbatim.

**Daily LLM budget raised to $20** (was $5). Set via `railway variables --set DAILY_LLM_BUDGET_USD=20`. At Opus rates this covers ~400-800 messages/day.

**Cron registration NUKED at boot when DISABLE_NOTIFICATIONS=true (commit `ffe7208`).** Stronger than per-firing skip: cron schedules don't even register when env var is true. Logs `cron.all_schedules_skipped_at_boot` once at startup.

**Pickup-vs-delivery + Best-price rules (commit `c27e0f7`).** Two new operational rules saved in system.md AND knowledge_entries (ids 825, 826):
- When asked where to get the product: ask if pickup from Abuja warehouse (Plot 816, Idu Industrial Area), Lagos warehouse (Rutam House), or delivery (delivery fees excluded, charged separately).
- When asked "is this the best price": reply "Yes, this is our best price. Are you ready to pay now?" If yes → HOT lead escalation. If no → acknowledge and stop pushing.

**Orphan recovery on startup (commit `c27e0f7`).** Real bug: in-memory debounce queue is wiped on container restart. Patrick's "What about batteries" message arrived 11 seconds before a redeploy and never got a reply. Fix: `recoverOrphanedInbound(maxAgeMinutes)` scans for inbound messages without a subsequent outbound reply (and not human_handled, not from owner) and re-queues them through the normal pipeline. Server.js calls it 3s after `app.listen`. Default 10 minutes.

**Voice note transcription (commit `834e2b0`).** WhatsApp voice notes (audio messages) now flow through the full pipeline:
- handler.js detects `msg.type === 'audio'` (or `voice`) and downloads from Meta media API.
- New `src/transcribe.js` calls OpenAI Whisper API (`whisper-1` by default, `WHISPER_MODEL` env override).
- Pipeline: download → save to MEDIA_DIR → Whisper transcription → rewrite `msg.body` to transcript and `msg.kind='text'` so the rest of the handler processes normally.
- Persisted in messages table with `[voice note transcribed]: <text>` prefix for admin visibility.
- Falls back gracefully if `OPENAI_API_KEY` is missing or Whisper fails ("[Customer sent a voice note that could not be transcribed]").
- Cost: ~$0.006/minute (~$0.005-0.01 per typical voice note).
- New dependency: `form-data` for multipart upload.
- **Pending: set `OPENAI_API_KEY` on Railway when Serge has one.**

**WhatsApp call auto-reply (commit `834e2b0`).** When Meta delivers a `calls` webhook event (someone tries to voice-call the business number), Sunny auto-sends: "Hello, this number isn't monitored for voice calls. Please send a text message and the Electro-Sun team will respond." Throttled per-caller to once per hour (in-memory). Logs `call_received` event for admin analytics. Note: Meta's Calling API is in beta; whether the `calls` webhook events actually arrive depends on Cloud API access tier.

**Catalog dedup.** Catalog had 12 duplicate items (ids 23-34) from a second `seed_hv_products.js` run. Deleted via API after Serge's authorization. Catalog now has 22 items only.

**HARD BAN on trailing questions (commit `e3b2598`).** The `a2f4be9` "optional question" rule was too soft; Sunny still asked a question after every one-word answer ("30kwh" → "Is this for home or business?", "Home" → "Single or three phase?", "Three phase" → "What's the peak load?"). Customer felt interrogated. Two-layer fix:
- system.md: rewrote REPLY LENGTH section as HARD BAN. Top of section: "STOP ASKING QUESTIONS AFTER EVERY ANSWER. This is the #1 most violated rule." Bad-vs-good table with EXACT failures from screenshots. Acknowledging is enough: "Noted." or "Got it." then STOP.
- claude.js: code-level guard. If customer's message is short factual (≤40 chars, no question mark) AND Sunny's reply ends with "?", STRIP the trailing question sentence from the reply. Logs `claude.reply.trailing_question_stripped`.

## 2026-05-05 afternoon-evening Beirut — short replies, debounce, pricing discipline, parallel inverter rule, local zombie killed

**Short-reply enforcement (commit `c253fc2`).** Live failure: Sunny was producing 3-paragraph "brochure" replies. Fixed:
- `src/prompts/system.md`: new "REPLY LENGTH" section. Max 2 short sentences per reply by default. No bullet lists, no proactive education, no multi-paragraph essays. Added bad/good examples. Replaced "offer 2-3 options" rule with "give ONE concrete answer, ask ONE clarifying question". Rewrote ALL worked-example dialogues so every reply is ~10-15 words.
- `src/claude.js`: `max_tokens` cut from 600 to 180 so Opus physically can't write paragraphs.

**Multi-message debounce (commit `c253fc2`).** When customers send 3-4 messages back-to-back (Patrick's "12kVA?, 8kVA?, lithium battery, all deye products" pattern), Sunny was processing each independently and replying 3 times with similar text. Fixed:
- `src/handler.js`: per-contact in-memory debounce queue with `MESSAGE_DEBOUNCE_MS` env (default 6000ms). Persists each message to DB immediately (admin UI sees them in real-time), but classification + reply only fire ONCE per debounce window.
- Combined classifier input format: `[Customer sent N messages back to back]\nmsg1\nmsg2\nmsg3` so Opus reads them as one logical turn.

**Pricing discipline (commits `f2eac1d`, `7a110e5`).** Sunny was volunteering price lists on questions like "i want inverters" or "do you have batteries". Two-layer fix:
- `src/prompts/system.md` ABSOLUTE rule: do NOT mention any price unless customer explicitly asks ("how much", "price", "cost", "naira", "NGN", "quotation", "quote", "rate"). Quote ONLY the specific item asked about, never adjacent products. NEVER produce a price list. Catalog is for reference only; don't recite. 6 worked examples covering "I want inverters" → no price.
- `src/claude.js` code-level guard: scans Opus reply, if customer didn't ask for price AND reply has 2+ price patterns, OVERWRITES the reply with "What size or load are you sizing for? Single or three phase?" Logs `claude.reply.price_dump_blocked`.
- Memory: `feedback_sunny_pricing_discipline.md`.

**Inverter parallel engineering rule (commit `94c3e42`).** Live failure: Sunny suggested "4 x Deye 80kW + 1 x Deye 30kW" for a 350kW system, which is INVALID — inverters can only be paralleled if same size, max 10 units. Fixed:
- `src/prompts/system.md`: new "Engineering rules you must NEVER violate" section right above the locations block. Same-size only, max 10 units, with valid examples (7 x 50kW = 350kW, 5 x 80kW = 400kW) and the explicit invalid example so Opus pattern-matches against it.
- Same fact saved to `knowledge_entries` (id 824) via API, category=product, so brother can edit from admin.

**Daily LLM budget raised to $20** (was $5). Set via `railway variables --set DAILY_LLM_BUDGET_USD=20`. At Opus rates this covers ~400-800 messages/day.

**Cron registration NUKED at boot when DISABLE_NOTIFICATIONS=true (commit `ffe7208`).** Previous version registered the cron schedules and skipped at fire time. Stronger: when env var is true at startup, do NOT register any cron schedules at all. Container has zero scheduled work for notifications. Logs `cron.all_schedules_skipped_at_boot` once at startup. Re-enable: `railway variables --set "DISABLE_NOTIFICATIONS=false"` triggers a redeploy that re-registers the schedules.

**LOCAL SUNNY ZOMBIE KILLED (the real culprit).** Serge kept getting "ELECTRO-SUN AGENT REPORT" messages every 2 hours despite the cloud kill switch being verified working. Cause: a `npm start` process had been running on his Mac since Sunday 10 PM (PIDs 59578 + 59596), reading the LOCAL `.env` from when it booted. Local Sunny had a stale cached `OWNER_WHATSAPP=966502392650` (Saudi number) AND its own cron firing every 2h. It used the same Meta API credentials so messages actually delivered. **Always check `ps aux | grep node` for local zombies when reports appear that the cloud DB has no record of.** Killed both PIDs. Local `.env` updated to set `DISABLE_NOTIFICATIONS=true` to prevent recurrence on future accidental `npm start`.

## 2026-05-05 12:15am Beirut — DISABLE_NOTIFICATIONS kill switch

Owner reports + reminders silenced while Serge tests as a customer. Set `DISABLE_NOTIFICATIONS=true` on Railway via CLI. Cron handlers in `server.js` skip cleanly with one log line each:
- 2-hour cron reports (`sendOwnerReport`)
- Daily reports (21:00 Africa/Lagos)
- Daily learning report (21:30 Africa/Lagos)
- 30-min window scan (24h-window reminders, over-budget alerts)

Inbound customer messages still work normally. Webhook handling, admin UI, DB tracking all unaffected. Verified live at `notifications_disabled=true` via `/version`. To re-enable: `railway variables --set "DISABLE_NOTIFICATIONS=false"` from the repo. Commit `9ddfd81`.

## 2026-05-04 8:30pm-9pm Beirut — Railway CLI + bulletproof greeting + history scrub

**Railway CLI installed.** Serge auth'd, Claude can now run `railway` commands directly from this repo:
- Project linked: `ample-laughter` / environment `production` / service `sunny-electrosun`
- `railway variables --set KEY=VALUE` updates Railway env vars without dashboard clicks
- `railway up --detach --ci` triggers a fresh deploy from local files (does NOT use git SHA, so `RAILWAY_GIT_COMMIT_SHA` env will be null on these deploys)
- `railway redeploy --yes` re-runs the latest deploy (only works when no build is in progress)
- `railway logs` tails live logs
- `railway status` confirms project/env/service binding
- IMPORTANT: `railway variables` (no args) is BLOCKED in Claude's sandbox because it would dump every secret into the transcript. Use `--set` for writes; use `/version` and `/api/brain` endpoints to read non-secret config like `owner_whatsapp_tail` and the `MODEL_*` values.

**OWNER_WHATSAPP routing fixed at 8:42pm Beirut.** Reports were going to Serge's Saudi number (`966502392650`) all evening because the Railway env var was still set to it despite the brother's number being intended. Set via CLI: `railway variables --set OWNER_WHATSAPP=2347041328055`. Verified live via `https://sunny-electrosun-production.up.railway.app/version` → `owner_whatsapp_tail: "8055"`.

**Public `/version` endpoint shipped (commit `f469935`).** No API key required. Returns `git_sha_short`, `git_branch`, `git_commit_message`, `deploy_id`, `escalations_disabled`, `owner_whatsapp_tail`, `node_uptime_seconds`. One-tap diagnostic for what's running. Lives on the main app router (`server.js`), NOT under `/api`, so it bypasses the X-API-Key middleware.

**Defense-in-depth greeting bypass (commit `d87c455`).**
- `src/handler.js`: `handlerIsGreeting()` runs BEFORE the escalation branch and forces `needs_escalation=false` on any short greeting message even if the classifier somehow asked for hot_lead. Belt-and-suspenders against the `src/classifier.js` fast-path bug.
- `src/handler.js`: `DISABLE_ESCALATIONS` env kill switch. Set `DISABLE_ESCALATIONS=true` on Railway and ALL escalations (hot_lead and silent_query) get demoted to normal Sonnet/Opus replies. Useful for testing without canned holding messages firing.

**Critical bug fixed (commit `2a94d8b`).** The greeting guard in `src/classifier.js` was checking `message?.body` but the classifier receives the message body as a STRING, not an object. So `body` always evaluated to `"undefined"` and the regex never matched. That's why "hello" still hit hot_lead even after `065653a` deployed. Fix: new `bodyText()` helper handles both string and object inputs. Plus a fast-path that returns a synthetic `{C1, COLD, no escalation, intent=greeting}` result and SKIPS Haiku/Opus entirely for casual greetings, saving cost.

**wa.me link ban + history scrub (commit `735d748`).** Live failure: greeting bypass worked, but Opus generated its own wa.me link in the reply text, mimicking patterns it saw in prior canned holding replies in the conversation history. Three fixes:
- `src/prompts/system.md`: top-priority rule "NEVER write wa.me URLs, click-to-chat links, or phone-number tel-links". The system handles handoff via separate canned messages.
- `src/prompts/system.md`: "Treat each new customer message as the live one. A greeting gets a greeting reply. Do NOT bring up prior products, categories, or temperatures."
- `src/claude.js`: `scrubHistoryContent()` strips wa.me URLs and "Direct line to the specialist" sentences from prior assistant messages before sending history to Opus. Replaces canned holding-reply lines with `[earlier system holding message]` so Opus can't anchor on the pattern.
- `src/claude.js`: when current message is a casual greeting, suppress the "Known about this customer" context block (except name) and append guidance: "Do NOT bring up prior products."

**Empty history on greetings + extended AI-speak ban (commit `851faa8`).** Even with context-block suppression, Opus still anchored on prior turns ("12kW order and payment details") because the conversation HISTORY itself referenced those. Fix:
- `src/claude.js`: when greeting detected, send Opus an EMPTY conversation history (clean slate). Just the system prompt + the greeting. Stops Opus from inheriting any anchor from prior turns.
- `src/prompts/system.md`: extends the AI-speak ban list with "I can help you with", "Is there anything else I can help you with", "How can I assist you", "How may I assist". Adds explicit rule against carrying over prior context the customer did not bring up in the current message.

**Architecture rule (Serge clarified):** On a greeting, history is empty so Opus can't anchor. On any other message, full history available so Opus CAN pull prior context if the customer references it ("what about that 12kW we discussed?"). Don't proactively reach into history; do reach in when asked.

**Address-vs-phone split (commit `a6d2a7a`).** Live failure: customer asked "Where in Lagos" twice, Sunny replied with the Lagos PHONE number instead of the Lagos OFFICE ADDRESS. Three fixes:
- `src/prompts/system.md`: split the conflated "do not proactively share phone OR address" rule. Addresses ARE shared whenever asked about location, branch, office, pickup, visit, warehouse. Phone numbers are still NEVER proactive (only on explicit "call me"/"your number" or HOT lead).
- `src/prompts/system.md`: baked the actual office addresses into the prompt as a top-of-prompt "Electro-Sun locations" section. Always in scope, never pruned by the knowledge cap.
- `src/prompts/classifier.md`: location/branch/address/pickup/warehouse questions are NEVER silent_query.

**Specialist-link gating (commits `065653a`, `d3992ab`).** Specialist link was being attached to every escalation reply (silent_query AND hot_lead). Now: link only attached on `escalation_type === 'hot_lead'` AND `SPECIALIST_DIRECT_LINK` env set. Silent queries get just the holding sentence (team will handle via the alert pipeline).

**Voice rule deepened.** All references to "Great." in worked examples and HOT_LEAD_REPLY constant scrubbed. New holding reply: "Noted. A specialist will follow up with you shortly with the formal documents and final figures."

## 2026-05-04 8pm Beirut — Opus everywhere

Serge directive: every model call uses `claude-opus-4-7`. Classifier, reply, teacher, owner-Q&A, all on Opus. Reasoning: he's frustrated with Haiku-classifier mistakes (greetings escalating, addresses turning into phone numbers in replies) and wants a single high-capability brain handling everything.

**Implemented:**
- `src/claude.js`: `MODEL_CLASSIFIER` and `MODEL_REPLY` default to `claude-opus-4-7`, env-overridable via `MODEL_CLASSIFIER` / `MODEL_REPLY`.
- `src/knowledge.js`: `MODEL_TEACHER` defaults to `claude-opus-4-7`, env-overridable via `MODEL_TEACHER`.
- `src/owner_qa.js`: `MODEL` defaults to `claude-opus-4-7`, env-overridable via `MODEL_OWNER_QA`.
- `src/cost_tracker.js`: added Opus pricing (1500 cents/M input, 7500 output, 150 cache_read, 1875 cache_write). `DAILY_LLM_BUDGET_USD` guardrail still enforces, just trips faster.
- `api/dashboard.js`: `/api/brain` now reports the live model env values so the admin Models & config tab shows what's actually running, not the hardcoded constants.

**Cost reality:** ~$0.025-0.05 per message vs ~$0.005 before. Roughly 5-10x. At 500 messages/day that's $15-25/day or $450-750/month. Brother needs to confirm appetite. Use the env overrides to step back to Sonnet/Haiku selectively if budget tightens (`MODEL_REPLY=claude-sonnet-4-6` for example).

**Important caveat documented in CLAUDE.md:** the recent visible bugs ("hello" escalating, link spam on every escalation, phone-vs-address confusion) were all CODE bugs in classifier.js, handler.js, and system.md. They are NOT model-quality issues. Opus does NOT fix bad code; it only improves judgement on borderline cases the prompt actually handles correctly. Greeting fast-path bypass + address-vs-phone split + greeting-guard string-typing fix shipped in commits 2a94d8b, a6d2a7a, 065653a, d3992ab.

## 2026-05-04 evening tail (Beirut) — voice rule + diag

**Voice rule, set permanently 2026-05-04 (Serge):**
Sunny must NOT sound like an AI. No compliments, no subjective praise, no AI-speak fillers. Banned phrases include: "Great", "Great choice", "Great project", "Great question", "Excellent", "Awesome", "Amazing", "Perfect", "I'd be happy to help", "I love that", "Sounds wonderful", "I understand", "I see", "I hear you", "Let me help you with that", "Feel free to...", "Hope this helps", "Just to clarify", "Certainly", "indeed", "moreover", "delve". No unsolicited adjectives on the customer's project ("nice property", "good plan"). Tone target: Lagos sales floor, not customer-service chatbot. Information first, brevity always.

Implemented in:
- `src/prompts/system.md`, new section "No compliments, no AI-speak, no subjective phrases" added directly under "Voice".
- All worked-example dialogues in `system.md` scrubbed of compliment openers (no more "Great." in HOT replies).
- `src/handler.js > HOT_LEAD_REPLY` and `SILENT_QUERY_REPLY` rewritten without "Great" or "happy to help" tone.
- `UNSUPPORTED_REPLY` shortened, no more "I'll get back to you right away".
- Specialist-link copy ("If you'd like to reach our specialist directly now") replaced with neutral "Direct line to the specialist:".
- Memory: `memory/feedback_sunny_voice_no_compliments.md`.

**Number swap timing rule (Serge, 2026-05-04):**
Replace the test number `+1 555 172 6906` with the real Electro-Sun production number ONLY when end-to-end testing is 100% done. Until then, keep the test number. Brother's number is already in use as `OWNER_WHATSAPP` for alerts and reports; that's separate from the customer-facing number.

**Owner-target diagnostics (commit `7c348e3`):**
- `/api/brain` now returns `owner_whatsapp_tail` (last 4 digits of `process.env.OWNER_WHATSAPP`) so the admin Knowledge tab can verify which number the live container is targeting without leaking the full number.
- `src/reports.js`: every `sendOwnerReport` and `sendDailyLearningReport` call logs `report.target {owner_tail: "XXXX"}` at info-level. Lets you see in Railway logs where each cron actually fired.
- Reason: 4 PM and 6 PM Beirut crons both landed on Serge's phone despite `OWNER_WHATSAPP` set to brother's number (`8055`) on Railway. Diagnostic is in place to catch whether the env or the code is at fault on the next cron firing.

## 2026-05-04 afternoon-evening session (Beirut) — full snapshot

Today's focus: production hardening, owner cutover, owner Q&A, knowledge ingestion at scale, admin UI redesign in two passes (brand-dark, then WhatsApp-light).

**Owner cutover (Task #17 partial):**
- Brother's number `2347041328055` is now `OWNER_WHATSAPP` on Railway. Brother is whitelisted on Meta. Serge stays as a customer-tester from `+966 50 239 2650`. Serge's messages now flow through the normal customer pipeline.
- Specialist link kept pointing at brother's number too (`SPECIALIST_DIRECT_LINK=2347041328055`).
- Note: a 4 PM Beirut 2-hour cron report still landed on Serge's phone the day of the env change, attributed to a stale container; next cron should land on brother's. **Verify each cron firing for the next 24h**.

**Image vision (commit `ad39a4e`):**
- WhatsApp images now flow through full pipeline: download from Meta media API, save to `MEDIA_DIR` on the Railway volume (default `/data/media/`), pass as base64 to Sonnet 4.6 vision.
- `src/whatsapp.js > downloadMedia(mediaId)` does the two-step Meta download (metadata GET → signed URL GET with auth, 25MB cap).
- `src/handler.js`: `extractMessages()` picks up `msg.type === 'image'`, `handleInbound()` downloads + base64s + threads into `generateReply(history, message, contact, attachments)`.
- `src/claude.js > generateReply` accepts attachments; rewrites the last user message into a multi-block content array with image blocks before the text.
- `src/memory.js`: new `media_path` and `media_mime` columns on messages; idempotent migration in `db/init.js`.
- Classifier still text-only by design; sees `[Customer sent an image with caption]: ...` marker.
- Use cases unlocked: roof photos, inverter labels, meter readings, payment screenshots (HOT escalation), warranty damage photos.

**Owner teaching → owner Q&A (commits `bb2b540` then `543440b`):**
- First version was teaching mode: brother WhatsApps Sunny → Haiku-teacher (`src/prompts/teacher.md`) extracts facts → saved to `knowledge_entries` (status=active) → Sunny WhatsApps confirmation back. New table + CRUD + admin Knowledge tab shipped with this.
- Then the brother's first real conversations made it clear that teaching-mode + casual chat were getting confused. Replaced with **owner Q&A mode** (`src/owner_qa.js`, `src/prompts/owner_qa.md`). Brother now asks Sunny questions about his data ("how many leads today", "any HOT leads", "did Patrick reply") and Sunny answers from a live snapshot (today's stats + last 24h hot leads + pending queries + recent contacts + brother's own chat history + active facts count). For teaching, brother uses the admin Knowledge tab.
- `src/handler.js > handleOwnerNonQueryMessage` calls `answerOwnerQuestion(ownerContactId, msg.body)`. Persists owner inbound/outbound with intents `owner_question` / `owner_qa_reply`.
- Owner replies to alerts (`msg.replyToId` matching a pending QID) still route via `handleOwnerReply` and relay to the customer.

**Catalog moved to DB and made editable from admin (commit `e771021`):**
- `db/schema.sql`: new `catalog_items` and `catalog_notes` tables.
- `db/init.js`: idempotent seed-from-`products.json` on first boot. `products.json` stays in repo as the seed source; subsequent boots leave the DB alone.
- `src/catalog.js`: CRUD + `formatCatalogForPrompt()` produces the same Markdown block `claude.js` used to bake at module init.
- `src/claude.js`: drops file-based loader, calls `formatCatalogForPrompt()` inside `generateReply()` so each customer reply sees the latest prices (no restart needed after an edit).
- `api/dashboard.js`: `GET /api/catalog`, `POST /api/catalog/items`, `POST /api/catalog/items/:id`, `DELETE /api/catalog/items/:id`, plus notes CRUD.
- Admin UI Catalog sub-tab is fully editable: per-row inputs for brand/model/price/stock/notes with Save/Delete; "Add a new item" form; editable note list; flash-green confirmation on save. Owner can change prices any time without a developer push.

**Knowledge tab expanded** (commit `38f26cd`): Knowledge tab has four sub-panels now:
- **Live facts**: existing owner-taught facts (filterable, editable).
- **Rules**: read-only render of `system.md`, `classifier.md`, `teacher.md` so the owner can see what's in Sunny's system prompt.
- **Catalog**: fully editable (above).
- **Models & config**: model IDs (Sonnet 4.6 reply, Haiku 4.5 classifier, Haiku 4.5 teacher), runtime config (DB path, media dir, daily budget, WABA ID, graph version), and which env vars are set as booleans only (never the actual values).
- New endpoint `GET /api/brain` returns rules + models + config from disk and env. No secrets returned.

**HV catalog seeded (commit `99a91fd`):**
- New script `scripts/seed_hv_products.js`. Posts 12 catalog items + 4 product facts:
  - Inverters: Deye 30/50/80kW HV 3-phase (4.1M / 5.9M / 8.8M NGN).
  - Batteries: BOS-G 5.12kWh (1.15M), BOS-A 7.68kWh (1.65M), BOS-B Pro 16kWh (2.75M).
  - Battery accessories (new section in catalog): BOS-G PDU + rack, BOS-A PDU + rack 11/14, BOS-B PDU+accessories.
  - Compatibility facts about PDU stacking limits per inverter size.

**Legacy data import (commit `44bf23d`):**
- `scripts/import_legacy.js` parses the brother's old MariaDB dump from `/Users/sergeadaimy/Downloads/localhost.sql` (whatsapp_n8n_database_v2 schema). 11k+ message rows, 258 INSERT statements, plus `ai_memory` and `contact_list`.
- Five stages, all post to `/api/knowledge`:
  1. `ai_memory` direct (10 already-extracted Q&A facts saved as `customer`).
  2. `fact_summary` per substantive conversation, deduped by leading 80 chars to avoid near-identical "client inquired about X" repeats. Cap 150 most recent.
  3. Pricing references via regex over team replies (`Nx.xM`, `xxxk`). Limited to 80 unique. Marked as historical "Past quote ({date})" entries. **Later REJECTED** because they were polluting Sunny's prompt with stale prices (commit `4eb07fe`).
  4. Writing-style examples: 25 sampled team replies bundled into one fact in `sales` category as a tone reference.
  5. (Optional, `--llm`) Haiku pass over top 80 substantive conversations. Extracts up to 4 facts each, confidence ≥ 60. Costs ~$0.05 in API spend.
- Bound runaway memory: `src/knowledge.js > formatKnowledgeForPrompt` now caps active facts at most recent 500 entries and 30KB total characters (env-overridable: `KNOWLEDGE_PROMPT_MAX_FACTS`, `KNOWLEDGE_PROMPT_BUDGET_CHARS`).

**Critical bug fix (commit `5c64aa8`):**
- `src/memory.js > updateContactFields` was crashing with `RangeError: Too many parameter values were provided` when Haiku returned `products_asked_about` as an array (better-sqlite3 spreads arrays into bind params). Now coerces arrays to comma-joined strings, plain objects to JSON, primitives to String(). Live impact: Patrick's "12kVA / 18kVA inverter" question silently failed before this fix.

**Behaviour fixes after the brother used Sunny in production (commit `4eb07fe`):**
- Sunny was dumping phone numbers and addresses on routine queries; doctrine facts weren't strong enough.
- `src/prompts/system.md` now opens with three top-priority rules:
  1. **Source of truth for prices is the catalog.** NEVER quote a price from owner-taught knowledge or "Past quote" entries. Past quotes are historical only.
  2. **Do NOT proactively share phone numbers or addresses.** Phone numbers (Patrick `07041328055`, Charbel `09068859213`, Lagos `0911 188 0000`) and office addresses NEVER appear in a reply unless the customer explicitly asks for contact/location/pickup OR the lead is HOT.
  3. **Think and answer from catalog + general knowledge before escalating.** Sizing questions are answered with concrete options, not silent_query'd.
- `src/prompts/classifier.md` updated: "I'm using 50kW inverter and want 200kWh backup" type sizing questions are explicitly NOT escalations now.
- `src/knowledge.js > addKnowledgeEntry` now dedups at insert time. If a new fact's normalised leading 120 chars (lowercase, alphanumeric+spaces only) match an existing active fact in the same category, returns the existing id without inserting. `skipDedup: true` escapes if needed.
- `scripts/cleanup_past_quotes.js`: one-shot to mark all "Past quote" pricing facts as rejected. Stays in audit trail; no longer feeds the prompt. **Run this after the next push.**

**Admin UI: full Electro-Sun brand refresh (commit `49a7baf`, then refreshed `3a2ca80`):**
- Pass 1 was a brand-dark theme with deep leaf-green surfaces, gold accents, Manrope/Fraunces typography. Brother didn't like it.
- Pass 2 (`3a2ca80`) is the WhatsApp-style light redesign. White surfaces, charcoal text, brand green only as a sparing accent. Inbox redesigned to look like WhatsApp Web: gradient-green avatar circles with per-contact initials (commit `55166a2`), white incoming bubbles with bottom-left tail, pastel green (`#DCF8C6`) outgoing bubbles with bottom-right tail, pastel violet for human-typed outgoing. Compose pill with circular green send button (paper-plane glyph). Typography: Inter throughout, system mono for phones/code. WhatsApp-style inline-bottom-right timestamps via float trick (commit `55166a2`).
- All four sub-tabs (Live facts / Rules / Catalog / Models & config) and all three top tabs (Inbox / Contacts / Knowledge) reskinned to the same palette.

**HV products + locations + sales doctrine seeded as Live facts:**
- `scripts/seed_locations.js`: 7 facts about Abuja office (Wuse 2), Abuja warehouse (Idu Industrial Area), Abuja contacts (Charbel/Patrick), Lagos office (Rutam House), Lagos line, DEYE Platinum credential.
- `scripts/seed_doctrine.js`: 3 facts enforcing the no-proactive-numbers/addresses doctrine and the credentials line ("DEYE Platinum authorised distributor").
- `scripts/seed_hv_products.js`: 12 catalog items + 4 product facts (above).
- All run-once, idempotent against the dedup at insert time.

**Done (20 of 27, plus #16 came free):**
1. Meta Developer app `ElectroSun_Whtspp` created. App ID `2440193806402796`.
2. Meta credentials captured. Test number `+1 555 172 6906`. Phone Number ID `1111486288711551`. WABA ID `1713234916358524`. Owner whitelisted (Saudi `+966502392650`).
3. Anthropic API key, Org `7e197f14-a3e1-4b93-9836-cd54cd831e1f`, Tier 2.
4. Meta business verification confirmed (since 2026-06-27, also closes #16).
5. `.env` filled, sanity check passed.
6. `cloudflared` installed (dev-only).
7. Sunny + quick tunnel booted on laptop.
8. Meta webhook configured.
9. First live WhatsApp test passed end-to-end. Anthropic block resolved on its own.
10. Five-language coverage by code review.
11. Force-escalation test passed.
12. Hourly report cron verified.
13. **Task #13 system prompt deployed against brother's Electro-Sun foundation document.** Identity: "member of the Electro-Sun team", never reveals AI. Voice: fast, direct, confident, professional, English-only. New categorization C1-C5. New lead temperature HOT/WARM/COLD/DISQUALIFIED/CLOSED/LOST. New client_type taxonomy. Two escalation patterns: silent_query and hot_lead. Punctuation rule (no double dashes) preserved.
14. **Task #14 classifier prompt deployed and hardened.** Outputs C1-C5, lead_temperature, client_type, escalation_type. HOT triggers force escalation regardless of prior context. Code-level safety net: if classifier sets HOT temperature without escalation, handler forces it. Live tested: 5 categories all classified correctly, hot lead handoff fires both customer reply and owner RED alert.
18. Permanent System User token issued. System User "Sunny-Server", ID `615889422441392`. No expiry.
19. **Task #19 templates submitted to Meta** 2026-05-04. Both PENDING. Approval clock running.
20. **Phase 5 cloud deploy DONE 2026-05-04.** Sunny live on Railway at https://sunny-electrosun-production.up.railway.app, /health returning 200, volume mounted, env vars set, Meta webhook updated to the Railway URL, `messages` field subscribed. **First live cloud conversation passed end-to-end** at 12:42 PM Beirut.
21. **Task #17 partial DONE 2026-05-04 evening.** `OWNER_WHATSAPP` swapped from Serge `966502392650` to brother `2347041328055` on Railway. Brother whitelisted on Meta. Serge stays as customer-tester. Real production WhatsApp business number (Task #17 full) still pending the brother providing one.

**Bonus shipped today (not on the formal task list):**
- `handleUnsupported()` in `src/handler.js`: voice notes / images / documents / stickers / locations no longer drop silently, customer gets a polite "text only" reply.
- HOLDING_REPLIES (multi-language) replaced with English-only HOT_LEAD_REPLY and SILENT_QUERY_REPLY constants per brother's "Always English" directive. Multi-language detection still runs in classifier for data capture only.
- `notifyOwnerEscalation` differentiates hot lead vs silent query in alert text (RED vs YELLOW, includes lead_temperature and client_type).
- Cloud-deploy readiness: `LOG_TO_FILE` env var (default true) opt-out for cloud PaaS. Disables `logs/sunny.log` writes and daily DB snapshot when set to `false`.
- Templates `templates/owner_hourly_report_en.json` and `templates/follow_up_24h_en.json` drafted with Meta API schema, ready for one-click submission.
- **Task #19 templates submitted to Meta 2026-05-04.** `scripts/submit_templates.js` posts both with `_notes` stripped. Owner hourly report id `3044946312362011`, follow-up 24h id `949981397673982`. Both PENDING. 24-48h Meta review clock running. Check status with `node -e "require('axios').get('https://graph.facebook.com/v21.0/1713234916358524/message_templates?fields=name,status,rejected_reason', {headers:{Authorization:'Bearer '+require('dotenv').config().parsed.META_ACCESS_TOKEN}}).then(r=>console.log(JSON.stringify(r.data,null,2)))"`.
- Contact #5 (Serge's test number) wiped clean multiple times during testing.

**Phase B code work shipped today (separate from launch sequence):**
- **Schema migration.** Added `lead_temperature`, `client_type`, `products_asked_about`, `brand_preference`, `budget_mentioned`, `expiring_warning_sent_at` columns. Added `pending_queries` and `daily_costs` tables. Idempotent ALTER TABLE migration in `db/init.js > applyMigrations`.
- **Reports refactor.** `src/reports.js` aggregates by `lead_temperature` (HOT/WARM/COLD/DISQUALIFIED) and `category` (C1-C5). Brother's Section 9.2 format with emoji headers, no em-dashes. Hourly cron switched from `0 * * * *` to `0 */2 * * *` per brother's spec.
- **Silent-query workflow (the killer feature).** Sunny holds the customer reply, sends YELLOW alert to owner with `[QID:N]` tag and `alert_message_id` captured. When owner long-presses the alert and replies in WhatsApp, webhook's `context.id` matches the pending row. `handleOwnerReply` posts the answer to the customer, marks pending resolved, logs `silent_query_resolved` event with `elapsed_ms`. Verified end-to-end: 27.5s loopback test.
- **Classifier HOT lock-down.** Tightened `src/prompts/classifier.md` so HOT temperature requires explicit commitment phrases (pay/account/proforma/deposit/install-date/proceed/order). Specific-brand pricing defaults to C2/WARM/silent_query.
- **Daily learning report (Section 9.3).** `generateDailyLearningReport` in `src/reports.js`. New cron at 21:30 Africa/Lagos. Pulls unanswered `pending_queries`, unsorted contacts, frequent inbound intents.
- **scripts/seed.js modernized** to C1-C5 + HOT/WARM/COLD demo data.
- **23h/24h window monitor (`src/window_monitor.js`).** New cron `*/30 * * * *` scans `pending_queries`. Rows past 22h: one-time reminder to owner. Rows past 24h: marked status='expired' and owner gets a "Meta window closed, needs template" alert. Idempotent via `expiring_warning_sent_at` column.
- **Budget guardrail (`src/cost_tracker.js`).** Per-day spend tracked in `daily_costs` table (cents, integers, no float drift). `recordUsage` after every Anthropic response includes input/output/cache_read/cache_write costs per model. `isOverBudget` short-circuits classify and generateReply to fallback paths when daily spend exceeds `DAILY_LLM_BUDGET_USD`. One-time over-budget alert to owner via the window-scan cron. Pricing per million tokens (cents): haiku in 80/out 400/cache_read 8/cache_write 100; sonnet in 300/out 1500/cache_read 30/cache_write 375.
- **Template voice aligned.** Both `templates/owner_hourly_report_en.json` and `templates/follow_up_24h_en.json` now say "Electro-Sun team" instead of "Sunny" (brother's foundation doc forbids the name).
- **FALLBACK_CLASSIFICATION updated** in `src/claude.js` from old `category=explorer` to new C1-C5 framework: `category=unsorted`, `lead_temperature=COLD`, `client_type=unknown`, `escalation_type=silent_query`. Plus generateReply context block now includes `client_type`, `lead_temperature`, `products_asked_about`, `brand_preference`, `budget_mentioned`.
- **Admin web UI** at `/admin` (commit `77507ae`). Single-page HTML+JS+CSS, dark theme, two-pane layout (conversation list + message thread). Login with `API_KEY` from `.env`, stored in localStorage. Endpoints: `GET /api/inbox`, `GET /api/conversations/:id`, `POST /api/conversations/:id/{handle, release, send-reply}`, `GET /api/queries/pending`, `GET /api/budget/today`. Filter tabs (All / Pending / HOT / WARM / Human / C2 / C3 / C5). Take-over and Return-to-agent buttons; a manual reply auto-marks the conversation `human_handled` so Sunny stops auto-replying there. New columns on `conversations`: `human_handled`, `human_handled_at`. Handler skips Sunny processing when `conversation.human_handled` is true.
- **Product catalog injection** (commit `19ce347`). New file `src/knowledge/products.json` with 8 Deye inverters and 2 Deye batteries at confirmed NGN prices. `src/claude.js` loads at module init, injects formatted catalog into Sonnet's system prompt as a third cache_control: ephemeral block. Classifier updated: pricing on these specific Deye products does NOT escalate (agent has the answer). Other brands still escalate.
- **No-hedge rule + multi-option rule** (commits `19ce347`, `ffcaac6`). System prompt: never say "let me check and get back" type phrases. Always share what you know in the same reply. For open questions (sizing, choice, "how much"), offer 2-3 concrete options the customer can evaluate, each with prices from the catalog when relevant, with a clarifying question to help them pick.
- **No-repetition rule** (commit `19ce347`). System prompt: read the FULL conversation history before each reply, never repeat own prior phrases, never re-ask answered questions, build on prior turns. Conversation history limit bumped from 20 to 50 messages.
- **Specialist direct link** (commit `4737584`). Optional wa.me click-to-chat link appended to escalation holding replies. Configured via `SPECIALIST_DIRECT_LINK` env var (digits only, no plus sign). When set, customers hitting a HOT lead or silent_query also get a tap-to-chat link with a pre-filled context message. When unset, no link is appended (default off). Trade-off: link breaks Sunny's conversation continuity but offers immediate human-route for genuinely critical cases.
- **Tightened over-escalation** (commit `7167de5`). Classifier escalation rules now require Electro-Sun specific facts (exact price, current stock, specific install date, complaints, warranty claims, custom designs). General questions about how solar works, brand context, sizing, market price ranges, segment confirmations are answered, NOT escalated. Plus enriched system prompt with general industry knowledge (brand overviews, typical Nigerian household sizing, install timeline norms) and concrete example dialogues from foundation doc Section 4 verbatim.

**Open items the brother explicitly left blank** in Section 11 of the foundation doc, must answer before production launch:
- Reference WhatsApp number for escalations (currently `OWNER_WHATSAPP=966502392650` is Serge's; needs swap to brother's actual number for go-live).
- Working hours (24/7 or specific?). Affects after-hours fallback.
- Greeting opener variations (one fixed or 2-3 to rotate?).
- Location-specific tags (Lagos, Abuja, Port Harcourt, Kano, Ibadan?).
- Currency: NGN only or also USD for installers / regional?
- Default delivery and installation policy lines.
- Default warranty messaging.
- Competitor pricing doctrine (beat / match / justify / walk).
- After-hours auto-reply text.
- Pricing data: Deye 12kW, Sungrow 50kW, JA 550W, etc. Until provided, every C2 inquiry triggers silent_query escalation to the brother.

**Owner teaching loop shipped 2026-05-04:**
- New table `knowledge_entries` (id, source_message, extracted_fact, category, confidence, status, created_at, approved_at, rejected_at).
- New file `src/knowledge.js`: `extractKnowledge()` calls Haiku with `src/prompts/teacher.md`, returns `{facts:[{category, text, confidence}], reply_to_owner}`. Helpers for add/list/setStatus/edit/delete/formatForPrompt.
- New prompt `src/prompts/teacher.md`: turns owner DMs into structured facts. Categories: pricing, policy, product, sales, operations, warranty, customer, correction, other. Confidence < 60 triggers a clarifying question instead of save.
- `src/handler.js`: any text message from `OWNER_WHATSAPP` that is NOT a reply to a `[QID:N]` alert is now routed to `handleOwnerTeaching()`. Sunny extracts facts (auto-status `active`, only saved if confidence >= 60), persists them, and WhatsApps the owner a confirmation. If no facts (greeting, casual chat), still replies appropriately.
- `src/claude.js > generateReply` now injects a fourth `cache_control: ephemeral` block with all active knowledge facts, grouped by category. Sonnet treats them as authoritative and overrides earlier general guidance if they conflict.
- Admin UI: new **Knowledge** tab with status/category filters, manual fact entry, and per-card buttons (Edit / Approve / Reject / Delete). Each card shows the extracted fact, confidence pill, category pill, status pill, original source message (truncated), and the timestamp.
- API endpoints: `GET /api/knowledge`, `POST /api/knowledge`, `POST /api/knowledge/:id/status`, `POST /api/knowledge/:id/edit`, `DELETE /api/knowledge/:id`.
- Workflow: owner WhatsApps Sunny "Working hours are 9 to 6 Mon-Sat" → Haiku extracts {category: policy, text: "Working hours are 9am to 6pm Mon-Sat, closed Sundays.", confidence: 95} → saves as active → Sunny replies "Got it: working hours 9am to 6pm Mon-Sat. Logged. Anything else?" → next customer asking about hours gets the answer.

**Image support shipped 2026-05-04:**
- WhatsApp images now flow through the full pipeline (download from Meta media API → save to volume → classifier sees text hint → Sonnet sees the actual image as a vision input → reply).
- `src/whatsapp.js > downloadMedia(mediaId)` does the two-step Meta download (metadata GET → signed URL GET with auth, 25MB cap, 30s timeout).
- `src/handler.js`: `extractMessages()` now picks up `msg.type === 'image'` with caption, mime, and sha256. `handleInbound()` downloads, base64-encodes, saves to `MEDIA_DIR`, and threads the bytes into `generateReply(history, message, contact, attachments)`.
- `src/claude.js > generateReply` accepts an `attachments` array. When present, the last user message becomes a multi-block content array with `image` blocks before the text. Sonnet 4.6 vision handles it.
- `src/memory.js > appendMessage`: new `media_path` and `media_mime` meta keys persist the local file path so the admin UI can render the image later. `getMessagesForConversation` now returns both columns.
- `db/init.js`: idempotent migration adds `messages.media_path` and `messages.media_mime`.
- `MEDIA_DIR` env var: defaults to `<DB_PATH dirname>/media` (so on Railway, images land in `/data/media/`). Documented in `.env.example`.
- Classifier still text-only by design (sees `[Customer sent an image with caption]: <text>` or `[Customer sent an image with no caption]`). Cheap, fast. If image-only messages prove hard to classify, switch to vision-Haiku later.
- Use cases unlocked: roof photos, inverter labels, meter readings, payment screenshots (HOT escalation), warranty damage photos.
- Cost: ~$0.01-0.03 per image on Sonnet vision. Daily budget tracker already in place.
- Storage: ~200KB avg image, ~200MB/month at 1000 images. Volume is 1GB on Railway, so plenty of runway.

**Phase 5 cloud deploy DONE 2026-05-04 (Railway):**
- `db/init.js`: `DB_PATH` env-overridable, auto-creates parent dir.
- `railway.json`: Nixpacks, `npm start`, /health check with 30s timeout, restart on failure up to 5.
- `.env.example`: documents `DB_PATH`.
- `DEPLOY.md`: full Railway guide.
- `scripts/print_railway_env.js`: produces the Railway env-var block from `.env` with cloud overrides (`DB_PATH=/data/sunny.db`, `LOG_TO_FILE=false`, `META_WABA_ID=1713234916358524`). Pipes cleanly to `pbcopy` so secrets never hit the chat transcript.
- **Live URL:** https://sunny-electrosun-production.up.railway.app
- **Volume:** `sunny-electrosun-volume` mounted at `/data`, holds the SQLite DB at `/data/sunny.db`. Persists across redeploys, restarts, and 7 days after detach. Railway also auto-backs up volumes.
- **`/health` verified:** HTTP 200, JSON `{status:"ok",uptime_seconds:N,timestamp:...}`.
- **Project on Railway:** project name "ample-laughter" (auto-generated), service "sunny-electrosun", environment "production", region us-west2, 1 replica.
- **Trial vs. Hobby:** Railway showed "30 days or $1.00 left | Limited Trial" banner during setup. Serge said he subscribed to Hobby; verify the subscription is actually active in Settings → Billing or the service will pause in 30 days.
- **PM2 + cloudflared retired** for production. Local dev still uses cloudflared if needed for testing webhooks against local code, but production traffic now runs through Railway's stable HTTPS URL.

**Resume plan (current as of 2026-05-04 evening Beirut):**

PUSHED but PENDING USER ACTION:
1. **Push the latest commits.** `git push` from Serge's Terminal. Last local commits: `4eb07fe` (behavior fixes + dedup + cleanup script), `3a2ca80` (admin WhatsApp redesign), `55166a2` (avatar initials + inline timestamps). Railway redeploys automatically.
2. **Run `node scripts/cleanup_past_quotes.js`** AFTER push to retire ~50 noisy "Past quote" pricing facts from the legacy import. They stay in audit but no longer feed Sunny's prompt. Costs are now sourced from the catalog only.
3. **Hard refresh `/admin`** (Cmd+Shift+R) to bypass cached old CSS for the new WhatsApp-style UI.

WAITING ON BROTHER:
4. **Brother's pricing data** for Sungrow, JA panels, Longi, etc. (whatever isn't in the catalog yet). Add via admin Catalog tab or by feeding a spec to a new seed script.
5. **Brother's Section 11 decisions** still blank from foundation doc:
   - Working hours (24/7 or specific hours)
   - Greeting opener variations (one fixed or 2-3 to rotate)
   - Location-specific tags (Lagos, Abuja, Port Harcourt, Kano, Ibadan)
   - Currency: NGN only or also USD for installers / regional
   - Default delivery and installation policy lines
   - Default warranty messaging
   - Competitor pricing doctrine (beat / match / justify / walk)
   - After-hours auto-reply text
6. **Brother's real WhatsApp business number** (Task #17 full). Right now the test number `+1 555 172 6906` is in use; once brother provides ElectroSun's actual line, swap `META_PHONE_NUMBER_ID` on Railway and re-verify the webhook.

USER-DRIVEN:
7. **Task #15: 48-hour soak** with 3-5 testers on the current test number. Captures real conversation patterns to feed the daily learning loop and surface gaps.
8. **Task #19 templates**: re-check Meta approval status in 24-48h via `node scripts/check_templates.js`. If rejected, read `rejected_reason` and re-submit.
9. **Verify the next 2-hour cron** (every even hour Beirut) lands on brother's phone, not Serge's. The 4 PM Beirut cron landed on Serge — likely stale container; needs verification.

CODE NICE-TO-HAVES (not blocking launch):
10. **Hot-lead alert with conversation summary** (a small Haiku synthesis call to enrich the brother's RED alert; Section 9.1 of foundation doc).
11. **Approve-to-permanent learning loop** (admin UI button on daily learning items to convert into permanent fact).
12. **v2 daily learning sections** ("New patterns with draft replies", "Internal questions I have").
13. **Knowledge file expansion**: brother to send remaining 14 categories (installation pricing, service area, warranty, payment terms, common objections, past projects, real conversation samples, working hours, holidays, compliance). Each new fact via admin Knowledge tab or via a new seed script.
14. **Cleanup `scripts/seed.js`** (still has old category names).
15. **Re-enable owner teaching from WhatsApp** with a cleaner intent disambiguation (today brother's WhatsApp messages always go to Q&A mode; teaching is admin-only).
16. **RAG-style fact retrieval** instead of always injecting all active facts. With ~500 facts cap today, fine; if knowledge base grows, switch to per-message semantic search.
17. **Avatars: per-contact color hashing** so different contacts get visually distinct avatar discs (currently all green).
18. **Image inline rendering in admin** (`media_path` is stored; admin doesn't yet render the image inline).

**Hard rule reminder:** before recommending or relying on a remembered fact (file path, function, key, URL), verify it still holds. Quick-tunnel URLs are stale-by-design; the Meta webhook config will need redoing next session if cloudflared was restarted.

