import {
  NON_OPPORTUNITY_DISPOSITIONS,
  WON_DISPOSITIONS,
  type LeadDisposition,
} from '../types.js'

/**
 * Close rate and realised value from recorded lead outcomes.
 *
 * ==================== THIS IS THE OTHER HALF OF THE RENT MODEL ====================
 * `modelRent()` multiplies an ESTIMATED monthly search volume by a PRIOR
 * (`valuePerSearchMicros`) and clamps it between a floor and a ceiling. Nothing in the
 * research half can test whether that prior is right -- ranking proves the site can be
 * found, and call volume proves people dial it, but only a booked job with a dollar
 * figure proves what a lead is worth.
 *
 * So this computes realised value per lead, and the site page shows it beside the
 * modelled figure.
 * ==============================================================================
 *
 * Pure. Takes plain rows, returns plain numbers.
 */

/** Below this many recorded outcomes, `rate` is null rather than a number. */
export const MIN_OUTCOMES_FOR_RATE = 5

export interface LeadOutcomeRow {
  leadId: number
  disposition: LeadDisposition
  /** NULL = booked but the value was never recorded. NOT zero. */
  jobValueMicros: bigint | null
}

export interface CloseRateStats {
  /** Leads that exist in the period, whether or not an outcome was recorded. */
  leads: number
  /** Leads with a recorded outcome. */
  recorded: number
  /**
   * `recorded / leads`, 0..1. Shown beside every rate below.
   *
   * A 100% close rate over 3 of 40 leads is not the same claim as over 40 of 40, and
   * without coverage on screen the two are indistinguishable -- the same argument as
   * `weightCovered` sitting next to every difficulty score.
   */
  coverage: number | null
  /**
   * Recorded outcomes that were real opportunities: spam and duplicates removed.
   * This is the close-rate denominator.
   */
  opportunities: number
  won: number
  /**
   * NULL below MIN_OUTCOMES_FOR_RATE, or when there are no opportunities.
   *
   * Never 0 for "no data" -- a 0% close rate reads as "this site does not convert",
   * which is a claim about the market rather than about the sample size.
   */
  rate: number | null
  /** Summed job value of won leads. Nulls are skipped, not counted as zero. */
  valueMicros: bigint
  /** Won leads that had no value recorded, so `valueMicros` is a known undercount. */
  wonWithoutValue: number
  /**
   * Realised value per OPPORTUNITY, micros. Null when there is nothing to divide by,
   * or when every won lead is missing its value.
   */
  valuePerOpportunityMicros: bigint | null
}

export function closeRate(args: {
  /** Total leads in the period, including ones with no outcome recorded. */
  leadCount: number
  outcomes: readonly LeadOutcomeRow[]
}): CloseRateStats {
  const { leadCount, outcomes } = args
  const recorded = outcomes.length

  const opportunityRows = outcomes.filter(
    (o) => !NON_OPPORTUNITY_DISPOSITIONS.includes(o.disposition),
  )
  const wonRows = outcomes.filter((o) => WON_DISPOSITIONS.includes(o.disposition))

  let valueMicros = 0n
  let wonWithoutValue = 0
  for (const w of wonRows) {
    if (w.jobValueMicros === null) wonWithoutValue++
    else valueMicros += w.jobValueMicros
  }

  const opportunities = opportunityRows.length
  const rate =
    recorded < MIN_OUTCOMES_FOR_RATE || opportunities === 0 ? null : wonRows.length / opportunities

  return {
    leads: leadCount,
    recorded,
    coverage: leadCount === 0 ? null : recorded / leadCount,
    opportunities,
    won: wonRows.length,
    rate,
    valueMicros,
    wonWithoutValue,
    valuePerOpportunityMicros:
      opportunities === 0 || valueMicros === 0n ? null : valueMicros / BigInt(opportunities),
  }
}

/**
 * How the realised figure compares with the modelled one.
 *
 * Returns null rather than a ratio when either side is unknown. A "0.0x of modelled"
 * for a site nobody has recorded outcomes on would read as a failed prediction when it
 * is only an unmeasured one -- the governing rule of this codebase, applied to the
 * comparison it was built to make.
 */
export function realisedVsModelled(args: {
  modelledRentMicros: bigint | null
  realisedMonthlyValueMicros: bigint | null
}): { ratio: number | null; note: string } {
  const { modelledRentMicros, realisedMonthlyValueMicros } = args

  if (modelledRentMicros === null || modelledRentMicros === 0n) {
    return { ratio: null, note: 'No modelled rent to compare against.' }
  }
  if (realisedMonthlyValueMicros === null) {
    return { ratio: null, note: 'No lead outcomes recorded yet, so there is nothing to compare.' }
  }

  const ratio = Number(realisedMonthlyValueMicros) / Number(modelledRentMicros)
  return {
    ratio,
    note:
      ratio >= 1
        ? 'Realised value meets or exceeds the modelled rent.'
        : 'Realised value is below the modelled rent. One site is an anecdote, not a calibration.',
  }
}

/** Human label for a disposition. */
export function dispositionLabel(d: LeadDisposition): string {
  switch (d) {
    case 'booked':
      return 'booked'
    case 'quoted':
      return 'quoted, not closed'
    case 'no_answer':
      return 'could not reach'
    case 'not_qualified':
      return 'not qualified'
    case 'spam':
      return 'spam'
    case 'duplicate':
      return 'duplicate'
    case 'lost':
      return 'lost'
  }
}
