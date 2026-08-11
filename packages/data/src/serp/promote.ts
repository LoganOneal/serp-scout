import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { oldRedditThreadUrl, PRICE, probeCommentability } from '@rnr/core'
import type { Database } from '../db.js'
import {
  discoveryHits,
  discoveryNiches,
  localities,
  niches,
  serpKeywords,
  sites,
  spendLedger,
  type DiscoveryHit,
  type Site,
} from '../schema.js'
import { createSite } from '../sites.js'
import { addSerpTarget } from './targets.js'
import { ensureKeywordVolumesFromEnv } from './keyword-volume-cache.js'
import { createProviders } from '../providers/index.js'

/**
 * Promote a discovery hit into a market cell + SERP monitoring target.
 *
 * Get-or-create site by (locality, niche). Volume from DataForSEO Keywords Data
 * (local location_code) when live.
 */

export class PromoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromoteError'
  }
}

export interface PromoteResult {
  siteId: number
  keywordId: number
  targetId: number
  /** True when we re-used an existing promote. */
  idempotent: boolean
  warning: string | null
  volume: number | null
  volumeSource: string
  commentable: boolean | null
}

export async function getOrCreateSiteForCell(
  db: Database,
  args: { localityId: number; nicheId: number },
): Promise<Site> {
  const [existing] = await db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.localityId, args.localityId),
        eq(sites.nicheId, args.nicheId),
        sql`${sites.status} <> 'dropped'`,
      ),
    )
    .limit(1)
  if (existing) return existing

  try {
    return await createSite(db, {
      localityId: args.localityId,
      nicheId: args.nicheId,
      domain: null,
      status: 'building',
    })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    // Concurrent promote: both saw no row; one wins sites_active_cell_uq.
    if (!/sites_active_cell_uq|unique|duplicate/i.test(msg)) throw e
    const [winner] = await db
      .select()
      .from(sites)
      .where(
        and(
          eq(sites.localityId, args.localityId),
          eq(sites.nicheId, args.nicheId),
          sql`${sites.status} <> 'dropped'`,
        ),
      )
      .limit(1)
    if (!winner) throw e
    return winner
  }
}

/**
 * Map a discovery CSV niche row onto a seeded `niches` id.
 * Cascades to all hits for that discovery niche so deep-links and promote work.
 */
export async function mapDiscoveryNiche(
  db: Database,
  args: { discoveryNicheId: number; nicheId: number },
): Promise<void> {
  await db
    .update(discoveryNiches)
    .set({ nicheId: args.nicheId })
    .where(eq(discoveryNiches.id, args.discoveryNicheId))
  await db
    .update(discoveryHits)
    .set({ nicheId: args.nicheId })
    .where(eq(discoveryHits.discoveryNicheId, args.discoveryNicheId))
}

/**
 * Promote one discovery hit into monitoring.
 *
 * Idempotent: if already promoted, returns existing FKs.
 */
export async function promoteDiscoveryHit(
  db: Database,
  args: {
    hitId: number
    /** Required if discovery_niches.niche_id is still null. */
    nicheId?: number
    commentPermalink?: string | null
    /** Skip Google Ads volume lookup. */
    skipVolume?: boolean
  },
): Promise<PromoteResult> {
  const [hit] = await db.select().from(discoveryHits).where(eq(discoveryHits.id, args.hitId)).limit(1)
  if (!hit) throw new PromoteError(`Discovery hit ${args.hitId} not found.`)

  // Idempotent re-promote.
  if (hit.promotedTargetId !== null && hit.promotedSiteId !== null && hit.promotedKeywordId !== null) {
    return {
      siteId: hit.promotedSiteId,
      keywordId: hit.promotedKeywordId,
      targetId: hit.promotedTargetId,
      idempotent: true,
      warning: null,
      volume: null,
      volumeSource: 'unchanged',
      commentable: hit.commentable,
    }
  }

  if (hit.localityId === null) {
    throw new PromoteError('This hit has no locality — cannot promote to a market cell.')
  }

  const [dn] = hit.discoveryNicheId
    ? await db
        .select()
        .from(discoveryNiches)
        .where(eq(discoveryNiches.id, hit.discoveryNicheId))
        .limit(1)
    : []

  let nicheId = args.nicheId ?? dn?.nicheId ?? hit.nicheId
  if (nicheId === null || nicheId === undefined) {
    throw new PromoteError(
      'Map this discovery niche to a seeded niche before promoting (pass nicheId).',
    )
  }

  // Persist map if newly provided.
  if (dn && dn.nicheId === null && hit.discoveryNicheId) {
    await mapDiscoveryNiche(db, { discoveryNicheId: hit.discoveryNicheId, nicheId })
  }

  const site = await getOrCreateSiteForCell(db, {
    localityId: hit.localityId,
    nicheId,
  })

  // Local volume via DataForSEO Keywords Data + locality location_code.
  let volume: number | null = null
  let volumeSource = 'skipped'
  if (!args.skipVolume) {
    const [loc] = hit.localityId
      ? await db
          .select({ code: localities.providerLocationCode })
          .from(localities)
          .where(eq(localities.id, hit.localityId))
          .limit(1)
      : []
    // ONE KEYWORD, and DataForSEO bills per REQUEST -- so this was $0.09 to
    // price a single phrase, the exact unbatched shape that made a 50x50 run
    // cost $225. Google Ads answers the same question for nothing, and the
    // 30-day cache means promoting a second hit in the same market is free.
    const vol = await ensureKeywordVolumesFromEnv(db, {
      keywords: [hit.keyword],
      locationCode: loc?.code ?? null,
      ...(hit.runId == null ? {} : { runId: hit.runId }),
    })
    const cached = vol.volumes.get(hit.keyword.trim().toLowerCase())
    volumeSource = cached?.source ?? 'no_data'
    volume = cached?.avgMonthlySearches ?? null
  }

  const importBatch = `discovery:${hit.runId}`
  const [kw] = await db
    .insert(serpKeywords)
    .values({
      siteId: site.id,
      keyword: hit.keyword,
      volume,
      difficulty: null,
      cpcMicros: null,
      semrushPosition: null,
      semrushUrl: null,
      importBatch,
      active: true,
    })
    .onConflictDoUpdate({
      target: [serpKeywords.siteId, serpKeywords.keyword],
      // Preserve existing Semrush/Google metadata: only fill volume when currently null.
      set: {
        active: true,
        importBatch: sql`CASE
          WHEN ${serpKeywords.importBatch} LIKE 'discovery:%' THEN excluded.import_batch
          ELSE ${serpKeywords.importBatch}
        END`,
        volume: sql`COALESCE(${serpKeywords.volume}, excluded.volume)`,
      },
    })
    .returning()

  const keywordId = kw!.id

  const packLabel =
    hit.sourceKind === 'discussions_and_forums'
      ? 'discussions pack'
      : hit.sourceKind === 'organic'
        ? 'organic'
        : hit.sourceKind

  const sub = hit.subreddit ? `r/${hit.subreddit}` : null
  const label = [sub, packLabel].filter(Boolean).join(' · ') || null

  // Prefer operator comment permalink; else post URL for post-only watch.
  const permalink =
    args.commentPermalink?.trim() ||
    hit.redditUrl ||
    `https://www.reddit.com/comments/${hit.redditPostId}/`

  const target = await addSerpTarget(db, {
    keywordId,
    permalinkOrUrl: permalink,
    label,
  })

  // Commentability probe on promote (default mode) — site ledger, not run reserve.
  let commentable = hit.commentable
  let warning: string | null = null
  if (commentable === null) {
    commentable = await probeHitOnPromote(db, {
      hit,
      siteId: site.id,
      redditPostId: hit.redditPostId,
    })
  }
  if (commentable === false) {
    warning =
      'Thread is not commentable (archived, locked, or OP deleted). SERP watch still enabled.'
  }

  await db
    .update(discoveryHits)
    .set({
      promotedSiteId: site.id,
      promotedKeywordId: keywordId,
      promotedTargetId: target.id,
      nicheId,
      commentable,
      commentableCheckedAt: hit.commentableCheckedAt ?? new Date(),
    })
    .where(eq(discoveryHits.id, hit.id))

  return {
    siteId: site.id,
    keywordId,
    targetId: target.id,
    idempotent: false,
    warning,
    volume,
    volumeSource,
    commentable,
  }
}

/**
 * on_promote probe: site ledger, uncapped vs monitor daily cap, fail → NULL.
 */
async function probeHitOnPromote(
  db: Database,
  args: { hit: DiscoveryHit; siteId: number; redditPostId: string },
): Promise<boolean | null> {
  const providers = createProviders()
  const cost = providers.live ? PRICE.onPageInstantPage : 0n
  let commentable: boolean | null = null
  let detail: string | null = null

  try {
    const page = await providers.fetchPageHtml(oldRedditThreadUrl(args.redditPostId))
    const outcome = probeCommentability(page.html)
    if (outcome.status === 'open') {
      commentable = true
      detail = 'open'
    } else if (outcome.status === 'closed') {
      commentable = false
      detail = outcome.reasons.join(',')
    } else {
      commentable = null
      detail = outcome.reason
    }
  } catch (e) {
    commentable = null
    detail = `fetch failed: ${(e as Error).message}`
  }

  await db
    .update(discoveryHits)
    .set({
      commentable,
      commentableDetail: detail,
      commentableCheckedAt: new Date(),
    })
    .where(eq(discoveryHits.id, args.hit.id))

  await db.insert(spendLedger).values({
    siteId: args.siteId,
    discoveryRunId: args.hit.runId,
    scanRunId: null,
    endpoint: 'serp/discovery/commentability',
    costMicros: cost,
    note: `on_promote hit ${args.hit.id}`,
  })

  return commentable
}

/** Resolve market URL pieces for a promoted / promotable hit. */
export async function marketPathForHit(
  db: Database,
  hitId: number,
): Promise<{ localitySlug: string; nicheSlug: string } | null> {
  const [hit] = await db.select().from(discoveryHits).where(eq(discoveryHits.id, hitId)).limit(1)
  if (!hit?.localityId || !hit.nicheId) return null
  const [loc] = await db
    .select({ slug: localities.slug })
    .from(localities)
    .where(eq(localities.id, hit.localityId))
  const [n] = await db.select({ slug: niches.slug }).from(niches).where(eq(niches.id, hit.nicheId))
  if (!loc || !n) return null
  return { localitySlug: loc.slug, nicheSlug: n.slug }
}
