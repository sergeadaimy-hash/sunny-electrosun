const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
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

async function downloadMedia(mediaId) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');
  const auth = { Authorization: `Bearer ${token}` };

  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const metaRes = await axios.get(metaUrl, { headers: auth, timeout: 15000 });
  const url = metaRes.data && metaRes.data.url;
  const mimeType = metaRes.data && metaRes.data.mime_type;
  const sizeBytes = metaRes.data && metaRes.data.file_size;
  if (!url) throw new Error('media metadata missing url');

  const fileRes = await axios.get(url, {
    headers: auth,
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 25 * 1024 * 1024,
    maxBodyLength: 25 * 1024 * 1024
  });

  logger.info('whatsapp.media.downloaded', { mediaId, mimeType, sizeBytes });
  return { buffer: Buffer.from(fileRes.data), mimeType, sizeBytes };
}

async function uploadMediaToMeta(filePath, mimeType, filename) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId) throw new Error('META_PHONE_NUMBER_ID is not set');
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');
  if (!fs.existsSync(filePath)) throw new Error('file not found: ' + filePath);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', fs.createReadStream(filePath), { filename: filename || 'file', contentType: mimeType });

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/media`;
  const res = await axios.post(url, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    timeout: 60000,
    maxContentLength: 30 * 1024 * 1024,
    maxBodyLength: 30 * 1024 * 1024
  });
  const mediaId = res.data && res.data.id;
  if (!mediaId) throw new Error('upload returned no media id');
  logger.info('whatsapp.media.uploaded', { mediaId, mimeType, filename });
  return mediaId;
}

async function sendDocument(to, mediaId, filename, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: {
      id: mediaId,
      filename: filename || 'document.pdf',
      caption: caption || undefined
    }
  };
  if (!payload.document.caption) delete payload.document.caption;

  try {
    const res = await axios.post(endpoint(), payload, { headers: authHeaders(), timeout: 20000 });
    const messageId = res.data?.messages?.[0]?.id || null;
    logger.info('whatsapp.document.ok', { to, mediaId, messageId, filename });
    return { ok: true, messageId, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('whatsapp.document.fail', { to, mediaId, status, data: safe(data), message: err.message });
    return { ok: false, status, error: data || err.message };
  }
}

function safe(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return String(obj); }
}

module.exports = { sendMessage, sendTemplate, downloadMedia, uploadMediaToMeta, sendDocument };
