# Agent redesign roadmap, 2026-05-09 (paused)

Brainstorm captured at the end of the 2026-05-09 session before Serge stepped away. Nothing in this document has been implemented yet. Read this first when the work resumes; the gaps and proposals here are still open questions.

## 1. Every reply is the sum of these inputs

When a customer message arrives, ten layers stack together to produce one reply. Each one can poison the result if it is wrong.

| Layer | What it is | Where it lives today |
|---|---|---|
| 1. Master prompt | Identity, voice, do/dont, hard rules, engineering rules | src/prompts/system.md (~600 lines, too long) |
| 2. Catalog | SKU, model name, capacity, price | catalog_items table, rendered into prompt |
| 3. Stock and availability | In stock, out of stock, ETA, incoming batch, price changes | Owner-taught "facts" (free text), prone to drift |
| 4. Owner doctrine | Best-price script, discount rule, working hours, location, after-hours | Mixed into "facts" with everything else |
| 5. Datasheets list | What PDFs Sunny can send | datasheets table |
| 6. Conversation history | Last 50 turns of this customer | messages table |
| 7. Conversation state | Computed: sizes mentioned, brands, what was already asked | Computed live |
| 8. Expert context | Special block when escalating or in casual confirm | Computed live |
| 9. Customer's current message | The actual incoming text | Webhook payload |
| 10. Reply guards (post-process) | Strip prices when not asked, strip wa.me, strip duplicates, strip stalls | src/claude.js, src/handler.js |

The classifier (separate LLM call) reads layers 1, 2, 3, 4, 6, 9 and decides: HOT, silent_query, or normal. Then the reply LLM gets the same layers plus 5, 7, 8 and writes the reply.

## 2. Where it broke on 2026-05-08 and 2026-05-09

- Layers 2, 3, 4 are mashed together. Catalog says "Longi 580W: 152k", owner-taught fact says "Longi 650W: 165k incoming next week", legacy import says "Longi 650W: 130,000 NGN". All three reach the LLM. It picks one. It picks wrong.
- No structured stock state exists. "Out of stock" is a free-text sentence among 500 other free-text sentences. The LLM has to skim and decide what is current. Sonnet missed it on long prompts.
- Layer 1 is too long. ~600 lines of rules. The model's attention drops. The HV-only rule is on line 100, the price-discipline rule on line 6, contradictions in the middle.
- Layer 6 is poisoned by hallucinations. Once Sunny said "100-unit order" wrongly, that line lives in history forever and Sonnet keeps echoing it. Scrubbing only catches a small set of patterns.
- Escalation rules are split between classifier and reply paths. Classifier escalates on "stock confirmation"; reply path then injects "team will follow up"; reply guards then auto-append the wa.me link. Three independent layers each contributed to the failure.

## 3. Single source of truth for stock (Serge's request)

Stock should live in ONE structured place, not as free text inside facts. Proposed shape:

Google Sheet (or Airtable, or a simple admin grid) with one row per SKU.

| Column | Example | Why |
|---|---|---|
| sku | LONGI_650_HIMOX10 | Unique key |
| brand | Longi | Filter / search |
| model | Himox10 mono facial | Display |
| category | panel | (panel / inverter / battery / accessory / kit) |
| capacity_value | 650 | Numeric for sizing logic |
| capacity_unit | W | (W / kW / kWh / kVA) |
| voltage_class | n/a | (LV / HV / n/a) for inverters and batteries |
| phase | n/a | (single / three / n/a) |
| stock_state | incoming | (in_stock / out_of_stock / incoming / discontinued / not_carried) |
| eta_date | 2026-05-16 | Real date when state=incoming |
| price_ngn | 165000 | Plain number, blank if not set |
| price_status | confirmed | (confirmed / special / negotiable / awaiting) |
| notes | Reservable with prepayment | Free text shown to customer |
| updated_at | auto | For staleness tracking |

A Railway cron pulls this sheet every 5-15 minutes into a local inventory table. The catalog block AND the stock block are both generated from this one source. Owner edits the sheet, nothing else. No more freeform "out of stock" facts. No more dedup tricks. No more legacy imports polluting anything.

The prompt block then becomes structured and tight, e.g.

```
# Inventory (live, last updated 2026-05-09 17:42 GMT+1)
PANELS
- Longi 650W Himox10 mono facial: INCOMING (2026-05-16), 165,000 NGN, reservable with prepayment
- Jinko 615W bifacial: INCOMING (2026-05-15), 149,000 NGN, reservable
- All other panel SKUs: out of stock

INVERTERS
- Deye 6kW off-grid: OUT OF STOCK, new batch next week, special price (team confirms)
- Deye 12kW LV hybrid: IN STOCK, 2,800,000 NGN
- ...

BATTERIES
- BOS-G 5.12kWh HV: IN STOCK
- BOS-B Pro 16kWh LV: INCOMING (2026-05-15)
- 5kWh LV: SOLD OUT, batch in ~20 days, 940,000 NGN
- 16kWh LV: OUT OF STOCK, batch next week
```

Sonnet reads this in 5 seconds, never invents prices, never mis-states stock. The owner edits one sheet.

## 4. What the master prompt should contain (proposed final structure)

Strip it down to ~250 lines, organized like this.

```
# Identity
- Who Sunny is, who Electro-Sun is, what tone (Lagos sales floor)
- Languages: detect, reply in same

# Posture (before any rule)
- ANSWER from inventory + doctrine. Never stall. Never invent.
- Banned phrases (the seven stall lines + "team will email", etc.)
- Casual fillers get one-phrase ack

# Escalation, the only two cases
- HOT: explicit commitment phrase ("I want to pay", "send invoice", "deposit", "ready", "lets proceed", "site visit")
- silent_query: ONLY for install dates, complaints, warranty claims, custom contracts, "let me speak to a human"
- Everything else = answer directly. No exceptions.

# Pricing rules
- Quote only when customer asks (the trigger words)
- Source of truth = inventory block. Forbidden to invent or interpolate.
- Multi-item totals OK when customer named items
- No catalog dumps. No price lists.

# Stock rules
- Source of truth = inventory block. If stock_state is not in_stock, mention it.
- Never invent an ETA. Use the eta_date in the inventory block or say "team confirms".

# Solar engineering rules (these never change)
- LV vs HV pairing
- BOS-A and BOS-B are HV-only commercial. Never offered for residential 10kWh asks.
- BOS-G/A/B need their own PDU + BMS + Cluster Box. Same series only.
- Inverter parallel: same size only, max 10 units.
- Series quantity rules per battery + inverter pairing.

# Voice rules
- No compliments, no AI-speak, no double dashes, max 2 sentences
- No proactive questions to short factual answers
- No URLs in reply (the system appends wa.me on HOT only)
- No phone numbers volunteered

# Owner doctrine (small, owner-edited)
- Best-price script (one sentence)
- Discount policy (one sentence)
- After-hours reply (one sentence)
- Working hours (one line)
- Pickup vs delivery rule (one paragraph)

# Locations (always answered, never escalated)
- Abuja office, Abuja warehouse, Lagos office addresses

# Worked examples
- 8-12 short before/after pairs. That is it.
```

Each section is sharp and short. No worked examples that bleed across sections. No contradicting rules.

## 5. Where each kind of edit happens (single window per topic)

| Owner wants to change | Edits this | Sunny picks it up |
|---|---|---|
| Stock or price for a SKU | The Google Sheet | Within 15 min |
| New SKU | The Google Sheet | Within 15 min |
| Discount policy / best-price script / hours | Admin, Knowledge, Doctrine sub-panel (small, max 20 items) | Next reply |
| Solar engineering rule (HV pairing, parallel rule) | src/prompts/system.md (committed via Serge) | Next deploy |
| Sunny's voice / tone | src/prompts/system.md | Next deploy |
| Datasheets to send | Admin, Knowledge, Datasheets | Next reply |

Three lanes, no overlap. No more pasting prices into "facts" then deduping them.

## 6. Two-week clean-up path

1. Today / tomorrow: pull the real number off the webhook. Easiest is `railway variables --set "DISABLE_AUTO_REPLY=true"` (need a small kill switch in handler.js, ~10 lines) so inbound is stored but Sunny never replies; owner answers manually from admin. Real customers see human-quality replies. No more public failures.
2. Days 2-4: build the inventory sheet + Railway-side puller. Replace the catalog block + stock-fact block in the prompt with the single inventory block. Reject the rest of the legacy facts. Owner-doctrine sub-panel built, with 5-10 sharp owner-edited rules.
3. Days 4-6: rewrite the master prompt to the proposed structure. ~250 lines, tight.
4. Day 6: switch webhook to test phone, kill switch off. Run a 30-scenario script with 2-3 testers. Score each: did Sunny answer correctly, did it stall, did it invent a price, did it escalate when it shouldnt have, did it miss an escalation. Iterate until 90%+ pass.
5. Day 7+: switch the webhook back to the real number. Watch the first 50 conversations live. Have admin "Take over" ready in case anything slips.

## 7. Decisions to make before any coding resumes

- Stock source format: Google Sheet that the brother maintains, or a simple admin grid in Sunny itself? Sheet is better for the brother (he already uses spreadsheets for stock). Grid is faster to build but the brother has to log into admin. Recommendation: sheet.
- Stock states: are 5 states enough (in_stock, out_of_stock, incoming, discontinued, not_carried) or are more needed (e.g. low_stock, preorder_only)?
- Price column: when stock is incoming with a special price to be confirmed, do we leave price blank and Sunny says "team confirms", or do we let owner type "special, awaiting" and Sunny says exactly that?
- Test phone: register a fresh test number in Meta Cloud API for this, or use one of the brother's spare numbers? The old test WABA 1713234916358524 is retired and cannot be reused.
- Kill switch first? Ship the `DISABLE_AUTO_REPLY` kill switch right now, today, so the real number stops sending bad replies. That is a 10-line change with no risk and stops the bleeding. The architectural rebuild then happens calmly over the next week.

## State of the codebase when this roadmap was written

- Live SHA on Railway: 90d8dfb (datasheet email-handoff line removed; legacy-fact one-click cleanup endpoint and admin button shipped but not yet pressed by the owner).
- Recent shipped fixes (2026-05-09): respect owner-taught stock + price facts, ban BOS-A/B as residential alternates, repair admin datasheet download, no-spam fallback when Anthropic is down, retry endpoint for stuck conversations, posture inverted to answer-first, casual confirmations now ack and stop, wa.me link only on HOT, expert-context rewritten to forbid hallucinated quantities, stock facts hoisted to top of prompt, price-invention banned in prompt, legacy-fact cleanup endpoint added.
- Anthropic monthly cap: was hit 2026-05-09 ~14:46 GMT+3, raised manually by Serge mid-session.
- Reply model: Sonnet 4.6 (`MODEL_REPLY=claude-sonnet-4-6`), flipped from Opus mid-session for cost. Quality regressions noted (BOS HV-only rule slipping, hallucinated 100-unit order persisting in history). Whether to flip back to Opus is open.
- Real WhatsApp number is still active on Railway. Serge wants it removed before the rebuild.
- Owner has not yet clicked the new "Reject all legacy facts" admin button. That single click should drop the prompt size by hundreds of stale entries, but the structural rebuild in this roadmap is still needed.

## How to resume

1. Read this file end-to-end.
2. Check the answers Serge gave to section 7 questions (in the next session).
3. Decide whether to ship the `DISABLE_AUTO_REPLY` kill switch as the first action.
4. Then start on the inventory pipeline (section 3) before touching the master prompt (section 4).
