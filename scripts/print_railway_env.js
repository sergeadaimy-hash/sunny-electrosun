require('dotenv').config();

const cloudOverrides = {
  LOG_TO_FILE: 'false',
  DB_PATH: '/data/sunny.db',
  META_WABA_ID: '1713234916358524',
};

const skip = new Set(['PORT', 'LOG_TO_FILE']);

const lines = [];

const order = [
  'META_VERIFY_TOKEN',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'ANTHROPIC_API_KEY',
  'OWNER_WHATSAPP',
  'OWNER_EMAIL',
  'SPECIALIST_DIRECT_LINK',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'API_KEY',
  'DAILY_LLM_BUDGET_USD',
];

for (const key of order) {
  if (skip.has(key)) continue;
  let val = process.env[key];
  if (!val) continue;
  if (key === 'SPECIALIST_DIRECT_LINK') {
    val = val.replace(/[^0-9]/g, '');
  }
  lines.push(`${key}=${val}`);
}

for (const [k, v] of Object.entries(cloudOverrides)) {
  lines.push(`${k}=${v}`);
}

console.log('=== COPY EVERYTHING BELOW THIS LINE INTO RAILWAY RAW EDITOR ===');
console.log(lines.join('\n'));
console.log('=== END ===');
