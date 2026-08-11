import { describe, expect, it } from 'vitest'
import { extractRedditHitsFromDfsResult, findRedditPlacement } from '@rnr/core'
import { loadContract, resultOf } from './contracts.js'
import { normaliseOrganicResult } from './serp.js'
import { fixtureOrganicSerpDetailed, type FixtureContext } from '../fixtures/index.js'

/**
 * PR 3: detailed SERP path keeps scoring organic-only while discovery can see packs.
 */

describe('normaliseOrganicResult still drops discussions packs', () => {
  const envelope = loadContract('serp_organic_with_discussions').payload
  const result = resultOf<Array<{ items?: Array<Record<string, unknown>> }>>(envelope)
  const block = Array.isArray(result) ? result[0] : undefined

  it('keeps only type=organic and uses rank_group', () => {
    const items = normaliseOrganicResult(block as never)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.position >= 1)).toBe(true)
    // Pack + local_pack + PAA must not appear as scored pages.
    expect(items.some((i) => i.domain.includes('quora'))).toBe(false)
    // First organic is yelp at rank_group 1 (not rank_absolute 3).
    expect(items[0]?.domain).toBe('yelp.com')
    expect(items[0]?.position).toBe(1)
  })

  it('extracts Reddit from organic and discussions pack separately', () => {
    const raw = (block?.items ?? []) as Array<Record<string, unknown>>
    const hits = extractRedditHitsFromDfsResult({ items: raw })
    expect(hits.some((h) => h.sourceKind === 'organic' && h.postId === '1org001')).toBe(true)
    expect(
      hits.filter((h) => h.sourceKind === 'discussions_and_forums').map((h) => h.postId).sort(),
    ).toEqual(['1pack01', '1pack02'])
    // Quora is not Reddit.
    expect(hits.every((h) => h.domain.includes('reddit'))).toBe(true)
  })

  it('findRedditPlacement reports both for a post only in one surface', () => {
    const raw = (block?.items ?? []) as Array<Record<string, unknown>>
    expect(findRedditPlacement(raw, '1org001').sourceKind).toBe('organic')
    expect(findRedditPlacement(raw, '1pack01').sourceKind).toBe('discussions_and_forums')
    expect(findRedditPlacement(raw, 'missing').sourceKind).toBeNull()
  })
})

describe('fixtureOrganicSerpDetailed', () => {
  const ctx: FixtureContext = {
    keyword: 'electrician near me',
    locationCode: 1013509,
    localityName: 'Tucson',
    stateCode: 'AZ',
    nicheNoun: 'electrician',
    nicheEmdToken: 'electrician',
  }

  it('snapshot stays organic-only for scoring', () => {
    const { snapshot, rawItems } = fixtureOrganicSerpDetailed(ctx)
    expect(snapshot.source).toBe('fixture')
    expect(snapshot.items.every((i) => i.position >= 1)).toBe(true)
    // Raw may include pack; snapshot never includes quora/reddit unless organic plan had them
    // (fixture organic plan does not seed reddit.com).
    expect(snapshot.items.every((i) => i.domain !== 'reddit.com')).toBe(true)
    expect(Array.isArray(rawItems)).toBe(true)
  })

  it('is deterministic for the same seed', () => {
    const a = fixtureOrganicSerpDetailed(ctx)
    const b = fixtureOrganicSerpDetailed(ctx)
    expect(a.rawItems).toEqual(b.rawItems)
  })
})
