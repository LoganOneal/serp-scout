import { describe, expect, it } from 'vitest'
import { GUEST_BUCKETS, guestBucket } from './guest-buckets.js'
import { isGuestBucketKeyword, isGuestFrontierKeyword, selectGuestFrontierIdeas } from './guest-frontier.js'
import {
  GUEST_TEMPLATES,
  GUEST_TOURISM_REGIONS,
  guestMetroEntities,
  guestStateEntities,
  guestTemplateSlot,
  guestTemplateStats,
  guestYieldBaseline,
  matchGuestTemplate,
  metroPrincipalCity,
  rankGuestTemplateCandidates,
  renderGuestTemplate,
  type GuestEntity,
  type GuestTemplateHistoryRow,
} from './guest-templates.js'

const city = (name: string, weight = 1): GuestEntity => ({ kind: 'city', name, weight })

describe('guest buckets', () => {
  it('keeps the original travel terms as the default bucket', () => {
    expect(isGuestFrontierKeyword('packing list for chile')).toBe(true)
    expect(isGuestFrontierKeyword('romantic staycation ideas at home')).toBe(true)
    expect(isGuestFrontierKeyword('hot tub repair near me')).toBe(false)
    expect(guestBucket('user_broad_travel').id).toBe('travel')
    expect(guestBucket(null).id).toBe('travel')
  })

  it('filters Google Ads ideas with the seed bucket regex', () => {
    const ideas = [
      { keyword: 'best spas in vermont', avgMonthlySearches: 90, volumeLow: null, volumeHigh: null, volumeIsRange: false },
      { keyword: 'vermont travel guide', avgMonthlySearches: 80, volumeLow: null, volumeHigh: null, volumeIsRange: false },
    ]
    expect(selectGuestFrontierIdeas({ ideas, alreadyKnown: [], limit: 5, bucket: 'wellness' })).toEqual(['best spas in vermont'])
    expect(selectGuestFrontierIdeas({ ideas, alreadyKnown: [], limit: 5 })).toEqual(['vermont travel guide'])
  })
})

describe('guest templates', () => {
  it('renders every template into a keyword its own bucket accepts', () => {
    const sample: Record<string, GuestEntity> = {
      city: city('Austin'),
      state: { kind: 'state', name: 'Vermont', weight: 1 },
      region: GUEST_TOURISM_REGIONS[0]!,
    }
    for (const template of GUEST_TEMPLATES) {
      const keyword = renderGuestTemplate(template, sample[guestTemplateSlot(template)]!)
      expect(isGuestBucketKeyword(keyword, template.bucket), `${template.id}: ${keyword}`).toBe(true)
      expect(matchGuestTemplate(keyword)?.template.id).toBe(template.id)
    }
    expect(Object.keys(GUEST_BUCKETS)).toEqual(['travel', 'romance', 'weddings', 'wellness', 'lifestyle'])
    expect(GUEST_TOURISM_REGIONS.length).toBeGreaterThanOrEqual(40)
  })

  it('matches stored keywords to the most specific template', () => {
    expect(matchGuestTemplate('Things to do in Austin this weekend')?.template.id).toBe('lifestyle.this-weekend')
    expect(matchGuestTemplate('best things to do in santa fe')).toMatchObject({ template: { id: 'travel.things-to-do' }, entity: 'santa fe' })
    expect(matchGuestTemplate('tennessee road trip')?.template.id).toBe('travel.state-road-trip')
    expect(matchGuestTemplate('packing list for chile')).toBeNull()
    expect(matchGuestTemplate('weekend in new york itinerary')).toBeNull()
    expect(matchGuestTemplate('vermont road trip itinerary')).toBeNull()
    expect(matchGuestTemplate('3 days in paris itinerary')).toBeNull()
    expect(matchGuestTemplate('romantic staycation ideas')).toBeNull()
  })

  it('names metros by their destination city and weights them', () => {
    expect(metroPrincipalCity('Nashville-Davidson--Murfreesboro--Franklin')).toBe('Nashville')
    expect(metroPrincipalCity('North Port-Bradenton-Sarasota')).toBe('Sarasota')
    expect(metroPrincipalCity('Urban Honolulu')).toBe('Honolulu')
    expect(metroPrincipalCity('Washington-Arlington-Alexandria')).toBe('Washington DC')
    expect(metroPrincipalCity('Louisville/Jefferson County')).toBe('Louisville')
    const entities = guestMetroEntities([
      { name: 'Riverside-San Bernardino-Ontario', population: 4_600_000 },
      { name: 'Savannah', population: 400_000 },
      { name: 'Portland-Vancouver-Hillsboro', population: 2_500_000 },
      { name: 'Portland-South Portland', population: 550_000 },
      { name: 'Tiny', population: null },
    ], { limit: 10 })
    expect(entities.map((row) => row.name)).toEqual(['Riverside', 'Portland', 'Savannah'])
    const weight = Object.fromEntries(entities.map((row) => [row.name, row.weight]))
    expect(weight['Savannah']).toBeGreaterThan(0.6)
    expect(weight['Riverside']).toBeCloseTo(0.7)
    expect(guestStateEntities(['Florida', 'Kansas']).map((row) => row.weight)).toEqual([1, 0.7])
  })
})

describe('template priors', () => {
  const history: GuestTemplateHistoryRow[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ keyword: `packing list for place${i}`, fetched: true, newDomains: 10, pitchable: 0 })),
    { keyword: 'things to do in boston', fetched: true, newDomains: 30, pitchable: 2 },
    { keyword: 'things to do in denver', fetched: true, newDomains: 20, pitchable: 1 },
    ...Array.from({ length: 10 }, (_, i) => ({ keyword: `day trips from city ${'abcdefghij'[i]}`, fetched: true, newDomains: 2, pitchable: i === 0 ? 1 : 0 })),
    { keyword: 'weekend in chicago', fetched: true, newDomains: 25, pitchable: null },
    { keyword: 'weekend in miami', fetched: false, newDomains: 0, pitchable: null },
  ]

  it('derives the baseline from tracker counts', () => {
    const baseline = guestYieldBaseline(history)
    expect(baseline.perNewDomain).toBeCloseTo(4 / 170)
  })

  it('computes running yield and retires weak templates after ten fetches', () => {
    const stats = guestTemplateStats(history, { baseline: { perNewDomain: 0.04, perKeyword: 1 } })
    const things = stats.get('travel.things-to-do')!
    expect(things).toMatchObject({ fetches: 2, observed: 2, pitchable: 3, pitchablePerKeyword: 1.5, newDomainsPerKeyword: 25, retired: false })
    expect(things.prior).toBeCloseTo((3 + 3) / 5)
    const weekend = stats.get('travel.weekend-in')!
    expect(weekend).toMatchObject({ fetches: 1, observed: 0, pitchable: 1 })
    const dayTrips = stats.get('travel.day-trips-from')!
    expect(dayTrips).toMatchObject({ fetches: 10, pitchablePerKeyword: 0.1, retired: true })
    expect(stats.get('wellness.spa-weekend-state')).toMatchObject({ fetches: 0, prior: 1, retired: false })
  })
})

describe('template ranking', () => {
  const templates = GUEST_TEMPLATES.filter((row) => ['travel.things-to-do', 'travel.day-trips-from', 'travel.weekend-in'].includes(row.id))

  it('ranks by prior × weight × novelty and drops known, retired and near-duplicate keywords', () => {
    const stats = guestTemplateStats([
      { keyword: 'things to do in boston', fetched: true, newDomains: 30, pitchable: 3 },
      ...Array.from({ length: 10 }, (_, i) => ({ keyword: `day trips from town ${'abcdefghij'[i]}`, fetched: true, newDomains: 1, pitchable: 0 })),
    ], { templates, baseline: { perNewDomain: 0.04, perKeyword: 1 } })
    const ranking = rankGuestTemplateCandidates({
      templates,
      entities: [city('Boston', 1), city('Austin', 1), city('Tulsa', 0.4)],
      stats,
      known: ['Things to do in Boston'],
      fetched: [{ keyword: 'weekend in austin', neighborhood: 'saturated' }],
      limit: 10,
      perTemplate: 10,
    })
    expect(ranking.candidates.map((row) => row.keyword)).toEqual([
      'things to do in austin',
      'things to do in tulsa',
      'weekend in boston',
      'weekend in tulsa',
    ])
    expect(ranking.skipped).toMatchObject({ known: 1, retiredTemplate: 3, nearDuplicate: 1 })
    const austin = ranking.candidates[0]!
    expect(austin.novelty).toBeLessThan(1)
    expect(austin.score).toBeCloseTo(austin.prior * austin.entity.weight * austin.novelty)
  })

  it('caps each template so new buckets get explored', () => {
    const ranking = rankGuestTemplateCandidates({
      templates,
      entities: ['A', 'B', 'C', 'D'].map((name) => city(`City ${name}`)),
      stats: new Map(),
      known: [],
      fetched: [],
      limit: 6,
      perTemplate: 2,
    })
    expect(ranking.candidates).toHaveLength(6)
    const counts = new Map<string, number>()
    for (const row of ranking.candidates) counts.set(row.templateId, (counts.get(row.templateId) ?? 0) + 1)
    expect([...counts.values()]).toEqual([2, 2, 2])
    expect(ranking.skipped.perTemplateCap).toBeGreaterThan(0)
  })
})
