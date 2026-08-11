# Plan: Trigger.dev as discovery job runner

| Field | Value |
|---|---|
| **Date** | 2026-08-06 |
| **Status** | Planned (after cheap Vercel timeout fixes) |
| **Goal** | Near-zero permanent job failure; long reliable niche×market deep dives |

---

## 1. Why Trigger.dev (after cheap fixes)

We already have a durable queue (`discovery_jobs` + skip-locked claims). Cheap fixes make **cron** viable again. Trigger.dev becomes valuable when:

- Runs are **multi-minute / multi-hour** (desktop+mobile × many niches)
- We want **automatic retries, concurrency, and a UI** without operating `pnpm worker`
- Fat jobs (organic + volume + maps) should not fight **45–180s serverless budgets**

Trigger.dev does **not** replace the domain model — it replaces (or supplements) the **consumer**.

---

## 2. Architecture (recommended)

```
┌────────────────────┐     enqueue      ┌──────────────────┐
│ Next.js (Research) │ ───────────────► │ discovery_runs   │
│ opportunityDeepDive│                  │ discovery_jobs   │
└────────────────────┘                  └────────┬─────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    │                            │                            │
                    ▼                            ▼                            ▼
           ┌────────────────┐          ┌─────────────────┐          ┌────────────────┐
           │ Vercel cron    │          │ Trigger.dev     │          │ pnpm worker    │
           │ /api/cron/drain│          │ task: drain one │          │ (local/dev)    │
           │ light + voice  │          │ or process run  │          │ optional        │
           └────────────────┘          └─────────────────┘          └────────────────┘
```

**Principle:** One queue, multiple consumers still safe via `FOR UPDATE SKIP LOCKED`.

### Preferred integration shape

**Option A — Trigger as primary discovery consumer (recommended)**

1. After `enqueueCatalogBulkResearch`, call Trigger:  
   `discoveryDrainRun.trigger({ runId })` or `discoveryProcessJob.trigger({ jobId })`.
2. Trigger task:
   - Claims next job(s) for that run (or any pending discovery job)
   - Calls existing `runDiscoveryJob` / `drainDiscoveryOnce`
   - On retriable error: throw → Trigger retries with backoff
   - On permanent account fail: mark run failed (existing logic)
3. Vercel cron keeps **voice + SERP monitor + redrive stuck claims** (and can still drain discovery as a safety net at burst=1).

**Option B — Fan-out one Trigger task per job**

1. Enqueue creates N Postgres jobs **and** N Trigger tasks with `jobId`.
2. Task loads job by id, processes if still `pending`, idempotent.
3. Higher Trigger fan-out cost; simpler mental model.

**Choose A first** (one long-running drain task per run with internal loop until empty or time box 10–15 min).

---

## 3. Implementation steps

### Phase 0 — Prerequisites (cheap fixes — done or in flight)

- [x] Retriable abort / 40101 / network
- [x] Refund spend on requeue
- [x] Volume/maps non-fatal
- [x] Vercel burst=1, higher drain budget
- [ ] Deploy and verify run #17 recovery

### Phase 1 — Scaffold Trigger.dev

1. `npx trigger.dev@latest init` in monorepo (or `apps/web`).
2. Env: `TRIGGER_SECRET_KEY` on Vercel + Trigger dashboard.
3. Project structure:

```
apps/web/src/trigger/
  client.ts
  discovery-drain.ts   // process pending discovery jobs
  discovery-run.ts     // optional: drain one runId until complete
```

4. Local: `npx trigger.dev@latest dev` alongside `pnpm dev` / `pnpm worker`.

### Phase 2 — Wire enqueue → Trigger

In `startOpportunityDeepDive` / `opportunityDeepDiveAction` after run created:

```ts
await discoveryDrainRun.trigger(
  { runId: run.id },
  { idempotencyKey: `discovery-run-${run.id}` },
)
```

Also schedule a **recurring** Trigger schedule every 1–2 min as a safety net for pending jobs (if enqueue hook misses).

### Phase 3 — Task body (reuse existing code)

```ts
// pseudo
export const discoveryDrainRun = task({
  id: "discovery-drain-run",
  retry: { maxAttempts: 10, factor: 1.5, minTimeoutInMs: 5_000 },
  maxDuration: 900, // 15 min — product choice
  run: async ({ runId }) => {
    const db = db()
    const workerId = `trigger:${task.id}`
    // Loop until no jobs or soft budget 12 min
    while (Date.now() - start < 12 * 60_000) {
      const did = await drainDiscoveryOnce(db, { workerId, log })
      if (!did) break
    }
    return { runId, drained: true }
  },
})
```

**Important:** Do **not** reimplement SERP logic in Trigger — only the runner loop.

### Phase 4 — Idempotency & double consumers

- Claims remain skip-locked → Trigger + cron can coexist.
- Prefer **pause discovery in cron** when `TRIGGER_SECRET_KEY` is set, leave voice/serp:
  ```ts
  if (process.env.TRIGGER_SECRET_KEY) skip discovery in drainQueues
  ```
- Redrive stuck claims still runs on cron.

### Phase 5 — Observability

- Map Trigger run URL in Research UI next to discovery run id (optional).
- Log `jobId`, DFS phase, retry count (already in `[retry:n]` error field).

### Phase 6 — Cutover checklist

- [ ] Staging: 10 niches × 2 markets × both devices, 0 permanent aborts  
- [ ] Prod: same  
- [ ] Kill switch: unset `TRIGGER_SECRET_KEY` → fall back to cron-only  
- [ ] Cost: Trigger compute + DFS (unchanged product costs)

---

## 4. What Trigger.dev does **not** solve

| Issue | Still need |
|-------|------------|
| DFS account pause | Fail closed (existing AccountIssueError) |
| Invalid location_code | Geo resolution quality |
| Double spend on bad retries | Refund on requeue (cheap fix) |
| Product “too many keywords” | Screen defaults / cost caps |

---

## 5. Alternatives (if Trigger is deferred)

| Option | When |
|--------|------|
| Always-on `pnpm worker` on Fly/Railway | Cheapest long runner; no new vendor |
| Inngest | Similar to Trigger; evaluate pricing |
| Cron-only after cheap fixes | OK for moderate volume |

---

## 6. Success metrics

- Permanent fail rate on retriable errors **&lt; 0.5%** of jobs  
- Median time-to-drain for 160-job run **&lt; 45 min** on Trigger (vs hours on 1 job/min cron)  
- Zero “stuck running with 0 done” UI states  

---

## 7. Effort estimate

| Phase | Effort |
|-------|--------|
| Phase 1 scaffold | 0.5–1 day |
| Phase 2–3 wire + task | 1 day |
| Phase 4–5 polish | 0.5 day |
| Phase 6 soak | 1–2 days calendar |

**Total ~2–3 eng days** after cheap fixes are green.

---

## 8. Decision

1. **Ship cheap fixes first** (this PR).  
2. Validate run recovery on prod.  
3. Then implement Phase 1–3 Trigger integration as the primary discovery consumer, keep cron as safety net for voice + stuck redrive.
