# Sunny session-by-session history

Chronological changelog of Sunny development sessions, extracted from CLAUDE.md on 2026-05-05 to keep the always-loaded working memory tight. Each session below is dated and appears in reverse chronological order (most recent first). Cross-reference commit hashes against `git log` for the actual code.

## 2026-06-08 Beirut — emoji reactions stop the "type your question" nag

Owner sent a screenshot (Babajide Samson Daramola) showing two `UNSUPPORTED_TYPE` inbound rows labelled `[unsupported_reaction]`, each answered by Sunny with the canned `UNSUPPORTED_REPLY` ("This number receives text messages only. Please type your question and the team will respond."). The customer had simply tapped an emoji reaction (WhatsApp long-press 👍/❤️/🙏) on one of Sunny's messages, right after Sunny told him "No problem, take your time." A reaction is a passive acknowledgement, not a question, so nagging him to "type your question" made Sunny look broken and pushy. He reacted twice, so he got nagged twice.

Root cause: `extractMessages` in `src/handler.js` only recognised `text` / `image` / `audio` / `voice`; everything else (including `type: 'reaction'`) fell into the `else` branch and was tagged `kind: 'unsupported'`, which the dispatch loop routed to `handleUnsupported` -> the canned reply.

Shipped (commit `9994adc`, pushed, Railway auto-deploy):

1. **Reactions are recognised and ignored.** `extractMessages` now tags `msg.type === 'reaction'` as `kind: 'reaction'`, capturing the emoji (`msg.reaction.emoji`) and the id of the message it was applied to (`msg.reaction.message_id` -> `reactedToId`). New `handleReaction(msg)` persists the reaction as an inbound row (`[reacted: 👍]`, intent `reaction`, with `reacted_to_wamid`) and logs a `reaction_received` event, then returns WITHOUT replying. The dispatch loop routes `kind: 'reaction'` ahead of the `unsupported` branch, so owners reacting to alerts also stop getting the nag. Genuinely unsupported types (stickers, location pins, documents, contacts) still get the "text only" reply, unchanged.

2. **Admin renders reactions as a bubble badge, not a standalone bubble.** New `messages.reacted_to_wamid` column (idempotent migration in `db/init.js`) links a reaction to its target; `memory.js` `appendMessage` stores it and both message queries select it; the contact-view query uses `m.*` (already covered) and the Owner Chat query (`api/dashboard.js`) was extended to return `whatsapp_message_id` + `reacted_to_wamid`. In `public/admin.html`, a new `renderMessages(msgs)` helper (replacing the two `msgs.map(msgHtml)` call sites: inbox + Owner Chat) folds reactions onto the target bubble as a WhatsApp-style `.reaction-badge` pill (bottom corner, right for outbound / left for inbound). Last reaction wins per target (handles changing the emoji); a removed reaction clears the badge; a reaction whose target is outside the loaded window falls back to a subtle centered `.reaction-note` ("Reacted 👍 to an earlier message") so it isn't lost.

Verification: `node --check` on all four touched JS files, `node db/init.js` applied the migration locally, `npm test` 55/55 green, admin.html inline script parses (vm check), and a standalone simulation of `renderMessages` confirmed the change-emoji / removal / orphan cases.

### Same-day inbox audit + two reply-quality fixes (commit `6a7a427`, pushed)

Used the systematic-debugging + TDD skills to audit all 34 customer threads from today's inbox (pulled live from production via `/api/inbox` + `/api/conversations/:id`, owners conv 43/2461 excluded). Confirmed the reaction fix is live and working (conv 2593 reacted 🙏🏼 at 09:01 UTC, after the ~08:23 UTC deploy, and Sunny stayed silent; the two nags in conv 2550 were at 21:49/06:57 UTC, before the deploy). Found and fixed two HIGH-severity reply bugs:

1. **Price-strip garble (10 instances across 9 leads today).** The price-dump guard in `src/claude.js` strips a price the customer did not ask for (the Click-to-WhatsApp ad opener "I'm interested in the LONGi 650W panels" has no price keyword), but the dangling-fragment detectors missed two shapes, so the fragment shipped to customers: "**Available, per panel.**" (8 leads: 2489/2579/2580/2584/2588/2598/2603/2608) because a COMMA preceded "per" and the clause-start class only allowed `. ; : ! ?`; and "**available at, which could work**" / "**at would do the job**" (conv 2597) because an orphaned preposition with no number was not covered. Fix: extracted the dangling logic into `detectDanglingFragment(stripped)` (exported from `src/claude.js`, unit-tested), added a comma to the per-unit clause-start class and two `prep_orphan` detectors. "looking at, Saheed?" (conv 2602) still passes clean because "looking" is not a price-introducing word. End-to-end simulation: all three real garbles now fall back to the generic "Could you share more about your project" line.

2. **Nonsensical stall ack (3 leads).** The stall guard's last-resort fallback in `src/handler.js` was hard-coded to "Noted. Will share the figure once confirmed." even when no figure was in play, e.g. conv 2599 where the customer asked "Is anyone here to respond?" New `buildStallFallbackText(contextText)` keeps the figure phrasing only for genuine price context (`how much`, `price`, `N pcs`, etc.) and returns a neutral "Noted, the team will get back to you on this shortly." otherwise; the fallback now passes the real open-query / customer text as context.

New `test/reply_guards.test.js` (11 cases) covers both. Suite 66/66 green.

### Routing audit + R1/R3/R2/B-#2 fixes (commit `21db3dc`, pushed)

Cross-checked today's escalations against what Sunny actually sent each Patrick/Charbel/Abuja/Lagos thread (`/api/queries/pending` + `/api/owner-chat?label=`). Found that multiple non-big-project leads landed on PATRICK instead of the regional desks (ken stone 30pcs Abuja, Lanre "is anyone here", Salvage 500 reseller), violating the finalized "owners handle big projects only" rule. Afternoon region-known leads (▫️, Chinedu) routed correctly to the Abuja desk, so the wiring works; the gaps were specific:

- **R1 (HIGH):** the **stall-guard escalation** path (`handler.js`) called `notifyOwnerForEscalation` directly and never checked gather-first, so a region-unknown stall fell straight to the general owner via `region_unknown_fallback`. The classifier escalation path was already gather-first-guarded; the stall path was not. Fix: the stall guard now checks `ownerRouting.routingInfoSufficient(classification)` and, when insufficient, defers (sets `deferred_handoff`) and regenerates with `buildGatherFirstContext` ("Abuja or Lagos?") instead of pinging the owner.
- **R3 (MEDIUM):** a presence/impatience check ("Is anyone here to respond?", conv 2599) tripped the stall guard, escalated to Patrick, and got a reply about a non-existent "figure". New `isPresenceOrImpatienceCheck(text)` (exported, unit-tested) short-circuits the stall guard with "Yes, I'm here. How can I help you with your solar needs?" and no escalation.
- **R2 (MEDIUM):** 253 stale `pending_queries` going back to May 8, because the `window_monitor` auto-expiry was gated behind `DISABLE_NOTIFICATIONS=true`. Stale open rows suppress fresh routed alerts (the open-pending → follow-up-ping branch in `notifyOwnerForEscalation`) and inflate the open-query count. Fix: `runWindowScan({ silent })` expires stale queries WITHOUT owner pings; `server.js` now registers the window-scan cron ALWAYS (silent when notifications are disabled). The May backlog clears quietly on the next scan.
- **B-#2 (MEDIUM):** bulk detection missed "30pcscof" (conv 2592 ken stone, a typo for "30pcs of") because `BULK_ORDER_RE` required a trailing `\b` after the unit. Added `BULK_ORDER_GLUE_RE` for the low-collision units (pcs/pieces/units/panels/modules) when followed by letters; `detectBulkQuantity` (now exported + unit-tested) tries both. "30 setup" and the ad opener "650W panels" still return 0.

`test/reply_guards.test.js` grew to 23 cases (presence + bulk groups added). Suite 74/74. Verified the routing decision end-to-end: a region-unknown SERIOUS lead now returns `routingInfoSufficient=false` (gather city), a known-Abuja daily lead routes to `abuja`.

**Still NOT fixed (needs live-log instrumentation, not a guess): B-#1 double/triple replies** to one logical turn (~14 cases today, some contradictory, e.g. conv 2580 "share more about your project" + "will share the figure"). Root cause is a debounce-window vs burst-typing timing issue (the 6s window is shorter than the gap between the ad's auto-message and the customer's quick follow-up), plus the welcome-card path, plus occasional same-batch double-fires the repeat-guard masks ("Apologies, let me re-read your last message."). A safe fix needs per-contact batch enqueue/fire/reply timestamps logged first to see exactly where the doubles originate. **Instrumentation now in place (commit `76b00cd`, logging only):** every fired debounce batch logs `handler.batch.fired` (with `batchId`, `queue_size`, `gap_since_last_fire_ms`, first/last message previews) and `handler.batch.completed` (with `duration_ms`). Reading these on live traffic will show whether a 2nd reply came from a second batch firing (debounce-vs-burst) or one batch double-sending, which decides the fix. Minor doctrine drift also noted but not fixed: conv 2597 invented "See you tomorrow", conv 2489 computed a bulk total against the no-invented-totals rule.

## 2026-06-07 Beirut — post-routing audit + four owner-facing fixes

Day after the 4-number owner-alert routing went live (`96a8e0b`). Owner sent screenshots with observations. Audited yesterday's routing work first: all 44 unit tests green, three-tier inbound recognition correctly wired into `handleInbound` (alert-only desks ignored, full owners get reply-relay + Owner Q&A, everyone else is a customer), recipient resolved once after throttles, no stale `OWNER_WHATSAPP ===` comparisons left behind, routing falls back to the general owner everywhere a number is unset. Core pipeline intact; routing is purely additive. Then shipped four fixes (NOT yet committed/pushed; Serge pushes manually):

1. **Garbled price-strip reply ("...is per panel").** Root cause: customer typed "Depends on the proce" (typo, no price-ask keyword), so the price-dump guard in `src/claude.js` stripped "165,000 NGN" from "...monofacial is 165,000 NGN per panel, available" and shipped the dangling "...is per panel, available". Added two new dangling detectors to the strip guard: `per_unit` (orphaned "is/at/of/for per <unit>" or a clause now starting "per <unit>") and `copula` (a bare "is/are/was/were/costs/priced/sells" immediately before punctuation, e.g. "is, available"). Both are precise: they only run after a price was actually stripped, and a valid strip that leaves real content ("...is 7.68kWh, available") does NOT misfire. On a hit the reply falls back to the generic "Could you share more about your project..." instead of gibberish.

2. **Customer "Direct line to the Sales Manager" now points at the routed recipient.** Was always `SPECIALIST_DIRECT_LINK` (Patrick). `notifyOwnerForEscalation` now returns `recipientNumber` + `recipientLabel` (resolved once, after throttles). `buildSpecialistLink(customerMessage, overrideNumber)` takes the routed number; the HOT link-append uses `escResult.recipientNumber`, falling back to `SPECIALIST_DIRECT_LINK` when no recipient was resolved this turn. The handoff-in-reply backstop now also surfaces its `handoffEsc` recipient onto `escResult` so a reply-text-detected HOT still gets the right number. So an Abuja-routed HOT lead gets the Abuja sales number, Lagos gets Lagos, big-project gets Charbel/Patrick per the round-robin.

3. **Owner-alert brief is a real 2-phrase summary even when `owner_brief` is null.** The screenshots showed the generic fallback "Customer needs a team answer on: their enquiry" because `classification.owner_brief` was null (force-promoted HOT via commitment phrase, or synthetic stall-guard/photo classifications, never carry it). `ownerBriefLine(classification, customerMessage)` in `src/owner_alert.js` now, when `owner_brief` is absent, builds `Customer asked: "<real message, truncated 180>". Needs a team answer on <intent topic>.` from the actual inbound text. `buildOwnerAlertText` gained a 4th `customerMessage` arg; both callers in `handler.js` (main alert + follow-up ping) pass it. Classifier `owner_brief`, when present, still wins.

4. **Owner Chat tab shows all four routed numbers.** New `configuredRecipients()` in `src/owner_routing.js` returns Patrick / Charbel / Abuja Sales / Lagos Sales (only desks whose env number is set and distinct from Patrick's, deduped). `/owner-chat` accepts `?label=` and returns `{ contact, messages, recipients, active_label }`. Admin `public/admin.html` Owner Chat tab renders a pill tab-bar (one per recipient, with the number), switches threads on click, keeps the active label across the 15s auto-refresh, and updates the header name/phone per selection. Tab bar hides itself when only one recipient is configured.

Tests: added 3 owner_alert cases (message-fallback summary, brief-wins-over-message, long-message truncation) and 3 owner_routing cases (all-four, unset-desk-omitted, dup-deduped). Suite now 50/50 green. All touched modules load; admin.html inline script parses (vm check). Committed `50b7e81` + `b4604b1` (snapshot), pushed.

**Same-day follow-ups (commits `4218041`, `f16bfd6`, `81a8b4f`, pushed):**

5. **Header "242 pending" badge replaced with today's HOT leads** (`4218041`). The all-time open-pending-query count was stale and not actionable. `buildStats` now returns `hot` (contacts with HOT category or lead_temperature, active in the window); the header fetches `/stats/today` and renders "N hot". Dropped the dead `/queries/pending` header fetch + `pendingQueries` global. Inbox "Pending" filter is unaffected (uses per-conversation `pending_queries_count`).

6. **Owners/sales excluded from lead stats** (`f16bfd6`). Bug: Charbel (a configured owner) was reported to the owner in the Owner Q&A snapshot as a SERIOUS+HOT lead in Abuja, and counted in hot-lead figures. Team numbers that messaged Sunny before being configured carried stale customer-lead rows. New `teamPhoneDigits()` in `owner_routing.js` (the four owner/sales numbers, deduped, digits-only); the Owner Q&A snapshot (hot-lead count + list, warm, recent contacts, recent escalations) and the new hot badge now exclude them. Test added (52 total then). Note: the stale contact rows still exist; the fix filters at query time so the owner never sees a colleague as a lead.

7. **Bulk-request stonewall loop fixed; quote unit price + Sales Manager** (`81a8b4f`). Bug (Lanre Ajeigbe screenshot): "650W Longi, I need up to 34 units" with no literal price word. The no-proactive-price strip nuked Sunny's quote, the leftover became the generic "could you share more about your project", the customer repeated, the duplicate guard turned it into "let me re-read your last message" -> infinite loop on a ~22kW buyer. Owner directive (asked + answered this session): a product + multi-unit quantity IS a price ask. `claude.js` PRICE_ASK_RE now treats quantities ("N units/pcs/panels", "up to N", buy/order/purchase) as a price ask so the unit price survives the strip. `handler.js` added `detectBulkQuantity` + a `bulk_order` escalation type: a non-HOT product+quantity request escalates (owner alerted, routed), bypasses gather-first (product/scale already known), uses `buildBulkOrderContext` (quote per-unit price from warehouse, offer Sales Manager for the bulk price, no invented totals/discounts), and appends the routed Sales Manager direct line. `system.md` got a matching bulk-quantity pricing rule. Threshold is quantity >= 2 (tunable).

**Alert-desk decisions + generic ack.** Owner confirmed (a) Abuja/Lagos sales desks stay ALERT-ONLY (no reply-relay, no Owner Q&A; only Patrick/Charbel converse), and (b) keep FREE-FORM alert delivery for now (NOT the Meta template). Operational caveat: each desk must keep its 24h window open (message Sunny periodically) or routed alerts are silently dropped by Meta. "No alert reached the desks" is expected unless a daily-sales lead (<=20kW, <=15M, not HV) with a stated Abuja/Lagos region escalated; otherwise it falls back to Patrick.

**URGENT routing bug: escalating leads were dumped on the general owner instead of the regional desks.** Live-log diagnosis (Adeyato, contactId 596): a "Deye 6kW, can I pay half deposit" lead was force-promoted to HOT by the commitment-phrase safety net (`classifier.commitment_phrase_force_promoted_to_hot`), but `owner_routing.resolved` showed `reason:"not_serious_or_hot"`, `routing_category:null`, `routing_region:null` -> routed to Patrick (`8055`). Root cause: `isSeriousOrHot` keyed ONLY on `classification.category`, which the force-promotion leaves COLD (it sets `lead_temperature=HOT` + `escalation_type=hot_lead`). So gather-first never asked the city and routing fell through to the general owner, for EVERY force-promoted HOT and most escalating-but-not-HOT-category leads. The desks got nothing. Fixes in `owner_routing.js`: (1) `isSeriousOrHot` is now signal-based (category HOT/SERIOUS, OR lead_temperature HOT/WARM, OR escalation_type in hot_lead/bulk_order/negotiation/big_project/repeat_complex); (2) `decideRecipient`/`hasRoutingInfo` treat an UNKNOWN routing_category like daily (route by region) so a clearly-regional sale isn't stranded by the classifier leaving routing_category null; (3) `decideRecipient`/`resolveRecipient` now forward `lead_temperature` + `escalation_type` into the decision (they were being stripped before the isSeriousOrHot check). `handler.js` `buildGatherFirstContext` now asks the city whenever region is unknown (not only for an explicitly-daily category). Net effect: a force-promoted HOT 6kW Lagos lead now asks "Abuja or Lagos?", then routes to Lagos Sales on the answer. Tests: +4 (force-promoted-HOT regression, unknown-category-with-region, bulk_order-serious, hasRoutingInfo-region); suite 54/54.

**Owner now gets BIG PROJECTS ONLY; all small leads/inquiries go to the regional desks.** Owner saw small leads (a `silent_query` pricing question "what of 590xw", a daily HOT) land on Patrick. Root cause: routing only sent HOT/SERIOUS to the desks; everything else (silent_query, pricing, dealer, COLD) hit the `not_serious_or_hot` -> general-owner fallback in `decideRecipient`. Owner directive (hard): owners (Patrick/Charbel round-robin) handle ONLY big projects; every other escalation routes to the Abuja/Lagos desk by region, regardless of temperature or escalation type. Changes: `decideRecipient` dropped the `isSeriousOrHot` gate (big_project -> owners; else -> regional desk; region-unknown -> last-resort `region_unknown_fallback` owner, which gather-first should prevent); `routingInfoSufficient` is now just `hasRoutingInfo` (any escalation lacking region+category must gather the city); `handler.js` gather-first no longer requires `isSeriousOrHot`, so a pricing/silent_query lead with no city is asked "Abuja or Lagos?" instead of dumped on the owner. A delivery-status logger (`whatsapp.delivery.status`/`.failed`) was also added so `send.ok` (Meta accepted) is distinguished from actual delivery (the 24h-window silent drop shows as a failed status). Tests updated + added; suite 55/55.

**Owner Q&A status replies made smarter + shorter.** The "any important updates?" reply was a long report: "85 inbound, 108 outbound, 22 new contacts", a list, and "242 pending queries dating back to May 6". Owner wants the pulse of TODAY: how many customers reached out, how many are hot today, no message-volume counts, no stale all-time pending backlog. `owner_qa.js` snapshot: added `customers_reached_out` (distinct customers who messaged today, team excluded), renamed to `hot_leads_today` / `warm_contacts_active_today`, and REMOVED `inbound`/`outbound`/`pending_queries` (the 242) from the `today` block (raw counts + backlog stay queryable from admin, just not surfaced in updates). `owner_qa.md`: new "Status / update questions" section, lead with "N customers reached out today, M went hot", list only today's hot leads (max 5), never report message volume, never volunteer the pending backlog, today-only, under 60 words.

**Voice notes verified WORKING.** Live logs show `transcribe.ok` HTTP 200 with real transcripts; the OpenAI key is valid. The "[Customer sent a voice note that could not be transcribed]" the owner saw was a clip Whisper returned EMPTY for (`transcribe.ok {"chars":0}` -> handler treats empty as a fail). Cause is clip-level (very short / silent / possibly non-English under the `language=en` pin), not a system outage.

**Contact-number requests now region-routed (code).** Screenshot: a Lagos customer asked "phone number to contact please" and Sunny replied "For our Lagos office, you can reach: Patrick: 07041328055". Wrong on every axis: Patrick is the big-deal OWNER (Cat-2 round-robin with Charbel), not a regional desk; there is no Lagos number in any customer-facing content (the welcome card lists only the Abuja owner contacts); and it was mislabeled "Lagos office". The number leaked because the LLM pulled Patrick from the welcome card in history (the owner-number-leak guard only matches the full 234... form, not local 07041...). Owner directive: a contact request gets the REGIONAL SALES desk as a WhatsApp link only. New deterministic fast-path in `handler.js`: `CONTACT_REQUEST_RE` + `resolveContactRegion` (routing_region -> message/location fallback) + `buildContactReply` -> Lagos => `wa.me/<SALES_LAGOS_WHATSAPP>`, Abuja => `wa.me/<SALES_ABUJA_WHATSAPP>`, unknown => ask which city. Never an owner number. Skipped for HOT (HOT handoff already appends the routed Sales Manager link) and greetings; bypasses the LLM + wa.me-strip guard so the link survives. The welcome card was NOT touched (owner instruction).

Then the owner noticed a desk's own messages to Sunny did not appear in the admin at all. Cause: the alert-only branch dropped inbound with a bare `continue` BEFORE persisting, so nothing was saved and no reply sent (a black hole). Fix (code): new `handleAlertOnlyMessage(msg)` persists the desk's inbound (intent `alert_desk_inbound`, visible under the desk's Owner Chat tab) and sends a generic, throttled (1/hour/desk) ack (`ALERT_DESK_ACK`, intent `alert_desk_ack`) that takes no instruction. Still no relay, no Owner Q&A, no classification. Owners/sales remain excluded from lead stats via `teamPhoneDigits()`, so persisting the desk contact does not pollute the hot/lead figures. Minor known side effect: the desk conversation also appears in the customer Inbox tab.

**Region source hardened (two follow-ups).** (a) `8f5017b`: the classifier is unreliable at extracting `routing_region` ("pick from abuja" came back null, so a HOT lead deferred instead of routing). Added a code-level region backfill before the routing decision: if the classifier left the region unknown, read it from the message text. (b) `a29d721`: the backfill initially reused `resolveContactRegion`, which falls back to the contact's STORED location, so a returning test number with `location=Abuja` made a Lagos-less deal route to Abuja Sales. Fixed: the routing backfill now uses CURRENT-conversation text only (`detectRegionInText` over the current message + recent customer turns), never `contact.location`. Also removed the `!isBulkOrder` exclusion from gather-first, so a bulk (or any) escalation with unknown region asks "Abuja or Lagos?" instead of guessing or going to the owner. Net rule: Sunny routes to a regional desk only when the current deal states the city; otherwise it asks. Live tip after this session: `a29d721` (confirmed via `/version`).

**Telegram phone-to-session bridge (operational, not code).** Owner wanted to send notes from his phone into the Claude Code session. The mechanism is the built-in Telegram channel (`/telegram:configure` + `/telegram:access`), bot "ClaudeCodeBot". Diagnosed a half-paired state: the owner's ID `5083579788` was in `allowFrom` but the `approved/<id>` binding file (holding the chatId) was missing, so the bot kept replying "to pair" and never bridged. Cleaned up (removed + re-paired with code `8f3789`); now `allowFrom:["5083579788"]` + `approved/5083579788` exist and the bot confirmed "You're in". Remaining gotcha: `/reload-plugins` restarts the bridge process but does NOT wire message injection into an already-running session, so DMs still did not surface; a FULL session restart (quit + `claude` again in the project dir) is required for the bridge to bind to the session. Pairing persists across restart. For a 1:1 Telegram DM, chatId == userId.

## 2026-06-01 Beirut — inbox-only team login (second restricted role)

Owner wanted to give one team member access to the **Inbox tab only**, with his own username + password, and keep them out of the rest of the admin (prices, warehouse, contacts, prompts, owner chat). Built a real second role, server-enforced, not just UI hiding.

What shipped (commit `d3ed314`, pushed + deployed):
- **`server.js`**: new public `POST /inbox-login` (validates `INBOX_USER`/`INBOX_PASSWORD` env, returns `INBOX_API_KEY` + `role:'inbox'`; in-memory throttle of 8 attempts / 10 min / IP; 503 when the three env vars are unset). New `GET /inbox` route serves the same `admin.html`.
- **`api/dashboard.js`**: auth middleware now tags `req.role`. Master `API_KEY` => `admin` (unchanged, full access). `INBOX_API_KEY` => `inbox`, allowed ONLY on a whitelist (`/whoami`, `/inbox`, `/stats/today`, `/queries/pending`, `/conversations/:id`, `…/handle`, `…/release`, `…/send-reply`); every other endpoint returns 403. New `GET /whoami` returns `{role}`.
- **`public/admin.html`**: login card gained a Username field. Username filled => exchanges username+password at `/inbox-login` for the inbox key; blank => the password field is the master API key (admin path, as before). After login the page calls `/whoami`; for `role==='inbox'` it hides every nav tab except Inbox and the budget badge, and forces the inbox view (`applyRole()`). `refreshAll()` skips the budget call for the inbox role (not whitelisted). Role persisted in `localStorage` (`electrosun_admin_role`).
- **Env**: `INBOX_USER`, `INBOX_PASSWORD`, `INBOX_API_KEY` documented in `.env.example` + CLAUDE.md. `INBOX_API_KEY` must differ from master `API_KEY`. Leave all three blank to disable the feature.

Live values (set on Railway `Electrosun-Agents`/production/`sunny-electrosun` this session via CLI): `INBOX_USER="Electrosun User"`, `INBOX_PASSWORD=PwUsLJ3j2Ak0wb`, `INBOX_API_KEY=inbox_2853...fef4f5b`. Owner had tried setting them earlier but they hadn't reached this service (prod returned 503 "inbox login not configured"); re-set from the linked CLI fixed it. Credentials handed off in a Desktop doc `~/Desktop/ElectroSun-Access-Credentials.md` (outside the repo, not committed).

Verified end-to-end against production after redeploy: correct login => role inbox; wrong password => 401; inbox key => 200 on `/api/inbox` but 403 on `/api/warehouse` and `/api/contacts`; admin key still full access. Local: `node --check` on all three files passes, inline admin.html script extracted + checked, `npm test` 18/18 green.

Caveat recorded for the owner: this is a single shared username/password for one trusted staffer, not a multi-user system with per-person accounts or audit logs. A larger named-users build was scoped as a separate future task. Password + inbox key are visible in the chat transcript; rotate `INBOX_PASSWORD` on Railway anytime (no code change).

## 2026-05-30 Beirut — phase-aware datasheet/photo matcher

Owner screenshot: a customer asked for the "12kw 3 phase" datasheet and Sunny sent the single-phase sheet (Deye SUN-12K-SG02LP1, file `...SUN-12-16K-SG01LP1...pdf`), then doubled down claiming it was "for that exact model." Diagnosis: NOT a data problem. The correct 3-phase sheet is in the warehouse, properly attached to item #10 `Deye SUN-12K-SG04LP3-EU` (`...SUN-5-12K-SG04LP3...pdf`). The matcher (`findItemDatasheetByQuery`) had no concept of electrical phase: it gated only on the size number ("12") and ranked by token overlap. Both the single-phase #9 and the three-phase #10 carry "12K", and the phase marker (`LP1` vs `LP3`) is buried inside an opaque model token, so the two scored equal and the lower rowid (#9, single-phase) won.

Fix in `src/warehouse.js`: extracted a DB-free `selectItemByQuery(items, message, recentText, opts)` shared by both the datasheet and photo matchers (the photo matcher's old size/token block was a near-duplicate, comment even said "Mirrors findItemDatasheetByQuery"). Pipeline now: size gate -> **phase gate** -> token-overlap tiebreak -> single-candidate fallback. New helpers:
- `detectPhaseIntent(text)` -> `'single' | 'three' | null`. Three-phase wins when both appear ("3 phase not single phase" is a three-phase ask). Handles glued "3phase". Detected on the current message first; history is only consulted when the message names neither a phase nor a size (a "send the datasheet" continuation), so a stale phase never narrows a fresh differently-sized request.
- `itemPhase(item)` -> phase from the Deye model string (`LP3`/`HP3`/"3 phase" => three, `LP1` => single, batteries/racks/panels => null/agnostic).
- Phase gate: when the customer names a phase and phased items match, restrict to exactly the matching-phase items (drops opposite-phase AND phase-agnostic items, e.g. a battery whose "PACK-16" name collided with "16kw"). If no item of the requested phase exists, keep only phase-agnostic items, and if none remain return null rather than send a wrong-phase sheet. `opts.hardSizeGate` (photos) and `opts.singleFallbackNeedsSize` (datasheets) preserve each matcher's prior size/fallback behavior.

Behavior change to note: for a no-phase request where two same-size siblings exist (e.g. "16kw datasheet" with both the single- and three-phase 16kW), the matcher now returns null (no confident pick) and the LLM asks which phase, instead of sending a coin-flip sheet.

Tests: new `test/matcher.test.js` (Node built-in `node:test`, no new dep), 18 cases incl. the exact reported scenario and the full 23-item production catalog; wired `npm test`. All green. Signatures/return shapes of `findItemDatasheetByQuery` / `findItemPhotosByQuery` unchanged, so `src/handler.js` call sites are untouched. Not yet committed/deployed (owner pushes manually). `node -c src/warehouse.js` passes.

Prompt hardening (also done this session, owner approved): `src/prompts/system.md` §8 datasheet-delivery rule now tells Sunny it does NOT see which file the system attached, so it must never assert the sent sheet "is for that exact model" or matches a specific model/phase/size, must not argue if the customer says the sheet is wrong, and must acknowledge + offer to confirm the right one with the team. Adds an explicit single-phase-vs-three-phase warning. This kills the "doubling down" failure from the screenshot.

## 2026-05-29 Beirut — voice notes fixed + Arabic-reply bug

OpenAI key restored: new `sk-proj-` key (billing credit added) validated against OpenAI (`GET /v1/models/whisper-1` 200; a real Whisper transcription test returned text), set on Railway via `railway variables --set`, redeployed. Confirmed live: a real WhatsApp voice note was transcribed and Sunny answered the spoken question correctly. Key was pasted in chat; rotate later for hygiene.

Then a follow-up bug surfaced: Sunny replied to the voice note in Arabic even though the tester spoke English. The stored transcript was `[voice note transcribed]: مرحباً، ما هو أسعار تشغيل البرنامج 12 كيلو وات اليوم؟` (garbled Arabic, "the program" instead of "inverter") — Whisper auto-detected the accented English clip as Arabic and transcribed into Arabic, then Sunny mirrored that language. Two-layer fix:
1. `src/transcribe.js` now pins the transcription `language` to `en` by default (env `WHISPER_LANGUAGE`, empty to restore auto-detect). Stops the Arabic mis-detection at the source.
2. `src/prompts/system.md` §4 reply-language rule rewritten: reply in English by default, mirror the customer ONLY for the five serviced languages (English, Pidgin, Hausa, Yoruba, Igbo); for any other language (Arabic, French, etc.) reply in English. Safety net even if a transcript comes back non-English.

## 2026-05-29 Beirut — discount policy + "specialist" renamed to "Sales Manager"

Two owner requests from live screenshots.

1. *Discount handling policy.* Replaced the blanket "ALL negotiation escalates, ZERO authority" rule with a tiered policy in `src/prompts/system.md` §7 and `classifier.md` negotiation rule:
   - Small orders (1-2 items, or total under ₦15M): Sunny declines warmly ("Our prices are already fixed at discounted rates, so there's no further room on this one.") and does NOT escalate. Classifier sets `needs_escalation=false`, so routine haggling no longer pings the owner. Previously every negotiation fired a NEGOTIATION alert.
   - Large orders (over ₦15M total) where the customer seems serious: Sunny (1) confirms they're ready to finalize now, (2) judges if the ask is reasonable (~5% of item price max), (3) offers to raise it with the Sales Manager, no promise. Classifier escalates `escalation_type='negotiation'`; the owner gets a NEGOTIATION alert and `expertContext` stays null so the §7 reply governs the wording. A discount ask paired with a commitment phrase still classifies HOT.
   - Sunny never names a percentage or a discounted number; the Sales Manager has final authority. Verified the existing reply guards don't strip the flow: trailing-question strip fires only on pure acks (a counter-offer like "Let me do 2.4m" is not one), and the CTA-tail strip's regex does not include "finalize".

2. *"Specialist" renamed to "Sales Manager".* Owner: stop saying "specialist" in conversations. Renamed across all customer-facing replies and LLM-instruction blocks: `system.md` (EPC route, HOT handoff, dynamic-block notes, worked examples, hard-nevers), `handler.js` (`HOT_LEAD_REPLY`, `SILENT_QUERY_REPLY`, both wa.me link labels now "Direct line to the Sales Manager:", expert-context HOT block, banned-phrase list, gratitude/casual blocks), `classifier.md`. Internal names left intact (`SPECIALIST_DIRECT_LINK` env var, `buildSpecialistLink()`, `specialist_link_set` API field). Detection regexes (`security.js` STALL_PATTERNS, `handler.js` HANDOFF_REPLY_RE / HOT_HANDOFF_REPLY_RE) and the `claude.js` history scrubber were extended to match BOTH "specialist" and "sales manager" so the stall/handoff safety guards and wa.me-link scrubbing keep working with the new wording. Legacy "specialist" canned-line scrubbers kept for old history.

Not yet deployed (owner pushes/deploys manually). All four edited JS files pass `node -c`.

## 2026-05-21 Beirut — THE photo bug: matcher returned photos without file_path

Even with an active PNG on file, the photo fast-path kept falling back. Isolated tests all passed (matcher matched, file existed, Meta upload + sendImage worked from a script), which made it look like deploy churn. It was not. Added a temporary `/api/_diag/photo` endpoint that runs the matcher + Meta upload from INSIDE the prod container; it revealed the matcher's returned photo had NO `file_path` (exists:false), while a direct `getPhotoById` had the path and uploaded fine.

Root cause: `findItemPhotosByQuery` built its result via `listPhotosForItem`, whose SELECT deliberately omits `file_path` (so the admin API never leaks the server disk path). The handler then called `uploadMediaToMeta(photo.file_path=undefined)` which threw "file not found", so every photo send failed and fell back. `meta_media_id` stayed null across all attempts, confirming no upload ever succeeded.

Fix: `findItemPhotosByQuery` now selects the full photo rows including `file_path` (and filters to active jpeg/png in the same query). Also relaxed the single-candidate rule: when exactly one product has sendable photos, a no-size request ("Photo", "send a picture") returns it even without a token/size match. Verified with a temp-DB repro that asserts `file_path` is present for the 6kW item across sized and no-size queries. Removed the temporary diagnostic endpoint in the same change.

## 2026-05-21 Beirut — photo false-positives, no-team-promise, answer format

Three owner complaints from live screenshots, all fixed:

1. *Photo fast-path false positives.* (a) A customer who SENT an image ("Can it power it" + photo) got the photo-share fallback, because the synthetic `[Customer sent an image]` marker contains the word "image" and the old `PHOTO_REQUEST_RE` matched any "image/picture/photo". (b) "The picture showing in ur advert is 6kw" also triggered it. Rewrote detection in `src/handler.js`: strip the image markers, require a real request context (request verb near a photo noun, "photo of/for/please", a bare "photo" message, or "what does it look like"), and SKIP entirely when the customer attached an image (`attachments.length > 0`) so their image goes to the normal vision reply instead. Verified with a 12-case unit test.

2. *No more "team will share" promises.* Owner: "no team would share anything, stop promising people." Photo no-photo fallback changed from "Let me ask the team to share photos of that shortly." to "I don't have a photo of that one on hand right now." (owner still pinged to add it). Datasheet no-file line in `system.md` also changed off the "team will share it shortly" wording.

3. *Answer format.* "i want to check 6kw inverter" returned "**Topology:** LV, single-phase, off-grid **Stock:** Available" (and WhatsApp does not even render `**`). Root cause: `system.md` itself instructed the bold-label format (lines 87, 94-95, 220-221). Rewrote: single-item answers are plain conversational sentences, NO labels, NO "Stock:" line, NO "Topology:" line, NO asterisks; say "available"/"in stock"/"incoming" in plain words; only mention topology when there are multiple options at a size and in plain words. Structured multi-line format reserved for BOMs / 3+ item answers. Example added for the exact 6kW case.

## 2026-05-21 Beirut — photo send bug: webp not supported by WhatsApp image messages

Customer asked for a photo of the 6kW inverter; Sunny kept replying "Let me ask the team to share photos of that shortly." (the no-photo fallback) even though the admin had uploaded a photo. Root cause (systematic debugging): the uploaded photo was a `.webp` (`SUN-6K-OG01LP1-EU-AM2.webp`), and WhatsApp Cloud API image messages accept ONLY jpeg/png. WebP is sticker-only. Verified: Meta's `/media` ACCEPTS the webp upload (reproduced live, got a media id), but `sendImage` (type=image) is rejected (error 131053), so every photo "fails to send" and the handler falls through to the fallback. Confirmed the matcher itself was fine (the 6kW item was the only one with a photo and the size token matched, so it definitely matched).

Fix (no new dependency, per owner choice): removed `image/webp` from `ALLOWED_PHOTO_MIMES` in `src/warehouse.js` (blocks webp at the upload endpoint), added `SENDABLE_PHOTO_MIMES` and filtered `findItemPhotosByQuery` (both the candidate EXISTS query and the returned photo list) to jpeg/png so a stray webp degrades to the graceful no-photo fallback + owner ping instead of a failed send. Admin Photos panel: `accept` now jpg/png only, client-side mime check rejects webp with a clear message, label/help text updated. CLAUDE.md photo-mime references updated (datasheet allow-list left as-is since datasheets are sent as documents).

Note: this does NOT auto-convert. The existing 6kW webp will keep hitting the fallback until the brother re-uploads it (and any other product photos) as JPG or PNG. Also found only 1 photo existed across 23 items despite "uploaded for each product" (others likely exceeded the 5MB cap or were webp); brother to re-upload after this ships.

## 2026-05-21 Beirut — Contacts "Export to Excel" (.xlsx)

Added a one-click contacts export to the admin Contacts tab. New dependency `exceljs` (approved by Serge this session; the Contacts export was the trigger). New endpoint `GET /api/contacts/export` builds a single-sheet `.xlsx` of every contact (no pagination, ignores UI filters), ordered like the Contacts tab. exceljs is required lazily inside the handler so a missing dependency only breaks the export, not the dashboard. The route is declared before `/contacts/:id` so "export" is not swallowed by the `:id` param. Phone column is `numFmt '@'` (text) so Excel keeps `+234...` intact; header row bold and frozen. Columns: Phone, Name, Category, Lead temperature, Client type, Language, Location, Use case, Load estimate, Timeline, Products asked about, Brand preference, Budget mentioned, First seen, Last active, Notes.

Frontend: "Export to Excel" button at the top-right of the contacts toolbar. `apiFetch` only returns JSON, so `exportContacts()` does a raw `fetch` with the `X-API-Key` header, reads a blob, and triggers a download named `electrosun-contacts-YYYY-MM-DD.xlsx`. Verified exceljs roundtrip locally: valid PK/zip, phone preserved as text, rows read back correctly.

## 2026-05-21 Beirut — cost-counter accounting bug fixed, monthly spend in admin

The admin badge ($spend / $budget) was reading far below the real Claude platform spend. Root cause in `src/cost_tracker.js > calcCostCents`: it computed non-cached input as `(input_tokens - cache_read - cache_write)`. The Anthropic API already reports `input_tokens` excluding cache tokens, so this double-subtracted them. On cache-heavy reply calls (Sunny caches its system blocks) the term went strongly negative and `Math.max(0, ...)` clamped the whole call to 0 cents, so most replies recorded as free.

Fix: bill each token type once at its own rate (`input * input_rate + cacheRead * cache_read_rate + cacheWrite * cache_write_rate + output * output_rate`). Verified: a typical cached Opus reply (300 fresh + 8000 cache-read + 250 out) went from 0 → 4 cents; a cache-write turn reads ~17 cents. The fix also makes the `isOverBudget()` daily guardrail meaningful again.

Added monthly tracking: `getMonthSpendCents()` + `getMonthStats()` in `src/cost_tracker.js` (sum `daily_costs` where `date LIKE 'YYYY-MM%'`, UTC). `GET /api/brain` now returns a `spending` block (today, month total, month reply/classifier call counts, active days, daily budget). Admin Knowledge → Models & config renders a new "Spending (estimate)" section at the top of the panel with a note that the estimate excludes Whisper/WhatsApp/hosting and only counts usage recorded after the fix.

Note: past `daily_costs` rows cannot be retroactively corrected (only the wrong totals were stored, not raw token counts). The figures are accurate from this fix forward. Uncommitted on local main; Serge to push.

## 2026-05-15 afternoon Beirut — BOM cleanup broadened, dangling-label preposition, wa.me HOT-only (fourteenth push)

Three live failures from the Charles and Xtocom Quality screenshots, three tactical patches:

1. *BOM cleanup broadened (six new strippers).* The image 15 leak (Xtocom Quality, church 50kW/400kWh) showed the model dumping the entire §9LV.4 sizing math, §9LV.8 pre-send checklist, dropped-pack reasoning, and meta-narration. Existing cleanup didn't catch any of it because the regexes were tuned for v1 leak shapes.

   New patterns added to `src/claude.js > cleanupBomReply`:
   - `(a3)` parenthetical regex broadened from "(≤ 20kW)" to also catch unit-less variants like "(≤ 10 ✓)" / "(≤ 32 ✓)" / "(= 10, on the limit ✓)".
   - `(a5)` `calc_line` strips any line containing `ceil(...)` math.
   - `(a6)` `internalLabels` strips `**LV Pre-send checklist:**`, `**Sizing logic:**`, `**Floor check:**`, `**Inverter count:**`, `**Total packs:**`, `**Min clusters:**`, `**Equal modules per inverter:**`, `**Tie-break:**`, etc.
   - `(a7)` `narration` strips "Running the configuration now.", "Only SE-F16 survives.", "For each battery pack/series", "Walk through the math/sizing", "Let me compute/calculate/run".
   - `(b2)` `droppedSku` strips dropped lines without "Option N:" prefix: `SE-F12: ceil(...) → exceeds 32 cap, dropped silently`, `BOS-B: 6 modules → fails minimum, dropped`.
   - `(b3)` `checklistRow` strips survivor rows like `SE-F16: 25 packs, 3 inverters ✓`.
   - `(d)` final cleanup widened to drop leftover punctuation+dash glue ("., - ") at line starts after narration strip.
   - Bug fix: removed the `break` in the `defaultPhrases` and `narrationPatterns` loops so ALL matching patterns can fire (previously only the first match in each loop applied, letting later leaks slip through).

   Verified under unit test against the exact Xtocom Quality leak text: cleaned output retains only the BOM card and recommendation. Legit 2-option BOM passes through with only the trailing-period normalization.

2. *Dangling-label detection widened.* The Charles screenshot showed Sunny's first reply ending in "at a special promo price of." after the price-strip removed the actual figure. Dangling-label detection only checked for `: punct` colon-pattern; "of." has no colon so the check missed.

   `src/claude.js` price-strip block now also flags trailing-preposition patterns: `\b(price|cost|rate|figure|amount|total|sum|quote|charge|fee)\s+(of|at|for|is)\s*[.,;!?]`. When detected, the reply is replaced with the standard "Could you share more about your project so I can guide you better?" deflection. Logged as `claude.reply.prices_stripped` with new field `dangling_kind` ('colon' | 'preposition').

3. *Customer-side wa.me link restricted to HOT-lead handoff only.* The Charles screenshot (image 14) showed the link being appended on every silent_query reply, including "Can I take your number?" and "the team will check shortly". This is spammy and confusing.

   `src/handler.js` change: the link append now requires `classification.escalation_type === 'hot_lead'` instead of any escalation. Silent_query, pricing_question, and all other escalation types no longer get the link. The link only appears when Sunny is genuinely passing the customer to a specialist after explicit commitment phrasing ("send me the account", "i want to pay", etc.). Variable renamed to `isHotHandoffThisTurn` to avoid collision with the existing `isHotEscalation` defined upstream.

Open data-hygiene issue (NOT code, owner-side): the `coming_note` for the SUN-6K-OG warehouse row says "special Promo price 559k", but the customer (Charles) said "I thought the promo price was NGN549,000". Sunny correctly sourced "559k" verbatim from Warehouse Stock and rendered "559,000 NGN" per Nigerian shorthand. Either the customer misremembered or the coming_note has a typo. Owner to confirm with brother and edit the warehouse note in the admin if needed.

Also saved: `docs/agent-improvement-brainstorm-2026-05-15.txt` captures the broader architectural recommendations (tool-ify §9, structured output for replies, two-stage cheaper models, failure replay test suite, prompt-trim + positive-shape rewrites). Reference for future sessions when we move beyond tactical patches.

This push is uncommitted on local main. Serge will push.

## 2026-05-14 late evening Beirut — §9 v5 docx swap, 2% tolerance, equal-modules-per-inverter mandatory (thirteenth push)

Owner shipped `Section_9_Battery_Configurator_LV_and_HV_FINAL_v5-1.docx` and asked to replace §9 entirely. Parsed the docx with python (xml.etree, with table + heading detection), produced `/tmp/new_section_9.md`, and spliced it into `src/prompts/system.md` replacing the previous §9 (lines 246-697 → 246-794, +96 net lines).

Material doctrine changes vs the previous §9:

1. *LV battery pack lineup updated.* §9LV.3 now lists `SE-F5.12 / SE-F12 / SE-F16` (5.12 / 12 / 16 kWh). The previous lineup was `SE-G6.1 / SE-F16`. SE-G6.1 is retired; SE-F12 is new. All §9LV.4 sizing loops, §9LV.5 mix rules, §9LV.9 worked references, and §19 forbidden-example wording updated to the new lineup.
2. *2% tolerance rule added in BOTH LV (§9LV.4 Step 2) and HV (§9HV.4 Step 1) sizing.* If the floor count (one fewer pack/module) lands within 2% below the storage target, use the floor instead of ceiling. Prevents over-sizing customers by a single pack/module just to clear the rounding. Three worked examples per side: 80 / 82 / 81 kWh LV; 230 / 200 / 196 kWh HV.
3. *HV equal-modules-per-inverter is now MANDATORY (§9HV.4 Step 3).* "Every paralleled inverter carries the SAME number of modules. Not approximately equal, exactly equal." Total modules must be divisible by inverter count; bump up to next multiple. Worked examples: 30 modules on 4 inverters → 32 (8 per inverter); 47 on 2 → 48 (24 per inverter); 17 on 3 → 18 (6 per inverter, then floor-check or drop).
4. *HV floor check is now "drop, never bump" (§9HV.4 Step 4).* If any cluster falls below the series minimum, drop the series silently. NEVER increase module count to clear the floor, that would over-store the customer. New worked example: 90 kWh on 2× SUN-30K with BOS-B → 3 per inverter → drop BOS-B entirely, don't bump to 14 modules.
5. *Tie-break for LV inverter selection (§9LV.4 Step 1).* When multiple inverter models fit, prefer the lowest count (1× 16K beats 2× 12K). If counts tie, prefer the closest power match (avoid heavy oversizing).
6. *Off-grid inverter pick rule (§9LV.2).* SUN-6K-OG only when the customer states the site has no grid connection. Every other 1-phase site → prefer the hybrid SG model (supports future grid connection).
7. *New §9.X "Shared rules and glossary" section.* Replaces the duplicated mixing/customer-voice rules across §9LV and §9HV. Four subsections: §9.X.1 Mixing prohibitions, §9.X.2 Customer-voice rules, §9.X.3 Common rules (both LV and HV), §9.X.4 Glossary (12-term table covering LV, HV, Pack, Module, Cluster, Min/Max cluster, PDU, BOM, Parallel bus, Phase).
8. *§9HV "no HV fits at all" fallback added (§9HV.4 end).* If even the largest inverter size cannot fit the load or storage, return to the customer with three options: (a) reduce storage target, (b) reduce backed-up load, or (c) split into two systems. Never invent a workaround. Never silently force LV.
9. *§9HV.5 hard rules tightened.* New entry on §9.0-governs-entry: "If the customer originally requested LV and HV was suggested by §9.0 Check 4, the customer may still insist on LV, in which case exit §9HV and return to §9LV via §9.0 Check 5. Never refuse the LV-insist path."
10. *Subsection numbers normalized.* The docx uses "§9 HV" (with space) and "§9.X" labels; spliced version normalizes to "§9HV" (no space) for consistency with §9LV, but keeps "§9.X" as the owner wrote it. All cross-references updated.

Cross-reference clean-up outside §9:
- §19 hard never with "Option 2: SE-G6.1 not in stock, skipped" example updated to SE-F12 (matches new pack lineup).
- All other §9.x / §9LV.x / §9HV.x cross-refs in §5, §6, §19 verified consistent.

HV BOM validator (`src/hv_validator.js`) NOT modified. Its existing logic already supports the new mandatory "equal modules per inverter" rule because `computeExpectedClusterSplit` bumps `minClusters` to a multiple of `inverterQty`, which implicitly enforces equal-per-inverter. The 2% tolerance is a model-side decision (the validator can't see the customer's target storage value), so the prompt rule is the only enforcement for that.

Net prompt size: 1056 lines (was 893 before this push). §9 is now the longest section by far at ~550 lines, fully self-contained for LV + HV doctrine.

This push is uncommitted on local main. Serge will push.

## 2026-05-14 later evening Beirut — 5kVA adjacent rule, sku_list_dump_blocked, SE-G5.1 Pro removed (twelfth push)

Three live failures flagged by the owner:

1. *Image 10, 5kVA case.* Customer asked "5kv inverter prize". Warehouse has no SUN-5K row (closest sizes: SUN-6K-OG01LP1 incoming, SUN-8K-SG05LP1 in stock). Instead of surfacing the 6kW or 8kW, Sunny escalated as silent_query (intent `pricing_question`) and replied with the canned "Noted. Will share the figure once confirmed." That canned text comes from `src/handler.js > stall guard` when both the model's first reply AND the stall-regenerated reply contain stall language. Doctrine fix: §6 gained an "if customer named a size with no exact row but adjacent sizes exist in Warehouse Stock, do NOT stall, do NOT silent_query, surface the closest match with topology and stock state" block, with a concrete reply template using the actual SKUs. §19 gained a matching hard never.

2. *Image 11, catalog dump.* Customer asked "Which of the battery and inverter do you have". Sunny dumped 9 inverter SKUs (8K, 12K x 2, 16K x 2, 20K, 18K, 6K, 30K, 50K, 80K) and 5 battery SKUs across LV and HV, with stock state on each line. The existing `catalog_enumeration_blocked` guard requires `priceCount >= 3` to fire; this reply had stock states but no prices, so it slipped through. New `sku_list_dump_blocked` guard in `src/claude.js > generateReply`: counts distinct inverter SKUs (regex `\bSUN-\d+(?:\.\d+)?K\b`) and distinct battery SKUs (regex matching BOS-X and SE-F/SE-G families). Fires when (a) `optionHeaderCount === 0` (i.e. NOT a structured BOM with "Option N:" headers) AND (b) at least 4 distinct inverter SKUs OR 4 distinct battery SKUs OR 6 total SKUs. Replaces the reply with: "Could you share what you're sizing for? Residential, commercial, a specific kW size or storage target. That way the team can point you at the right setup." Verified under unit test that the image 11 text triggers the block (9 inverter SKUs, 0 option headers) and a legitimate 3-option HV BOM with 9 battery SKUs does NOT trigger (because it has 3 option headers).

3. *Image 12, SE-G5.1 Pro not in stock.* Sunny offered "SE-G5.1 Pro" as an LV battery option to a customer. Owner: "we don't have SE-G 5.12 in stock, remove it from the master prompt". Warehouse confirms: only SE-F5.12 and SE-F16 are listed as LV battery rows. SE-G5.1 Pro is sourced from §9LV.3 prompt only. Removed: §9LV.3 table row, §9LV.4 sizing loop label, §9LV.5 mix-rule, all SE-G5.1 worked references in §9LV.9 (6 worked references trimmed of their SE-G5.1 line). SE-G6.1 left in place per owner's explicit scope ("remove SE-G 5.12" only). Added a closing line to §9LV.3: "Always cross-check against Warehouse Stock before offering. If a pack listed here is not in Warehouse Stock, it is NOT offerable today; surface only the pack rows present in the stock block."

§19 also gained an "enumeration" hard never inline-mirroring the new code guard's threshold (4+ inverter SKUs or 4+ battery SKUs in a non-BOM reply = catalog dump = forbidden).

Note on the "Sunny went silent after owner's manual reply" complaint in image 10: the conversation is in `human_handled` state because the owner sent a manual reply via the admin's HUMAN_MANUAL_REPLY path. While `human_handled=true`, Sunny does NOT process new customer messages, so the customer's "With battery" and "Then 8kv with battery nko" follow-ups sit unanswered until the `autoReleaseStaleHumanConversations` cron fires (currently `HUMAN_AUTO_RELEASE_MINUTES=15`, cron runs every 5 minutes, so up to 20 min wait). Consider lowering this to 5 minutes or adding an owner ping when new customer messages arrive during human_handled mode. Not changed in this push.

This push is uncommitted on local main. Serge will push.

## 2026-05-14 evening Beirut — cleanupBomReply for §9.0 leak (eleventh push)

Owner flagged a live reply that leaked the §9.0 decision tree verbatim to the customer, listed dropped LV pack options inline, glued every block together with no line breaks, and tacked a reasoning paragraph onto the Recommended line. Concrete failure mode from the screenshot:

```
For 13kW / 65kWh on LV: §9.0 Check 2: load is 13kW (≤ 20kW), so LV is the default. Option 1: SE-F16
Inverter: SUN-16K-SG01LP1-EU × 1
...
Cables: battery comm bus + AC tie Option 2: SE-G6.1 Not in our current stock, skipped. Option 3: SE-G5.1 Not in our current stock, skipped. Recommended: Option 1: SE-F16, 1 inverter covers 13kW with headroom, 5 packs gives you 80kWh which exceeds your 65kWh target cleanly.
```

Six distinct leaks in one reply. Prompt rules alone clearly cannot hold; shipped a deterministic backstop:

A. *New `cleanupBomReply(text)` helper in `src/claude.js`.* Runs as the absolute final pass after the existing HV validator, dash strip, and all security guards. Six cleanup passes in order:
   1. Strip "§9.0 Check 2: load is X..."-style doctrine leaks, also bare "§9.0", "§9LV.x", "§9HV.x", "Section 9" refs.
   2. Strip "Check N:" / "Step N:" stems even without a §9 prefix.
   3. Strip parenthetical sizing reasoning: "(≤ 20kW)", "(≤ 32 packs)", "(≥ 50kWh)", "(<= 10 inverters)".
   4. Strip default-routing phrases: "so LV is the default", "LV is the default", "small-app default", "decision tree", "LV ceilings hold/break".
   5. Strip inline "Option N: SKU (skipped|not in stock|dropped|unavailable|unviable)" sentences. Dropped options must be invisible.
   6. Trim recommendation reasoning: keep only `Recommended: Option N` (optionally `: SKU`), preserve closing markdown asterisks for WhatsApp bold, drop everything after.
   7. Force blank line before every "Option N:" and "Recommended:" header glued to a preceding sentence. Protect the "Recommended: Option N" pair from being split (uses a temporary marker, then restored).
   8. Force single newline before glued BOM body labels (Inverter:/Battery:/Parallel kit:/Cables:/Cluster split:/Control Box:/Racks:).
   9. Whitespace cleanup: collapse 3+ newlines, drop orphan punctuation lines, normalize double spaces.
   Returns `{ text, changed, reasons }`. Logged as `claude.reply.bom_cleanup_applied` with the original and cleaned text plus the reason list.

B. *§9LV.6 and §9HV.6 (BOM output format) rewritten as STRICT rules.* Numbered output rules (opening line, blank lines between blocks, no-reason recommendation), an explicit forbidden-tokens list (§9.0 / §9LV / §9HV / Check N / Step N / small-app default / ceilings hold / 32-pack ceiling / 10-inverter limit / battery inputs available / cluster inputs total), and a tightened template. Recommended line is now `Recommended: Option [N]` with NO reason, NO explanation, NO "because".

C. *§9LV.7 and §9HV.7 (agent behavior) tightened.* Dropped options are SILENT (never listed, never named, never mentioned). Section references and decision-tree labels are internal-only. Recommended line never carries a reason.

D. *§19 hard nevers gained five entries* covering the same surface area, expressed as concrete bans with examples of forbidden output ("Option 2: SE-G6.1 not in stock, skipped" specifically called out).

Unit-tested cleanup against the exact screenshot text plus a clean-BOM passthrough and a non-BOM passthrough. All three behave correctly: leaks stripped, clean output preserved (including closing markdown asterisks), non-BOM text untouched.

This push is uncommitted on local main. Serge will push.

## 2026-05-14 afternoon Beirut — LV configurator + §9.0 LV-vs-HV decision tree (tenth push)

Owner-supplied LV configurator + new §9.0 LV-vs-HV decision tree to replace the existing §9. The pre-tune §9 (HV-only, 151 lines) is preserved in git history under the previous push. New §9 expanded to three subsections:

1. *§9.0 LV vs HV decision tree.* Five sequential checks: voltage named by customer (LV/HV literal) → use it; otherwise load ≤ 20 kW = small-app LV default; otherwise test LV ceilings (≤ 32 packs, ≤ 10 inverters paralleled, phase match) → if pass, recommend LV; if fail, suggest HV and wait; if customer insists on LV, re-size LV at full parallel; if still doesn't fit, offer to reduce scope or accept HV. Includes a visual ASCII tree and a "§9.0 hard rules — never break" block. Critically: storage size alone is NEVER a trigger for HV anymore. The previous "storage > 50 kWh = HV" rule is explicitly retired in §9.0 hard rules.

2. *§9LV.1 to §9LV.9 LV Configurator (new).* Lists 10 LV Deye inverters (5K, 6K-OG, 8K, 10K, 12K x 2, 16K x 2, 18K, 20K) with phase + type. Lists 3 LV battery packs (SE-G5.1 Pro 5.12 kWh, SE-G6.1 6.14 kWh, SE-F16 16 kWh). Sizing flow: ceil(load/inverter kW) × 1.25 headroom for inverter count (must be ≤ 10); ceil(storage/pack kWh) for total packs (must be ≤ 32 system-wide, NOT per inverter); phase check; emit. Hard rules cover no-mixing (pack model, inverter model, phase), 32-pack pool ceiling, 10-inverter parallel ceiling. Output format is a BOM card per surviving pack with comm bus + parallel kit lines (no clusters, no PDU, no racks unlike HV). Worked references for 100/80, 30/50, 10/30, 5/15, 6/20 off-grid, 150/200 borderline, 200/600 LV-fails.

3. *§9HV.1 to §9HV.10 HV Configurator.* Existing HV content preserved verbatim except: §9HV.1 trigger list rewritten to point at §9.0 routing (removed standalone "storage > 50 kWh" trigger and "HV-only inverter" implicit trigger, replaced with: customer named HV / customer named HV-only product / §9.0 Check 4 escalation accepted). §9HV.5 cross-reference to §9LV.5 added. Internal subsection numbers renamed from 9.2-9.10 to 9HV.2-9HV.10 for consistency.

Cross-references reconciled:
- §5 "HV BOM cards are governed by §9. only build when §9.1 triggers" updated to "Battery BOMs (LV or HV) are governed by §9. The §9.0 decision tree decides LV vs HV."
- §19 hard nevers: dropped the "storage > 50 kWh" volunteer-HV trigger, replaced with two new entries: never volunteer a battery BOM unless customer asked for sizing; never auto-switch from LV to HV based on storage size or any other size threshold. §19 reference to "§9.3" updated to "§9HV.3".
- §11 "Pivot back to supply: Want me to confirm what's in stock for the system size you're sizing?" CTA stripped per the new no-CTA §5 rule. Hold-the-line text remains; the customer pivots back to supply themselves.
- §12 SERIOUS push-to-close rewritten. Old: "The Deye 12kW is X NGN, available. Want to proceed with pickup or delivery?". New: "The Deye 12kW is X NGN, available." Then stop. Let the customer say "I want to pay" themselves. Capture-for-follow-up clarified as a once-per-conversation clarifier, not a CTA.

Code update: `src/claude.js` option-header dash-strip special case broadened from `BOS-[ABG]` only to any capital-letter-starting SKU, so LV BOM headers like "Option 1 — SE-F16" become "Option 1: SE-F16" instead of "Option 1, SE-F16".

HV validator (`src/hv_validator.js`) unchanged. Its OPTION_HEADER_RE matches only BOS-[ABG], so LV BOM option blocks pass through untouched. Verified under unit test (LV BOM with 2 options through validateAndFixHvBom: changed=false, no drops).

Owner mentioned the SE-G5.1 Pro and SE-G6.1 may not yet be in Warehouse Stock (the live warehouse shows SE-F5.12 as the LV pack row currently). Sunny will follow §6 "Warehouse Stock is the source of truth for what's offerable" and surface only the rows that exist in stock, while the §9LV.3 list informs sizing rules for any of the three packs once added.

The LV-inverter-with-HV-battery `non_hv_inverter` validator drop reason from the 8th push still holds and is the right guard for the reverse case (HV BOM with LV inverter SKU).

This push is uncommitted on local main. Serge will push.

## 2026-05-14 morning Beirut — CTA-tail strip + exact-size rule + structured-reply default (ninth push)

Owner-flagged three live failures: (a) customer asked "6kVA Deye inverter with 10kWh battery", Sunny silently upsized to the 8kW hybrid and never surfaced the 6kW off-grid row that IS in the warehouse (`SUN-6K-OG01LP1-EU-AM2`, LV single-phase, off-grid, incoming); (b) replies still cap with CTA-style questions like "Want to proceed with the inverter now and pre-order the batteries, or would you prefer to wait?", which Nigerian customers read as pushy; (c) replies are wall-of-text paragraphs instead of structured blocks with line breaks. Changes:

A. *§5 rewritten.* Old "1 to 3 short sentences, ONE natural follow-up question" wording dropped. New rule: length scales with the answer (1-fact = 1 sentence; 2-fact = 1-2 sentences or 2-line block; 3+ facts = ALWAYS structured with line breaks, blank line between groups, max 6 blocks). Structured replies are no longer gated on "explicit multi-component ask", they are the default for any multi-fact answer. New explicit ban on CTA-style tails ("Want to proceed?", "Want me to send the account?", "Are you ready to pay?", "Should I send the proforma?", "Shall I confirm the order?", "Would you like to wait or pre-order?", "Want to pre-order?", "Ready to confirm?", "Do you want me to put it aside?"). Clarifying questions still allowed when the model genuinely needs info AND hasn't asked it yet. New worked examples replace the old "Ready to proceed?"-closer example.

B. *§8 Exact-size rule added.* When the customer names a specific kW or kVA size, the model must check Warehouse Stock for EVERY matching row across all topologies (hybrid, off-grid, grid-tie) and all stock states (in stock, incoming, out of stock). Do NOT silently upsize to the next available hybrid. Do NOT skip off-grid or incoming rows. Surface every match with model code, topology, and stock state. The earlier Variant rule (SIZE+PHASE/SIZE+VOLTAGE) kept directly after, slightly retitled.

C. *§19 Hard nevers gained three entries.* (1) Never silently upsize the inverter, list every matching size regardless of topology or stock state. (2) Never cap a reply with a CTA-style question, full forbidden-list inline. (3) Never produce a wall-of-text paragraph for a multi-fact answer, three or more facts always become a structured block per §5.

D. *New CTA-tail strip guard in `src/claude.js > generateReply`.* Runs right after the existing pure-ack trailing-question strip. Skips the strip when the customer's last message contains a guidance/intent phrase (`recommend`, `suggest`, `i'?m ready`, `let's proceed`, `send (me) the account/proforma/invoice`, `where do i pay`, etc.) because in those cases a CTA close is appropriate. Otherwise matches a comprehensive set of trailing CTA patterns ("Want to proceed/order/pre-order/wait/confirm/buy/pay/lock/reserve", "Want me/us/the team to send/share/prepare/process/...", "Would you like to ...", "Should I send/share/prepare/process/...", "Shall I ...", "Do you want to ... / me to send/share/prepare", "Are you ready to / Ready to proceed/pay/order/confirm") followed by up to 200 non-stop chars and a trailing "?" anchored to end-of-text. Strips the tail sentence. Logs `claude.reply.cta_tail_stripped`. Unit-tested across 12 positive/negative shapes including the multi-clause "Want to proceed... or would you prefer to wait?" case from the live failure.

LV doctrine NOT touched this push, owner is sending consolidated LV rules separately (32 LV batteries in parallel per inverter, 10 LV inverters in parallel). Will land in a follow-up §9.x addition.

This push is uncommitted on local main. Serge will push.

## 2026-05-13 late evening Beirut — validator gates + framing rewrite + prior-drops feedback + dash strip (eighth push)

Diagnostic-driven follow-up to the seventh tune. Owner flagged three live conversations where the validator either (a) approved a hardware-impossible BOM, (b) silently dropped 2 of 3 options without rewriting the framing line so the customer read "Here are all three options" with only one card, or (c) repeatedly emitted the same broken BOM across turns with no feedback loop. Plus a recurring no-double-dashes violation that the prompt rule alone has not eliminated. All four fixes are code-level guards in `src/hv_validator.js` and `src/claude.js`:

1. *Inverter-series gate in `validateOption`.* New `non_hv_inverter` drop reason. When an option's header is BOS-A/B/G AND the inverter line parses to a SUN-XXK SKU where XX is not 30/50/80, the option is dropped (was previously passthrough on null inverter code, which silently approved the LV+HV hardware mix in the live screenshot). Caught all three options in the 20K LV + HV battery case under unit test.
2. *Framing-line rewrite when survivor count differs from original.* New helper `rewriteFramingForSurvivorCount` rewrites "Here are all three options" / "Here are both options" / standalone "all three options" / "both options" to match the new survivor count (1 → "Here is one option", 2 → "Here are two options"). Runs after `renumberRemainingOptions`. Tested against the Electro1 case where 3 options dropped to 1 visible, the framing was previously left untouched.
3. *Per-contact validator feedback loop.* New module state `_lastDropsByContact` (Map keyed on contactId, TTL 10 min). `recordDropsForContact` is called from `claude.js` after the validator strips anything. `consumeDropsForContact` is called from `claude.js` at the top of `generateReply` (after expert context, before history). `formatPriorDropsContext` builds a system block that names each dropped series with reason + errors and gives the model corrective hints per reason (non_hv_inverter, uneven_split, floor_violated). Closes the steady-state failure where the model regenerated the same broken BOM on follow-up turns. Cleared after one consumption.
4. *No-double-dashes output guard in `claude.js > generateReply`.* Runs LAST, after the HV validator (which still needs em-dash to match option headers) and after the datasheet marker guard. Pipeline: special-case "Option N — BOS-X" → "Option N: BOS-X" (clean), then en-dash between digits stays as single hyphen (number ranges like "13-14kW"), then em-dash with spaces becomes ", ", en-dash with spaces becomes ", ", ASCII "--" becomes ", ". Followed by cleanup passes for repeated commas, double spaces, and stray comma-before-punctuation. Logs `claude.reply.dashes_stripped` with em/en/-- counts.

Touched files: `src/hv_validator.js` (added `rewriteFramingForSurvivorCount`, `non_hv_inverter` branch in `validateOption`, `_lastDropsByContact` Map + `recordDropsForContact` / `consumeDropsForContact` / `formatPriorDropsContext`, export list); `src/claude.js` (require destructure now pulls the three new helpers, prior-drops injection after expert context block, drop recording after validator runs, dash-strip guard before final return). No prompt edits this push; the §9 doctrine is unchanged and the validator is now strict enough that prompt-only enforcement of the LV+HV ban is no longer load-bearing.

This push is uncommitted on local main. Serge will push.

## 2026-05-13 late evening Beirut — owner PDF round-trip §4 + §9 restored (seventh tune, live SHA 9b70cb5)

After the sixth-tune slim §9 went live, the owner reviewed it, marked up the master prompt as a PDF (`master-prompt-2026-05-13-edited.pdf` on their desktop), and asked me to apply the edits verbatim. Only two sections changed:

1. *§4 Nigerian English flavor block* replaced. The bullet list with "Kindly / Reach out / Soonest / Avoid Americanisms" was swapped for an affirmation-phrase list with translations: "Okay sir" (respectful agreement), "Yes sir / Yes ma" (confirmation + respect), "No wahala" (no problem), "Ehen" (I understand / go on), "Correct" (that's right), "Sharp sharp" (quickly / understood fast), "I dey hear you" (I understand you), "Noted" (very common in professional chats), "Done" (task confirmed), "Carry go!" (encouragement). Plus example confirmations ("Okay sir, noted." / "No wahala sir." / "Done sir.") and a closing line on where these phrases are used (business, tech, solar, logistics environments).

2. *§9 HV configurator restructured to 10 subsections (was 7 in sixth tune).* The owner essentially reinstated the RULE 0-style "no inverter capacity framing" doctrine that the sixth tune compression had dropped. Material changes vs sixth tune: §9.2 inverter table renamed "Battery inputs" column to "Max clusters" with explicit "ceiling, never a target" emphasis. §9.3 battery table now omits the "Rack hardware" column (rack rules live below as a separate subsection). §9.4 sizing logic in 5 steps (was 6); Step 2 marked "(this is the target)" with the "Do NOT increase it just because more inverter battery inputs are available" line. §9.5 Hard rules restored as a 7-item list. §9.6 Output format with new "Never mention 'battery inputs available' or 'cluster inputs total' in the output. Skip inverter capacity framing → go straight to the options" rule. §9.7 Agent behavior tightened (validator safety-net note removed). §9.8 Pre-send checklist restored as 9 checkbox items including "No mention of 'battery inputs' or 'cluster inputs available' in output?". §9.9 Worked references restored with three full examples (300/480 on 4× 80K, 150/360 on 2× 80K, 100/230 on 2× 50K). §9.10 Key mental model appendix added.

Workflow note: the owner edits the master prompt by taking the .txt I export and re-importing through their editor (PDF round-trip), not by sending a diff or markdown. They expect "cross-check format, don't change content" semantics.

Sections 1-3, 5-8, 10-20 untouched in this tune.

Live state on Railway: SHA `9b70cb5`, deploy `fb311fec-078b-4277-97aa-b6c826518b68`, clean boot, validator still active. Prompt is 575 lines (was 513 after sixth tune; the restored §9.5 / §9.8 / §9.9 / §9.10 added ~62 lines, but the owner trimmed §4 Nigerian flavor by a few lines).

Today's commit chain on origin/main (chronological, all post-revert-revert):
- `cab9e31` sixth tune: HV BOM validator + slim §9
- `cadf649` Nigerian English flavor block first version (since superseded)
- `9b70cb5` owner PDF edit (current live)

Also two reverts earlier in the day (`cdb6257`, `7bc5252`) when the owner asked to roll back to pre-11am state, then immediately back to 6:30pm state. History preserved, no force-pushes.

## 2026-05-13 evening Beirut — HV BOM validator + slim prompt rewrite (sixth tune, cab9e31)

Driven by a live failure where v3 still produced an invalid BOM (24 BOS-B on 2× 80K split 6+6+6+6, violating both the min-clusters rule and the BOS-B 7-floor). Diagnosis: prompt-only enforcement of numeric rules is unreliable on LLMs no matter how many times the rule is repeated. Fix: add a deterministic code-level validator AND trim the prompt of repetition.

Changes shipped this push:

A. *New module `src/hv_validator.js`* (302 lines). Pure-logic HV BOM validator with no external dependencies beyond the logger. Engineering constants are the single source of truth (the prompt mirrors them in §9 but the code is authoritative): MODULE_KWH per series, SERIES_MIN_PER_CLUSTER (BOS-G: 5, BOS-A: 7, BOS-B: 7), MAX_PER_CLUSTER per (inverter, series), SERIES_PDU.

   Pipeline: `splitIntoOptionBlocks(text)` scans the reply for `*Option N — BOS-X*` headers (tolerates em-dash / en-dash / ASCII hyphen, optional asterisks) and returns block ranges. `parseOptionBlock(blockText)` extracts inverter SKU + qty, battery series + module count + kWh, cluster split (`"12+12"` / `"8+8 across 2 inverters"` / `"16"`), PDU model + qty, racks line, cables line. `computeExpectedClusterSplit(series, totalModules, inverterCode, inverterQty)` runs the §9.4 algorithm: `min clusters = ceil(total ÷ max-per-cluster)`, bump to multiple of `inverterQty` for even multi-inverter split, distribute modules evenly with remainder going to the first N clusters.

   `validateOption(parsed)` decides one of {drop, passthrough, valid}: drop on floor violation (actual or expected cluster below series-min), too-many-clusters (actual > expected), uneven split (sorted actual ≠ sorted expected), pdu-mismatch (pdu_qty ≠ cluster count). Passthrough on incomplete parse.

   `validateAndFixHvBom(replyText)` orchestrates. Strips offending option blocks back-to-front to preserve string indices, renumbers surviving options sequentially, repoints any `*Recommended: Option N*` line (remaps to new index if the recommendation pointed at a survivor, replaces with a generic "team will confirm" close if it pointed at a dropped option, OR if only one option survives, rewrites to `*Recommended:* Option 1`). Returns `{ok: true, text, changed, drops, survivors}` on partial drop, `{ok: false, text: null, droppedAll: true, drops}` when every option fails (caller sends a deflection).

B. *Wired into `src/claude.js > generateReply`* as the 9th post-generation guard, placed AFTER `detectFabricatedVariant` and BEFORE the datasheet-marker guard. On `droppedAll`, the reply text is replaced with: "Let me confirm the exact configuration with the team and send you the options shortly." (caught by the existing reply-handoff backstop in handler.js, which then routes to silent_query). On partial drop, the fixed text is sent. Logs `claude.reply.hv_bom_options_dropped` or `claude.reply.hv_bom_all_options_invalid` with the original_reply, drops detail, survivors list, and fixed_reply for observability.

   Sanity-tested against the live screenshot case (24 BOS-B on 2× 80K split 6+6+6+6): validator detects floor violation, strips ONLY the BOS-B option, keeps BOS-A and BOS-G with their per-line price math intact, renumbers Option 3 → Option 2, and neutralizes the recommendation. Non-HV replies pass through unchanged.

C. *`src/prompts/system.md` re-engineered.* Pre-rework v3 (673 lines, `ff3b775`) snapshotted to `docs/archive/system-v3-pre-validator-rework-2026-05-13.md`. New version 514 lines (24% reduction) preserves every rule, fact, address, hard never, worked example, and dynamic-block reference. Repetition removed in §9: subsections collapsed from 10 (§9.1 to §9.10) to 7 (§9.1 to §9.7). The §9.5 "Hard rules" subsection dropped (rules live in §9.3 tables, §9.4 algorithm steps, §19 hard nevers). The §9.8 mandatory pre-send checklist dropped (replaced by the deterministic validator). The §9.10 "Key mental model" appendix dropped (validator enforces what the 6 anti-pattern paragraphs were trying to teach). The §5 HV BOM template merged into §9.5 where it logically belongs. §9.3 per-series details merged into one compact 3-row table plus a rack-picking subsection. §19 hard nevers tightened (still 30+ items, but each safety-critical rule kept and a few duplicates with body sections collapsed).

   Section count unchanged (20 top-level sections), preserving admin-tab editor compatibility. Reply length, voice, pricing, stock, locations, installation, closing moves, promos, confusion handling, anti-repeat, dynamic blocks, industry context, worked examples, when-unsure sections all kept with minor wording tightening.

   New: §9.7 explicitly tells the model the validator exists ("The reply pipeline runs a deterministic post-validator on every BOM. Options that violate min-clusters, the floor, or rack matching are silently stripped before send. Treat that as a backstop. Following §9.4 yourself is still your job.") so the model doesn't get confused when its own BOM gets edited downstream.

## 2026-05-13 afternoon Beirut — v3 HV configurator with min-clusters rule (fifth tune)

v2 (`863ee89`) snapshotted to `docs/archive/system-hv-section-2026-05-13-configurator-v2.md`. v3 introduces a critical doctrine change driven by a live failure case: Sunny was filling all available inverter battery inputs (e.g. 32 BOS-A modules on 2× 50K → 4 clusters of 8) instead of picking the minimum cluster count (2 clusters of 16). v3 also splits BOS-B into clusters of fewer than 7 in some cases, which is invalid.

Material changes in v3 vs v2:

- *New §9.4 sizing flow as explicit Steps A through E,* with Step B "minimum clusters needed" promoted to the most prominent step: `min clusters = ceil(total modules ÷ max-per-cluster for this inverter+series)`. The earlier flow allowed the model to drift into using all available battery inputs.
- *New hard rule §9.5 #5:* "Use the MINIMUM number of clusters, NOT the maximum the inverter allows."
- *§9.8 mandatory checklist* gained an item: "Total clusters = MINIMUM possible (not max the inverter allows)?"
- *BOS-B floor language strengthened* with a 🚫 prefix: "ABSOLUTE FLOOR: 7 modules per cluster. Anything less = BOS-B is INVALID for this project. Drop it."
- *Worked examples §9.9 rewritten.* New Example A (150 kW / 360 kWh on 2× 80K) showcases the min-clusters rule across all three series. Example B (100 kW / 230 kWh) now correctly puts 32 BOS-A in 2 clusters of 16 (was 4 clusters of 8).
- *New §9.10 Key Mental Model appendix* (six Wrong-behavior / Correct-rule pairs) reinforces the same rules in anti-pattern form.
- *§19 gained a hard never:* "Never use more clusters than the MINIMUM needed" with the formula and the BOS-A example.

Section §5 HV BOM shape and the other §19 nevers stayed the same as v2.

## 2026-05-13 afternoon Beirut — §9 v2 swap with Deye HV Configurator v2 (fourth tune, 863ee89)

Swapped §9 entirely with the owner-supplied "Deye HV Inverter & Battery Configurator v2" content. The previous §9 + §5 HV BOM shape + related §19 nevers were snapshotted to `docs/archive/system-hv-section-2026-05-13-before-configurator-v2.md`.

Material changes in this swap:

- *Optimal module count rule RETIRED.* Sizing now uses pure ceil(total kWh ÷ module kWh) plus even cluster balancing. The earlier "round down within 3%" optimization is gone. Per the owner's worked reference: 230 kWh BOS-A → 30 modules round to 32 (balanced 8+8+8+8), not 28 or 29.
- *BOS-A rack capacities updated.* BOS-A-RACK11 holds 10 batteries + 1 PDU (was 11). BOS-A-RACK14 holds 13 batteries + 1 PDU (unchanged).
- *BOS-A rack picking rule rewritten.* 7-10 modules → 1× RACK11, 11-13 modules → 1× RACK14, 14-16 modules → 1× RACK14 + 1× RACK11, 17-21 modules → 2× RACK14. Previously: 1× RACK11 for 1-11 / 1× RACK14 for 12-13 / 2× RACK11 for 14-22.
- *BOS-G module SKU named:* BOS-G-PACK 5.1 (51.2 V, 100 Ah, LiFePO4). BOS-G rack SKU named: 3U-RACK.
- *Inverter table gains a Battery voltage column* (160 to 700/800/1000 V) and a footnote on three-phase 380/400 V, 50/60 Hz, IP65, up-to-10 parallel.
- *BOM output format simplified.* No per-line price math in BOM cards. Prices remain governed by §6 (quote only on explicit ask).
- *New §9.9 worked reference* (100 kW / 230 kWh, 2× 50K) embedded as an internal sanity check across BOS-A / BOS-B / BOS-G with recommended option.
- *§19 cleaned:* dropped the "Never blindly use ceil" never (Optimal module count retired). Rack-counting never rewritten with the new BOS-A sizing guide.

## 2026-05-13 early afternoon Beirut — per-series rack rules (third push)

Addressed a per-series rack mapping error. Live case: 13 BOS-A modules in one cluster, Sunny said "Racks (19″): 2 × 550k = 1.10M NGN" — but 13 BOS-A modules fit in 1× BOS-A-RACK14 (one rack, 550k NGN). The generic "13+ modules = 2 racks" rule from the previous prompt was a BOS-G assumption that doesn't apply to BOS-A. The brother specified the rack facts:

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

## 2026-05-13 late morning Beirut — welcome-card fallthrough + BOM rules strengthened (second push, a52b0be / c31006f)

Addressed three live-test failures the brother flagged:

A. *Welcome card swallowed the customer's first-turn question.* Live case: customer wrote "Good morning, Is 16kwh Deye lithium battery available?" — Sunny sent only the hardcoded welcome card and ignored the question. Root cause: `src/handler.js > processCustomerBatch` always sent the welcome card and `return`ed on the first message of every fresh conversation, regardless of whether the message had substantive content beyond the greeting. Fix: detect `firstMessageIsPureGreeting = handlerIsGreeting(combinedText)`. If TRUE → keep current behavior (welcome card, then return). If FALSE → send the welcome card AND fall through to the Opus reply path. A new `welcomeCardJustSent` flag bubbles into the `generateReply` call as an `expertContext` prefix: "WELCOME-ALREADY-SENT context: A welcome card with our addresses and contacts was just sent. Do NOT greet again. Do NOT repeat any address or phone number. Answer the customer's actual question directly in 1 to 2 short sentences." Net effect on the brother's case: customer now gets TWO outbound messages on first turn (welcome card + direct answer to "Is 16kWh Deye battery available?").

B. *BOS-B card shown at 5 modules per cluster.* Live case: 160 kWh BOM offered BOS-B as Option 2 at 10 modules in 2 clusters (5 per cluster) — violates BOS-B min 7. The rule was already in §9 four places (table notes, selection logic step 4, sanity checks, hard never) but the model bypassed it. Strengthened by adding a "STOP — pre-flight checks before sending ANY HV BOM" block at the top of §9 (right after the section intro, before the inverter table) listing the six most-violated rules numbered with explicit instructions to drop the card if any fails. BOS-B min 7 is rule #1.

C. *BOS-G option in BOM omitted the rack count and pricing.* Live case: BOS-G card listed Inverter / Battery / PDU but no Racks line. §5 BOM template already required a Racks line, but the model dropped it. Strengthened the BOM card spec in §5: every card MUST include all six lines (Inverter, Battery, Cluster split, Control Box, Racks, Cables) in order. Per-line price math (unit × qty) is now required when prices are in Warehouse Stock, with explicit fallback wording when rack pricing isn't on file: "Racks (19″): N (rack pricing confirmed with the team)". §19 hard nevers gained a matching entry banning BOM cards without a Racks line. Pre-flight rule #2 in §9 reiterates.

## 2026-05-13 morning Beirut — HV refinements: Nigerian address, HV trigger, BOS-G/B limits, Optimal module count (first push, e3d361f)

Tuned `src/prompts/system.md` with three owner-supplied refinements (no full prompt swap; targeted edits inside the existing v3 file). The pre-tune v3 was snapshotted to `docs/archive/system-v3-hv-configurator-2026-05-13.md` (518 lines, matches commit `bc4d1d4` on origin/main).

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

## 2026-05-12 evening Beirut — §9 HV configurator v3 swap

Swapped `src/prompts/system.md` to v3 with owner-supplied HV configurator content from the new "Deye HV Battery Selection" spec. The v2 distributor-counter prompt was archived to `docs/archive/system-v2-distributor-counter-2026-05-12.md`. Changes are confined to three sections, nothing else in the file touched:

- §5 Reply length and rhythm: added a second structured-reply shape, the *HV BOM card format*. Used when the customer asks for HV sizing. Format: one project-confirmation line, one BOM card per viable battery series (Inverter / Battery / Control Box / Racks / Cables), one-line recommendation. The existing generic "~50kW" example stays for non-HV configs.
- §9 Engineering principles: rewrote with concrete Deye HV product limits inlined instead of delegating everything to Datasheet Knowledge. New content: HV vs LV gate clarified ("HV vs LV is determined by the inverter selection, NEVER by battery capacity"; ≥30kW = HV, <30kW = LV). New inverter capacity table (SUN-30K/50K/80K with cluster inputs + max charge/discharge amps). New battery series table (BOS-G/A/B with module size + Min-Max per cluster, differentiated by paired inverter). New 5-step sizing logic replaces the old 4-step verification. New rules: drop unviable series silently, don't show calculations unless asked, parallel inverters only with the SAME model.
- §19 Hard nevers: added two entries. "Never show sizing math/cluster calculations/step-by-step reasoning in the reply unless the customer asks how you sized it." "Never offer or quote an HV battery option that violates the Min-Max range — drop it silently, don't announce it."

Live commit on origin/main BEFORE this prompt change: `1f2ef50` (datasheet marker fix).

## 2026-05-12 late afternoon Beirut — variant rule + HOT-alert fix on open-pending + fabricated-variant guard

Patched two recurring production bugs the brother flagged from live tests: (1) Sunny invented size+phase combos that don't exist in the warehouse ("20kW single-phase incoming within 20 days" when only 20kW 3-phase is stocked), and (2) HOT-lead alerts to the owner silently dropped on `notifyOwnerForEscalation` whenever an open `pending_queries` row existed (the second escalation got routed as a silent_query follow-up ping instead of a fresh `escalation_alert_hot`).

- `src/prompts/system.md` section 8 (Stock) extended with a strict VARIANT rule and an ETA discipline rule. Variant rule: if a SIZE+PHASE / SIZE+VOLTAGE combo doesn't have a matching row in Warehouse Stock, do NOT say it's incoming and do NOT invent an ETA; state the closest combo we DO carry. ETA rule: only quote ETAs that appear VERBATIM in `coming_note` / `eta_date` for the matched item; if no ETA on file, say "incoming" alone with no day count, no week phrase, no "soon", no "shortly". Section 19 (Hard nevers) gained two matching items.
- `src/classifier.js` got an unconditional HOT promotion: if the customer's CURRENT message body contains a `HOT_TRIGGER_RE` commitment phrase ("send me account", "i want to pay", "pay now", "send proforma", etc.), promote to HOT regardless of what the Sonnet classifier returned and regardless of what Sunny said previously. Logged as `classifier.commitment_phrase_force_promoted_to_hot`. Backstop covers the failure mode where the prior-Sunny-question regex `HOT_PROMPT_FROM_SUNNY_RE` missed (e.g. "Want to place a pre-order to secure a unit?" wasn't in the regex, so a "Yes send me account" affirmation didn't promote). Also widened `HOT_PROMPT_FROM_SUNNY_RE` to include "place a pre-order", "secure a unit", "lock it in", "want to (place|secure|reserve)", "pickup or delivery", "how would you like to pay", etc.
- `src/security.js` added `HOT_ESCALATION_COOLDOWN_MS` (default 60s, env override `HOT_ESCALATION_COOLDOWN_MS`) and `checkHotEscalationThrottle(contactId)`. HOT escalations now use the 60s throttle instead of the 30-min `ESCALATION_COOLDOWN_MS`. Reason: the regular cooldown was eating real HOT alerts when a customer escalated twice in the same 30-min window. A HOT signal must always reach the owner; the 60s cap is only to defang back-to-back identical retries.
- `src/handler.js > notifyOwnerForEscalation`: HOT routes through `checkHotEscalationThrottle` (60s), non-HOT through the regular 30-min throttle. HOT alerts also get one automatic retry after 1.5s if the first Meta send fails (`handler.escalation.hot_alert_first_send_failed_retrying`).
- `src/handler.js > processCustomerBatch` reply backstop: split into `HOT_HANDOFF_REPLY_RE` (HOT-specific markers like "account details and final figures", "send you the account") and the existing `HANDOFF_REPLY_RE` (generic team-follow-up markers). HOT backstop runs FIRST and is NOT satisfied by a silent_query follow-up ping having fired this turn — it requires `escResult.escalationType === 'hot_lead'` AND `ownerNotified=true`. If a HOT marker is in the reply and no hot_lead alert has fired this turn, fire one (source `hot_handoff_in_reply`). This is the bug that let "Yes send me account" get demoted to a silent-query follow-up ping on an old QID instead of escalating as a fresh HOT.
- `src/claude.js > detectFabricatedVariant`: new code-level guard. For every (size + phase + stock-state) claim in the generated reply, verify a matching row exists in `warehouse_items` (matching BOTH the size and the phase/voltage). If no match AND the surrounding context isn't a negation ("we don't have", "stops at", "only in three-phase", etc.), the reply is replaced with "Let me confirm the exact availability of that configuration with the team and get back to you shortly." Logs `claude.reply.fabricated_variant_blocked`. The deflection contains "get back to you shortly", which the existing reply-handoff backstop in `handler.js` then catches and escalates as silent_query so the owner is alerted, the customer gets a sane reply, and Sunny never communicates the hallucinated combo.

## 2026-05-12 midday Beirut — classifier swap (HOT/SERIOUS/COLD), system prompt v2, enriched owner alerts (d89ca2c)

Swapped both master prompts to owner-supplied versions and enriched owner escalation alerts. Three commits at this point:

- `ce8df82` Classifier prompt swap to HOT/SERIOUS/COLD/DISQUALIFIED/REPEAT_CLIENT vocabulary. Old C1-C5 schema archived at `docs/archive/classifier-v1-c1-to-c5-2026-05-12.md`. New `normalizeClassifierShape` in `src/classifier.js` derives the legacy `lead_temperature` from the new `category` (SERIOUS→WARM) so every downstream consumer keeps working without changes. Greeting fast-path and `FALLBACK_CLASSIFICATION` updated to new shape.
- `192a161` System reply prompt swap to "distributor counter rep v2". Old version archived at `docs/archive/system-v1-19sections-2026-05-12.md`. Key shifts: install discussion strict-refused under 30kW; 30kW+ routes to specialist for EPC; ALL negotiation escalates to human; HV defaults flipped to LV-first for residential; WARM renamed to SERIOUS.
- `d89ca2c` Owner escalation alerts now include typed headers (HOT/NEGOTIATION/REPEAT/BIG-PROJECT/FOLLOW-UP), customer signals, latest message, 6-turn conversation brief, an admin deep-link of the form `<PUBLIC_BASE_URL>/admin#conv=<id>`, and the customer wa.me link. New env var `PUBLIC_BASE_URL` (defaults to the Railway URL when unset). Admin SPA auto-selects the linked conversation on hash change.

Code adaptation backlog (new prompts reference these but the code does not yet honor them):
- Routing for `escalation_type='negotiation'` / `'repeat_complex'` / `'big_project'` currently falls through the silent_query pending-queries flow (header label is correct via `ESCALATION_HEADERS`, but routing is generic).
- `Active Promos`, `Big project context`, structured `Datasheet Knowledge` injection blocks not yet built.
- `contacts.category` rows now mix C1-C5 (legacy) with HOT/SERIOUS/COLD (new). Admin filters for C* still work for legacy rows.

## 2026-05-10 evening Beirut — warehouse stock rebuild, 19-section system.md, stock-quantity privacy, HOT-only owner alerts (88d5a84)

Per `docs/archive/agent-redesign-roadmap-2026-05-09.md`: commit `88d5a84` ships the agent redesign in seven steps:

1. **Warehouse Stock** is now the single source of truth for stock + price + datasheets. New top-level admin tab with per-item Abuja/Lagos panels (state in_stock/incoming/out_of_stock, quantity +/-, coming note, ETA date) and a per-item datasheet PDF upload. `formatWarehouseForPrompt()` replaces the catalog block in Sunny's prompt. Catalog table preserved but its prompt block is no longer injected.
2. **Knowledge tab stripped** to two sub-panels: **Rules** (editable per-prompt textareas with Save = git commit+push via GitHub Contents API, Deploy = Railway GraphQL `serviceInstanceRedeploy`) and **Models & config**. Live facts, Catalog, Datasheets sub-panels and the owner-DM teaching path retired. `teacher.md` dropped from the editor. Doctrine now lives entirely inside `system.md`.
3. **system.md restructured into 19 single-purpose sections** (407 lines, down from 621). Sections are: 1 Identity, 2 Posture, 3 Voice and tone, 4 Reply length and rhythm, 5 Pricing rules, 6 Negotiation forbidden, 7 Stock and availability, 8 Solar engineering, 9 Locations/pickup/delivery, 10 Escalation, 11 Dynamic context blocks, 12 Conversation state, 13 Multi-idea + anti-repeat, 14 How to read the customer, 15 Industry knowledge, 16 Worked examples, 17 Hard nevers, 18 Punctuation, 19 When unsure. Each section is editable independently from admin.
4. **Voice softened** to "warm Lagos salesman" tone. Brief acknowledgements ("Got it", "Glad to help", "Sure") explicitly allowed. Empty hype + AI-speak still banned. Reply-length cap loosened from "max 2 sentences" to "1 to 3 sentences with one optional follow-up question." Code-level trailing-question guard now fires only on pure acknowledgements (ok/noted/thanks/emoji), not on factual answers like "30kwh" or "Lagos".
5. **Stock quantity privacy.** Section 7 rule + section 17 hard never: the per-warehouse unit count in the Warehouse Stock block is INTERNAL ONLY. Default reply for stock questions is "in stock" / "out of stock" / "incoming, ETA <date>" with no numbers. Quantity is shared ONLY when the customer's requested quantity exceeds available stock (to gate the deal).
6. **Datasheet matcher gates on customer-named size.** `findItemDatasheetByQuery` extracts numeric size tokens ("80kw", "12.5kva", "16kwh") and requires the warehouse item to share that size before matching. Legacy single-item fallback removed. If the requested datasheet isn't attached, Sunny falls through to a text reply rather than sending the wrong PDF.
7. **Owner alerts pared to HOT-only.** `notifyOwnerForEscalation` returns early for anything that isn't `escalation_type='hot_lead'`. No silent_query pings, no follow-up alerts, no stall-guard pings, no QID tags, no pending_queries row creation. Alert format simplified to 4 lines: header + customer name/phone + their last message verbatim + customer wa.me link.

Bonus: **Customer-side wa.me link** is auto-appended on BOTH hot_lead and silent_query escalations (previously HOT-only). So the customer always has a one-tap path to reach the owner via `SPECIALIST_DIRECT_LINK`.

## 2026-05-08 day-long Beirut — WABA migration to Nigerian number, owner-alert end-to-end, datasheets, Owner Chat tab, auto-release, welcome card, HV engineering rules

Long session covering production migration off the Meta test number, an end-to-end fix for the owner-alert pipeline, two new admin features (Owner Chat tab, Datasheets sub-panel), the auto-release cron, the hardcoded welcome card, and the HV battery engineering rules.

**Production WABA migration (no commit, environment-only).**
- Brother created a new WABA "Sunny-Electrosun" id `986225450549617` in Meta Business Manager and added Nigerian number `+234 913 055 4747`. The original Test WABA `1713234916358524` was capped at one phone number and the test number cannot be deleted (Meta hard-locks test numbers to test WABAs), so the new WABA was the only path. Verification hit Meta's per-number SMS rate limit hard (took 3+ hours of cooldown and a switch to voice call to land the 6-digit code). Once verified, Sunny app was added under the new WABA's Apps tab.
- API steps performed: subscribed our app to `986225450549617` via `POST /<waba>/subscribed_apps`, registered the phone with Cloud API via `POST /<phone-id>/register` with PIN `271828` (`META_REGISTRATION_PIN` saved on Railway and local .env), updated `META_WABA_ID` and `META_PHONE_NUMBER_ID` on Railway, force-redeployed since env-only changes don't auto-trigger a rebuild on Railway, re-submitted both message templates against the new WABA (still pending Meta review). `/version` and `/api/brain` confirm `waba_id: 986225450549617`. `code_verification_status: VERIFIED`, `platform_type: CLOUD_API`, `quality_rating: GREEN`, display name "ELECTROSUN" still PENDING_REVIEW (1 to 3 business days; sending unblocked, customers see raw number until approved).

**Reply quality wave (commits 593fa27, 4444057, 648a766, 47a3c03, a1f110e, dd4524e).**
- 593fa27 catalog-enumeration block now triggers on customer LIST-ASK intent (price list, all your prices, full catalog, what do you have, send me your list, how much for everything, etc.) AND priceCount >= 3, instead of pure priceCount >= 5. Multi-item asks where the customer NAMED specific items (12kW + 16kW + 20kW) flow through with all prices. Replaced "I'll quote that one" first-person fallback with "The team will quote that one." Added a post-override duplicate guard at the very end of `generateReply` so byte-identical canned outputs after override blocks get caught (the original duplicate check ran BEFORE overrides and was bypassed).
- 4444057 trailing-question-strip gated behind "Sunny actually just asked a question". Walks history backward to last assistant turn; only fires if that turn ended with `?`. Customer "Hello" or "I'm looking for solar system" now keeps Sunny's qualifying question because Sunny had no prior question. Added Deye Platinum distributor credential to first greeting only. New rule banning naked "Noted" on interest signals.
- 648a766 greetings reset (`expertContext` suppressed on `isCasualGreeting=true` so a "Hi" doesn't anchor on yesterday's open pending query). Awaiting-expert block rewritten to a two-branch decision: FOLLOWING UP on the open query (third-person reassurance, no first-person stalls) vs. PIVOTING to a new topic (answer directly from catalog, ONE qualifier, no naked "Noted"). System prompt got concrete examples for "I want batteries" -> "We carry BOS-G 5.12kWh, BOS-A 7.68kWh, BOS-B Pro 16kWh. What capacity?".
- 47a3c03 HOT detection on "Yes" after "ready to pay?". New `isAffirmationAfterHotPrompt(history, body)` walks history backward for the last assistant message; if it matches `HOT_PROMPT_FROM_SUNNY_RE` (ready to pay / shall I send the account / best price + ready/pay / are you ready to / etc.) AND body matches `AFFIRMATION_RE` (yes/yeah/sure/ok/go ahead/absolutely/etc.), force-promote to HOT. The hasHotTrigger demotion is skipped when this fires.
- a1f110e dropped "home, business, or resale?" qualifier from greetings and interest signals; replaced with "How can I help?" / "What's the load you're sizing for?" / "What size system?". Negative rule "Do NOT ask 'home, business, or resale?'" added so Sunny does not regress.
- dd4524e admin Inbox preserves typed reply text + cursor + focus + scroll across the 15s polling re-renders. `renderConversationView` snapshots input value/focus/cursor and msg-list scrollTop before innerHTML rebuild, restores them on the new nodes after. Scroll: pinned to bottom if user was within 80px of it, restored to prior position otherwise.

**Owner-alert reliability wave (commits 95afd23, 79c58bf, 3b9567c, b5dd0f6).**
- 95afd23 stall-language guard expanded to catch third-person handoff phrases ("the team will confirm", "a specialist will reach out", "the team is finalising", "our specialist is checking", "team member will follow up"). The original regex only caught first-person stalls; after the awaiting-expert rewrite Sunny started using third-person handoffs by default, which then bypassed the guard and never paged the brother. 10/10 smoke cases pass. Same commit also fixed `claude.reply.dup_check_fail "no such column: contact_id"` SQL error (replaced bad clause with `direction = 'outbound' AND conversation_id IN (...)`).
- 79c58bf High Voltage battery + inverter engineering rules added to system.md as a permanent section. BOS-G PDU range 5 to 12 packs, BOS-A max 21 with 80kW HV / max 16 with 30 or 50kW HV, BOS-B max 16 with 80kW HV or PCS / max 13 with 30 or 50kW HV. HV batteries must always include matching same-series PDU/BMS/Cluster Box, never mix series. Default to LV unless customer explicitly asks for HV or project clearly requires it. Same content also seeded as 7 active knowledge facts (ids 831 to 837) so the brother can edit limits via admin if needed.
- 3b9567c hardcoded WELCOME_REPLY constant in handler.js. On the first greeting from a contact with no prior outbound from us, send the verbatim multi-line card (Welcome to Electro-Sun Global Services, *Abuja Address* office + warehouse, Contact line with Charbel and Patrick numbers, *Lagos Address:* Guardian Newspapers Rutam House) and return early. Bypasses Opus and all output guards because Patrick's number IS the OWNER_WHATSAPP digits 2347041328055; a Sunny-generated welcome would trip the owner-number-leak detector. Subsequent greetings fall through to normal Opus reply.
- b5dd0f6 HOT_TRIGGER_RE expanded to catch "can i pay" / "send me account" / "send account" / "account details please" / "i am proceed" / "going to pay" / "wanna pay" / "wants to pay" / "payment now" / "book now" / "order now" patterns. Plus a new auto-link append: when Sunny's reply mentions specialist handoff (HANDOFF_REPLY_RE) the wa.me direct link is appended even if classifier did not flag HOT. So even if HOT detection misses, the customer always has a direct line when handoff language appears in the reply.

**Admin features wave (commits 415b43a, 385df6c, 33716c9, 8661ea9, 7338652).**
- 415b43a auto-release on human idle. New `answerPendingForContact(contactId)` re-queues the latest unanswered customer message for the contact through the normal pipeline. Wired into manual `/release` endpoint as fire-and-forget. New `autoReleaseStaleHumanConversations(thresholdMinutes)` scans `human_handled=1` conversations, releases any whose `max(human_handled_at, last_human_reply_at)` is older than the threshold, calls `answerPendingForContact` for each. Cron: every 5 min, registered OUTSIDE the `DISABLE_NOTIFICATIONS` gate (it's customer-pipeline, not reporting). Tunable via `HUMAN_AUTO_RELEASE_MINUTES` env (default 15). Logs `cron.auto_release.registered`, `cron.auto_release.done`, `handler.auto_release.fired`, event `conversation_auto_released`.
- 385df6c Owner Chat tab in admin. New top-level nav item between Contacts and Knowledge. New `<section id='view-owner'>` with header (Owner / Patrick + phone + message count) and message thread. New `GET /api/owner-chat?limit=N` returns all messages for the owner contact joined to conversations, ordered chronologically. Read-only, polls every 15s. Reuses `msgHtml()` so bubbles look identical to inbox.
- 33716c9 fixed /owner-chat 500 (the SELECT referenced `m.kind` which does not exist on the messages table, and used `m.created_at` instead of `m.timestamp`). Replaced columns with the actual schema.
- 8661ea9 owner-alert persistence. `notifyOwnerEscalation` and the follow-up ping in `notifyOwnerForEscalation` now persist their outbound message to the owner's conversation with `intent='escalation_alert_hot'` / `'escalation_alert_silent'` / `'escalation_followup_ping'`. Before this fix, alerts were sent successfully but never recorded locally, so the new Owner Chat tab missed every RED/YELLOW alert. Wrapped in try/catch so DB write failure logs `escalation.persist_owner_alert_fail` without breaking delivery.
- 7338652 datasheets module. New `datasheets` table in db/schema.sql (idempotent CREATE TABLE IF NOT EXISTS). New `src/datasheets.js` with CRUD + token-overlap matching + Meta media TTL handling (refresh after 25 days since Meta expires media at 30). New `src/whatsapp.js > uploadMediaToMeta` and `sendDocument`. New admin `Datasheets` sub-panel under Knowledge: upload form (label, keywords, file, client-side base64), list with Download/Edit/Archive. Auth middleware now also accepts `?key=` query param so download links work directly in the browser. New `src/handler.js` datasheet fast-path: `DATASHEET_REQUEST_RE` detects "datasheet"/"brochure"/"spec sheet"/"specifications"/"manual" etc., looks up matching sheet, uploads to Meta on first send (cached after), sends WhatsApp document with caption "<label> -- datasheet from Electro-Sun", appends `intent='datasheet_sent'` outbound row, returns early. Falls through to normal reply on no match or send failure. Datasheet inventory injected into Sunny's prompt via `formatDatasheetsForPrompt()`.

**OpenAI Whisper key (no commit).**
Brother provided a key but Whisper returns HTTP 401 ("Incorrect API key provided"). Same key against `https://api.openai.com/v1/models` from Serge's Terminal also returns 401, confirming the key itself (not Railway) is the issue. Most likely no billing credit on the OpenAI account. Voice notes still flow through (download succeeds, transcription fails gracefully) but the customer gets the polite "couldn't transcribe" fallback instead of an actual reply to the audio content. Resolution path: add $5 credit at https://platform.openai.com/settings/organization/billing/overview OR generate a new non-project full-access key, then `railway variables --set "OPENAI_API_KEY=sk-..."` + `railway redeploy --yes`.

**Files touched all session.** `src/claude.js`, `src/classifier.js`, `src/handler.js`, `src/whatsapp.js`, `src/security.js`, `src/datasheets.js` (new), `src/prompts/system.md`, `db/schema.sql`, `api/dashboard.js`, `public/admin.html`, `server.js`, `CLAUDE.md`, `docs/session-history.md`. Plus 11 active knowledge facts added (ids 827-837 covering stock updates and HV rules).

**Verified live.** Diagnostic ping to brother returned HTTP 200 with messageId. Real F18 escalation alert (QID:19) created and `alert_message_id` set, confirming Meta accepted delivery. Real HOT lead at 14:42 UTC for contact 1 fired, alert sent to owner_tail 8055 with `whatsapp.send.ok`. Owner Chat tab renders without 500. Datasheets API returns 200 empty list. No `ERROR`-level entries in last 1500 log lines after the latest deploy.

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

