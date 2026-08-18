import { describe, expect, it } from 'vitest'
import {
  isOurDomain,
  surfaceForItemType,
  surfaceState,
  tallyCoverage,
  type SurfaceObservation,
} from './surfaces.js'

const obs = (
  surface: SurfaceObservation['surface'],
  present: boolean,
  ourRank: number | null = null,
  holderCount = 3,
): SurfaceObservation => ({ surface, present, ourRank, holderCount })

describe('surfaceForItemType', () => {
  it('maps the types DataForSEO actually returns', () => {
    expect(surfaceForItemType('organic')).toBe('organic')
    expect(surfaceForItemType('discussions_and_forums')).toBe('discussions')
    expect(surfaceForItemType('perspectives')).toBe('discussions')
    expect(surfaceForItemType('images')).toBe('images')
    expect(surfaceForItemType('video')).toBe('video')
    expect(surfaceForItemType('people_also_ask')).toBe('paa')
    expect(surfaceForItemType('ai_overview')).toBe('ai_overview')
    expect(surfaceForItemType('local_pack')).toBe('maps')
    expect(surfaceForItemType('paid')).toBe('paid')
    expect(surfaceForItemType('top_stories')).toBe('top_stories')
    // Found by the first live probe — the hotel booking module was missing.
    expect(surfaceForItemType('hotels_pack')).toBe('hotels_pack')
  })

  /**
   * The vendor keeps adding types — ai_overview, discussions_and_forums and
   * perspectives all postdate this pipeline. An unknown type returns null so it
   * can be COUNTED as unmapped; silently dropping it is how a new surface
   * arrives and nobody notices for a year.
   */
  it('returns null for a type it does not know, rather than guessing', () => {
    expect(surfaceForItemType('some_new_google_thing')).toBeNull()
    expect(surfaceForItemType('')).toBeNull()
  })
})

describe('surfaceState — the four states', () => {
  it('distinguishes all four', () => {
    expect(surfaceState(obs('organic', true, 4))).toBe('held')
    expect(surfaceState(obs('organic', true, null))).toBe('theirs')
    expect(surfaceState(obs('organic', false))).toBe('absent')
    expect(surfaceState(null)).toBe('unmeasured')
    expect(surfaceState(undefined)).toBe('unmeasured')
  })

  /**
   * The distinction the whole grid rests on. "Someone else holds it" is go
   * compete; "Google does not return it" is nothing to win; "no row" is go and
   * spend $0.003. Collapsing them makes the picture actively misleading.
   */
  it('never reports an absent surface as one somebody else holds', () => {
    expect(surfaceState(obs('video', false))).not.toBe('theirs')
    expect(surfaceState(null)).not.toBe('absent')
  })
})

describe('surfaceState — unattributable', () => {
  /**
   * The live probe returned an images block that was PRESENT with zero holder
   * domains. The four-state model called it THEIRS — asserting somebody else
   * holds it, from a response that says nothing about who holds it.
   */
  it('reports a present surface with no attributable domains as unattributable', () => {
    expect(surfaceState(obs('images', true, null, 0))).toBe('unattributable')
  })

  it('still reports theirs when the response DOES name holders', () => {
    expect(surfaceState(obs('organic', true, null, 8))).toBe('theirs')
  })

  it('treats an older row with no holderCount as attributable, preserving old behaviour', () => {
    expect(surfaceState({ surface: 'organic', present: true, ourRank: null })).toBe('theirs')
  })
})

describe('tallyCoverage', () => {
  it('counts held over AVAILABLE, excluding absent surfaces', () => {
    const t = tallyCoverage([
      obs('organic', true, 3),
      obs('discussions', true, null),
      obs('video', false),
      obs('images', false),
    ])
    // organic + discussions are present; video and images are not on this SERP.
    expect(t).toEqual({ held: 1, available: 2, unmeasured: false })
  })

  /**
   * A keyword with no video carousel is not behind for failing to be in one. A
   * denominator that counted absent surfaces would make the score a function of
   * what Google happened to render rather than of anything we did.
   */
  it('does not penalise a keyword for a surface that does not exist', () => {
    const all = tallyCoverage([obs('organic', true, 1), obs('video', false), obs('images', false)])
    expect(all.available).toBe(1)
    expect(all.held).toBe(1)
  })

  /** Maps is not occupiable by a directory, so it is excluded from both sides. */
  it('ignores surfaces this kind of site can never hold', () => {
    const t = tallyCoverage([obs('organic', true, 2), obs('maps', true, null)])
    expect(t).toEqual({ held: 1, available: 1, unmeasured: false })
  })

  /**
   * An unattributable surface leaves the DENOMINATOR too. Counting it as unheld
   * would depress the ratio using a fact we do not have.
   */
  it('excludes an unattributable surface from both sides of the ratio', () => {
    const t = tallyCoverage([obs('organic', true, 2), obs('images', true, null, 0)])
    expect(t).toEqual({ held: 1, available: 1, unmeasured: false })
  })

  /**
   * Nothing measured must render as an em dash, not 0/6. Zero-of-six is a claim;
   * we have not made a measurement.
   */
  it('reports unmeasured rather than a zero score', () => {
    expect(tallyCoverage([])).toEqual({ held: 0, available: 0, unmeasured: true })
  })
})

describe('isOurDomain', () => {
  it('matches the apex and its subdomains', () => {
    expect(isOurDomain('hotelhottubs.com', 'hotelhottubs.com')).toBe(true)
    expect(isOurDomain('www.hotelhottubs.com', 'hotelhottubs.com')).toBe(true)
    expect(isOurDomain('blog.hotelhottubs.com', 'hotelhottubs.com')).toBe(true)
  })

  /**
   * The naive `includes()` credits us with this competitor's slot. Worth a test
   * because the failure is silent and flattering.
   */
  it('does not match a domain that merely contains ours', () => {
    expect(isOurDomain('nothotelhottubs.com', 'hotelhottubs.com')).toBe(false)
    expect(isOurDomain('hotelhottubs.com.evil.net', 'hotelhottubs.com')).toBe(false)
  })

  it('is empty-safe', () => {
    expect(isOurDomain('', 'hotelhottubs.com')).toBe(false)
    expect(isOurDomain('hotelhottubs.com', '')).toBe(false)
  })
})
