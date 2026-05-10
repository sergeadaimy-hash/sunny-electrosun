const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sunny.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  applyMigrations(db);
  seedCatalogIfEmpty(db);

  return db;
}

function seedCatalogIfEmpty(db) {
  try {
    const itemCount = db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get().n;
    const noteCount = db.prepare('SELECT COUNT(*) AS n FROM catalog_notes').get().n;
    if (itemCount > 0 && noteCount > 0) return;

    const seedPath = path.join(__dirname, '..', 'src', 'knowledge', 'products.json');
    if (!fs.existsSync(seedPath)) return;
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

    let itemsSeeded = 0;
    if (itemCount === 0 && seed.categories) {
      const insertItem = db.prepare(
        `INSERT INTO catalog_items (section, brand, model, size_kw, capacity_kwh, phase, type, price_ngn, in_stock, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const tx = db.transaction(() => {
        for (const [section, items] of Object.entries(seed.categories)) {
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            insertItem.run(
              section,
              it.brand || '',
              it.model || '',
              typeof it.size_kw === 'number' ? it.size_kw : null,
              typeof it.capacity_kwh === 'number' ? it.capacity_kwh : null,
              it.phase || null,
              it.type || null,
              typeof it.price_ngn === 'number' ? it.price_ngn : null,
              it.in_stock === false ? 0 : 1,
              it.notes || null,
              itemsSeeded++
            );
          }
        }
      });
      tx();
      console.log('catalog: seeded', itemsSeeded, 'items from products.json');
    }

    let notesSeeded = 0;
    if (noteCount === 0 && Array.isArray(seed.notes)) {
      const insertNote = db.prepare('INSERT INTO catalog_notes (text, sort_order) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const n of seed.notes) {
          if (typeof n === 'string' && n.trim()) insertNote.run(n.trim(), notesSeeded++);
        }
      });
      tx();
      console.log('catalog: seeded', notesSeeded, 'notes from products.json');
    }
  } catch (err) {
    console.error('catalog seed error:', err.message);
  }
}

function applyMigrations(db) {
  const expected = {
    contacts: [
      { name: 'lead_temperature', type: 'TEXT' },
      { name: 'client_type', type: 'TEXT' },
      { name: 'products_asked_about', type: 'TEXT' },
      { name: 'brand_preference', type: 'TEXT' },
      { name: 'budget_mentioned', type: 'TEXT' }
    ],
    pending_queries: [
      { name: 'expiring_warning_sent_at', type: 'TIMESTAMP' }
    ],
    conversations: [
      { name: 'human_handled', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'human_handled_at', type: 'TIMESTAMP' }
    ],
    messages: [
      { name: 'media_path', type: 'TEXT' },
      { name: 'media_mime', type: 'TEXT' }
    ],
    warehouse_items: [
      { name: 'datasheet_filename', type: 'TEXT' },
      { name: 'datasheet_path', type: 'TEXT' },
      { name: 'datasheet_mime', type: 'TEXT' },
      { name: 'datasheet_size_bytes', type: 'INTEGER' },
      { name: 'datasheet_meta_media_id', type: 'TEXT' },
      { name: 'datasheet_meta_uploaded_at', type: 'TEXT' }
    ]
  };

  for (const [table, cols] of Object.entries(expected)) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    for (const col of cols) {
      if (!existing.includes(col.name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
        console.log(`migration: added ${table}.${col.name}`);
      }
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_lead_temperature ON contacts(lead_temperature);
    CREATE INDEX IF NOT EXISTS idx_contacts_client_type ON contacts(client_type);
  `);
}

let instance = null;

function getDb() {
  if (!instance) instance = initDb();
  return instance;
}

if (require.main === module) {
  const db = initDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('DB initialized at', DB_PATH);
  console.log('Tables:', tables.map(t => t.name).join(', '));
  db.close();
}

module.exports = { getDb, initDb, DB_PATH };
