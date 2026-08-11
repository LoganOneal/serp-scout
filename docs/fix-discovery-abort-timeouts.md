# Plan: Fix discovery job failures on Vercel (“This operation was aborted”)

| Field | Value |
|---|---|
| **Date** | 2026-08-06 |
| **Status** | Cheap fixes implemented 2026-08-06; Trigger plan in `plan-trigger-dev-discovery.md` |
| **Prod evidence** | Run #17 (niche×market · 10 niches · desktop+mobile) |

---

## 1. What we saw (not auth/pause)

### Drain / DB (live)

Manual hit to `/api/cron/drain` on prod:

```json
{
  "ok": true,
  "discovery": 2,
  "timedOut": true,
  "elapsedMs": 51366,
  "log": [
    "Discovery #753 … failed … This operation was aborted",
    "Discovery #755 … failed … This operation was aborted"
  ]
}
```

### Run #17 snapshot

| Status | Count |
|--------|------:|
| done | ~6–8 |
| failed | ~18+ (climbing) |
| pending | ~135 |
| claimed | 1 |

**100% of failures** share the same error:

```text
This operation was aborted
```

That string is the browser/Node **`AbortError`** from `AbortController.abort()` — **not** DataForSEO 401 auth.

### What it is *not*

| Hypothesis | Evidence against |
|------------|------------------|
| Bad DataForSEO credentials | Drain returns 200; some jobs **done** with real hits/volume |
| Account paused (40201) | Fail message would be account preflight / 402xx, not abort |
| Budget exceeded | Fail would be `budget_exceeded` |

---

## 2. Root cause

Each discovery job on a **board deep dive** now does **multiple sequential HTTP calls** on Vercel:

```
1. Organic SERP live advanced     ← can take 5–25s
2. Keywords Data search_volume    ← extra call (same DFS account)
3. Maps SERP (once per niche×city)← extra call when not yet cached
```

On Vercel:

| Knob | Current value | Effect |
|------|---------------|--------|
| `DataForSeoClient` timeout | **25s** (`VERCEL` set) | Slow DFS call → abort → job **failed** |
| Cron drain budget | **45s** | Only 1–2 fat jobs per minute |
| `maxDiscoveryBurst` | **8** | Tries many jobs; later ones start with no time left |
| `maxDuration` | 300s | Budget is far under platform max |

So:

1. Organic or volume call hits **25s** → `This operation was aborted`.
2. Job is marked **`failed` permanently** (spend already reserved ~$0.002).
3. Cron reports `timedOut: true` after ~45–50s with few successes.
4. Desktop+mobile **doubles** job count → more aborts, longer wall clock.

Auth works; **timeout + permanent fail + over-ambitious burst** is the bug.

---

## 3. Fix plan (ordered)

### PR1 — Stop permanent fail on abort (P0, small)

**Problem:** Transient timeout becomes a dead job forever.

**Change:**
- In `runDiscoveryJob` catch / `drainDiscoveryOnce`: if error is `AbortError` or message matches `/aborted/i`:
  - Prefer **requeue** `status = pending` (clear claim) **or** mark failed with `error` prefix `retriable:` and redrive once.
- Cap retries (e.g. max 2 aborts → then real fail) to avoid infinite loops.

**Success:** Abort no longer burns a keyword×market forever on first blip.

---

### PR2 — Fit work into Vercel cron budget (P0)

**Problem:** One job can exceed 25s or two jobs exceed 45s.

**Changes:**

| Change | Detail |
|--------|--------|
| **Drain budget** | Raise `BUDGET_MS` from `45_000` → **`120_000`–`240_000`** (still under `maxDuration` 300s). |
| **Burst** | On Vercel, `maxDiscoveryBurst = 1` (or 2 if job is thin). Local worker can stay 8. |
| **Per-job wall clock** | Before starting Maps/volume, skip if remaining drain budget &lt; 15s. |
| **DFS timeout** | Keep ~20–25s for a *single* call, but don’t stack three full 25s windows without checking budget. |

**Success:** Drain completes 1 solid job/tick more often than 2 aborted jobs.

---

### PR3 — Thin the hot path (P0/P1)

**Problem:** Decision metrics added sequential Maps + volume onto every organic job.

**Changes:**

1. **Organic first, always**  
   Finish organic + layout + Reddit; mark job done path for SERP even if enrichments lag.

2. **Volume**  
   - Keep shared cache by `(runId, keyword, locationCode)`.  
   - Optional: batch volume in a post-pass (one Keywords Data call per location with many keywords) instead of per job.  
   - On volume timeout: store `volumeSource=skipped`, **don’t fail** the SERP job.

3. **Maps once per niche×city** (already intended)  
   - Ensure first job doesn’t also do organic+maps under 25s pressure.  
   - Prefer: **separate lightweight maps job** or run maps only when organic finished and remaining budget &gt; 20s.  
   - On maps timeout: leave `maps_entry_count` null; **don’t fail** organic job.

4. **Default devices**  
   - Keep “both” as option, but Screen default could be **desktop only** until timeouts are fixed (or document 2× cost + time).

**Success:** Abort on maps/volume never kills organic success.

---

### PR4 — Observability (P1)

- Log per phase timing: `organic_ms`, `volume_ms`, `maps_ms`.  
- Surface last error class in run UI: `abort` vs `40101` vs `auth`.  
- Drain response already returns log lines — keep them in Vercel logs with `[drain] phase=…`.

---

### PR5 — Optional recovery for run #17 (ops)

- Script: `UPDATE discovery_jobs SET status='pending', error=null, claimed_at=null WHERE run_id=17 AND status='failed' AND error ILIKE '%aborted%'`.  
- Or delete run #17 and re-run after PR1–3 deploy.

---

## 4. Implementation order

```
PR1 retriable abort     ─┬─► deploy (stops bleed)
PR2 budget + burst=1    ─┘
PR3 volume/maps non-fatal + budget gates  ─► deploy
PR5 requeue run #17 (or user re-run)
PR4 timing logs
```

Do **not** raise DFS timeout to 120s on Vercel without raising drain budget — that recreates stuck `claimed` jobs.

---

## 5. Acceptance criteria

- [ ] Manual `/api/cron/drain` for a live pending job: **done** more often than **aborted** for organic-only path.  
- [ ] Abort on volume/maps does **not** set job `failed` if organic already succeeded.  
- [ ] Abort on organic **requeues** at least once.  
- [ ] Run of 10 niches × 2 markets × desktop finishes with **&lt;5% permanent fails** under normal DFS latency.  
- [ ] UI still shows total **organic** spend; optional note that volume/maps are extra.

---

## 6. Cost / product tradeoffs

| Choice | Tradeoff |
|--------|----------|
| Burst=1 | Slower wall clock (~1 job/min if budget stays 45s; better with 120s budget) |
| Desktop default | Half the jobs; mobile optional |
| Maps deferred | Decision “Maps n” fills later or only on first keyword of cell |
| Volume batch | Fewer Keywords Data requests, better rate-limit behavior (~12 live/min) |

---

## 7. Related code

- `apps/web/src/app/api/cron/drain/route.ts` — `BUDGET_MS`  
- `packages/data/src/worker/drain.ts` — `maxDiscoveryBurst`  
- `packages/data/src/providers/index.ts` — `timeoutMs` 25s on Vercel  
- `packages/data/src/providers/dataforseo/client.ts` — AbortController  
- `packages/data/src/serp/run-discovery.ts` — organic + volume + maps stack  

---

## 8. Immediate user guidance (until fix deploys)

1. Prefer **desktop only** for large niche×market runs.  
2. Smaller batches (e.g. top 5 niches × 10 markets).  
3. Failures that say **aborted** are retries-worthy after fix; not credential problems.  
4. Run #17 can keep running (pending jobs still process) but will keep aborting some until PR1–3 ship.
