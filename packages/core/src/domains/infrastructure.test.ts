import { describe, expect, it } from 'vitest'
import { hasLocalityToken, isInfrastructureHost } from './infrastructure.js'

describe('isInfrastructureHost', () => {
  it('catches the hosts a BBB category page reported as businesses', () => {
    // probe-wayback-directory reported 15 "business websites"; these were them.
    for (const h of [
      'doubleclick.net',
      'demdex.net',
      'omtrdc.net',
      'nr-data.net',
      'mouseflow.com',
      'bbbpromos.org',
      'give.org',
      'bbbmarketplacetrust.org',
    ]) {
      expect(isInfrastructureHost(h), h).toBe(true)
    }
  })

  it('catches YellowPages chrome seen on archived category pages', () => {
    for (const h of ['ypcdn.com', 'anywho.com', 'ingenio.com', 'keen.com', 'taleo.net']) {
      expect(isInfrastructureHost(h), h).toBe(true)
    }
  })

  it('matches subdomains, since that is how they appear in markup', () => {
    expect(isInfrastructureHost('cdn.mouseflow.com')).toBe(true)
    expect(isInfrastructureHost('bam.nr-data.net')).toBe(true)
  })

  it('excludes manufacturers a contractor links to', () => {
    // kohler.com was reported PARKED_DEAD at #2 on a timed-out probe.
    expect(isInfrastructureHost('kohler.com')).toBe(true)
    expect(isInfrastructureHost('carrier.com')).toBe(true)
  })

  it('does not catch a local business', () => {
    for (const h of ['mohrhusen.com', 'drainsruswi.com', 'villageplumber.biz']) {
      expect(isInfrastructureHost(h), h).toBe(false)
    }
  })
})

describe('hasLocalityToken', () => {
  it('rejects the wiki-spam network that inflated the citation-hub probe', () => {
    // The probe used a bare `.includes('wi')` and counted all of these as
    // Kenosha-local, along with kilo-wiki.win and oscar-wiki.win.
    for (const d of ['wikitrans.net', 'wikiland.org', 'wikiwand.com', 'kilo-wiki.win']) {
      expect(hasLocalityToken(d, 'wi'), d).toBe(false)
    }
  })

  it('still matches a real state-code usage', () => {
    expect(hasLocalityToken('drainsrus-wi.com', 'wi')).toBe(true)
    expect(hasLocalityToken('example.wi.us', 'wi')).toBe(true)
  })

  it('matches long tokens anywhere in the label', () => {
    expect(hasLocalityToken('godowntownkenosha.com', 'kenosha')).toBe(true)
    expect(hasLocalityToken('kenoshacountyeye.com', 'kenosha')).toBe(true)
  })

  it('ignores the TLD', () => {
    // Otherwise every domain matches the token "com".
    expect(hasLocalityToken('plumberwi.com', 'com')).toBe(false)
  })

  it('does not match a short token buried inside a word', () => {
    expect(hasLocalityToken('sandwiches.com', 'wi')).toBe(false)
    expect(hasLocalityToken('winner.com', 'wi')).toBe(false)
  })
})
