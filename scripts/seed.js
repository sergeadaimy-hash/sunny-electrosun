require('dotenv').config();

const { initDb } = require('../db/init');
const { getOrCreateContact, getActiveConversation, appendMessage, logEvent } = require('../src/memory');

initDb();

const samples = [
  {
    phone: '2348011112222',
    name: 'Adaeze (test)',
    category: 'C2',
    lead_temperature: 'WARM',
    client_type: 'commercial',
    body: 'Hi, I need pricing on a 30kW Sungrow inverter for my supermarket in Lagos.'
  },
  {
    phone: '2348011113333',
    name: 'Tunde (test)',
    category: 'C4',
    lead_temperature: 'COLD',
    client_type: 'residential',
    body: 'How does solar work for a 3-bedroom flat?'
  },
  {
    phone: '2348011114444',
    name: 'Kemi (test)',
    category: 'C2',
    lead_temperature: 'WARM',
    client_type: 'installer',
    body: 'I am an installer, do you sell Deye batteries on dealer pricing?'
  },
  {
    phone: '2348011115555',
    name: 'Ibrahim (test)',
    category: 'C3',
    lead_temperature: 'HOT',
    client_type: 'hotel',
    body: 'Send me a proforma for solar at our hotel in Abuja, ready to proceed this week.'
  }
];

const { updateContactFields } = require('../src/memory');

for (const s of samples) {
  const contact = getOrCreateContact(s.phone, s.name);
  const conv = getActiveConversation(contact.id);
  appendMessage(conv.id, 'inbound', s.body, { language: 'english' });
  appendMessage(conv.id, 'outbound', `Hello, thanks for reaching out. (seed)`, { intent: 'greeting' });

  const updates = {};
  if (contact.category !== s.category) {
    logEvent(contact.id, 'category_changed', {
      from: contact.category,
      to: s.category,
      confidence: 90,
      lead_temperature: s.lead_temperature
    });
    updates.category = s.category;
  }
  updates.lead_temperature = s.lead_temperature;
  if (!contact.client_type) updates.client_type = s.client_type;

  updateContactFields(contact.id, updates);
}

console.log('Seeded 4 demo contacts (C1-C5 + HOT/WARM/COLD framework).');
