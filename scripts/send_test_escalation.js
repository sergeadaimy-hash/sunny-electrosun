require('dotenv').config();
const { sendTemplate } = require('../src/whatsapp');
const { buildOwnerAlertTemplateComponents } = require('../src/owner_alert');

// One-shot test: send a sample owner/sales-desk escalation alert via the
// owner_escalation_alert_en template. Only works once the template is APPROVED
// on the live WABA (Meta rejects sends of PENDING/REJECTED templates).
//
//   node scripts/send_test_escalation.js            -> sends to OWNER_WHATSAPP (Patrick)
//   node scripts/send_test_escalation.js 234XXXXXXXXXX  -> sends to that number

const TEMPLATE = process.env.OWNER_ALERT_TEMPLATE || 'owner_escalation_alert_en';
const LANG = process.env.OWNER_ALERT_TEMPLATE_LANG || 'en';

const to = String(process.argv[2] || process.env.OWNER_WHATSAPP || '').replace(/\D+/g, '');

const sampleContact = { phone: '2348034455038' };
const sampleClassification = {
  escalation_type: 'hot_lead',
  intent: 'pricing_question',
  owner_brief: 'Customer wants to buy a Deye 6KW off-grid inverter today and is asking for the account to pay.',
  owner_followup_draft: 'Hello, this is ElectroSun following up on your Deye 6KW enquiry. How can we help you move forward?',
  lead_data: { products_asked_about: 'Deye 6KW Off-Grid Inverter' },
};

(async () => {
  if (!to) {
    console.error('No recipient. Set OWNER_WHATSAPP in .env or pass digits as the first argument.');
    process.exit(1);
  }
  const header = 'HOT LEAD, customer is ready to pay.';
  const components = buildOwnerAlertTemplateComponents(
    sampleContact,
    sampleClassification,
    header,
    'I want to pay for the Deye 6KW now, send account.'
  );
  console.log(`Sending template "${TEMPLATE}" (${LANG}) to ${to} ...`);
  const res = await sendTemplate(to, TEMPLATE, LANG, components);
  if (res.ok) {
    console.log(`  OK  messageId=${res.messageId}`);
  } else {
    console.log(`  FAIL  status=${res.status}`);
    console.log('  body:', JSON.stringify(res.error, null, 2));
  }
})();
