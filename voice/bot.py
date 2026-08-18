"""Sunny voice bot: the per-call Pipecat pipeline.

One instance of run_bot runs per answered WhatsApp call. Cascaded pipeline:
Deepgram (speech to text) -> Claude (LLM) -> Cartesia (text to speech), with
Silero VAD for turn detection, over the WebRTC connection that
WhatsAppClient established with Meta.

Phase 1: knowledge is the small hardcoded prompt in prompt.py (no prices, no
specs; everything defers to WhatsApp chat follow-up). Phase 2 swaps that for a
live fetch of Sunny's composed context from the Node service.
"""

import os
from datetime import datetime, timezone

import aiohttp
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from prompt import GREETING_INSTRUCTION, SYSTEM_PROMPT

load_dotenv(override=True)

# Matches the model family Sunny's text replies run on. Override per deploy.
MODEL_VOICE = os.getenv("MODEL_VOICE", "claude-sonnet-4-6")

# Default voice: Cartesia "British Reading Lady" (the Pipecat quickstart
# default). Pick a better fit in the Cartesia playground and set
# CARTESIA_VOICE_ID on the service.
CARTESIA_VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121")

# Speaking speed multiplier, valid range 0.6 (slow) to 1.5 (fast). Unset = 1.0.
CARTESIA_SPEED = os.getenv("CARTESIA_SPEED", "").strip()


def _tts_settings():
    kwargs = {"voice": CARTESIA_VOICE_ID}
    if CARTESIA_SPEED:
        try:
            speed = min(1.5, max(0.6, float(CARTESIA_SPEED)))
            kwargs["generation_config"] = GenerationConfig(speed=speed)
        except ValueError:
            logger.warning(f"Ignoring invalid CARTESIA_SPEED: {CARTESIA_SPEED}")
    return CartesiaTTSService.Settings(**kwargs)

# Where transcripts are posted at call end (Sunny's Node service).
SUNNY_BASE_URL = os.getenv(
    "SUNNY_BASE_URL", "https://sunny-electrosun-production.up.railway.app"
).rstrip("/")
VOICE_SERVICE_SECRET = os.getenv("VOICE_SERVICE_SECRET", "")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _collect_transcript(context):
    """Flatten the LLM context into [{role, content}] turns, dropping the
    system prompt and the internal greeting instruction."""
    try:
        messages = context.get_messages()
    except Exception:
        messages = getattr(context, "messages", None) or []
    turns = []
    for m in messages:
        if not isinstance(m, dict):
            m = getattr(m, "__dict__", None) or {}
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(
                (p.get("text", "") if isinstance(p, dict) else str(p)) for p in content
            )
        content = str(content or "").strip()
        if not content or content == GREETING_INSTRUCTION:
            continue
        turns.append({"role": role, "content": content})
    return turns


async def _post_transcript(caller, call_id, started_at, turns):
    """Send the finished call's transcript to Sunny. Best effort: a failure is
    logged, never raised, so it can't break call teardown."""
    if not caller:
        logger.warning("No caller phone captured; transcript not posted")
        return
    payload = {
        "phone": caller,
        "call_id": call_id,
        "status": "completed" if turns else "no_transcript",
        "started_at": started_at,
        "ended_at": _now_iso(),
        "messages": turns,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{SUNNY_BASE_URL}/voice-transcript",
                json=payload,
                headers={"X-Voice-Secret": VOICE_SERVICE_SECRET},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                logger.info(f"Transcript posted ({len(turns)} turns): HTTP {resp.status}")
    except Exception as e:
        logger.error(f"Failed to post transcript: {e}")


async def run_bot(webrtc_connection, caller=None, call_id=None):
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_10ms_chunks=2,
        ),
    )

    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    llm = AnthropicLLMService(
        api_key=os.getenv("ANTHROPIC_API_KEY"),
        model=MODEL_VOICE,
    )

    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        settings=_tts_settings(),
    )

    # System prompt lives in the context so it is provider agnostic.
    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}])
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    started_at = _now_iso()

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Caller connected, starting greeting")
        context.add_message({"role": "user", "content": GREETING_INSTRUCTION})
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Caller disconnected, cancelling pipeline")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    finally:
        turns = _collect_transcript(context)
        await _post_transcript(caller, call_id, started_at, turns)
