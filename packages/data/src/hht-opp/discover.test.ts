import { describe, expect, it } from 'vitest'
import { FixtureHhtOppSearchProvider } from '@rnr/core'
import { createHhtOppSearchProvider } from './search.js'
import { isHhtOppSearchStrategy, parseDiscoveryRunNotes } from './discover.js'

describe('discovery run notes', () => {
  it('clamps limits and ignores unknown strategies', () => {
    const notes = parseDiscoveryRunNotes(
      JSON.stringify({
        queryLimit: 99,
        domainLimit: 0,
        strategies: ['direct_keyword_search', 'competitor_backlinks'],
      }),
    )
    expect(notes.queryLimit).toBe(12)
    expect(notes.domainLimit).toBe(1)
    expect(notes.strategies).toEqual(['direct_keyword_search'])
  })

  it('falls back when notes are not JSON', () => {
    const notes = parseDiscoveryRunNotes('not-json')
    expect(notes.queryLimit).toBe(4)
    expect(notes.domainLimit).toBe(6)
  })
})

describe('search provider gate', () => {
  it('uses the labeled fixture catalog when live calls are off', () => {
    const provider = createHhtOppSearchProvider({ LIVE_CALLS_ENABLED: 'false' })
    expect(provider).toBeInstanceOf(FixtureHhtOppSearchProvider)
    expect(provider.live).toBe(false)
    expect(
      createHhtOppSearchProvider(
        { LIVE_CALLS_ENABLED: 'true', DATAFORSEO_LOGIN: 'x', DATAFORSEO_PASSWORD: 'y' },
        { fixture: true },
      ).live,
    ).toBe(false)
    expect(isHhtOppSearchStrategy('direct_keyword_search')).toBe(true)
    expect(isHhtOppSearchStrategy('competitor_backlinks')).toBe(false)
  })
})
