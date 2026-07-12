# Sunny, WhatsApp Account Manager for ElectroSun

Sunny is an AI-powered WhatsApp Account Manager for **ElectroSun**, a solar energy supply agency in Nigeria. It answers every inbound WhatsApp message in the customer's own language, explains ElectroSun's products and services, qualifies and categorizes leads, escalates the ones that matter to the right sales desk, and stores everything behind a clean REST API and an admin web UI.

> This is a private operational repository. The authoritative, always-current reference is [`CLAUDE.md`](CLAUDE.md); the chronological changelog is [`docs/session-history.md`](docs/session-history.md). Read those before changing anything.

## What it does

- Replies to WhatsApp text, image (vision), and voice notes (transcribed), plus debounced message bursts.
- Classifies each contact (HOT / SERIOUS / COLD / DISQUALIFIED / REPEAT_CLIENT) and captures lead data.
- Routes escalations by region and deal size: big projects to the owners, everything else to the Abuja or Lagos sales desk.
- Quotes prices only when explicitly asked, only from the live Warehouse Stock table, with a stack of code-level reply guards.
- Sends per-item datasheets and product photos on request.
- Owner Q&A over WhatsApp, owner escalation alerts, and a self-improvement nightly audit.

## Tech stack

- **Runtime:** Node.js 20+ (Railway Linux container in production, macOS for local dev)
- **Framework:** Express.js
- **Database:** SQLite via `better-sqlite3` (single file)
- **WhatsApp:** Meta WhatsApp Cloud API (Graph API v21.0)
- **LLM:** Anthropic Claude API (classifier on Haiku 4.5; replies, owner Q&A, teacher, audit, and image descriptions on Sonnet 4.6)
- **Voice transcription:** OpenAI Whisper
- **Scheduler:** `node-cron`

The tech stack is locked. Do not add a dependency outside this list without approval (see `CLAUDE.md`).

## Repository layout

```
server.js          Express app, cron registration, startup checks
db/                schema.sql, idempotent init/migrations, SQLite file (gitignored)
src/               pipeline + integrations
  webhook.js         Meta webhook verify + signed inbound
  handler.js         inbound pipeline, debounce, routing, escalations
  claude.js          classify, generateReply, conversation-state, reply guards
  classifier.js      classification wrapper
  whatsapp.js        send/receive, media upload + download
  warehouse.js       stock + price + datasheets + photos (source of truth)
  owner_qa.js        owner Q&A over a live data snapshot
  security.js        rate limits, throttles, injection + leak detection
  prompts/           system.md, classifier.md, owner_qa.md, audit.md, ...
api/dashboard.js   REST API mounted at /api (X-API-Key auth)
public/admin/      single-page admin UI (Inbox, Contacts, Warehouse, Owner Chat, Knowledge, Audit)
docs/              session-history.md (changelog) + audits/
test/              node:test suites (run with npm test)
```

## Running locally

```bash
# Initialize the database (idempotent, safe to re-run)
node db/init.js

# Optional: seed demo data
node scripts/seed.js

# Start the server
npm start

# In a second terminal, expose the webhook publicly for Meta
cloudflared tunnel --url http://localhost:3000
```

Configuration is via environment variables; see `.env.example` for the full list. Never commit `.env`.

## Tests

```bash
npm test
```

Pure-logic units (reply guards, routing, matcher, HV BOM validator, owner alerts, webhook extraction, audit, playbook) run under `node:test` with no external services.

## Deployment

Production runs on **Railway**, auto-redeploying on push to `main`. Operational rules, kill switches, env vars, and the full runtime configuration are documented in [`CLAUDE.md`](CLAUDE.md).

## License

Private. All rights reserved.
