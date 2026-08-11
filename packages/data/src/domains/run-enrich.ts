import 'server-only'
import { eq } from 'drizzle-orm'
import type { Micros } from '@rnr/core'
import type { Database } from '../db.js'
import { domainCandidates, domainEnrichRuns, spendLedger } from '../schema.js'
import { collectBusinesses } from './collect-businesses.js'
import { collectFromStoredSerps } from './collect-from-serps.js'
import { runQualityGates, type QualityGateOptions } from './quality-gates.js'
import { auditAuthorityLinks } from './authority-links.js'
import { renderUnresolved } from './js-render.js'
import { enrichDomains, type EnrichPipelineOptions } from './enrich-pipeline.js'

/**
 * ENRICH MODE, start to finish, persisted.
 *
 * Stage 1 buys the business list; stages 2-5b are free. The only paid stage
 * beyond collection is Majestic, which is off unless a caller supplies
 * `fetchMajestic`.
 */

export interface StartEnrichRunArgs {
  niche: string
  locality: string
  locationCode: number
  radiusKm?: number
  maxResults?: number
  includeClosed?: boolean
  /** Optional PAID stages. Everything else in a run is free. */
  paidOptions?: PaidOptions
  nicheId?: number | null
}

export interface PaidOptions {
  /** Spam score, domain rank, referring domains. ~$0.03-0.10 per market. */
  checkSpam?: boolean
  /** Still-ranking check. $0.012 per domain, capped. */
  checkRankings?: boolean
  maxRankingLookups?: number
  /** Authority citations. $0.025 per qualifying domain. */
  checkAuthority?: boolean
  /**
   * Re-read UNKNOWN rows through a JS-capable renderer. $0.0051 per domain.
   * Fixes JS-rendered sites and some bot-blocked ones; hard blocks stay UNKNOWN.
   */
  renderUnknown?: boolean
  maxRenders?: number
}

export async function createEnrichRun(
  db: Database,
  args: StartEnrichRunArgs,
): Promise<number> {
  const [row] = await db
    .insert(domainEnrichRuns)
    .values({
      niche: args.niche,
      locality: args.locality,
      locationCode: args.locationCode,
      radiusKm: args.radiusKm ?? 25,
      maxResults: args.maxResults ?? 200,
      includeClosed: args.includeClosed ?? true,
      status: 'running',
      paidOptions: (args.paidOptions ?? {}) as Record<string, boolean>,
      nicheId: args.nicheId ?? null,
    })
    .returning({ id: domainEnrichRuns.id })
  if (!row) throw new Error('Failed to create domain enrich run')
  return row.id
}

/**
 * Record a purchase against the global ledger.
 *
 * The enrich run has no foreign key on `spend_ledger`, so attribution rides in
 * `note` — the same escape hatch the discovery path uses to survive a deleted
 * run. Writing the line at the moment of purchase is the point: the discovery
 * overspend happened precisely because volume and maps calls were never
 * ledgered, so the balance moved while the books did not.
 */
async function recordEnrichSpend(
  db: Database,
  args: { runId: number; costMicros: Micros; endpoint: string; rows: number },
): Promise<void> {
  if (args.costMicros <= 0n) return
  await db.insert(spendLedger).values({
    endpoint: args.endpoint,
    costMicros: args.costMicros,
    rows: args.rows,
    note: `domain_enrich_run=${args.runId}`,
  })
}

export interface RunEnrichResult {
  runId: number
  uniqueDomains: number
  candidates: number
  costMicros: Micros
}

/**
 * Run the stages for a row that already exists.
 *
 * Split from `runEnrich` because the web path creates the row in a server
 * action — so the operator sees a `running` row the moment they click — and
 * does the work in a Trigger.dev task, which is not bound by the serverless
 * request timeout a 200-domain triage would blow straight through.
 */
export async function executeEnrichRun(
  db: Database,
  runId: number,
  options?: EnrichPipelineOptions,
): Promise<RunEnrichResult> {
  const [run] = await db
    .select()
    .from(domainEnrichRuns)
    .where(eq(domainEnrichRuns.id, runId))
    .limit(1)
  if (!run) throw new Error(`Domain enrich run ${runId} not found`)

  const args = {
    niche: run.niche,
    locationCode: run.locationCode,
    maxResults: run.maxResults,
    options,
  }
  const paid = (run.paidOptions ?? {}) as PaidOptions

  await db
    .update(domainEnrichRuns)
    .set({ status: 'running', error: null })
    .where(eq(domainEnrichRuns.id, runId))

  try {
    // ---- Stage 1a: a live map pack ($0.002) ----
    const collected = await collectBusinesses({
      niche: args.niche,
      locationCode: args.locationCode,
      maxResults: args.maxResults ?? 200,
    })
    await recordEnrichSpend(db, {
      runId,
      costMicros: collected.costMicros,
      endpoint: 'serp/google/maps/live/advanced',
      rows: collected.businesses.length,
    })

    /**
     * ---- Stage 1b: everything the sweep already bought (free) ----
     * Organic and map-pack domains stored on discovery_serp_metrics for this
     * market. Measured at 509 domains never triaged against 254 the live map
     * pack had found, so this is most of the coverage and costs nothing.
     */
    const stored = await collectFromStoredSerps(db, {
      locationCode: args.locationCode,
      nicheId: run.nicheId ?? null,
    })
    const provenance = new Map(
      stored.map((s) => [
        (s.website ?? '').replace(/^https?:\/\//, '').toLowerCase(),
        { sources: s.sources, serpRank: s.serpRank, seenKeyword: s.seenKeyword },
      ]),
    )

    await db
      .update(domainEnrichRuns)
      .set({ domainsFromSerps: stored.length })
      .where(eq(domainEnrichRuns.id, runId))

    // ---- Stages 2-5, free for every domain from either source ----
    const result = await enrichDomains([...collected.businesses, ...stored], {
      nicheTerms: [args.niche],
      ...args.options,
    })

    /**
     * ---- Optional: re-read what a plain fetch could not ----
     * Only UNKNOWN rows, because that is exactly the population a renderer can
     * help: everything else already has a conclusive answer.
     */
    const unresolved = result.candidates
      .filter((c) => c.classification.status === 'UNKNOWN')
      .map((c) => c.domain)

    const rendered =
      paid.renderUnknown && unresolved.length > 0
        ? await renderUnresolved(unresolved, { maxRenders: paid.maxRenders ?? 100 })
        : null

    if (rendered && rendered.costMicros > 0n) {
      await recordEnrichSpend(db, {
        runId,
        costMicros: rendered.costMicros,
        endpoint: 'on_page/instant_pages (js render)',
        rows: rendered.results.length,
      })
    }
    const renderByDomain = new Map((rendered?.results ?? []).map((r) => [r.domain, r]))

    /**
     * ---- Optional paid gates ----
     * Only for rows that survived triage as candidates: paying to grade a live
     * business or an unreadable one buys nothing.
     */
    const gradable = result.candidates
      .filter((c) => !['LIVE', 'BROKEN', 'UNKNOWN'].includes(c.classification.status))
      .map((c) => c.domain)

    const quality =
      gradable.length > 0 && (paid.checkSpam || paid.checkRankings)
        ? await runQualityGates(gradable, {
            ...(paid.checkSpam === undefined ? {} : { checkSpam: paid.checkSpam }),
            ...(paid.checkRankings === undefined ? {} : { checkRankings: paid.checkRankings }),
            maxRankingLookups: paid.maxRankingLookups ?? 15,
            locationCode: 2840,
          } satisfies QualityGateOptions)
        : null

    if (quality && quality.costMicros > 0n) {
      await recordEnrichSpend(db, {
        runId,
        costMicros: quality.costMicros,
        endpoint: 'backlinks/bulk_* + labs/ranked_keywords',
        rows: quality.rows.length,
      })
    }
    const qualityByDomain = new Map((quality?.rows ?? []).map((r) => [r.domain, r]))

    /**
     * ---- Authority citations ($0.0242 per qualifying domain) ----
     *
     * ==================== THIS STAGE EXISTED AND NEVER RAN ====================
     * `checkAuthority` was declared in PaidOptions and read by nothing;
     * auditAuthorityLinks was exported from the package and called from nowhere.
     * So authority_checked_at was NULL on every candidate ever produced, every
     * directory chip in the UI fell back to a name search, and operators
     * reported those links landing on nothing -- which they did, because a
     * common business name in a big city returns a page of maybes.
     *
     * The audit pre-filters hard (skips LIVE / BROKEN / UNKNOWN and anything
     * with too few referring domains), so on a real market this is roughly
     * 12-18 lookups, not one per candidate.
     * =========================================================================
     */
    const authority =
      paid.checkAuthority === true && result.candidates.length > 0
        ? // Every candidate is passed WITH its status, not just the gradable
          // ones: the audit does its own pre-filtering and reports what it
          // skipped and why, so a blank authority column stays explainable.
          await auditAuthorityLinks(
            result.candidates.map((c) => ({
              domain: c.domain,
              status: c.classification.status,
            })),
          )
        : null

    if (authority && authority.costMicros > 0n) {
      await recordEnrichSpend(db, {
        runId,
        costMicros: authority.costMicros,
        endpoint: '/backlinks/backlinks/live',
        rows: authority.lookups,
      })
    }
    const authorityByDomain = new Map((authority?.rows ?? []).map((r) => [r.domain, r]))

    if (result.candidates.length > 0) {
      await db
        .insert(domainCandidates)
        .values(
          result.candidates.map((c) => ({
            runId,
            domain: c.domain,
            // A render that resolved the page overrides the plain-fetch
            // verdict; one that was still blocked leaves it alone.
            status: (() => {
              const r = renderByDomain.get(c.domain)
              if (!r) return c.classification.status
              if (r.verdict === 'live') return 'LIVE'
              if (r.verdict === 'parked') return 'PARKED_DEAD'
              return c.classification.status
            })(),
            reason: (() => {
              const r = renderByDomain.get(c.domain)
              return r && (r.verdict === 'live' || r.verdict === 'parked')
                ? `Rendered: ${r.detail}`
                : c.classification.reason
            })(),
            score: c.score.total,
            scoreComponents: c.score.components,
            scoreMissing: c.score.missing,
            businesses: c.businesses,
            businessCount: c.businessCount,
            sources: provenance.get(c.domain)?.sources ?? ['maps_live'],
            serpRank: provenance.get(c.domain)?.serpRank ?? null,
            seenKeyword: provenance.get(c.domain)?.seenKeyword ?? null,
            spamScore: qualityByDomain.get(c.domain)?.spamScore ?? null,
            rankedKeywords: qualityByDomain.get(c.domain)?.rankedKeywords ?? null,
            qualityCheckedAt: qualityByDomain.has(c.domain) ? new Date() : null,
            authorityScore: authorityByDomain.get(c.domain)?.profile?.score ?? null,
            authorityKinds: authorityByDomain.get(c.domain)?.profile?.kinds ?? null,
            authorityMatches:
              authorityByDomain.get(c.domain)?.profile?.matches.map((m) => ({
                domain: m.domain,
                kind: m.kind,
                reason: m.reason,
                rank: m.rank,
                urlFrom: m.urlFrom,
                pageStatus: m.pageStatus,
                isLost: m.isLost,
              })) ?? null,
            authorityNote: authorityByDomain.get(c.domain)?.note ?? null,
            authorityCheckedAt: authorityByDomain.has(c.domain) ? new Date() : null,
            domainRank: authorityByDomain.get(c.domain)?.rank ?? null,
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
            trustFlow: c.majestic?.trustFlow ?? null,
            citationFlow: c.majestic?.citationFlow ?? null,
            referringDomains: c.majestic?.referringDomains ?? null,
            referringSubnets: c.majestic?.referringSubnets ?? null,
            topics: c.majestic?.topics ?? null,
            firstSnapshotAt: c.wayback?.firstSnapshotAt ?? null,
            lastContentSnapshotAt: c.wayback?.lastContentSnapshotAt ?? null,
            // `ok: false` means Wayback did not answer. Storing 0 there would
            // read as "no archive history", which is a different claim.
            totalSnapshots: c.wayback?.ok ? c.wayback.totalSnapshots : null,
            yearsOfContent: c.wayback?.ok ? c.wayback.yearsOfContinuousContent : null,
          })),
        )
        .onConflictDoNothing()
    }

    await db
      .update(domainEnrichRuns)
      .set({
        status: 'complete',
        businessesFound: result.stats.businesses,
        uniqueDomains: result.stats.uniqueDomains,
        skippedPlatform: result.stats.skippedPlatform,
        skippedNoDomain: result.stats.skippedNoDomain,
        costMicros:
          collected.costMicros + (quality?.costMicros ?? 0n) + (rendered?.costMicros ?? 0n),
        completedAt: new Date(),
      })
      .where(eq(domainEnrichRuns.id, runId))

    return {
      runId,
      uniqueDomains: result.stats.uniqueDomains,
      candidates: result.candidates.filter((c) => c.classification.status !== 'LIVE').length,
      costMicros:
        collected.costMicros + (quality?.costMicros ?? 0n) + (rendered?.costMicros ?? 0n),
    }
  } catch (err) {
    // The Stage 1 ledger line stays written. The money left the account whether
    // or not triage finished, and a failed run that hides its spend is the
    // exact failure this project already paid for once.
    await db
      .update(domainEnrichRuns)
      .set({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(domainEnrichRuns.id, runId))
    throw err
  }
}

/** Create and execute in one call. Used by scripts; the web path splits them. */
export async function runEnrich(
  db: Database,
  args: StartEnrichRunArgs & { options?: EnrichPipelineOptions },
): Promise<RunEnrichResult> {
  const runId = await createEnrichRun(db, args)
  return executeEnrichRun(db, runId, args.options)
}
