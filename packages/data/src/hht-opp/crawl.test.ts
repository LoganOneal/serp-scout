import { describe, expect, it } from 'vitest'
import { analyzeOutbound, extractRelatedUrls, listOutboundLinks, pageLinksToHht, pageMentionsHht, sanitizePageBytes } from './crawl.js'

const html = `
<html><body>
  <a href="/write-for-us">Write for Us</a>
  <a href="https://hotelhottubs.com/vermont">HotelHotTubs</a>
  <a href="https://casino.example/offer">Casino</a>
  <a href="/about">About</a>
</body></html>
`

describe('hht opp crawl helpers', () => {
  it('detects HHT mentions and outbound links', () => {
    expect(pageMentionsHht('We cited Hotel Hot Tubs in our roundup.')).toBe(true)
    expect(pageLinksToHht(html, 'https://publisher.com/story')).toBe(true)
    expect(pageLinksToHht('<a href="/local">x</a>', 'https://publisher.com/story')).toBe(false)
  })

  it('samples outbound links without claiming sitewide totals', () => {
    const sample = analyzeOutbound(html, 'https://publisher.com/story')
    expect(sample.externalLinks).toBe(2)
    expect(sample.internalLinks).toBe(2)
    expect(sample.commercialLinks).toBeGreaterThanOrEqual(1)
    expect(extractRelatedUrls(html, 'https://publisher.com/story')).toContain('https://publisher.com/write-for-us')
  })

  it('lists outbound publisher links without counting internal nav', () => {
    const links = listOutboundLinks(html, 'https://publisher.com/story')
    expect(links.some((link) => link.domain === 'hotelhottubs.com')).toBe(true)
    expect(links.every((link) => link.domain !== 'publisher.com')).toBe(true)
  })

  it('strips null bytes so Postgres will accept the page', () => {
    expect(sanitizePageBytes('hello\u0000world')).toBe('helloworld')
  })
})
