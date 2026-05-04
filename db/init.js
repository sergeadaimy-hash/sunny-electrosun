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

  return db;
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
