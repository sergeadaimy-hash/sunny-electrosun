const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATIONS = 5;

function currentLogPath() {
  return path.join(LOG_DIR, 'sunny.log');
}

function rotateIfNeeded() {
  const file = currentLogPath();
  try {
    const stats = fs.statSync(file);
    if (stats.size < MAX_BYTES) return;
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
    const src = path.join(LOG_DIR, `sunny.${i}.log`);
    const dst = path.join(LOG_DIR, `sunny.${i + 1}.log`);
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  fs.renameSync(file, path.join(LOG_DIR, 'sunny.1.log'));
}

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + safeJson(meta) : '';
  return `[${ts}] ${level.toUpperCase()} ${msg}${metaStr}`;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function write(level, msg, meta) {
  const line = format(level, msg, meta);
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');

  rotateIfNeeded();
  fs.appendFileSync(currentLogPath(), line + '\n');
}

module.exports = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.DEBUG) write('debug', msg, meta);
  }
};
