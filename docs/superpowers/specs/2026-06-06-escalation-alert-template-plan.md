# Owner alert via Meta template (permanent-delivery) — plan

Date: 2026-06-06
Status: OFFLINE DRAFT. Nothing submitted to Meta, nothing committed/pushed.
Decision to proceed is pending (resume tomorrow).
Related: 2026-06-06-owner-alert-routing-design.md, 2026-06-06-concise-owner-alerts-design.md.

## Why

Owner/sales alerts are free-form WhatsApp messages, so Meta drops them if the
recipient has been silent for more than 24h (the customer-service window).
With 4 recipients this is 4 windows to keep open. An approved template can be
delivered any time, window or not. This makes alert delivery reliable without
anyone having to keep their chat active.

## What is already drafted

- `templates/owner_escalation_alert_en.json`: UTILITY template. BODY has 4
  variables (header, number, product, 2-line summary) behind a fixed
  "Electro-Sun lead alert." lead-in; a URL button "Follow up on WhatsApp"
  carries the wa.me link as base `https://wa.me/` + dynamic suffix
  (`<digits>?text=<encoded draft>`). Same content as the free-form concise
  alert, just delivered as a template.

## Still to do (tomorrow, once we decide)

1. Submit + approve (manual, online):
   - Confirm `META_WABA_ID` = live WABA `986225450549617` in `.env`.
   - Add `templates/owner_escalation_alert_en.json` to `TEMPLATE_FILES` in
     `scripts/submit_templates.js`.
   - `node scripts/submit_templates.js`, then `node scripts/check_templates.js`
     until status = APPROVED. Adjust per the open questions in the template's
     `_notes` if Meta rejects (variable-at-start, embedded newline, dynamic
     button suffix).

2. Code switch (in `src/whatsapp.js` + `src/handler.js`):
   - Add `sendTemplate(to, templateName, bodyParams[], buttonUrlSuffix)` in
     `src/whatsapp.js` (POST /messages, type=template, components with body
     parameters + a button parameter of sub_type=url index 0). A `sendTemplate`
     helper may already exist (see tech-stack notes); reuse if so.
   - Add `buildOwnerAlertTemplateParams(contact, classification)` in
     `src/owner_alert.js`, reusing the SAME pieces buildOwnerAlertText already
     derives: header (from caller), number, product (or "Not specified"),
     ownerBriefLine, and the follow-up suffix `<digits>?text=<encoded draft>`.
     Keep it pure + unit-tested (assert 4 body params + the suffix).
   - In `notifyOwnerEscalation` (and the follow-up-ping path), send the template
     instead of / in addition to the free-form text.

3. Delivery policy (decide):
   - Option A (simplest, most reliable): ALWAYS send the template. One code
     path, guaranteed delivery, fixed-ish layout.
   - Option B (richest): send free-form when inside the recipient's 24h window
     (we can't cheaply know the window state per recipient, so this needs a
     heuristic, e.g. last inbound-from-owner timestamp), template otherwise.
     More code, marginal benefit. Lean A unless the team dislikes the layout.

## Constraints to remember

- Template variables cannot be blank -> product passes "Not specified" when
  unknown (we lose the "omit Product line" behavior of the free-form version).
- The header text still varies per escalation type; it rides in a variable, so
  no re-approval per type.
- The 2-line summary stays fully dynamic (it is a variable); Meta approved only
  the empty shape, never the per-lead wording.
- Tiny per-message fee (UTILITY conversation), negligible at this volume.

## Out of scope
- Any change to the routing logic (already shipped) or customer-facing replies.
