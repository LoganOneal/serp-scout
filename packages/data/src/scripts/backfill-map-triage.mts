import 'dotenv/config'
import { desc, eq, sql } from 'drizzle-orm'
import { NON_ACQUIRABLE_HOSTS, isInfrastructureHost, registrableDomain } from '@rnr/core'
import { db } from '../db.js'
import { domainCandidates, domainEnrichRuns, discoverySerpMetrics } from '../schema.js'
import { triageDomain } from '../domains/enrich-pipeline.js'

/**
 * Triage every map-pack domain that has never been checked.
 *
 * ==================== WHY THIS IS THE BEST FREE MOVE LEFT ====================
 * The orphaned-GBP join found 24 candidates -- businesses still in a map pack
 * whose website is dead. That count is limited by TRIAGE COVERAGE, not by the
 * phenomenon: only 264 of 2,671 distinct map-pack domains had ever been
 * triaged, so those 24 came out of 10% of the corpus.
 *
 * Every one of those 2,671 domains was already paid for. DNS, HTTP, RDAP and
 * Wayback cost nothing at any volume. So the remaining ~2,400 are free to
 * check, and on the measured rate should yield roughly ten times as many
 * orphaned profiles.
 * ===========================================================================
 *
 * COST: $0. No DataForSEO calls. The paid spam/rank pass runs separately, and
 * only on the domains that survive, which is the whole point of doing this
 * first.
 *
 * RESUMABLE. Candidates are inserted in batches as they complete and skipped on
 * a re-run. A wall-clock kill cost this project a full run once already.
 */

/**
 * ==================== WHY CONCURRENCY IS 8 AND NOT 12 ====================
 * The first full run died after 50 domains with:
 *
 *   getaddrinfo ENOTFOUND aws-0-ca-central-1.pooler.supabase.com
 *
 * The DATABASE host failed to resolve -- on a machine that had been resolving
 * it fine for hours. `dnsTriage` issues several DNS queries per domain, so at
 * concurrency 12 this script is a DNS flood, and it starved the one lookup it
 * could not afford to lose.
 *
 * The workload's own side effect broke its persistence layer. Lower concurrency
 * plus a retry on every write is the fix; the retry matters more than the
 * number, because a transient resolver failure must never end a two-hour run.
 * ========================================================================
 */
const CONCURRENCY = Number(process.env['BACKFILL_CONCURRENCY'] ?? 8)
const LIMIT = Number(process.env['BACKFILL_LIMIT'] ?? 5000)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Retry a database write through transient DNS/connection failures. */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const wait = 2_000 * 2 ** attempt
      console.log(`  [retry] ${what} failed (${(e as Error).message.slice(0, 60)}) — ${wait}ms`)
      await sleep(wait)
    }
  }
  throw lastErr
}

const database = db()

// ---------------------------------------------------------------------------
// 1. The work list: mapped domains with no candidate row anywhere
// ---------------------------------------------------------------------------

const rows = await database.execute<{ domain: string; location_code: number }>(sql`
  with map_entries as (
    select distinct
           lower(trim(both '"' from d::text)) as domain,
           m.location_code
      from ${discoverySerpMetrics} m,
           jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select e.domain, min(e.location_code)::int as location_code
    from map_entries e
   where not exists (
     select 1 from ${domainCandidates} c where c.domain = e.domain
   )
   group by e.domain
   limit ${LIMIT}
`)

const all = [...rows]
console.log(`Map-pack domains with no triage row: ${all.length}`)

/**
 * Drop what can never be an acquisition target BEFORE spending 15 seconds of
 * network wait on it. Triage is free but it is not instant, and a national
 * brand costs the same wall clock as a real candidate.
 */
const work: Array<{ domain: string; locationCode: number }> = []
let skipped = 0
for (const r of all) {
  const n = registrableDomain(r.domain)
  if (!n || n.nonAcquirable || NON_ACQUIRABLE_HOSTS.has(n.domain) || isInfrastructureHost(n.domain)) {
    skipped += 1
    continue
  }
  work.push({ domain: n.domain, locationCode: r.location_code })
}
console.log(`  skipped as platform/infrastructure: ${skipped}`)
console.log(`  to triage: ${work.length}`)
console.log(`  concurrency: ${CONCURRENCY}   ·   estimated ${Math.round((work.length * 3.5) / 60)} min\n`)

if (work.length === 0) {
  console.log('Nothing to do.')
  await database.$client.end?.()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. A run row, so the results live where every other candidate lives
// ---------------------------------------------------------------------------

const locationCode = work[0]!.locationCode

/**
 * Resume into the existing backfill run rather than orphaning it.
 *
 * The work list already excludes any domain with a candidate row, so a re-run
 * naturally picks up where the last one died -- but creating a fresh run row
 * each time would scatter one logical sweep across several, and leave the
 * crashed one stuck at `running` forever.
 */
const existing = await database
  .select({ id: domainEnrichRuns.id })
  .from(domainEnrichRuns)
  .where(eq(domainEnrichRuns.niche, '(map-pack backfill)'))
  .orderBy(desc(domainEnrichRuns.id))
  .limit(1)

let runId: number
if (existing[0]) {
  runId = existing[0].id
  const [already] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(domainCandidates)
    .where(eq(domainCandidates.runId, runId))
  console.log(`Resuming backfill run #${runId} (${already?.n ?? 0} rows already stored)\n`)
  await database
    .update(domainEnrichRuns)
    .set({ status: 'running', error: null })
    .where(eq(domainEnrichRuns.id, runId))
} else {
  const [run] = await database
    .insert(domainEnrichRuns)
    .values({
      niche: '(map-pack backfill)',
      locality: '(all stored map packs)',
      locationCode,
      status: 'running',
      maxResults: work.length,
      // Nothing is purchased here. Recording otherwise would put a phantom
      // charge in a column the cost screens read.
      costMicros: 0n,
      paidOptions: {},
    })
    .returning({ id: domainEnrichRuns.id })
  runId = run!.id
  console.log(`Enrich run #${runId} created for the backfill\n`)
}

// ---------------------------------------------------------------------------
// 3. Triage, inserting in batches so a kill cannot discard the work
// ---------------------------------------------------------------------------

const started = Date.now()
let cursor = 0
let done = 0
let inserted = 0
let failed = 0
const byStatus = new Map<string, number>()

type Row = typeof domainCandidates.$inferInsert
let batch: Row[] = []

async function flush(): Promise<void> {
  if (batch.length === 0) return
  const rows = batch
  batch = []
  // Retried: a transient resolver failure here killed a two-hour run once.
  await withRetry(`insert ${rows.length} rows`, () =>
    database.insert(domainCandidates).values(rows).onConflictDoNothing(),
  )
  inserted += rows.length
}

const worker = async (): Promise<void> => {
  for (;;) {
    const item = work[cursor++]
    if (!item) return
    try {
      const c = await triageDomain(item.domain, [
        { name: item.domain, website: `https://${item.domain}` },
      ])
      byStatus.set(
        c.classification.status,
        (byStatus.get(c.classification.status) ?? 0) + 1,
      )
      batch.push({
        runId,
        domain: c.domain,
        status: c.classification.status,
        reason: c.classification.reason,
        score: c.score.total,
        scoreComponents: c.score.components,
        scoreMissing: c.score.missing,
        businesses: c.businesses,
        businessCount: c.businessCount,
        sources: ['map_pack'],
        registrar: c.rdap?.registrar ?? null,
        registeredAt: c.rdap?.createdAt ?? null,
        expiresAt: c.rdap?.expiresAt ?? null,
        ageYears: c.classification.ageYears,
        daysToExpiry: c.classification.daysToExpiry,
        rdapStatuses: c.rdap?.statuses ?? null,
        httpOutcome: c.http?.outcome ?? null,
        httpStatus: c.http?.httpStatus ?? null,
        redirectedTo: c.http?.redirectedTo ?? null,
        parkingNameserver: c.dns?.parkingNameserver ?? null,
        firstSnapshotAt: c.wayback?.firstSnapshotAt ?? null,
        lastContentSnapshotAt: c.wayback?.lastContentSnapshotAt ?? null,
        totalSnapshots: c.wayback?.ok ? c.wayback.totalSnapshots : null,
        yearsOfContent: c.wayback?.ok ? c.wayback.yearsOfContinuousContent : null,
      })
    } catch {
      // One unreachable domain must not abort a 2,400-domain backfill.
      failed += 1
    }

    done += 1
    if (batch.length >= 50) await flush()
    if (done % 100 === 0) {
      const rate = done / ((Date.now() - started) / 1000)
      const eta = Math.round((work.length - done) / rate / 60)
      console.log(
        `  ${done}/${work.length} · inserted ${inserted} · failed ${failed} · ` +
          `${rate.toFixed(1)}/s · ETA ${eta}min`,
      )
    }
  }
}

/**
 * A worker that throws must not take the run with it. Each one already catches
 * per-domain failures; this covers the flush, which talks to the database.
 */
const outcomes = await Promise.allSettled(
  Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker),
)
const crashed = outcomes.filter((o) => o.status === 'rejected')
for (const c of crashed) {
  console.log(`  [worker died] ${String((c as PromiseRejectedResult).reason).slice(0, 120)}`)
}

try {
  await flush()
} catch (e) {
  console.log(`  FINAL FLUSH FAILED — ${(e as Error).message.slice(0, 120)}`)
}

await withRetry('finalise run', () =>
  database
    .update(domainEnrichRuns)
    .set({
      // Honest status: if a worker died, this sweep did not cover its work list.
      status: crashed.length > 0 ? 'failed' : 'complete',
      error: crashed.length > 0 ? `${crashed.length} worker(s) died; re-run to resume` : null,
      uniqueDomains: work.length,
      businessesFound: work.length,
      completedAt: new Date(),
    })
    .where(eq(domainEnrichRuns.id, runId)),
)

console.log(`\n${'='.repeat(70)}`)
console.log(`BACKFILL COMPLETE — run #${runId}`)
console.log(`${'='.repeat(70)}`)
console.log(`  triaged ${done} · inserted ${inserted} · failed ${failed}`)
console.log(`  elapsed ${Math.round((Date.now() - started) / 60000)} min`)
console.log(`\nSTATUS MIX:`)
for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(16)} ${String(n).padStart(5)}  ${((n / done) * 100).toFixed(1)}%`)
}
console.log(`\nCost: $0.00 — no provider calls were made.`)
console.log(`Next: re-run probe-orphaned-gbp.mts to see the new orphan count.`)

await database.$client.end?.()
process.exit(0)
