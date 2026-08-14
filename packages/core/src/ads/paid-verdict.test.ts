import { describe, expect, it } from 'vitest'
import { INCREMENTALITY_BPS, estimateIncrementality } from './incrementality.js'
import { computeBreakEven } from './breakeven.js'
import { assessPaidKeyword, type PaidVerdictInput } from './paid-verdict.js'

/**
 * Hotel affiliate economics: a $300 booking at 4% commission = $12 per booking.
 * The same worked example as plan-paid-search.md §2.2, so the doc and the code
 * cannot drift apart silently.
 */
const HOTEL = { orderValueMicros: 300_000_000n, commissionRateBps: 400 }

const base: PaidVerdictInput = {
  keywordNorm: 'hotels with hot tubs in room las vegas',
  volume: 1900,
  organicPosition: null,
  positionMeasured: true,
  bidLowMicros: 800_000n,
  bidHighMicros: 1_200_000n,
  hasAiOverview: false,
  economics: HOTEL,
  achievedConversionBps: 300, // 3%
}

describe('incrementality is keyed on organic rank', () => {
  it('rank 1 is 50% — half of every paid click is cannibalised from ourselves', () => {
    const r = estimateIncrementality({ organicPosition: 1, positionMeasured: true })
    expect(r?.bps).toBe(INCREMENTALITY_BPS.rank1)
    expect(r?.costMultiplier).toBe(2)
  })

  it('ranks 2-4 are 82%', () => {
    expect(estimateIncrementality({ organicPosition: 3, positionMeasured: true })?.bps).toBe(8_200)
  })

  it('rank 5+ is 96% — paid is nearly pure addition', () => {
    expect(estimateIncrementality({ organicPosition: 9, positionMeasured: true })?.bps).toBe(9_600)
  })

  it('no organic result is treated as the 5+ band, NOT as 100%', () => {
    const r = estimateIncrementality({ organicPosition: null, positionMeasured: true })
    expect(r?.bps).toBe(9_600)
    expect(r?.bps).toBeLessThan(10_000)
  })

  it('an unmeasured position yields null — there is no safe default', () => {
    expect(estimateIncrementality({ organicPosition: null, positionMeasured: false })).toBeNull()
  })
})

describe('break-even conversion rate — the §2.2 worked example', () => {
  const at = (position: number | null) =>
    computeBreakEven({
      bidLowMicros: 1_200_000n,
      bidHighMicros: 1_200_000n,
      incrementality: estimateIncrementality({ organicPosition: position, positionMeasured: true }),
      economics: HOTEL,
    })

  it('no organic ranking: $1.20 CPC needs ~10.4% conversion', () => {
    expect(at(null).requiredConversionBpsHigh).toBe(1041)
  })

  it('organic 2-4: ~12.2%', () => {
    expect(at(3).requiredConversionBpsHigh).toBe(1219)
  })

  it('organic rank 1: exactly double, 20.0% — the eBay result from first principles', () => {
    expect(at(1).requiredConversionBpsHigh).toBe(2000)
  })

  it('a conversion is worth order value x commission', () => {
    expect(at(1).valuePerConversionMicros).toBe(12_000_000n)
  })

  it('cost per INCREMENTAL click is 2x the CPC at rank 1', () => {
    expect(at(1).costPerIncrementalClickMicros).toBe(2_400_000n)
  })

  it('is null when any operator input is unset — never a partial estimate', () => {
    const r = computeBreakEven({
      bidLowMicros: 1_200_000n,
      bidHighMicros: 1_200_000n,
      incrementality: estimateIncrementality({ organicPosition: 5, positionMeasured: true }),
      economics: { ...HOTEL, commissionRateBps: null },
    })
    expect(r.requiredConversionBpsHigh).toBeNull()
    expect(r.missing).toContain('commissionRateBps')
  })
})

describe('assessPaidKeyword', () => {
  it('BUYs when we convert comfortably above the bar', () => {
    const r = assessPaidKeyword({ ...base, achievedConversionBps: 2500 })
    expect(r.verdict).toBe('BUY')
    expect(r.marginRatio).toBeGreaterThan(2)
  })

  it('is MARGINAL when the margin is inside the noise Lewis & Rao describe', () => {
    const r = assessPaidKeyword({ ...base, achievedConversionBps: 1200 })
    expect(r.verdict).toBe('MARGINAL')
    expect(r.reason).toMatch(/cannot be distinguished from zero/)
  })

  it('SKIPs when the arithmetic does not work', () => {
    expect(assessPaidKeyword(base).verdict).toBe('SKIP')
  })

  /**
   * The margin ratio scales with incrementality exactly, so rank 1 against no
   * organic presence is 5000/9600 = 0.52x -- NOT 0.5x, because the unranked
   * band is 96% rather than 100%. Asserting the exact relationship rather than
   * a rounded one, since that 4% is the difference between "paid is pure
   * addition" and "paid is nearly pure addition".
   */
  it('ranking #1 organically cuts the margin by the incrementality ratio', () => {
    const notRanking = assessPaidKeyword({ ...base, achievedConversionBps: 1500, organicPosition: null })
    const rankingFirst = assessPaidKeyword({ ...base, achievedConversionBps: 1500, organicPosition: 1 })

    const expected = INCREMENTALITY_BPS.rank1 / INCREMENTALITY_BPS.noOrganic
    expect(rankingFirst.marginRatio! / notRanking.marginRatio!).toBeCloseTo(expected, 2)
    expect(notRanking.verdict).toBe('MARGINAL')
    expect(rankingFirst.verdict).toBe('SKIP')
  })

  it('and a keyword we rank 5th for is easier to justify than one we rank 1st for', () => {
    const deep = assessPaidKeyword({ ...base, achievedConversionBps: 2200, organicPosition: 7 })
    const top = assessPaidKeyword({ ...base, achievedConversionBps: 2200, organicPosition: 1 })
    expect(deep.verdict).toBe('BUY')
    expect(top.verdict).toBe('MARGINAL')
  })

  it('uses the HIGH end of the bid range — the low end is what losing costs', () => {
    const r = assessPaidKeyword({ ...base, achievedConversionBps: 1200 })
    expect(r.breakEven.requiredConversionBpsHigh).toBeGreaterThan(
      r.breakEven.requiredConversionBpsLow!,
    )
  })

  it('an AI Overview BLOCKS rather than silently discounting', () => {
    const r = assessPaidKeyword({ ...base, achievedConversionBps: 2500, hasAiOverview: true })
    expect(r.verdict).toBe('BLOCKED')
    expect(r.reason).toMatch(/no defensible coefficient/)
  })

  it('warns on brand queries, which organic rank does not capture', () => {
    const r = assessPaidKeyword({
      ...base,
      keywordNorm: 'peptide sciences review',
      achievedConversionBps: 2500,
      brandTerms: ['peptide sciences'],
    })
    expect(r.warnings.join(' ')).toMatch(/Blake, Nosko & Tadelis/)
  })

  it('SKIPs volume too low to ever evaluate, and says why', () => {
    const r = assessPaidKeyword({ ...base, volume: 20, achievedConversionBps: 2500 })
    expect(r.verdict).toBe('SKIP')
    expect(r.reason).toMatch(/cannot produce enough clicks to tell/)
  })
})

describe('missing signals are never treated as good ones', () => {
  it('an unmeasured achieved conversion rate is UNKNOWN, not SKIP', () => {
    const r = assessPaidKeyword({ ...base, achievedConversionBps: null })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing).toContain('achievedConversionBps')
  })

  it('an unmeasured organic position is UNKNOWN — incrementality cannot be guessed', () => {
    const r = assessPaidKeyword({ ...base, positionMeasured: false })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing.join(' ')).toMatch(/incrementality/)
  })

  it('an unmeasured bid range is UNKNOWN — there is no cost term without it', () => {
    const r = assessPaidKeyword({ ...base, bidHighMicros: null, achievedConversionBps: 2500 })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing).toContain('bidHighMicros')
  })

  it('a null hasAiOverview means the SERP was never bought, and does NOT block', () => {
    const r = assessPaidKeyword({ ...base, hasAiOverview: null, achievedConversionBps: 2500 })
    expect(r.verdict).not.toBe('BLOCKED')
  })
})
