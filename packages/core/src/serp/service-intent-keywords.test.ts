import { describe, expect, it } from 'vitest'
import {
  expandServiceIntentKeywords,
  MAX_SERVICE_INTENT_KEYWORDS,
} from './service-intent-keywords.js'

describe('expandServiceIntentKeywords', () => {
  it('expands HVAC into a buy-intent cluster with near-me heads', () => {
    const kws = expandServiceIntentKeywords({
      slug: 'hvac-repair',
      label: 'HVAC Repair',
      keywordNoun: 'hvac repair',
      category: 'trades',
    })
    expect(kws.length).toBeGreaterThan(10)
    expect(kws.length).toBeLessThanOrEqual(MAX_SERVICE_INTENT_KEYWORDS)
    expect(kws).toContain('hvac repair')
    expect(kws).toContain('hvac repair near me')
    expect(kws).toContain('ac repair')
    expect(kws).toContain('furnace repair')
    expect(kws).toContain('emergency ac repair')
    // Geo is via location_code — no city baked into queries by default.
    expect(kws.every((k) => !/\btucson\b|\bhouston\b/i.test(k))).toBe(true)
  })

  it('expands a generic niche without city names', () => {
    const kws = expandServiceIntentKeywords({
      slug: 'plumber',
      label: 'Plumber',
      keywordNoun: 'plumber',
      category: 'trades',
    })
    expect(kws).toContain('plumber')
    expect(kws).toContain('plumber near me')
    expect(kws.some((k) => k.includes('repair'))).toBe(true)
    expect(kws.every((k) => !/\btucson\b/i.test(k))).toBe(true)
  })

  it('dedupes and respects max', () => {
    const kws = expandServiceIntentKeywords(
      { slug: 'hvac-repair', label: 'HVAC', keywordNoun: 'hvac repair' },
      { max: 5 },
    )
    expect(kws).toHaveLength(5)
    expect(new Set(kws).size).toBe(5)
  })
})
