import 'server-only'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import {
  findCommentOrdinal,
  findRedditPlacement,
  oldRedditThreadUrl,
  PRICE,
  type Micros,
  type SerpSourceKind,
} from '@rnr/core'
import type { Database } from '../db.js'
import {
  localities,
  niches,
  serpChecks,
  serpKeywords,
  serpTargets,
  sites,
  spendLedger,
  type SerpTarget,
} from '../schema.js'
import type { Providers } from '../providers/index.js'

/**
 * Run one monitoring check.
 *
 * ==================== WHAT THIS COSTS, AND WHY IT IS CAPPED ====================
 * Each check buys one live SERP ($0.002) and, when a comment is being watched, one page
 * fetch (~$0.00015). Daily across 80 keywords that is about $5/month per cell. The cap is
 * checked BEFORE each purchase, exactly as `runScan` does -- a monitor that discovers it
 * overspent is a monitor that already overspent.
 * ============================================================================
 *
 * ==================== AND THE RULE THAT MATTERS MOST ====================
 * A blocked fetch, a layout change, or a truncated comment tree writes
 * `commentPresent: NULL` with a reason. Only a COMPLETE thread that does not contain the
 * comment writes `false`, because only `false` raises "your comment was removed". Reddit
 * answers 403 to server IPs, so NULL will be the common case and must stay silent.
 * =====================================================================
 */

export interface CheckOutcome {
  targetId: number
  keyword: string
  serpMeasured: boolean
  /** Organic rank_group, or null if not in organic. */
  serpPosition: number | null
  /** Discussions pack position, or null if not in pack. */
  serpPackPosition: number | null
  /** organic | discussions_and_forums | both | null when absent from both. */
  serpSourceKind: SerpSourceKind | null
  ourDomainPosition: number | null
  commentRank: number | null
  commentPresent: boolean | null
  costMicros: Micros
  error: string | null
}

/** Default daily ceiling per cell, in whole cents. ~$5/month. */
export const DEFAULT_DAILY_CAP_CENTS = 17

export function dailyCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SERP_MONITOR_DAILY_CAP_CENTS'])
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CAP_CENTS
}

/** What this cell has already spent on monitoring today. */
export async function spentTodayMicros(db: Database, siteId: number): Promise<Micros> {
  const [row] = await db
    .select({ total: sql<string>`COALESCE(sum(cost_micros), 0)::text` })
    .from(spendLedger)
    .where(
      and(
        eq(spendLedger.siteId, siteId),
        sql`${spendLedger.endpoint} LIKE 'serp/monitor%'`,
        sql`${spendLedger.createdAt} >= date_trunc('day', now())`,
      ),
    )
  return BigInt(row?.total ?? '0')
}

/**
 * Claim the next due target, atomically.
 *
 * `serp_targets` IS the queue -- same `FOR UPDATE SKIP LOCKED` shape as `claimNextRun`, so
 * two workers take two different rows and neither blocks. Returns the id only, then
 * re-selects through Drizzle: a raw `RETURNING *` hands back snake_case, so `keywordId`
 * would silently be undefined.
 */
export async function claimNextTarget(db: Database, workerId: string): Promise<SerpTarget | null> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE serp_targets
       SET claimed_at = now(), claimed_by = ${workerId}
     WHERE id = (
       SELECT id FROM serp_targets
        WHERE active AND next_check_at <= now()
        ORDER BY next_check_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND active
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null
  const [row] = await db.select().from(serpTargets).where(eq(serpTargets.id, id))
  return row ?? null
}

/** Push a target's next check out, and release the claim. */
export async function rescheduleTarget(
  db: Database,
  targetId: number,
  hours: number,
): Promise<void> {
  await db
    .update(serpTargets)
    .set({
      lastCheckedAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      nextCheckAt: sql`now() + (${hours} || ' hours')::interval`,
    })
    .where(eq(serpTargets.id, targetId))
}

/**
 * Measure one target and record the result.
 *
 * Never throws for a provider failure: a failed measurement is a ROW with a reason, because
 * "we could not look" is information the dashboard needs. Throwing would lose it.
 */
export async function runTargetCheck(
  db: Database,
  args: {
    target: SerpTarget
    providers: Providers
    /** Injected so the caller can fetch a page through the same seam. */
    fetchPage: (url: string) => Promise<{ html: string; costMicros: Micros }>
    env?: NodeJS.ProcessEnv
  },
): Promise<CheckOutcome> {
  const { target, providers } = args

  /**
   * Everything one SERP purchase needs, in one query.
   *
   * The niche fields are not decoration: `fetchOrganicSerp` takes a FixtureContext, and in
   * fixture mode the archetype generator uses them to synthesise a plausible SERP. Passing
   * placeholders would make the offline path produce results that look nothing like the
   * live one, which is how a fixture stops being a test.
   */
  const [ctx] = await db
    .select({
      keyword: serpKeywords.keyword,
      siteId: serpKeywords.siteId,
      domain: sites.domain,
      providerLocationCode: localities.providerLocationCode,
      localityName: localities.name,
      stateCode: localities.stateCode,
      nicheNoun: niches.keywordNoun,
      nicheEmdToken: niches.emdToken,
    })
    .from(serpKeywords)
    .innerJoin(sites, eq(sites.id, serpKeywords.siteId))
    .innerJoin(localities, eq(localities.id, sites.localityId))
    .innerJoin(niches, eq(niches.id, sites.nicheId))
    .where(eq(serpKeywords.id, target.keywordId))
    .limit(1)

  const base: CheckOutcome = {
    targetId: target.id,
    keyword: ctx?.keyword ?? '(unknown)',
    serpMeasured: false,
    serpPosition: null,
    serpPackPosition: null,
    serpSourceKind: null,
    ourDomainPosition: null,
    commentRank: null,
    commentPresent: null,
    costMicros: 0n,
    error: null,
  }

  if (ctx === undefined || ctx.providerLocationCode === null) {
    /**
     * No provider location code means the locality was never resolved, and `runScan` refuses
     * to buy a SERP for an unresolved locality because a widened code returns a well-formed
     * result for the wrong city. The same refusal applies here.
     */
    const outcome = {
      ...base,
      error:
        'The locality has no provider location code, so a SERP for it cannot be bought ' +
        'without widening to the wrong place.',
    }
    await writeCheck(db, outcome)
    return outcome
  }

  let costMicros = 0n
  let serpMeasured = false
  let serpPosition: number | null = null
  let serpPackPosition: number | null = null
  let serpSourceKind: SerpSourceKind | null = null
  let ourDomainPosition: number | null = null
  const errors: string[] = []

  // --- 1. Where does the thread rank? (organic AND discussions pack) -------
  try {
    // Detailed path: pack extraction needs raw DFS items. Snapshot stays organic-only
    // for our-domain rank (never poison scoring cache — we do not write raw here).
    const fetched = await providers.fetchOrganicSerpDetailed(
      {
        keyword: ctx.keyword,
        locationCode: ctx.providerLocationCode,
        localityName: ctx.localityName,
        stateCode: ctx.stateCode,
        nicheNoun: ctx.nicheNoun,
        nicheEmdToken: ctx.nicheEmdToken,
      },
      { depth: 100 },
    )
    costMicros += fetched.costMicros
    serpMeasured = true

    if (target.redditPostId) {
      const placement = findRedditPlacement(fetched.rawItems, target.redditPostId)
      serpPosition = placement.organicPosition
      serpPackPosition = placement.packPosition
      serpSourceKind = placement.sourceKind
    } else {
      // Non-Reddit / missing post id: fall back to URL match on organic only.
      const found = fetched.snapshot.items.find((i) =>
        urlsMatch(i.url, target.url, target.redditPostId),
      )
      serpPosition = found?.position ?? null
      serpSourceKind = found ? 'organic' : null
    }

    // Free from the same response: our own site's rank for this keyword.
    if (ctx.domain !== null) {
      ourDomainPosition =
        fetched.snapshot.items.find((i) => i.domain === ctx.domain)?.position ?? null
    }
  } catch (e) {
    errors.push(`SERP: ${(e as Error).message}`)
  }

  // --- 2. Where does our comment sit in the thread? ------------------------
  let commentRank: number | null = null
  let commentPresent: boolean | null = null

  if (target.commentId !== null && target.redditPostId !== null) {
    try {
      const page = await args.fetchPage(oldRedditThreadUrl(target.redditPostId))
      costMicros += page.costMicros

      const outcome = findCommentOrdinal(page.html, target.commentId)
      if (outcome.status === 'found') {
        commentRank = outcome.rank
        commentPresent = true
      } else if (outcome.status === 'absent') {
        // The ONLY path that writes false: a complete tree without our comment.
        commentPresent = false
      } else {
        // Blocked, truncated, or unparseable. NULL, with the reason recorded.
        commentPresent = null
        errors.push(`comment: ${outcome.reason}`)
      }
    } catch (e) {
      // A thrown fetch must never look like a deleted comment.
      commentPresent = null
      errors.push(`comment fetch: ${(e as Error).message}`)
    }
  }

  const outcome: CheckOutcome = {
    ...base,
    serpMeasured,
    serpPosition,
    serpPackPosition,
    serpSourceKind,
    ourDomainPosition,
    commentRank,
    commentPresent,
    costMicros,
    error: errors.length === 0 ? null : errors.join(' · '),
  }

  await writeCheck(db, outcome, { siteId: ctx.siteId, live: providers.live })
  return outcome
}

async function writeCheck(
  db: Database,
  outcome: CheckOutcome,
  opts: { siteId?: number; live?: boolean } = {},
): Promise<void> {
  await db.insert(serpChecks).values({
    targetId: outcome.targetId,
    serpMeasured: outcome.serpMeasured,
    serpPosition: outcome.serpPosition,
    serpPackPosition: outcome.serpPackPosition,
    serpSourceKind: outcome.serpSourceKind,
    ourDomainPosition: outcome.ourDomainPosition,
    commentRank: outcome.commentRank,
    commentPresent: outcome.commentPresent,
    measuredVia: outcome.serpMeasured ? (opts.live === false ? 'fixture' : 'dataforseo') : null,
    error: outcome.error,
    costMicros: outcome.costMicros,
  })

  // Every purchase gets a ledger row, so monitoring spend reconciles through the same path
  // as scans and calls rather than being merely tracked. Zero-cost fixture rows still
  // ledger so e2e can prove the path ran.
  if (outcome.costMicros > 0n || outcome.serpMeasured) {
    await db.insert(spendLedger).values({
      siteId: opts.siteId ?? null,
      scanRunId: null,
      endpoint: 'serp/monitor',
      costMicros: outcome.costMicros,
      note: `target ${outcome.targetId} · ${outcome.keyword}`,
    })
  }
}

/**
 * Does a SERP result point at the thread we are watching?
 *
 * Matched on the Reddit post id when we have one rather than on string equality: Google
 * reports the canonical `www.reddit.com/r/Sub/comments/<id>/<slug>/` while the stored URL
 * may be an `old.` host, carry a `?context=`, or end at a comment. Exact matching would
 * report a ranking thread as de-indexed.
 */
export function urlsMatch(serpUrl: string, storedUrl: string, postId: string | null): boolean {
  if (postId !== null && postId !== '') {
    return serpUrl.toLowerCase().includes(`/comments/${postId.toLowerCase()}`)
  }
  const norm = (u: string): string =>
    u.toLowerCase().replace(/^https?:\/\/(www\.|old\.|new\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
  return norm(serpUrl) === norm(storedUrl)
}

export { PRICE }

/** Targets due for a check, for a dry-run view of what a run would cost. */
export async function listDueTargets(db: Database, limit = 200) {
  return db
    .select({ target: serpTargets, keyword: serpKeywords.keyword, siteId: serpKeywords.siteId })
    .from(serpTargets)
    .innerJoin(serpKeywords, eq(serpTargets.keywordId, serpKeywords.id))
    .where(and(eq(serpTargets.active, true), lte(serpTargets.nextCheckAt, new Date())))
    .orderBy(serpTargets.nextCheckAt)
    .limit(limit)
}

export async function latestChecks(db: Database, targetId: number, limit = 2) {
  return db
    .select()
    .from(serpChecks)
    .where(eq(serpChecks.targetId, targetId))
    .orderBy(desc(serpChecks.checkedAt))
    .limit(limit)
}
