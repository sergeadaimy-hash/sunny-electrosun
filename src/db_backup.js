'use strict';

// Nightly DB backup (2026-07-12). Production previously had ZERO backups: the
// old snapshotDb() lives on the daily report cron, which never registers
// while DISABLE_NOTIFICATIONS=true, so /data/sunny.db (every contact,
// conversation, price, and learned lesson) existed as exactly one copy.
// This module snapshots the live DB with better-sqlite3's online backup API
// (WAL-safe, consistent even mid-write), gzips it into DB_BACKUP_DIR
// (default <DB dir>/backups, /data/backups on Railway), and keeps the newest
// DB_BACKUP_KEEP files (default 14). Same-day reruns overwrite the same file.
// Registered on an always-on cron in server.js, OUTSIDE the
// DISABLE_NOTIFICATIONS gate. This protects against corruption, a bad
// migration, or accidental deletion; for volume-loss protection, enable
// Railway volume backups or add an off-platform copy.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const logger = require('./utils/logger');
const { getDb, DB_PATH } = require('../db/init');

const BACKUP_DIR = process.env.DB_BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const DB_BACKUP_KEEP = Math.max(1, parseInt(process.env.DB_BACKUP_KEEP || '14', 10));

function backupFilename(date = new Date()) {
  return `sunny-${date.toISOString().slice(0, 10)}.db.gz`;
}

function pruneOldBackups(keep = DB_BACKUP_KEEP) {
  let removed = 0;
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^sunny-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f))
      .sort();
    const excess = files.slice(0, Math.max(0, files.length - keep));
    for (const f of excess) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      removed++;
    }
  } catch (err) {
    logger.warn('db_backup.prune_fail', { message: err.message });
  }
  return removed;
}

async function runDbBackup() {
  const started = Date.now();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tmpPath = path.join(BACKUP_DIR, `.snapshot-${process.pid}-${Date.now()}.db`);
    await getDb().backup(tmpPath);

    const gzPath = path.join(BACKUP_DIR, backupFilename());
    await new Promise((resolve, reject) => {
      const inp = fs.createReadStream(tmpPath);
      const gz = zlib.createGzip({ level: 6 });
      const out = fs.createWriteStream(gzPath);
      inp.on('error', reject);
      gz.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      inp.pipe(gz).pipe(out);
    });
    fs.unlinkSync(tmpPath);

    const pruned = pruneOldBackups();
    const sizeBytes = fs.statSync(gzPath).size;
    logger.info('db_backup.ok', {
      path: gzPath,
      size_bytes: sizeBytes,
      pruned,
      duration_ms: Date.now() - started
    });
    return { ok: true, path: gzPath, sizeBytes, pruned };
  } catch (err) {
    logger.error('db_backup.fail', { message: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { runDbBackup, pruneOldBackups, backupFilename, BACKUP_DIR, DB_BACKUP_KEEP };
