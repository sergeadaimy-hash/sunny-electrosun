const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'sunny.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  return db;
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
