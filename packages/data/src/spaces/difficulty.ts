import 'server-only'
import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm'
import {
  PRICE,
  buildMatchContext,
  classifyResult,
  extractSerpLayoutMetrics,
  formatMicrosUsd,
  scoreDifficulty,
  verticalPlatforms,
  type ClassifiedResult,
  type DomainAuthority,
  type Micros,
  type SerpItem,
} from '@rnr/core'
import type { Database } from '../db.js'
import { siteKeywordTargets, sites } from '../schema.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchOrganicSerpDetailed } from '../providers/dataforseo/serp.js'
import { fetchBulkBacklinks } from '../providers/dataforseo/backlinks.js'
import { readAuthorityCache, writeAuthorityCache } from '../cache.js'
import { loadSiteSpace } from './research.js'

/**
 * The only paid step in this pipeline, and the last one on purpose.
 *
 * ==================== IT RUNS ON SURVIVORS, NOT ON THE GRID ====================
 * `hotelhottubs` generates 975 keywords. Buying a SERP for each is $1.95 live,
 * and most of them have no demand — which is knowable for FREE, before spending
 * anything, because national volume comes from Google Ads.
 *
 * So this refuses to run on a keyword whose volume is unmeasured, and skips any
 * below the space's floor. That ordering is the entire economic argument of the
 * affiliate pipeline: free filtering first, paid measurement last.
 * =============================================================================
 *
 * The platform overlay is what makes the resulting number mean anything. On a
 * hot-tub-hotel SERP the slot holders are Booking, Expedia and TripAdvisor, and
 * without `VERTICAL_PLATFORM_DOMAINS` every one classifies as `local_business` —
 * a beatable independent site. That is the most optimistic error available, on
 * the heaviest-weighted component of the model.
 */

export interface DifficultyPassResult {
  eligible: number
  scored: number
  skippedNoVolume: number
  skippedBelowFloor: number
  serpsBought: number
  costMicros: Micros
  notes: string[]
}

/** Default ceiling per invocation. Small, because this is the step that spends. */
export const DEFAULT_DIFFICULTY_CAP = 25

export async function runDifficultyPass(
  db: Database,
  siteId: number,
  opts: { live?: boolean; max?: number; budgetMicros?: Micros } = {},
): Promise<DifficultyPassResult> {
  const site = await loadSiteSpace(db, siteId)
  const space = site.keywordSpace
  if (!space) throw new Error(`Site ${siteId} has no keyword_space`)

  const notes: string[] = []
  const max = opts.max ?? DEFAULT_DIFFICULTY_CAP
  const budget = opts.budgetMicros ?? PRICE.serpOrganicLive * BigInt(max)

  const [row] = await db
    .select({ platformVerticals: sites.platformVerticals })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1)

  /**
   * A typo'd vertical name throws rather than quietly overlaying nothing —
   * `verticalPlatforms` enforces that. Silently falling back to the global list
   * is precisely the failure this overlay exists to prevent.
   */
  const extraPlatforms =
    row?.platformVerticals?.length ? verticalPlatforms(...row.platformVerticals) : undefined
  if (!extraPlatforms) {
    notes.push(
      'No platformVerticals set on this site: the SERP will be classified with the local-services ' +
        'platform list only, so large vertical brands will read as beatable independent sites.',
    )
  }

  /**
   * Survivors only. `volume IS NOT NULL` is the load-bearing half — an
   * unmeasured keyword is not a cheap keyword, it is an unknown one, and buying
   * a SERP for it spends money to answer the second question before the first.
   */
  const candidates = await db
    .select({
      id: siteKeywordTargets.id,
      keyword: siteKeywordTargets.keyword,
      volume: siteKeywordTargets.volume,
    })
    .from(siteKeywordTargets)
    .where(
      and(
        eq(siteKeywordTargets.siteId, siteId),
        eq(siteKeywordTargets.active, true),
        isNull(siteKeywordTargets.difficultyMeasuredAt),
        isNotNull(siteKeywordTargets.volume),
        gte(siteKeywordTargets.volume, space.volumeFloor),
      ),
    )
    .orderBy(desc(siteKeywordTargets.volume))
    .limit(max)

  const [{ count: noVolume } = { count: 0 }] = await db
    .select({ count: siteKeywordTargets.id })
    .from(siteKeywordTargets)
    .where(
      and(
        eq(siteKeywordTargets.siteId, siteId),
        eq(siteKeywordTargets.active, true),
        isNull(siteKeywordTargets.volume),
      ),
    )
    .limit(1)
    .then((r) => (r.length ? [{ count: r.length }] : [{ count: 0 }]))

  if (candidates.length === 0) {
    return {
      eligible: 0,
      scored: 0,
      skippedNoVolume: noVolume,
      skippedBelowFloor: 0,
      serpsBought: 0,
      costMicros: 0n,
      notes: [
        ...notes,
        'No keyword qualifies. Difficulty only runs on keywords with MEASURED volume at or above ' +
          `the ${space.volumeFloor} floor — run \`volume --live\` first, it is free.`,
      ],
    }
  }

  if (opts.live === false || opts.live === undefined) {
    return {
      eligible: candidates.length,
      scored: 0,
      skippedNoVolume: noVolume,
      skippedBelowFloor: 0,
      serpsBought: 0,
      costMicros: 0n,
      notes: [
        ...notes,
        `${candidates.length} keyword(s) qualify. This step BUYS SERPs — about ` +
          `${formatMicrosUsd(PRICE.serpOrganicLive * BigInt(candidates.length))} at ` +
          `${formatMicrosUsd(PRICE.serpOrganicLive)} each. Pass --live to spend.`,
      ],
    }
  }

  const client = createDfsClientFromEnv()
  if (!client) {
    return {
      eligible: candidates.length,
      scored: 0,
      skippedNoVolume: noVolume,
      skippedBelowFloor: 0,
      serpsBought: 0,
      costMicros: 0n,
      notes: [...notes, 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set.'],
    }
  }

  // --- Buy, then barrier on the defender set, then score. --------------------
  // Same extract → BARRIER → score shape as run-scan.ts: collecting every
  // defending domain before buying link data is what makes this cents.
  const fetched: Array<{
    id: number
    keyword: string
    items: SerpItem[]
    raw: Array<Record<string, unknown>>
  }> = []
  let costMicros = 0n
  let serpsBought = 0

  for (const c of candidates) {
    if (costMicros + PRICE.serpOrganicLive > budget) {
      notes.push(
        `Budget cap reached at ${formatMicrosUsd(costMicros)} after ${serpsBought} SERP(s). ` +
          `${candidates.length - serpsBought} keyword(s) were NOT measured — they stay UNKNOWN, not easy.`,
      )
      break
    }
    const serp = await fetchOrganicSerpDetailed(client, {
      keyword: c.keyword,
      locationCode: space.serpLocationCode,
    })
    costMicros += PRICE.serpOrganicLive
    serpsBought += 1
    fetched.push({ id: c.id, keyword: c.keyword, items: serp.snapshot.items, raw: serp.rawItems })
  }

  const allDomains = new Set<string>()
  for (const f of fetched) for (const item of f.items) allDomains.add(item.domain)

  const authorities = new Map<string, DomainAuthority>()
  if (allDomains.size > 0) {
    const cache = await readAuthorityCache(db, [...allDomains])
    for (const [d, a] of cache.hits) authorities.set(d, a)
    if (cache.misses.length > 0) {
      try {
        const out = await fetchBulkBacklinks(client, cache.misses)
        for (const [d, a] of out.authorities) authorities.set(d, a)
        await writeAuthorityCache(db, { authorities: out.authorities, unresolved: out.unresolved })
        costMicros += PRICE.backlinksBulkRequest * BigInt(out.requestCount)
        costMicros += PRICE.backlinksBulkRow * BigInt(out.authorities.size)
      } catch {
        /**
         * Partial data stays partial. The alternative — treating every unfetched
         * defender as linkless — reports every SERP as wide open, which is the
         * failure the difficulty model's omit-and-renormalise rule exists for.
         */
        notes.push(
          'Link data could not be bought for some defenders. Difficulty is scored on reduced ' +
            'coverage; no domain was treated as having zero links.',
        )
      }
    }
  }

  const now = new Date()
  let scored = 0

  for (const f of fetched) {
    /**
     * No locality and no niche token on an affiliate space, so exact-match
     * detection is inert by construction. That is correct rather than a gap:
     * `{locality}{niche}.com` is not the asset here — the site already exists.
     * The overlay is what carries the real signal.
     */
    const ctx = buildMatchContext({
      localityName: '',
      nicheEmdToken: '',
      nicheDomainStems: [],
      extraPlatforms,
    })
    const classified: ClassifiedResult[] = f.items.map((item) =>
      classifyResult(item, ctx, authorities.get(item.domain) ?? null),
    )
    /**
     * `hasLocalPack: false` is a FACT here, not a default — an affiliate query
     * has no local pack. It is passed to scoreDifficulty only; assessEmd, which
     * would read it as `not_a_local_query` and veto the keyword, is never called
     * on this path. See localModelsApply.
     */
    const difficulty = scoreDifficulty({ results: classified, hasLocalPack: false })
    const layout = extractSerpLayoutMetrics(f.raw)

    await db
      .update(siteKeywordTargets)
      .set({
        difficulty: difficulty.difficulty,
        difficultyMeasuredAt: now,
        hasAiOverview: layout.hasAiOverview,
        updatedAt: now,
      })
      .where(eq(siteKeywordTargets.id, f.id))
    scored += 1
  }

  return {
    eligible: candidates.length,
    scored,
    skippedNoVolume: noVolume,
    skippedBelowFloor: 0,
    serpsBought,
    costMicros,
    notes,
  }
}
