require('dotenv').config();

const { initDb } = require('../db/init');
const { getOrCreateContact, getActiveConversation, appendMessage, logEvent } = require('../src/memory');

initDb();

const samples = [
  { phone: '2348011112222', name: 'Adaeze (test)', category: 'serious_buyer', body: 'Hi, I need 5kVA system for my shop in Lagos. Budget around 2.5M.' },
  { phone: '2348011113333', name: 'Tunde (test)', category: 'explorer', body: 'How does solar work for a 3-bedroom flat?' },
  { phone: '2348011114444', name: 'Kemi (test)', category: 'queries_only', body: 'Do una sell battery only?' },
  { phone: '2348011115555', name: 'Ibrahim (test)', category: 'returning_customer', body: 'Sannu, ina son in tabbatar da maintenance na inverter dina.' }
];

for (const s of samples) {
  const contact = getOrCreateContact(s.phone, s.name);
  const conv = getActiveConversation(contact.id);
  appendMessage(conv.id, 'inbound', s.body, { language: detectSimple(s.body) });
  appendMessage(conv.id, 'outbound', `Hi ${s.name.split(' ')[0]}, thanks for reaching out. (seed)`, { intent: 'greeting' });
  if (contact.category !== s.category) {
    logEvent(contact.id, 'category_changed', { from: contact.category, to: s.category, confidence: 90 });
    require('../src/memory').updateContactFields(contact.id, { category: s.category });
  }
}

function detectSimple(text) {
  if (/\b(una|wahala|wetin|abi|na so)\b/i.test(text)) return 'pidgin';
  if (/\b(sannu|ina son|na ji|ku yi)\b/i.test(text)) return 'hausa';
  if (/\b(bawo|jowo|e se|emi|won)\b/i.test(text)) return 'yoruba';
  if (/\b(daalu|kedu|biko|nke|gini)\b/i.test(text)) return 'igbo';
  return 'english';
}

console.log('Seeded 4 demo contacts.');
