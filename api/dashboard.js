const express = require('express');
const { getDb } = require('../db/init');
const logger = require('../src/utils/logger');

const router = express.Router();

router.use((req, res, next) => {
  const apiKey = req.get('X-API-Key');
  if (!process.env.API_KEY) {
    logger.warn('api.no_key_configured');
    return res.status(503).json({ error: 'API_KEY not configured on server' });
  }
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
});

function parseInt32(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/contacts', (req, res) => {
  const db = getDb();
  const { category, from, to } = req.query;
  const limit = Math.min(200, parseInt32(req.query.limit, 50));
  const offset = parseInt32(req.query.offset, 0);

  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (from) { where.push('first_seen >= ?'); params.push(from); }
  if (to) { where.push('first_seen < ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts ${whereSql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM contacts ${whereSql} ORDER BY last_active DESC NULLS LAST, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, limit, offset, contacts: rows });
});

router.get('/contacts/:id', (req, res) => {
  const db = getDb();
  const id = parseInt32(req.params.id, 0);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return res.status(404).json({ error: 'not found' });

  const conversations = db.prepare(
    'SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC'
  ).all(id);

  const messages = db.prepare(`
    SELECT m.*
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ?
    ORDER BY m.id ASC
  `).all(id);

  const events = db.prepare(
    'SELECT * FROM events WHERE contact_id = ? ORDER BY id DESC LIMIT 50'
  ).all(id);

  res.json({ contact, conversations, messages, events });
});

router.get('/stats/today', (req, res) => {
  res.json(buildStats(startOfTodayIso(), new Date().toISOString()));
});

router.get('/stats/range', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (ISO)' });
  res.json(buildStats(from, to));
});

router.get('/reports/latest', (req, res) => {
  const db = getDb();
  const type = req.query.type || 'hourly';
  const row = db.prepare(
    'SELECT * FROM reports WHERE type = ? ORDER BY id DESC LIMIT 1'
  ).get(type);
  if (!row) return res.status(404).json({ error: 'no report yet' });
  res.json({ ...row, payload: safeParse(row.payload) });
});

router.get('/reports', (req, res) => {
  const db = getDb();
  const { from, to, type } = req.query;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('generated_at >= ?'); params.push(from); }
  if (to) { where.push('generated_at < ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM reports ${whereSql} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  res.json({ count: rows.length, reports: rows.map(r => ({ ...r, payload: safeParse(r.payload) })) });
});

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function buildStats(from, to) {
  const db = getDb();
  const inbound = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const outbound = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const newContacts = db.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE first_seen >= ? AND first_seen < ?"
  ).get(from, to).n;
  const escalations = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'escalated' AND timestamp >= ? AND timestamp < ?"
  ).get(from, to).n;
  const byCategory = db.prepare(
    'SELECT category, COUNT(*) AS n FROM contacts GROUP BY category'
  ).all();

  return { from, to, inbound, outbound, new_contacts: newContacts, escalations, by_category: byCategory };
}

module.exports = router;
