# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

Detailed session-by-session changelog lives in `docs/session-history.md`. That file is the audit trail for "what shipped when and why"; this file is the always-true reference for what is currently in the codebase and what rules govern Sunny's behavior.

## Current launch status (paused 2026-05-05 evening Beirut)

Phase 1 (Setup), Phase 2 (Local end-to-end test), Phase 3 (Tune), Phase 5 (Cloud deploy) are closed. Phase B code work is closed: schema migration, 2-hour reports with HOT/WARM/COLD aggregations, silent-query workflow with reply-to routing, daily learning report, owner Q&A, knowledge ingestion, image vision, voice-note transcription, WhatsApp call auto-reply, conversation-state engine, multi-message debounce, orphan recovery on startup, code-level reply guards (price-strip, trailing-question-strip, repeat guard, wa.me link ban). Task #15 (48-hour soak) is the next user-driven launch step.

**Phase 5 is cloud-first** (Railway production). PM2 + named tunnel are no longer in the production path; PM2 stays in the repo as a local-dev fallback only. See `memory/project_cloud_first_decision.md`.

**Live state on Railway:**
- URL: https://sunny-electrosun-production.up.railway.app
- Volume `/data` mounts the SQLite DB at `/data/sunny.db` and media at `/data/media/`.
- `OWNER_WHATSAPP=2347041328055` (brother). Verified via `/version` → `owner_whatsapp_tail: "8055"`.
- `DISABLE_NOTIFICATIONS=true` (kill switch ON: cron schedules don't even register at boot). Customer chat still flows normally. Re-enable with `railway variables --set "DISABLE_NOTIFICATIONS=false"`.
- All four model env defaults are `claude-opus-4-7` (classifier, reply, teacher, owner_qa).
- `DAILY_LLM_BUDGET_USD=20` (raised from $5 to absorb Opus pricing).
- `DISABLE_ESCALATIONS=false` (kill switch available, not engaged).

**Source of truth:** https://github.com/sergeadaimy-hash/sunny-electrosun (private). Pushes from Claude's non-interactive shell hang on the credential prompt; Serge pushes manually with `git push` from his Terminal or `! git push` syntax in chat. Latest commit per `git log`: `b07bcd8`.

**Resume plan:**
- Waiting on brother: pricing data for Sungrow / JA / Longi; Section 11 decisions (working hours, location tags, currency, default warranty/delivery copy, after-hours reply, competitor pricing doctrine); real WhatsApp business number (Task #17 full).
- User-driven: Task #15 48-hour soak with 3-5 testers; re-check Meta template approval status (`node scripts/check_templates.js`).
- Code nice-to-haves (not blocking): hot-lead alert with Haiku/Opus conversation summary; admin "approve to permanent fact" button on daily learning items; per-contact avatar color hashing; image inline rendering in admin; RAG-style fact retrieval if knowledge base exceeds the 500-fact cap; re-enable owner teaching from WhatsApp with intent disambiguation.

## Current operational rules and configuration

This section captures behavior rules and runtime config that are LIVE in the codebase right now. The deeper "why we shipped this" notes are in `docs/session-history.md`.

### Voice and reply discipline (enforced in `src/prompts/system.md`)

- **No double dashes anywhere.** Permanent user rule (2026-04-26). No em-dash, en-dash, or `--`. Applies to chat replies, prompts, code comments, commit messages, every artifact. CSS custom properties (`--cream`) are the only allowed exception.
- **No compliments, no AI-speak, no subjective phrases.** Banned: "Great", "Excellent", "Awesome", "Perfect", "I'd be happy to help", "I love that", "I understand", "I see", "Let me help you with that", "Feel free to", "Hope this helps", "Just to clarify", "Certainly", "indeed", "moreover", "delve". No unsolicited adjectives on the customer's project. Tone: Lagos sales floor.
- **HARD BAN on trailing questions.** When customer gives a short factual answer (≤40 chars, no `?`), Sunny acknowledges and STOPS. Never squeezes another question. Code-level guard in `src/claude.js` strips trailing question sentences if the prompt rule is violated.
- **Reply length: max 2 short sentences by default.** No bullet lists, no proactive education, no multi-paragraph essays. `max_tokens=180` in `src/claude.js`.
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
- `dispatchEscalation` (in `src/handler.js`): single entry point for sending the customer holding reply + alerting the owner. Behavior:
  1. If an open `pending_queries` row already exists for this contact (`getOpenPendingQueryForContact`), send a "Follow-up on [QID:N], same customer is still asking" message to the owner (throttled by `checkFollowupThrottle`), do NOT create a new pending_queries row, do NOT touch the main escalation throttle. The brother replies to the original [QID:N] alert.
  2. If no open pending query, fall through to `checkEscalationThrottle`. If allowed, create the pending_queries row and send the regular alert. If throttled, return false so the caller falls back to a normal reply.
  Reason: the original throttle silenced legitimate follow-up pings during an active query, so Sunny invented "let me check / will get back" stalls (see "stall guard" below). Opening this side channel keeps the throttle's anti-spam defense for fresh escalations while letting the brother see urgency rise on an already-known query.

**Output-side guards (in `src/claude.js > generateReply`):** see "Code-level reply guards" above, items 5-8.

**Stall-language guard (in `src/handler.js > processCustomerBatch`):** after `generateReply` returns, before sending, `security.detectStallLanguage(reply.text)` checks for first-person stall patterns ("let me check / I'll confirm / will revert / will get back to you / one of our sales engineers will reach out / give me a moment"). If matched AND `DISABLE_ESCALATIONS=false`:
- Force `escalation_type='silent_query'` and call `dispatchEscalation` with `source='stall_guard'`. The customer gets the canned `SILENT_QUERY_REPLY` and the brother gets a follow-up [QID:N] ping (or a fresh alert if no open query).
- If the dispatch is blocked (no open query AND main throttle in cooldown), the reply is replaced with `SILENT_QUERY_REPLY` and no alert is sent. Logs `handler.stall_replaced_no_alert`.
The canned replies themselves use third-person ("A specialist will confirm...") and are not matched. Reason: Opus sometimes invented "I'll check and get back" promises after the 30-min throttle blocked a re-escalation, leaving the customer hanging without the owner being notified.

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
| `RATE_LIMIT_PER_MINUTE` | Per-contact message rate limit (default 15). Owner exempt. Blocked messages dropped without persistence or reply. |
| `RATE_LIMIT_DAILY` | Per-contact daily message cap (default 300). Owner exempt. |
| `MAX_SINGLE_MESSAGE_CHARS` | Per-message inbound truncation limit (default 2000). |
| `MAX_COMBINED_BATCH_CHARS` | Debounced batch truncation limit (default 4000). |
| `ESCALATION_COOLDOWN_MS` | Per-contact BRAND-NEW escalation cooldown (default 1800000 = 30 minutes). Repeat first-time triggers within the window demote to a normal reply. Does NOT apply when an open pending_queries row already exists for the contact (the follow-up channel takes over). |
| `FOLLOWUP_COOLDOWN_MS` | Per-contact follow-up-alert cooldown for the open-pending-query path (default 300000 = 5 minutes). Bounds how often the brother gets "same customer still asking on [QID:N]" pings. |
| `MAX_IMAGES_PER_DAY` | Per-contact daily image-vision quota (default 10). When exceeded, images flow through as text markers, vision is skipped. |

### Models, costs, and budget

- All model defaults: `claude-opus-4-7` (classifier, reply, teacher, owner_qa).
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
| `src/catalog.js` | catalog_items + catalog_notes CRUD. `formatCatalogForPrompt()` renders the live catalog as Markdown for each reply. Editable from admin Catalog tab. |
| `src/cost_tracker.js` | `recordUsage` after every Anthropic response; `isOverBudget` short-circuit. |
| `src/window_monitor.js` | `*/30 * * * *` cron. Past 22h: one-time reminder to owner. Past 24h: marks status='expired' and alerts owner. Idempotent via `expiring_warning_sent_at`. |
| `src/transcribe.js` | OpenAI Whisper wrapper for voice-note transcription. Falls back to "[Customer sent a voice note that could not be transcribed]" if OPENAI_API_KEY missing. |
| `src/whatsapp.js > downloadMedia(mediaId)` | Two-step Meta media download (metadata GET → signed URL GET with auth, 25MB cap, 30s timeout). |
| `src/handler.js > handleOwnerNonQueryMessage` | Routes brother's WhatsApp messages to `answerOwnerQuestion`. Owner replies to alerts (`msg.replyToId` matching pending QID) still route via `handleOwnerReply`. |
| `src/handler.js > recoverOrphanedInbound(maxAgeMinutes)` | Scans inbound messages without a subsequent outbound reply (and not human_handled, not from owner) and re-queues them through the normal pipeline. Called 3s after `app.listen`. Default 10 minutes. Bug it fixes: in-memory debounce queue is wiped on container restart. |
| `src/handler.js` debounce queue | Per-contact in-memory queue, fires once per `MESSAGE_DEBOUNCE_MS` window. Persists each message to DB immediately for admin visibility. |
| `src/handler.js > handleUnsupported` (legacy) | Polite "text only" fallback for unsupported message types. Voice notes now flow through transcribe instead. |
| `src/handler.js` calls handler | When Meta delivers a `calls` webhook event, auto-sends "Hello, this number isn't monitored for voice calls. Please send a text message and the Electro-Sun team will respond." Throttled per-caller to once per hour. Logs `call_received`. Note: Meta's Calling API is in beta. |

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
- **`catalog_items`**: `brand`, `model`, `price_naira`, `stock`, `notes`. Seeded from `src/knowledge/products.json` on first boot only.
- **`catalog_notes`**: free-form catalog notes (PDU stacking limits, etc.).

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
- **Knowledge**: four sub-panels.
  - Live facts: filterable, editable owner-taught facts with Edit / Approve / Reject / Delete.
  - Rules: read-only render of `system.md`, `classifier.md`, `teacher.md`.
  - Catalog: fully editable (brand/model/price/stock/notes); Add new; editable note list.
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
