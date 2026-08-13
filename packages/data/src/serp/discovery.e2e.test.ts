import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { PRICE } from '@rnr/core'
import { createDb, type Database } from '../db.js'
import {
  discoveryHits,
  discoveryJobs,
  discoveryRuns,
  localities,
  niches,
  researchGeoImports,
  researchGeos,
  researchKeywordImports,
  researchKeywords,
} from '../schema.js'
import { NICHE_SEEDS } from '../seed/niches.js'
import { createProviders, type Providers } from '../providers/index.js'
import { resetSchema } from '../test-support/schema-sql.js'
import { eq } from 'drizzle-orm'
import {
  claimNextDiscoveryJob,
  enqueueDiscoveryRun,
  reconcileDiscoverySpend,
  runDiscoveryJob,
} from './run-discovery.js'
import {
  previewOpportunityDeepDive,
  REDDIT_LOCAL_SERVICE_MATCH_SET,
} from './opportunity-screen.js'
import { reserveDiscoverySpend } from './discovery-budget.js'
import { normaliseStateCode } from './resolve-discovery-geos.js'

/**
 * Discovery e2e under fixtures: enqueue → drain all jobs → spend === 0.
 */

const DB_URL = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL']
const SCHEMA = 'rnr_discovery_e2e'

let db: Database
let raw: postgres.Sql

describe.skipIf(!DB_URL)('discovery e2e ($0, fixtures)', () => {
  beforeAll(async () => {
    const admin = postgres(DB_URL!, { max: 1, onnotice: () => {} })
    await resetSchema(admin, SCHEMA)
    await admin.end({ timeout: 5 })

    const created = createDb(DB_URL!, { searchPath: SCHEMA })
    db = created.db
    raw = created.sql

    await db.insert(localities).values([
      {
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
        // Fixture mode allows non-dataforseo sources.
        locationSource: 'google_geotargets',
        unmatchedReason: null,
        searchText: 'kenosha wi wisconsin',
      },
      {
        slug: 'tucson-az',
        kind: 'city',
        name: 'Tucson',
        rawName: 'Tucson city',
        stateCode: 'AZ',
        stateName: 'Arizona',
        fips: '0477000',
        countyFips: '04019',
        countyName: 'Pima County',
        population: 542_629,
        lat: 32.2226,
        lon: -110.9747,
        landAreaSqMi: 241.0,
        providerLocationCode: 1013509,
        providerLocationName: 'Tucson,Arizona,United States',
        resolutionMethod: 'city:name-state',
        locationSource: 'dataforseo',
        unmatchedReason: null,
        searchText: 'tucson az arizona',
      },
    ])

    await db.insert(niches).values(
      NICHE_SEEDS.slice(0, 5).map((n) => ({
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

  it('normaliseStateCode accepts codes and names', () => {
    expect(normaliseStateCode('wi')).toBe('WI')
    expect(normaliseStateCode('Wisconsin')).toBe('WI')
    expect(normaliseStateCode('???')).toBeNull()
  })

  it('defines 35 unique canonical niches for the local-service match set', () => {
    expect(REDDIT_LOCAL_SERVICE_MATCH_SET).toHaveLength(35)
    expect(new Set(REDDIT_LOCAL_SERVICE_MATCH_SET).size).toBe(35)
  })

  it('returns fixed keyword IDs in the review draft without provider discovery', async () => {
    const [keywordImport] = await db
      .insert(researchKeywordImports)
      .values({ sourceFilename: 'e2e-fixed-set', sourceKind: 'test' })
      .returning()
    const [geoImport] = await db
      .insert(researchGeoImports)
      .values({ sourceFilename: 'e2e-geos', sourceKind: 'test' })
      .returning()
    const [keyword] = await db
      .insert(researchKeywords)
      .values({
        importId: keywordImport!.id,
        keyword: 'plumber',
        keywordNorm: 'plumber',
        seedKey: 'plumber',
        variant: 'primary',
      })
      .returning()
    const [geo] = await db
      .insert(researchGeos)
      .values({
        importId: geoImport!.id,
        market: 'Kenosha',
        state: 'Wisconsin',
        stateAbbr: 'WI',
        selectedRank: 1,
        dataforseoLocationCode: 1028029,
        dataforseoLocationName: 'Kenosha,Wisconsin,United States',
        locationSource: 'csv_preresolved',
        resolveStatus: 'resolved',
      })
      .returning()

    const preview = await previewOpportunityDeepDive(db, {
      keywordIds: [keyword!.id],
      geoIds: [geo!.id],
      devices: ['desktop'],
      useQueuedSerp: true,
    })

    expect(preview.discovery).toEqual([
      {
        nicheSlug: 'plumber',
        source: 'fixed_match_set',
        selected: [{ keyword: 'plumber', volume: null }],
        rejected: 0,
        note: 'operator-approved fixed match set',
      },
    ])
    expect(preview.jobCount).toBe(1)

    await db.delete(researchKeywordImports).where(eq(researchKeywordImports.id, keywordImport!.id))
    await db.delete(researchGeoImports).where(eq(researchGeoImports.id, geoImport!.id))
  })

  it('enqueues catalog jobs as one canonical niche plus city per geo', async () => {
    const { run, preview } = await enqueueDiscoveryRun(db, {
      niches: [
        {
          label: 'AC repair',
          keywordPrimary: 'ac repair',
          keywordNearMe: 'ac repair near me',
        },
      ],
      geos: [
        { name: 'Kenosha', state: 'WI', population: 99_500 },
        { name: 'Tucson', state: 'AZ', population: 542_629 },
      ],
      budgetCapCents: 500,
      source: 'catalog',
      // Catalog source must ignore both legacy expansion flags.
      includeNearMe: true,
      includeGeoExplicit: true,
      devices: ['desktop'],
      usedFixtures: true,
    })

    expect(preview.jobCount).toBe(2)
    expect(preview.includeNearMe).toBe(false)
    const jobs = await db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.runId, run.id))
    expect(jobs.map((j) => j.keyword).sort()).toEqual([
      'ac repair kenosha',
      'ac repair tucson',
    ])
    expect(jobs.every((j) => j.keywordVariant === 'primary')).toBe(true)

    await db.delete(discoveryRuns).where(eq(discoveryRuns.id, run.id))
  })

  it('does not reserve a queued SERP again when collecting its paid result', async () => {
    const seed = NICHE_SEEDS[0]!
    const { run } = await enqueueDiscoveryRun(db, {
      niches: [
        {
          label: seed.label,
          slug: seed.slug,
          keywordPrimary: seed.keywordNoun,
          keywordNearMe: `${seed.keywordNoun} near me`,
        },
      ],
      geos: [{ name: 'Kenosha', state: 'WI', population: 99_500 }],
      budgetCapCents: 500,
      source: 'catalog',
      devices: ['desktop'],
      usedFixtures: false,
    })
    const [job] = await db
      .select()
      .from(discoveryJobs)
      .where(eq(discoveryJobs.runId, run.id))
    expect(job).toBeDefined()

    // task_post already charged and recorded the queued price.
    expect(
      await reserveDiscoverySpend(db, {
        runId: run.id,
        costMicros: PRICE.serpOrganicTask,
        endpoint: 'serp/discovery',
        note: 'queued task posted',
        jobId: job!.id,
      }),
    ).toBe('ok')

    const fixtures = createProviders()
    const liveProviders = Object.create(fixtures) as Providers
    Object.defineProperty(liveProviders, 'live', { value: true })

    const outcome = await runDiscoveryJob(db, {
      job: { ...job!, status: 'claimed', costMicros: PRICE.serpOrganicTask },
      providers: liveProviders,
      preFetched: { rawItems: [], paidMicros: PRICE.serpOrganicTask },
    })
    expect(outcome.status).toBe('done')

    const recon = await reconcileDiscoverySpend(db, run.id)
    expect(recon.runTotal).toBe(PRICE.serpOrganicTask)
    expect(recon.ledgerTotal).toBe(PRICE.serpOrganicTask)
    expect(recon.matches).toBe(true)

    await db.delete(discoveryRuns).where(eq(discoveryRuns.id, run.id))
  })

  it('enqueues jobs only for resolved geos and drains at $0', async () => {
    const providers = createProviders()
    expect(providers.live).toBe(false)

    const seed = NICHE_SEEDS[0]!
    const { run, preview } = await enqueueDiscoveryRun(db, {
      niches: [
        {
          label: seed.label,
          slug: seed.slug,
          keywordPrimary: seed.keywordNoun,
          keywordNearMe: `${seed.keywordNoun} near me`,
          nearMeSynthesised: false,
        },
      ],
      geos: [
        { name: 'Kenosha', state: 'WI', population: 99500 },
        { name: 'Tucson', state: 'AZ', population: 542629 },
        { name: 'Nowhereville', state: 'ZZ' }, // unresolved
      ],
      budgetCapCents: 500,
      commentabilityMode: 'on_promote',
      label: 'e2e discovery',
      usedFixtures: true,
    })

    expect(preview.geoResolved).toBe(2)
    expect(preview.geoUnresolved).toBe(1)
    // 1 niche × 2 keywords × 2 geos
    expect(preview.jobCount).toBe(4)
    expect(run.jobCount).toBe(4)
    expect(run.usedFixtures).toBe(true)

    let processed = 0
    for (;;) {
      const job = await claimNextDiscoveryJob(db, 'e2e-worker')
      if (!job) break
      const outcome = await runDiscoveryJob(db, { job, providers })
      expect(['done', 'failed', 'skipped']).toContain(outcome.status)
      processed += 1
      expect(processed).toBeLessThanOrEqual(10)
    }
    expect(processed).toBe(4)

    const [finished] = await db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.id, run.id))
    expect(finished?.status).toBe('done')
    expect(finished?.phase).toBe('complete')
    expect(finished?.spendMicros).toBe(0n)
    expect(finished?.jobsDone).toBe(4)

    const recon = await reconcileDiscoverySpend(db, run.id)
    expect(recon.runTotal).toBe(0n)
    expect(recon.ledgerTotal).toBe(0n)
    expect(recon.matches).toBe(true)
    // One ledger line per SERP job (zero-cost fixtures).
    expect(recon.lineItems).toBe(4)

    const jobs = await db.select().from(discoveryJobs).where(eq(discoveryJobs.runId, run.id))
    expect(jobs.every((j) => j.status === 'done')).toBe(true)
    expect(jobs.every((j) => j.rawItems !== null)).toBe(true)

    // Hits may be zero for some seeds; fixture rates are probabilistic per keyword.
    // At least the path wrote measured jobs.
    const hits = await db.select().from(discoveryHits).where(eq(discoveryHits.runId, run.id))
    expect(Array.isArray(hits)).toBe(true)
  })
})
