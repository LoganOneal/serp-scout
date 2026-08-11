import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_KEYWORD_VOLUME,
  isNonBuyerKeyword,
  selectKeywords,
} from './keyword-selection.js'

const k = (keyword: string, avgMonthlySearches: number | null) => ({ keyword, avgMonthlySearches })

describe('non-buyer filter', () => {
  it('drops searchers who want the job, not the service', () => {
    expect(isNonBuyerKeyword('roofing jobs near me')).toBe(true)
    expect(isNonBuyerKeyword('plumber salary chicago')).toBe(true)
    expect(isNonBuyerKeyword('how to become a licensed electrician')).toBe(true)
  })

  it('drops DIY and reading', () => {
    expect(isNonBuyerKeyword('diy bathroom remodel')).toBe(true)
    expect(isNonBuyerKeyword('how to fix a leaking roof')).toBe(true)
    expect(isNonBuyerKeyword('roofing meaning')).toBe(true)
  })

  it('keeps unfamiliar phrases that are real demand', () => {
    // The point of discovery is phrases a template would never guess. Both of
    // these are real Chicago volume and both look odd beside "Bathroom
    // Remodeling"; dropping them would defeat the exercise.
    expect(isNonBuyerKeyword('jacuzzi bath remodel')).toBe(false)
    expect(isNonBuyerKeyword('tub to shower conversion')).toBe(false)
    expect(isNonBuyerKeyword('bathroom remodel near me')).toBe(false)
  })

  it('does not mistake a service for a course', () => {
    // "training" appears in the exclusion list; a real service must not trip it
    // by accident.
    expect(isNonBuyerKeyword('bathroom remodel contractors')).toBe(false)
  })
})

describe('selectKeywords', () => {
  const ideas = [
    k('bathroom remodeling', 4400),
    k('bathroom remodel contractors', 1300),
    k('bathroom remodel near me', 480),
    k('bathroom remodel jobs', 900),
    k('tub to shower conversion', 90),
    k('bathroom remodeling installation', null),
    k('one day bathroom remodel', 5),
  ]

  it('keeps the highest volume first, not the input order', () => {
    const s = selectKeywords(ideas, { limit: 3 })
    expect(s.keywords).toEqual([
      'bathroom remodeling',
      'bathroom remodel contractors',
      'bathroom remodel near me',
    ])
  })

  it('drops the job query however high its volume', () => {
    // 900 would otherwise outrank "near me"; volume is not intent.
    const s = selectKeywords(ideas, { limit: 10 })
    expect(s.keywords).not.toContain('bathroom remodel jobs')
    expect(s.rejected.find((r) => r.keyword === 'bathroom remodel jobs')?.reason).toBe('non_buyer')
  })

  it('drops the template phrase that has no volume', () => {
    // This is the exact keyword the old template produced and we bought a SERP
    // for. Its rejection is the point of the whole change.
    const s = selectKeywords(ideas, { limit: 10 })
    expect(s.keywords).not.toContain('bathroom remodeling installation')
    expect(s.rejected.find((r) => r.keyword === 'bathroom remodeling installation')?.reason).toBe(
      'no_volume',
    )
  })

  it('drops volume below the floor, and says so', () => {
    const s = selectKeywords(ideas, { limit: 10 })
    expect(s.keywords).not.toContain('one day bathroom remodel')
    expect(s.rejected.find((r) => r.keyword === 'one day bathroom remodel')?.reason).toBe(
      'below_min_volume',
    )
    expect(DEFAULT_MIN_KEYWORD_VOLUME).toBeGreaterThan(5)
  })

  it('pins the head term even when discovery never returned it', () => {
    // Two runs of one niche have to stay comparable.
    const s = selectKeywords([k('tub to shower conversion', 90)], {
      limit: 5,
      alwaysInclude: ['bathroom remodeling'],
    })
    expect(s.keywords).toContain('bathroom remodeling')
  })

  it('a pinned keyword survives the filters that would drop it', () => {
    const s = selectKeywords([k('roofing jobs', 900)], {
      limit: 5,
      alwaysInclude: ['roofing jobs'],
    })
    expect(s.keywords).toEqual(['roofing jobs'])
  })

  it('deduplicates case and spacing', () => {
    const s = selectKeywords([k('Bathroom  Remodeling', 100), k('bathroom remodeling', 90)], {
      limit: 5,
    })
    expect(s.keywords).toHaveLength(1)
    expect(s.rejected.some((r) => r.reason === 'duplicate')).toBe(true)
  })
})
