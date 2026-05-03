const nodemailer = require('nodemailer');
const { getDb } = require('../db/init');
const { sendMessage } = require('./whatsapp');
const logger = require('./utils/logger');

function isoMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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
    "SELECT id, phone, name, category, lead_temperature, client_type, location FROM contacts WHERE first_seen >= ? AND first_seen < ?"
  ).all(periodStart, periodEnd);

  const newByCategory = countBy(newContacts, c => c.category || 'unsorted');
  const newByTemperature = countBy(newContacts, c => c.lead_temperature || 'unsorted');

  const allEscalations = db.prepare(`
    SELECT e.contact_id, e.payload, e.timestamp, c.name, c.phone, c.location, c.category, c.lead_temperature, c.client_type
    FROM events e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.type = 'escalated' AND e.timestamp >= ? AND e.timestamp < ?
    ORDER BY e.timestamp DESC
  `).all(periodStart, periodEnd).map(r => ({ ...r, payload: safeParse(r.payload) }));

  const hotLeadEscalations = allEscalations.filter(e => e.payload?.escalation_type === 'hot_lead');
  const silentQueryEscalations = allEscalations.filter(e => e.payload?.escalation_type !== 'hot_lead');

  const warmLeadsInWindow = db.prepare(`
    SELECT DISTINCT c.id, c.phone, c.name, c.category, c.client_type, c.location
    FROM contacts c
    JOIN conversations conv ON conv.contact_id = c.id
    JOIN messages m ON m.conversation_id = conv.id
    WHERE c.lead_temperature = 'WARM'
      AND m.direction = 'inbound'
      AND m.timestamp >= ? AND m.timestamp < ?
  `).all(periodStart, periodEnd);

  const intentRows = db.prepare(`
    SELECT intent, COUNT(*) AS n
    FROM messages
    WHERE direction = 'outbound' AND intent IS NOT NULL AND timestamp >= ? AND timestamp < ?
    GROUP BY intent
    ORDER BY n DESC
  `).all(periodStart, periodEnd);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    new_contacts: newContacts,
    new_contacts_count: newContacts.length,
    new_by_category: newByCategory,
    new_by_temperature: newByTemperature,
    hot_leads: hotLeadEscalations,
    warm_leads: warmLeadsInWindow,
    silent_queries: silentQueryEscalations,
    top_intents: intentRows.slice(0, 3),
    disqualified_count: newByTemperature.DISQUALIFIED || 0
  };
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function generateHourlyReport() {
  const end = new Date().toISOString();
  const start = isoMinus(2 * 60 * 60 * 1000);
  const data = aggregate(start, end);
  const report = { type: 'period', period_start: start, period_end: end, payload: data };
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
  const isDaily = report.type === 'daily';
  const lines = [];

  lines.push('*ELECTRO-SUN AGENT REPORT*');
  lines.push(`Window: ${shortTime(p.period_start)} to ${shortTime(p.period_end)}`);
  lines.push(`Inbound ${p.inbound_count}, outbound ${p.outbound_count}`);
  lines.push('');

  lines.push('🔴 HOT LEADS (action needed)');
  if (p.hot_leads.length === 0) {
    lines.push('  None this window.');
  } else {
    for (const h of p.hot_leads.slice(0, 10)) {
      const meta = [h.client_type, h.location].filter(Boolean).join(', ');
      lines.push(`  • ${h.name || 'unknown'} (${h.phone})${meta ? ': ' + meta : ''}`);
    }
  }
  lines.push('');

  lines.push('🟠 WARM LEADS (in progress)');
  if (p.warm_leads.length === 0) {
    lines.push('  None this window.');
  } else {
    for (const w of p.warm_leads.slice(0, 10)) {
      const meta = [w.client_type, w.location].filter(Boolean).join(', ');
      lines.push(`  • ${w.name || 'unknown'} (${w.phone})${meta ? ': ' + meta : ''}`);
    }
  }
  lines.push('');

  lines.push('🟡 PENDING SILENT QUERIES (awaiting your reply)');
  if (p.silent_queries.length === 0) {
    lines.push('  None this window.');
  } else {
    for (const s of p.silent_queries.slice(0, 10)) {
      const intent = s.payload?.intent || 'other';
      lines.push(`  • ${s.name || 'unknown'} (${s.phone}): ${intent}`);
    }
  }
  lines.push('');

  const cat = p.new_by_category || {};
  const catParts = ['C1', 'C2', 'C3', 'C4', 'C5', 'unsorted']
    .map(c => `${c}: ${cat[c] || 0}`)
    .join(', ');
  lines.push('🟢 NEW CONVERSATIONS THIS PERIOD');
  lines.push(`  Total: ${p.new_contacts_count} (${catParts})`);
  lines.push('');

  lines.push('⚪ DISQUALIFIED / LOW-TIER');
  lines.push(`  Total this window: ${p.disqualified_count}`);

  if (p.top_intents.length) {
    lines.push('');
    lines.push('Top intents:');
    for (const i of p.top_intents) lines.push(`  ${i.intent}: ${i.n}`);
  }

  if (isDaily) {
    lines.push('');
    lines.push('(Daily summary, full data in dashboard.)');
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
      subject: `Electro-Sun agent ${report.type} report`,
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
