# Google Ads API setup — keyword volume (OAuth)

**Who this is for:** anyone setting up local or shared credentials so the rank-and-rent research tool can pull **search volume** from Google Ads Keyword Planner.

**What this is not for:** DataForSEO / SERP purchases. SERP still uses DataForSEO. Volume only uses Google Ads.

---

## What you will produce

Three OAuth values (plus IDs the team already has):

| Variable | Description |
|---|---|
| `GOOGLE_ADS_CLIENT_ID` | OAuth client ID from Google Cloud |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret from Google Cloud |
| `GOOGLE_ADS_REFRESH_TOKEN` | Long-lived token after one browser login |

Also confirm (usually already configured by eng):

| Variable | Description |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Ads API developer token (API Center) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager (MCC) account ID |
| `GOOGLE_ADS_CUSTOMER_ID` | Client Ads account ID used for Keyword Planner |

Ask the repo owner for the current MCC / customer IDs and developer token if you do not already have them. **Do not commit secrets to git.** Put them only in local `.env` / shared secret store.

---

## Prerequisites

1. A **Google account** that can open [Google Ads](https://ads.google.com) for the client account under the MCC (read access is enough for metrics).
2. Permission to create a project (or use an existing one) in [Google Cloud Console](https://console.cloud.google.com/).
3. About **15–20 minutes**.

---

## Step 1 — Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project or select an existing one (name example: `rank-and-rent-ads`).
3. Open **APIs & Services → Library**.
4. Search for **Google Ads API**.
5. Click **Enable**.

---

## Step 2 — OAuth consent screen

1. Open **APIs & Services → OAuth consent screen**.
2. User type:
   - **External** — typical for most teams.
   - **Internal** — only if every user is on the same Google Workspace and you want to restrict to that org.
3. Fill required fields:
   - App name (e.g. `Rank and Rent keyword volume`)
   - User support email
   - Developer contact email
4. **Scopes → Add or remove scopes** → add:

   ```text
   https://www.googleapis.com/auth/adwords
   ```

5. If the app status is **Testing**:
   - Under **Test users**, add every Google account that will generate a refresh token or run the tool against live Ads.
   - Only listed test users can complete OAuth while the app is in Testing.
6. You do **not** need to publish the app to Production for internal tooling. Testing + test users is fine.

---

## Step 3 — Create Client ID and Client Secret

1. Open **APIs & Services → Credentials**.
2. **Create credentials → OAuth client ID**.
3. Application type: **Desktop app** (recommended for a refresh token you paste into env).
4. Name it (e.g. `rank-and-rent-desktop`).
5. Create, then copy:
   - **Client ID** → `GOOGLE_ADS_CLIENT_ID`
   - **Client secret** → `GOOGLE_ADS_CLIENT_SECRET`


   Client ID
YOUR_CLIENT_ID.apps.googleusercontent.com
You will no longer be able to view or download the client secret once you close this dialog. Make sure you have copied or downloaded the information below and securely stored it.
Client secret
GOCSPX-REDACTED-ROTATE-THIS
Creation date
August 4, 2026, 11:54:46 AM GMT-7
Status
 Enabled


Keep the secret private. Share via 1Password / team vault, not Slack/email if you can avoid it.

---

## Step 4 — Get a Refresh Token (one-time login)

You authorize once with the Google account that has Ads access. Google returns a **refresh token** the app uses forever (until revoked).

### Recommended: OAuth 2.0 Playground

1. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Click the **gear icon** (top right).
3. Check **Use your own OAuth credentials**.
4. Paste:
   - OAuth Client ID
   - OAuth Client secret
5. In the left panel, either:
   - Find **Google Ads API** and select the `adwords` scope, or
   - Paste this scope manually:

     ```text
     https://www.googleapis.com/auth/adwords
     ```

6. Click **Authorize APIs**.
7. Sign in as the **Google account that has access to the Ads customer** (must be a Test user if the consent screen is in Testing).
8. Accept the permissions. If you see “Google hasn’t verified this app”, use **Advanced → Go to … (unsafe)** — expected for internal testing apps.
9. Click **Exchange authorization code for tokens**.
10. Copy **Refresh token** → `GOOGLE_ADS_REFRESH_TOKEN`.

### Important flags (if you use a custom URL instead of Playground)

The authorize request must include:

- `access_type=offline` — required to receive a refresh token  
- `prompt=consent` — forces consent so a refresh token is issued even if the app was authorized before  

Without those, you often get only a short-lived **access token** and no refresh token.

---

## Step 5 — Put values in environment config

Local example (repo root `.env` — already gitignored):

```env
GOOGLE_ADS_DEVELOPER_TOKEN=...          # from Ads API Center
GOOGLE_ADS_LOGIN_CUSTOMER_ID=...        # MCC (dashes OK)
GOOGLE_ADS_CUSTOMER_ID=...              # client account (dashes OK)
GOOGLE_ADS_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=GOCSPX-...
GOOGLE_ADS_REFRESH_TOKEN=1//...
GOOGLE_ADS_API_VERSION=v18

# Required for any live provider call (Ads volume + DataForSEO SERP)
LIVE_CALLS_ENABLED=true
```

Notes:

- Customer IDs may include dashes; the app strips non-digits before calling the API.
- Restart the web app / worker after changing `.env`.
- Never commit `.env` or paste refresh tokens into PRs, tickets, or public channels.

---

## Step 6 — Access checklist

Before declaring setup done, verify:

| Check | Why |
|---|---|
| OAuth user can open the client account in Google Ads UI | API will reject otherwise |
| Same user is a **Test user** on the OAuth app (if Testing) | Consent will fail otherwise |
| Developer token is valid for this MCC | API Center on the manager account |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` is the MCC when using a manager | Required for many manager → client calls |
| `LIVE_CALLS_ENABLED` is exactly `true` | Anything else stays on fixtures / skips live volume |

---

## What success looks like

With env set and `LIVE_CALLS_ENABLED=true`, promoting a discovery hit (or any code path that calls `fetchKeywordVolumes`) should:

- Use source `google_ads` (not `fixture` / `skipped`)
- Fill `serp_keywords.volume` when Keyword Planner has data
- Leave volume as **null** (not zero) when Google has no metrics for that keyword

Null means “not reported,” not “zero searches.”

---

## Common errors

| Error / symptom | Likely fix |
|---|---|
| `invalid_grant` | Refresh token revoked, wrong client secret, or OAuth user mismatch — generate a new refresh token |
| `PERMISSION_DENIED` / customer not found | Give the OAuth user access to the client account; confirm MCC + customer IDs |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Use the correct manager’s token; complete API Center access if still exploratory-only and blocked |
| No `refresh_token` in response | Re-auth with `access_type=offline` and `prompt=consent`, or use Playground with your own credentials |
| Volume always null / source `skipped` | Missing client/secret/refresh, or `LIVE_CALLS_ENABLED` not `true` |
| “App isn’t verified” | Expected in Testing — continue via Advanced; add the user as Test user |

---

## Security rules (team)

1. **Do not commit** client secrets or refresh tokens to the repo.
2. Prefer a **shared secrets vault** (1Password, Doppler, etc.) over chat.
3. Prefer **one service Google user** (or a small set of named test users) rather than personal accounts when possible.
4. If a token is exposed in chat or a ticket, **revoke** it in Google Cloud / Account permissions and mint a new refresh token.
5. Rotate refresh tokens when people leave the team.

---

## Optional: revoke access later

- **Refresh token:** Google Account → Security → Third-party access → remove the app.  
- **OAuth client:** Cloud Console → Credentials → delete the OAuth client.  
- **Developer token:** managed in Google Ads **API Center** (manager account).

---

## Handoff back to eng

When finished, send (via vault, not plain Slack if possible):

1. `GOOGLE_ADS_CLIENT_ID`
2. `GOOGLE_ADS_CLIENT_SECRET`
3. `GOOGLE_ADS_REFRESH_TOKEN`
4. Which **Google account** completed OAuth (email)
5. Confirmation that account can open the intended Ads customer under the MCC

Eng will wire these into deployment env / local `.env` and verify a live volume call.

---

## Reference links

- [Google Cloud Console](https://console.cloud.google.com/)
- [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
- [Google Ads API — authorization](https://developers.google.com/google-ads/api/docs/oauth/overview)
- [Google Ads API Center](https://ads.google.com/aw/apicenter) (developer token; manager account)

---

*Internal setup guide for the rank-and-rent research tool. Volume via Google Ads; SERP discovery/monitoring still uses DataForSEO.*
