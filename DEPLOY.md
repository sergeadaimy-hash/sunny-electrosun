# Deploy Sunny to Railway

Step-by-step. Read top to bottom.

## Prerequisites

- GitHub repo `sergeadaimy-hash/sunny-electrosun` is up to date with main.
- You have your `.env` values handy (we'll paste them into Railway).

## 1. Sign up / log in to Railway

1. Go to https://railway.com.
2. Sign in with GitHub. Authorize Railway to read your repos.
3. On free trial you get $5 of credits. After that, Hobby plan is $5/mo (Sunny will fit comfortably).

## 2. Create a new project from the repo

1. Click "New Project" → "Deploy from GitHub repo".
2. Pick `sergeadaimy-hash/sunny-electrosun`.
3. Railway starts a first build. **Let it fail.** We have not set env vars yet, so Sunny will start, fail sanity checks, and crash. That is expected.

## 3. Add a persistent volume for the database

1. In the project, click on your service tile.
2. Go to "Settings" → "Volumes" → "Add Volume".
3. Mount path: `/data`.
4. Size: `1 GB` (way more than we need; lets us grow).
5. Save.

## 4. Set environment variables

In the service "Variables" tab, click "Raw Editor" and paste the block below. Fill in the real values from your local `.env`. Do NOT include `PORT` (Railway sets that automatically).

```
META_VERIFY_TOKEN=<your value>
META_ACCESS_TOKEN=<permanent system user token>
META_PHONE_NUMBER_ID=<your value>
META_APP_SECRET=<your value, REQUIRED in production>
ANTHROPIC_API_KEY=<your value>
OWNER_WHATSAPP=<digits only, e.g. 966502392650>
OWNER_EMAIL=<optional>
SPECIALIST_DIRECT_LINK=<optional, digits only>
SMTP_HOST=<optional>
SMTP_USER=<optional>
SMTP_PASS=<optional>
API_KEY=<random string for /api auth>
DAILY_LLM_BUDGET_USD=5

# Cloud-specific
LOG_TO_FILE=false
DB_PATH=/data/sunny.db
META_WABA_ID=1713234916358524
```

Click "Update Variables". Railway redeploys.

## 5. Wait for the deploy to go green

1. Watch "Deployments" tab.
2. First successful deploy should show "Active" within 1-2 min.
3. Click the deploy → "View Logs". You should see:
   - `migration: added contacts.<col>` (one-time on first boot)
   - `server.listen` log line
   - No `server.env.missing` or `server.env.no_app_secret` warnings (if you see them, you missed an env var).

## 6. Get the public URL

1. In "Settings" → "Networking" → "Public Networking", click "Generate Domain".
2. Railway gives you something like `sunny-electrosun-production.up.railway.app`.
3. Test the health endpoint in a browser:
   ```
   https://<your-railway-url>/health
   ```
   Should return `{"status":"ok","uptime_seconds":...}`.

## 7. Update Meta webhook to point at the new URL

1. https://developers.facebook.com/apps → ElectroSun_Whtspp app.
2. WhatsApp → Configuration → Webhook → Edit.
3. Callback URL: `https://<your-railway-url>/webhook`.
4. Verify token: same value as `META_VERIFY_TOKEN` you set in Railway.
5. Click "Verify and save". Meta hits `/webhook` with a GET, our handler echoes the challenge, success.
6. Subscribe to webhook fields: `messages` (you already did this in dev).

## 8. Live test

Send a WhatsApp message from a whitelisted number to your Meta test number (or production number once Task #17 is done):

- Customer message lands in Railway logs.
- Sunny replies.
- If escalation, owner gets the alert.
- Hourly report cron will fire on the next 2-hour boundary; check it works once the brother has messaged Sunny in the past 24h, otherwise the template fallback kicks in (which is the whole reason we submitted templates).

## 9. Cutover housekeeping

After a clean live test:

- Stop the local server (`Ctrl+C` on `npm start` and shut down the cloudflared tunnel).
- Delete or comment out cloudflared from your dev workflow notes; it's not needed anymore.
- Update `OWNER_WHATSAPP` in Railway to the brother's actual number when Task #17 lands.

## Rollback

If a bad deploy crashes Sunny:

1. Railway "Deployments" tab → previous green deploy → "Redeploy".
2. Takes 30-60 seconds.

## Volume safety

The `/data` volume survives redeploys, restarts, and even service-level deletes (Railway keeps volumes for 7 days after detach). Your DB is safe across normal deployment churn. For long-term backup, copy `/data/sunny.db` to your laptop periodically via `railway run` or a scheduled script.

## Troubleshooting

- **Build fails on `better-sqlite3`**: Nixpacks should compile it cleanly on Node 20. If it fails, check the build log; a Dockerfile fallback is a 10-line addition.
- **Webhook signature mismatches**: confirm `META_APP_SECRET` is set in Railway and matches the Meta app secret exactly.
- **`/api` returns 503**: `API_KEY` env var is unset.
- **Crons don't fire**: Railway containers restart on deploy, which resets cron; this is fine because cron schedules re-register on every boot in `server.js`.
