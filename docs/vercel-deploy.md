# Production on Vercel

**Live at https://rank-and-rent-beta.vercel.app** — `logan-oneals-projects-fc63bf16/rank-and-rent`, Pro, root directory `apps/web`, Node 22.

Supabase stays as the database. Retell and Twilio are unchanged except for four URLs.

---

## What had to change, and why

Three things assumed a long-lived server with a disk. Deploying without fixing them produces
a site that *looks* live and silently loses calls.

| Assumption | What breaks on Vercel | Fix |
|---|---|---|
| `pnpm worker` polls forever | No always-on process. Recordings never fetched, lead texts never sent, SERP checks never run — all invisible from the dashboard. | `/api/cron/drain`, once a minute |
| `recordings.ts` used `fs` | The filesystem is per-invocation. The function that writes a recording is not the one that serves it. | Vercel Blob, private |
| `DATABASE_URL` on port 5432 | Supabase's *session* pooler holds a connection per client and caps the project. | Port 6543 + `prepare: false` |

And one blocker that wasn't: **DataForSEO's IP whitelist is optional.** With no IP listed,
credentials alone authorise. One is listed today, which is why the local probe was rejected.

---

## Part 1 — Recordings in a private Blob store

`packages/data/src/voice/recording-store.ts` is a storage seam: local disk with no blob token,
Vercel Blob with one. Both key on the same relative path, so `calls.recording_path` means the
same thing in both and switching hosts is not a data migration.

Objects are written **`access: 'private'`**, so the blob URL is not a capability. Reads go
through `/api/recordings/:callId`, where authorisation already lives. Recordings are strangers
describing their homes and leaving phone numbers; an unguessable URL is not access control.

> The store must be **created** private — `access` cannot be PATCHed afterwards, and
> `vercel blob store add` has no flag for it. Created via
> `POST /v1/storage/stores/blob` with `{access:'private'}`. Store `rnr-recordings-private`.

**No silent fallback to a disk that vanishes.** On a serverless runtime with no blob token,
storage *refuses*. Falling back would "succeed" — the write lands, the row records a path, and
the bytes are gone before anyone plays them. A lost recording that reads as a stored one is the
one outcome not worth being lenient about. There is a test for exactly this.

Keys are validated separately for the object store (`isSafeObjectKey`): the old traversal check
is path arithmetic and does not transfer to a URL.

Both pre-existing recordings were migrated and size-verified
(`pnpm tsx packages/data/src/scripts/migrate-recordings.mts --confirm`).

## Part 2 — The queue drain

The worker's loop body lives in `packages/data/src/worker/drain.ts` and **both** callers use it:
`pnpm worker` in a loop, `/api/cron/drain` until a deadline. Copying it into the route would
have produced two consumers that drift apart — the bug this codebase already paid for once.
Claims are `FOR UPDATE SKIP LOCKED`, so a laptop worker and production cannot collide.

- `apps/web/vercel.json` schedules it `* * * * *`. `maxDuration = 300`.
- Bounded by a **45-second wall-clock budget**, not a job count, so the function always returns
  on its own. A job killed at the platform deadline stays `claimed` until redriven.
- `timedOut: true` is reported, not smoothed over — the only signal that one cron a minute has
  stopped being enough.
- Scans are not drained here; a 40-niche scan belongs in `pnpm scan`.

**Lead texts do not wait for the cron.** `save_lead` awaits the enqueue (the durable part), then
sends via `waitUntil`. `claimLeadDelivery` claims *that lead's* job, so an urgent text cannot
queue behind a recording download. If the fast path dies, the pending row is still there.

**Closed by default.** Vercel sends `Authorization: Bearer $CRON_SECRET`. An unset secret
returns **503**, not open access — this endpoint spends money.

## Part 3 — Database

- `DATABASE_URL` port **6543** (transaction pooler); `DIRECT_DATABASE_URL` port **5432** for
  `pnpm db:push`, which needs session mode for DDL and advisory locks.
- `prepare: false` **unconditionally** — transaction pooling gives each transaction a different
  backend. A flag that differs between environments only fails in production.
- `connect_timeout: 10`. postgres.js waits **forever** by default, and that is what made the
  outage below so hard to find.
- `poolMax` is **4 everywhere, and 1 is refused.** See below.

---

## The outage I caused, and what it taught

Worth reading before touching connection settings.

`poolMax` first shipped returning **1 on Vercel**, reasoning that a serverless instance serves
one request at a time so a pool is waste. That was wrong twice: a single render issues several
queries at once, and instances handle concurrent requests anyway.

The failure was not a pool-timeout error. **Every database-backed page returned zero bytes and
was killed at exactly 300 seconds** — no error, no log, no stack, nothing on screen. Meanwhile
`/api/cron/drain` answered in 300ms, because it happened to query *sequentially*. The app
looked half-alive.

What it cost to find, and what actually worked:

- `outputFileTracingRoot` — didn't help (kept it; it is correct for a pnpm monorepo anyway).
- A cacheless rebuild — didn't help.
- A trivial client component on a fresh route — rendered fine, so client components were
  exonerated.
- A **verbatim copy of `/markets` at `/diag/m4`** hung, while a diagnostic page running the
  *same three queries sequentially* rendered in 1.1s. That was the answer: concurrency, not code.
- The same production build served correctly under `next start` locally, which is why "it
  compiles" was never enough.

So: **pages issue their queries sequentially, each with its own deadline** (`queryOr`). Measured
cost on `/markets` is ~200ms versus ~140ms concurrent. Every query keeps the fallback it already
had, so a stalled query renders as an em dash — *not measured* — rather than as zero calls.
That is this codebase's existing rule applied to availability.

Result: **20/20 concurrent requests to `/markets` succeed**, and 12/12 on the heaviest page.
Before the fix it was 3/12.

Two smaller bugs surfaced in the same session, both in newly-added discovery code:
`column reference "error" is ambiguous` (an `UPDATE … FROM` needing `j.error`) which failed the
**whole drain route**, and a duplicate `listActiveNiches` export that broke the build.

## Part 4 — Environment variables

18 variables, **production only**. A preview deployment carrying these would answer real calls,
send real texts, and spend real money against the same accounts.

Written from `.env` by `packages/data/src/scripts/vercel-env.mts` rather than typed, because the
failure mode of pasting credentials by hand is a silently truncated secret that fails days
later as an unexplained 401. Two values are **derived**: `DATABASE_URL` gets port 6543,
`DIRECT_DATABASE_URL` keeps 5432. `RECORDINGS_DIR` is deliberately **not** pushed — its absence
is what selects the Blob backend. The script refuses if `LIVE_CALLS_ENABLED` is not the exact
string `true`.

## Part 5 — The four URLs

`agent-apply` moves `webhook_url`, an *agent* field. Three others are not:

| What | Where it lives | Command |
|---|---|---|
| Agent `webhook_url` | agent | `pnpm voice:agent-apply` |
| **`save_lead` tool URL** | **conversation flow `tools[0].url`** | **`pnpm voice:retarget-tools --confirm`** |
| Number `inbound_webhook_url` | Retell phone number | `pnpm sites:provision <domain> --number <e164> --confirm` |
| Twilio disaster recovery | trunk | `pnpm twilio:setup-trunk --confirm` |

Two gaps had to be closed to make this repeatable:

**The `save_lead` URL was unreachable by any script.** It lives on the flow, and the client
refuses flow writes so hand-built dialogue can never be clobbered by a guess. But a tool `url`
is not dialogue — it is the address of an endpoint this repo owns, the same class as
`webhook_url`. Left pointing at a dead tunnel, the agent collects a name and a problem, says
someone will call back, POSTs into the void, and **no lead row is created**. Silent, and the
most expensive failure in the system. `updateConversationFlowTools` sends **only** `tools`;
nodes are never transmitted. Verified by re-reading: 17 nodes before, 17 after.

**`sites:provision` was not idempotent.** `/import-phone-number` is a 400 for a DID Retell
already holds, so it aborted before setting the webhook. It now imports if new and patches the
webhook if not, so it is safe to re-run after any host move.

The ngrok tunnel can now be shut down. **That is the real win**: the failover URL no longer
lives on a laptop, so a Retell outage reaches your cell instead of a dead line.

## Part 6 — DataForSEO

Clear the IP whitelist (dashboard → API access) so scans and SERP checks work from Vercel.

> **The account is currently suspended** (`40201`: *"unusual activity … we've temporarily
> paused access"*). Scans and SERP monitoring stay dead until support restores it. The voice
> CRM does not touch DataForSEO, so calls, leads, recordings and alerts work regardless.

---

## Verified in production

- [x] All pages 200: `/` 0.9s, `/markets` 0.4s, cell page 1.1s, `/agent` 0.3s, `/research/reddit` 0.2s
- [x] **20/20** concurrent `/markets`; **12/12** on the cell page
- [x] Drain guarded: no token → 401, unset secret → 503, correct token → 200 with a JSON summary
- [x] **Cron fires unattended** — pending voice jobs went 2 → 0 between 19:11:21 and 19:11:49 with no manual call
- [x] Webhooks reach production: `pnpm voice:simulate` → 6/6 requests 200, call row and lead created
- [x] **The simulated lead was suppressed, not texted** (`lead 6 suppressed (simulated call)`)
- [x] Recordings from the private Blob store: 200 `audio/wav` at full size, and **206 with `Content-Range`** for `bytes=0-1023` — seeking works
- [x] All four URLs confirmed by reading them back from Retell and Twilio
- [x] `pnpm test` 384 pass, `pnpm e2e` 32 pass, `pnpm typecheck` clean

Still outstanding — neither is code:

1. **Flow version 3 is not published.** Publish it in the Retell dashboard. Until then an
   inbound call may be served by an older version that still has the old URLs.
2. **A real call.** Dial +1 (520) 369-4399 from a cell. Nothing before this proves the audio
   path; Retell cannot validate SIP configuration without one.

## Read this before sharing the URL

**The dashboard is publicly reachable.** Vercel's default protection redirects to SSO, which
Retell and Twilio cannot complete, so production had to be exempted
(`ssoProtection: prod_deployment_urls_and_all_previews` — the alias is open, per-deployment URLs
and all previews stay protected).

That means anyone with the URL can read call transcripts, lead names, phone numbers and
addresses. On ngrok the URL was random and short-lived; this one is stable. The webhook routes
each verify their own caller (Retell HMAC, `CRON_SECRET`), but the **pages do not authenticate**.

The clean fix is middleware requiring a password on page routes while exempting `/api/*`. It
needs a decision from you (shared password? per-user?), so it is not built.

## Local development output is isolated

`pnpm worker` still works and is the same code. Recordings still go to `.recordings/`.
`next dev` writes to `.next-dev`, while production builds and `next start` keep using `.next`.
That makes an ordinary `pnpm build` safe while the dev server is running. You can still use
`NEXT_DIST_DIR=.next-build pnpm build` when you want a third, disposable build directory.

`PUBLIC_BASE_URL` in `.env` now points at production, because that is where the webhooks point.
To test locally against a tunnel again, change it and re-run the four commands in Part 5.
