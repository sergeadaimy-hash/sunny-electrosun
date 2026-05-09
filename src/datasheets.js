const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb, DB_PATH } = require('../db/init');
const logger = require('./utils/logger');

const DATASHEETS_DIR = process.env.DATASHEETS_DIR || path.join(path.dirname(DB_PATH), 'datasheets');
const MAX_FILE_BYTES = parseInt(process.env.DATASHEET_MAX_BYTES || String(15 * 1024 * 1024), 10); // 15MB
const ALLOWED_MIME_PREFIXES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const META_MEDIA_TTL_DAYS = 25; // Meta-uploaded media expires at 30 days; refresh after 25.

function ensureDir() {
  if (!fs.existsSync(DATASHEETS_DIR)) {
    fs.mkdirSync(DATASHEETS_DIR, { recursive: true });
  }
}

function nowIso() { return new Date().toISOString(); }

function sanitizeFilename(name) {
  const base = String(name || 'datasheet').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return base || 'datasheet';
}

function isAllowedMime(mime) {
  return !!mime && ALLOWED_MIME_PREFIXES.includes(String(mime).toLowerCase());
}

function listDatasheets({ includeArchived = false } = {}) {
  const db = getDb();
  const where = includeArchived ? '' : "WHERE status = 'active'";
  return db.prepare(`
    SELECT id, label, keywords, filename, mime_type, size_bytes,
           meta_media_id, meta_media_uploaded_at, status, created_at, updated_at
    FROM datasheets
    ${where}
    ORDER BY id DESC
  `).all();
}

function getDatasheetById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM datasheets WHERE id = ?').get(id);
}

function addDatasheet({ label, keywords, filename, base64, mimeType }) {
  ensureDir();
  if (!label || !label.trim()) throw new Error('label required');
  if (!base64) throw new Error('file content required');
  if (!isAllowedMime(mimeType)) throw new Error(`mime not allowed: ${mimeType}`);

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('empty file');
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`file too large: ${buffer.length} bytes (max ${MAX_FILE_BYTES})`);

  const safeName = sanitizeFilename(filename);
  const hash = crypto.randomBytes(8).toString('hex');
  const finalName = `${hash}_${safeName}`;
  const finalPath = path.join(DATASHEETS_DIR, finalName);
  fs.writeFileSync(finalPath, buffer);

  const db = getDb();
  const ts = nowIso();
  const res = db.prepare(`
    INSERT INTO datasheets (label, keywords, filename, file_path, mime_type, size_bytes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(label.trim(), (keywords || '').trim(), safeName, finalPath, mimeType, buffer.length, ts, ts);
  logger.info('datasheets.added', { id: res.lastInsertRowid, label, size_bytes: buffer.length });
  return res.lastInsertRowid;
}

function updateDatasheet(id, { label, keywords, status }) {
  const db = getDb();
  const existing = getDatasheetById(id);
  if (!existing) throw new Error('not found');
  const updates = [];
  const params = [];
  if (typeof label === 'string' && label.trim()) { updates.push('label = ?'); params.push(label.trim()); }
  if (typeof keywords === 'string') { updates.push('keywords = ?'); params.push(keywords.trim()); }
  if (typeof status === 'string' && ['active', 'archived'].includes(status)) {
    updates.push('status = ?'); params.push(status);
  }
  if (!updates.length) return existing;
  updates.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);
  db.prepare(`UPDATE datasheets SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getDatasheetById(id);
}

function deleteDatasheet(id, { hard = false } = {}) {
  const db = getDb();
  const existing = getDatasheetById(id);
  if (!existing) return false;
  if (hard) {
    try {
      if (existing.file_path && fs.existsSync(existing.file_path)) fs.unlinkSync(existing.file_path);
    } catch (err) {
      logger.warn('datasheets.unlink_fail', { id, message: err.message });
    }
    db.prepare('DELETE FROM datasheets WHERE id = ?').run(id);
    logger.info('datasheets.deleted_hard', { id });
  } else {
    updateDatasheet(id, { status: 'archived' });
    logger.info('datasheets.archived', { id });
  }
  return true;
}

function setMetaMediaCache(id, mediaId) {
  const db = getDb();
  db.prepare('UPDATE datasheets SET meta_media_id = ?, meta_media_uploaded_at = ?, updated_at = ? WHERE id = ?')
    .run(mediaId, nowIso(), nowIso(), id);
}

function isMetaMediaFresh(row) {
  if (!row || !row.meta_media_id || !row.meta_media_uploaded_at) return false;
  const uploadedMs = new Date(row.meta_media_uploaded_at).getTime();
  const ageDays = (Date.now() - uploadedMs) / (1000 * 60 * 60 * 24);
  return ageDays < META_MEDIA_TTL_DAYS;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function findDatasheetByQuery(message, recentHistoryText = '') {
  const sheets = listDatasheets();
  if (!sheets.length) return null;
  const queryTokens = new Set(tokenize(message + ' ' + recentHistoryText));
  let best = null;
  let bestScore = 0;
  for (const sheet of sheets) {
    const sheetTokens = tokenize(sheet.label + ' ' + sheet.keywords);
    let score = 0;
    for (const t of sheetTokens) {
      if (queryTokens.has(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sheet;
    }
  }
  return bestScore >= 1 ? { sheet: best, score: bestScore } : null;
}

function formatDatasheetsForPrompt() {
  const sheets = listDatasheets();
  if (!sheets.length) return '';
  const lines = ['# Available datasheets (you can offer to send these on request)'];
  for (const s of sheets) {
    lines.push(`- ${s.label} [keywords: ${s.keywords || '(none)'}]`);
  }
  lines.push('');
  lines.push('When a customer asks for a datasheet / brochure / spec sheet / specifications / manual / product sheet AND they have specified or you can infer which product, the system will automatically attach the matching PDF to your reply. Just acknowledge briefly ("Sending the datasheet now.") and continue. If no datasheet matches, say "I don\'t have a datasheet for that one yet" and ask the customer if they want a quick spec summary or to confirm the exact model. Do NOT promise to email anything; we do not send datasheets by email.');
  return lines.join('\n');
}

module.exports = {
  DATASHEETS_DIR,
  MAX_FILE_BYTES,
  isAllowedMime,
  listDatasheets,
  getDatasheetById,
  addDatasheet,
  updateDatasheet,
  deleteDatasheet,
  setMetaMediaCache,
  isMetaMediaFresh,
  findDatasheetByQuery,
  formatDatasheetsForPrompt
};
