const { getDb } = require('../db/init');

const ITEM_FIELDS = [
  'section', 'brand', 'model',
  'size_kw', 'capacity_kwh', 'phase', 'type',
  'price_ngn', 'in_stock', 'notes', 'sort_order'
];

function listItems() {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM catalog_items ORDER BY section ASC, sort_order ASC, id ASC`
  ).all();
}

function listNotes() {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM catalog_notes ORDER BY sort_order ASC, id ASC`
  ).all();
}

function getCatalog() {
  return { items: listItems(), notes: listNotes() };
}

function coerceItem(input) {
  const out = {};
  for (const k of ITEM_FIELDS) {
    if (input[k] === undefined) continue;
    let v = input[k];
    if (k === 'price_ngn' || k === 'sort_order') {
      v = (v === null || v === '') ? null : Math.round(Number(v));
      if (Number.isNaN(v)) v = null;
    } else if (k === 'size_kw' || k === 'capacity_kwh') {
      v = (v === null || v === '') ? null : Number(v);
      if (Number.isNaN(v)) v = null;
    } else if (k === 'in_stock') {
      v = v ? 1 : 0;
    } else {
      v = v == null ? null : String(v).trim();
      if (v === '') v = null;
    }
    out[k] = v;
  }
  return out;
}

function addItem(input) {
  const db = getDb();
  const data = coerceItem(input);
  if (!data.section || !data.brand || !data.model) {
    throw new Error('section, brand, and model are required');
  }
  if (data.in_stock === null || data.in_stock === undefined) data.in_stock = 1;
  if (data.sort_order === null || data.sort_order === undefined) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM catalog_items WHERE section = ?').get(data.section).m;
    data.sort_order = max + 1;
  }
  const cols = ITEM_FIELDS.filter(k => data[k] !== undefined);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(k => data[k]);
  const info = db.prepare(
    `INSERT INTO catalog_items (${cols.join(', ')}) VALUES (${placeholders})`
  ).run(...values);
  return info.lastInsertRowid;
}

function updateItem(id, input) {
  const db = getDb();
  const data = coerceItem(input);
  const cols = ITEM_FIELDS.filter(k => data[k] !== undefined);
  if (!cols.length) return;
  const setSql = cols.map(k => `${k} = ?`).join(', ');
  const values = cols.map(k => data[k]);
  values.push(id);
  db.prepare(
    `UPDATE catalog_items SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(...values);
}

function deleteItem(id) {
  const db = getDb();
  db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id);
}

function addNote(text) {
  const db = getDb();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM catalog_notes').get().m;
  const info = db.prepare(
    'INSERT INTO catalog_notes (text, sort_order) VALUES (?, ?)'
  ).run(text, max + 1);
  return info.lastInsertRowid;
}

function updateNote(id, text) {
  const db = getDb();
  db.prepare('UPDATE catalog_notes SET text = ? WHERE id = ?').run(text, id);
}

function deleteNote(id) {
  const db = getDb();
  db.prepare('DELETE FROM catalog_notes WHERE id = ?').run(id);
}

function formatNgn(n) {
  if (!n && n !== 0) return 'price on request';
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
    return m + 'M NGN';
  }
  if (n >= 1_000) return Math.round(n / 1_000) + 'k NGN';
  return n + ' NGN';
}

function formatCatalogForPrompt() {
  const items = listItems();
  const notes = listNotes();
  if (!items.length && !notes.length) return '';

  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`# Current Electro-Sun catalog (last refreshed ${today})`);
  lines.push('All prices in NGN. These are confirmed Electro-Sun prices, quote them directly to customers when asked.');
  lines.push('');

  const bySection = {};
  for (const it of items) {
    if (!bySection[it.section]) bySection[it.section] = [];
    bySection[it.section].push(it);
  }

  for (const [section, list] of Object.entries(bySection)) {
    lines.push('## ' + String(section).toUpperCase());
    for (const it of list) {
      const stock = it.in_stock ? 'in stock' : 'check with team';
      const price = it.price_ngn ? formatNgn(it.price_ngn) : 'price on request';
      lines.push('- ' + it.brand + ' ' + it.model + ': ' + price + ' (' + stock + ')');
    }
    lines.push('');
  }

  if (notes.length) {
    lines.push('## Catalog notes');
    for (const n of notes) lines.push('- ' + n.text);
  }

  return lines.join('\n').trim();
}

module.exports = {
  getCatalog,
  listItems,
  listNotes,
  addItem,
  updateItem,
  deleteItem,
  addNote,
  updateNote,
  deleteNote,
  formatCatalogForPrompt
};
