# health_mcp

A personal MCP server that lets Claude read your health data and log food. It runs free on Cloudflare Workers.

- **Google Health API** (the successor to the Fitbit Web API): sleep, heart rate, HRV, SpO2, steps, weight, and food logging (read and write)
- **Garmin Personal API**: workouts and VO2max (read only)

Only one Google account, the one in `ALLOWED_EMAIL`, can sign in.

## How it works

```
Claude ──OAuth──▶ /authorize ──▶ consent page ──▶ Google sign-in ──▶ /callback
   │                                                                   │
   └──── Bearer token ──▶ /mcp  (tools)  ◀── Google tokens stored ─────┘
                           │                encrypted in the grant (KV)
                           ├──▶ health.googleapis.com/v4   (Google token)
                           └──▶ personal.connectapi.garmin.com (Garmin key → 24h token, cached in KV)
```

- `src/index.ts` wires the pieces together: the OAuth provider, the MCP endpoint, and the Google token refresh.
- `src/auth.ts` handles the consent page, the Google redirect, and the email check.
- `src/tools.ts` defines the MCP tools.
- `src/google.ts` and `src/garmin.ts` are the API clients.

## Tools

| Tool | Source | What it does |
|---|---|---|
| `get_health_data` | Google | Raw de-duplicated data points (sleep, HRV, resting HR, weight, …) for a date range |
| `get_daily_totals` | Google | Per-day steps, distance, active zone minutes, heart rate, weight |
| `log_food` | Google | Logs a meal with its calories and macros |
| `delete_food_logs` | Google | Deletes food log entries |
| `get_workouts` | Garmin | Lists workouts with their key metrics |
| `get_workout` | Garmin | Gives the full summary of one workout |
| `get_vo2max` | Garmin | Gives VO2max per day (running and cycling) |

## Setup (one time, about 20 minutes)

### 1. Garmin key
In Garmin Connect on the web, go to **Settings → Personal API Token** ([direct link](https://connect.garmin.com/app/settings/personalApiToken)). Create a key that lasts 1 year, and save it in your password manager. Garmin shows it only once.

### 2. Google Cloud project (free)
1. Create a project at https://console.cloud.google.com.
2. Enable the **Google Health API**: https://console.cloud.google.com/apis/library/health.googleapis.com
3. Set up the **OAuth consent screen**. Choose user type **External**, and add your Gmail under **Test users**.
4. On **Data Access**, add the Google Health scopes listed in `src/google.ts`.
5. Under **Credentials**, create an **OAuth client ID** of type *Web application*. Set the redirect URI to `https://health-mcp.bvph9n47ws.workers.dev/callback`.
6. Under **Audience**, click **Publish app**. If you skip this, Google's sign-in expires every 7 days while the app is in "Testing". An unverified published app works for up to 100 users and shows an "unverified app" warning, which you click through.

### 3. Cloudflare (free)
```sh
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV      # paste the id into wrangler.jsonc
# edit wrangler.jsonc: MCP_RESOURCE (your workers.dev URL + /mcp) and ALLOWED_EMAIL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GARMIN_API_KEY
openssl rand -hex 32 | npx wrangler secret put CONSENT_SECRET
npm run deploy
```

### 4. Connect Claude
In Claude, go to **Settings → Connectors → Add custom connector**. Paste `https://health-mcp.bvph9n47ws.workers.dev/mcp`, then sign in.

## Known limits
- Garmin keys expire after at most 1 year. When yours does, make a new one and run `wrangler secret put GARMIN_API_KEY`.
- Garmin's Personal API is read only, so you can't push workouts to the watch.
- Food entries without a food ID can't be edited, only deleted and logged again.
- The Google Health API caps rollups at 90 days per request, or 14 days for heart rate and active zone minutes.
