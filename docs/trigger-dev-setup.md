# Trigger.dev setup (this repo)

| Field | Value |
|---|---|
| **Project** | RankAndRent Patform |
| **Project ref** | `proj_eiqklproulshogglvxmb` |
| **App path** | `apps/web` |
| **Config** | `apps/web/trigger.config.ts` |
| **Tasks** | `apps/web/src/trigger/` |
| **Dashboard** | https://cloud.trigger.dev/projects/v3/proj_eiqklproulshogglvxmb |

## What was initialized

```bash
# Already run:
pnpm dlx trigger.dev@latest init --yes --project-ref proj_eiqklproulshogglvxmb --no-browser
```

- `@trigger.dev/sdk@4.5.9` + `@trigger.dev/build@4.5.9` + the `trigger.dev@4.5.9` CLI in `@rnr/web`
  - The CLI's binary is **`trigger`**, not `trigger.dev` — scripts run `trigger dev` / `trigger deploy`.
  - `import-in-the-middle` + `require-in-the-middle` are explicit devDeps. pnpm's isolated
    store does not hoist them, and OpenTelemetry's instrumentation `require()`s them at
    runtime: without them the build dies with `Cannot find module 'import-in-the-middle'`.
- `trigger.config.ts` with project ref + `server-only` build shim (so `@rnr/data` loads in the worker)
- Tasks:
  - `hello-world` — smoke test
  - `discovery-drain` — long consumer for `discovery_jobs`
  - `discovery-drain-schedule` — every 5 min safety net (manage in dashboard)

Deep dive enqueue (`opportunityDeepDiveAction`) triggers `discovery-drain` when `TRIGGER_SECRET_KEY` is set.

## Local development

```bash
# Terminal 1 — Next app
pnpm dev

# Terminal 2 — Trigger worker (from apps/web or root)
pnpm trigger:dev
# or: pnpm --filter @rnr/web exec trigger.dev dev
```

The Trigger CLI looks for `.env` beside `trigger.config.ts` (i.e. `apps/web`), but this
monorepo keeps one at the **root**. `trigger.config.ts` dotenv-loads `../../.env` for the
same reason `next.config.ts` does — without it dev runs boot with no `DATABASE_URL`.
This covers **dev only**; deployed runs read the dashboard's env vars.

## Environment variables

### Local (`apps/web` / monorepo root `.env`)

> **One environment, on purpose.** The **PROD** key goes everywhere — local `.env`
> and Vercel. A trigger from any host therefore runs on the Trigger cloud
> deployment, never on a laptop. Using the DEV key locally splits the two: the
> dev environment is served by whoever is running `trigger dev`, so with the cron
> gate active a production deep dive would drain only while that machine is awake
> and stall silently when it sleeps. `pnpm trigger:dev` is for iterating on task
> code, not for draining real work.

| Variable | Purpose |
|----------|---------|
| `TRIGGER_SECRET_KEY` | Server SDK auth — the **PROD** key (Trigger dashboard → API keys) |
| `DATABASE_URL` | Same Postgres as the app |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Live SERP |
| `LIVE_CALLS_ENABLED=true` | Real DFS (else fixtures) |

### Vercel (Production)

Add **`TRIGGER_SECRET_KEY`** — the same **PROD** key as local (see the note above).

Setting it is what makes `/api/cron/drain` stop claiming discovery, so it must
not be set until the Trigger deployment can actually run the jobs: set the
Trigger dashboard's own env vars first, deploy the tasks, deploy this app, then
set this key last. Out of order, discovery stalls — cron steps back while
Trigger cannot yet pick up.

### Trigger.dev dashboard (worker runtime)

Sync the same secrets the worker needs to call DFS + DB:

- `DATABASE_URL` (or `DIRECT_DATABASE_URL` if you prefer)
- `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`
- `LIVE_CALLS_ENABLED=true`
- Any other vars `createProviders` / `db()` need

Without these, Trigger tasks fail even if Vercel is fine.

## Deploy tasks to Trigger cloud

```bash
pnpm trigger:deploy
# from apps/web: pnpm exec trigger.dev deploy
```

Then enable **`discovery-drain-schedule`** in the dashboard if you want the 5‑minute safety net.

## Verify

1. `pnpm trigger:dev`
2. Trigger `hello-world` from dashboard or:

```ts
import { helloWorldTask } from "@/trigger/example"
await helloWorldTask.trigger({ name: "logan" })
```

3. Smallest real job — 1 keyword × 1 geo × desktop, ~$0.002 of DataForSEO:

```bash
pnpm trigger:smoke --dry   # prove the selection is 1 job, queue nothing
pnpm trigger:smoke         # enqueue 1 job, trigger discovery-drain, poll the result
```

   Expect `output: {"processed":1,...}`. **`processed: 0` means Vercel cron won the
   race** (see below), not that Trigger is broken — re-run to try again.

4. Start a small deep dive on Research with `TRIGGER_SECRET_KEY` set — run detail should mention Trigger.dev draining.

## Only one consumer claims discovery

`vercel.json` runs `/api/cron/drain` **every minute** on the same database, and
`pnpm worker` polls it too. Both now step back from discovery *claims* when
`TRIGGER_SECRET_KEY` is set (`discoveryHandledByTrigger()`); the stuck-job
redrive still runs in both, since that is what rescues a Trigger run that dies
mid-job. Unset the key and cron picks discovery back up on the next tick — that
is the kill switch.

Skip-locked claims mean a second consumer could never corrupt anything, so this
gate is about *ownership*, not safety. It matters because two consumers on
different code versions is how a run gets billed one keyword-volume request per
keyword ($0.09 each) instead of one per market: whichever one is running older
code spends invisibly. A Trigger run reporting `processed: 0` is the symptom.

## Notes

- **Cron still runs** `/api/cron/drain` for voice, SERP monitor, and stuck-job redrive.
- Worker uses the same `drainDiscoveryOnce` / retriable abort logic as Vercel cron.
- See also: `docs/plan-trigger-dev-discovery.md` for full architecture.
