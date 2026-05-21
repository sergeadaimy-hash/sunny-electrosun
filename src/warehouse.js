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

const PHOTOS_DIR = process.env.WAREHOUSE_PHOTOS_DIR || path.join(path.dirname(DB_PATH), 'warehouse_photos');
const MAX_PHOTO_BYTES = parseInt(process.env.PHOTO_MAX_BYTES || String(5 * 1024 * 1024), 10);
// WhatsApp Cloud API image messages accept ONLY jpeg and png. WebP is valid for
// stickers, not image messages, so a webp upload is accepted by Meta's /media but
// rejected at send (error 131053). Keep webp out so Sunny never tries to send one.
const ALLOWED_PHOTO_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
const SENDABLE_PHOTO_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
const PHOTO_SEND_CAP = parseInt(process.env.PHOTO_SEND_CAP || '3', 10);

// Per-item cap on injected datasheet text. ~2KB per item × ~4 items in scope per
// reply keeps the Datasheet Knowledge block under 8KB even on busy turns.
const DATASHEET_TEXT_PER_ITEM_CAP = parseInt(process.env.DATASHEET_TEXT_PER_ITEM_CAP || '2000', 10);
const DATASHEET_BLOCK_TOTAL_CAP = parseInt(process.env.DATASHEET_BLOCK_TOTAL_CAP || '10000', 10);
const DATASHEET_SCOPE_HISTORY_TURNS = parseInt(process.env.DATASHEET_SCOPE_HISTORY_TURNS || '6', 10);

function ensureDatasheetsDir() {
  if (!fs.existsSync(DATASHEETS_DIR)) fs.mkdirSync(DATASHEETS_DIR, { recursive: true });
}

function ensurePhotosDir() {
  if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

function isAllowedPhotoMime(mime) {
  return !!mime && ALLOWED_PHOTO_MIMES.includes(String(mime).toLowerCase());
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'datasheet').replace(/[^A-Za-z0-9._-]+/g, '_');
  if (cleaned.length <= 120) return cleaned || 'datasheet';
  // Preserve the file extension when the source name is over the cap.
  // Meta's media upload rejects multipart filenames whose extension doesn't
  // match Content-Type, so a chopped "...20250520_ENGLISH.pdf" -> "..._E" turns
  // into HTTP 400 even though the bytes on disk are a valid PDF.
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0 && cleaned.length - dot <= 8) {
    const ext = cleaned.slice(dot);
    const stem = cleaned.slice(0, dot).slice(0, 120 - ext.length);
    return (stem + ext) || 'datasheet';
  }
  return cleaned.slice(0, 120) || 'datasheet';
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
  // Fetch active photos for all items in one query; group by item_id for the
  // per-item attachment. Sorted so the first N (PHOTO_SEND_CAP) are deterministic.
  const photoRows = db.prepare(
    `SELECT id, item_id, filename, mime_type, size_bytes, caption, sort_order,
            meta_media_id, meta_media_uploaded_at, created_at
     FROM warehouse_item_photos
     WHERE item_id IN (${items.map(() => '?').join(',')}) AND status = 'active'
     ORDER BY item_id, sort_order ASC, id ASC`
  ).all(...items.map(it => it.id));
  const photosByItem = {};
  for (const row of photoRows) {
    if (!photosByItem[row.item_id]) photosByItem[row.item_id] = [];
    photosByItem[row.item_id].push(row);
  }
  return items.map(it => ({
    ...it,
    stock: {
      abuja: stockByItem[it.id]?.abuja || null,
      lagos: stockByItem[it.id]?.lagos || null
    },
    photos: photosByItem[it.id] || []
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

// State derivation is centralized here so the UI cannot put state and
// quantity out of sync. Rule:
// - state = 'incoming' is preserved only when explicitly set (caller opted in).
// - otherwise: state is derived from final quantity. qty > 0 -> 'in_stock',
//   qty == 0 -> 'out_of_stock'.
// This closes the bug where the brother could set qty 87 but accidentally
// leave the state on 'out_of_stock' (or vice versa) and Sunny would tell
// customers the item was unavailable.
function deriveStockState(currentRow, updates) {
  const updatesIncoming = updates.state === 'incoming';
  const currentIncoming = !updatesIncoming && currentRow && currentRow.state === 'incoming' && updates.state === undefined;
  if (updatesIncoming || currentIncoming) return 'incoming';
  const newQty = (updates.quantity !== undefined ? updates.quantity : (currentRow ? currentRow.quantity : 0)) || 0;
  return Number(newQty) > 0 ? 'in_stock' : 'out_of_stock';
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
  const currentRow = db.prepare(
    'SELECT state, quantity FROM warehouse_stock WHERE item_id = ? AND location = ?'
  ).get(itemId, location);
  // Always write a derived state. Caller's state is treated as a hint
  // ("incoming" or "not incoming"); qty does the rest.
  data.state = deriveStockState(currentRow, data);
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
  const currentRow = db.prepare(
    'SELECT state, quantity FROM warehouse_stock WHERE item_id = ? AND location = ?'
  ).get(itemId, location);
  const newQty = Math.max(0, (currentRow ? currentRow.quantity : 0) + n);
  const newState = deriveStockState(currentRow, { quantity: newQty });
  db.prepare(`
    UPDATE warehouse_stock
    SET quantity = ?, state = ?, updated_at = ?
    WHERE item_id = ? AND location = ?
  `).run(newQty, newState, nowIso(), itemId, location);
}

function repairAllStockStates() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT item_id, location, state, quantity FROM warehouse_stock'
  ).all();
  let fixed = 0;
  const upd = db.prepare(
    'UPDATE warehouse_stock SET state = ?, updated_at = ? WHERE item_id = ? AND location = ?'
  );
  for (const r of rows) {
    const correct = deriveStockState(r, {});
    if (correct !== r.state) {
      upd.run(correct, nowIso(), r.item_id, r.location);
      fixed++;
    }
  }
  if (fixed) logger.info('warehouse.stock.state_repaired', { rows_fixed: fixed });
  return fixed;
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
  lines.push('Authoritative list of every item Electro-Sun stocks. Per-warehouse state and quantity below are INTERNAL ONLY (use them to compute what to say). Customer hears exactly ONE of three words: "available" (any warehouse in_stock), "incoming" with the earliest ETA (no warehouse in_stock, at least one incoming), or "out of stock" (all warehouses out_of_stock). NEVER name a specific warehouse to the customer. NEVER reveal unit counts unless the customer asked for a quantity larger than our total (then give the TOTAL across all warehouses without naming them). Quote ETA dates and "incoming" notes verbatim. If a customer asks for an item that is not listed below, tell them it is not in our current list and offer to confirm with the team.');
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
// "80kva", "16kwh", and also "7.68" from "A7.68kwh" or "bos-A7.68kwh" where
// the digit is glued onto a leading letter. The `\b` form used previously
// rejected these because letter-digit has no word boundary; we now use a
// guard that allows any leading char except another digit / dot (which would
// be a sub-match of a larger number).
function extractSizeNumbers(text) {
  const out = new Set();
  if (!text) return out;
  const re = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:kw|kva|kwh|k)\b/gi;
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

  // Size match is the preferred gate. If the customer message names a specific
  // size ("80kw", "12.5kva", "16kwh"), prefer items whose model/notes carry
  // that same size, to stop "80kw datasheet" from falling back to the 50kW
  // item just because it's the only one with a PDF attached. BUT if no item
  // matches the size by the kw-suffix check (common for batteries whose
  // capacity is in the model name without a "kwh" suffix, e.g. "BOS-A-PACK7.68"
  // or "SE-F5.12"), fall through to token-overlap matching instead of giving
  // up entirely. Previous behavior was to return null, which dropped the
  // customer to the LLM path where Sunny could end up sending an internal
  // "[Datasheet sent: ...]" marker as plain text.
  const querySizes = extractSizeNumbers(message);
  let candidates = items;
  if (querySizes.size > 0) {
    const sizeMatched = items.filter(it => {
      const itemSizes = extractSizeNumbers(
        [it.brand, it.model, it.notes].filter(Boolean).join(' ')
      );
      for (const q of querySizes) {
        if (itemSizes.has(q)) return true;
      }
      // Soft size-in-token check: the customer's size number appears as a
      // substring of any model/notes token (catches "5" matching "F5.12",
      // "7.68" matching "PACK7.68", "16" matching "Se-F16").
      const blob = [it.brand, it.model, it.notes]
        .filter(Boolean).join(' ').toLowerCase();
      for (const q of querySizes) {
        const re = new RegExp(`(?:^|[^\\d.])${q.replace(/\./g, '\\.')}(?![\\d])`);
        if (re.test(blob)) return true;
      }
      return false;
    });
    if (sizeMatched.length > 0) candidates = sizeMatched;
    // else: keep candidates = items, let token overlap handle it. We won't
    // claim a size-perfect match, but we'll still try to find the right item.
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

// ---------------------------------------------------------------------------
// Item Photos (per-item, many-per-item, sent as WhatsApp images on request)
// ---------------------------------------------------------------------------
// Mirrors the datasheet pattern but lives in its own table (warehouse_item_photos)
// because each item can have multiple photos with their own captions, sort order,
// and Meta media cache. Files live under WAREHOUSE_PHOTOS_DIR (default
// <DB dir>/warehouse_photos/). Allowed mimes: JPG / PNG / WebP (no PDF here).
// Max 5MB per photo by default (override via PHOTO_MAX_BYTES).
// ---------------------------------------------------------------------------

function listPhotosForItem(itemId, { includeArchived = false } = {}) {
  const db = getDb();
  const where = includeArchived ? '' : "AND status = 'active'";
  return db.prepare(
    `SELECT id, item_id, filename, mime_type, size_bytes, caption, sort_order,
            meta_media_id, meta_media_uploaded_at, status, created_at, updated_at
     FROM warehouse_item_photos
     WHERE item_id = ? ${where}
     ORDER BY sort_order ASC, id ASC`
  ).all(itemId);
}

function getPhotoById(photoId) {
  const db = getDb();
  return db.prepare(
    `SELECT id, item_id, filename, file_path, mime_type, size_bytes, caption,
            sort_order, meta_media_id, meta_media_uploaded_at, status,
            created_at, updated_at
     FROM warehouse_item_photos WHERE id = ?`
  ).get(photoId) || null;
}

function addPhotoForItem(itemId, { filename, base64, mimeType, caption } = {}) {
  const db = getDb();
  const item = db.prepare('SELECT id FROM warehouse_items WHERE id = ?').get(itemId);
  if (!item) throw new Error('item not found');
  if (!isAllowedPhotoMime(mimeType)) throw new Error('photo mime not allowed: ' + mimeType);
  if (!base64) throw new Error('photo file content required');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('empty photo file');
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new Error('photo too large: ' + buffer.length + ' bytes (max ' + MAX_PHOTO_BYTES + ')');
  }

  ensurePhotosDir();
  const safeName = sanitizeFilename(filename || 'photo');
  const hash = crypto.randomBytes(8).toString('hex');
  const finalName = hash + '_' + safeName;
  const finalPath = path.join(PHOTOS_DIR, finalName);
  fs.writeFileSync(finalPath, buffer);

  const maxOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM warehouse_item_photos WHERE item_id = ? AND status = 'active'"
  ).get(itemId).m;
  const sortOrder = maxOrder + 1;
  const ts = nowIso();
  const captionClean = caption == null ? null : String(caption).trim().slice(0, 280) || null;

  const info = db.prepare(`
    INSERT INTO warehouse_item_photos
      (item_id, filename, file_path, mime_type, size_bytes, caption, sort_order, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(itemId, safeName, finalPath, mimeType, buffer.length, captionClean, sortOrder, ts, ts);

  logger.info('warehouse.photo.attached', {
    itemId, photoId: info.lastInsertRowid, filename: safeName, size_bytes: buffer.length
  });
  return getPhotoById(info.lastInsertRowid);
}

function updatePhotoForItem(photoId, { caption, sort_order } = {}) {
  const db = getDb();
  const photo = getPhotoById(photoId);
  if (!photo) throw new Error('photo not found');
  const updates = [];
  const values = [];
  if (caption !== undefined) {
    const captionClean = caption == null ? null : String(caption).trim().slice(0, 280) || null;
    updates.push('caption = ?');
    values.push(captionClean);
  }
  if (sort_order !== undefined) {
    const so = Math.max(0, Math.round(Number(sort_order)) || 0);
    updates.push('sort_order = ?');
    values.push(so);
  }
  if (!updates.length) return photo;
  updates.push('updated_at = ?');
  values.push(nowIso());
  values.push(photoId);
  db.prepare(`UPDATE warehouse_item_photos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getPhotoById(photoId);
}

// Soft archive by default so an accidental click is recoverable from the DB.
// Hard delete (with file unlink) is opt-in via { hard: true }.
function removePhotoForItem(photoId, { hard = false } = {}) {
  const db = getDb();
  const photo = getPhotoById(photoId);
  if (!photo) return false;
  if (hard) {
    if (photo.file_path && fs.existsSync(photo.file_path)) {
      try { fs.unlinkSync(photo.file_path); }
      catch (err) { logger.warn('warehouse.photo.unlink_fail', { photoId, message: err.message }); }
    }
    db.prepare('DELETE FROM warehouse_item_photos WHERE id = ?').run(photoId);
    logger.info('warehouse.photo.deleted_hard', { photoId, itemId: photo.item_id });
  } else {
    db.prepare(
      "UPDATE warehouse_item_photos SET status = 'archived', updated_at = ? WHERE id = ?"
    ).run(nowIso(), photoId);
    logger.info('warehouse.photo.archived', { photoId, itemId: photo.item_id });
  }
  return true;
}

function setPhotoMetaMediaCache(photoId, mediaId) {
  const db = getDb();
  db.prepare(
    'UPDATE warehouse_item_photos SET meta_media_id = ?, meta_media_uploaded_at = ?, updated_at = ? WHERE id = ?'
  ).run(mediaId, nowIso(), nowIso(), photoId);
}

// Find the warehouse item whose photos best match the customer's request.
// Mirrors findItemDatasheetByQuery: size-token gate first (so "16kw photo" goes
// to the 16kW row, not the 80kW one), token-overlap tiebreaker. Only items
// with at least one ACTIVE photo are considered.
function findItemPhotosByQuery(message, recentText = '') {
  const db = getDb();
  const items = db.prepare(`
    SELECT wi.id, wi.brand, wi.model, wi.notes, wi.section
    FROM warehouse_items wi
    WHERE EXISTS (
      SELECT 1 FROM warehouse_item_photos p
      WHERE p.item_id = wi.id AND p.status = 'active'
        AND lower(p.mime_type) IN ('image/png','image/jpeg','image/jpg')
    )
  `).all();
  if (!items.length) return null;

  const querySizes = extractSizeNumbers(message);
  let candidates = items;
  if (querySizes.size > 0) {
    const sizeMatched = items.filter(it => {
      const itemSizes = extractSizeNumbers(
        [it.brand, it.model, it.notes].filter(Boolean).join(' ')
      );
      for (const q of querySizes) {
        if (itemSizes.has(q)) return true;
      }
      const blob = [it.brand, it.model, it.notes]
        .filter(Boolean).join(' ').toLowerCase();
      for (const q of querySizes) {
        const re = new RegExp(`(?:^|[^\\d.])${q.replace(/\./g, '\\.')}(?![\\d])`);
        if (re.test(blob)) return true;
      }
      return false;
    });
    // Size is a HARD gate for photos: if the customer named a specific size and
    // no photo-bearing item carries it, return no match so the handler escalates
    // ("team will share shortly") rather than sending a DIFFERENT-size product's
    // photo via the loose token-overlap fallback (e.g. answering a 6kW request
    // with the 16kW photo). Catalog fidelity beats always sending something.
    if (sizeMatched.length === 0) return null;
    candidates = sizeMatched;
  }

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

  let matchedItem = null;
  let matchScore = 0;
  if (best) {
    matchedItem = best;
    matchScore = bestScore;
  } else if (candidates.length === 1) {
    // Exactly one product has sendable photos. Even if the wording doesn't overlap
    // the model name and no size was given ("Photo", "send a picture"), it's safe to
    // return that single item. With >1 candidate we still require a token match.
    matchedItem = candidates[0];
    matchScore = 0;
  } else {
    return null;
  }

  // Pull full photo rows INCLUDING file_path. listPhotosForItem deliberately omits
  // file_path (so the admin API never leaks the server disk path), but the handler
  // needs it to upload the file to Meta. Using listPhotosForItem here was the bug:
  // photo.file_path came back undefined, so uploadMediaToMeta failed and every photo
  // send fell back. Only jpeg/png are sendable as WhatsApp images; a stray webp is
  // skipped so the handler degrades to the no-photo fallback instead of a failed send.
  const photos = db.prepare(
    `SELECT id, item_id, filename, file_path, mime_type, size_bytes, caption,
            sort_order, meta_media_id, meta_media_uploaded_at, status
       FROM warehouse_item_photos
      WHERE item_id = ? AND status = 'active'
        AND lower(mime_type) IN ('image/png','image/jpeg','image/jpg')
      ORDER BY sort_order ASC, id ASC`
  ).all(matchedItem.id).slice(0, PHOTO_SEND_CAP);
  if (!photos.length) return null;
  return { item: matchedItem, photos, score: matchScore };
}

module.exports = {
  LOCATIONS,
  STATES,
  DATASHEETS_DIR,
  MAX_DATASHEET_BYTES,
  PHOTOS_DIR,
  MAX_PHOTO_BYTES,
  PHOTO_SEND_CAP,
  isAllowedMime,
  isAllowedPhotoMime,
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
  pickDatasheetItemsForScope,
  repairAllStockStates,
  listPhotosForItem,
  getPhotoById,
  addPhotoForItem,
  updatePhotoForItem,
  removePhotoForItem,
  setPhotoMetaMediaCache,
  findItemPhotosByQuery
};
