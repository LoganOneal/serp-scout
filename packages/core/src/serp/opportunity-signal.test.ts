import { describe, expect, it } from 'vitest'
import {
  SIGNAL_THRESHOLDS,
  opportunitySignals,
  signalStrength,
} from './opportunity-signal.js'

describe('reddit signal', () => {
  it('fires on a computable estimate above the floor', () => {
    expect(opportunitySignals({ redditHitCount: 1, redditVisits: 40, volume: 300 })).toContain(
      'reddit',
    )
  })

  it('fires on volume alone when visits cannot be computed', () => {
    // The exact case that read as empty: a thread on page 1, real demand, but
    // no visits estimate because Google Ads had no figure for the phrase.
    const s = opportunitySignals({ redditHitCount: 1, redditVisits: null, volume: 300 })
    expect(s).toContain('reddit')
    expect(s).not.toContain('partial')
  })

  it('does not fire on a thread with no demand behind it', () => {
    expect(opportunitySignals({ redditHitCount: 1, redditVisits: 2, volume: 10 })).not.toContain(
      'reddit',
    )
  })

  it('never fires without a thread, however large the volume', () => {
    // Volume is not a Reddit opportunity; a thread is.
    expect(opportunitySignals({ redditHitCount: 0, volume: 50_000 })).toEqual([])
  })
})

describe('partial signal', () => {
  it('fires when a thread exists but nothing else could be established', () => {
    const s = opportunitySignals({ redditHitCount: 2, redditVisits: null, volume: null })
    expect(s).toEqual(['partial'])
  })

  it('yields to a stronger claim rather than adding noise', () => {
    // A row already saying REDDIT does not also need telling its evidence is thin.
    const s = opportunitySignals({ redditHitCount: 2, redditVisits: 80, volume: null })
    expect(s).toContain('reddit')
    expect(s).not.toContain('partial')
  })

  it('does not fire on a row with no threads at all', () => {
    expect(opportunitySignals({ redditHitCount: 0, volume: null })).toEqual([])
  })
})

describe('build signal', () => {
  it('needs both a winnable verdict and somewhere to land', () => {
    expect(
      opportunitySignals({ verdictAcquired: 'likely_30d', slotsOpen: 5 }),
    ).toContain('build')
    expect(
      opportunitySignals({ verdictAcquired: 'likely_30d', slotsOpen: 1 }),
    ).not.toContain('build')
    expect(
      opportunitySignals({ verdictAcquired: 'not_winnable', slotsOpen: 9 }),
    ).not.toContain('build')
  })

  it('treats an uncomputed verdict as no claim, not as a pass', () => {
    expect(opportunitySignals({ verdictAcquired: null, slotsOpen: 9 })).toEqual([])
  })
})

describe('domain signal', () => {
  it('fires only when availability was actually measured true', () => {
    expect(opportunitySignals({ emdAvailable: true })).toEqual(['domain'])
    expect(opportunitySignals({ emdAvailable: false })).toEqual([])
    // Null means never checked. Never checked is not available.
    expect(opportunitySignals({ emdAvailable: null })).toEqual([])
  })
})

describe('signalStrength', () => {
  it('ranks the plays, not the magnitudes', () => {
    // A modest Reddit row outranks a strong build row on purpose: the column
    // says WHICH play, and blending would bury the better play type.
    const modestReddit = signalStrength({ redditHitCount: 1, redditVisits: 25, volume: 100 })
    const strongBuild = signalStrength({ verdictAcquired: 'likely_30d', slotsOpen: 9 })
    expect(modestReddit).toBeGreaterThan(strongBuild)
  })

  it('rewards a row offering two plays over one offering a single play', () => {
    const one = signalStrength({ redditHitCount: 1, redditVisits: 40 })
    const two = signalStrength({ redditHitCount: 1, redditVisits: 40, emdAvailable: true })
    expect(two).toBeGreaterThan(one)
  })

  it('is zero when nothing fires, so blank rows sort last', () => {
    expect(signalStrength({})).toBe(0)
  })

  it('uses the documented thresholds', () => {
    // Guards against the constants drifting away from the tests that explain them.
    expect(signalStrength({ redditHitCount: 1, redditVisits: SIGNAL_THRESHOLDS.redditVisits })).toBeGreaterThan(0)
    expect(signalStrength({ redditHitCount: 1, redditVisits: SIGNAL_THRESHOLDS.redditVisits - 1, volume: 1 })).toBe(100)
  })
})
