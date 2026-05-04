require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.API_KEY;
const BASE = process.env.SUNNY_BASE_URL || 'https://sunny-electrosun-production.up.railway.app';

if (!API_KEY) {
  console.error('API_KEY missing from .env');
  process.exit(1);
}

const facts = [
  {
    category: 'sales',
    text: "Never proactively share Electro-Sun addresses or phone numbers in a customer reply. Share an address ONLY when the customer explicitly asks about location, pickup, store visit, warehouse, or how to reach Electro-Sun in person."
  },
  {
    category: 'sales',
    text: "Phone numbers (Charbel 09068859213, Patrick 07041328055, Lagos line 0911 188 0000) are reserved for HOT leads only (customer is ready to pay or commit). For routine specific questions or quotes, do NOT give a phone number; escalate via silent_query and the owner will reply through the alert. The customer will get the answer relayed back to them automatically."
  },
  {
    category: 'sales',
    text: "When a customer asks for credentials or trust signals, lead with: Electro-Sun is a DEYE Platinum authorised distributor in Nigeria. Do not list addresses or phone numbers as part of credentials unless asked separately."
  }
];

(async () => {
  let saved = 0;
  for (const f of facts) {
    try {
      const res = await axios.post(`${BASE}/api/knowledge`, {
        text: f.text,
        category: f.category
      }, {
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      console.log(`OK [${f.category}] id=${res.data.id} - ${f.text.slice(0, 80)}...`);
      saved++;
    } catch (err) {
      const data = err.response && err.response.data;
      console.log(`FAIL [${f.category}] http=${err.response && err.response.status}`);
      console.log('  ', JSON.stringify(data));
    }
  }
  console.log(`\nDone. ${saved} of ${facts.length} doctrine facts saved.`);
})();
