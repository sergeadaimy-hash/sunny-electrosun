# Sunny ten-day audit, 22 July to 1 August 2026

Run on 2026-08-01 against production `4231ef9` (identical to local HEAD, uptime 5.8 days, no errors in the logs). Data pulled live from `/api/inbox` and `/api/conversations/:id`: **647 customer conversations, 6,441 messages**, plus a full code pass.

## Context

Traffic changed scale on 22 July. Inbound went from about 5/day to **280 to 430/day** (peak 428 on 29 July). Everything below is a pre-existing weakness that only became expensive at the new volume.

## Measured baseline

| Metric | Value |
|---|---|
| Customer conversations | 647 |
| Messages (in / out) | 2,493 / 3,948 |
| Reply latency | p50 12.5s, p90 16.5s, p99 29.4s |
| Replies over 60s | 13 of 2,421 |
| Genuinely unanswered inbound | 0 (all 14 trailing inbounds are emoji reactions, correctly silent) |
| Conversations escalated to a desk | 163 of 647 (25%) |
| Alerts sent | 301 (65 HOT, 147 silent, 77 nudges, 12 pings) |
| Quoted NGN figures matching a warehouse row | 850 of 987; the other 137 are line totals and multiples |
| Spend | $7.50 by 14:20 UTC against a $50/day budget |

## Findings and what shipped

### 1. Price-strip guard destroyed 60 replies (CRITICAL, fixed)

`src/claude.js`. When Sunny quoted a price and the guard judged that the customer had not asked for one, it stripped the figures; a leftover fragment then replaced the whole reply with a generic deflection.

**53 replies** became "Could you share more about your project so I can guide you better?" in response to:

| Customer | conv |
|---|---|
| "I'm looking for 20 kva 3 phase inverter" | 7000 |
| "Do you have 80kva deye inverter" | 6954 |
| "I need 30 kw inverter" | 6819 |
| "deye 16kwh lithium battery" (twice) | 7039 |
| "The 8kw inverter and the 16kwh battery is ok" | 6936 |
| "Prix svp" | 6945 |

**7 more** shipped broken, e.g. conv 6999: "Closest sizes we carry: - SUN-8K-SG05LP1-EU-SM2-P (8kW, 1-phase hybrid, available) at".

Root cause: `PRICE_ASK_RE` looked for words like "how much" or "price". A customer naming a product and a size matched none of them.

**Fixed:** `isPriceAsk(text)` exported from `src/claude.js`. Product + size counts as a price ask; French price words added. `detectDanglingFragment` gained `connector_eol` for a line ending on a bare connector.

### 2. The escalation channel is write-only (CRITICAL, needs an owner decision)

| Desk | Alerts (lifetime) | Replies | Last reply |
|---|---|---|---|
| Abuja `…493087` | 746 | 6 (all "Hi") | 4 July |
| Lagos `…880000` | 85 | 1 | 20 July |
| Charbel | 27 | 0 | never |
| Patrick | 38 | 5 (Owner Q&A questions, not alert replies) | 30 July |

**77 of 301 alerts (26%) are nudges** about alerts nobody answered. Every "the team will confirm" promise goes unfulfilled, and the 3h check-in asked 77 customers whether a Sales Manager reached out when none does. Code cannot fix this; it is an operations decision.

### 3. Silent-skip swallowed real messages (CRITICAL, fixed)

`isCasualConfirmation` treated any message under 30 characters with no question mark and no product keyword as a polite close. Combined with the warm-close skip, these got total silence: "I live in Port Harcourt", "May I have u name", "Hello good evening", "And 590w", "for the panels and inverter". 70 warm-close skips in the window. This contradicted the 19 July directive that any message with content always gets a reply.

**Fixed:** rebuilt on a `FILLER_WORDS` vocabulary. Casual only when every word is filler, with no digit and no question mark.

### 4. Double replies, 138 bursts across 100 conversations, 15% (SERIOUS, fixed)

- **122** were the debounce gap: customers' consecutive messages arrive at p50 8.9s, p90 12.6s against a 6s window.
- **16** were a race where one message got two replies. conv 7003: "How much is 20 kW?" got "Sure, which product or system size are you looking at?" and then the real 20kW answer 11s later.

**Fixed:** debounce 6s to 12s, plus `batchIsSuperseded` dropping a reply that newer queued messages have already made stale.

### 5. Internal reasoning leaked to customers, 4 times (SERIOUS, fixed)

conv 6447, sent verbatim to a customer in Benin:

> "The customer is asking in French ("Coutera combien" = "How much will this cost"). Per the reply language rules, I must respond in English regardless. The image shows a Sohigh Solar system (not a Deye system)... I should offer our equivalent Deye components... I'll offer the Deye equivalents."

Also conv 6572 and conv 6778. All triggered on French or context-heavy turns.

**Fixed:** narration markers added to `PROMPT_LEAK_MARKERS`, curly apostrophes normalized, and a hard never in `system.md` §19 quoting all four leaks.

### 6. Routing was 68/14 lopsided (SERIOUS, fixed)

Every city-unknown lead defaulted to Abuja: **205 alerts to Abuja against 41 to Lagos** in the window. The owner asked about exactly this on the developer line on 29 July ("Why lagos sales is not receiving a lot of escalations? Let them go to any sales manager") and it had not been addressed.

Separately, Owner Q&A told Patrick on 29 July that leads were "still waiting on city confirmation before they get routed", behaviour retired on 19 July.

**Fixed:** city-unknown leads alternate between the two desks (`last_regional_desk` in `routing_state`). Owner Q&A routing copy corrected, and `alerts_by_desk_today` added so the per-desk question gets real numbers. Also fixed a latent bug where `abujaConfigured` was derived from `numberForLabel('abuja')`, which falls back to `OWNER_WHATSAPP` and so reported every desk as configured.

### 7. `lead_temperature` was useless (SERIOUS, fixed)

**639 of 647 contacts (98.8%) read COLD**, including all 19 whose category was HOT. Temperature was overwritten from the latest message while category kept the peak, so "I want to pay" followed by "ok thanks" ended COLD.

**Fixed:** `mergeLeadTemperature` makes it a high-water mark; the terminal verdicts override in both directions.

### 8. Duplicate Sales Manager check-ins (SERIOUS, fixed)

12 of 63 recipients got 2 or 3. conv 6999 got the identical message at 07:00 and 10:25. Superseding only cleared *pending* rows.

**Fixed:** `SALES_FOLLOWUP_COOLDOWN_HOURS`, default 24, checked against the last *sent* check-in.

### 9. Unsupported media (MODERATE, fixed)

A customer sent an installation video captioned "Pls rate my first time high voltage installation" and got "This number receives text messages only." Another thread got that nag five times from stickers.

**Fixed:** stickers are silent, the nag is capped at once per conversation, and videos get a reply that invites the customer to continue.

### 10. Remaining items for an owner decision

- **French leads.** 8 threads from Benin, Niger, Chad and Cameroon numbers where the ads run. The 2026-05-29 serviced-languages rule refuses French; in conv 6940 Sunny told the customer to find an interpreter. The three outright mishandlings (reasoning leak, wrong warranty answer, price deflection) are fixed, but the policy itself is unchanged and is the owner's call.
- **Nightly audit backlog.** 30 runs, roughly 1,200 findings, nothing approved. It costs about 60 Sonnet calls a night with zero consumption.

## What was already healthy

- **Prices are accurate.** 850 of 987 quoted figures match a warehouse row exactly; every remaining figure checked resolves to a line total (276,000 = 2 x 138,000, 1,656,000 = 12 x 138,000). No invented prices anywhere.
- **The warranty fix worked.** Warranty escalations peaked at 35/day on 19 July and are near zero since, after the vault fill. That removed about a quarter of all alerts.
- **The Haiku classifier is holding.** No parse failures observed. Commitment-phrase promotion caught the genuine commitment thread.
- **No leakage.** Zero URLs beyond the three approved map pins, no owner-number leaks outside the welcome card, no wa.me links from the model.
- **Nothing goes unanswered**, and latency is well inside a customer's patience.

## Verification

`npm test`: **325/325 pass** (289 before, 36 added). `npm audit`: **0 vulnerabilities** (was 1 high, 1 low).

New regression suites: `test/audit_fixes_2026-08-01.test.js`, `test/audit_fixes_2026-08-01b.test.js`, `test/owner_qa_routing_summary.test.js`. Two assertions in `test/owner_routing.test.js` were updated where they encoded the Abuja-only default the owner asked to replace; the invariant they protect (a city-unknown lead always reaches a real sales desk, never the owner dead-end) is still asserted.
