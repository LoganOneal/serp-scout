import { describe, expect, it } from 'vitest'
import { buildNullResolver, geoSlugFor, localityResolverFrom, resolveItem } from './resolve.js'
import type { SupplyItem } from '@rnr/supply-feed'

const GEOS = [
  { market: 'Las Vegas', stateAbbr: 'NV', localityId: 11 },
  { market: 'Aspen', stateAbbr: 'CO', localityId: 12 },
  { market: 'Boise', stateAbbr: 'ID', localityId: 13 },
  // The collision that makes ambiguity a real case, not a hypothetical.
  { market: 'Springfield', stateAbbr: 'IL', localityId: 14 },
  { market: 'Springfield', stateAbbr: 'MO', localityId: 15 },
]

const resolver = localityResolverFrom(GEOS)

describe('geoSlugFor — must equal the grid’s own slug function', () => {
  /**
   * `research_keywords.keyword_norm` learned this once: a second normalisation
   * convention silently splits a catalog into two halves that never join. If
   * `geoSlug` in spaces/entities.ts changes, this must change with it — and the
   * join between supply and demand exists only while they agree.
   */
  it('produces market-state, lowercased and hyphenated', () => {
    expect(geoSlugFor('Las Vegas', 'NV')).toBe('las-vegas-nv')
    expect(geoSlugFor('St. Louis', 'MO')).toBe('st-louis-mo')
    expect(geoSlugFor('Paris', null)).toBe('paris')
  })
})

describe('locality resolution', () => {
  it('resolves city + region exactly', () => {
    const r = resolver.resolve({ city: 'Las Vegas', region: 'NV', country: 'US' })
    expect(r).toMatchObject({
      status: 'resolved',
      entityKind: 'locality',
      entitySlug: 'las-vegas-nv',
      localityId: 11,
      method: 'city_state',
    })
  })

  it('is case- and whitespace-insensitive on both fields', () => {
    expect(resolver.resolve({ city: '  las   vegas ', region: 'nv', country: 'US' }).entitySlug).toBe(
      'las-vegas-nv',
    )
  })

  it('resolves a bare city name when exactly one market carries it', () => {
    const r = resolver.resolve({ city: 'Aspen', country: 'US' })
    expect(r.status).toBe('resolved')
    expect(r.entitySlug).toBe('aspen-co')
    expect(r.method).toBe('city_only')
  })

  /**
   * ==================== THE ONE THAT WOULD BE INVISIBLE ====================
   * Picking the first match would attach a property in Springfield, Missouri to
   * Springfield, Illinois. Nothing downstream could tell: the coverage number
   * would look perfectly reasonable, and the page would be built for the wrong
   * city. Ambiguity is an UNRESOLVED, and the reason names the candidates.
   * ========================================================================
   */
  it('refuses an ambiguous bare city rather than picking one', () => {
    const r = resolver.resolve({ city: 'Springfield', country: 'US' })
    expect(r.status).toBe('unresolved')
    expect(r.entitySlug).toBeNull()
    expect(r.reason).toMatch(/ambiguous/)
    expect(r.reason).toMatch(/springfield-il/)
    expect(r.reason).toMatch(/springfield-mo/)
  })

  it('resolves an ambiguous city once a region disambiguates it', () => {
    expect(resolver.resolve({ city: 'Springfield', region: 'MO', country: 'US' }).entitySlug).toBe(
      'springfield-mo',
    )
  })

  /**
   * "Not in research_geos" is UNKNOWN coverage, never zero. This is the sentence
   * that stops an importer gap from cancelling the build queue, so the reason
   * says it out loud.
   */
  it('returns unresolved — and says it is not a zero — for a market not in the corpus', () => {
    const r = resolver.resolve({ city: 'Reykjavik', country: 'IS' })
    expect(r.status).toBe('unresolved')
    expect(r.reason).toMatch(/UNKNOWN coverage, not zero/)
  })

  it('returns unresolved when a locality source publishes no location at all', () => {
    const r = resolver.resolve(undefined)
    expect(r.status).toBe('unresolved')
    expect(r.reason).toMatch(/published no location/)
  })

  /** A region we do not recognise must not discard an otherwise-unique city. */
  it('falls back to a unique city when the published region does not match', () => {
    const r = resolver.resolve({ city: 'Boise', region: 'Idaho', country: 'US' })
    expect(r.status).toBe('resolved')
    expect(r.entitySlug).toBe('boise-id')
    expect(r.method).toBe('city_only_region_unmatched')
  })
})

describe('null resolver', () => {
  /**
   * A catalogue with no geography is CORRECT, not broken. Folding it into
   * `unresolved` would make a perfectly good feed report 100% resolution
   * failure — and a loud signal that fires constantly stops being read.
   */
  it('reports not_applicable, never unresolved', () => {
    const item = { supplierName: 'Acme Peptides', title: 'BPC-157 5mg' } as SupplyItem
    const r = resolveItem(buildNullResolver(), item)
    expect(r.status).toBe('not_applicable')
    expect(r.reason).toBeNull()
  })
})

describe('resolveItem dispatch', () => {
  it('feeds a locality resolver the item’s location', () => {
    const item = {
      supplierName: 'Bellagio',
      title: 'Suite',
      location: { city: 'Las Vegas', region: 'NV', country: 'US' },
    } as SupplyItem
    expect(resolveItem(resolver, item).entitySlug).toBe('las-vegas-nv')
  })
})
