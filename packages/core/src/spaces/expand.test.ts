import { describe, expect, it } from 'vitest'
import { expandKeywordSpace, matchEntities } from './expand.js'
import { LOCATION_US, type KeywordSpace, type SpaceEntity } from './keyword-space.js'

const geo = (slug: string, label: string, code: number): SpaceEntity => ({
  slug,
  label,
  aliases: [],
  locationCode: code,
})

const product = (slug: string, label: string, aliases: string[] = []): SpaceEntity => ({
  slug,
  label,
  aliases,
  locationCode: null,
})

const LOCALITIES = [
  geo('las-vegas-nv', 'Las Vegas', 1014221),
  geo('gatlinburg-tn', 'Gatlinburg', 1026201),
]

const HOTEL_SPACE: KeywordSpace = {
  geoMode: 'in_keyword',
  audienceScope: 'country:US',
  serpLocationCode: LOCATION_US,
  dimensions: { locality: { source: 'research_geos' } },
  patterns: [
    { template: 'hotels with hot tubs in room {locality}', label: 'in-room' },
    { template: '{locality} jacuzzi suites', label: 'suites' },
  ],
  volumeFloor: 50,
}

describe('hotelhottubs — locality is a token, not a code', () => {
  it('produces one keyword per pattern per locality', () => {
    const r = expandKeywordSpace(HOTEL_SPACE, { locality: LOCALITIES })
    expect(r.keywords.map((k) => k.keyword)).toEqual([
      'hotels with hot tubs in room las vegas',
      'hotels with hot tubs in room gatlinburg',
      'las vegas jacuzzi suites',
      'gatlinburg jacuzzi suites',
    ])
    expect(r.dropped).toBe(0)
  })

  it('records which entity produced each row, so a grid row can be traced back', () => {
    const r = expandKeywordSpace(HOTEL_SPACE, { locality: LOCALITIES })
    expect(r.keywords[0]!.entities).toEqual({ locality: 'las-vegas-nv' })
    expect(r.keywords[0]!.seedKey).toBe('in-room')
  })

  it('says so when a dimension is empty, instead of silently generating nothing', () => {
    const r = expandKeywordSpace(HOTEL_SPACE, { locality: [] })
    expect(r.keywords).toEqual([])
    expect(r.notes.join(' ')).toMatch(/has no active entities/)
  })
})

describe('borenhealth — two dimensions and a capped pairwise', () => {
  const PEPTIDES = [
    product('bpc-157', 'BPC-157', ['BPC 157', 'BPC157']),
    product('tb-500', 'TB-500', ['TB 500']),
    product('ipamorelin', 'Ipamorelin'),
  ]

  const SPACE: KeywordSpace = {
    geoMode: 'none',
    audienceScope: 'country:US',
    serpLocationCode: LOCATION_US,
    dimensions: { product: { source: 'entity_set', setSlug: 'peptides' } },
    patterns: [
      { template: '{product} dosage', label: 'dosage' },
      { template: '{product} vs {product:2}', label: 'vs', pairwise: true },
    ],
    volumeFloor: 50,
  }

  it('emits one direction per pair, not both', () => {
    const r = expandKeywordSpace(SPACE, { product: PEPTIDES })
    const vs = r.keywords.filter((k) => k.seedKey === 'vs').map((k) => k.keyword)
    expect(vs).toEqual(['bpc-157 vs tb-500', 'bpc-157 vs ipamorelin', 'tb-500 vs ipamorelin'])
    expect(vs).not.toContain('tb-500 vs bpc-157')
  })

  it('never pairs an entity with itself', () => {
    const r = expandKeywordSpace(SPACE, { product: PEPTIDES })
    expect(r.keywords.map((k) => k.keyword)).not.toContain('bpc-157 vs bpc-157')
  })

  it('refuses a repeated dimension that did not opt in', () => {
    const r = expandKeywordSpace(
      { ...SPACE, patterns: [{ template: '{product} vs {product:2}', label: 'vs' }] },
      { product: PEPTIDES },
    )
    expect(r.keywords).toEqual([])
    expect(r.notes.join(' ')).toMatch(/without pairwise: true/)
  })

  it('a hit cap is reported, because a sampled grid reads exactly like a complete one', () => {
    const r = expandKeywordSpace({ ...SPACE, pairwiseCap: 2 }, { product: PEPTIDES })
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.notes.join(' ')).toMatch(/sampled, not expanded/)
  })
})

describe('matchEntities — boundary-safe, never bare substring', () => {
  const PEPTIDES = [product('bpc-157', 'BPC-157', ['BPC 157']), product('tb-500', 'TB-500')]

  it('matches an alias form', () => {
    expect(matchEntities('bpc 157 dosage', PEPTIDES).map((e) => e.slug)).toEqual(['bpc-157'])
  })

  it('does NOT match inside a longer token — the `wi` matching `wiki*` bug', () => {
    expect(matchEntities('bpc-1570 review', PEPTIDES)).toEqual([])
  })

  it('returns every entity present, for a pairwise keyword', () => {
    expect(matchEntities('bpc-157 vs tb-500', PEPTIDES).map((e) => e.slug)).toEqual([
      'bpc-157',
      'tb-500',
    ])
  })
})
