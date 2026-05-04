# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

## Current launch status (paused 2026-05-03 evening Beirut)

Phase 1 (Setup), Phase 2 (Local end-to-end test), Phase 3 (Tune) are closed. Phase B code work (separate from launch sequence) substantially closed in the same session: schema migration, 2-hour reports with HOT/WARM/COLD aggregations, silent-query workflow with reply-to routing, daily learning report, seed.js modernization. Task #15 (48-hour soak) is the next user-driven launch step.

**Phase 5 is cloud-first** (Railway or Fly.io, NOT Mac Mini). PM2 + named tunnel are no longer in the production path. See `memory/project_cloud_first_decision.md`.

**Source of truth:** https://github.com/sergeadaimy-hash/sunny-electrosun (private). Origin is in sync with local main as of 2026-05-04 (the 14 queued commits were pushed). Latest commit before this session: `ffcaac6`. Reminder: pushes from Claude's non-interactive shell hang on the credential prompt; Serge pushes manually with `git push` from his Terminal or `! git push` syntax in chat.

**Done (17 of 27, plus #16 came free):**
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
20. **Phase 5 cloud deploy DONE 2026-05-04.** Sunny live on Railway at https://sunny-electrosun-production.up.railway.app, /health returning 200, volume mounted, env vars set, Meta webhook updated to the Railway URL, `messages` field subscribed. **First live cloud conversation passed end-to-end** at 12:42 PM Beirut: customer message → Meta webhook → Railway → classifier (Haiku) → reply generator (Sonnet) → Meta send → WhatsApp delivery, ~10s round trip. Reply quality on-spec: recognized customer by name, offered multi-option product list (Jinko/JA Solar/Longi), no hedging, focused clarifying question, no repetition on second turn.

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

**Resume plan:**
1. Once brother provides pricing data and Section 11 decisions, update prompts with concrete prices and policies. Until then, silent_query escalations to him are the right behavior.
2. Task #15: 48-hour soak with 3-5 testers on the test number. Captures real conversation patterns to feed the daily learning loop.
3. Task #17: Add ElectroSun's real WhatsApp number to the WABA, swap `META_PHONE_NUMBER_ID` and `OWNER_WHATSAPP` in `.env`.
4. Task #19: DONE 2026-05-04. Both templates submitted via `scripts/submit_templates.js`, status PENDING with Meta. Re-check in 24-48h. If rejected, read `rejected_reason` and re-submit.
5. Phase B code work (separate from launch tasks). DONE 2026-05-03. Plus admin UI shipped same day. Only nice-to-haves remain:
   - **Approve-to-permanent learning loop.** Brother sees daily learning suggestions in the 21:30 report, but there's no UI button to "Approve and turn into permanent rule." Currently he updates `system.md` or `products.json` manually and pushes. v2 feature: an admin UI page for learning items with approve/edit/skip buttons that auto-update prompts.
   - **v2 daily learning sections.** "New patterns with draft replies" requires an LLM pass over the day's conversations. "Internal questions I have" requires self-generated learning items. Both are placeholders today.
   - **Hot-lead alert with conversation summary.** Brother's foundation doc shows "Project: ..., Ready to: ..., full conversation summary attached." Currently we send classifier metadata + last message. A small Haiku synthesis call could enrich this. Not urgent; brother can scroll history in admin UI.
   - **Knowledge file expansion.** Brother to send remaining 14 categories beyond product catalog: installation pricing, service area, warranty, payment terms, sales doctrine, common objections, past projects, real conversation samples, working hours, holidays, compliance constraints. Each goes into `src/knowledge/*.json` or directly into `system.md`.
   - 23-hour window flagging.
   - Cleanup `scripts/seed.js` (still has old category names).
6. Phase 5 cloud deploy as the final cutover.

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
