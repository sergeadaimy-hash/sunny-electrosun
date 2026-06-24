require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WABA_ID = process.env.META_WABA_ID || '1713234916358524';
const TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_VERSION = 'v21.0';

if (!TOKEN) {
  console.error('META_ACCESS_TOKEN missing from .env');
  process.exit(1);
}

const TEMPLATE_FILES = [
  // Already submitted/approved on the live WABA; re-submitting errors as a
  // duplicate name, so they stay commented. Uncomment only to re-create.
  // 'templates/owner_hourly_report_en.json',
  // 'templates/follow_up_24h_en.json',
  // 'templates/nightly_audit_ping_en.json',
  'templates/owner_escalation_alert_en.json',
];

async function submit(file) {
  const full = path.join(__dirname, '..', file);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const { _notes, ...body } = raw;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates`;
  console.log(`\nSubmitting ${body.name} ...`);

  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`  OK  id=${res.data.id} status=${res.data.status} category=${res.data.category}`);
  } catch (err) {
    const data = err.response && err.response.data;
    console.log(`  FAIL  http=${err.response && err.response.status}`);
    console.log('  body:', JSON.stringify(data, null, 2));
  }
}

(async () => {
  for (const f of TEMPLATE_FILES) await submit(f);
})();
