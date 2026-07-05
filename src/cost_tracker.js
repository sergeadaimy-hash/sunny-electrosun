const { getDb } = require('../db/init');
const logger = require('./utils/logger');

const PRICING_CENTS_PER_MTOK = {
  'claude-haiku-4-5':   { input: 80,   output: 400,  cache_read: 8,    cache_write: 100 },
  'claude-sonnet-4-6':  { input: 300,  output: 1500, cache_read: 30,   cache_write: 375 },
  // Sonnet 5 sticker price equals Sonnet 4.6 (intro $2/$10 per MTok runs through
  // 2026-08-31, so real bills come in lower until then; we count at sticker).
  'claude-sonnet-5':    { input: 300,  output: 1500, cache_read: 30,   cache_write: 375 },
  'claude-opus-4-7':    { input: 1500, output: 7500, cache_read: 150,  cache_write: 1875 }
};

function modelKey(model) {
  if (!model) return null;
  for (const k of Object.keys(PRICING_CENTS_PER_MTOK)) {
    if (model.startsWith(k)) return k;
  }
  return null;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function calcCostCents(model, usage) {
  const key = modelKey(model);
  if (!key || !usage) return 0;
  const p = PRICING_CENTS_PER_MTOK[key];
  // Anthropic reports input_tokens as the NON-cached input only. Cache reads and
  // cache writes come back in their own fields and are NOT included in input_tokens,
  // so each token type is billed once at its own rate. (Previous code subtracted the
  // cache tokens from input_tokens, which double-counted them and pushed cache-heavy
  // calls to a negative total that clamped to 0, undercounting real spend.)
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cents =
    input * p.input / 1_000_000 +
    output * p.output / 1_000_000 +
    cacheRead * p.cache_read / 1_000_000 +
    cacheWrite * p.cache_write / 1_000_000;
  return Math.max(0, Math.round(cents));
}

function ensureRow(db, date) {
  db.prepare(
    'INSERT OR IGNORE INTO daily_costs (date, total_cents, classifier_calls, reply_calls, budget_warning_sent, last_updated) VALUES (?, 0, 0, 0, 0, ?)'
  ).run(date, new Date().toISOString());
}

function recordUsage(model, usage, kind) {
  if (!usage) return;
  const cents = calcCostCents(model, usage);
  if (cents <= 0 && (!usage.input_tokens && !usage.output_tokens)) return;

  const db = getDb();
  const date = todayKey();
  ensureRow(db, date);

  const callField = kind === 'classifier' ? 'classifier_calls' : 'reply_calls';
  db.prepare(
    `UPDATE daily_costs SET total_cents = total_cents + ?, ${callField} = ${callField} + 1, last_updated = ? WHERE date = ?`
  ).run(cents, new Date().toISOString(), date);
}

function getTodaySpendCents() {
  const db = getDb();
  const row = db.prepare('SELECT total_cents FROM daily_costs WHERE date = ?').get(todayKey());
  return row ? row.total_cents : 0;
}

function getBudgetCents() {
  const usd = parseFloat(process.env.DAILY_LLM_BUDGET_USD);
  if (!isFinite(usd) || usd <= 0) return null;
  return Math.round(usd * 100);
}

function isOverBudget() {
  const budget = getBudgetCents();
  if (budget === null) return false;
  return getTodaySpendCents() >= budget;
}

function getTodayStats() {
  const db = getDb();
  const row = db.prepare('SELECT * FROM daily_costs WHERE date = ?').get(todayKey());
  return row || { date: todayKey(), total_cents: 0, classifier_calls: 0, reply_calls: 0, budget_warning_sent: 0 };
}

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}

function getMonthSpendCents() {
  const db = getDb();
  const row = db.prepare(
    "SELECT COALESCE(SUM(total_cents), 0) AS cents FROM daily_costs WHERE date LIKE ?"
  ).get(monthKey() + '%');
  return row ? row.cents : 0;
}

function getMonthStats() {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cents), 0)      AS total_cents,
            COALESCE(SUM(classifier_calls), 0) AS classifier_calls,
            COALESCE(SUM(reply_calls), 0)      AS reply_calls,
            COUNT(*)                           AS days
       FROM daily_costs WHERE date LIKE ?`
  ).get(monthKey() + '%');
  return {
    month: monthKey(),
    total_cents: row ? row.total_cents : 0,
    classifier_calls: row ? row.classifier_calls : 0,
    reply_calls: row ? row.reply_calls : 0,
    days: row ? row.days : 0
  };
}

function markBudgetWarningSent() {
  const db = getDb();
  const date = todayKey();
  ensureRow(db, date);
  db.prepare('UPDATE daily_costs SET budget_warning_sent = 1 WHERE date = ?').run(date);
}

function shouldSendBudgetWarning() {
  if (!isOverBudget()) return false;
  const stats = getTodayStats();
  return stats.budget_warning_sent === 0;
}

module.exports = {
  recordUsage,
  isOverBudget,
  getTodaySpendCents,
  getBudgetCents,
  getTodayStats,
  getMonthSpendCents,
  getMonthStats,
  shouldSendBudgetWarning,
  markBudgetWarningSent,
  calcCostCents
};
