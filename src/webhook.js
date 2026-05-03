const express = require('express');
const logger = require('./utils/logger');
const { verifyMetaSignature } = require('./utils/verifySignature');
const { handleInbound } = require('./handler');

const router = express.Router();

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.META_VERIFY_TOKEN) {
    logger.info('webhook.verify.ok');
    return res.status(200).send(challenge);
  }
  logger.warn('webhook.verify.fail', { mode, tokenMatch: token === process.env.META_VERIFY_TOKEN });
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  const signature = req.get('X-Hub-Signature-256');
  const appSecret = process.env.META_APP_SECRET;
  const rawBody = req.rawBody;

  if (!rawBody) {
    logger.error('webhook.post.no_raw_body');
    return res.sendStatus(400);
  }

  if (appSecret && !verifyMetaSignature(rawBody, signature, appSecret)) {
    logger.warn('webhook.signature.invalid');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    await handleInbound(req.body);
  } catch (err) {
    logger.error('webhook.handler.error', { message: err.message, stack: err.stack });
  }
});

module.exports = router;
