# Concise owner alerts with ready-to-send follow-up link

Date: 2026-06-06
Status: approved (pending spec review)

## Problem

Owner escalation alerts are long. They dump the customer's verbatim latest
message, a full multi-turn "Conversation so far" transcript, the customer
name, a Category/Temp/Intent signals line, and an admin deep-link. On a phone
the owner has to scroll a wall of text to understand a simple case (see the
2026-06-06 screenshot: a single "send me more detail" enquiry produced a
message that scrolled past one screen).

The owner wants a short brief, not a transcript.

## Goal

Replace the long alert with a compact one:

```
FOLLOW-UP NEEDED, customer is waiting on a team answer.
2348034455038
Product: Deye 6KW Off-Grid Inverter

Customer wants details on the Deye 6KW off-grid inverter.
No price or stock confirmed yet, needs a team reply.

Follow up on WhatsApp: https://wa.me/2348034455038?text=Hello...
```

## Decisions (all confirmed with owner)

1. **Drop** the customer name. Show the number only.
2. **Drop** the Category / Temp / Intent signals line.
3. **Drop** the verbatim "Latest message" block.
4. **Drop** the entire "Conversation so far" transcript.
5. **Drop** the "Open in admin" line and its link.
6. **Add** a 2-line plain-language situation summary, written by Sunny.
7. **Add** a `Product:` line, shown only when the case concerns a product
   (sourced from `lead_data.products_asked_about`, which the classifier
   already captures, so it does not depend on the summary wording).
8. **Keep** the typed header (HOT LEAD / FOLLOW-UP NEEDED / NEGOTIATION / etc.,
   unchanged, from `ESCALATION_HEADERS`).
9. **Keep** the wa.me link, and upgrade it: it carries a `?text=` pre-filled,
   **client-facing follow-up opener** so when the owner taps the link, a chat
   to the customer opens from the owner's own number with a message ready in
   the box. The owner reviews and hits send. No typing.

## How the two generated pieces are produced

Both pieces ride on the classifier call that already runs on every customer
message. **Zero extra LLM calls, zero extra cost or latency.**

Add two fields to the classifier JSON output:

- `owner_brief`: a 2-line, owner-facing summary of the situation. Names the
  product when relevant. Internal, never sent to the customer.
- `owner_followup_draft`: a short (1 to 2 sentence) client-facing follow-up
  opener the owner can send as-is. Obeys the no-double-dash rule. Never
  invents a price, stock figure, spec, or timeline.

The classifier only needs to populate these when `needs_escalation` is true
(every alert path runs through classification, or through a synthetic
classification on the stall-guard / photo paths).

`src/claude.js > classify` already returns `{ ...FALLBACK_CLASSIFICATION,
...parsed }`, so the two new fields pass through automatically once they are
added to `FALLBACK_CLASSIFICATION` (defaulting to `null`).

## Fallbacks (when owner_brief / owner_followup_draft are missing)

Some escalations are raised with a synthetic classification object that the
classifier never produced (stall-guard, photo-no-match, HOT-handoff-in-reply).
Those will not carry `owner_brief` / `owner_followup_draft`. The alert builder
must degrade gracefully:

- Missing `owner_brief` -> fall back to a single line:
  `Customer needs a team answer on: <intent>.` (intent from classification,
  default "their enquiry").
- Missing `owner_followup_draft` -> build the wa.me link with a generic
  opener: `Hello, this is ElectroSun following up on your enquiry. How can we
  help you move forward?`
- Missing `products_asked_about` -> omit the `Product:` line entirely.

## Code changes

### `src/prompts/classifier.md`
- Add the two output fields to the JSON schema with the constraints above.
- Add a short rule block: when `needs_escalation` is true, write a 2-line
  `owner_brief` and a 1-2 sentence `owner_followup_draft`; the draft is
  client-facing, no double dashes, no invented prices/specs/stock/timelines.

### `src/claude.js`
- Add `owner_brief: null` and `owner_followup_draft: null` to
  `FALLBACK_CLASSIFICATION` (top level).
- The no-double-dash output guard is reply-side only; the follow-up draft is
  not a Sunny reply, so apply a small dash-strip to `owner_followup_draft`
  inside the alert builder before URL-encoding (reuse the existing dash
  cleanup helper rather than the full reply guard chain).

### `src/handler.js`
Rewrite the line-assembly in two places to the new format:

1. `notifyOwnerEscalation(contact, message, classification)` (the main alert).
2. The inline follow-up-ping builder inside `notifyOwnerForEscalation`
   (the "FOLLOW-UP, same customer is still asking" path) — apply the same
   concise shape so repeat pings are short too.

Add one helper, `buildOwnerFollowupLink(contact, classification)`, that returns
the wa.me URL with the URL-encoded (dash-stripped) follow-up draft, or the
plain wa.me URL with the generic opener as fallback. Remove the
`formatConversationBriefForOwner` calls and the admin-link calls from both
builders. `formatConversationBriefForOwner` and `buildAdminConversationLink`
stay in the file (still used elsewhere / harmless), but are no longer called
from the alert builders.

The persisted owner-conversation copy (`appendMessage` to the owner's thread)
uses the same new concise text, so the admin Owner Chat tab shows the short
version too.

## Out of scope

- Multi-owner routing (parked until the owner sends team details).
- Changing alert delivery from free-form to Meta templates.
- Any change to the customer-facing reply path or HOT-lead wa.me handoff link.

## Testing

- Add a unit test that builds an alert from a fully-populated classification
  and asserts: no customer name, no "Conversation so far", no "Latest message",
  no admin link, presence of the number, the `Product:` line, the 2-line
  summary, and a `wa.me/<digits>?text=` link whose decoded text matches the
  follow-up draft.
- Add a unit test for the fallback path (synthetic classification with no
  `owner_brief` / `owner_followup_draft` / product) asserting the generic
  summary line and generic opener, and that no `Product:` line appears.
- To make the builder testable, extract the pure line-assembly into a function
  that takes `(contact, classification)` and returns the alert string, so the
  test does not need WhatsApp or DB. `npm test` (node:test) already exists.
```
