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

// Per-item cap on injected datasheet text. ~2KB per item × ~4 items in scope per
// reply keeps the Datasheet Knowledge block under 8KB even on busy turns.
const DATASHEET_TEXT_PER_ITEM_CAP = parseInt(process.env.DATASHEET_TEXT_PER_ITEM_CAP || '2000', 10);
const DATASHEET_BLOCK_TOTAL_CAP = parseInt(process.env.DATASHEET_BLOCK_TOTAL_CAP || '10000', 10);
const DATASHEET_SCOPE_HISTORY_TURNS = parseInt(process.env.DATASHEET_SCOPE_HISTORY_TURNS || '6', 10);

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

async function extractTextFromPdfBuffer(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    const raw = String(result?.text || '');
    return normalizeDatasheetText(raw);
  } catch (err) {
    logger.warn('warehouse.datasheet.pdf_extract_fail', { message: err.message });
    return '';
  }
}

function normalizeDatasheetText(s) {
  if (!s) return '';
  // Collapse runs of whitespace, drop completely blank lines, strip lines that
  // are page numbers, strip control chars. Keep meaningful structure (newlines
  // between sections), since spec tables read better when each row is its own
  // line.
  const lines = s
    .replace(/ +/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^\d{1,3}\s*\/\s*\d{1,3}$/.test(l) && !/^page\s+\d+$/i.test(l));
  return lines.join('\n').trim();
}

async function extractDatasheetTextForItem(itemId) {
  const db = getDb();
  const item = db.prepare(
    'SELECT id, datasheet_path, datasheet_mime, datasheet_filename FROM warehouse_items WHERE id = ?'
  ).get(itemId);
  if (!item || !item.datasheet_path || !fs.existsSync(item.datasheet_path)) return null;

  let text = '';
  if (item.datasheet_mime === 'application/pdf') {
    const buffer = fs.readFileSync(item.datasheet_path);
    text = await extractTextFromPdfBuffer(buffer);
  } else {
    // Image datasheets: nothing to extract text-wise here. We leave the field
    // empty; the file is still sent to the customer on request.
    text = '';
  }

  db.prepare(
    'UPDATE warehouse_items SET datasheet_text = ?, datasheet_text_extracted_at = ?, updated_at = ? WHERE id = ?'
  ).run(text || null, nowIso(), nowIso(), itemId);
  logger.info('warehouse.datasheet.text_extracted', {
    itemId, chars: text.length, mime: item.datasheet_mime
  });
  return text;
}

function setStaple(itemId, value) {
  const db = getDb();
  const v = value ? 1 : 0;
  db.prepare('UPDATE warehouse_items SET is_staple = ?, updated_at = ? WHERE id = ?')
    .run(v, nowIso(), itemId);
  logger.info('warehouse.staple.set', { itemId, is_staple: v });
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
        datasheet_text = NULL, datasheet_text_extracted_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(safeName, finalPath, mimeType, buffer.length, nowIso(), itemId);
  logger.info('warehouse.datasheet.attached', { itemId, filename: safeName, size_bytes: buffer.length });

  // Fire-and-forget text extraction so the upload response stays fast. The
  // extracted text just won't be in the Datasheet Knowledge block for the
  // next ~second; subsequent replies will have it.
  extractDatasheetTextForItem(itemId).catch(err => {
    logger.warn('warehouse.datasheet.extract_background_fail', { itemId, message: err.message });
  });
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
        datasheet_text = NULL, datasheet_text_extracted_at = NULL,
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

// Pick the warehouse items whose datasheet text should be injected into Sunny's
// prompt this turn. Rules:
// 1. Always include items flagged is_staple=1 (the brother's "always tell Sunny
//    about this" list).
// 2. Scan the current customer message + the last N customer turns for tokens
//    that match an item's brand+model. Any match gets included.
// 3. Cap individual items at DATASHEET_TEXT_PER_ITEM_CAP chars, cap the whole
//    block at DATASHEET_BLOCK_TOTAL_CAP chars. Current-message mentions win
//    over history mentions, which win over staples, if the budget runs out.
function pickDatasheetItemsForScope(currentMessage, recentHistory) {
  const db = getDb();
  const items = db.prepare(`
    SELECT id, brand, model, section, notes, is_staple, datasheet_text
    FROM warehouse_items
    WHERE datasheet_text IS NOT NULL AND length(datasheet_text) > 0
  `).all();
  if (!items.length) return [];

  const currentTokens = new Set(tokenize(currentMessage || ''));
  const historyText = (Array.isArray(recentHistory) ? recentHistory : [])
    .filter(m => m && m.role === 'user')
    .slice(-DATASHEET_SCOPE_HISTORY_TURNS)
    .map(m => String(m.content || ''))
    .join(' ');
  const historyTokens = new Set(tokenize(historyText));

  function itemMatches(it, tokens) {
    if (!tokens.size) return false;
    const itemTokens = tokenize([it.brand, it.model, it.section].filter(Boolean).join(' '));
    for (const t of itemTokens) {
      if (t.length < 2) continue;
      if (tokens.has(t)) return true;
    }
    return false;
  }

  // Priority: 0 = current-message match (highest), 1 = history match, 2 = staple-only.
  const ranked = [];
  for (const it of items) {
    if (itemMatches(it, currentTokens)) ranked.push({ it, priority: 0 });
    else if (itemMatches(it, historyTokens)) ranked.push({ it, priority: 1 });
    else if (it.is_staple) ranked.push({ it, priority: 2 });
  }

  ranked.sort((a, b) => a.priority - b.priority);

  const out = [];
  const seen = new Set();
  let totalChars = 0;
  for (const { it } of ranked) {
    if (seen.has(it.id)) continue;
    let text = String(it.datasheet_text || '').trim();
    if (text.length > DATASHEET_TEXT_PER_ITEM_CAP) {
      text = text.slice(0, DATASHEET_TEXT_PER_ITEM_CAP).trim() + '\n[...truncated...]';
    }
    if (totalChars + text.length > DATASHEET_BLOCK_TOTAL_CAP) break;
    seen.add(it.id);
    out.push({ id: it.id, brand: it.brand, model: it.model, section: it.section, notes: it.notes, text });
    totalChars += text.length;
  }
  return out;
}

function formatDatasheetKnowledgeForPrompt(currentMessage, recentHistory) {
  const picked = pickDatasheetItemsForScope(currentMessage, recentHistory);
  if (!picked.length) return '';
  const lines = [];
  lines.push('# Datasheet Knowledge (per-item specs from uploaded datasheets)');
  lines.push('');
  lines.push('Authoritative spec text for the items in scope this turn. Use these excerpts to answer technical questions (voltage windows, pack counts, current ratings, dimensions, compatible inverters, install constraints) for the items below. Two strict rules:');
  lines.push('1. Only quote specs that appear in the excerpt for that item. If a customer asks a spec figure that is NOT in the excerpt, say "let me confirm that with the team" rather than guessing.');
  lines.push('2. Never quote a price from this block. Prices come ONLY from the Warehouse Stock block.');
  lines.push('');
  for (const p of picked) {
    const head = (p.brand + ' ' + p.model).trim();
    lines.push('## ' + head + (p.section ? ' (' + p.section + ')' : ''));
    if (p.notes) lines.push('Internal notes: ' + p.notes);
    lines.push('');
    lines.push(p.text);
    lines.push('');
  }
  return lines.join('\n').trim();
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
  formatWarehouseForPrompt,
  extractDatasheetTextForItem,
  setStaple,
  formatDatasheetKnowledgeForPrompt,
  pickDatasheetItemsForScope
};
