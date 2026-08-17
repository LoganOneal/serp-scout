import { describe, expect, it } from 'vitest'
import {
  dedupeHhtBlBacklinks,
  exactBacklinkKey,
  normalizeHhtBlDomain,
  normalizeHhtBlUrl,
  referringRelationshipKey,
} from './normalize.js'

describe('HHT backlink normalization', () => {
  it('normalizes domains without treating paths as part of the host', () => {
    expect(normalizeHhtBlDomain('HTTPS://WWW.Example.com/story')).toBe('example.com')
    expect(normalizeHhtBlDomain('not a domain')).toBeNull()
  })

  it('removes tracking parameters, fragments, and transport variants', () => {
    expect(
      normalizeHhtBlUrl('http://www.Example.com//travel/?utm_source=newsletter&b=2&a=1#hotels'),
    ).toBe('https://example.com/travel?a=1&b=2')
  })

  it('keeps exact links distinct from referring-domain relationships', () => {
    const first = {
      sourceUrl: 'https://guide.example.com/a',
      targetUrl: 'https://tubhotels.com/chicago',
      researchSite: 'tubhotels.com',
    }
    const second = { ...first, sourceUrl: 'https://guide.example.com/b' }
    expect(exactBacklinkKey(first)).not.toBe(exactBacklinkKey(second))
    expect(referringRelationshipKey(first)).toBe(referringRelationshipKey(second))
  })

  it('deduplicates exact backlink records globally', () => {
    const row = {
      sourceUrl: 'https://example.com/list?utm_medium=email',
      targetUrl: 'http://www.tubhotels.com/chicago/',
      researchSite: 'tubhotels.com',
      anchor: 'Chicago hotels',
    }
    expect(
      dedupeHhtBlBacklinks([
        row,
        {
          ...row,
          sourceUrl: 'https://www.example.com/list',
          targetUrl: 'https://tubhotels.com/chicago',
        },
      ]),
    ).toHaveLength(1)
  })
})

