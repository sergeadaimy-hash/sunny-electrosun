const logger = require('./utils/logger');
const {
  findPendingQueriesNeedingWarning,
  markPendingQueryWarned,
  findExpiredPendingQueries,
  markPendingQueryExpired,
  logEvent
} = require('./memory');
const {
  shouldSendBudgetWarning,
  markBudgetWarningSent,
  getTodaySpendCents,
  getBudgetCents,
  getTodayStats
} = require('./cost_tracker');
const { sendMessage } = require('./whatsapp');

const WARN_AFTER_HOURS = 22;
const EXPIRE_AFTER_HOURS = 24;

function isoMinus(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function ageHours(createdAtIso) {
  return (Date.now() - new Date(createdAtIso).getTime()) / (60 * 60 * 1000);
}

// opts.silent (2026-06-08, R2): expire stale pending queries WITHOUT sending
// any owner reminders/alerts. Used when DISABLE_NOTIFICATIONS=true so the
// expiry hygiene still runs (stale open queries otherwise suppress fresh
// routed alerts via the follow-up-ping path, and inflate the open-query count
// indefinitely). Only the owner-facing pings are silenced, not the cleanup.
async function runWindowScan(opts = {}) {
  const silent = !!opts.silent;
  const ownerPhone = process.env.OWNER_WHATSAPP;

  const expired = findExpiredPendingQueries(isoMinus(EXPIRE_AFTER_HOURS));
  for (const q of expired) {
    markPendingQueryExpired(q.id);
    logEvent(q.contact_id, 'silent_query_expired', {
      queryId: q.id,
      ageHours: ageHours(q.created_at)
    });
    logger.warn('window_monitor.expired', {
      queryId: q.id,
      customerPhone: q.customer_phone,
      ageHours: ageHours(q.created_at).toFixed(1)
    });
    if (!silent && ownerPhone) {
      const text = [
        `Heads up: query [QID:${q.id}] from ${q.customer_name || 'unknown'} (${q.customer_phone}) is past the 24h Meta free-form window.`,
        `Customer asked: "${(q.customer_message_text || '').slice(0, 200)}"`,
        '',
        'Meta blocks new free-form replies after 24h. To re-engage, an approved template must be sent.'
      ].join('\n');
      try {
        await sendMessage(ownerPhone, text);
      } catch (err) {
        logger.error('window_monitor.expired_alert_failed', { queryId: q.id, message: err.message });
      }
    }
  }

  // The 22h reminder and budget warning are owner-facing notifications only.
  // In silent mode (DISABLE_NOTIFICATIONS) skip them entirely; the expiry above
  // is the part that must always run.
  const needWarning = silent ? [] : findPendingQueriesNeedingWarning(isoMinus(WARN_AFTER_HOURS));
  for (const q of needWarning) {
    const age = ageHours(q.created_at);
    if (age >= EXPIRE_AFTER_HOURS) continue;

    markPendingQueryWarned(q.id);
    logger.info('window_monitor.warning_sent', {
      queryId: q.id,
      customerPhone: q.customer_phone,
      ageHours: age.toFixed(1)
    });
    if (ownerPhone) {
      const remaining = (EXPIRE_AFTER_HOURS - age).toFixed(1);
      const text = [
        `Reminder: query [QID:${q.id}] from ${q.customer_name || 'unknown'} (${q.customer_phone}) is approaching the 24h window.`,
        `About ${remaining} hours left to send a free-form reply.`,
        '',
        `Customer asked: "${(q.customer_message_text || '').slice(0, 200)}"`,
        '',
        'Long-press the original alert and reply with the answer.'
      ].join('\n');
      try {
        await sendMessage(ownerPhone, text);
      } catch (err) {
        logger.error('window_monitor.warning_alert_failed', { queryId: q.id, message: err.message });
      }
    }
  }

  let budgetWarningSent = 0;
  if (!silent && shouldSendBudgetWarning()) {
    const spend = getTodaySpendCents();
    const budget = getBudgetCents();
    const stats = getTodayStats();
    markBudgetWarningSent();
    budgetWarningSent = 1;
    logger.warn('window_monitor.budget_warning', {
      spend_cents: spend,
      budget_cents: budget,
      classifier_calls: stats.classifier_calls,
      reply_calls: stats.reply_calls
    });
    if (ownerPhone) {
      const text = [
        `Heads up: today's LLM spend has crossed your daily budget.`,
        `Spent: $${(spend / 100).toFixed(2)} (cap: $${(budget / 100).toFixed(2)})`,
        `Classifier calls: ${stats.classifier_calls}, reply calls: ${stats.reply_calls}`,
        '',
        'New customer messages will get the holding reply only until the budget resets at UTC midnight, or until you raise DAILY_LLM_BUDGET_USD.'
      ].join('\n');
      try {
        await sendMessage(ownerPhone, text);
      } catch (err) {
        logger.error('window_monitor.budget_alert_failed', { message: err.message });
      }
    }
  }

  return { warned: needWarning.length, expired: expired.length, budget_warning: budgetWarningSent };
}

module.exports = { runWindowScan, WARN_AFTER_HOURS, EXPIRE_AFTER_HOURS };
