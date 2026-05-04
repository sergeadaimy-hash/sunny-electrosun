require('dotenv').config();
const axios = require('axios');

const WABA_ID = process.env.META_WABA_ID || '1713234916358524';
const TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_VERSION = 'v21.0';

if (!TOKEN) {
  console.error('META_ACCESS_TOKEN missing from .env');
  process.exit(1);
}

const STATUS_GLYPH = {
  APPROVED: 'OK',
  PENDING: '..',
  REJECTED: 'XX',
  DISABLED: '--',
  PAUSED: '||',
};

async function main() {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates`;
  const params = { fields: 'name,status,category,language,rejected_reason', limit: 100 };

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      params,
    });
    const rows = res.data.data || [];
    if (!rows.length) {
      console.log('No templates found on this WABA.');
      return;
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    const nameWidth = Math.max(...rows.map(r => r.name.length), 4);

    console.log(`\n${'NAME'.padEnd(nameWidth)}  STATUS    CATEGORY  LANG`);
    console.log('-'.repeat(nameWidth + 30));

    for (const r of rows) {
      const glyph = STATUS_GLYPH[r.status] || '??';
      const status = `${glyph} ${r.status}`.padEnd(10);
      const cat = (r.category || '').padEnd(9);
      const lang = (r.language || '').padEnd(5);
      console.log(`${r.name.padEnd(nameWidth)}  ${status} ${cat} ${lang}`);
      if (r.status === 'REJECTED' && r.rejected_reason) {
        console.log(`  reason: ${r.rejected_reason}`);
      }
    }
    console.log('');
  } catch (err) {
    const data = err.response && err.response.data;
    console.log('FAIL', err.response && err.response.status);
    console.log(JSON.stringify(data, null, 2));
  }
}

main();
