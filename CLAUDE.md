# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

## Current launch status (paused 2026-05-03 evening Beirut)

Phase 1 (Setup), Phase 2 (Local end-to-end test), Phase 3 (Tune) are closed. Phase B code work (separate from launch sequence) substantially closed in the same session: schema migration, 2-hour reports with HOT/WARM/COLD aggregations, silent-query workflow with reply-to routing, daily learning report, seed.js modernization. Task #15 (48-hour soak) is the next user-driven launch step.

**Phase 5 is cloud-first** (Railway or Fly.io, NOT Mac Mini). PM2 + named tunnel are no longer in the production path. See `memory/project_cloud_first_decision.md`.

**Source of truth:** https://github.com/sergeadaimy-hash/sunny-electrosun (private). Origin is in sync with local main as of 2026-05-04 (the 14 queued commits were pushed). Latest commit before this session: `ffcaac6`. Reminder: pushes from Claude's non-interactive shell hang on the credential prompt; Serge pushes manually with `git push` from his Terminal or `! git push` syntax in chat.

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

## Mission

Sunny is an AI-powered WhatsApp Account Manager for **ElectroSun**, a solar energy supply agency in Nigeria. Sunny answers every inbound WhatsApp message in the customer's own language, explains ElectroSun's services, qualifies leads, categorizes contacts, sends hourly reports to the owner, and stores everything behind a clean REST API ready for a future web dashboard.

## Who is who

- **Project owner**: Serge (builder, technical lead).
- **End client**: Serge's brother, who runs ElectroSun.
- **Production host**: Mac Mini M4 in the office.
- **First production phone number**: ElectroSun's verified WhatsApp Business number (TBD at launch).

## Tech stack (locked, do not deviate without asking)

- **Runtime**: Node.js 20+ on macOS (Mac Mini M4 in production, same machine for dev).
- **Framework**: Express.js.
- **Database**: SQLite via `better-sqlite3` (synchronous, single file at `db/sunny.db`).
- **WhatsApp**: Meta WhatsApp Cloud API (official, NOT Twilio, NOT unofficial libs). Graph API version `v21.0`.
- **LLM**: Anthropic Claude API.
  - `claude-haiku-4-5` for classification (fast, cheap, strict JSON output).
  - `claude-sonnet-4-6` for reply generation (smarter, on-brand voice).
  - Prompt caching enabled on the system blocks via `cache_control: { type: 'ephemeral' }`.
- **Scheduler**: `node-cron`.
- **Email fallback**: `nodemailer` (used only if owner's WhatsApp report fails).
- **Tunnel for local webhook**: Cloudflare Tunnel (preferred) or ngrok.
- **Process manager**: PM2 (`ecosystem.config.js`) for autostart on Mac Mini boot.

Do not add any dependency that is not in the list above without explicit approval.

## Folder structure

```
sunny/
├── .env                         # NEVER commit. Real secrets live here.
├── .env.example                 # Reference of required keys.
├── .gitignore
├── package.json
├── server.js                    # Express app + cron registration + startup checks.
├── ecosystem.config.js          # PM2 process config.
├── db/
│   ├── schema.sql               # Single source of truth for the schema.
│   ├── init.js                  # Initializes DB with WAL + foreign keys, exports getDb().
│   └── sunny.db                 # Generated, gitignored.
├── src/
│   ├── webhook.js               # Express router: GET /webhook (Meta verify) + POST /webhook (signed inbound).
│   ├── whatsapp.js              # Graph API send: sendMessage(to, body), sendTemplate(to, name, lang, components).
│   ├── claude.js                # classify() and generateReply(), with retries and JSON parse fallback.
│   ├── classifier.js            # Wraps classify(): updates contact category and lead_data, logs category_changed.
│   ├── memory.js                # Contacts + conversations + messages + events. ISO timestamps everywhere.
│   ├── handler.js               # handleInbound(payload): parse, idempotency, classify, escalate or reply, persist.
│   ├── reports.js               # Hourly + daily aggregation, formatting, send via WhatsApp first, email fallback.
│   ├── prompts/
│   │   ├── system.md            # Sunny's personality. Editable, no code restart needed beyond a process restart.
│   │   └── classifier.md        # Strict JSON classifier rules.
│   └── utils/
│       ├── logger.js            # Console + rotating file at logs/sunny.log (5MB rotations, 5 kept).
│       └── verifySignature.js   # HMAC-SHA256 of raw body using META_APP_SECRET.
├── api/
│   └── dashboard.js             # Express router mounted at /api. Requires X-API-Key header.
├── scripts/
│   └── seed.js                  # Demo data for testing the dashboard.
├── presentation/
│   └── sunny-overview.html      # Stakeholder-facing brochure. Self-contained, print-ready.
└── logs/                        # sunny.log, daily DB snapshots, PM2 logs.
```

The project folder path contains a space: `/Users/sergeadaimy/Desktop/Claude Projects/Sunny-Whatsapp Account Manager`. Always quote it in shell commands.

## How a message flows (the pipeline)

1. Customer sends a WhatsApp text to ElectroSun's number.
2. Meta POSTs to `/webhook` with `X-Hub-Signature-256` header.
3. `src/webhook.js` reads the raw body (captured by an `express.json` `verify` callback so HMAC computation matches what Meta signed) and calls `verifyMetaSignature`. Mismatched signatures get a 403. The webhook returns 200 immediately, then processes asynchronously to be friendly to Meta retries.
4. `handler.js > handleInbound(payload)`:
   1. Extracts text messages only. Non-text types are logged and ignored.
   2. **Idempotency**: looks up `whatsapp_message_id` in `messages`. If already stored, skips (Meta retries failed webhooks).
   3. `getOrCreateContact(phone, profileName)`.
   4. `getActiveConversation(contactId)` opens a new conversation if the last message was more than 24 hours ago.
   5. Reads the prior history (last 20 messages) BEFORE persisting the new one.
   6. Persists the inbound message.
   7. Calls `classifier.runClassification()` which calls Haiku, parses JSON, retries once on parse failure, falls back to a safe `explorer + needs_escalation: true` if Claude fails entirely. It updates the contact's category, language, and lead_data fields (only fills in nulls, never overwrites existing values).
   8. **Branch A (escalation)**: logs `escalated` event, alerts owner via WhatsApp with full context, sends the customer a short holding reply in their detected language.
   9. **Branch B (auto-reply)**: calls Sonnet via `generateReply(history, message, contact)`. The system prompt is `src/prompts/system.md` plus a "Known about this customer" block built from the contact row. If Sonnet fails, falls back to the holding reply.
   10. Sends the reply via `sendMessage`, persists outbound message with the returned WhatsApp message ID.

5. Hourly cron (`0 * * * *` UTC) generates an hourly report and sends it to the owner.
6. Daily cron (`0 21 * * *` Africa/Lagos) generates a 24h report, sends it, then snapshots `db/sunny.db` to `logs/sunny_YYYY-MM-DD.db`.

## Database schema and conventions

Schema lives in `db/schema.sql`. Tables: `contacts`, `conversations`, `messages`, `events`, `reports`. Indexes include a partial unique index on `messages.whatsapp_message_id` (only when not null) for idempotency.

**Timestamp convention**: every timestamp written by application code is an **ISO 8601 string** (`new Date().toISOString()`). Do NOT rely on SQLite's `CURRENT_TIMESTAMP` default for new rows because it produces `'YYYY-MM-DD HH:MM:SS'` (no `T`, no `Z`) which sorts wrong against ISO strings in range queries. The schema keeps the defaults for safety, but every INSERT in code passes an explicit ISO timestamp.

**Conversation rollover**: a new conversation row is opened if the latest one's `last_message_at` is older than `CONVERSATION_WINDOW_MS` (24 hours). Defined in `src/memory.js`.

**History shape for Claude**: `getRecentHistory(contactId, limit=20)` returns an array of `{role, content}` objects with **alternating roles enforced**. Consecutive same-role messages (e.g. customer sends two texts before Sunny replies) are merged into one with newline joins. The Anthropic API requires alternation.

**Lead data merge rule**: `classifier.js` only fills in lead fields (`name`, `location`, `use_case`, `load_estimate`, `timeline`) when the contact's existing value is null. We never overwrite a known value with a possibly noisier later guess.

## Environment variables

All listed in `.env.example`. Required at runtime:

| Key | Purpose | Required for |
|---|---|---|
| `META_VERIFY_TOKEN` | Random string. Must match the value pasted into Meta's webhook config. | Webhook GET handshake |
| `META_ACCESS_TOKEN` | Bearer token for Graph API. Use the 24h temp token for dev, a permanent System User token in production. | All outbound WhatsApp |
| `META_PHONE_NUMBER_ID` | The Meta-issued ID for the sending number. | All outbound WhatsApp |
| `META_APP_SECRET` | Used to verify `X-Hub-Signature-256`. If unset, signature checks are SKIPPED and a startup warning is logged (dev only). Production must set this. | Webhook signature verification |
| `ANTHROPIC_API_KEY` | Claude API key. | Classification and replies |
| `OWNER_WHATSAPP` | E.164 digits, e.g. `2348012345678`. Receives escalation alerts and reports. | Owner notifications |
| `OWNER_EMAIL` | Email fallback when WhatsApp report fails. | Email fallback |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials for the email fallback. Optional. | Email fallback |
| `PORT` | Express port. Defaults to 3000. | Server |
| `API_KEY` | Required by `/api/*`. If unset, every API call returns 503. | Dashboard API |
| `DAILY_LLM_BUDGET_USD` | Soft daily cap. Currently a placeholder, NOT YET enforced. | Future cost guardrail |
| `DB_PATH` | Optional override of the SQLite file location. Defaults to `db/sunny.db` inside the repo. Set to `/data/sunny.db` on Railway (volume mount). | Cloud deploy |
| `META_WABA_ID` | WhatsApp Business Account ID for template management. Default `1713234916358524`. | Template submissions |

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

The `cloudflared` quick-tunnel URL changes every restart. For production use a named tunnel with a stable hostname.

## Cron schedule

Defined in `server.js`:

- `0 * * * *` (UTC) hourly: `generateHourlyReport()` then `sendOwnerReport(report)`.
- `0 21 * * *` (Africa/Lagos timezone) daily: `generateDailyReport()` then `sendOwnerReport(report)`, then `snapshotDb()` copies `db/sunny.db` to `logs/sunny_YYYY-MM-DD.db`.

## Dashboard API

Mounted at `/api`. Every endpoint requires header `X-API-Key: <process.env.API_KEY>`. Returns 401 on mismatch, 503 if `API_KEY` is not set on the server.

- `GET /api/contacts?category=&from=&to=&limit=&offset=` paginated list, ordered by `last_active DESC`.
- `GET /api/contacts/:id` single contact + all conversations + all messages + last 50 events.
- `GET /api/stats/today` counts since UTC midnight.
- `GET /api/stats/range?from=&to=` same shape over an arbitrary ISO window.
- `GET /api/reports/latest?type=hourly|daily` most recent persisted report (default `hourly`).
- `GET /api/reports?from=&to=&type=` list of reports.

Plus `GET /health` (no auth) returns `{status, uptime_seconds, timestamp}`.

## Prompts: where to tune Sunny's voice

Two files, edited like English prose, no code changes needed:

- `src/prompts/system.md`: Sunny's personality, tone rules, what she can answer, what she escalates, format rules, escalation phrase. Edit and restart the server.
- `src/prompts/classifier.md`: strict JSON schema, category definitions, escalation triggers. Edit and restart.

Both files are read once at module load via `fs.readFileSync`. A process restart picks up changes.

## Languages

Sunny detects from the customer's first message and replies in the same language throughout:

- English (default fallback).
- Nigerian Pidgin.
- Hausa.
- Yoruba.
- Igbo.

Holding reply text per language is hardcoded in `src/handler.js > HOLDING_REPLIES`. The classifier returns the detected language as `english | pidgin | hausa | yoruba | igbo | other` and that drives which holding reply is used when escalating.

## Categories and escalation rules

Categories returned by the classifier:
- `new_client` (first ever message)
- `serious_buyer` (requires AT LEAST TWO of: location shared, load details, timeline, payment discussion, scheduling request)
- `explorer` (general questions, no commitment)
- `queries_only` (info seeking, no buying intent)
- `returning_customer` (mentions past install or service)
- `spam` (not solar related, scams, bulk marketing, jobs)

Default to `explorer` when uncertain.

`needs_escalation: true` triggers the human alert path. The classifier sets it true when:
- Specific pricing requested.
- Complaint or warranty claim.
- Custom system design request.
- Confidence below 90.

If Claude fails entirely, the fallback classification has `needs_escalation: true` so we err on the side of human review.

## Hard rules (do not violate)

1. **No double dashes anywhere.** This is a permanent user preference (set 2026-04-26). No em-dashes (`—`), no en-dashes (`–`), no ASCII `--`. Applies to: chat replies, prompts, code comments, commit messages, README, slide copy, every single artifact. Use commas, periods, colons, parentheses, or semicolons. The only allowed `--` substrings are CSS custom property names (`--cream`, etc.) which are syntactically required. Before writing any text or code, scan for these characters and rewrite.
2. **Never invent specs, prices, model numbers, or timelines** in customer replies. Sunny escalates whenever uncertain. Confirmed prices in Naira only.
3. **Never overwrite known lead data** with later guesses. Fill nulls only.
4. **Idempotency is mandatory** on `whatsapp_message_id`. Meta retries failed webhooks. Duplicate processing must be a silent skip, not an error.
5. **Webhook signature verification** is required in production. The current dev convenience of skipping it when `META_APP_SECRET` is unset must be removed before public launch (or production deployment must always set the secret).
6. **Do not auto-deploy or auto-commit** anything. Builder runs deploys manually.
7. **Ask before installing any dependency** not in the locked tech stack list above.
8. **Stay inside the 24-hour window** for free-form replies. Outside that window, only pre-approved Meta message templates can be sent. Templates are NOT YET implemented (see TODO).
9. **Never expose `API_KEY`, `META_*`, or `ANTHROPIC_API_KEY`** in logs, error responses, or any user-facing output.

## Build status

**Done and verified locally**:
- Folder structure, `package.json`, `.env.example`, `.gitignore`.
- `db/schema.sql` and `db/init.js` (WAL mode, foreign keys, idempotency index).
- `src/utils/logger.js` (rotating file logger).
- `src/utils/verifySignature.js` (HMAC SHA-256, timing-safe compare).
- `src/whatsapp.js` (sendMessage, sendTemplate).
- `src/webhook.js` (GET verify, POST signed handler, async processing).
- `src/memory.js` (contacts, conversations, messages, events, history collapse).
- `src/claude.js` (classify with retry + JSON parse fallback, generateReply with prompt caching, exponential backoff with jitter on retriable errors).
- `src/classifier.js` (category change events, lead_data merge).
- `src/handler.js` (full inbound pipeline including escalation alerts).
- `src/reports.js` (hourly + daily aggregation, WhatsApp formatting, WhatsApp + email send).
- `api/dashboard.js` (all REST endpoints, X-API-Key auth).
- `server.js` (Express, cron, health, startup checks, graceful shutdown).
- `ecosystem.config.js` (PM2).
- `scripts/seed.js` (4 demo contacts).
- `presentation/sunny-overview.html` (stakeholder brochure).
- Local end-to-end smoke test: webhook GET verify, signed POST round-trip (good and bad sigs), seed + dashboard reads, hourly report generation.

**Not yet done**:
- Real WhatsApp test with Meta test number (requires `.env` filled with Meta credentials).
- 5-language live test.
- Soak test with real users.
- Meta business verification for ElectroSun (1 to 14 days lead time).
- Permanent System User access token for production.
- Message template submission and approval (24 to 48 hours per template):
  - `follow_up_24h_en` (re-engage silent leads).
  - `owner_hourly_report_en` (deliver reports outside the 24h window).
  - Optional: language variants.
- Stable named Cloudflare Tunnel with a real hostname.
- PM2 install and `pm2 startup` registration on the Mac Mini.
- `DAILY_LLM_BUDGET_USD` enforcement in `src/claude.js` (currently just an env value).
- Web dashboard frontend on top of the existing API.
- "Human took over" flag on escalations so reports can show resolution.

## Deployment (Mac Mini, PM2)

```bash
cd "/Users/sergeadaimy/Desktop/Claude Projects/Sunny-Whatsapp Account Manager"
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# Run the sudo command pm2 prints. Once.
```

Useful PM2 commands:
- `pm2 status` health snapshot.
- `pm2 logs sunny` tail logs.
- `pm2 restart sunny` after a code or `.env` change.
- `pm2 stop sunny` emergency rollback to silence Sunny without uninstalling.

## Stakeholder-facing artifacts

- `presentation/sunny-overview.html`: single-file illustrated brochure for ElectroSun management. Self-contained, print-ready, no external dependencies. Open in any browser, or print to PDF for sharing. Built with the frontend-design agent. Reflects the actual implemented behavior, not aspirational features.

## Cost guardrails (current and planned)

- Haiku classification: about $0.0005 per message.
- Sonnet reply: about $0.003 to $0.01 per reply (depends on history length and reply length).
- Per 1,000 conversations roughly $5 to $15.
- `DAILY_LLM_BUDGET_USD` is in `.env` and intended as a soft daily cap. Enforcement in `src/claude.js` is a TODO: before each Claude call, sum the day's token usage cost from a ledger (or from the Anthropic Usage API), and short-circuit to a holding message if over budget.

## When in doubt

- If a behavior is ambiguous, **ask the project owner**. Do not guess.
- If a customer reply might invent facts (specs, prices, timelines, warranty terms, installation dates), escalate.
- If a code change requires a new dependency, **ask first**.
- If something looks like in-progress work or unfamiliar files, **investigate before deleting or overwriting**.
- Treat Meta retries, Claude rate limits, and SMTP failures as expected events, log them, do not crash.
