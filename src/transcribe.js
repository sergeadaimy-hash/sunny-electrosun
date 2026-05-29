const axios = require('axios');
const FormData = require('form-data');
const logger = require('./utils/logger');

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';

async function transcribeAudio(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('transcribe.no_openai_key');
    return { ok: false, error: 'OPENAI_API_KEY not set', text: null };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, error: 'empty audio buffer', text: null };
  }

  const ext = mimeType?.includes('mp3') ? 'mp3'
    : mimeType?.includes('wav') ? 'wav'
    : mimeType?.includes('mp4') || mimeType?.includes('m4a') ? 'm4a'
    : mimeType?.includes('webm') ? 'webm'
    : 'ogg';

  const form = new FormData();
  form.append('file', buffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg' });
  form.append('model', WHISPER_MODEL);
  // Pin the source language so Whisper does not auto-detect a wrong language on
  // short or accented clips. Electro-Sun voice notes are overwhelmingly English
  // (and Pidgin, which Whisper renders as English). Without this hint, accented
  // English clips were being mis-detected and transcribed into Arabic, which
  // then made Sunny reply in Arabic. Configurable via WHISPER_LANGUAGE; set to
  // empty string to restore auto-detect.
  const whisperLanguage = process.env.WHISPER_LANGUAGE === undefined ? 'en' : process.env.WHISPER_LANGUAGE;
  if (whisperLanguage) {
    form.append('language', whisperLanguage);
  }

  try {
    const res = await axios.post(`${OPENAI_API_BASE}/audio/transcriptions`, form, {
      headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
      maxContentLength: 30 * 1024 * 1024,
      maxBodyLength: 30 * 1024 * 1024,
      timeout: 60000
    });
    const text = (res.data?.text || '').trim();
    logger.info('transcribe.ok', { chars: text.length, mime: mimeType });
    return { ok: true, text };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('transcribe.fail', { status, message: err.message, data: typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200) });
    return { ok: false, error: err.message, text: null };
  }
}

module.exports = { transcribeAudio };
