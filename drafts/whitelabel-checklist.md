# Sunny White-Label Template, Per-Client Customization Checklist

Working draft from brainstorm on 2026-05-27.

This document captures the decision and the checklist for turning Sunny into a reusable starting point for future WhatsApp agent deployments.

## The approach (Option A with a healthy parent)

We are NOT going to:
- Build a single multi-tenant platform.
- Build a config-driven mono-repo where every client shares the same code.
- Build an industry-pack plugin system up front.

We ARE going to:
- Create one new public-or-private repo called `sunny-template`, by cloning Sunny's current code and stripping out the ElectroSun and solar specifics.
- For every new agency client, `git clone sunny-template` into `sunny-<client>`. From that moment, the client's fork is fully independent.
- Sunny (the ElectroSun deployment) stays exactly where it is, untouched. It is the reference, not the template parent.

Why this shape:
- Each client deploy is sacred and isolated. Touching one cannot affect another.
- Businesses really are different. Fork-per-client lets us rewrite anything we need for any vertical without compromise.
- Trade-off accepted: when a bug is fixed or a feature is added, we manually cherry-pick the patch into the forks we want to update. Multi-fork maintenance is the price.

## The 10-step recipe (every new client)

1. Clone: `git clone sunny-template sunny-<client>`.
2. Brand: edit business name, locations, contacts inside `src/prompts/system.md`.
3. Voice: tune `src/prompts/system.md` for the client's tone and industry vocabulary.
4. Languages: adjust the language list if the client is outside Nigeria.
5. Currency: find-replace NGN with the client's currency.
6. Catalog: decide retail-shape (use as-is) or build a new shape (services, listings).
7. Industry rules: drop in any validators that vertical needs (or skip if none).
8. Env vars: set Meta credentials, owner phone, currency-related defaults.
9. Deploy: new Railway project, mount volume, point Meta webhook at it.
10. Seed: log in to admin, add the client's catalog or services or listings, plus any knowledge facts.

Steps 2 through 7 are the real work. Everything else is mechanical.

## Bucket 1, Identity and branding (always changes per client)

| What | Where | How to swap |
|---|---|---|
| Business name (currently "Electro-Sun") | `src/prompts/system.md`, admin UI title, `WELCOME_REPLY` constant in `src/handler.js` | Find-replace in prompts; rewrite the constant |
| Owner WhatsApp number | `.env` → `OWNER_WHATSAPP` | Env var only |
| WhatsApp Cloud API credentials | `.env` → `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_WABA_ID`, `META_REGISTRATION_PIN` | Env vars only |
| Specialist contact numbers (e.g. Patrick, Charbel, Lagos line) | `src/prompts/system.md` locations block, plus `SPECIALIST_DIRECT_LINK` env var | Prompt edit plus env var |
| Physical locations | `src/prompts/system.md` "locations" block | Prompt edit |
| Currency (NGN) | `src/prompts/system.md`, `formatWarehouseForPrompt()` inside `src/warehouse.js` | Prompt edit, small code edit |
| Working hours and after-hours reply | `src/prompts/system.md` (currently a TODO, never finalized for Sunny) | Prompt edit |

## Bucket 2, Voice and prompts (always changes per client)

Four markdown files, edited as plain English. No code touched.

| File | Purpose | Per-client effort |
|---|---|---|
| `src/prompts/system.md` | Personality, voice rules, hard rules, locations, conversation-state usage, engineering rules | Heaviest rewrite. This is the agent's soul. |
| `src/prompts/classifier.md` | HOT, SERIOUS, COLD, DISQUALIFIED, REPEAT_CLIENT definitions, escalation triggers | Moderate. Category names stay, trigger phrases swap ("send proforma" becomes "book appointment", etc.). |
| `src/prompts/owner_qa.md` | How the agent answers the owner's data questions over WhatsApp | Light. Mostly framework, swap business name and metric labels. |
| `src/prompts/teacher.md` | Legacy, owner-DM-to-fact extraction | Skip or keep as-is. No longer injected into prompts. |

These four files are the biggest per-client work item by hours.

## Bucket 3, Catalog (what the business sells)

Sunny's `warehouse_items` plus `warehouse_stock` schema is designed for physical goods sold from physical locations (brand, model, price, stock per location, datasheet, photos).

Three scenarios for a new client:

- Same shape (physical goods, e.g. furniture, electronics, auto parts). Clear the table, refill via admin UI. Zero code change.
- Different shape (services, e.g. dental clinic, salon, repair shop). Schema becomes appointment slots, service types, duration. Requires schema migration plus admin UI rework.
- Different shape (listings, e.g. real estate, vehicle resale). Schema becomes properties with location, price, features. Requires schema migration plus admin UI rework.

For the template, leave the `warehouse_*` schema as-is and rename "Warehouse Stock" to something generic like "Catalog" in the admin UI. Physical-goods clients use it without touching code. Service or listings clients ignore it and use a custom schema (built in Bucket 4 territory).

## Bucket 4, Industry rules (changes per vertical, not per client)

Code modules that ONLY make sense for solar. Strip from the template:

| File | Why it's solar-only |
|---|---|
| `src/hv_validator.js` | HV BOM math (clusters, modules per series) |
| `cleanupBomReply` inside `src/claude.js` | Strips §9HV doctrine and "Option N:" labels, only relevant when generating multi-option BOMs |
| Engineering rules in `src/prompts/system.md` (inverter parallel limits, kWh capacities) | Pure solar physics |

What to KEEP (these are generic and rename-safe):
- `detectFabricatedVariant` in `src/claude.js`. The guard "does this catalog row exist?" works for any catalog. Rename and parameterize.
- The post-reply guard pipeline (price strip, repeat guard, trailing-question strip, wa.me strip, leak detectors). All vertical-agnostic.

For other industries you would add their equivalent solver at the same hook points. Examples:
- Dental clinic: appointment conflict validator.
- Real estate: viewing schedule validator.
- Furniture: delivery zone and dimensions checker.

Template ships with NONE of these. You add the relevant one per client.

## Bucket 5, Languages

Sunny supports English, Nigerian Pidgin, Hausa, Yoruba, Igbo. That's Nigeria-specific.

| Where | How to swap |
|---|---|
| `src/prompts/system.md` | Language list, sample phrases per language |
| `src/prompts/classifier.md` | Language detection labels |
| Welcome card and canned replies in `src/handler.js` | Currently English-only. If a client needs Arabic-first or French-first, translate the constants. |

## Bucket 6, Operational config (env vars only)

These tune behavior without any code edits. All in `.env`.

- `DAILY_LLM_BUDGET_USD`, soft daily cap.
- `MODEL_REPLY`, `MODEL_CLASSIFIER`, `MODEL_TEACHER`, `MODEL_OWNER_QA`, per call-site Opus vs Sonnet vs Haiku.
- `HUMAN_AUTO_RELEASE_MINUTES`, how long human-handled before the agent resumes.
- `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_DAILY`, abuse guards.
- `MESSAGE_DEBOUNCE_MS`, how long to wait before replying to batched customer messages.
- `PHOTO_SEND_CAP`, max photos per customer request.
- `DISABLE_NOTIFICATIONS`, `DISABLE_ESCALATIONS`, kill switches.

Defaults are sane for most clients. Touch only if needed.

## What stays IDENTICAL across all clients

Roughly 80 percent of Sunny's code is plumbing that does NOT change per business. The template ships this as-is:

- WhatsApp Cloud API webhook plus signature verification.
- Debounce queue (groups rapid customer messages).
- Classify-then-reply pipeline structure.
- Owner alerts plus handoff plus pending_queries workflow.
- 24-hour message window monitor.
- Voice transcription via OpenAI Whisper.
- Photo and document upload helpers.
- Admin UI shell (Inbox, Catalog, Owner Chat, Rules editor, Models config).
- Cost tracker plus budget guardrail.
- Security guards (rate limits, leak detection, injection detection, stall language).
- Cron scheduler (reports, window monitor, auto-release).
- Idempotency on incoming WhatsApp message IDs.
- Conversation rollover at the 24-hour mark.
- Owner Q&A mode.

## Open questions to resolve before building `sunny-template`

These are not blockers for the brainstorm but they shape the template:

1. Public or private repo? Sunny is currently private at `sergeadaimy-hash/sunny-electrosun`. Should the template be public (portfolio piece) or private (internal toolkit)?
2. License if public (MIT, Apache 2.0, or source-available)?
3. Should the template ship with a default "retail goods" example so a developer can boot it once and see it work, or empty?
4. Should the admin UI's "Warehouse Stock" tab be renamed in the template (e.g. "Catalog"), or left and renamed per client?
5. Should we keep the `seed.js`, `seed_hv_products.js`, `seed_locations.js`, `seed_doctrine.js` solar seed scripts in the template (as examples) or strip them and provide blank equivalents?
6. Should the template include a `CUSTOMIZATION.md` (this doc, polished) so a future dev can follow the recipe?

## Next steps when ready to build

1. Decide the answers above.
2. Spin up `sunny-template` repo.
3. Mechanical strip: copy Sunny's code, remove the items flagged in Buckets 1, 4, 5; replace with `{{PLACEHOLDER}}` markers or sensible blanks.
4. Write `CUSTOMIZATION.md` (this doc, refined).
5. Tag v0.1.0 on the template repo. From here, every future client deploy starts with a `git clone` of this tag.
