import { describe, expect, it } from 'vitest'
import { dedupeDomains, registrableDomain } from './normalize.js'

describe('registrableDomain', () => {
  it('reduces a full URL to eTLD+1', () => {
    expect(registrableDomain('https://www.joesplumbing.com/services?utm=x')?.domain).toBe(
      'joesplumbing.com',
    )
  })

  it('accepts a bare host with no scheme', () => {
    expect(registrableDomain('joesplumbing.com')?.domain).toBe('joesplumbing.com')
  })

  it('lowercases', () => {
    expect(registrableDomain('HTTP://JoesPlumbing.COM')?.domain).toBe('joesplumbing.com')
  })

  it('keeps multi-part public suffixes intact', () => {
    // The whole reason for a real PSL: naive split-on-dot yields "co.uk".
    expect(registrableDomain('https://joesplumbing.co.uk/')?.domain).toBe('joesplumbing.co.uk')
  })

  it('rejects IP addresses', () => {
    expect(registrableDomain('http://192.168.1.1/')).toBeNull()
  })

  it('rejects junk and empty input', () => {
    expect(registrableDomain('')).toBeNull()
    expect(registrableDomain(null)).toBeNull()
    expect(registrableDomain('not a url at all')).toBeNull()
  })

  it('collapses a free site-builder subdomain onto the platform domain', () => {
    const n = registrableDomain('https://joesplumbing.wixsite.com/home')
    expect(n?.domain).toBe('wixsite.com')
    expect(n?.nonAcquirable).toBe(true)
  })

  it('flags directory and social hosts as non-acquirable', () => {
    expect(registrableDomain('https://www.yelp.com/biz/joes-plumbing')?.nonAcquirable).toBe(true)
    expect(registrableDomain('https://facebook.com/joesplumbing')?.nonAcquirable).toBe(true)
    expect(registrableDomain('https://joesplumbing.business.site')?.nonAcquirable).toBe(true)
  })

  it('does not flag an ordinary business domain', () => {
    expect(registrableDomain('https://joesplumbing.com')?.nonAcquirable).toBe(false)
  })
})

describe('dedupeDomains', () => {
  it('merges www and bare variants into one candidate', () => {
    const { domains } = dedupeDomains([
      { name: 'Joe A', website: 'https://www.joesplumbing.com' },
      { name: 'Joe B', website: 'http://joesplumbing.com/contact' },
    ])
    expect(domains).toHaveLength(1)
    expect(domains[0]?.domain).toBe('joesplumbing.com')
    expect(domains[0]?.businesses).toHaveLength(2)
  })

  it('separates the two reasons a business produced no candidate', () => {
    const result = dedupeDomains([
      { name: 'Platform', website: 'https://yelp.com/biz/x' },
      { name: 'Nothing', website: null },
      { name: 'Real', website: 'https://realplumber.com' },
    ])
    expect(result.skippedPlatform).toBe(1)
    expect(result.skippedNoDomain).toBe(1)
    expect(result.domains).toHaveLength(1)
  })
})
