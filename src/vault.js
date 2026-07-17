const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

// Knowledge vault (2026-07-17). Plain markdown files under vault/ hold
// editable business knowledge (products, policies, playbook). The classifier
// tags each message with 0 to 3 topic_tags from vault/tag-map.json; the reply
// call then receives ONLY the matching files, wrapped in a
// <business_knowledge> block, capped at a hard token budget. Everything here
// is fail-open: any read/parse failure returns empty content and the reply
// proceeds without vault knowledge. No new dependencies, plain fs only.

const DEFAULT_BUDGET_TOKENS = 1000;
const DEFAULT_MAX_TOPIC_FILES = 3;
const TAG_MAP_FILENAME = 'tag-map.json';
const MAP_CACHE_MS = 30 * 1000; // same refresh cadence as prompt_store

function defaultVaultDir() {
  return process.env.VAULT_DIR || path.join(__dirname, '..', 'vault');
}

function budgetTokens() {
  const n = parseInt(process.env.VAULT_PROMPT_BUDGET_TOKENS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_TOKENS;
}

function maxTopicFiles() {
  const n = parseInt(process.env.VAULT_MAX_TOPIC_FILES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOPIC_FILES;
}

// Rough but stable token estimate (4 chars per token). Used for the budget
// cap and the per-message savings log.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// tag-map.json cache, keyed by vault dir so tests with temp dirs never
// poison the production cache.
const _mapCache = new Map();

function loadTagMap(dir) {
  const vaultDir = dir || defaultVaultDir();
  const cached = _mapCache.get(vaultDir);
  const now = Date.now();
  if (cached && now - cached.at < MAP_CACHE_MS) return cached.map;
  try {
    const raw = fs.readFileSync(path.join(vaultDir, TAG_MAP_FILENAME), 'utf8');
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('tag-map.json must be a JSON object');
    _mapCache.set(vaultDir, { at: now, map });
    return map;
  } catch (err) {
    logger.warn('vault.tag_map_load_fail', { dir: vaultDir, message: err.message });
    _mapCache.set(vaultDir, { at: now, map: null });
    return null;
  }
}

function clearCacheForTests() {
  _mapCache.clear();
}

function knownTags(dir) {
  const map = loadTagMap(dir);
  return map ? Object.keys(map) : [];
}

// Keep only tags that exist in the map, lowercased, deduped, capped.
function sanitizeTags(tags, dir) {
  if (!Array.isArray(tags)) return [];
  const known = new Set(knownTags(dir));
  const out = [];
  for (const t of tags) {
    const k = String(t || '').trim().toLowerCase();
    if (k && known.has(k) && !out.includes(k)) out.push(k);
    if (out.length >= maxTopicFiles()) break;
  }
  return out;
}

// Deterministic backstop when the classifier returned no usable tags (parse
// fallback, older cached classification, Haiku flakiness): score each tag by
// keyword hits against the customer text, take the best 2.
function keywordFallbackTags(messageText, dir) {
  const map = loadTagMap(dir);
  if (!map) return [];
  const text = String(messageText || '').toLowerCase();
  if (!text.trim()) return [];
  const scored = [];
  for (const [tag, entry] of Object.entries(map)) {
    const keywords = Array.isArray(entry && entry.keywords) ? entry.keywords : [];
    let hits = 0;
    for (const kw of keywords) {
      const k = String(kw || '').toLowerCase();
      if (k && text.includes(k)) hits++;
    }
    if (hits > 0) scored.push({ tag, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 2).map(s => s.tag);
}

// Read a topic file, refusing any path that escapes the vault dir.
function readTopicFile(relPath, dir) {
  const vaultDir = path.resolve(dir || defaultVaultDir());
  const full = path.resolve(vaultDir, String(relPath || ''));
  if (full !== vaultDir && !full.startsWith(vaultDir + path.sep)) {
    throw new Error(`path escapes vault dir: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

// Strip editor scaffolding before injection: %% ... %% comment blocks
// (editing instructions for the owner; Obsidian renders these as comments
// too) and any line still carrying a [TODO marker. If nothing meaningful
// remains (headings only), return '' so an unfilled placeholder file costs
// zero tokens.
function stripTodos(content) {
  let text = String(content || '').replace(/%%[\s\S]*?%%/g, '');
  const lines = text.split('\n').filter(l => !/\[TODO/i.test(l));
  const meaningful = lines.some(l => {
    const t = l.trim();
    return t && !/^#{1,6}\s/.test(t) && t !== '#';
  });
  if (!meaningful) return '';
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Cut at the last line break before maxChars so we never ship half a
// sentence. Appends a marker so the model knows the file continues.
function truncateAtBoundary(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, Math.max(0, maxChars));
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > maxChars * 0.4 ? slice.slice(0, lastBreak) : slice;
  return cut.trimEnd() + '\n(knowledge file truncated for length)';
}

// Main entry for the reply path. Returns { text, tags, estTokens }.
// text is '' when there is nothing worth injecting.
function buildKnowledgeBlock(tags, messageText, opts = {}) {
  const dir = opts.dir || defaultVaultDir();
  try {
    const map = loadTagMap(dir);
    if (!map) return { text: '', tags: [], estTokens: 0 };

    let useTags = sanitizeTags(tags, dir);
    if (!useTags.length) useTags = keywordFallbackTags(messageText, dir);
    if (!useTags.length) return { text: '', tags: [], estTokens: 0 };

    const budgetChars = budgetTokens() * 4;
    const parts = [];
    let used = 0;
    for (const tag of useTags) {
      const entry = map[tag];
      if (!entry || !entry.file) continue;
      let content = '';
      try {
        content = stripTodos(readTopicFile(entry.file, dir));
      } catch (err) {
        logger.warn('vault.read_fail', { tag, file: entry.file, message: err.message });
        continue;
      }
      if (!content) continue;
      const header = `## ${entry.title || tag} (vault/${entry.file})`;
      let piece = `${header}\n${content}`;
      if (used + piece.length > budgetChars) {
        const remaining = budgetChars - used - header.length - 1;
        if (remaining < 200) break;
        piece = `${header}\n${truncateAtBoundary(content, remaining)}`;
      }
      parts.push(piece);
      used += piece.length + 2;
      if (used >= budgetChars) break;
    }

    if (!parts.length) return { text: '', tags: useTags, estTokens: 0 };

    const text = [
      '<business_knowledge>',
      'Knowledge pulled from the editable business vault for THIS message. Treat it as authoritative for policy, product-family, and playbook questions. Prices and stock still come ONLY from the Warehouse Stock block, never from here.',
      ...parts,
      '</business_knowledge>'
    ].join('\n\n');

    return { text, tags: useTags, estTokens: estimateTokens(text) };
  } catch (err) {
    logger.warn('vault.build_block_fail', { message: err.message });
    return { text: '', tags: [], estTokens: 0 };
  }
}

// Small cached system block appended to the CLASSIFIER call. Lives in code
// (built from tag-map.json) instead of inside classifier.md so an owner
// prompt rewrite can never silently drop the topic_tags field.
function buildClassifierTagBlock(opts = {}) {
  const dir = opts.dir || defaultVaultDir();
  try {
    const map = loadTagMap(dir);
    if (!map) return '';
    const tagLines = Object.entries(map)
      .map(([tag, entry]) => `- ${tag}: ${(entry && entry.description) || ''}`.trimEnd());
    if (!tagLines.length) return '';
    return [
      '# Additional output field: topic_tags',
      'Add one more field to the JSON object you output: "topic_tags", an array of 0 to 3 strings.',
      'Pick ONLY from this fixed list, most relevant first. Use [] when none apply.',
      ...tagLines,
      'This field selects which knowledge files the reply agent receives. It never changes category, escalation, routing, or any other field.'
    ].join('\n');
  } catch (err) {
    logger.warn('vault.classifier_block_fail', { message: err.message });
    return '';
  }
}

module.exports = {
  buildKnowledgeBlock,
  buildClassifierTagBlock,
  sanitizeTags,
  keywordFallbackTags,
  knownTags,
  loadTagMap,
  stripTodos,
  truncateAtBoundary,
  estimateTokens,
  clearCacheForTests
};
