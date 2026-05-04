require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.API_KEY;
const BASE = process.env.SUNNY_BASE_URL || 'https://sunny-electrosun-production.up.railway.app';
if (!API_KEY) { console.error('API_KEY missing from .env'); process.exit(1); }

const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };

(async () => {
  console.log('Fetching active facts...');
  const res = await axios.get(`${BASE}/api/knowledge?status=active`, { headers, timeout: 30000 });
  const entries = res.data.entries || [];
  console.log(`  ${entries.length} active facts on file`);

  const toReject = entries.filter(e => {
    const t = (e.extracted_fact || '').toLowerCase();
    return e.category === 'pricing' && (t.startsWith('past quote') || t.includes('past quote ('));
  });

  console.log(`  ${toReject.length} historical "Past quote" facts to reject (cost source is the catalog only)`);

  let rejected = 0;
  for (const e of toReject) {
    try {
      await axios.post(`${BASE}/api/knowledge/${e.id}/status`, { status: 'rejected' }, { headers, timeout: 15000 });
      rejected++;
      if (rejected % 10 === 0) process.stdout.write(`(${rejected}) `);
      else process.stdout.write('.');
    } catch (err) {
      console.warn('  fail:', err.response?.data || err.message);
    }
  }
  console.log(`\nDone. Rejected ${rejected} historical price facts. They stay in the DB for audit, but no longer feed Sunny's prompt.`);
})();
