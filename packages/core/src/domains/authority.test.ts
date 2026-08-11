import { describe, expect, it } from 'vitest'
import { classifyAuthority, summariseAuthority } from './authority.js'

describe('classifyAuthority', () => {
  it('recognises BBB, including regional properties', () => {
    expect(classifyAuthority({ domain: 'bbb.org' })?.kind).toBe('bbb')
    expect(classifyAuthority({ domain: 'dallas.bbb.org' })?.kind).toBe('bbb')
  })

  it('treats restricted-registration TLDs as the strongest signal', () => {
    expect(classifyAuthority({ domain: 'dallascityhall.gov' })?.kind).toBe('government')
    expect(classifyAuthority({ domain: 'utdallas.edu' })?.kind).toBe('education')
  })

  it('catches chambers by name as well as by exact domain', () => {
    expect(classifyAuthority({ domain: 'dallaschamber.org' })?.kind).toBe('chamber')
    expect(classifyAuthority({ domain: 'chamberofcommerce.com' })?.kind).toBe('chamber')
  })

  it('recognises trade associations', () => {
    expect(classifyAuthority({ domain: 'acca.org' })?.kind).toBe('trade_association')
  })

  it('returns null for ordinary domains rather than guessing a tier', () => {
    // A false "authority citation" would inflate a domain's apparent worth,
    // which is the one thing this feature must not do.
    expect(classifyAuthority({ domain: 'home-decor-online.com' })).toBeNull()
    expect(classifyAuthority({ domain: 'qdexx.com' })).toBeNull()
    expect(classifyAuthority({ domain: '' })).toBeNull()
  })

  it('carries rank and backlink counts through', () => {
    const m = classifyAuthority({ domain: 'bbb.org', rank: 612, backlinks: 3 })
    expect(m?.rank).toBe(612)
    expect(m?.backlinks).toBe(3)
  })
})

describe('summariseAuthority', () => {
  it('scores a genuine citation profile above a pile of spam', () => {
    const real = summariseAuthority([
      { domain: 'bbb.org' },
      { domain: 'dallaschamber.org' },
      { domain: 'tdlr.texas.gov' },
    ])
    const spam = summariseAuthority(
      Array.from({ length: 40 }, (_, i) => ({ domain: `spam-blog-${i}.ru` })),
    )
    expect(real.score).toBeGreaterThan(spam.score)
    expect(spam.score).toBe(0)
    expect(real.hasHardToReplace).toBe(true)
  })

  it('counts each kind once, so repetition cannot dominate', () => {
    const many = summariseAuthority([
      { domain: 'yelp.com' },
      { domain: 'angi.com' },
      { domain: 'houzz.com' },
      { domain: 'manta.com' },
      { domain: 'thumbtack.com' },
    ])
    const one = summariseAuthority([{ domain: 'yelp.com' }])
    expect(many.score).toBe(one.score)
    expect(many.matches).toHaveLength(5)
  })

  it('ranks the hardest-to-replace citation first', () => {
    const p = summariseAuthority([
      { domain: 'yelp.com' },
      { domain: 'tdlr.texas.gov' },
      { domain: 'bbb.org' },
    ])
    expect(p.matches[0]?.kind).toBe('government')
    expect(p.kinds).toContain('bbb')
  })

  it('does not claim a hard-to-replace citation for directories alone', () => {
    const p = summariseAuthority([{ domain: 'yelp.com' }, { domain: 'yellowpages.com' }])
    expect(p.hasHardToReplace).toBe(false)
    expect(p.score).toBeGreaterThan(0)
  })

  it('handles an empty profile', () => {
    const p = summariseAuthority([])
    expect(p.score).toBe(0)
    expect(p.matches).toEqual([])
    expect(p.hasHardToReplace).toBe(false)
  })
})
