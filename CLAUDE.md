# Sunny, WhatsApp Account Manager for ElectroSun

This file is the working memory for Sunny. Read it before making any change. It captures decisions already made so they do not need to be re-litigated.

## Current launch status (paused 2026-05-03 mid-morning Beirut)

We are partway through the 27-task launch sequence (see `~/.claude/projects/-Users-sergeadaimy-Desktop-Claude-Projects-Sunny-Whatsapp-Account-Manager/memory/launch_sequence.md` for the full list). Phase 1 (Setup) and Phase 2 (Local end-to-end test) are fully closed; Task #18 (permanent System User token) is also closed out of order. Resume from Task #13.

**Phase 5 was rewritten cloud-first on 2026-05-03.** Production target is now Railway or Fly.io (push-to-deploy from the GitHub repo), NOT the Mac Mini. Reason: Nigerian office power and ISP can be flaky, cloud PaaS gives 99.9%+ uptime SLA. Mac Mini stays as a future on-prem option but is NOT the launch target. PM2 (was Task #23) and named Cloudflare Tunnel (was Task #21) are no longer in the production path. See `memory/project_cloud_first_decision.md`.

**GitHub repo (source of truth):** https://github.com/sergeadaimy-hash/sunny-electrosun (private, owned by `sergeadaimy-hash`). 23 files, no secrets. See `memory/reference_github_repo.md` for clone recipe.

**Done (13 of 27, plus #16 came free):**
1. Meta Developer app `ElectroSun_Whtspp` created. App ID `2440193806402796`.
2. Meta credentials captured. Test number `+1 555 172 6906`. Phone Number ID `1111486288711551`. WABA ID `1713234916358524`. Owner whitelisted as a test recipient (Saudi number `+966502392650`).
3. Anthropic API key created in Default workspace (`Sunny-dev`). Org ID `7e197f14-a3e1-4b93-9836-cd54cd831e1f`. Tier 2 reached.
4. Meta business verification confirmed already verified for ELECTROSUN since 2026-06-27. (Also closes Task #16.)
5. `.env` filled with all 7 required keys, sanity check passed.
6. `cloudflared` 2026.3.0 installed via Homebrew (dev-only now; cloud deploy will not use it).
7. Sunny + quick tunnel booted on laptop, both healthy. Quick-tunnel URLs rotate per launch.
8. Meta webhook configured, `webhook.verify.ok`, `messages` field subscribed. Will be repointed at the cloud platform URL during Phase 5.
9. First live WhatsApp test passed end-to-end. Anthropic API unblocked. Classifier ran clean, three `whatsapp.send.ok` outbound, owner phone confirmed receipt.
10. Five-language coverage marked done by code review (not formally tested live). Classifier prompt has the language field, `HOLDING_REPLIES` map has all 5 languages, paths are identical regardless of language.
11. Force-escalation test passed. Complaint+warranty message moved category `explorer` to `returning_customer`, owner alert + customer holding reply both sent and received.
12. Hourly report verified. Cron `0 * * * *` UTC fired at `08:00:00` on 2026-05-03, owner WhatsApp received the report.
18. Permanent System User access token issued. System User name "Sunny-Server", ID `615889422441392`, Admin access, Full control on App `ElectroSun_Whtspp` + both WhatsApp accounts (Test WABA + "Esther Electro-Sun Admin" production WABA). Token does NOT expire after 24h. No more token rot.

**Bonus shipped this session (not on the formal task list):**
- Voice-note / image / document / sticker / location messages no longer drop silently. New `handleUnsupported()` path in `src/handler.js` sends a polite "I can only read text" reply in the contact's stored language (English fallback) and logs an `unsupported_received` event. Verified live with a voice note. Idempotent on `whatsapp_message_id`. Zero new dependencies.
- Classifier escalation rule tightened in `src/prompts/classifier.md`. Removed the "confidence < 90 auto-escalate" trigger that was pinging the owner on every borderline message. Now escalates only on explicit triggers (specific quote, complaint, warranty, custom design with concrete loads, hostility, B2B/wholesale).
- System prompt punctuation rule added in `src/prompts/system.md`. Sunny's replies must contain no em-dashes, en-dashes, or double hyphens (hard rule #1 enforced for customer output). Verified live: post-fix replies use commas, colons, parentheses cleanly.
- GitHub repo created and pushed (initial commit `c6332cf`).

**Resume plan:**
1. Check whether intake answers from Serge's brother have come in (the 12 ElectroSun facts + 4 escalation policy questions). If not, ask Serge.
2. If Sunny is not running, restart with `npm start` from project root. Restart cloudflared quick tunnel for dev, capture new URL, repaste into Meta webhook (still pointed at the test number).
3. Once intake is back, rewrite `src/prompts/system.md` against the answers. Fix the placeholder bug on line 66 (`[X] hours` is literal text that will leak to customers). Update `src/prompts/classifier.md` with any new escalation triggers. Commit and push to GitHub.
4. Run a 5-message smoke test (greeting, technical question, pricing question, complaint, returning customer) to verify the new voice + escalation rules.
5. Move to Task #15 (48-hour soak with 3-5 testers on test number), then Tasks #17 (real ElectroSun number), #19 (templates), #20 (template approval wait).
6. Phase 5 cloud deploy (Railway or Fly.io) is the FINAL step before launch, not in parallel with anything else.

**Open decision parked by Serge:** tiered escalation notifications (hot vs warm). Whether complaints + warranty + hostility should ping the owner immediately while specific-quote / custom-design / B2B should be batched into the hourly report. Not blocking; revisit when Serge brings it up.

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
