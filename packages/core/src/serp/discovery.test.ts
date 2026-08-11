import { describe, expect, it } from 'vitest'
import { extractRedditHitsFromDfsResult, findRedditPlacement } from './discovery.js'

const ORGANIC_REDDIT = {
  type: 'organic',
  rank_group: 3,
  rank_absolute: 5,
  domain: 'www.reddit.com',
  url: 'https://www.reddit.com/r/electricians/comments/1abc234/best_electrician_in_austin/',
  title: 'Best electrician in Austin?',
}

const ORGANIC_OTHER = {
  type: 'organic',
  rank_group: 1,
  rank_absolute: 1,
  domain: 'angi.com',
  url: 'https://www.angi.com/companylist/us/tx/austin/electricians.htm',
  title: 'Electricians in Austin',
}

const DISCUSSIONS_PACK = {
  type: 'discussions_and_forums',
  rank_absolute: 4,
  items: [
    {
      type: 'discussions_and_forums_element',
      url: 'https://www.reddit.com/r/Austin/comments/9xyz789/need_electrician_recommendations/',
      title: 'Need electrician recommendations',
      domain: 'reddit.com',
    },
    {
      type: 'discussions_and_forums_element',
      url: 'https://www.quora.com/Who-is-the-best-electrician-in-Austin',
      title: 'Who is the best electrician?',
      domain: 'quora.com',
    },
    {
      type: 'discussions_and_forums_element',
      url: 'https://www.reddit.com/r/HomeImprovement/comments/1abc234/another_title/',
      title: 'Same post also in pack',
      domain: 'reddit.com',
    },
  ],
}

describe('extractRedditHitsFromDfsResult', () => {
  it('returns empty for missing or empty items', () => {
    expect(extractRedditHitsFromDfsResult({})).toEqual([])
    expect(extractRedditHitsFromDfsResult({ items: null })).toEqual([])
    expect(extractRedditHitsFromDfsResult({ items: [] })).toEqual([])
  })

  it('extracts organic Reddit with rank_group and skips non-Reddit organic', () => {
    const hits = extractRedditHitsFromDfsResult({
      items: [ORGANIC_OTHER, ORGANIC_REDDIT] as Array<Record<string, unknown>>,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      postId: '1abc234',
      subreddit: 'electricians',
      sourceKind: 'organic',
      organicPosition: 3,
      rankAbsolute: 5,
      packPosition: null,
      domain: 'reddit.com',
    })
  })

  it('extracts discussions pack Reddit only and numbers pack position', () => {
    const hits = extractRedditHitsFromDfsResult({
      items: [DISCUSSIONS_PACK] as Array<Record<string, unknown>>,
    })
    // Quora skipped; two Reddit elements
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      postId: '9xyz789',
      sourceKind: 'discussions_and_forums',
      packPosition: 1,
      organicPosition: null,
      subreddit: 'Austin',
    })
    expect(hits[1]).toMatchObject({
      postId: '1abc234',
      sourceKind: 'discussions_and_forums',
      packPosition: 2,
    })
  })

  it('keeps organic and pack as separate hits for the same post id', () => {
    const hits = extractRedditHitsFromDfsResult({
      items: [ORGANIC_REDDIT, DISCUSSIONS_PACK] as Array<Record<string, unknown>>,
    })
    const same = hits.filter((h) => h.postId === '1abc234')
    expect(same).toHaveLength(2)
    expect(same.map((h) => h.sourceKind).sort()).toEqual([
      'discussions_and_forums',
      'organic',
    ])
  })

  it('skips share links that cannot be parsed', () => {
    const hits = extractRedditHitsFromDfsResult({
      items: [
        {
          type: 'organic',
          rank_group: 2,
          domain: 'reddit.com',
          url: 'https://www.reddit.com/r/HVAC/s/AbCdEfGh',
          title: 'share',
        },
      ],
    })
    expect(hits).toEqual([])
  })

  it('never throws on garbage nest shapes', () => {
    expect(() =>
      extractRedditHitsFromDfsResult({
        items: [
          { type: 'discussions_and_forums', items: 'nope' },
          { type: 'discussions_and_forums', items: [null, 42, { type: 'x' }] },
          { type: 'video', url: 'https://youtube.com/x' },
          null as unknown as Record<string, unknown>,
        ],
      }),
    ).not.toThrow()
  })
})

describe('findRedditPlacement', () => {
  it('returns both when post is organic and in pack', () => {
    const p = findRedditPlacement(
      [ORGANIC_REDDIT, DISCUSSIONS_PACK] as Array<Record<string, unknown>>,
      '1abc234',
    )
    expect(p.sourceKind).toBe('both')
    expect(p.organicPosition).toBe(3)
    expect(p.packPosition).toBe(2)
  })

  it('returns pack-only placement', () => {
    const p = findRedditPlacement(
      [DISCUSSIONS_PACK] as Array<Record<string, unknown>>,
      '9xyz789',
    )
    expect(p).toEqual({
      organicPosition: null,
      packPosition: 1,
      rankAbsolute: 4, // parent discussions_and_forums rank_absolute
      sourceKind: 'discussions_and_forums',
    })
  })

  it('returns null sourceKind when absent', () => {
    const p = findRedditPlacement(
      [ORGANIC_OTHER] as Array<Record<string, unknown>>,
      '1abc234',
    )
    expect(p.sourceKind).toBeNull()
    expect(p.organicPosition).toBeNull()
    expect(p.packPosition).toBeNull()
  })
})
