# ElectroLeads escalation handoff

Everything ElectroLeads needs to send owner / sales-desk escalation alerts the
same way Sunny does, to the same four numbers, using the same WhatsApp template
so the alerts are not silently dropped outside Meta's 24h window.

Read the three CRITICAL caveats first, then copy the template, the env vars, and
the `escalation-kit.js` module.

---

## CRITICAL caveats (read before copying anything)

1. **A template is per-WABA. You cannot reuse our approved template id.** The
   template DEFINITION below is reusable, but each WhatsApp Business Account
   must submit and get its OWN approval. Submit the JSON on YOUR WABA, wait for
   `APPROVED`, then use it. The name (`owner_escalation_alert_en`) can be the
   same; the numeric id will be different (yours).

2. **Meta only delivers APPROVED templates.** Sending a PENDING or REJECTED
   template errors out. The kit below tries the template first and falls back to
   a free-form text send, so it is safe to deploy before approval (it just stays
   window-bound until Meta approves).

3. **The four numbers are YOUR env values, not hard-coded.** Set them on the
   ElectroLeads side. Owners (Patrick, Charbel) receive BIG PROJECTS only;
   everything else routes to the regional sales desk (Abuja / Lagos).

4. **Your WABA needs a valid payment method, or template sends silently fail.**
   Template messages are billed, so a WABA with no payment method attached has
   the API accept the send (`messages.ok`) but the delivery webhook returns
   `error_code 131042 "Business eligibility payment issue"` and nothing arrives.
   Free-form in-window replies still work, so this is easy to miss. Add a
   payment method in WhatsApp Manager -> Billing before relying on the alerts.
   (We hit exactly this on our first live test 2026-06-24.)

---

## 1. The template (submit on YOUR WABA)

Save as `owner_escalation_alert_en.json`. This exact shape cleared Meta after
three rejections, so keep the structure if you want it to pass:

- No URL button (Meta blocks `wa.me` links in buttons, subcode 2388081). The
  follow-up link rides in body text instead.
- Exactly 4 variables (a 5-var version failed the parameters-to-words ratio,
  subcode 2388293).
- The body neither starts nor ends with a variable (subcode 2388299).

```json
{
  "name": "owner_escalation_alert_en",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Electro-Sun lead alert. A customer is waiting on a team follow-up, please take a look.\n\nStatus: {{1}}\nCustomer number: {{2}}\n\nSummary: {{3}}\n\nTo reply to this customer on WhatsApp, tap the link below: {{4}}\n\nYou can also open the Electro-Sun admin inbox to see the full conversation.",
      "example": {
        "body_text": [[
          "FOLLOW-UP NEEDED, customer is waiting on a team answer.",
          "2348034455038",
          "Deye 6KW Off-Grid Inverter. Customer wants details on it, no price or stock confirmed yet, needs a team reply.",
          "https://wa.me/2348034455038?text=Hello%2C%20this%20is%20ElectroSun%20following%20up%20on%20your%20Deye%206KW%20enquiry.%20How%20can%20we%20help%20you%20move%20forward%3F"
        ]]
      }
    }
  ]
}
```

Variables: `{{1}}` status/header, `{{2}}` customer number, `{{3}}` one-line
summary (product folded in), `{{4}}` full `https://wa.me/...` follow-up link.

Submit it (Graph API v21.0), then poll for status:

```bash
# submit
curl -X POST "https://graph.facebook.com/v21.0/<YOUR_WABA_ID>/message_templates" \
  -H "Authorization: Bearer <YOUR_META_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d @owner_escalation_alert_en.json

# check status
curl -s "https://graph.facebook.com/v21.0/<YOUR_WABA_ID>/message_templates?fields=name,status,category,rejected_reason" \
  -H "Authorization: Bearer <YOUR_META_ACCESS_TOKEN>"
```

---

## 2. Env vars (set on the ElectroLeads side)

```
META_ACCESS_TOKEN=...            # ElectroLeads' Graph API token
META_PHONE_NUMBER_ID=...         # ElectroLeads' sending number id
OWNER_ALERT_TEMPLATE=owner_escalation_alert_en
OWNER_ALERT_TEMPLATE_LANG=en

# The four routing numbers (E.164 digits, no +). Owners = big projects only.
OWNER_WHATSAPP=234...            # Patrick (the default owner)
OWNER_CHARBEL_WHATSAPP=234...    # Charbel
SALES_ABUJA_WHATSAPP=234...      # Abuja sales desk
SALES_LAGOS_WHATSAPP=234...      # Lagos sales desk
```

Known business numbers for reference (confirm against the live values you use):
Patrick `07041328055`, Charbel `09068859213`, Lagos sales `0911 188 0000`.
In E.164 a leading `0` becomes `234` (e.g. `07041328055` -> `2347041328055`).

---

## 3. `escalation-kit.js` (portable, no database, depends only on `axios`)

Drop this in, set the env vars, and call `sendEscalationAlert(contact, classification)`.

```js
'use strict';
const axios = require('axios');

const GRAPH_VERSION = 'v21.0';
const TEMPLATE = process.env.OWNER_ALERT_TEMPLATE || 'owner_escalation_alert_en';
const LANG = process.env.OWNER_ALERT_TEMPLATE_LANG || 'en';
const GENERIC_FOLLOWUP_DRAFT =
  'Hello, this is ElectroSun following up on your enquiry. How can we help you move forward?';

// --- routing: owners handle big projects only; everything else by region ----
function numberForLabel(label) {
  const owner = process.env.OWNER_WHATSAPP || null;
  switch (label) {
    case 'patrick': return owner;
    case 'charbel': return process.env.OWNER_CHARBEL_WHATSAPP || owner;
    case 'abuja':   return process.env.SALES_ABUJA_WHATSAPP || owner;
    case 'lagos':   return process.env.SALES_LAGOS_WHATSAPP || owner;
    default:        return owner;
  }
}

// state must persist across restarts for a fair Charbel<->Patrick round-robin.
// Back this with your DB; this in-memory default just keeps the kit runnable.
let lastBigProjectAssignee = null;

// classification needs: routing_category ('big_project'|'daily_sales'|'unknown'),
// routing_region ('abuja'|'lagos'|'unknown'), and optionally stickyOwner.
function resolveRecipientLabel(classification) {
  const cat = String(classification.routing_category || '').toLowerCase();
  const region = String(classification.routing_region || '').toLowerCase();

  if (cat === 'big_project' || cat === 'big') {
    const sticky = classification.stickyOwner;
    if (sticky === 'patrick' || sticky === 'charbel') return sticky;
    const next = lastBigProjectAssignee === 'charbel' ? 'patrick' : 'charbel';
    lastBigProjectAssignee = next;            // persist this in your DB
    return next;
  }
  if (region === 'abuja') return 'abuja';
  if (region === 'lagos') return 'lagos';
  // region unknown and not a big project: default to the Abuja desk if set.
  return numberForLabel('abuja') ? 'abuja' : 'patrick';
}

// --- header by escalation type ----------------------------------------------
const HEADERS = {
  hot_lead: 'HOT LEAD, customer is ready to pay.',
  negotiation: 'NEGOTIATION, customer is asking for a discount or counter-offer.',
  big_project: 'BIG PROJECT, 30kW+ install / EPC enquiry.',
  bulk_order: 'BULK ORDER, customer wants a multi-unit quantity, confirm bulk price.',
  live_agent: 'LIVE AGENT REQUEST, customer asked to speak with a person.',
  repeat_complex: 'REPEAT CLIENT, returning customer with a complex ask.',
  silent_query: 'FOLLOW-UP NEEDED, customer is waiting on a team answer.',
};
function headerFor(type) { return HEADERS[type] || HEADERS.silent_query; }

// --- text helpers ------------------------------------------------------------
function stripDashes(t) {
  if (!t) return t;
  return String(t)
    .replace(/(\d)\s*[–]\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[—–]/g, '-')
    .replace(/\s*--\s*/g, ', ')
    .replace(/--/g, '-')
    .replace(/,(\s*,)+/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*([.?!:;])/g, '$1')
    .replace(/\s+,/g, ',')
    .trim();
}
function digitsOnly(p) { return String(p || '').replace(/\D+/g, ''); }

function summaryFor(classification, customerMessage) {
  let s = classification.owner_brief && String(classification.owner_brief).trim();
  if (!s) {
    const msg = customerMessage ? String(customerMessage).replace(/\s+/g, ' ').trim() : '';
    const topic = classification.intent && classification.intent !== 'other'
      ? String(classification.intent).replace(/_/g, ' ') : null;
    s = msg
      ? `Customer asked: "${msg.length > 180 ? msg.slice(0, 177) + '...' : msg}". ${topic ? 'Needs a team answer on ' + topic + '.' : 'Needs a team answer.'}`
      : `Customer needs a team answer on: ${topic || 'their enquiry'}.`;
  }
  s = stripDashes(s).replace(/\s*\n\s*/g, ' ').trim();
  const product = (classification.lead_data && classification.lead_data.products_asked_about)
    || classification.products_asked_about;
  if (product && !s.toLowerCase().includes(String(product).toLowerCase())) {
    s = `${String(product).trim()}. ${s}`;
  }
  return s;
}

function followupLink(contact, classification) {
  const d = digitsOnly(contact && contact.phone);
  if (!d) return null;
  let draft = classification.owner_followup_draft && String(classification.owner_followup_draft).trim();
  draft = draft ? stripDashes(draft) : GENERIC_FOLLOWUP_DRAFT;
  return `https://wa.me/${d}?text=${encodeURIComponent(draft)}`;
}

// --- template components (the 4 body params, in order) ----------------------
function buildComponents(contact, classification, headerText, customerMessage) {
  const link = followupLink(contact, classification);
  if (!link) return null;
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: headerText },
      { type: 'text', text: String(contact.phone) },
      { type: 'text', text: summaryFor(classification, customerMessage) },
      { type: 'text', text: link },
    ],
  }];
}

// --- WhatsApp sends ----------------------------------------------------------
function endpoint() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.META_PHONE_NUMBER_ID}/messages`;
}
function authHeaders() {
  return { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
}
async function sendTemplate(to, components) {
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'template', template: { name: TEMPLATE, language: { code: LANG }, components },
  };
  const res = await axios.post(endpoint(), payload, { headers: authHeaders(), timeout: 15000 });
  return res.data?.messages?.[0]?.id || null;
}
async function sendText(to, body) {
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'text', text: { preview_url: false, body },
  };
  const res = await axios.post(endpoint(), payload, { headers: authHeaders(), timeout: 15000 });
  return res.data?.messages?.[0]?.id || null;
}

function freeFormText(headerText, contact, classification, customerMessage) {
  const link = followupLink(contact, classification);
  const lines = ['Electro-Sun lead alert.', headerText, contact.phone, '', summaryFor(classification, customerMessage)];
  if (link) { lines.push('', `Follow up on WhatsApp: ${link}`); }
  return lines.join('\n');
}

// MAIN entry point. classification fields used:
//   escalation_type, intent, owner_brief, owner_followup_draft,
//   routing_category, routing_region, lead_data.products_asked_about
async function sendEscalationAlert(contact, classification, customerMessage) {
  const recipient = numberForLabel(resolveRecipientLabel(classification));
  if (!recipient) throw new Error('no recipient configured (set OWNER_WHATSAPP)');
  const header = headerFor(classification.escalation_type);
  const components = buildComponents(contact, classification, header, customerMessage);
  // template first (window-independent), free-form fallback
  if (components) {
    try { return { via: 'template', messageId: await sendTemplate(recipient, components), recipient }; }
    catch (e) { /* fall through to free-form */ }
  }
  const messageId = await sendText(recipient, freeFormText(header, contact, classification, customerMessage));
  return { via: 'free_form', messageId, recipient };
}

module.exports = { sendEscalationAlert, resolveRecipientLabel, numberForLabel, buildComponents };
```

Usage:

```js
const { sendEscalationAlert } = require('./escalation-kit');

await sendEscalationAlert(
  { phone: '2348034455038' },                       // the customer
  {
    escalation_type: 'hot_lead',
    intent: 'pricing_question',
    owner_brief: 'Customer wants to buy a Deye 6KW today and asked for the account to pay.',
    owner_followup_draft: 'Hello, this is ElectroSun following up on your Deye 6KW enquiry. How can we help you move forward?',
    routing_category: 'daily_sales',
    routing_region: 'abuja',
    lead_data: { products_asked_about: 'Deye 6KW Off-Grid Inverter' },
  },
  'I want to pay for the Deye 6KW now, send account.'  // raw customer message
);
```

---

## Notes for the colleague

- The round-robin state (`lastBigProjectAssignee`) is in-memory in this kit.
  Persist it in your DB so a restart does not always reset to Charbel.
- `routing_category` / `routing_region` are expected to come from however
  ElectroLeads classifies a lead. If you have no classifier, pass
  `routing_category: 'daily_sales'` and the customer's city as `routing_region`.
- `owner_brief` and `owner_followup_draft` are short strings your side writes
  (a 1-2 sentence situation summary, and a customer-facing follow-up opener).
  Both are optional; the kit builds sensible fallbacks from `customerMessage`.
- No double dashes anywhere in copy (em-dash, en-dash, or `--`). The kit strips
  them, but keep your source strings clean too.
