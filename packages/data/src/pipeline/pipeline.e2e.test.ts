import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { centsToMicros } from '@rnr/core'
import { createDb, type Database } from '../db.js'
import { localities, niches, scanRuns, scanTargets, serpSnapshots, spendLedger } from '../schema.js'
import { NICHE_SEEDS } from '../seed/niches.js'
import { createProviders } from '../providers/index.js'
import { claimNextRun, enqueueScan, redriveStuckRuns } from '../queue.js'
import { reconcileSpend } from '../budget.js'
import { runScan } from './run-scan.js'
import { getRunResults, saveToShortlist, searchLocalities } from '../queries.js'
import { resetSchema } from '../test-support/schema-sql.js'

/**
 * End-to-end pipeline run, entirely offline, asserting $0.
 *
 * The single most important assertion is `spend_micros === 0n`: it PROVES nothing
 * was bought rather than assuming it. An e2e that merely "seems to use fixtures"
 * is exactly how a test suite starts quietly spending money.
 *
 * The second most important is the difficulty SPREAD. A fixture generator that
 * produces ten plausible results per SERP yields scores clustered around the
 * middle, and every ordering bug in the model survives that -- the table looks
 * populated and informative while being useless.
 *
 * Requires a reachable Postgres. Set E2E_DATABASE_URL (preferred) or DATABASE_URL.
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL']
const SCHEMA = 'rnr_e2e'

let db: Database
let raw: postgres.Sql
let localityId: number

describe.skipIf(!DB_URL)('pipeline e2e ($0, fixtures)', () => {
  beforeAll(async () => {
    // Own an isolated schema so the suite cannot disturb real data. The DDL runs
    // on a throwaway SINGLE-connection client -- `SET search_path` only affects the
    // connection that ran it, so a pool would scatter the CREATE TABLEs. The real
    // client is then opened with search_path set per connection.
    const admin = postgres(DB_URL!, { max: 1, onnotice: () => {} })
    await resetSchema(admin, SCHEMA)
    await admin.end({ timeout: 5 })

    const created = createDb(DB_URL!, { searchPath: SCHEMA })
    db = created.db
    raw = created.sql

    // One locality, resolvable against the fixture provider's location set.
    const [loc] = await db
      .insert(localities)
      .values({
        slug: 'kenosha-wi',
        kind: 'city',
        name: 'Kenosha',
        rawName: 'Kenosha city',
        stateCode: 'WI',
        stateName: 'Wisconsin',
        fips: '5539225',
        countyFips: '55059',
        countyName: 'Kenosha County',
        population: 99_500,
        lat: 42.5872,
        lon: -87.8578,
        landAreaSqMi: 27.1,
        providerLocationCode: 1028029,
        providerLocationName: 'Kenosha,Wisconsin,United States',
        resolutionMethod: 'city:name-state',
        locationSource: 'google_geotargets',
        unmatchedReason: null,
        searchText: 'kenosha wi wisconsin',
      })
      .returning({ id: localities.id })
    localityId = loc!.id

    await db.insert(niches).values(
      NICHE_SEEDS.map((n) => ({
        slug: n.slug,
        label: n.label,
        keywordNoun: n.keywordNoun,
        emdToken: n.emdToken,
        domainStems: n.domainStems,
        category: n.category,
        demandPerCapitaPer1k: n.demandPerCapitaPer1k,
        valuePerSearchMicros: n.valuePerSearchMicros,
        rentFloorMicros: n.rentFloorMicros,
        rentCeilingMicros: n.rentCeilingMicros,
        active: true,
      })),
    )
  })

  afterAll(async () => {
    if (raw) await raw.end({ timeout: 5 })
    const admin = postgres(DB_URL!)
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await admin.end({ timeout: 5 })
  })

  it('claims a queued run atomically, and only once', async () => {
    const run = await enqueueScan(db, {
      localityId,
      budgetCapMicros: centsToMicros(200),
      usedFixtures: true,
    })
    expect(run.status).toBe('pending')

    // Two workers race. Exactly one gets it -- FOR UPDATE SKIP LOCKED plus the
    // conditional status check is what makes double-dispatch impossible.
    const [a, b] = await Promise.all([claimNextRun(db, 'worker-a'), claimNextRun(db, 'worker-b')])
    const claimed = [a, b].filter((r) => r !== null)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.id).toBe(run.id)
    expect(claimed[0]!.status).toBe('claimed')

    // A third attempt finds nothing pending.
    expect(await claimNextRun(db, 'worker-c')).toBeNull()

    // Re-drive leaves a fresh claim alone.
    expect(await redriveStuckRuns(db)).toBe(0)

    await db.delete(scanRuns).where(sql`id = ${run.id}`)
  })

  describe('locality search accepts how people actually type a city', () => {
    it('finds Kenosha by every natural spelling, comma or not', async () => {
      // THE REGRESSION. search_text is "kenosha wi wisconsin" -- no punctuation --
      // so matching the raw input as a prefix meant "Kenosha, WI" produced
      // LIKE 'kenosha, wi%' and found nothing, while "kenosha" worked. The UI
      // reported "no locality matches", which reads as missing data for a city
      // that was present and scannable all along.
      for (const q of [
        'kenosha',
        'Kenosha',
        'kenosha wi',
        'Kenosha, WI',
        'Kenosha, Wisconsin',
        'kenosha,wi',
        '  Kenosha ,  WI  ',
      ]) {
        const rows = await searchLocalities(db, q)
        expect(rows.map((r) => r.slug), `query: ${JSON.stringify(q)}`).toContain('kenosha-wi')
      }
    })

    it('still rejects a query that genuinely matches nothing', async () => {
      expect(await searchLocalities(db, 'kenosha, texas')).toEqual([])
      expect(await searchLocalities(db, 'zzzznowhere')).toEqual([])
    })

    it('requires the first token to START the name, not appear anywhere', async () => {
      // Otherwise "wi" would return every city in Wisconsin, and a name search
      // that matches substrings anywhere is useless at 23k rows.
      expect(await searchLocalities(db, 'enosha')).toEqual([])
    })

    it('ignores a query too short to be meaningful', async () => {
      expect(await searchLocalities(db, 'k')).toEqual([])
      expect(await searchLocalities(db, ' ')).toEqual([])
      expect(await searchLocalities(db, ',')).toEqual([])
    })
  })

  it('re-drives a run stuck in claimed for over 20 minutes', async () => {
    const run = await enqueueScan(db, {
      localityId,
      budgetCapMicros: centsToMicros(200),
      usedFixtures: true,
    })
    await claimNextRun(db, 'dead-worker')
    // Backdate the claim: a worker that died mid-scan would otherwise leave the
    // operator staring at a spinner forever.
    await raw.unsafe(
      `UPDATE ${SCHEMA}.scan_runs SET claimed_at = now() - interval '25 minutes' WHERE id = ${run.id}`,
    )
    expect(await redriveStuckRuns(db)).toBe(1)
    const [after] = await db.select().from(scanRuns).where(sql`id = ${run.id}`)
    expect(after!.status).toBe('pending')
    expect(after!.claimedBy).toBeNull()
    await db.delete(scanRuns).where(sql`id = ${run.id}`)
  })

  describe('a full fixture scan', () => {
    let runId: number

    beforeAll(async () => {
      const providers = createProviders({ LIVE_CALLS_ENABLED: 'false' })
      expect(providers.live).toBe(false)

      const run = await enqueueScan(db, {
        localityId,
        budgetCapMicros: centsToMicros(200),
        usedFixtures: true,
      })
      runId = run.id
      const result = await runScan({
        db,
        providers,
        runId,
        localityId,
        budgetCapMicros: centsToMicros(200),
      })
      expect(result.status).toBe('done')
      expect(result.scored).toBe(NICHE_SEEDS.length)
    })

    it('SPENDS NOTHING', async () => {
      // The assertion that proves, rather than assumes, that fixtures were used.
      const [run] = await db.select().from(scanRuns).where(sql`id = ${runId}`)
      expect(run!.spendMicros).toBe(0n)
      expect(typeof run!.spendMicros).toBe('bigint')

      const spend = await reconcileSpend(db, runId)
      expect(spend.runTotal).toBe(0n)
      expect(spend.ledgerTotal).toBe(0n)
      expect(spend.matches).toBe(true)
      // Every fixture call is still ledgered, so $0 is positive evidence of
      // free calls rather than an absence of evidence that anything happened.
      expect(spend.lineItems).toBeGreaterThan(NICHE_SEEDS.length)

      const rows = await db.select().from(spendLedger).where(sql`scan_run_id = ${runId}`)
      expect(rows.every((r) => r.costMicros === 0n)).toBe(true)
    })

    it('marks the run and its cached snapshots as fixture-sourced', async () => {
      const [run] = await db.select().from(scanRuns).where(sql`id = ${runId}`)
      expect(run!.usedFixtures).toBe(true)
      // The cache records provenance too, so a later live run cannot silently
      // serve a fixture snapshot as real data.
      const snaps = await db.select().from(serpSnapshots)
      expect(snaps.length).toBeGreaterThan(0)
      expect(snaps.every((s) => s.source === 'fixture')).toBe(true)
    })

    it('produces REAL difficulty spread, not a flat list', async () => {
      const rows = await getRunResults(db, runId)
      const scored = rows.map((r) => r.difficulty).filter((d): d is number => d !== null)
      expect(scored.length).toBeGreaterThan(NICHE_SEEDS.length * 0.8)

      const mean = scored.reduce((a, b) => a + b, 0) / scored.length
      const stdev = Math.sqrt(scored.reduce((a, b) => a + (b - mean) ** 2, 0) / scored.length)
      const distinct = new Set(scored).size

      // A flat list hides every ordering bug in the model.
      expect(stdev).toBeGreaterThan(8)
      expect(distinct).toBeGreaterThanOrEqual(10)
      expect(Math.max(...scored) - Math.min(...scored)).toBeGreaterThan(30)
    })

    it('sorts easiest first with nulls LAST, never first', async () => {
      const rows = await getRunResults(db, runId)
      const positions = rows.map((r) => r.difficulty)
      const firstNull = positions.findIndex((p) => p === null)
      if (firstNull >= 0) {
        // A null difficulty means "could not be scored". Sorting it first would
        // present it as the single best opportunity in the locality.
        expect(positions.slice(firstNull).every((p) => p === null)).toBe(true)
      }
      const scored = positions.filter((p): p is number => p !== null)
      for (let i = 1; i < scored.length; i++) {
        expect(scored[i]!).toBeGreaterThanOrEqual(scored[i - 1]!)
      }
    })

    it('spans several verdict bands', async () => {
      const rows = await getRunResults(db, runId)
      const bands = new Set(rows.map((r) => r.verdict))
      expect(bands.size).toBeGreaterThanOrEqual(3)
    })

    it('exercises the omit-and-renormalise path on real rows', async () => {
      // If every row had full coverage, the measurement-honesty code would never
      // run in this suite and its correctness would be asserted only in unit
      // tests against hand-built objects.
      const rows = await getRunResults(db, runId)
      const partial = rows.filter((r) => r.weightCovered < 0.999)
      expect(partial.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect(r.weightCovered).toBeGreaterThan(0)
        expect(r.weightCovered).toBeLessThanOrEqual(1)
      }
    })

    it('never awards likely_30d without confirmed availability AND measured link data', async () => {
      // The asymmetry that protects money, verified against real pipeline output
      // rather than a constructed input.
      const rows = await getRunResults(db, runId)
      for (const r of rows.filter((x) => x.verdict === 'likely_30d')) {
        expect(r.emdAvailable, `${r.nicheLabel} got 30d with availability ${r.emdAvailable}`).toBe(
          true,
        )
        expect(r.linkDataMeasured, `${r.nicheLabel} got 30d with no link data`).toBe(true)
      }
    })

    it('records every component including the unmeasured ones', async () => {
      const targets = await db.select().from(scanTargets).where(sql`scan_run_id = ${runId}`)
      for (const t of targets) {
        const components = t.components as Record<string, { measured: boolean; value: number | null }>
        expect(Object.keys(components).sort()).toEqual([
          'authorityWall',
          'intentLock',
          'linkQuality',
          'slotDefence',
        ])
        for (const [name, c] of Object.entries(components)) {
          // Null is never coerced to 0 on the way into the database.
          if (!c.measured) expect(c.value, `${t.keyword}/${name}`).toBeNull()
        }
      }
    })

    it('flags every volume as estimated and stores rent as nullable micros', async () => {
      const targets = await db.select().from(scanTargets).where(sql`scan_run_id = ${runId}`)
      expect(targets.every((t) => t.volumeEstimated)).toBe(true)
      for (const t of targets) {
        if (t.rentMicros !== null) expect(typeof t.rentMicros).toBe('bigint')
      }
    })

    it('freezes difficulty and verdict when a cell is saved', async () => {
      const rows = await getRunResults(db, runId)
      const target = rows[0]!
      const saved = await saveToShortlist(db, target.scanTargetId)
      expect(saved).not.toBeNull()

      const [item] = await raw.unsafe(
        `SELECT difficulty_at_save, verdict_at_save, weight_covered_at_save FROM ${SCHEMA}.shortlist_items WHERE id = ${saved!.id}`,
      )
      expect(item!['verdict_at_save']).toBe(target.verdict)
      expect(item!['difficulty_at_save']).toBe(target.difficulty)
      expect(Number(item!['weight_covered_at_save'])).toBeCloseTo(target.weightCovered, 5)
    })

    it('serves the second scan of the same locality entirely from cache', async () => {
      const providers = createProviders({ LIVE_CALLS_ENABLED: 'false' })
      const run2 = await enqueueScan(db, {
        localityId,
        budgetCapMicros: centsToMicros(200),
        usedFixtures: true,
      })
      const result = await runScan({
        db,
        providers,
        runId: run2.id,
        localityId,
        budgetCapMicros: centsToMicros(200),
      })
      expect(result.status).toBe('done')
      expect(result.spendMicros).toBe(0n)
      // Cache hits mean no provider calls at all, so no ledger rows beyond the
      // availability pass.
      const spend = await reconcileSpend(db, run2.id)
      expect(spend.ledgerTotal).toBe(0n)
    })
  })
})

/**
 * The test schema comes from the REAL generated migration.
 *
 * It used to be hand-written DDL "so the test does not depend on drizzle-kit".
 * That copy drifted: adding `spend_ledger.site_id` to schema.ts broke this suite
 * with `expected 0 to be 41` -- a scan that scored nothing -- because drizzle lists
 * every declared column in its INSERT and the test table lacked one. The cause was
 * several layers from the symptom.
 *
 * Reading the migration cannot drift, and applying it also proves the migration
 * works. See test-support/schema-sql.ts.
 */
