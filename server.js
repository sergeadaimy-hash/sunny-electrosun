require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const logger = require('./src/utils/logger');
const { initDb, DB_PATH } = require('./db/init');
const webhookRouter = require('./src/webhook');
const dashboardRouter = require('./api/dashboard');
const { recoverOrphanedInbound, autoReleaseStaleHumanConversations } = require('./src/handler');
const {
  generateHourlyReport,
  generateDailyReport,
  generateDailyLearningReport,
  sendOwnerReport,
  sendDailyLearningReport
} = require('./src/reports');
const { runWindowScan } = require('./src/window_monitor');

initDb();

const app = express();

app.use('/webhook', express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.json({ limit: '25mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/version', (req, res) => {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || null;
  res.json({
    git_sha: sha,
    git_sha_short: sha ? sha.slice(0, 7) : null,
    git_branch: process.env.RAILWAY_GIT_BRANCH || null,
    git_commit_message: (process.env.RAILWAY_GIT_COMMIT_MESSAGE || '').slice(0, 200) || null,
    deploy_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
    escalations_disabled: String(process.env.DISABLE_ESCALATIONS || '').toLowerCase() === 'true',
    notifications_disabled: String(process.env.DISABLE_NOTIFICATIONS || '').toLowerCase() === 'true',
    owner_whatsapp_tail: process.env.OWNER_WHATSAPP ? String(process.env.OWNER_WHATSAPP).slice(-4) : null,
    node_uptime_seconds: Math.floor(process.uptime()),
    server_time: new Date().toISOString()
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(webhookRouter);
app.use('/api', dashboardRouter);

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inbox-only team member entry point. Serves the same admin page; the page
// asks the server for its role after login and locks itself to the inbox.
app.get('/inbox', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public login exchange for the inbox-only team member. Validates the
// username/password env pair and returns the separate INBOX_API_KEY, which is
// NOT the master API_KEY. A small in-memory throttle defangs brute force.
const inboxLoginAttempts = new Map();
const INBOX_LOGIN_MAX = 8;
const INBOX_LOGIN_WINDOW_MS = 10 * 60 * 1000;

app.post('/inbox-login', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
  const now = Date.now();
  const rec = inboxLoginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > INBOX_LOGIN_WINDOW_MS) { rec.count = 0; rec.first = now; }
  if (rec.count >= INBOX_LOGIN_MAX) {
    logger.warn('inbox_login.throttled', { ip });
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const user = process.env.INBOX_USER;
  const pass = process.env.INBOX_PASSWORD;
  const key = process.env.INBOX_API_KEY;
  if (!user || !pass || !key) {
    return res.status(503).json({ error: 'inbox login not configured on server' });
  }

  const { username, password } = req.body || {};
  if (typeof username === 'string' && typeof password === 'string'
      && username.trim() === user && password === pass) {
    inboxLoginAttempts.delete(ip);
    logger.info('inbox_login.ok', { ip });
    return res.json({ key, role: 'inbox' });
  }

  rec.count += 1;
  inboxLoginAttempts.set(ip, rec);
  logger.warn('inbox_login.fail', { ip, attempts: rec.count });
  return res.status(401).json({ error: 'invalid username or password' });
});

app.use((err, req, res, next) => {
  logger.error('express.error', { message: err.message, type: err.type, status: err.status, stack: err.stack });
  if (res.headersSent) return;
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'file too large', limit: err.limit, length: err.length });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  res.status(500).json({ error: 'internal' });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;

function startupSanityChecks() {
  const required = ['META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) logger.warn('server.env.missing', { keys: missing });
  if (!process.env.META_APP_SECRET) {
    logger.warn('server.env.no_app_secret', { note: 'webhook signature checks will be skipped' });
  }
  if (!process.env.API_KEY) {
    logger.warn('server.env.no_api_key', { note: '/api will return 503 until set' });
  }
}

function notificationsDisabled() {
  return String(process.env.DISABLE_NOTIFICATIONS || '').toLowerCase() === 'true';
}

if (require.main === module) {
  startupSanityChecks();
  try {
    const { rejectLegacyFacts } = require('./src/knowledge');
    const result = rejectLegacyFacts();
    logger.info('server.legacy_fact_cleanup', { rejected: result.rejected_count });
  } catch (err) {
    logger.warn('server.legacy_fact_cleanup_fail', { message: err.message });
  }
  try {
    const { repairAllStockStates } = require('./src/warehouse');
    const fixed = repairAllStockStates();
    if (fixed > 0) logger.info('server.stock_state_repair_boot', { rows_fixed: fixed });
  } catch (err) {
    logger.warn('server.stock_state_repair_fail', { message: err.message });
  }
  const server = app.listen(PORT, () => {
    logger.info('server.listen', { port: PORT, notifications_disabled: notificationsDisabled() });
    setTimeout(() => {
      recoverOrphanedInbound(10).catch(err => {
        logger.error('server.recovery_fail', { message: err.message });
      });
    }, 3000);
  });

  // Customer-pipeline cron: auto-release stale human-handled conversations after 15 min idle.
  // Runs regardless of DISABLE_NOTIFICATIONS because this is core inbox flow, not reporting.
  const autoReleaseMinutes = parseInt(process.env.HUMAN_AUTO_RELEASE_MINUTES || '15', 10);
  cron.schedule('*/5 * * * *', async () => {
    try {
      const res = await autoReleaseStaleHumanConversations(autoReleaseMinutes);
      if (res.released > 0) {
        logger.info('cron.auto_release.done', res);
      }
    } catch (err) {
      logger.error('cron.auto_release.error', { message: err.message });
    }
  });
  logger.info('cron.auto_release.registered', { interval: '*/5 * * * *', threshold_minutes: autoReleaseMinutes });

  if (notificationsDisabled()) {
    logger.warn('cron.all_schedules_skipped_at_boot', {
      reason: 'DISABLE_NOTIFICATIONS=true',
      note: 'Notification cron handlers (reports, window monitor) skipped. Customer-pipeline cron (auto-release) still active.'
    });
  } else {
    cron.schedule('0 */2 * * *', async () => {
      try {
        logger.info('cron.period.start');
        const report = generateHourlyReport();
        await sendOwnerReport(report);
        logger.info('cron.period.done', { reportId: report.id });
      } catch (err) {
        logger.error('cron.period.error', { message: err.message });
      }
    });

    cron.schedule('0 21 * * *', async () => {
      try {
        logger.info('cron.daily.start');
        const report = generateDailyReport();
        await sendOwnerReport(report);
        snapshotDb();
        logger.info('cron.daily.done', { reportId: report.id });
      } catch (err) {
        logger.error('cron.daily.error', { message: err.message });
      }
    }, { timezone: 'Africa/Lagos' });

    cron.schedule('30 21 * * *', async () => {
      try {
        logger.info('cron.daily_learning.start');
        const report = generateDailyLearningReport();
        await sendDailyLearningReport(report);
        logger.info('cron.daily_learning.done', { reportId: report.id });
      } catch (err) {
        logger.error('cron.daily_learning.error', { message: err.message });
      }
    }, { timezone: 'Africa/Lagos' });

    cron.schedule('*/30 * * * *', async () => {
      try {
        const res = await runWindowScan();
        if (res.warned || res.expired) {
          logger.info('cron.window_scan.done', res);
        }
      } catch (err) {
        logger.error('cron.window_scan.error', { message: err.message });
      }
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.info('server.shutdown', { signal: sig });
      server.close(() => process.exit(0));
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandledRejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaughtException', { message: err.message, stack: err.stack });
  });
}

function snapshotDb() {
  if (process.env.LOG_TO_FILE === 'false') {
    logger.info('snapshot.skipped', { reason: 'LOG_TO_FILE=false (cloud deploy uses platform backups)' });
    return;
  }
  try {
    const date = new Date().toISOString().slice(0, 10);
    const dest = path.join(__dirname, 'logs', `sunny_${date}.db`);
    fs.copyFileSync(DB_PATH, dest);
    logger.info('snapshot.ok', { dest });
  } catch (err) {
    logger.error('snapshot.fail', { message: err.message });
  }
}

module.exports = app;
