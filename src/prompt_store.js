const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const ALLOWED = ['system', 'classifier', 'owner_qa'];
const CACHE_TTL_MS = 30 * 1000;

const cache = new Map();

function pathFor(name) {
  if (!ALLOWED.includes(name)) throw new Error('unknown prompt: ' + name);
  return path.join(PROMPTS_DIR, name + '.md');
}

function readFresh(name) {
  const p = pathFor(name);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    logger.warn('prompt_store.read_fail', { name, message: err.message });
    return '';
  }
}

function get(name) {
  const now = Date.now();
  const entry = cache.get(name);
  if (entry && (now - entry.at) < CACHE_TTL_MS) return entry.text;
  const text = readFresh(name);
  cache.set(name, { text, at: now });
  return text;
}

function getAll() {
  const out = {};
  for (const name of ALLOWED) out[name] = get(name);
  return out;
}

function write(name, content) {
  const p = pathFor(name);
  if (typeof content !== 'string') throw new Error('content must be a string');
  fs.writeFileSync(p, content, 'utf8');
  cache.set(name, { text: content, at: Date.now() });
  logger.info('prompt_store.write', { name, bytes: Buffer.byteLength(content, 'utf8') });
}

function invalidate(name) {
  if (name) cache.delete(name);
  else cache.clear();
}

module.exports = {
  ALLOWED,
  PROMPTS_DIR,
  pathFor,
  get,
  getAll,
  write,
  invalidate
};
