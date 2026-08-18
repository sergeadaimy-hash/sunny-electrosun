const test = require('node:test');
const assert = require('node:assert');

process.env.DISABLE_NOTIFICATIONS = 'true';
process.env.DISABLE_ESCALATIONS = 'true';

const handler = require('../src/handler');

test('voiceServiceUrl returns null when unset and strips trailing slashes', () => {
  const prev = process.env.VOICE_SERVICE_URL;
  try {
    delete process.env.VOICE_SERVICE_URL;
    assert.strictEqual(handler.voiceServiceUrl(), null);
    process.env.VOICE_SERVICE_URL = '   ';
    assert.strictEqual(handler.voiceServiceUrl(), null);
    process.env.VOICE_SERVICE_URL = 'https://voice.example.com/';
    assert.strictEqual(handler.voiceServiceUrl(), 'https://voice.example.com');
    process.env.VOICE_SERVICE_URL = 'https://voice.example.com//';
    assert.strictEqual(handler.voiceServiceUrl(), 'https://voice.example.com');
  } finally {
    if (prev === undefined) delete process.env.VOICE_SERVICE_URL;
    else process.env.VOICE_SERVICE_URL = prev;
  }
});

test('forwardCallsToVoiceService is disabled when no URL is configured', async () => {
  const res = await handler.forwardCallsToVoiceService({ entry: [] }, { url: null });
  assert.deepStrictEqual(res, { forwarded: false, reason: 'disabled' });
});

test('forwardCallsToVoiceService posts the raw payload with the shared secret', async () => {
  const prevSecret = process.env.VOICE_SERVICE_SECRET;
  process.env.VOICE_SERVICE_SECRET = 'test-secret';
  const seen = {};
  const fetchImpl = async (url, opts) => {
    seen.url = url;
    seen.opts = opts;
    return { ok: true, status: 200 };
  };
  try {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: '1' }] };
    const res = await handler.forwardCallsToVoiceService(payload, {
      url: 'https://voice.example.com',
      fetchImpl
    });
    assert.deepStrictEqual(res, { forwarded: true });
    assert.strictEqual(seen.url, 'https://voice.example.com/');
    assert.strictEqual(seen.opts.method, 'POST');
    assert.strictEqual(seen.opts.headers['X-Voice-Secret'], 'test-secret');
    assert.deepStrictEqual(JSON.parse(seen.opts.body), payload);
  } finally {
    if (prevSecret === undefined) delete process.env.VOICE_SERVICE_SECRET;
    else process.env.VOICE_SERVICE_SECRET = prevSecret;
  }
});

test('forwardCallsToVoiceService reports non-200 responses as failures', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const res = await handler.forwardCallsToVoiceService({ entry: [] }, {
    url: 'https://voice.example.com',
    fetchImpl
  });
  assert.deepStrictEqual(res, { forwarded: false, reason: 'status_503' });
});

test('forwardCallsToVoiceService reports network errors as failures', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const res = await handler.forwardCallsToVoiceService({ entry: [] }, {
    url: 'https://voice.example.com',
    fetchImpl
  });
  assert.strictEqual(res.forwarded, false);
  assert.strictEqual(res.reason, 'ECONNREFUSED');
});
