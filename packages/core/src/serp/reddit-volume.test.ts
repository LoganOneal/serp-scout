import { describe, expect, it } from 'vitest'
import { estimateRedditVisits, organicCtr, totalRedditVolume } from './reddit-volume.js'

describe('estimateRedditVisits', () => {
  it('multiplies volume by the CTR of the position held', () => {
    // #1 on the curve is 0.276.
    expect(estimateRedditVisits({ volume: 1000, organicPosition: 1 })).toBe(276)
    expect(estimateRedditVisits({ volume: 1000, organicPosition: 9 })).toBe(21)
  })

  it('ranks a small keyword at #1 above a big one at #9', () => {
    // The entire point: neither column alone tells you this.
    const small = estimateRedditVisits({ volume: 200, organicPosition: 1 })!
    const big = estimateRedditVisits({ volume: 1000, organicPosition: 9 })!
    expect(small).toBeGreaterThan(big)
  })

  it('prefers organic position over absolute rank', () => {
    // Organic #3 with six ad units above is still organic #3. Using absolute
    // rank would apply position-9 click-through and understate it.
    const byOrganic = estimateRedditVisits({ volume: 1000, organicPosition: 3, rankAbsolute: 9 })
    expect(byOrganic).toBe(100)
  })

  it('returns null, never 0, when volume was never measured', () => {
    // A market whose volume was not bought is not a market with no demand.
    expect(estimateRedditVisits({ volume: null, organicPosition: 1 })).toBeNull()
    expect(estimateRedditVisits({ volume: undefined, organicPosition: 1 })).toBeNull()
  })

  it('returns null beyond the curve rather than a fabricated tail', () => {
    expect(estimateRedditVisits({ volume: 1000, organicPosition: 25 })).toBeNull()
  })

  it('scores a pack hit mid-page when it has no organic position', () => {
    expect(estimateRedditVisits({ volume: 1000, fromPack: true })).toBe(52)
  })
})

describe('totalRedditVolume', () => {
  it('sums across distinct keywords', () => {
    const t = totalRedditVolume([
      { keyword: 'hvac repair', volume: 1000, organicPosition: 1 },
      { keyword: 'ac repair', volume: 500, organicPosition: 2 },
    ])
    expect(t.visits).toBe(276 + 76)
    expect(t.keywords).toBe(2)
    expect(t.bestPosition).toBe(1)
  })

  it('counts one keyword once even when the SERP returned several threads', () => {
    // One query, three Reddit results. Summing hits would treble the demand.
    const t = totalRedditVolume([
      { keyword: 'hvac repair', volume: 1000, organicPosition: 1 },
      { keyword: 'hvac repair', volume: 1000, organicPosition: 4 },
      { keyword: 'hvac repair', volume: 1000, organicPosition: 7 },
    ])
    expect(t.visits).toBe(276)
    expect(t.keywords).toBe(1)
  })

  it('does not double count a keyword measured on two devices', () => {
    const t = totalRedditVolume([
      { keyword: 'hvac repair', volume: 1000, organicPosition: 2 },
      { keyword: 'HVAC Repair', volume: 1000, organicPosition: 2 },
    ])
    expect(t.visits).toBe(151)
    expect(t.keywords).toBe(1)
  })

  it('keeps the best-placed thread for a keyword', () => {
    const t = totalRedditVolume([
      { keyword: 'hvac repair', volume: 1000, organicPosition: 8 },
      { keyword: 'hvac repair', volume: 1000, organicPosition: 2 },
    ])
    expect(t.visits).toBe(151)
    expect(t.bestPosition).toBe(2)
  })

  it('is null when nothing could be measured', () => {
    const t = totalRedditVolume([{ keyword: 'x', volume: null, organicPosition: 1 }])
    expect(t.visits).toBeNull()
  })
})

describe('organicCtr', () => {
  it('is zero outside the curve and for junk input', () => {
    expect(organicCtr(0)).toBe(0)
    expect(organicCtr(null)).toBe(0)
    expect(organicCtr(999)).toBe(0)
  })
})
