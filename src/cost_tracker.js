const { getDb } = require('../db/init');
const logger = require('./utils/logger');

const PRICING_CENTS_PER_MTOK = {
  'claude-haiku-4-5':   { input: 80,  output: 400,  cache_read: 8,   cache_write: 100 },
  'claude-sonnet-4-6':  { input: 300, output: 1500, cache_read: 30,  cache_write: 375 }
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
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cents =
    (input - cacheRead - cacheWrite) * p.input / 1_000_000 +
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
  shouldSendBudgetWarning,
  markBudgetWarningSent,
  calcCostCents
};
