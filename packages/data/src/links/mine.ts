import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  assessProspect,
  computeMaxBid,
  estimateLinkValue,
  formatMicrosUsd,
  isExcludedProspect,
  qualityMultiplier,
  type Micros,
  type ProspectSignals,
  type ProspectVerdict,
} from '@rnr/core'
import type { Database } from '../db.js'
import { linkProspectRuns, linkProspectSources, linkProspects, sites } from '../schema.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchReferringDomains } from '../domains/authority-links.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'
import { fetchTrafficEstimates } from '../providers/dataforseo/traffic.js'

/**
 * Mine competitors' backlinks into a priced prospect list.
 *
 * ==================== COST FALLS AT EVERY STAGE, ON PURPOSE ==============
 *   ① referring domains   $0.025/competitor   ~200-1000 domains
 *   ② exclusions          $0                  removes most of it
 *   ③ bulk metrics        $0.024/req + $0.000036/row
 *   ④ traffic filter      $0.012/req + $0.00012/target, batched 1,000
 *
 * The two stages that scale per prospect run LAST and only on survivors — the
 * same ordering the affiliate pipeline uses, for the same reason: free
 * filtering first, paid measurement last.
 *
 * See docs/plan-link-outreach.md §2.
 */

export interface MineArgs {
  /**
   * Several competitors, not one.
   *
   * With a single competitor every prospect has a competitor count of 1 and the
   * §0.2 marketplace signal carries no information at all. Three or more is
   * where "links to 4 of our competitors" starts meaning something.
   */
  competitors: string[]
  siteId?: number
  /** Referring domains pulled per competitor. Cost scales with rows. */
  limitPerCompetitor?: number
  /** Hard ceiling on prospects carried into the paid stages. */
  maxProspects?: number
  live?: boolean
  /** Economics for the bid model. Omit and prospects are qualified but unpriced. */
  linkValue?: {
    prizeMicrosPerMonth: Micros | null
    serpAuthorityWall: number | null
    ourReferringDomains: number | null
    pSuccess: number
    decay: number
    horizonMonths: number
  }
}

export interface MineResult {
  runId: number
  referringDomainsFound: number
  excluded: number
  byVerdict: Record<ProspectVerdict, number>
  droppedToCap: number
  costMicros: Micros
  notes: string[]
}

const EMPTY_TALLY = (): Record<ProspectVerdict, number> => ({
  PURSUE: 0,
  MARGINAL: 0,
  REJECT: 0,
  UNKNOWN: 0,
})

export async function mineProspects(db: Database, args: MineArgs): Promise<MineResult> {
  const notes: string[] = []
  const competitors = [...new Set(args.competitors.map((c) => normalise(c)).filter(Boolean))]
  if (competitors.length === 0) throw new Error('at least one competitor domain is required')

  if (competitors.length < 3) {
    notes.push(
      `Only ${competitors.length} competitor(s). The marketplace signal (how many of our ` +
        `competitors a domain links to) needs at least 3 to distinguish an editorial link from a ` +
        `seller — with one, every prospect scores 1 and the column is noise.`,
    )
  }

  const maxProspects = args.maxProspects ?? 500
  const limitPerCompetitor = args.limitPerCompetitor ?? 200

  const [run] = await db
    .insert(linkProspectRuns)
    .values({
      ...(args.siteId === undefined ? {} : { siteId: args.siteId }),
      competitors,
      status: 'running',
    })
    .returning({ id: linkProspectRuns.id })
  if (!run) throw new Error('failed to create run')

  let costMicros = 0n
  const byVerdict = EMPTY_TALLY()

  try {
    const client = createDfsClientFromEnv()
    if (!client || args.live === false) {
      notes.push(
        args.live === false ? 'live disabled — nothing fetched' : 'DATAFORSEO credentials not set',
      )
      await finish(db, run.id, { costMicros, notes, byVerdict, found: 0, excluded: 0, dropped: 0 })
      return {
        runId: run.id,
        referringDomainsFound: 0,
        excluded: 0,
        byVerdict,
        droppedToCap: 0,
        costMicros,
        notes,
      }
    }

    // --- ① referring domains, per competitor ------------------------------
    /** domain → the competitors linking to it, and the page each link sits on. */
    const sources = new Map<string, Map<string, string | null>>()

    for (const competitor of competitors) {
      const r = await fetchReferringDomains(client, competitor, limitPerCompetitor)
      costMicros += r.costMicros
      for (const item of r.referring) {
        /**
         * A LOST link still tells us the domain was willing to link to a
         * competitor once, which is the signal we are mining. Kept, and the
         * status travels no further — it is not evidence about the prospect's
         * quality today.
         */
        const existing = sources.get(item.domain) ?? new Map<string, string | null>()
        if (!existing.has(competitor)) existing.set(competitor, item.urlFrom ?? null)
        sources.set(item.domain, existing)
      }
    }

    const referringDomainsFound = sources.size

    // --- ② exclusions, free -----------------------------------------------
    const ownDomains = await loadOwnDomains(db)
    const kept: string[] = []
    let excluded = 0
    for (const domain of sources.keys()) {
      const verdict = isExcludedProspect(domain, { ownDomains, competitorDomains: competitors })
      if (verdict.excluded) {
        excluded += 1
        continue
      }
      kept.push(domain)
    }

    /**
     * Sorted by competitor count before the cap bites, so a truncated run keeps
     * the rows the §0.2 signal says are most interesting rather than an
     * arbitrary alphabetical slice.
     */
    kept.sort((a, b) => (sources.get(b)?.size ?? 0) - (sources.get(a)?.size ?? 0))
    const droppedToCap = Math.max(0, kept.length - maxProspects)
    const prospects = kept.slice(0, maxProspects)

    if (droppedToCap > 0) {
      notes.push(
        `${droppedToCap} prospect(s) dropped at the ${maxProspects} cap. This run is a SAMPLE of ` +
          `the eligible set, not the set — kept the highest competitor-overlap rows.`,
      )
    }

    // --- ③ bulk metrics ----------------------------------------------------
    const authority = await fetchBulkBacklinks(client, prospects)
    costMicros +=
      PRICE_BULK_REQUEST * BigInt(authority.requestCount) +
      PRICE_BULK_ROW * BigInt(authority.authorities.size)

    // --- ④ the traffic filter ---------------------------------------------
    const traffic = await fetchTrafficEstimates(client, prospects)
    costMicros += traffic.costMicros
    if (traffic.unresolved.length > 0) {
      notes.push(
        `${traffic.unresolved.length} prospect(s) returned no traffic data. That is UNRESOLVED, ` +
          `not zero traffic — they are UNKNOWN, never rejected on it.`,
      )
    }

    // --- ⑤ qualify and price ----------------------------------------------
    const value = args.linkValue ? estimateLinkValue(args.linkValue) : null
    if (args.linkValue && value?.valuePerLinkMicros === null) {
      notes.push(`Bids not computable — missing: ${value.missing.join(', ')}`)
    }
    if (!args.linkValue) {
      notes.push('No link-value inputs supplied: prospects are qualified but unpriced.')
    }

    for (const domain of prospects) {
      const auth = authority.authorities.get(domain)
      const est = traffic.estimates.get(domain)
      const competitorMap = sources.get(domain)

      const signals: ProspectSignals = {
        domain,
        dfsRank: auth?.rank ?? null,
        referringDomains: auth?.referringDomains ?? null,
        spamScore: auth?.spamScore ?? null,
        rankedKeywords: est?.rankedKeywords ?? null,
        organicEtv: est?.organicEtv ?? null,
        competitorLinkCount: competitorMap?.size ?? 0,
        alreadyLinked: false,
      }

      const assessment = assessProspect(signals)
      byVerdict[assessment.verdict] += 1

      const bid =
        value && value.valuePerLinkMicros !== null && assessment.verdict === 'PURSUE'
          ? computeMaxBid({ value, signals })
          : null

      const [row] = await db
        .insert(linkProspects)
        .values({
          runId: run.id,
          domain,
          dfsRank: signals.dfsRank,
          referringDomains: signals.referringDomains,
          spamScore: signals.spamScore,
          rankedKeywords: signals.rankedKeywords,
          organicEtv: signals.organicEtv,
          competitorLinkCount: signals.competitorLinkCount,
          alreadyLinked: signals.alreadyLinked,
          verdict: assessment.verdict,
          verdictReason: assessment.reason,
          warnings: assessment.warnings.length > 0 ? assessment.warnings : null,
          qualityMultiplier: qualityMultiplier(signals),
          maxBidMicros: bid?.maxBidMicros ?? null,
          linksNeeded: value?.linksNeeded ?? null,
        })
        .onConflictDoNothing({ target: [linkProspects.runId, linkProspects.domain] })
        .returning({ id: linkProspects.id })

      if (row && competitorMap) {
        for (const [competitor, urlFrom] of competitorMap) {
          await db
            .insert(linkProspectSources)
            .values({ prospectId: row.id, competitor, urlFrom })
            .onConflictDoNothing()
        }
      }
    }

    notes.push(`Spend: ${formatMicrosUsd(costMicros)}`)
    await finish(db, run.id, {
      costMicros,
      notes,
      byVerdict,
      found: referringDomainsFound,
      excluded,
      dropped: droppedToCap,
    })

    return {
      runId: run.id,
      referringDomainsFound,
      excluded,
      byVerdict,
      droppedToCap,
      costMicros,
      notes,
    }
  } catch (e) {
    await db
      .update(linkProspectRuns)
      .set({ status: 'failed', error: (e as Error).message, finishedAt: new Date() })
      .where(eq(linkProspectRuns.id, run.id))
    throw e
  }
}

/** Measured: $0.024 per bulk request plus $0.000036 per returned row. */
const PRICE_BULK_REQUEST = 24_000n
const PRICE_BULK_ROW = 36n

async function finish(
  db: Database,
  runId: number,
  args: {
    costMicros: Micros
    notes: string[]
    byVerdict: Record<ProspectVerdict, number>
    found: number
    excluded: number
    dropped: number
  },
): Promise<void> {
  await db
    .update(linkProspectRuns)
    .set({
      status: 'complete',
      referringDomainsFound: args.found,
      excludedCount: args.excluded,
      qualifiedCount: args.byVerdict.PURSUE + args.byVerdict.MARGINAL,
      droppedToCap: args.dropped,
      costMicros: args.costMicros,
      notes: args.notes,
      finishedAt: new Date(),
    })
    .where(eq(linkProspectRuns.id, runId))
}

async function loadOwnDomains(db: Database): Promise<string[]> {
  const rows = await db.select({ domain: sites.domain }).from(sites)
  return rows.map((r) => r.domain).filter((d): d is string => typeof d === 'string')
}

function normalise(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
}

export interface ProspectBoardRow {
  id: number
  domain: string
  verdict: ProspectVerdict | null
  verdictReason: string | null
  dfsRank: number | null
  rankedKeywords: number | null
  organicEtv: number | null
  spamScore: number | null
  competitorLinkCount: number
  maxBidMicros: Micros | null
  warnings: string[] | null
}

/**
 * The board. Sorted by bid, then by how many competitors link there.
 *
 * The competitor count is shown as a raw number rather than folded into the
 * sort key, because it means two opposite things at once — easiest sale, worst
 * footprint — and a single ranking would hide whichever half the reader needed.
 */
export async function listProspects(
  db: Database,
  runId: number,
  opts: { verdicts?: ProspectVerdict[]; limit?: number } = {},
): Promise<ProspectBoardRow[]> {
  const where = [eq(linkProspects.runId, runId)]
  if (opts.verdicts?.length) where.push(inArray(linkProspects.verdict, opts.verdicts))

  return db
    .select({
      id: linkProspects.id,
      domain: linkProspects.domain,
      verdict: linkProspects.verdict,
      verdictReason: linkProspects.verdictReason,
      dfsRank: linkProspects.dfsRank,
      rankedKeywords: linkProspects.rankedKeywords,
      organicEtv: linkProspects.organicEtv,
      spamScore: linkProspects.spamScore,
      competitorLinkCount: linkProspects.competitorLinkCount,
      maxBidMicros: linkProspects.maxBidMicros,
      warnings: linkProspects.warnings,
    })
    .from(linkProspects)
    .where(and(...where))
    .orderBy(
      sql`case ${linkProspects.verdict} when 'PURSUE' then 0 when 'MARGINAL' then 1 when 'UNKNOWN' then 2 else 3 end`,
      sql`${linkProspects.maxBidMicros} desc nulls last`,
      sql`${linkProspects.organicEtv} desc nulls last`,
    )
    .limit(opts.limit ?? 100)
}
