import { describe, expect, it } from 'vitest'
import { buildSerpLeads, isFootprintUrl, serpHitJunkReason, type SerpHit } from './serp-leads.js'

const hit = (url: string, position: number, keywordId = 1, extra: Partial<SerpHit> = {}): SerpHit => ({
  url,
  domain: new URL(url).hostname,
  position,
  keywordId,
  keyword: `query ${keywordId}`,
  bucket: 'topic_wfu',
  leadType: 'guest_post',
  ...extra,
})

describe('SERP lead pre-filter', () => {
  it('recognises write-for-us style URLs', () => {
    expect(isFootprintUrl('https://a.com/write-for-us/')).toBe(true)
    expect(isFootprintUrl('https://a.com/travel-write-for-us')).toBe(true)
    expect(isFootprintUrl('https://a.com/contributor-guidelines')).toBe(true)
    expect(isFootprintUrl('https://a.com/best-hotels-in-chicago/')).toBe(false)
  })

  it('drops sellers, listicles, social sites and non-US ccTLDs', () => {
    expect(serpHitJunkReason('https://shop-z.com/buy-guest-posts', 'shop-z.com')).toMatch(/sells/)
    expect(serpHitJunkReason('https://list-z.com/travel-blogs-that-accept-guest-posts/', 'list-z.com')).toMatch(/listicle/)
    expect(serpHitJunkReason('https://seoagency.com/write-for-us', 'seoagency.com')).toMatch(/SEO/)
    expect(serpHitJunkReason('https://www.pinterest.com/pin/1', 'pinterest.com')).not.toBeNull()
    expect(serpHitJunkReason('https://reiseblog.de/gastbeitrag', 'reiseblog.de')).toMatch(/ccTLD/)
    expect(serpHitJunkReason('https://travelblog.in/write-for-us', 'travelblog.in')).toMatch(/non-US/)
    expect(serpHitJunkReason('https://wanderblog.com/write-for-us', 'wanderblog.com')).toBeNull()
  })

  it('groups by domain, prefers footprint URLs and scores repeat hits', () => {
    const { leads, junk } = buildSerpLeads([
      hit('https://www.blog-a.com/hotels/', 3, 1),
      hit('https://blog-a.com/write-for-us', 20, 2),
      hit('https://blog-b.co.uk/write-for-us', 5, 1),
      hit('https://blog-c.com/buy-guest-posts', 1, 1),
    ])
    const a = leads.find((l) => l.domain === 'blog-a.com')
    expect(a).toMatchObject({ opportunityUrl: 'https://blog-a.com/write-for-us', bestPosition: 3, queryHits: 2, sourceQuery: 'query 2' })
    expect(a?.score).toBe(97 + 40 + 10)
    expect(leads.find((l) => l.domain === 'blog-b.co.uk')?.score).toBe(95 + 40 - 15)
    expect(junk).toEqual([{ domain: 'blog-c.com', reason: 'sells guest posts or SEO links' }])
  })

  it('keeps link-insertion hits separate and without the footprint bonus', () => {
    const { leads } = buildSerpLeads([
      hit('https://blog-a.com/best-hot-tub-hotels/', 2, 9, { leadType: 'link_insertion', bucket: 'link_insertion' }),
      hit('https://blog-a.com/write-for-us', 10, 1),
    ])
    expect(leads.map((l) => `${l.leadType}:${l.domain}`).sort()).toEqual(['guest_post:blog-a.com', 'link_insertion:blog-a.com'])
    expect(leads.find((l) => l.leadType === 'link_insertion')?.score).toBe(98)
  })
})
