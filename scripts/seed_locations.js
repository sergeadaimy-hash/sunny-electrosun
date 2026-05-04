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
    category: 'operations',
    text: "Electro-Sun is a DEYE Platinum authorised distributor in Nigeria, with two locations: Abuja (head office plus warehouse) and Lagos."
  },
  {
    category: 'operations',
    text: "Abuja office address: Sunset Place, 141 Adetokunbo Ademola Crescent, Wuse 2, Abuja."
  },
  {
    category: 'operations',
    text: "Abuja warehouse address: Plot 816, Gidado Idriss Way, Idu Industrial Area, FCT Abuja."
  },
  {
    category: 'operations',
    text: "Abuja contacts: Charbel on 09068859213, Patrick on 07041328055."
  },
  {
    category: 'operations',
    text: "Lagos office address: Guardian Newspapers Ltd, Rutam House, Apapa-Oshodi Expressway, Isolo, P.M.B 1217, Oshodi, Lagos, Nigeria."
  },
  {
    category: 'operations',
    text: "Lagos contact: 0911 188 0000."
  },
  {
    category: 'sales',
    text: "When asked about credentials or trust, lead with: Electro-Sun is a DEYE Platinum authorised distributor."
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
      console.log(`OK [${f.category}] id=${res.data.id} - ${f.text.slice(0, 60)}...`);
      saved++;
    } catch (err) {
      const data = err.response && err.response.data;
      console.log(`FAIL [${f.category}] http=${err.response && err.response.status}`);
      console.log('  ', JSON.stringify(data));
    }
  }
  console.log(`\nDone. ${saved} of ${facts.length} facts saved.`);
})();
