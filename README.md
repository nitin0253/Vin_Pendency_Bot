# QC Dashboard → Slack Bot (Fully Automated via GitHub Actions)

Zero servers. Zero cost. Runs 24x7 automatically.

## Setup (5 minutes)

### Step 1 — Push to GitHub
Create a new repo and push these files:
```
.github/workflows/slack-screenshot.yml
screenshot-bot.js
package.json
```

### Step 2 — Add Secrets in GitHub
Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these 3 secrets:

| Secret name | Value |
|---|---|
| `SLACK_WEBHOOK` | `https://hooks.slack.com/services/T01HY4TNJDC/B0B524H0F7F/...` |
| `SLACK_BOT_TOKEN` | `xoxb-...` (get from api.slack.com — needed to send actual image) |
| `SLACK_CHANNEL` | Your channel ID e.g. `C0XXXXXXXX` (right-click channel → Copy link → last part) |

> **SLACK_WEBHOOK is already hardcoded as fallback** — but for actual screenshots
> you MUST add SLACK_BOT_TOKEN + SLACK_CHANNEL. Without them, only a text message is sent.

### Step 3 — Get a Bot Token (for real screenshot images)
1. Go to https://api.slack.com/apps
2. Open your existing Slack app
3. **OAuth & Permissions** → Scopes → Add: `files:write`, `chat:write`
4. **Install to Workspace** → copy the `xoxb-...` token
5. Get channel ID: open Slack → right-click your channel → **Copy link** → last segment is the ID (`C0XXXXXXXX`)

### Step 4 — Done! ✅
GitHub Actions will now:
- Run **every hour automatically** (0 * * * * UTC)
- Take a screenshot of https://vin-tracker-delivery.vercel.app/
- Wait for dashboard data to load
- Post the screenshot to your Slack channel

### Manual trigger
Go to GitHub repo → **Actions** → **QC Dashboard Screenshot → Slack** → **Run workflow**

## Timezone note
Cron runs in UTC. `0 * * * *` = every hour on the hour UTC = 5:30 AM, 6:30 AM... IST.
To shift to IST hours (e.g. every hour on the IST hour): `30 * * * *`

## Cost
**Free** — GitHub Actions gives 2000 minutes/month on free tier.
Each run takes ~2 minutes → 48 runs/day → ~1440 min/month. Just within free tier.
