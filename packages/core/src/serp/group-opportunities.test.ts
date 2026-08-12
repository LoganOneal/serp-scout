import { describe, expect, it } from 'vitest'
import { groupByNicheMarket, nicheGroupKey, type GroupableRow } from './group-opportunities.js'

let seq = 0
const row = (over: Partial<GroupableRow> = {}): GroupableRow => ({
  researchKeywordId: ++seq,
  researchGeoId: 10,
  keyword: 'fire damage restoration',
  seedKey: 'fire-damage',
  variant: 'primary',
  device: 'desktop',
  volume: 100,
  opportunityScore: 50,
  firstOrganicRankAbsolute: 5,
  bestRedditAbsoluteRank: null,
  nicheId: 7,
  nicheSlug: 'fire-damage-restoration',
  market: 'Indianapolis',
  stateAbbr: 'IN',
  localitySlug: 'indianapolis-in',
  marketHref: '/portfolio/indianapolis-in/fire-damage-restoration',
  ...over,
})

describe('nicheGroupKey', () => {
  it('prefers the matched niche', () => {
    expect(nicheGroupKey(row({ nicheId: 7, seedKey: 'x' }))).toBe('n:7')
  })

  it('falls back to the seed so unmatched variations still group', () => {
    expect(nicheGroupKey(row({ nicheId: null, seedKey: 'Fire-Damage' }))).toBe('s:fire-damage')
  })

  it('falls back to the keyword when there is no seed either', () => {
    expect(nicheGroupKey(row({ nicheId: null, seedKey: '  ', keyword: 'Odd Query' }))).toBe(
      'k:odd query',
    )
  })
})

describe('groupByNicheMarket', () => {
  it('collapses variations of one niche in one market into a single row', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'fire damage restoration', volume: 880, opportunityScore: 74, firstOrganicRankAbsolute: 3 }),
      row({ keyword: 'fire damage repair', variant: 'v2', volume: 590, opportunityScore: 68, firstOrganicRankAbsolute: 5 }),
      row({ keyword: 'smoke damage restoration', variant: 'v3', volume: 390, opportunityScore: 71, firstOrganicRankAbsolute: 4 }),
    ])

    expect(grouped).toHaveLength(1)
    const g = grouped[0]!
    expect(g.variationCount).toBe(3)
    expect(g.volume).toBe(1860) // summed
    expect(g.firstOrganicRankAbsolute).toBe(3) // best = lowest
    expect(g.opportunityScore).toBe(74) // max
    expect(g.volumeComplete).toBe(true)
  })

  it('traces the headline score back to the variation that produced it', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'seed', volume: 10, opportunityScore: 20 }),
      row({ keyword: 'winner', variant: 'v2', volume: 10, opportunityScore: 90 }),
    ])
    expect(grouped[0]!.opportunityScore).toBe(90)
    expect(grouped[0]!.bestVariation.keyword).toBe('winner')
  })

  it('titles the group with the head term the others are built on', () => {
    // Real data: every expansion is stored variant='primary', so the label has
    // to be found structurally or the group gets titled by its best long-tail.
    const grouped = groupByNicheMarket([
      row({ keyword: 'water damage restoration cost', opportunityScore: 99, volume: 10 }),
      row({ keyword: 'water damage restoration', opportunityScore: 6, volume: 140 }),
      row({ keyword: 'water damage restoration company', opportunityScore: 6, volume: 90 }),
      row({ keyword: 'water damage restoration contractor', opportunityScore: 3, volume: 10 }),
    ])
    expect(grouped[0]!.label).toBe('water damage restoration')
    // The headline score still comes from the strongest variation.
    expect(grouped[0]!.opportunityScore).toBe(99)
  })

  it('falls back to the shortest phrase when nothing is a common prefix', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'emergency foundation repair', opportunityScore: 9 }),
      row({ keyword: 'foundation company', opportunityScore: 8 }),
      row({ keyword: 'best foundation work', opportunityScore: 7 }),
    ])
    expect(grouped[0]!.label).toBe('foundation company')
  })

  it('keeps different markets apart', () => {
    const grouped = groupByNicheMarket([
      row({ researchGeoId: 10, market: 'Indianapolis' }),
      row({ researchGeoId: 11, market: 'Dayton' }),
    ])
    expect(grouped).toHaveLength(2)
  })

  it('keeps different niches apart in the same market', () => {
    const grouped = groupByNicheMarket([
      row({ nicheId: 7 }),
      row({ nicheId: 8, keyword: 'water damage', seedKey: 'water-damage' }),
    ])
    expect(grouped).toHaveLength(2)
  })

  it('puts desktop and mobile in ONE row, not two', () => {
    // The reported bug: "hvac repair - Houston, TX" appeared twice in the grid
    // because the run measured both devices.
    const grouped = groupByNicheMarket([
      row({ device: 'desktop', firstOrganicRankAbsolute: 4 }),
      row({ device: 'mobile', firstOrganicRankAbsolute: 1 }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.devices).toEqual(['desktop', 'mobile'])
    expect(grouped[0]!.firstOrganicRankAbsolute).toBe(1)
    expect(grouped[0]!.variations).toHaveLength(2)
  })

  it('does not double-count volume when a keyword is measured on both devices', () => {
    // Volume belongs to the query and the market, not the device. Summing rows
    // would report 2,260 for a niche worth 1,130.
    const grouped = groupByNicheMarket([
      row({ keyword: 'solar', device: 'desktop', volume: 880 }),
      row({ keyword: 'solar', device: 'mobile', volume: 880 }),
      row({ keyword: 'solar company', device: 'desktop', volume: 170 }),
      row({ keyword: 'solar company', device: 'mobile', volume: 170 }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.volume).toBe(1050)
    // Two keywords measured, four rows stored.
    expect(grouped[0]!.variationCount).toBe(2)
    expect(grouped[0]!.variations).toHaveLength(4)
  })

  it('skips missing volumes instead of counting them as zero, and says so', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'fire damage restoration', volume: 500 }),
      row({ keyword: 'smoke damage repair', volume: null }),
    ])
    expect(grouped[0]!.volume).toBe(500)
    expect(grouped[0]!.volumeComplete).toBe(false)
  })

  it('takes the first non-null volume when one device measured it and the other did not', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'solar', device: 'desktop', volume: null }),
      row({ keyword: 'solar', device: 'mobile', volume: 880 }),
    ])
    expect(grouped[0]!.volume).toBe(880)
    expect(grouped[0]!.volumeComplete).toBe(true)
  })

  it('returns a null volume when no variation had one', () => {
    const grouped = groupByNicheMarket([
      row({ keyword: 'a', volume: null }),
      row({ keyword: 'b', volume: null }),
    ])
    expect(grouped[0]!.volume).toBeNull()
  })

  it('ranks groups by score then volume', () => {
    const grouped = groupByNicheMarket([
      row({ nicheId: 1, opportunityScore: 30, volume: 100 }),
      row({ nicheId: 2, opportunityScore: 80, volume: 10 }),
      row({ nicheId: 3, opportunityScore: 80, volume: 900 }),
    ])
    expect(grouped.map((g) => g.nicheId)).toEqual([3, 2, 1])
  })
})

describe('reddit hit count survives grouping', () => {
  const row = (keyword: string, device: string, hits: number) => ({
    researchKeywordId: 1,
    researchGeoId: 1,
    keyword,
    device,
    market: 'Chicago',
    nicheId: 7,
    redditHitCount: hits,
  })

  it('does not double-count a keyword measured on two devices', () => {
    // Desktop and mobile return the same threads; summing rows would report a
    // cell as twice as busy as it is.
    const [g] = groupByNicheMarket([
      row('bathroom remodeling chicago', 'desktop', 2),
      row('bathroom remodeling chicago', 'mobile', 2),
    ])
    expect(g!.redditHitCount).toBe(2)
  })

  it('adds up distinct keywords', () => {
    const [g] = groupByNicheMarket([
      row('bathroom remodeling chicago', 'desktop', 2),
      row('bathroom remodeling installation chicago', 'desktop', 1),
    ])
    expect(g!.redditHitCount).toBe(3)
  })

  it('is zero, not undefined, when nothing carried a count', () => {
    // The grid branches on `> 0`; undefined would silently take the em-dash
    // path that this field exists to avoid.
    const [g] = groupByNicheMarket([{ ...row('x', 'desktop', 0), redditHitCount: undefined }])
    expect(g!.redditHitCount).toBe(0)
  })
})
