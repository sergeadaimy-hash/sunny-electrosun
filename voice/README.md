# Sunny Voice (WhatsApp calls)

Python sidecar that answers voice calls to the Electro-Sun WhatsApp number (+234 913 055 4747) with a real-time AI agent. Built on [Pipecat](https://github.com/pipecat-ai/pipecat) and Meta's WhatsApp Business Calling API.

Pipeline per call: WebRTC audio from Meta, Deepgram (speech to text), Claude (`claude-sonnet-4-6`), Cartesia (text to speech), back over WebRTC.

## How it connects to Sunny

Meta delivers ALL webhook events (messages and calls) to the Node service's `/webhook`. When `VOICE_SERVICE_URL` is set on the Node service, `src/handler.js` forwards raw `calls` payloads here with an `X-Voice-Secret` header; this server answers the call (pre_accept, then accept with an SDP answer) and runs one bot pipeline per call. If the forward fails or `VOICE_SERVICE_URL` is unset, the Node service falls back to the old "this number isn't monitored for voice calls" text reply, so a down sidecar never loses a customer. Blocked numbers (`BLOCKED_NUMBERS`) are dropped before forwarding.

Phase 1 knowledge is the hardcoded prompt in `prompt.py`: no prices, no specs, everything defers to a WhatsApp chat follow-up. Phase 2 will fetch Sunny's composed context (warehouse stock, playbook, caller history) at call start.

## One-time Meta setup

1. WhatsApp Manager, the phone number's **Calls** tab: enable **Allow voice calls**.
2. Meta App Dashboard, WhatsApp > Configuration > Webhook fields: subscribe to **calls** (messages is already subscribed). The callback URL stays the Node service's `/webhook`.

## Deploy on Railway (second service, same repo)

1. New service from the `sunny-electrosun` repo, **Root Directory = `voice/`** (it builds from the Dockerfile).
2. Set env vars from `env.example`: `WHATSAPP_TOKEN` (same System User token as the Node service), `WHATSAPP_PHONE_NUMBER_ID`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`, and a fresh random `VOICE_SERVICE_SECRET`.
3. Generate a public domain for the service.
4. On the NODE service set: `VOICE_SERVICE_URL=https://<voice-service-domain>` and the same `VOICE_SERVICE_SECRET`, then redeploy it.
5. Call the WhatsApp number and talk to Sunny.

Kill switch: remove `VOICE_SERVICE_URL` from the Node service (or take this service down); calls revert to the text autoreply.

## Local dev

```bash
cd voice
cp env.example .env   # fill it in
uv sync
uv run server.py
```

`GET /health` is the liveness check. Direct-webhook debug mode (Meta pointed straight at this server, bypassing Node) needs `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN` set and should only ever be used on a test number, because message webhooks would bypass the text pipeline.

## Known risk (why Phase 1 exists)

WebRTC media runs over UDP from inside this container. Railway does not support inbound UDP; ICE usually succeeds over outbound flows, but this must be proven with a real call. If audio will not hold on Railway, move ONLY this service to Fly.io, Pipecat Cloud, or a small VPS; the Node service and the forwarding contract stay unchanged.
