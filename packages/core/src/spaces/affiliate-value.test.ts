import { describe, expect, it } from 'vitest'
import {
  affiliateValueDisclosure,
  ctrAtPosition,
  estimateAffiliateValue,
  valuePerClickMicros,
  type AffiliateEconomics,
} from './affiliate-value.js'

/** A hotel booking: $300 order, 4% commission, 3% of clicks convert. */
const HOTEL: AffiliateEconomics = {
  orderValueMicros: 300_000_000n,
  commissionRateBps: 400,
  conversionRateBps: 300,
}

describe('valuePerClickMicros', () => {
  it('is order x commission x conversion, in integer micros', () => {
    // $300 * 4% = $12 per booking; * 3% of clicks = $0.36 per click.
    expect(valuePerClickMicros(HOTEL)).toBe(360_000n)
  })

  it('is null if ANY term is unset — never a partial estimate', () => {
    expect(valuePerClickMicros({ ...HOTEL, conversionRateBps: null })).toBeNull()
    expect(valuePerClickMicros({ ...HOTEL, commissionRateBps: null })).toBeNull()
    expect(valuePerClickMicros({ ...HOTEL, orderValueMicros: null })).toBeNull()
  })
})

describe('estimateAffiliateValue', () => {
  it('values a keyword we do not rank for against the target position', () => {
    const r = estimateAffiliateValue({ volume: 1000, position: null, economics: HOTEL })
    // Position 5 -> 6% CTR -> 60 clicks -> 60 * $0.36 = $21.60/mo
    expect(r.estimatedMonthlyClicks).toBe(60)
    expect(r.monthlyValueMicros).toBe(21_600_000n)
  })

  it('uses our real position when we have one', () => {
    const r = estimateAffiliateValue({ volume: 1000, position: 1, economics: HOTEL })
    expect(r.estimatedMonthlyClicks).toBe(280)
  })

  it('labels the modelled terms so the on-screen banner cannot drift from the model', () => {
    const r = estimateAffiliateValue({ volume: 1000, position: null, economics: HOTEL })
    expect(r.modelled).toContain('ctrAtPosition')
    expect(r.modelled).toContain('targetPosition')
  })

  it('an unmeasured conversion rate yields NULL, never a plausible default', () => {
    const r = estimateAffiliateValue({
      volume: 1000,
      position: 3,
      economics: { ...HOTEL, conversionRateBps: null },
    })
    expect(r.monthlyValueMicros).toBeNull()
    expect(r.missing).toContain('conversionRateBps')
  })

  it('an unmeasured volume yields NULL even when the economics are complete', () => {
    const r = estimateAffiliateValue({ volume: null, position: 3, economics: HOTEL })
    expect(r.monthlyValueMicros).toBeNull()
    expect(r.missing).toEqual(['volume'])
  })
})

describe('ctrAtPosition', () => {
  it('falls off with position and flattens past the top 10', () => {
    expect(ctrAtPosition(1)).toBeGreaterThan(ctrAtPosition(5))
    expect(ctrAtPosition(11)).toBe(ctrAtPosition(50))
  })

  it('is 0 for a nonsensical position rather than throwing or guessing', () => {
    expect(ctrAtPosition(0)).toBe(0)
    expect(ctrAtPosition(Number.NaN)).toBe(0)
  })
})

describe('affiliateValueDisclosure', () => {
  it('says value is NOT modelled when an input is unset, and names which', () => {
    const text = affiliateValueDisclosure({ ...HOTEL, conversionRateBps: null })
    expect(text).toMatch(/not modelled/)
    expect(text).toMatch(/conversion rate/)
  })

  it('names every modelled term when the economics are complete', () => {
    const text = affiliateValueDisclosure(HOTEL)
    expect(text).toMatch(/operator inputs/)
    expect(text).toMatch(/published curve/)
  })
})
