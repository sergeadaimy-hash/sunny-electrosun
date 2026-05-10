const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb, DB_PATH } = require('../db/init');
const logger = require('./utils/logger');

const LOCATIONS = ['abuja', 'lagos'];
const STATES = ['in_stock', 'out_of_stock', 'incoming'];

const ITEM_FIELDS = ['section', 'brand', 'model', 'price_ngn', 'notes', 'sort_order'];
const STOCK_FIELDS = ['state', 'quantity', 'coming_note', 'eta_date'];

const DATASHEETS_DIR = process.env.WAREHOUSE_DATASHEETS_DIR || path.join(path.dirname(DB_PATH), 'warehouse_datasheets');
const MAX_DATASHEET_BYTES = parseInt(process.env.DATASHEET_MAX_BYTES || String(15 * 1024 * 1024), 10);
const ALLOWED_DATASHEET_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const META_MEDIA_TTL_DAYS = 25;

function ensureDatasheetsDir() {
  if (!fs.existsSync(DATASHEETS_DIR)) fs.mkdirSync(DATASHEETS_DIR, { recursive: true });
}

function sanitizeFilename(name) {
  const base = String(name || 'datasheet').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return base || 'datasheet';
}

function isAllowedMime(mime) {
  return !!mime && ALLOWED_DATASHEET_MIMES.includes(String(mime).toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function coerceItem(input) {
  const out = {};
  for (const k of ITEM_FIELDS) {
    if (input[k] === undefined) continue;
    let v = input[k];
    if (k === 'price_ngn' || k === 'sort_order') {
      v = (v === null || v === '') ? null : Math.round(Number(v));
      if (Number.isNaN(v)) v = null;
    } else {
      v = v == null ? null : String(v).trim();
      if (v === '') v = null;
    }
    out[k] = v;
  }
  return out;
}

function coerceStock(input) {
  const out = {};
  for (const k of STOCK_FIELDS) {
    if (input[k] === undefined) continue;
    let v = input[k];
    if (k === 'quantity') {
      v = (v === null || v === '') ? 0 : Math.round(Number(v));
      if (Number.isNaN(v) || v < 0) v = 0;
    } else if (k === 'state') {
      v = String(v || '').trim().toLowerCase();
      if (!STATES.includes(v)) v = 'out_of_stock';
    } else {
      v = v == null ? null : String(v).trim();
      if (v === '') v = null;
    }
    out[k] = v;
  }
  return out;
}

function listItems() {
  const db = getDb();
  const items = db.prepare(
    `SELECT * FROM warehouse_items ORDER BY section ASC, sort_order ASC, id ASC`
  ).all();
  if (!items.length) return [];
  const stockRows = db.prepare(
    `SELECT * FROM warehouse_stock WHERE item_id IN (${items.map(() => '?').join(',')})`
  ).all(...items.map(it => it.id));
  const stockByItem = {};
  for (const row of stockRows) {
    if (!stockByItem[row.item_id]) stockByItem[row.item_id] = {};
    stockByItem[row.item_id][row.location] = row;
  }
  return items.map(it => ({
    ...it,
    stock: {
      abuja: stockByItem[it.id]?.abuja || null,
      lagos: stockByItem[it.id]?.lagos || null
    }
  }));
}

function getItem(id) {
  const all = listItems();
  return all.find(it => it.id === id) || null;
}

function ensureStockRows(itemId) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT location FROM warehouse_stock WHERE item_id = ?'
  ).all(itemId).map(r => r.location);
  const insert = db.prepare(
    `INSERT INTO warehouse_stock (item_id, location, state, quantity, updated_at)
     VALUES (?, ?, 'out_of_stock', 0, ?)`
  );
  for (const loc of LOCATIONS) {
    if (!existing.includes(loc)) insert.run(itemId, loc, nowIso());
  }
}

function addItem(input) {
  const db = getDb();
  const data = coerceItem(input);
  if (!data.section || !data.brand || !data.model) {
    throw new Error('section, brand, and model are required');
  }
  if (data.sort_order === null || data.sort_order === undefined) {
    const max = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM warehouse_items WHERE section = ?'
    ).get(data.section).m;
    data.sort_order = max + 1;
  }
  const ts = nowIso();
  const cols = ITEM_FIELDS.filter(k => data[k] !== undefined);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map(k => data[k]);
  const info = db.prepare(
    `INSERT INTO warehouse_items (${cols.join(', ')}, created_at, updated_at)
     VALUES (${placeholders}, ?, ?)`
  ).run(...values, ts, ts);
  const itemId = info.lastInsertRowid;
  ensureStockRows(itemId);
  return itemId;
}

function updateItem(id, input) {
  const db = getDb();
  const data = coerceItem(input);
  const cols = ITEM_FIELDS.filter(k => data[k] !== undefined);
  if (!cols.length) return;
  const setSql = cols.map(k => `${k} = ?`).join(', ');
  const values = cols.map(k => data[k]);
  values.push(nowIso(), id);
  db.prepare(
    `UPDATE warehouse_items SET ${setSql}, updated_at = ? WHERE id = ?`
  ).run(...values);
}

function deleteItem(id) {
  const db = getDb();
  db.prepare('DELETE FROM warehouse_stock WHERE item_id = ?').run(id);
  db.prepare('DELETE FROM warehouse_items WHERE id = ?').run(id);
}

function setStock(itemId, location, input) {
  if (!LOCATIONS.includes(location)) {
    throw new Error('location must be one of: ' + LOCATIONS.join(', '));
  }
  const db = getDb();
  const item = db.prepare('SELECT id FROM warehouse_items WHERE id = ?').get(itemId);
  if (!item) throw new Error('item not found');
  ensureStockRows(itemId);
  const data = coerceStock(input);
  const cols = STOCK_FIELDS.filter(k => data[k] !== undefined);
  if (!cols.length) return;
  const setSql = cols.map(k => `${k} = ?`).join(', ');
  const values = cols.map(k => data[k]);
  values.push(nowIso(), itemId, location);
  db.prepare(
    `UPDATE warehouse_stock SET ${setSql}, updated_at = ? WHERE item_id = ? AND location = ?`
  ).run(...values);
}

function adjustQuantity(itemId, location, delta) {
  if (!LOCATIONS.includes(location)) {
    throw new Error('location must be one of: ' + LOCATIONS.join(', '));
  }
  const n = Math.round(Number(delta));
  if (!Number.isFinite(n) || n === 0) return;
  const db = getDb();
  ensureStockRows(itemId);
  db.prepare(`
    UPDATE warehouse_stock
    SET quantity = MAX(0, quantity + ?),
        updated_at = ?
    WHERE item_id = ? AND location = ?
  `).run(n, nowIso(), itemId, location);
}

function formatNgn(n) {
  if (!n && n !== 0) return null;
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
    return m + 'M NGN';
  }
  if (n >= 1_000) return Math.round(n / 1_000) + 'k NGN';
  return n + ' NGN';
}

function describeStock(s, price) {
  if (!s) return 'no record';
  const parts = [];
  if (s.state === 'in_stock') {
    parts.push('IN STOCK');
    if (s.quantity > 0) parts.push(s.quantity + ' unit' + (s.quantity === 1 ? '' : 's'));
  } else if (s.state === 'incoming') {
    parts.push('INCOMING');
    if (s.eta_date) parts.push('ETA ' + s.eta_date);
    if (s.coming_note) parts.push('"' + s.coming_note + '"');
  } else {
    parts.push('OUT OF STOCK');
    if (s.coming_note) parts.push('note: "' + s.coming_note + '"');
  }
  const priceStr = formatNgn(price);
  if (priceStr) parts.push(priceStr);
  return parts.join(', ');
}

function formatWarehouseForPrompt() {
  const items = listItems();
  if (!items.length) return '';

  const lines = [];
  const today = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`# Warehouse stock (live source of truth, last refreshed ${today} UTC)`);
  lines.push('Authoritative list of every item Electro-Sun stocks, with separate state for the Abuja warehouse and the Lagos warehouse. Use this block to answer "do you have X?", "is it in stock?", "how many are left?", and "when is it arriving?". Quote ETA dates and "incoming" notes verbatim, never invent them. If a customer asks for an item that is not listed below, tell them it is not in our current warehouse list and offer to confirm with the team.');
  lines.push('');

  const bySection = {};
  for (const it of items) {
    if (!bySection[it.section]) bySection[it.section] = [];
    bySection[it.section].push(it);
  }

  for (const [section, list] of Object.entries(bySection)) {
    lines.push('## ' + String(section).toUpperCase());
    for (const it of list) {
      const head = it.brand + ' ' + it.model + (it.notes ? ' (' + it.notes + ')' : '');
      lines.push('- ' + head);
      lines.push('  - Abuja: ' + describeStock(it.stock.abuja, it.price_ngn));
      lines.push('  - Lagos: ' + describeStock(it.stock.lagos, it.price_ngn));
      if (it.datasheet_path) lines.push('  - Datasheet on file: yes (the system attaches it automatically when the customer asks for a datasheet, brochure, or spec sheet for this item).');
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function setDatasheet(itemId, { filename, base64, mimeType }) {
  const db = getDb();
  const item = db.prepare('SELECT id, datasheet_path FROM warehouse_items WHERE id = ?').get(itemId);
  if (!item) throw new Error('item not found');
  if (!isAllowedMime(mimeType)) throw new Error('mime not allowed: ' + mimeType);
  if (!base64) throw new Error('file content required');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('empty file');
  if (buffer.length > MAX_DATASHEET_BYTES) {
    throw new Error('file too large: ' + buffer.length + ' bytes (max ' + MAX_DATASHEET_BYTES + ')');
  }

  ensureDatasheetsDir();
  const safeName = sanitizeFilename(filename);
  const hash = crypto.randomBytes(8).toString('hex');
  const finalName = hash + '_' + safeName;
  const finalPath = path.join(DATASHEETS_DIR, finalName);
  fs.writeFileSync(finalPath, buffer);

  // Remove old file if any
  if (item.datasheet_path && fs.existsSync(item.datasheet_path)) {
    try { fs.unlinkSync(item.datasheet_path); }
    catch (err) { logger.warn('warehouse.datasheet.unlink_old_fail', { itemId, message: err.message }); }
  }

  db.prepare(`
    UPDATE warehouse_items
    SET datasheet_filename = ?, datasheet_path = ?, datasheet_mime = ?, datasheet_size_bytes = ?,
        datasheet_meta_media_id = NULL, datasheet_meta_uploaded_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(safeName, finalPath, mimeType, buffer.length, nowIso(), itemId);
  logger.info('warehouse.datasheet.attached', { itemId, filename: safeName, size_bytes: buffer.length });
}

function removeDatasheet(itemId) {
  const db = getDb();
  const item = db.prepare('SELECT datasheet_path FROM warehouse_items WHERE id = ?').get(itemId);
  if (!item) return;
  if (item.datasheet_path && fs.existsSync(item.datasheet_path)) {
    try { fs.unlinkSync(item.datasheet_path); }
    catch (err) { logger.warn('warehouse.datasheet.unlink_fail', { itemId, message: err.message }); }
  }
  db.prepare(`
    UPDATE warehouse_items
    SET datasheet_filename = NULL, datasheet_path = NULL, datasheet_mime = NULL,
        datasheet_size_bytes = NULL, datasheet_meta_media_id = NULL, datasheet_meta_uploaded_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), itemId);
  logger.info('warehouse.datasheet.removed', { itemId });
}

function setItemDatasheetMetaCache(itemId, mediaId) {
  const db = getDb();
  db.prepare(
    'UPDATE warehouse_items SET datasheet_meta_media_id = ?, datasheet_meta_uploaded_at = ?, updated_at = ? WHERE id = ?'
  ).run(mediaId, nowIso(), nowIso(), itemId);
}

function isMetaMediaFresh(uploadedAt) {
  if (!uploadedAt) return false;
  const ageDays = (Date.now() - new Date(uploadedAt).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays < META_MEDIA_TTL_DAYS;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// Pull out size tokens like "80", "12.5" from "80kw", "80kW", "12kw", "80k",
// "80kva", "16kwh". Returns the bare numbers as a Set of strings.
function extractSizeNumbers(text) {
  const out = new Set();
  if (!text) return out;
  const re = /\b(\d+(?:\.\d+)?)\s*(?:kw|kva|kwh|k)\b/gi;
  let m;
  const s = String(text);
  while ((m = re.exec(s)) !== null) out.add(m[1]);
  return out;
}

function findItemDatasheetByQuery(message, recentText = '') {
  const db = getDb();
  const items = db.prepare(`
    SELECT id, brand, model, notes, section, datasheet_path, datasheet_filename,
           datasheet_mime, datasheet_meta_media_id, datasheet_meta_uploaded_at
    FROM warehouse_items
    WHERE datasheet_path IS NOT NULL
  `).all();
  if (!items.length) return null;

  // Size match is the hard gate. If the customer message names a specific size
  // ("80kw", "12.5kva", "16kwh"), only items with that same size in their model
  // or notes are candidates. This stops "80kw datasheet" from falling back to
  // the 50kW item just because it's the only one with a PDF attached.
  const querySizes = extractSizeNumbers(message);
  let candidates = items;
  if (querySizes.size > 0) {
    candidates = items.filter(it => {
      const itemSizes = extractSizeNumbers(
        [it.brand, it.model, it.notes].filter(Boolean).join(' ')
      );
      for (const q of querySizes) {
        if (itemSizes.has(q)) return true;
      }
      return false;
    });
    if (!candidates.length) return null; // no matching size, do NOT fall back
  }

  // Among the candidates, rank by ordinary token overlap (brand, model, notes,
  // section) for the tie-breaker.
  const queryTokens = new Set(tokenize(message + ' ' + recentText));
  let best = null;
  let bestScore = 0;
  for (const it of candidates) {
    const itemTokens = tokenize([it.brand, it.model, it.notes, it.section].filter(Boolean).join(' '));
    let score = 0;
    for (const t of itemTokens) {
      if (queryTokens.has(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  // If the customer named a size and exactly one candidate matched it, send
  // that one even if the token score is 0 (e.g. "send the 80kw datasheet").
  if (best) return { item: best, score: bestScore };
  if (querySizes.size > 0 && candidates.length === 1) {
    return { item: candidates[0], score: 0 };
  }
  // No size given AND no token match. Don't guess. Return null so the LLM
  // handles the request in text instead of sending a possibly-wrong PDF.
  return null;
}

module.exports = {
  LOCATIONS,
  STATES,
  DATASHEETS_DIR,
  MAX_DATASHEET_BYTES,
  isAllowedMime,
  listItems,
  getItem,
  addItem,
  updateItem,
  deleteItem,
  setStock,
  adjustQuantity,
  ensureStockRows,
  setDatasheet,
  removeDatasheet,
  setItemDatasheetMetaCache,
  isMetaMediaFresh,
  findItemDatasheetByQuery,
  formatWarehouseForPrompt
};
