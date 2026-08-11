import { describe, expect, it } from 'vitest'
import {
  closeRate,
  dispositionLabel,
  MIN_OUTCOMES_FOR_RATE,
  realisedVsModelled,
  type LeadOutcomeRow,
} from './lead-outcome.js'
import { LEAD_DISPOSITIONS } from '../types.js'

const row = (
  leadId: number,
  disposition: LeadOutcomeRow['disposition'],
  jobValueMicros: bigint | null = null,
): LeadOutcomeRow => ({ leadId, disposition, jobValueMicros })

describe('closeRate', () => {
  it('is null below the minimum sample, not zero', () => {
    // A 0% close rate reads as "this market does not convert" -- a claim about the
    // world. With two data points the honest answer is that there is no rate yet.
    const stats = closeRate({ leadCount: 10, outcomes: [row(1, 'lost'), row(2, 'lost')] })
    expect(stats.recorded).toBe(2)
    expect(stats.rate).toBeNull()
    expect(stats.won).toBe(0)
  })

  it('reports coverage so a rate over 3 of 40 is distinguishable from 3 of 3', () => {
    const outcomes = [
      row(1, 'booked', 450_000_000n),
      row(2, 'lost'),
      row(3, 'lost'),
      row(4, 'no_answer'),
      row(5, 'quoted'),
    ]
    const sparse = closeRate({ leadCount: 40, outcomes })
    const complete = closeRate({ leadCount: 5, outcomes })

    expect(sparse.rate).toBe(complete.rate) // same rate...
    expect(sparse.coverage).toBeCloseTo(0.125) // ...very different confidence
    expect(complete.coverage).toBe(1)
  })

  it('excludes spam and duplicates from the denominator', () => {
    // They are not opportunities you failed to convert. Counting them makes a good
    // month look like a bad one.
    const outcomes = [
      row(1, 'booked', 100_000_000n),
      row(2, 'lost'),
      row(3, 'spam'),
      row(4, 'duplicate'),
      row(5, 'spam'),
    ]
    const stats = closeRate({ leadCount: 5, outcomes })
    expect(stats.recorded).toBe(5)
    expect(stats.opportunities).toBe(2)
    expect(stats.rate).toBe(0.5)
  })

  it('counts only booked as won -- a quote is not a sale', () => {
    const outcomes = [
      row(1, 'quoted', 900_000_000n),
      row(2, 'quoted'),
      row(3, 'quoted'),
      row(4, 'quoted'),
      row(5, 'quoted'),
    ]
    const stats = closeRate({ leadCount: 5, outcomes })
    expect(stats.won).toBe(0)
    expect(stats.rate).toBe(0)
    // And the quoted value is NOT summed as revenue.
    expect(stats.valueMicros).toBe(0n)
  })

  it('treats a booked job with no value as an undercount, not a $0 job', () => {
    const outcomes = [
      row(1, 'booked', 500_000_000n),
      row(2, 'booked', null),
      row(3, 'lost'),
      row(4, 'lost'),
      row(5, 'lost'),
    ]
    const stats = closeRate({ leadCount: 5, outcomes })
    expect(stats.won).toBe(2)
    expect(stats.valueMicros).toBe(500_000_000n)
    // Surfaced so the UI can say the total is a floor rather than the truth.
    expect(stats.wonWithoutValue).toBe(1)
  })

  it('leaves value per opportunity null when no won lead has a value', () => {
    const outcomes = [
      row(1, 'booked', null),
      row(2, 'lost'),
      row(3, 'lost'),
      row(4, 'lost'),
      row(5, 'lost'),
    ]
    expect(closeRate({ leadCount: 5, outcomes }).valuePerOpportunityMicros).toBeNull()
  })

  it('handles no leads and no outcomes without dividing by zero', () => {
    const empty = closeRate({ leadCount: 0, outcomes: [] })
    expect(empty.coverage).toBeNull()
    expect(empty.rate).toBeNull()
    expect(empty.valuePerOpportunityMicros).toBeNull()
    expect(empty.valueMicros).toBe(0n)
  })

  it('produces a rate once the sample is large enough', () => {
    const outcomes = Array.from({ length: MIN_OUTCOMES_FOR_RATE }, (_, i) =>
      i === 0 ? row(i, 'booked', 250_000_000n) : row(i, 'lost'),
    )
    const stats = closeRate({ leadCount: MIN_OUTCOMES_FOR_RATE, outcomes })
    expect(stats.rate).toBeCloseTo(1 / MIN_OUTCOMES_FOR_RATE)
    expect(stats.valuePerOpportunityMicros).toBe(250_000_000n / BigInt(MIN_OUTCOMES_FOR_RATE))
  })
})

describe('realisedVsModelled', () => {
  it('refuses to compare when outcomes were never recorded', () => {
    // "0.0x of modelled" for an unmeasured site would read as a failed prediction.
    const r = realisedVsModelled({
      modelledRentMicros: 800_000_000n,
      realisedMonthlyValueMicros: null,
    })
    expect(r.ratio).toBeNull()
    expect(r.note).toContain('nothing to compare')
  })

  it('refuses to compare when there is no modelled rent', () => {
    expect(
      realisedVsModelled({ modelledRentMicros: null, realisedMonthlyValueMicros: 500_000_000n })
        .ratio,
    ).toBeNull()
    expect(
      realisedVsModelled({ modelledRentMicros: 0n, realisedMonthlyValueMicros: 500_000_000n }).ratio,
    ).toBeNull()
  })

  it('computes a ratio and stays cautious about one site', () => {
    const under = realisedVsModelled({
      modelledRentMicros: 1_000_000_000n,
      realisedMonthlyValueMicros: 400_000_000n,
    })
    expect(under.ratio).toBeCloseTo(0.4)
    expect(under.note).toContain('anecdote')

    const over = realisedVsModelled({
      modelledRentMicros: 1_000_000_000n,
      realisedMonthlyValueMicros: 1_500_000_000n,
    })
    expect(over.ratio).toBeCloseTo(1.5)
  })
})

describe('dispositionLabel', () => {
  it('labels every disposition, so a new member cannot render blank', () => {
    for (const d of LEAD_DISPOSITIONS) {
      expect(dispositionLabel(d), d).toBeTruthy()
    }
  })
})
