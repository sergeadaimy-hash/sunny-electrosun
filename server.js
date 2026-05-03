require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const logger = require('./src/utils/logger');
const { initDb, DB_PATH } = require('./db/init');
const webhookRouter = require('./src/webhook');
const dashboardRouter = require('./api/dashboard');
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

app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.use(webhookRouter);
app.use('/api', dashboardRouter);

app.use((err, req, res, next) => {
  logger.error('express.error', { message: err.message, stack: err.stack });
  if (res.headersSent) return;
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

if (require.main === module) {
  startupSanityChecks();
  const server = app.listen(PORT, () => {
    logger.info('server.listen', { port: PORT });
  });

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
