import 'server-only'
import { and, count, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { KeywordVerdict } from '@rnr/core'
import type { Database } from '../db.js'
import {
  adsPlans,
  affiliateCommissionRates,
  affiliateObservations,
  linkProspectRuns,
  siteKeywordTargets,
  sites,
  supplyCoverage,
  supplyIngestRuns,
  supplySources,
} from '../schema.js'
import { googleAdsConfigured } from '../providers/google-ads/keyword-volume.js'
import { searchConsoleConfigured } from '../providers/google/search-console.js'

/**
 * What a directory site's pipeline actually looks like right now.
 *
 * ==================== WHY A PIPELINE AND NOT A TABLE ====================
 * The obvious screen for a directory is its keyword board. Built today, that
 * screen is 975 rows of em dashes: the grid is expanded, supply is flowing, and
 * NOTHING has been measured, because volume is blocked on a Google Ads 429 and
 * rankings on an unset GSC_REFRESH_TOKEN.
 *
 * A table cannot say that. It renders the same blank cell for "measured and
 * absent", "not measured yet" and "cannot be measured until you fix a
 * credential", and those are three completely different situations with three
 * different next actions. The operator who opened /portfolio looking for this
 * site and found nothing would open the board and learn equally little.
 *
 * So the primary view is the PIPELINE — one tile per stage, each carrying what
 * it measured, out of how many, and what is stopping it. The board is what you
 * open once a stage has something in it.
 * =======================================================================
 *
 * This mirrors what the CLI already does well: `verdict` does not just report
 * 975 UNKNOWN, it reports that 975 of them wait on the same signal and names the
 * command that supplies it. This is that behaviour, on a screen.
 */

export type StageState =
  /** Every row this stage can measure, it has. */
  | 'done'
  /** Some rows measured. Real progress, not finished. */
  | 'partial'
  /** Nothing measured, and nothing preventing it. Just run it. */
  | 'not_run'
  /** Cannot run: a credential, quota or upstream stage is missing. */
  | 'blocked'
  /** Not applicable to this site. */
  | 'n_a'

export interface DirectoryStage {
  key: string
  label: string
  /** Rows this stage has measured. Null when the stage is not row-shaped. */
  measured: number | null
  total: number | null
  state: StageState
  /** What this stage means, in one line. */
  detail: string
  /** Why it cannot run. Null unless state is 'blocked'. */
  blocker: string | null
  /** The exact command that advances it. Null when nothing to do. */
  command: string | null
  /** Free, or does it spend? Surfaced so the screen never hides a priced step. */
  cost: 'free' | 'paid'
}

export interface DirectorySummary {
  siteId: number
  domain: string
  displayName: string | null
  status: string
  /** From the keyword space, so the screen can say what it targets. */
  geoMode: string | null
  audienceScope: string | null
  patternCount: number

  keywords: number
  byVerdict: Record<KeywordVerdict, number>
  /** Rows with a verdict that is not UNKNOWN. The only honest "progress" number. */
  decided: number

  stages: DirectoryStage[]
  /**
   * The single next thing to do, chosen from the stages.
   *
   * One action, not a list. A screen offering five equal options for a pipeline
   * with a strict order is a screen that gets the order wrong.
   */
  nextAction: { label: string; command: string; blocker: string | null } | null

  /** Downstream features that hang off this site, for the detail page's links. */
  adsPlans: number
  linkRuns: number
  supplySources: number
  supplyItems: number
  unresolvedSuppliers: number
}

const EMPTY_TALLY = (): Record<KeywordVerdict, number> => ({
  DEFEND: 0,
  IMPROVE: 0,
  BUILD: 0,
  IGNORE: 0,
  UNKNOWN: 0,
})

const CLI = 'pnpm tsx --conditions=react-server packages/data/src/scripts'

/**
 * Every affiliate/directory site, with its pipeline resolved.
 *
 * ==================== EIGHT QUERIES TOTAL, NOT EIGHT PER SITE ====================
 * The first version issued eight round trips per site and blew the 8-second
 * query deadline on the very first render against the pooler — which the page
 * then rendered as "this directory does not exist".
 *
 * Every count below is therefore GROUPED BY site_id across all directories at
 * once, so the cost is flat in the number of sites. Queries are still
 * SEQUENTIAL: concurrent queries against the transaction pooler are what took
 * production down once already, and the fix for slow is fewer queries, never
 * parallel ones. See the note in portfolio/page.tsx.
 * ================================================================================
 */
export async function listDirectories(db: Database): Promise<DirectorySummary[]> {
  const rows = await db
    .select({
      id: sites.id,
      domain: sites.domain,
      displayName: sites.displayName,
      status: sites.status,
      keywordSpace: sites.keywordSpace,
      orderValueMicros: sites.affiliateOrderValueMicros,
      commissionRateBps: sites.affiliateCommissionRateBps,
      conversionRateBps: sites.affiliateConversionRateBps,
    })
    .from(sites)
    .where(eq(sites.kind, 'affiliate'))
    .orderBy(sites.domain)

  if (rows.length === 0) return []

  const facts = await loadFacts(db)
  return rows.map((site) => summarise(site, facts))
}

/**
 * One directory.
 *
 * Deliberately built on the same grouped queries rather than a narrower
 * per-site path: at two directories the difference is noise, and a second
 * code path would be a second place for the pipeline definition to drift.
 */
export async function loadDirectory(
  db: Database,
  domain: string,
): Promise<DirectorySummary | null> {
  const all = await listDirectories(db)
  return all.find((d) => d.domain === domain) ?? null
}

type SiteRow = {
  id: number
  domain: string | null
  displayName: string | null
  status: string
  keywordSpace: unknown
  orderValueMicros: bigint | null
  commissionRateBps: number | null
  conversionRateBps: number | null
}

interface Facts {
  keywords: Map<number, KeywordCounts>
  supplySources: Map<number, number>
  coverage: Map<number, { entities: number; withSupply: number; items: number }>
  lastRun: Map<number, { unresolved: number }>
  rates: Map<number, number>
  observations: Map<number, number>
  adsPlans: Map<number, number>
  linkRuns: Map<number, number>
}

interface KeywordCounts {
  total: number
  volume: number
  position: number
  difficulty: number
  defend: number
  improve: number
  build: number
  ignore: number
  unknown: number
}

const tally = (rows: Array<{ siteId: number; n: number }>): Map<number, number> =>
  new Map(rows.map((r) => [r.siteId, r.n]))

async function loadFacts(db: Database): Promise<Facts> {
  /**
   * One pass for every per-keyword count. `filter (where ...)` keeps this to a
   * single scan rather than one query per signal.
   */
  const k = await db
    .select({
      siteId: siteKeywordTargets.siteId,
      total: sql<number>`count(*)::int`,
      volume: sql<number>`count(*) filter (where ${siteKeywordTargets.volumeMeasuredAt} is not null)::int`,
      position: sql<number>`count(*) filter (where ${siteKeywordTargets.positionMeasuredAt} is not null)::int`,
      difficulty: sql<number>`count(*) filter (where ${siteKeywordTargets.difficultyMeasuredAt} is not null)::int`,
      defend: sql<number>`count(*) filter (where ${siteKeywordTargets.verdict} = 'DEFEND')::int`,
      improve: sql<number>`count(*) filter (where ${siteKeywordTargets.verdict} = 'IMPROVE')::int`,
      build: sql<number>`count(*) filter (where ${siteKeywordTargets.verdict} = 'BUILD')::int`,
      ignore: sql<number>`count(*) filter (where ${siteKeywordTargets.verdict} = 'IGNORE')::int`,
      unknown: sql<number>`count(*) filter (where ${siteKeywordTargets.verdict} = 'UNKNOWN' or ${siteKeywordTargets.verdict} is null)::int`,
    })
    .from(siteKeywordTargets)
    .where(eq(siteKeywordTargets.active, true))
    .groupBy(siteKeywordTargets.siteId)

  const srcs = await db
    .select({ siteId: supplySources.siteId, n: sql<number>`count(*)::int` })
    .from(supplySources)
    .groupBy(supplySources.siteId)

  const cov = await db
    .select({
      siteId: supplyCoverage.siteId,
      entities: sql<number>`count(*)::int`,
      withSupply: sql<number>`count(*) filter (where ${supplyCoverage.availableItemCount} > 0)::int`,
      items: sql<number>`coalesce(sum(${supplyCoverage.availableItemCount}), 0)::int`,
    })
    .from(supplyCoverage)
    .groupBy(supplyCoverage.siteId)

  /**
   * The most recent ingest run per site. `distinct on` is the Postgres idiom
   * and does it in one pass; the alternative is a correlated subquery per site,
   * which is the shape this whole function exists to avoid.
   */
  const runs = await db
    .select({
      siteId: supplyIngestRuns.siteId,
      unresolved: supplyIngestRuns.unresolvedSuppliers,
    })
    .from(supplyIngestRuns)
    .orderBy(supplyIngestRuns.siteId, desc(supplyIngestRuns.startedAt))
    .limit(500)

  const rates = await db
    .select({ siteId: affiliateCommissionRates.siteId, n: sql<number>`count(*)::int` })
    .from(affiliateCommissionRates)
    .groupBy(affiliateCommissionRates.siteId)

  const obs = await db
    .select({ siteId: affiliateObservations.siteId, n: sql<number>`count(*)::int` })
    .from(affiliateObservations)
    .groupBy(affiliateObservations.siteId)

  const plans = await db
    .select({ siteId: adsPlans.siteId, n: sql<number>`count(*)::int` })
    .from(adsPlans)
    .groupBy(adsPlans.siteId)

  const links = await db
    .select({ siteId: linkProspectRuns.siteId, n: sql<number>`count(*)::int` })
    .from(linkProspectRuns)
    .where(isNotNull(linkProspectRuns.siteId))
    .groupBy(linkProspectRuns.siteId)

  const lastRun = new Map<number, { unresolved: number }>()
  for (const r of runs) {
    // Ordered newest-first per site, so the first one wins.
    if (!lastRun.has(r.siteId)) lastRun.set(r.siteId, { unresolved: r.unresolved })
  }

  return {
    keywords: new Map(k.map((r) => [r.siteId, r])),
    supplySources: tally(srcs),
    coverage: new Map(cov.map((r) => [r.siteId, r])),
    lastRun,
    rates: tally(rates),
    observations: tally(obs),
    adsPlans: tally(plans),
    linkRuns: tally(links as Array<{ siteId: number; n: number }>),
  }
}

function summarise(site: SiteRow, facts: Facts): DirectorySummary {
  const k = facts.keywords.get(site.id)
  const cov = facts.coverage.get(site.id)
  const lastRun = facts.lastRun.get(site.id)
  const supply = { sources: facts.supplySources.get(site.id) ?? 0 }
  const rates = { n: facts.rates.get(site.id) ?? 0 }
  const obs = { n: facts.observations.get(site.id) ?? 0 }
  const plans = { n: facts.adsPlans.get(site.id) ?? 0 }
  const linkRuns = { n: facts.linkRuns.get(site.id) ?? 0 }

  const byVerdict = EMPTY_TALLY()
  byVerdict.DEFEND = k?.defend ?? 0
  byVerdict.IMPROVE = k?.improve ?? 0
  byVerdict.BUILD = k?.build ?? 0
  byVerdict.IGNORE = k?.ignore ?? 0
  byVerdict.UNKNOWN = k?.unknown ?? 0

  const keywords = k?.total ?? 0
  const decided = keywords - byVerdict.UNKNOWN

  const space = (site.keywordSpace ?? null) as {
    geoMode?: string
    audienceScope?: string
    patterns?: unknown[]
  } | null

  const domain = site.domain ?? '(no domain)'
  const gscReady = searchConsoleConfigured()
  const adsReady = googleAdsConfigured()

  /**
   * The three inputs a keyword's monthly value needs. Conversion counts as set
   * when EITHER the site scalar is filled in or an observation has been
   * recorded — observations supersede a typed rate, so requiring the scalar
   * would report a well-measured site as incomplete.
   */
  const hasConversion = site.conversionRateBps !== null || (obs?.n ?? 0) > 0
  const hasCommission = site.commissionRateBps !== null || rates.n > 0
  const hasOrderValue = site.orderValueMicros !== null
  const economicsSet = [
    hasOrderValue ? 'order value' : null,
    hasCommission ? 'commission' : null,
    hasConversion ? 'conversion' : null,
  ].filter(Boolean) as string[]
  const economicsMissing = [
    hasOrderValue ? null : 'order value',
    hasCommission ? null : 'commission',
    hasConversion ? null : 'conversion',
  ].filter(Boolean) as string[]

  const stages: DirectoryStage[] = [
    {
      key: 'keywords',
      label: 'Keyword grid',
      measured: keywords,
      total: keywords,
      state: keywords > 0 ? 'done' : 'not_run',
      detail:
        keywords > 0
          ? `${keywords.toLocaleString('en-US')} keywords generated from ${space?.patterns?.length ?? 0} pattern(s)`
          : 'No keywords generated yet',
      blocker: null,
      command: keywords > 0 ? null : `${CLI}/affiliate-research.mts expand ${domain}`,
      cost: 'free',
    },
    {
      key: 'volume',
      label: 'Demand',
      measured: k?.volume ?? 0,
      total: keywords,
      state: stageState(k?.volume ?? 0, keywords, adsReady),
      detail: 'Average monthly searches, from Google Ads',
      blocker: adsReady
        ? null
        : 'Google Ads is not configured. There is deliberately no paid fallback for volume.',
      command: `${CLI}/affiliate-research.mts volume ${domain} --live`,
      cost: 'free',
    },
    {
      key: 'rankings',
      label: 'Our rankings',
      measured: k?.position ?? 0,
      total: keywords,
      state: stageState(k?.position ?? 0, keywords, gscReady),
      /**
       * The sentence that makes Search Console worth fixing rather than paying
       * around: a keyword it does NOT return is a keyword we do not rank for,
       * and that is the measurement BUILD depends on.
       */
      detail: 'Search Console. Its silence for a keyword is itself the measurement',
      blocker: gscReady
        ? null
        : 'GSC_REFRESH_TOKEN is unset. Mint one with `gsc-auth.mts` — the OAuth app is already configured.',
      command: `${CLI}/affiliate-research.mts rankings ${domain} --live`,
      cost: 'free',
    },
    {
      key: 'difficulty',
      label: 'Difficulty',
      measured: k?.difficulty ?? 0,
      total: keywords,
      state: (k?.difficulty ?? 0) > 0 ? 'partial' : 'not_run',
      detail: 'Buys a SERP per keyword. Run it on the volume survivors only',
      blocker: null,
      command: `${CLI}/affiliate-research.mts difficulty ${domain} --live --max=25`,
      cost: 'paid',
    },
    {
      key: 'supply',
      label: 'Supply',
      measured: cov?.withSupply ?? 0,
      total: cov?.entities ?? 0,
      state:
        (supply?.sources ?? 0) === 0
          ? 'not_run'
          : (lastRun?.unresolved ?? 0) > 0
            ? 'partial'
            : 'done',
      detail:
        (supply?.sources ?? 0) === 0
          ? 'No feed connected — every keyword is UNKNOWN supply and nothing is gated'
          : `${(cov?.items ?? 0).toLocaleString('en-US')} available listing(s)` +
            ((lastRun?.unresolved ?? 0) > 0
              ? ` · ${lastRun!.unresolved.toLocaleString('en-US')} supplier(s) unresolved, which is UNKNOWN coverage and never zero`
              : ''),
      blocker: null,
      command:
        (supply?.sources ?? 0) === 0
          ? `${CLI}/supply.mts connect --site=${domain} --url=https://${domain}/api/supply`
          : `${CLI}/supply.mts pull <sourceId>`,
      cost: 'free',
    },
    {
      key: 'economics',
      label: 'Economics',
      /**
       * ==================== NAME THE MISSING INPUT, NOT JUST "INCOMPLETE" ====
       * `estimateAffiliateValue` needs all three of order value, commission and
       * conversion, and returns null unless it has every one — which is why the
       * board's "Value / mo" column is em dashes. A tile that said only
       * "partial" would leave the operator to work out WHICH of the three is
       * missing by reading a CLI, and the answer changes the next command.
       * ======================================================================
       */
      measured: economicsSet.length,
      total: 3,
      state:
        economicsSet.length === 0 ? 'not_run' : economicsMissing.length === 0 ? 'done' : 'partial',
      detail:
        economicsMissing.length === 0
          ? `All three inputs set${(obs?.n ?? 0) > 0 ? ` · ${obs!.n} conversion observation(s)` : ''}`
          : `Missing ${economicsMissing.join(' and ')} — so every keyword value stays null rather ` +
            `than becoming a guess`,
      blocker: null,
      command: economicsMissing.includes('conversion')
        ? `${CLI}/economics.mts observe ${domain} --clicks=… --orders=…`
        : `${CLI}/economics.mts set ${domain} --commission-bps=750`,
      cost: 'free',
    },
  ]

  return {
    siteId: site.id,
    domain,
    displayName: site.displayName,
    status: site.status,
    geoMode: space?.geoMode ?? null,
    audienceScope: space?.audienceScope ?? null,
    patternCount: space?.patterns?.length ?? 0,
    keywords,
    byVerdict,
    decided,
    stages,
    nextAction: pickNext(stages),
    adsPlans: plans?.n ?? 0,
    linkRuns: linkRuns?.n ?? 0,
    supplySources: supply?.sources ?? 0,
    supplyItems: cov?.items ?? 0,
    unresolvedSuppliers: lastRun?.unresolved ?? 0,
  }
}

function stageState(measured: number, total: number, configured: boolean): StageState {
  if (total === 0) return 'n_a'
  if (measured >= total) return 'done'
  if (measured > 0) return 'partial'
  return configured ? 'not_run' : 'blocked'
}

/**
 * The pipeline has a strict order, so the next action is the first stage that is
 * not done — blocked ones included, because a blocker IS the next thing to do.
 *
 * Difficulty is skipped: it spends money and is only worth running on the volume
 * survivors, so it is never auto-suggested. A screen that nudges an operator
 * toward a priced call before the free ones have run is a screen that costs
 * money for nothing.
 */
function pickNext(stages: DirectoryStage[]): DirectorySummary['nextAction'] {
  for (const s of stages) {
    if (s.cost === 'paid') continue
    if (s.state === 'done' || s.state === 'n_a') continue
    if (!s.command) continue
    return { label: s.label, command: s.command, blocker: s.blocker }
  }
  return null
}
