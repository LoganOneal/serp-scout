import { describe, expect, it } from 'vitest'
import { scoreLeadGenNiche } from './lead-gen-score.js'

const usd = (n: number) => BigInt(Math.round(n * 1_000_000))

describe('scoreLeadGenNiche', () => {
  it('ranks high volume high ticket above low ticket', () => {
    const hi = scoreLeadGenNiche({
      volume: 40_000,
      avgTicketMicros: usd(8000),
      leadCommissionRateBps: 1000,
      leadValueMicros: null,
      competitionIndex: 40,
      topOfPageBidHighMicros: usd(8),
    })
    const lo = scoreLeadGenNiche({
      volume: 40_000,
      avgTicketMicros: usd(120),
      leadCommissionRateBps: 1500,
      leadValueMicros: null,
      competitionIndex: 40,
      topOfPageBidHighMicros: usd(8),
    })
    expect(hi.compositeScore).not.toBeNull()
    expect(lo.compositeScore).not.toBeNull()
    expect(hi.compositeScore!).toBeGreaterThan(lo.compositeScore!)
    expect(hi.leadValueMicros).toBe(800_000_000) // $800 lead at 10% of $8k
  })

  it('boosts reddit priority when paid competition is high', () => {
    const base = {
      volume: 10_000,
      avgTicketMicros: usd(500),
      leadCommissionRateBps: 1200,
      leadValueMicros: null as bigint | null,
      topOfPageBidHighMicros: usd(5),
    }
    const lowComp = scoreLeadGenNiche({ ...base, competitionIndex: 20 })
    const highComp = scoreLeadGenNiche({ ...base, competitionIndex: 85 })
    expect(highComp.redditPriorityScore!).toBeGreaterThanOrEqual(lowComp.redditPriorityScore! - 1)
    expect(highComp.adsFitScore!).toBeLessThan(lowComp.adsFitScore!)
  })

  it('returns null scores when nothing measured', () => {
    const s = scoreLeadGenNiche({
      volume: null,
      avgTicketMicros: null,
      leadCommissionRateBps: null,
      leadValueMicros: null,
      competitionIndex: null,
      topOfPageBidHighMicros: null,
    })
    expect(s.compositeScore).toBeNull()
  })
})
