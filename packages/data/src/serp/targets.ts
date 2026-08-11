import 'server-only'
import { and, desc, eq, sql } from 'drizzle-orm'
import { detectRegressions, parseRedditPermalink, type Regression } from '@rnr/core'
import type { Database } from '../db.js'
import { serpChecks, serpKeywords, serpTargets, type SerpCheck, type SerpTarget } from '../schema.js'

/** Monitored URLs and their latest measurements. */

export class SerpTargetError extends Error {}

/**
 * Attach a Reddit thread (and optionally our comment on it) to a keyword.
 *
 * The permalink is parsed rather than trusted: without a post id there is nothing to fetch,
 * and without a comment id there is no ordinal to measure. Refusing here beats storing a
 * target that can only ever produce "could not measure".
 */
export async function addSerpTarget(
  db: Database,
  args: { keywordId: number; permalinkOrUrl: string; label?: string | null },
): Promise<SerpTarget> {
  const parsed = parseRedditPermalink(args.permalinkOrUrl)
  if (parsed === null) {
    throw new SerpTargetError(
      `"${args.permalinkOrUrl}" is not a Reddit thread or comment link. ` +
        'Share links (/s/…) carry no ids — open the comment and copy its full permalink.',
    )
  }

  // Stored canonically so the same thread pasted in two forms is one target, while the
  // permalink is kept verbatim because it is what identifies OUR comment.
  const canonicalUrl = `https://www.reddit.com/comments/${parsed.postId}/`

  const [row] = await db
    .insert(serpTargets)
    .values({
      keywordId: args.keywordId,
      url: canonicalUrl,
      platform: 'reddit',
      redditPostId: parsed.postId,
      commentPermalink: parsed.commentId === null ? null : args.permalinkOrUrl.trim(),
      commentId: parsed.commentId,
      label: args.label?.trim() || (parsed.subreddit === null ? null : `r/${parsed.subreddit}`),
      active: true,
    })
    .onConflictDoUpdate({
      target: [serpTargets.keywordId, serpTargets.url],
      set: {
        commentPermalink: parsed.commentId === null ? null : args.permalinkOrUrl.trim(),
        commentId: parsed.commentId,
        active: true,
      },
    })
    .returning()

  return row!
}

export async function setTargetActive(db: Database, targetId: number, active: boolean): Promise<void> {
  await db.update(serpTargets).set({ active }).where(eq(serpTargets.id, targetId))
}

export async function deleteSerpTarget(db: Database, targetId: number): Promise<void> {
  await db.delete(serpTargets).where(eq(serpTargets.id, targetId))
}

export interface SerpTargetRow {
  target: SerpTarget
  keyword: string
  /** Most recent measurement, or null when never checked. */
  latest: SerpCheck | null
  /** Comparison of the latest two checks. Empty when there is nothing to compare. */
  regressions: Regression[]
}

/**
 * Every monitored target for a cell, with its latest state and any regression.
 *
 * The two most recent checks per target are fetched so `detectRegressions` can compare them.
 * A single check can never be a regression -- otherwise every newly added target alerts the
 * moment it is created.
 */
export async function listSerpTargets(db: Database, siteId: number): Promise<SerpTargetRow[]> {
  const rows = await db
    .select({ target: serpTargets, keyword: serpKeywords.keyword })
    .from(serpTargets)
    .innerJoin(serpKeywords, eq(serpTargets.keywordId, serpKeywords.id))
    .where(eq(serpKeywords.siteId, siteId))
    .orderBy(desc(serpTargets.active), serpTargets.nextCheckAt)

  const out: SerpTargetRow[] = []
  for (const r of rows) {
    const checks = await db
      .select()
      .from(serpChecks)
      .where(eq(serpChecks.targetId, r.target.id))
      .orderBy(desc(serpChecks.checkedAt))
      .limit(2)

    const latest = checks[0] ?? null
    const previous = checks[1] ?? null

    const regressions =
      latest === null
        ? []
        : detectRegressions({
            keyword: r.keyword,
            previous: previous === null ? null : toPoint(previous),
            latest: toPoint(latest),
          })

    out.push({ target: r.target, keyword: r.keyword, latest, regressions })
  }
  return out
}

function toPoint(c: SerpCheck) {
  return {
    checkedAt: c.checkedAt.toISOString(),
    serpPosition: c.serpPosition,
    serpPackPosition: c.serpPackPosition ?? null,
    serpSourceKind: (c.serpSourceKind as
      | 'organic'
      | 'discussions_and_forums'
      | 'both'
      | null) ?? null,
    serpMeasured: c.serpMeasured,
    commentRank: c.commentRank,
    commentPresent: c.commentPresent,
    ourDomainPosition: c.ourDomainPosition,
  }
}

/**
 * Regression count for a cell, for the markets list.
 *
 * Counts only CONFIRMED changes -- `detectRegressions` stays silent on anything unmeasured,
 * so a cell whose checks were all blocked reports 0 rather than a wall of false alarms.
 */
export async function countRegressions(db: Database, siteId: number): Promise<number> {
  const targets = await listSerpTargets(db, siteId)
  return targets.reduce((n, t) => n + t.regressions.length, 0)
}

/** Monitoring spend for a cell today, for the cost line on the markets list. */
export async function monitoringSpendToday(db: Database, siteId: number): Promise<string> {
  const [row] = await db
    .select({ total: sql<string>`COALESCE(sum(cost_micros), 0)::text` })
    .from(serpChecks)
    .innerJoin(serpTargets, eq(serpChecks.targetId, serpTargets.id))
    .innerJoin(serpKeywords, eq(serpTargets.keywordId, serpKeywords.id))
    .where(
      and(eq(serpKeywords.siteId, siteId), sql`${serpChecks.checkedAt} >= date_trunc('day', now())`),
    )
  return row?.total ?? '0'
}
