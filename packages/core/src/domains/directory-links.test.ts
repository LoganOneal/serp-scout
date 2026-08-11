import { describe, expect, it } from 'vitest'
import { buildDirectoryLinks } from './directory-links.js'

describe('buildDirectoryLinks', () => {
  const base = {
    domain: 'joesplumbing.com',
    businessName: "Joe's Plumbing",
    city: 'Houston',
    state: 'TX',
  }

  it('uses place_id for an exact profile link rather than a search', () => {
    const links = buildDirectoryLinks({ ...base, placeId: 'ChIJabc123' })
    const gbp = links.find((l) => l.label === 'Google Business Profile')
    expect(gbp?.kind).toBe('exact')
    expect(gbp?.url).toContain('place_id:ChIJabc123')
  })

  it('omits profile links when no identifier is held', () => {
    const links = buildDirectoryLinks(base)
    expect(links.find((l) => l.label === 'Google Business Profile')).toBeUndefined()
    expect(links.find((l) => l.label === 'Maps (CID)')).toBeUndefined()
  })

  it('searches the DOMAIN to find citations, excluding the domain itself', () => {
    const cited = buildDirectoryLinks(base).find((l) => l.label === 'Cited by')
    expect(cited?.url).toContain(encodeURIComponent('"joesplumbing.com"'))
    expect(cited?.url).toContain('-site:joesplumbing.com')
  })

  it('marks a directory the index has confirmed, and leaves the rest as guesses', () => {
    const links = buildDirectoryLinks({ ...base, confirmedCitations: ['bbb.org'] })
    expect(links.find((l) => l.label === 'BBB')?.kind).toBe('confirmed')
    expect(links.find((l) => l.label === 'Yelp')?.kind).toBe('search')
  })

  it('escapes names and localities into the query', () => {
    const yelp = buildDirectoryLinks(base).find((l) => l.label === 'Yelp')
    expect(yelp?.url).toContain(encodeURIComponent("Joe's Plumbing"))
    expect(yelp?.url).toContain(encodeURIComponent('Houston, TX'))
  })

  it('skips name-based directories when there is no business name', () => {
    // SERP-harvested rows carry a domain and nothing else; a search for an
    // empty name would return the whole directory.
    const links = buildDirectoryLinks({ domain: 'joesplumbing.com' })
    expect(links.find((l) => l.label === 'Yelp')).toBeUndefined()
    expect(links.find((l) => l.label === 'Cited by')).toBeDefined()
    expect(links.find((l) => l.label === 'Wayback')).toBeDefined()
  })
})

describe('citation links point at the page, not a search', () => {
  const base = {
    domain: 'kenoshatreeservice.com',
    businessName: "Kenosha Tree Service",
    city: 'Kenosha',
    state: 'WI',
  }

  it('opens the recorded BBB page instead of searching for the business', () => {
    // The complaint this fixes: a name search on a directory returns a page of
    // maybes, or nothing, and reads as a broken link.
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [
        {
          domain: 'bbb.org',
          urlFrom: 'https://www.bbb.org/us/wi/kenosha/profile/tree-service/kenosha-tree-0694-1000',
          pageStatus: 200,
        },
      ],
    })
    const bbb = links.find((l) => l.label === 'BBB')!
    expect(bbb.kind).toBe('exact')
    expect(bbb.url).toBe(
      'https://www.bbb.org/us/wi/kenosha/profile/tree-service/kenosha-tree-0694-1000',
    )
    expect(bbb.url).not.toContain('search')
  })

  it('refuses to link a citation whose page 404s', () => {
    // Replacing an unreliable search with a confident 404 would be worse: an
    // exact link claims more than a search does.
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [
        { domain: 'bbb.org', urlFrom: 'https://www.bbb.org/gone', pageStatus: 404 },
      ],
    })
    const bbb = links.find((l) => l.label === 'BBB')!
    expect(bbb.kind).toBe('confirmed')
    expect(bbb.url).toContain('bbb.org/search')
  })

  it('refuses to link a citation the index has lost', () => {
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [
        { domain: 'bbb.org', urlFrom: 'https://www.bbb.org/x', pageStatus: 200, isLost: true },
      ],
    })
    expect(links.find((l) => l.label === 'BBB')!.kind).toBe('confirmed')
  })

  it('still accepts a bare host from a row audited before URLs were collected', () => {
    const links = buildDirectoryLinks({ ...base, confirmedCitations: ['bbb.org'] })
    const bbb = links.find((l) => l.label === 'BBB')!
    expect(bbb.kind).toBe('confirmed')
    expect(bbb.hint).toMatch(/not recorded/)
  })

  it('routes a chamber citation through the Chamber chip, as an exact link', () => {
    // 'chamber' is a directory host, so this is matched by the directory pass
    // rather than the catch-all -- and it must still open the recorded page.
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [
        {
          domain: 'kenoshachamber.org',
          urlFrom: 'https://kenoshachamber.org/members/kenosha-tree-service',
          pageStatus: 200,
        },
      ],
    })
    const chamber = links.find((l) => l.url.includes('kenoshachamber.org/members'))!
    expect(chamber).toBeDefined()
    expect(chamber.kind).toBe('exact')
  })

  it('surfaces a citation from a site in no directory at all', () => {
    // A .gov licence register is exactly the kind of citation an operator would
    // never guess the URL of, and there is no chip for it to hide behind.
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [
        {
          domain: 'dsps.wi.gov',
          urlFrom: 'https://dsps.wi.gov/pages/credential/12345',
          pageStatus: 200,
        },
      ],
    })
    const gov = links.find((l) => l.label === 'dsps.wi.gov')!
    expect(gov).toBeDefined()
    expect(gov.kind).toBe('exact')
    expect(gov.url).toBe('https://dsps.wi.gov/pages/credential/12345')
  })

  it('never emits a non-http url as a clickable record', () => {
    const links = buildDirectoryLinks({
      ...base,
      confirmedCitations: [{ domain: 'bbb.org', urlFrom: 'javascript:alert(1)', pageStatus: 200 }],
    })
    expect(links.every((l) => /^https?:\/\//.test(l.url))).toBe(true)
  })

  it('drops the directory chips entirely when there is no name and no citation', () => {
    // A search built from an empty name is a link to a blank result page.
    const links = buildDirectoryLinks({ domain: 'example.com' })
    expect(links.find((l) => l.label === 'BBB')).toBeUndefined()
  })
})
