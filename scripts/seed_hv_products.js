require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.API_KEY;
const BASE = process.env.SUNNY_BASE_URL || 'https://sunny-electrosun-production.up.railway.app';

if (!API_KEY) {
  console.error('API_KEY missing from .env');
  process.exit(1);
}

const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };

const items = [
  { section: 'inverters', brand: 'Deye', model: '30kW high voltage hybrid (3 phase)', size_kw: 30, phase: 'three', type: 'hybrid', price_ngn: 4_100_000, in_stock: true, notes: 'High voltage stack' },
  { section: 'inverters', brand: 'Deye', model: '50kW high voltage hybrid (3 phase)', size_kw: 50, phase: 'three', type: 'hybrid', price_ngn: 5_900_000, in_stock: true, notes: 'High voltage stack' },
  { section: 'inverters', brand: 'Deye', model: '80kW high voltage hybrid (3 phase)', size_kw: 80, phase: 'three', type: 'hybrid', price_ngn: 8_800_000, in_stock: true, notes: 'High voltage stack' },

  { section: 'batteries', brand: 'Deye', model: 'BOS-G pack 5.12kWh', capacity_kwh: 5.12, price_ngn: 1_150_000, in_stock: true, notes: 'High voltage lithium, requires BOS-G PDU and rack' },
  { section: 'batteries', brand: 'Deye', model: 'BOS-A pack 7.68kWh', capacity_kwh: 7.68, price_ngn: 1_650_000, in_stock: true, notes: 'High voltage lithium, requires BOS-A PDU and rack' },
  { section: 'batteries', brand: 'Deye', model: 'BOS-B Pro pack 16kWh', capacity_kwh: 16, price_ngn: 2_750_000, in_stock: true, notes: 'High voltage lithium, requires BOS-B PDU and accessories' },

  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-G PDU', price_ngn: 1_100_000, in_stock: true, notes: 'Power distribution unit for BOS-G batteries' },
  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-G Rack', price_ngn: 450_000, in_stock: true, notes: 'Mounting rack for BOS-G batteries' },
  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-A PDU', price_ngn: 1_400_000, in_stock: true, notes: 'Power distribution unit for BOS-A batteries' },
  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-A Rack 11', price_ngn: 500_000, in_stock: true, notes: 'Mounting rack for BOS-A batteries (Rack 11)' },
  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-A Rack 14', price_ngn: 550_000, in_stock: true, notes: 'Mounting rack for BOS-A batteries (Rack 14)' },
  { section: 'battery_accessories', brand: 'Deye', model: 'BOS-B PDU and accessories', price_ngn: 2_300_000, in_stock: true, notes: 'Full PDU plus accessories bundle for BOS-B Pro' },
];

const facts = [
  { category: 'product', text: 'BOS-G PDU can take up to 12 BOS-G battery packs (5.12kWh each) for a total of 61kWh per stack.' },
  { category: 'product', text: 'BOS-A PDU can take up to 21 BOS-A packs (7.68kWh each) when paired with the Deye 80kW high voltage hybrid inverter, and up to 16 BOS-A packs when paired with the 30kW or 50kW high voltage hybrid inverters.' },
  { category: 'product', text: 'BOS-B Pro BMS supports 16 BOS-B Pro packs (16kWh each) with the Deye 80kW high voltage hybrid inverter, and 13 packs with the 30kW or 50kW high voltage hybrid inverters.' },
  { category: 'product', text: 'High voltage Deye stack: pair the 30kW, 50kW, or 80kW 3-phase hybrid inverter with one of the BOS-G, BOS-A, or BOS-B Pro lithium battery families. Each battery family needs its own matching PDU and rack.' }
];

(async () => {
  let savedItems = 0;
  for (const it of items) {
    try {
      const res = await axios.post(`${BASE}/api/catalog/items`, it, { headers, timeout: 15000 });
      console.log(`OK item id=${res.data.id} - ${it.brand} ${it.model} @ ${it.price_ngn ? (it.price_ngn / 1_000_000).toFixed(2) + 'M NGN' : 'request'}`);
      savedItems++;
    } catch (err) {
      console.log(`FAIL item ${it.model}:`, err.response && err.response.data || err.message);
    }
  }

  let savedFacts = 0;
  for (const f of facts) {
    try {
      const res = await axios.post(`${BASE}/api/knowledge`, { text: f.text, category: f.category }, { headers, timeout: 15000 });
      console.log(`OK fact id=${res.data.id} [${f.category}] - ${f.text.slice(0, 80)}...`);
      savedFacts++;
    } catch (err) {
      console.log(`FAIL fact:`, err.response && err.response.data || err.message);
    }
  }

  console.log(`\nDone. ${savedItems}/${items.length} items, ${savedFacts}/${facts.length} facts.`);
})();
