import { describe, expect, it } from 'vitest'
import {
  blogrollPageCandidates,
  capLookalikeCandidates,
  guestPageCandidates,
  isAuthorArchiveUrl,
  isBlogrollPageLink,
  lookalikeKeyword,
  lookalikeKeywordKey,
  lookalikePosition,
  mergeLookalikeHits,
  parseLookalikeKeyword,
  parseOrganicCompetitors,
  parseWpUsers,
  selectOrganicCompetitors,
  trackerSeeds,
  type LookalikeHit,
} from './guest-lookalike.js'

describe('trackerSeeds', () => {
  it('keeps PURSUE rows as seeds and tracks every domain', () => {
    const { seeds, tracked } = trackerSeeds([
      { site: 'https://www.Alpha-Travel.com/write-for-us', verdict: 'PURSUE' },
      { site: 'beta.com', verdict: 'SKIP_NO_GUEST' },
      { site: 'alpha-travel.com', verdict: 'pursue' },
      { site: 'gamma.co.uk', verdict: 'PURSUE' },
      { site: '', verdict: 'PURSUE' },
    ])
    expect(seeds).toEqual(['alpha-travel.com', 'gamma.co.uk'])
    expect([...tracked].sort()).toEqual(['alpha-travel.com', 'beta.com', 'gamma.co.uk'])
  })
})

describe('lookalike keyword rows', () => {
  it('round-trips signal and seed', () => {
    expect(lookalikeKeyword('author_bio', 'a.com')).toBe('lookalike author_bio a.com')
    expect(parseLookalikeKeyword('lookalike author_bio a.com')).toEqual({ signal: 'author_bio', seed: 'a.com' })
    expect(parseLookalikeKeyword(lookalikeKeywordKey('blogroll', 'b.org'))).toEqual({ signal: 'blogroll', seed: 'b.org' })
    expect(parseLookalikeKeyword('things to do in austin')).toBeNull()
    expect(parseLookalikeKeyword('lookalike nonsense a.com')).toBeNull()
  })
})

describe('organic competitors', () => {
  it('parses the raw Semrush export', () => {
    const rows = parseOrganicCompetitors(
      'Domain;Competitor Relevance;Common Keywords;Organic Keywords;Organic Traffic;Organic Cost\n' +
        'tubandspahotels.com;0.07;10;3402;405;319\nbigbrand.com;0.05;300;900000;5000000;1\n',
    )
    expect(rows).toEqual([
      { domain: 'tubandspahotels.com', relevance: 0.07, commonKeywords: 10, organicKeywords: 3402, organicTraffic: 405 },
      { domain: 'bigbrand.com', relevance: 0.05, commonKeywords: 300, organicKeywords: 900000, organicTraffic: 5000000 },
    ])
  })

  it('parses MCP record arrays', () => {
    expect(parseOrganicCompetitors([{ domain: 'x.com', common_keywords: '12', organic_traffic: '1,200' }])).toEqual([
      { domain: 'x.com', relevance: null, commonKeywords: 12, organicKeywords: null, organicTraffic: 1200 },
    ])
    expect(parseOrganicCompetitors(null)).toEqual([])
  })

  it('drops brands and weak overlaps but keeps rank', () => {
    const picked = selectOrganicCompetitors([
      { domain: 'big.com', relevance: 0.5, commonKeywords: 400, organicKeywords: 1e6, organicTraffic: 3e6 },
      { domain: 'small.com', relevance: 0.3, commonKeywords: 40, organicKeywords: 2000, organicTraffic: 900 },
      { domain: 'thin.com', relevance: 0.1, commonKeywords: 2, organicKeywords: 50, organicTraffic: 10 },
    ])
    expect(picked.map((row) => [row.domain, row.rank, !!row.dropped])).toEqual([
      ['big.com', 1, true],
      ['small.com', 2, false],
      ['thin.com', 3, true],
    ])
  })
})

describe('seed page link classification', () => {
  it('finds guest author archives but not the house account', () => {
    expect(isAuthorArchiveUrl('https://seed.com/author/jane-doe/')).toBe(true)
    expect(isAuthorArchiveUrl('https://seed.com/author/admin/')).toBe(false)
    expect(isAuthorArchiveUrl('https://seed.com/2024/05/post/')).toBe(false)
  })

  it('picks same-site author archives and guest listings', () => {
    const picked = guestPageCandidates(
      [
        { url: 'https://seed.com/author/jane/', anchor: 'Jane' },
        { url: 'https://seed.com/author/jane', anchor: 'Jane again' },
        { url: 'https://other.com/author/bob/', anchor: 'Bob' },
        { url: 'https://seed.com/category/guest-posts/', anchor: 'Guest Posts' },
        { url: 'https://seed.com/contributors-page', anchor: 'Our contributors' },
        { url: 'https://seed.com/about/', anchor: 'About' },
      ],
      'seed.com',
    )
    expect(picked.authors).toEqual(['https://seed.com/author/jane/'])
    expect(picked.listings).toEqual(['https://seed.com/category/guest-posts/', 'https://seed.com/contributors-page'])
  })

  it('recognises resources, blogroll and collaboration pages', () => {
    expect(isBlogrollPageLink('https://seed.com/travel-resources/', '')).toBe(true)
    expect(isBlogrollPageLink('https://seed.com/blogs-we-love', '')).toBe(true)
    expect(isBlogrollPageLink('https://seed.com/work-together', 'Collaborations')).toBe(true)
    expect(isBlogrollPageLink('https://seed.com/best-hotels/', 'Best hotels')).toBe(false)
    expect(
      blogrollPageCandidates(
        [
          { url: 'https://seed.com/resources/', anchor: 'Resources' },
          { url: 'https://seed.com/resources', anchor: 'Resources' },
          { url: 'https://elsewhere.com/resources/', anchor: 'Resources' },
          { url: 'https://seed.com/favorite-blogs/', anchor: 'Blogs' },
          { url: 'https://seed.com/links/', anchor: 'Links' },
        ],
        'seed.com',
      ),
    ).toEqual(['https://seed.com/resources/', 'https://seed.com/favorite-blogs/'])
  })
})

describe('parseWpUsers', () => {
  it('reads author websites, description links and archives', () => {
    const body = JSON.stringify([
      { slug: 'owner', url: 'https://seed.com', description: '', link: 'https://seed.com/author/owner/' },
      { slug: 'jane', url: 'https://janewanders.com', description: 'Also at https://janeeats.net/blog.', link: 'https://seed.com/author/jane/' },
      { slug: 'admin', url: '', description: '', link: 'https://seed.com/author/admin/' },
    ])
    expect(parseWpUsers(body, 'seed.com')).toEqual({
      bioUrls: ['https://janewanders.com', 'https://janeeats.net/blog'],
      archiveUrls: ['https://seed.com/author/jane/', 'https://seed.com/author/owner/'],
    })
    expect(parseWpUsers('<html>blocked</html>', 'seed.com')).toEqual({ bioUrls: [], archiveUrls: [] })
    expect(parseWpUsers('{"code":"rest_no_route"}', 'seed.com')).toEqual({ bioUrls: [], archiveUrls: [] })
  })
})

describe('mergeLookalikeHits', () => {
  const hits: LookalikeHit[] = [
    { seed: 'a.com', signal: 'organic_competitor', url: 'twin-blog.com', rank: 1 },
    { seed: 'b.com', signal: 'organic_competitor', url: 'twin-blog.com', rank: 4 },
    { seed: 'a.com', signal: 'author_bio', url: 'https://www.writer-site.com/about/' },
    { seed: 'a.com', signal: 'author_bio', url: 'https://writer-site.com/' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://b.com/' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://a.com/self' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://facebook.com/someone' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://bestseoservices.com/' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://reiseblog.de/' },
    { seed: 'a.com', signal: 'blogroll', url: 'https://already.com/' },
  ]

  it('dedupes against known domains, drops seeds and junk, and records provenance', () => {
    const merged = mergeLookalikeHits(hits, new Set(['b.com', 'already.com']))
    expect(merged.candidates.map((c) => [c.domain, c.hits, c.position, c.signals, c.seeds])).toEqual([
      ['twin-blog.com', 2, 8, ['organic_competitor'], ['a.com', 'b.com']],
      ['writer-site.com', 1, 10, ['author_bio'], ['a.com']],
    ])
    expect(merged.known).toBe(2)
    expect(merged.junk.map((j) => j.domain).sort()).toEqual(['bestseoservices.com', 'facebook.com', 'reiseblog.de'])
    expect(merged.rows).toHaveLength(3)
    expect(merged.rows.find((row) => row.domain === 'writer-site.com')?.url).toBe('https://www.writer-site.com/about/')
  })

  it('caps candidates and their rows together', () => {
    const capped = capLookalikeCandidates(mergeLookalikeHits(hits, new Set()), 1)
    expect(capped.candidates.map((c) => c.domain)).toEqual(['twin-blog.com'])
    expect(capped.rows.every((row) => row.domain === 'twin-blog.com')).toBe(true)
  })

  it('ranks bio links above deep competitors and blogrolls', () => {
    expect(lookalikePosition({ signal: 'author_bio' })).toBeLessThan(lookalikePosition({ signal: 'blogroll' }))
    expect(lookalikePosition({ signal: 'organic_competitor', rank: 1 })).toBeLessThan(lookalikePosition({ signal: 'author_bio' }))
    expect(lookalikePosition({ signal: 'organic_competitor', rank: 30 })).toBe(60)
  })
})
