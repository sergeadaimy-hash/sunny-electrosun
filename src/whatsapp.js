const axios = require('axios');
const logger = require('./utils/logger');

const GRAPH_VERSION = 'v21.0';

function endpoint() {
  const id = process.env.META_PHONE_NUMBER_ID;
  if (!id) throw new Error('META_PHONE_NUMBER_ID is not set');
  return `https://graph.facebook.com/${GRAPH_VERSION}/${id}/messages`;
}

function authHeaders() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

async function sendMessage(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body }
  };

  try {
    const res = await axios.post(endpoint(), payload, { headers: authHeaders(), timeout: 15000 });
    const messageId = res.data?.messages?.[0]?.id || null;
    logger.info('whatsapp.send.ok', { to, messageId });
    return { ok: true, messageId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('whatsapp.send.fail', { to, status, data: safe(data), message: err.message });
    return { ok: false, status, error: data || err.message };
  }
}

async function sendTemplate(to, templateName, languageCode = 'en', components = []) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components
    }
  };

  try {
    const res = await axios.post(endpoint(), payload, { headers: authHeaders(), timeout: 15000 });
    const messageId = res.data?.messages?.[0]?.id || null;
    logger.info('whatsapp.template.ok', { to, templateName, messageId });
    return { ok: true, messageId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('whatsapp.template.fail', { to, templateName, status, data: safe(data), message: err.message });
    return { ok: false, status, error: data || err.message };
  }
}

function safe(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return String(obj); }
}

module.exports = { sendMessage, sendTemplate };
