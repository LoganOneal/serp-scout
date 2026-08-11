import type { OutcomeDayOffset, OutcomeRow, Verdict } from './types.js'

/**
 * Calibration: does the model's own claim survive contact with real builds?
 *
 * Every threshold in priors.ts came from published research about the web in
 * general, not from this operator's sites. Until this file has data, the 30-day
 * verdict is a claim about a model. That is the whole reason it must be reported
 * with sample size attached and never as a bare percentage.
 */

/** A build counts as a hit for a band if it reached the top 10 by that band's deadline. */
export const BAND_DEADLINE_DAYS: Record<Exclude<Verdict, 'not_winnable' | 'unknown'>, number> = {
  likely_30d: 30,
  likely_90d: 90,
  likely_6m: 90, // 6-month claims are evaluated at the last check we take.
}

export const TOP_10 = 10

export interface BandStats {
  verdict: Verdict
  /**
   * Number of BUILDS evaluated. Always present, never optional -- the UI must
   * be unable to render "100%" without "of 3" beside it.
   */
  n: number
  hits: number
  /** null when n === 0. Not 0 -- an unmeasured rate is not a rate of zero. */
  rate: number | null
}

/**
 * Group outcome rows into per-build results, then per-band hit rates.
 *
 * Bands are compared against `verdictAtSave`, FROZEN on the shortlist item at
 * decision time. Joining to a live score instead would compare today's
 * thresholds against yesterday's build, and every band would validate itself:
 * change a constant, and the historical predictions silently change to match.
 */
export function hitRateByBand(rows: OutcomeRow[]): BandStats[] {
  const byBuild = new Map<number, OutcomeRow[]>()
  for (const r of rows) {
    const list = byBuild.get(r.shortlistItemId)
    if (list) list.push(r)
    else byBuild.set(r.shortlistItemId, [r])
  }

  const bands: Verdict[] = ['likely_30d', 'likely_90d', 'likely_6m', 'not_winnable', 'unknown']
  const tally = new Map<Verdict, { n: number; hits: number }>()
  for (const b of bands) tally.set(b, { n: 0, hits: 0 })

  for (const [, buildRows] of byBuild) {
    const verdict = buildRows[0]!.verdictAtSave
    const deadline = BAND_DEADLINE_DAYS[verdict as keyof typeof BAND_DEADLINE_DAYS]
    // No deadline defined (not_winnable / unknown): still counted in n, so the
    // denominator reflects every build actually made, but a "hit" is any top-10
    // appearance at all -- which for not_winnable is a model FAILURE, and worth
    // seeing rather than hiding.
    const relevant =
      deadline === undefined ? buildRows : buildRows.filter((r) => r.dayOffset <= deadline)

    // A build is only counted once we have at least one CHECK for it. The row
    // existing is the measurement; `position === null` is a checked miss.
    if (relevant.length === 0) continue

    const entry = tally.get(verdict)!
    entry.n += 1
    if (relevant.some((r) => r.position !== null && r.position <= TOP_10)) entry.hits += 1
  }

  return bands.map((verdict) => {
    const { n, hits } = tally.get(verdict)!
    return { verdict, n, hits, rate: n === 0 ? null : hits / n }
  })
}

/** Per-check coverage, so the panel can say how many builds have reached day 30 yet. */
export function checkCoverage(rows: OutcomeRow[]): Record<OutcomeDayOffset, number> {
  const out = { 7: 0, 14: 0, 30: 0, 60: 0, 90: 0 } as Record<OutcomeDayOffset, number>
  for (const r of rows) out[r.dayOffset] = (out[r.dayOffset] ?? 0) + 1
  return out
}

export interface OrderingCheck {
  /** null = not enough data in enough bands to say anything. */
  sound: boolean | null
  violations: { worse: Verdict; better: Verdict; worseRate: number; betterRate: number }[]
  /** Bands that had enough builds to participate. */
  evaluated: { verdict: Verdict; n: number; rate: number }[]
  note: string
}

/**
 * PRIOR. Minimum builds in a band before its rate is allowed to participate in
 * the ordering check. Below this, one lucky build flips the verdict.
 */
export const MIN_N_FOR_ORDERING = 3

/**
 * Is the model ordering SERPs correctly? likely_30d must outperform likely_90d
 * must outperform likely_6m.
 *
 * WHY THIS AND NOT ABSOLUTE RATES: ordering is answerable at far smaller n than
 * any absolute hit rate, because it needs only relative comparison. And it fails
 * for a different reason: a violation means the model is READING SERPS WRONG --
 * it cannot tell an easy page from a hard one -- rather than that a constant
 * needs nudging. Those need entirely different fixes, so they should not be
 * diagnosed by the same number.
 */
export function isOrderingSound(stats: BandStats[]): OrderingCheck {
  const order: Verdict[] = ['likely_30d', 'likely_90d', 'likely_6m']
  const byVerdict = new Map(stats.map((s) => [s.verdict, s]))

  const evaluated = order
    .map((v) => byVerdict.get(v))
    .filter(
      (s): s is BandStats & { rate: number } =>
        s !== undefined && s.rate !== null && s.n >= MIN_N_FOR_ORDERING,
    )
    .map((s) => ({ verdict: s.verdict, n: s.n, rate: s.rate }))

  if (evaluated.length < 2) {
    return {
      sound: null,
      violations: [],
      evaluated,
      note: `Needs at least two bands with >= ${MIN_N_FOR_ORDERING} builds each. Currently ${evaluated.length}.`,
    }
  }

  const violations: OrderingCheck['violations'] = []
  for (let i = 0; i < evaluated.length - 1; i++) {
    const better = evaluated[i]!
    const worse = evaluated[i + 1]!
    if (worse.rate > better.rate) {
      violations.push({
        better: better.verdict,
        worse: worse.verdict,
        betterRate: better.rate,
        worseRate: worse.rate,
      })
    }
  }

  return {
    sound: violations.length === 0,
    violations,
    evaluated,
    note:
      violations.length === 0
        ? `Ordering holds across ${evaluated.length} bands.`
        : 'Ordering VIOLATED. The model is misreading SERPs, not mis-tuned -- a constant nudge will not fix this.',
  }
}

/**
 * The dates a build should be re-checked on.
 *
 * These checks must NOT be cache-first. The cached SERP snapshot predates the
 * site by definition, so serving it would record every build as never having
 * ranked -- turning the entire calibration loop into a machine for confirming
 * that nothing ever works.
 */
export function dueOutcomeChecks(args: {
  buildStartedAt: Date
  now: Date
  alreadyChecked: OutcomeDayOffset[]
}): OutcomeDayOffset[] {
  const elapsedDays = Math.floor(
    (args.now.getTime() - args.buildStartedAt.getTime()) / 86_400_000,
  )
  const done = new Set(args.alreadyChecked)
  return ([7, 14, 30, 60, 90] as const).filter((d) => elapsedDays >= d && !done.has(d))
}
