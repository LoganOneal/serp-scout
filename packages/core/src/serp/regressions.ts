/**
 * Comparing the latest two checks for a monitored target.
 *
 * This module decides whether you get woken up, so its bias is deliberate: it alerts on a
 * CONFIRMED change and stays silent on an unmeasured one.
 *
 * ==================== NULL IS NOT A REGRESSION ====================
 * `commentPresent: null` means the fetch was blocked or the tree was truncated -- we do not
 * know. Treating that as "comment gone" would page you every time Reddit rate-limited a
 * crawler, and after the third false alarm you would stop reading the alerts, which costs
 * you the real one.
 *
 * `serpPosition: null` is DIFFERENT: there, null is a measurement. The row exists, we ran
 * the SERP, and the thread was not in the top 100. That IS the "post is not showing up"
 * signal you asked for, so it alerts -- but only when the previous check had a position to
 * fall from.
 * =================================================================
 *
 * Pure. No IO.
 */

export type SerpSourceKind = 'organic' | 'discussions_and_forums' | 'both'

export interface SerpCheckPoint {
  checkedAt: string
  /** NULL = ran the SERP and the thread was not in organic results. A measurement. */
  serpPosition: number | null
  /**
   * Position in the Discussions and Forums pack (1-based). Distinct from organic.
   * Pack-only threads have this set and serpPosition null — still "ranking".
   */
  serpPackPosition: number | null
  /**
   * Where the thread was found: organic | discussions_and_forums | both | null if neither.
   * null + serpMeasured means measured and absent from both surfaces.
   */
  serpSourceKind: SerpSourceKind | null
  /** Did the SERP call actually happen? False means position fields say nothing. */
  serpMeasured: boolean
  /** Ordinal among top-level comments. NULL = not measured. */
  commentRank: number | null
  /** true / false (confirmed absent) / null (could not measure). */
  commentPresent: boolean | null
  /** Your own domain's rank for this keyword, free from the same SERP response. */
  ourDomainPosition: number | null
}

export type RegressionKind =
  | 'thread_deindexed'
  | 'thread_slipped'
  | 'pack_dropped'
  | 'comment_removed'
  | 'comment_slipped'
  | 'our_domain_lost'

/** True when the thread was present on organic and/or the discussions pack. */
export function threadWasPresent(p: Pick<SerpCheckPoint, 'serpPosition' | 'serpPackPosition'>): boolean {
  return p.serpPosition !== null || p.serpPackPosition !== null
}

function describePlacement(p: Pick<SerpCheckPoint, 'serpPosition' | 'serpPackPosition'>): string {
  const parts: string[] = []
  if (p.serpPosition !== null) parts.push(`organic #${p.serpPosition}`)
  if (p.serpPackPosition !== null) parts.push(`Discussions #${p.serpPackPosition}`)
  return parts.length > 0 ? parts.join(' / ') : 'nowhere'
}

export interface Regression {
  kind: RegressionKind
  /** One line, written for a notification. */
  message: string
  /** 'high' when something disappeared, 'medium' when it merely moved. */
  severity: 'high' | 'medium'
  from: number | null
  to: number | null
}

/** A slip smaller than this is SERP noise, not a signal. */
export const SLIP_THRESHOLD = 3

export function detectRegressions(args: {
  keyword: string
  previous: SerpCheckPoint | null
  latest: SerpCheckPoint
}): Regression[] {
  const { keyword, previous, latest } = args

  // Nothing to compare against. A first check can never be a regression -- otherwise every
  // newly added target alerts the moment it is created.
  if (previous === null) return []

  const out: Regression[] = []

  // --- The thread's SERP position (organic and/or discussions pack) --------
  if (previous.serpMeasured && latest.serpMeasured) {
    const wasPresent = threadWasPresent(previous)
    const isPresent = threadWasPresent(latest)

    if (wasPresent && !isPresent) {
      out.push({
        kind: 'thread_deindexed',
        severity: 'high',
        from: previous.serpPosition ?? previous.serpPackPosition,
        to: null,
        message:
          `"${keyword}": the thread was at ${describePlacement(previous)} and is now ` +
          `nowhere on page 1 (organic or Discussions pack).`,
      })
    } else if (
      previous.serpPosition !== null &&
      latest.serpPosition !== null &&
      latest.serpPosition - previous.serpPosition >= SLIP_THRESHOLD
    ) {
      out.push({
        kind: 'thread_slipped',
        severity: 'medium',
        from: previous.serpPosition,
        to: latest.serpPosition,
        message: `"${keyword}": the thread slipped from #${previous.serpPosition} to #${latest.serpPosition}.`,
      })
    } else if (
      // Phase-2 optional: left the pack but still ranks organically.
      previous.serpPackPosition !== null &&
      latest.serpPackPosition === null &&
      latest.serpPosition !== null
    ) {
      out.push({
        kind: 'pack_dropped',
        severity: 'medium',
        from: previous.serpPackPosition,
        to: null,
        message:
          `"${keyword}": the thread left the Discussions pack (was #${previous.serpPackPosition}) ` +
          `but still ranks organically at #${latest.serpPosition}.`,
      })
    }
  }

  // --- Our comment ----------------------------------------------------------
  /**
   * Only a true -> false transition counts. `null` on either side means we could not
   * measure, and an unmeasured check must not be able to raise an alarm.
   */
  if (previous.commentPresent === true && latest.commentPresent === false) {
    out.push({
      kind: 'comment_removed',
      severity: 'high',
      from: previous.commentRank,
      to: null,
      message: `"${keyword}": our comment is no longer in the thread (it was #${previous.commentRank ?? '?'}).`,
    })
  } else if (
    previous.commentRank !== null &&
    latest.commentRank !== null &&
    latest.commentRank > previous.commentRank
  ) {
    // Any drop in comment ordering is worth knowing -- unlike SERP positions there is no
    // churn here, so a change is a real change.
    out.push({
      kind: 'comment_slipped',
      severity: 'medium',
      from: previous.commentRank,
      to: latest.commentRank,
      message: `"${keyword}": our comment moved from #${previous.commentRank} to #${latest.commentRank} in the thread.`,
    })
  }

  // --- Our own site, free from the same SERP call ---------------------------
  if (
    previous.serpMeasured &&
    latest.serpMeasured &&
    previous.ourDomainPosition !== null &&
    latest.ourDomainPosition === null
  ) {
    out.push({
      kind: 'our_domain_lost',
      severity: 'high',
      from: previous.ourDomainPosition,
      to: null,
      message: `"${keyword}": our own site was at #${previous.ourDomainPosition} and is now out of the top 100.`,
    })
  }

  return out
}

/**
 * How much of a target's history is actually measured.
 *
 * Surfaced next to any comment-rank number for the same reason `weightCovered` sits next to
 * difficulty: "rank 4" from a target whose last six checks were all blocked is a stale
 * number wearing a confident face.
 */
export function measurementCoverage(checks: readonly SerpCheckPoint[]): {
  total: number
  commentMeasured: number
  serpMeasured: number
  /** 0..1, or null when there is nothing to divide by. */
  commentCoverage: number | null
} {
  const total = checks.length
  const commentMeasured = checks.filter((c) => c.commentPresent !== null).length
  const serpMeasured = checks.filter((c) => c.serpMeasured).length
  return {
    total,
    commentMeasured,
    serpMeasured,
    commentCoverage: total === 0 ? null : commentMeasured / total,
  }
}
