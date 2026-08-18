"""Sunny voice sidecar: FastAPI server for WhatsApp Business Calling.

Receives `calls` webhook payloads, normally FORWARDED by the Node service
(src/handler.js posts the raw Meta payload here with an X-Voice-Secret
header). Answers the call via Pipecat's WhatsAppClient (pre_accept / accept
with an SDP answer) and runs one bot pipeline per call (bot.py).

Two intake modes:
- Forwarded (production): Sunny verified Meta's signature already; this
  server checks the shared VOICE_SERVICE_SECRET header instead.
- Direct (debug only): point Meta's webhook straight at this server; GET /
  handles Meta's verification handshake using
  WHATSAPP_WEBHOOK_VERIFICATION_TOKEN and the secret check is skipped when
  VOICE_SERVICE_SECRET is unset. In direct mode message webhooks also land
  here and are ignored, which breaks the text pipeline, so use it only on a
  test number.

Adapted from pipecat-examples/whatsapp (BSD 2-Clause, Daily).
"""

import asyncio
import hmac
import os
import sys
from contextlib import asynccontextmanager
from typing import Optional

import aiohttp
import uvicorn
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from loguru import logger

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.whatsapp.api import WhatsAppWebhookRequest
from pipecat.transports.whatsapp.client import WhatsAppClient

from bot import run_bot

load_dotenv(override=True)

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID")
WHATSAPP_WEBHOOK_VERIFICATION_TOKEN = os.getenv("WHATSAPP_WEBHOOK_VERIFICATION_TOKEN", "")
VOICE_SERVICE_SECRET = os.getenv("VOICE_SERVICE_SECRET", "")

_missing = [
    name
    for name, val in [
        ("WHATSAPP_TOKEN", WHATSAPP_TOKEN),
        ("WHATSAPP_PHONE_NUMBER_ID", WHATSAPP_PHONE_NUMBER_ID),
        ("DEEPGRAM_API_KEY", os.getenv("DEEPGRAM_API_KEY")),
        ("ANTHROPIC_API_KEY", os.getenv("ANTHROPIC_API_KEY")),
        ("CARTESIA_API_KEY", os.getenv("CARTESIA_API_KEY")),
    ]
    if not val
]
if _missing:
    raise ValueError(f"Missing required environment variables: {', '.join(_missing)}")

whatsapp_client: Optional[WhatsAppClient] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global whatsapp_client
    async with aiohttp.ClientSession() as session:
        whatsapp_client = WhatsAppClient(
            whatsapp_token=WHATSAPP_TOKEN,
            phone_number_id=WHATSAPP_PHONE_NUMBER_ID,
            session=session,
        )
        logger.info("WhatsApp client initialized")
        try:
            yield
        finally:
            logger.info("Terminating active calls before shutdown")
            if whatsapp_client:
                await whatsapp_client.terminate_all_calls()


app = FastAPI(title="Sunny Voice", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "sunny-voice"}


@app.get("/")
async def verify_webhook(request: Request):
    """Meta webhook verification handshake (direct debug mode only)."""
    if not WHATSAPP_WEBHOOK_VERIFICATION_TOKEN:
        raise HTTPException(status_code=403, detail="Direct webhook mode not configured")
    params = dict(request.query_params)
    try:
        return await whatsapp_client.handle_verify_webhook_request(
            params=params,
            expected_verification_token=WHATSAPP_WEBHOOK_VERIFICATION_TOKEN,
        )
    except ValueError:
        raise HTTPException(status_code=403, detail="Verification failed")


def _check_secret(request: Request) -> None:
    """Require the shared secret when one is configured (forwarded mode)."""
    if not VOICE_SERVICE_SECRET:
        return
    provided = request.headers.get("x-voice-secret", "")
    if not hmac.compare_digest(provided, VOICE_SERVICE_SECRET):
        raise HTTPException(status_code=403, detail="Invalid voice secret")


def _extract_caller(body: WhatsAppWebhookRequest):
    """Pull the caller phone and Meta call id from the webhook payload so the
    bot can attribute the transcript. Returns (phone, call_id), either may be
    None."""
    try:
        raw = body.model_dump(by_alias=True) if hasattr(body, "model_dump") else body.dict(by_alias=True)
        for entry in raw.get("entry") or []:
            for change in entry.get("changes") or []:
                value = change.get("value") or {}
                for call in value.get("calls") or []:
                    if call.get("from"):
                        return call.get("from"), call.get("id")
    except Exception as e:
        logger.warning(f"Could not extract caller from webhook: {e}")
    return None, None


@app.post("/")
async def whatsapp_webhook(
    body: WhatsAppWebhookRequest, request: Request, background_tasks: BackgroundTasks
):
    _check_secret(request)

    if body.object != "whatsapp_business_account":
        raise HTTPException(status_code=400, detail="Invalid object type")

    caller, call_id = _extract_caller(body)

    async def connection_callback(connection: SmallWebRTCConnection):
        logger.info(
            f"Call answered, starting bot for connection {connection.pc_id} "
            f"(caller tail ...{str(caller or '')[-4:]}, call {call_id})"
        )
        background_tasks.add_task(run_bot, connection, caller=caller, call_id=call_id)

    try:
        await whatsapp_client.handle_webhook_request(body, connection_callback)
        return {"status": "success"}
    except ValueError as ve:
        logger.warning(f"Invalid webhook request: {ve}")
        raise HTTPException(status_code=400, detail=f"Invalid request: {ve}")
    except Exception as e:
        logger.error(f"Error processing webhook: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


if __name__ == "__main__":
    logger.remove()
    logger.add(sys.stderr, level=os.getenv("LOG_LEVEL", "INFO"))
    port = int(os.getenv("PORT", "7860"))
    logger.info(f"Starting Sunny Voice on 0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_config=None)
