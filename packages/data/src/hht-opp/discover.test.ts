import { describe, expect, it } from 'vitest'
import { FixtureHhtOppSearchProvider } from '@rnr/core'
import { createHhtOppSearchProvider, semrushPhrase } from './search.js'
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

describe('semrushPhrase', () => {
  it('strips Google operators Semrush will not honor', () => {
    expect(semrushPhrase('"travel" "write for us"')).toBe('travel write for us')
    expect(semrushPhrase('site:afar.com write for us')).toBe('write for us')
  })
})

describe('search provider gate', () => {
  it('prefers Semrush over DataForSEO when a Semrush key is present', () => {
    const provider = createHhtOppSearchProvider({
      LIVE_CALLS_ENABLED: 'true',
      SEMRUSH_API_KEY: 'test-key',
      DATAFORSEO_LOGIN: 'x',
      DATAFORSEO_PASSWORD: 'y',
    })
    expect(provider.id).toBe('semrush')
    expect(provider.live).toBe(true)
  })

  it('uses the labeled fixture catalog when no Semrush key is set and fixture is requested', () => {
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
