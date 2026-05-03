const nodemailer = require('nodemailer');
const { getDb } = require('../db/init');
const { sendMessage } = require('./whatsapp');
const logger = require('./utils/logger');

function isoMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function aggregate(periodStart, periodEnd) {
  const db = getDb();

  const inboundCount = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND timestamp >= ? AND timestamp < ?"
  ).get(periodStart, periodEnd).n;

  const outboundCount = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND timestamp >= ? AND timestamp < ?"
  ).get(periodStart, periodEnd).n;

  const newContacts = db.prepare(
    "SELECT id, phone, name, category, location FROM contacts WHERE first_seen >= ? AND first_seen < ?"
  ).all(periodStart, periodEnd);

  const categoryChanges = db.prepare(
    "SELECT contact_id, payload, timestamp FROM events WHERE type = 'category_changed' AND timestamp >= ? AND timestamp < ?"
  ).all(periodStart, periodEnd).map(r => ({ ...r, payload: safeParse(r.payload) }));

  const escalations = db.prepare(`
    SELECT e.contact_id, e.payload, e.timestamp, c.name, c.phone, c.location
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.timestamp >= ? AND e.timestamp < ?
  `).all(periodStart, periodEnd).map(r => ({ ...r, payload: safeParse(r.payload) }));

  const intentRows = db.prepare(`
    SELECT intent, COUNT(*) AS n
    FROM messages
    WHERE direction = 'outbound' AND intent IS NOT NULL AND timestamp >= ? AND timestamp < ?
    GROUP BY intent
    ORDER BY n DESC
  `).all(periodStart, periodEnd);
  const topIntents = intentRows.slice(0, 3);

  const newSeriousBuyers = categoryChanges
    .filter(c => c.payload?.to === 'serious_buyer')
    .map(c => {
      const contact = db.prepare('SELECT name, phone, location FROM contacts WHERE id = ?').get(c.contact_id);
      return contact ? { ...contact } : null;
    })
    .filter(Boolean);

  const categoryBreakdown = db.prepare(
    "SELECT category, COUNT(*) AS n FROM contacts GROUP BY category ORDER BY n DESC"
  ).all();

  return {
    period_start: periodStart,
    period_end: periodEnd,
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    new_contacts: newContacts,
    new_contacts_count: newContacts.length,
    category_changes_count: categoryChanges.length,
    escalations,
    top_intents: topIntents,
    new_serious_buyers: newSeriousBuyers,
    category_breakdown: categoryBreakdown
  };
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function generateHourlyReport() {
  const end = new Date().toISOString();
  const start = isoMinus(60 * 60 * 1000);
  const data = aggregate(start, end);
  const report = { type: 'hourly', period_start: start, period_end: end, payload: data };
  persistReport(report);
  return report;
}

function generateDailyReport() {
  const end = new Date().toISOString();
  const start = isoMinus(24 * 60 * 60 * 1000);
  const data = aggregate(start, end);
  const report = { type: 'daily', period_start: start, period_end: end, payload: data };
  persistReport(report);
  return report;
}

function persistReport(report) {
  const db = getDb();
  const info = db.prepare(
    'INSERT INTO reports (type, period_start, period_end, payload, generated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(report.type, report.period_start, report.period_end, JSON.stringify(report.payload), new Date().toISOString());
  report.id = info.lastInsertRowid;
}

function formatReportForWhatsApp(report) {
  const p = report.payload;
  const isHourly = report.type === 'hourly';
  const title = isHourly ? 'Sunny hourly report' : 'Sunny daily report';
  const lines = [];
  lines.push(`*${title}*`);
  lines.push(`Window: ${shortTime(p.period_start)} to ${shortTime(p.period_end)}`);
  lines.push('');
  lines.push(`Messages: ${p.inbound_count} in, ${p.outbound_count} out`);
  lines.push(`New contacts: ${p.new_contacts_count}`);
  lines.push(`Category changes: ${p.category_changes_count}`);
  lines.push(`Escalations: ${p.escalations.length}`);

  if (p.top_intents.length) {
    lines.push('');
    lines.push('Top intents:');
    for (const i of p.top_intents) lines.push(`  ${i.intent}: ${i.n}`);
  }

  if (p.new_serious_buyers.length) {
    lines.push('');
    lines.push('New serious buyers:');
    for (const b of p.new_serious_buyers.slice(0, 10)) {
      lines.push(`  ${b.name || 'unknown'} (${b.phone}) ${b.location ? '- ' + b.location : ''}`.trim());
    }
  }

  if (p.escalations.length) {
    lines.push('');
    lines.push('Pending escalations:');
    for (const e of p.escalations.slice(0, 10)) {
      lines.push(`  ${e.name || 'unknown'} (${e.phone})`);
    }
  }

  if (!isHourly) {
    lines.push('');
    lines.push('Category breakdown:');
    for (const c of p.category_breakdown) lines.push(`  ${c.category}: ${c.n}`);
  }

  let out = lines.join('\n');
  if (out.length > 1500) out = out.slice(0, 1490) + '\n(truncated)';
  return out;
}

function shortTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

let _mailer = null;
function getMailer() {
  if (_mailer) return _mailer;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  _mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return _mailer;
}

async function sendOwnerReport(report) {
  const text = formatReportForWhatsApp(report);
  const ownerPhone = process.env.OWNER_WHATSAPP;
  let whatsappOk = false;

  if (ownerPhone) {
    const res = await sendMessage(ownerPhone, text);
    whatsappOk = res.ok;
    if (!whatsappOk) logger.warn('report.whatsapp.fail', { status: res.status });
  } else {
    logger.warn('report.no_owner_phone');
  }

  if (!whatsappOk) {
    await sendOwnerEmail(report, text);
  }
}

async function sendOwnerEmail(report, text) {
  const mailer = getMailer();
  const to = process.env.OWNER_EMAIL;
  if (!mailer || !to) {
    logger.warn('report.email.skipped', { hasMailer: !!mailer, hasTo: !!to });
    return;
  }
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject: `Sunny ${report.type} report`,
      text
    });
    logger.info('report.email.ok', { type: report.type });
  } catch (err) {
    logger.error('report.email.fail', { message: err.message });
  }
}

module.exports = {
  generateHourlyReport,
  generateDailyReport,
  formatReportForWhatsApp,
  sendOwnerReport
};
