import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUILD_DIFFICULTY_CEILING,
  assessKeyword,
  type KeywordVerdictInput,
} from './keyword-verdict.js'

const base: KeywordVerdictInput = {
  position: null,
  positionMeasured: true,
  volume: 500,
  difficulty: 30,
  volumeFloor: 50,
}

describe('assessKeyword', () => {
  it('top-3 is DEFEND', () => {
    expect(assessKeyword({ ...base, position: 2 }).verdict).toBe('DEFEND')
  })

  it('DEFEND does not require difficulty — we are already there', () => {
    const r = assessKeyword({ ...base, position: 1, difficulty: null, volume: null })
    expect(r.verdict).toBe('DEFEND')
    expect(r.missing).toEqual([])
  })

  it('page 1-2 is IMPROVE — a page exists and on-page work is cheaper', () => {
    expect(assessKeyword({ ...base, position: 12 }).verdict).toBe('IMPROVE')
  })

  it('IMPROVE does not require difficulty: we rank, so the SERP is demonstrably enterable', () => {
    expect(assessKeyword({ ...base, position: 8, difficulty: null }).verdict).toBe('IMPROVE')
  })

  it('nothing ranking, real volume, soft SERP is BUILD', () => {
    expect(assessKeyword(base).verdict).toBe('BUILD')
  })

  it('a deep ranking is a BUILD, and says the existing page is not competitive', () => {
    const r = assessKeyword({ ...base, position: 64 })
    expect(r.verdict).toBe('BUILD')
    expect(r.reason).toMatch(/not competitive/)
  })

  it('below the floor is IGNORE, with the floor named', () => {
    const r = assessKeyword({ ...base, volume: 10 })
    expect(r.verdict).toBe('IGNORE')
    expect(r.reason).toMatch(/below the 50 floor/)
  })

  it('above the build ceiling is IGNORE', () => {
    const r = assessKeyword({ ...base, difficulty: DEFAULT_BUILD_DIFFICULTY_CEILING + 1 })
    expect(r.verdict).toBe('IGNORE')
  })
})

describe('missing signals are never treated as good ones', () => {
  it('an unmeasured volume is UNKNOWN, not IGNORE', () => {
    const r = assessKeyword({ ...base, volume: null })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing).toContain('volume')
  })

  it('a measured ZERO is IGNORE, not UNKNOWN — the distinction the schema exists for', () => {
    expect(assessKeyword({ ...base, volume: 0 }).verdict).toBe('IGNORE')
  })

  it('never having asked Search Console is UNKNOWN, even though position is null either way', () => {
    const neverAsked = assessKeyword({ ...base, position: null, positionMeasured: false })
    const askedAndAbsent = assessKeyword({ ...base, position: null, positionMeasured: true })
    expect(neverAsked.verdict).toBe('UNKNOWN')
    expect(neverAsked.missing).toContain('position')
    expect(askedAndAbsent.verdict).toBe('BUILD')
  })

  it('an unmeasured difficulty blocks BUILD but is reported as UNKNOWN, not IGNORE', () => {
    const r = assessKeyword({ ...base, difficulty: null })
    expect(r.verdict).toBe('UNKNOWN')
    expect(r.missing).toEqual(['difficulty'])
    expect(r.reason).toMatch(/no SERP has been bought/)
  })
})
