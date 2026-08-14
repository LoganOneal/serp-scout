import 'server-only'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  WORLDWIDE,
  assertRequestLocation,
  assessKeyword,
  estimateAffiliateValue,
  expandKeywordSpace,
  localModelsApply,
  normaliseKeyword,
  validateKeywordSpace,
  volumeLocationFor,
  volumeScopeLabel,
  type GeneratedKeyword,
  type KeywordSpace,
  type KeywordVerdict,
  type SpaceEntity,
} from '@rnr/core'
import type { Database } from '../db.js'
import { siteKeywordTargets, sites } from '../schema.js'
import { ensureKeywordVolumes } from '../serp/keyword-volume-cache.js'
import { loadDimensionEntities } from './entities.js'

/**
 * Keyword research for a site we already own.
 *
 * ==================== THE FUNNEL IS INVERTED HERE ====================
 * The local pipeline must buy a SERP to learn anything, because there is no
 * city-level keyword database to buy (endpoints.ts TRAP 3) — so volume is
 * MODELLED from population, afterwards.
 *
 * At national scope the real number is free. `ensureKeywordVolumes` goes to
 * Google Ads, which we already hold credentials for, and there is no paid
 * fallback by policy. So the entire keyword space can be generated, measured and
 * ranked for $0, and only the survivors are ever eligible for a SERP purchase.
 *
 * The expensive stage moves from first to last. Everything in this file is free.
 * =====================================================================
 */

export interface SiteSpaceRow {
  id: number
  domain: string | null
  kind: string
  keywordSpace: KeywordSpace | null
  affiliateOrderValueMicros: bigint | null
  affiliateCommissionRateBps: number | null
  affiliateConversionRateBps: number | null
}

export async function loadSiteSpace(db: Database, siteId: number): Promise<SiteSpaceRow> {
  const [row] = await db
    .select({
      id: sites.id,
      domain: sites.domain,
      kind: sites.kind,
      keywordSpace: sites.keywordSpace,
      affiliateOrderValueMicros: sites.affiliateOrderValueMicros,
      affiliateCommissionRateBps: sites.affiliateCommissionRateBps,
      affiliateConversionRateBps: sites.affiliateConversionRateBps,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)

  if (!row) throw new Error(`No site ${siteId}`)
  return row
}

export interface ExpandSiteResult {
  generated: number
  inserted: number
  alreadyPresent: number
  dropped: number
  notes: string[]
}

/**
 * Generate this site's keyword space and record every row.
 *
 * Free, idempotent, and re-runnable: adding one pattern or one entity and
 * re-running inserts only what is new, because `(site_id, keyword_norm)` is
 * unique and existing rows keep their measurements.
 */
export async function expandSiteSpace(
  db: Database,
  siteId: number,
  opts: { maxKeywords?: number } = {},
): Promise<ExpandSiteResult> {
  const site = await loadSiteSpace(db, siteId)
  const space = requireSpace(site)

  const errors = validateKeywordSpace(space)
  if (errors.length > 0) {
    throw new Error(`Keyword space for site ${siteId} is invalid:\n  - ${errors.join('\n  - ')}`)
  }

  const entities = await loadDimensionEntities(db, space)
  const expansion = expandKeywordSpace(space, entities, opts)

  if (expansion.keywords.length === 0) {
    return {
      generated: 0,
      inserted: 0,
      alreadyPresent: 0,
      dropped: expansion.dropped,
      notes: [
        ...expansion.notes,
        'No keywords were generated. That is a configuration result, not a measurement — ' +
          'no conclusion about demand can be drawn from it.',
      ],
    }
  }

  const norms = expansion.keywords.map((k) => k.keywordNorm)
  const existing = await selectExistingNorms(db, siteId, norms)

  let inserted = 0
  for (const batch of chunk(expansion.keywords, 500)) {
    const fresh = batch.filter((k) => !existing.has(k.keywordNorm))
    if (fresh.length === 0) continue
    await db
      .insert(siteKeywordTargets)
      .values(fresh.map((k) => toInsert(siteId, k)))
      .onConflictDoNothing({
        target: [siteKeywordTargets.siteId, siteKeywordTargets.keywordNorm],
      })
    inserted += fresh.length
  }

  return {
    generated: expansion.keywords.length,
    inserted,
    alreadyPresent: expansion.keywords.length - inserted,
    dropped: expansion.dropped,
    notes: expansion.notes,
  }
}

function toInsert(siteId: number, k: GeneratedKeyword) {
  return {
    siteId,
    keyword: k.keyword,
    keywordNorm: k.keywordNorm,
    seedKey: k.seedKey,
    patternLabel: k.patternLabel,
    entities: k.entities,
    sources: ['grid'],
  }
}

export interface VolumePassResult {
  requested: number
  measured: number
  /** Measured and genuinely zero. NOT the same as unmeasured — see below. */
  measuredZero: number
  unmeasured: number
  scope: string
  /** Always 0n today. Present so a future paid path cannot be silent. */
  costMicros: bigint
}

/**
 * Measure demand for every keyword this site targets. Free.
 *
 * `measuredZero` and `unmeasured` are reported separately and must stay
 * separate on screen. A keyword Google reports at 0 and a keyword Google was
 * never asked about are the same NULL in a naive schema, and merging them is
 * how a screen ends up claiming a space has no demand when it has no data.
 */
export async function runVolumePass(
  db: Database,
  siteId: number,
  opts: { live?: boolean; limit?: number } = {},
): Promise<VolumePassResult> {
  const site = await loadSiteSpace(db, siteId)
  const space = requireSpace(site)

  const location = volumeLocationFor(space)
  if (location === WORLDWIDE) {
    /**
     * Deferred, deliberately, and named rather than silently downgraded.
     *
     * `fetchDfsKeywordVolumes` cannot express "no location" — a null
     * locationCode falls through to DFS_VOLUME_LOCATION_US — and the Google Ads
     * path has never been asked for an empty geo target. Running this as US and
     * labelling it worldwide is precisely the error the label exists to prevent.
     */
    throw new Error(
      `audienceScope 'worldwide' is not implemented: neither provider path can express ` +
        `"no location" today, and returning US figures under a worldwide label is the one ` +
        `outcome that is worse than stopping. See plan-affiliate-directory-sites.md §0.2.`,
    )
  }

  // The invariant, at the boundary, immediately before the request is priced.
  assertRequestLocation(space, location)

  const rows = await db
    .select({ id: siteKeywordTargets.id, keywordNorm: siteKeywordTargets.keywordNorm })
    .from(siteKeywordTargets)
    .where(and(eq(siteKeywordTargets.siteId, siteId), eq(siteKeywordTargets.active, true)))
    .limit(opts.limit ?? 20_000)

  if (rows.length === 0) {
    return { requested: 0, measured: 0, measuredZero: 0, unmeasured: 0, scope: '', costMicros: 0n }
  }

  const scope = volumeScopeLabel(space, location)
  const result = await ensureKeywordVolumes(db, {
    keywords: rows.map((r) => r.keywordNorm),
    locationCode: location,
    live: opts.live ?? false,
  })

  const now = new Date()
  let measured = 0
  let measuredZero = 0
  let unmeasured = 0

  for (const row of rows) {
    const v = result.volumes.get(row.keywordNorm)
    if (!v || v.avgMonthlySearches === null) {
      unmeasured += 1
      continue
    }
    if (v.avgMonthlySearches === 0) measuredZero += 1
    measured += 1

    await db
      .update(siteKeywordTargets)
      .set({
        volume: Math.round(v.avgMonthlySearches),
        volumeScope: scope,
        volumeMeasuredAt: now,
        competitionIndex: v.competitionIndex,
        cpcMicros: v.cpcMicros,
        /**
         * The cost term for paid search, and it was already being bought.
         *
         * `cpcMicros` is deliberately null on the Google Ads path — Google
         * publishes a RANGE and the code refuses to collapse it into an
         * invented CPC. Carrying both ends is what gives the paid-search model
         * a price without fabricating one. See computeBreakEven.
         */
        bidLowMicros: v.lowTopOfPageBidMicros,
        bidHighMicros: v.highTopOfPageBidMicros,
        monthlySeries: v.monthlySearches,
        updatedAt: now,
      })
      .where(eq(siteKeywordTargets.id, row.id))
  }

  return {
    requested: rows.length,
    measured,
    measuredZero,
    unmeasured,
    scope,
    costMicros: result.costMicros,
  }
}

export interface VerdictPassResult {
  scored: number
  byVerdict: Record<KeywordVerdict, number>
  /** Non-null only when every economics input is set on the site. */
  valuedRows: number
  notes: string[]
}

/** What to actually do about each missing signal. Both fixes here are free. */
const FIX_FOR: Record<string, string> = {
  position:
    'Run `rankings <domain>` — Search Console is free and complete, and its silence for a keyword ' +
    'is itself the measurement that turns UNKNOWN into BUILD.',
  volume: 'Run `volume <domain> --live` — Google Ads volume is free and there is no paid fallback.',
  difficulty:
    'No SERP has been bought for these keywords. That is the only paid step in this pipeline, ' +
    'and it should run on the volume survivors, not the whole grid.',
}

const EMPTY_TALLY = (): Record<KeywordVerdict, number> => ({
  DEFEND: 0,
  IMPROVE: 0,
  BUILD: 0,
  IGNORE: 0,
  UNKNOWN: 0,
})

/**
 * Turn measurements into decisions. Free, pure per row, and re-runnable.
 *
 * Nothing here calls assessEmd or assessAcquiredDomain. On a non-local space
 * they fire `not_a_local_query` on every keyword by construction, and that reads
 * as a hard negative verdict rather than "this model does not apply". The guard
 * below makes the omission explicit rather than incidental.
 */
export async function runVerdictPass(
  db: Database,
  siteId: number,
  opts: { buildDifficultyCeiling?: number } = {},
): Promise<VerdictPassResult> {
  const site = await loadSiteSpace(db, siteId)
  const space = requireSpace(site)
  const notes: string[] = []

  const applicability = localModelsApply(space)
  if (!applicability.applies) notes.push(applicability.reason)

  const economics = {
    orderValueMicros: site.affiliateOrderValueMicros,
    commissionRateBps: site.affiliateCommissionRateBps,
    conversionRateBps: site.affiliateConversionRateBps,
  }

  const rows = await db
    .select()
    .from(siteKeywordTargets)
    .where(and(eq(siteKeywordTargets.siteId, siteId), eq(siteKeywordTargets.active, true)))

  const byVerdict = EMPTY_TALLY()
  /**
   * Tallied from the FRESH assessments, not from `rows`.
   *
   * `rows` was selected before this pass wrote anything, so its
   * `verdict_missing` is the PREVIOUS run's answer. Reading it made the
   * diagnostic report "348 waiting on position" immediately after a rankings
   * pull had just measured all 348 — advising the operator to re-run the command
   * they had already run.
   */
  const missingTally = new Map<string, number>()
  let valuedRows = 0
  const now = new Date()

  for (const row of rows) {
    const assessment = assessKeyword(
      {
        position: row.position,
        // The whole reason the column exists: Search Console silence and never
        // having asked Search Console are the same null position.
        positionMeasured: row.positionMeasuredAt !== null,
        volume: row.volume,
        difficulty: row.difficulty,
        volumeFloor: space.volumeFloor,
      },
      opts,
    )

    const value = estimateAffiliateValue({
      volume: row.volume,
      position: row.position,
      economics,
    })
    if (value.monthlyValueMicros !== null) valuedRows += 1

    byVerdict[assessment.verdict] += 1
    for (const m of assessment.missing) missingTally.set(m, (missingTally.get(m) ?? 0) + 1)

    await db
      .update(siteKeywordTargets)
      .set({
        verdict: assessment.verdict,
        verdictReason: assessment.reason,
        verdictMissing: assessment.missing,
        monthlyValueMicros: value.monthlyValueMicros,
        updatedAt: now,
      })
      .where(eq(siteKeywordTargets.id, row.id))
  }

  if (valuedRows === 0 && rows.length > 0) {
    notes.push(
      'No keyword carries a value estimate: order value, commission rate or conversion rate is ' +
        'unset on this site. Rows are ranked on demand and difficulty only.',
    )
  }

  /**
   * ==================== NAME THE MISSING SIGNAL, NOT JUST THE COUNT ====================
   * The first real run returned 350 of 350 UNKNOWN, which is correct — nobody
   * had pulled rankings, so no keyword could be BUILD ("nothing ranks, and we
   * checked") rather than "nobody ever looked".
   *
   * It is also useless on its own. A screen of UNKNOWN with no cause reads as a
   * broken feature, and the actual fix is one free command away. So when a
   * single missing signal dominates, say which one and what to run.
   * ====================================================================================
   */
  if (byVerdict.UNKNOWN > 0) {
    const dominant = [...missingTally.entries()].sort((a, b) => b[1] - a[1])[0]
    if (dominant && dominant[1] >= byVerdict.UNKNOWN * 0.8) {
      notes.push(
        `${byVerdict.UNKNOWN} of ${rows.length} rows are UNKNOWN, and ${dominant[1]} of them are ` +
          `waiting on the same signal: ${dominant[0]}. ${FIX_FOR[dominant[0]] ?? ''}`.trim(),
      )
    }
  }

  return { scored: rows.length, byVerdict, valuedRows, notes }
}

export interface KeywordBoardRow {
  id: number
  keyword: string
  verdict: KeywordVerdict | null
  verdictReason: string | null
  volume: number | null
  volumeScope: string | null
  position: number | null
  positionSource: string | null
  difficulty: number | null
  monthlyValueMicros: bigint | null
  sources: string[]
}

/**
 * The screen. Sorted so the cheapest wins come first.
 *
 * IMPROVE outranks BUILD at equal volume because an existing page needs on-page
 * work rather than a new page, and UNKNOWN sorts LAST rather than being hidden —
 * a bucket you cannot see is a coverage gap you will not fix.
 */
export async function listKeywordBoard(
  db: Database,
  siteId: number,
  opts: { verdicts?: KeywordVerdict[]; limit?: number } = {},
): Promise<KeywordBoardRow[]> {
  const where = [eq(siteKeywordTargets.siteId, siteId), eq(siteKeywordTargets.active, true)]
  if (opts.verdicts?.length) where.push(inArray(siteKeywordTargets.verdict, opts.verdicts))

  const rows = await db
    .select({
      id: siteKeywordTargets.id,
      keyword: siteKeywordTargets.keyword,
      verdict: siteKeywordTargets.verdict,
      verdictReason: siteKeywordTargets.verdictReason,
      volume: siteKeywordTargets.volume,
      volumeScope: siteKeywordTargets.volumeScope,
      position: siteKeywordTargets.position,
      positionSource: siteKeywordTargets.positionSource,
      difficulty: siteKeywordTargets.difficulty,
      monthlyValueMicros: siteKeywordTargets.monthlyValueMicros,
      sources: siteKeywordTargets.sources,
    })
    .from(siteKeywordTargets)
    .where(and(...where))
    .orderBy(
      sql`case ${siteKeywordTargets.verdict}
            when 'IMPROVE' then 0
            when 'BUILD'   then 1
            when 'DEFEND'  then 2
            when 'IGNORE'  then 3
            else 4 end`,
      /**
       * NULLS LAST, explicitly.
       *
       * Postgres defaults DESC to NULLS FIRST, which put every unmeasured row
       * above every measured one — so the first real run showed a screen of em
       * dashes and buried the 83 keywords that actually had figures. An
       * unmeasured row must sort last, which is the same rule the difficulty
       * column already follows.
       */
      sql`${siteKeywordTargets.monthlyValueMicros} desc nulls last`,
      sql`${siteKeywordTargets.volume} desc nulls last`,
    )
    .limit(opts.limit ?? 500)

  return rows.map((r) => ({ ...r, sources: r.sources ?? [] }))
}

/**
 * Record a keyword discovered by something other than the grid.
 *
 * `sources` accumulates rather than overwrites: a keyword found by both the grid
 * and a competitor gap is one row that knows both, and provenance is the first
 * question anybody asks about a surprising result.
 */
export async function recordDiscoveredKeywords(
  db: Database,
  siteId: number,
  keywords: Array<{
    keyword: string
    source: string
    position?: number | null
    positionSource?: string | null
    rankingUrl?: string | null
    impressions?: number | null
    clicks?: number | null
    volume?: number | null
    volumeScope?: string | null
  }>,
): Promise<{ inserted: number; updated: number }> {
  if (keywords.length === 0) return { inserted: 0, updated: 0 }
  const now = new Date()

  const existing = await selectExistingNorms(
    db,
    siteId,
    keywords.map((k) => normaliseKeyword(k.keyword)),
  )

  let inserted = 0
  let updated = 0

  for (const k of keywords) {
    const keywordNorm = normaliseKeyword(k.keyword)
    if (!keywordNorm) continue
    const isNew = !existing.has(keywordNorm)

    const measuredPosition = k.positionSource != null

    await db
      .insert(siteKeywordTargets)
      .values({
        siteId,
        keyword: keywordNorm,
        keywordNorm,
        seedKey: k.source,
        position: k.position ?? null,
        positionSource: k.positionSource ?? null,
        positionMeasuredAt: measuredPosition ? now : null,
        rankingUrl: k.rankingUrl ?? null,
        impressions: k.impressions ?? null,
        clicks: k.clicks ?? null,
        volume: k.volume ?? null,
        volumeScope: k.volumeScope ?? null,
        volumeMeasuredAt: k.volume === undefined ? null : now,
        sources: [k.source],
      })
      .onConflictDoUpdate({
        target: [siteKeywordTargets.siteId, siteKeywordTargets.keywordNorm],
        set: {
          position: k.position ?? sql`${siteKeywordTargets.position}`,
          positionSource: k.positionSource ?? sql`${siteKeywordTargets.positionSource}`,
          positionMeasuredAt: measuredPosition
            ? now
            : sql`${siteKeywordTargets.positionMeasuredAt}`,
          rankingUrl: k.rankingUrl ?? sql`${siteKeywordTargets.rankingUrl}`,
          impressions: k.impressions ?? sql`${siteKeywordTargets.impressions}`,
          clicks: k.clicks ?? sql`${siteKeywordTargets.clicks}`,
          // Accumulate provenance; never replace it.
          sources: sql`(
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements(${siteKeywordTargets.sources} || ${JSON.stringify([k.source])}::jsonb)
          )`,
          updatedAt: now,
        },
      })

    if (isNew) inserted += 1
    else updated += 1
  }

  return { inserted, updated }
}

function requireSpace(site: SiteSpaceRow): KeywordSpace {
  if (!site.keywordSpace) {
    throw new Error(
      `Site ${site.id} (${site.domain ?? 'no domain'}) has no keyword_space. ` +
        `Local cells derive keywords from their niche; an affiliate site must declare one.`,
    )
  }
  return site.keywordSpace
}

async function selectExistingNorms(
  db: Database,
  siteId: number,
  norms: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const batch of chunk(norms, 1000)) {
    const rows = await db
      .select({ keywordNorm: siteKeywordTargets.keywordNorm })
      .from(siteKeywordTargets)
      .where(
        and(eq(siteKeywordTargets.siteId, siteId), inArray(siteKeywordTargets.keywordNorm, batch)),
      )
    for (const r of rows) out.add(r.keywordNorm)
  }
  return out
}

function* chunk<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

export type { SpaceEntity }
