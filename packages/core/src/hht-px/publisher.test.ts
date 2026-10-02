import { describe, expect, it } from 'vitest'
import { assessHhtPxPublisher, hhtPxDiscoverySeeds, inspectPublisherHtml } from './index.js'

const ROUNDUP = `
<html><head><title>Romantic getaways in Vermont</title></head>
<body>
<a href="/about">About</a>
<a href="/contact">Contact</a>
<h2>Where to stay</h2>
<p>Written by Alex. We stayed at three inns. This post may contain affiliate links, including Booking.com.</p>
<p>The best hotels in Vermont for couples are the Stone Hill Inn, Twin Farms, and a small bed and breakfast in Stowe.</p>
</body></html>`

describe('publisher lanes', () => {
  it('excludes a major magazine without treating that as a guess from the word magazine', () => {
    const result = assessHhtPxPublisher({
      url: 'https://www.cntraveler.com/gallery/romantic-getaways',
      domain: 'cntraveler.com',
    })
    expect(result.lane).toBe('excluded')
    expect(result.evidence).toBe('observed')
    expect(result.editorialScore).toBeNull()
  })

  it('keeps an independent stay roundup that uses Booking.com affiliate links', () => {
    const result = assessHhtPxPublisher({
      url: 'https://exampleblog.com/vermont-getaways',
      domain: 'exampleblog.com',
      geographyName: 'Vermont',
      bestPosition: 4,
      volume: 720,
      inspection: inspectPublisherHtml(ROUNDUP),
    })
    expect(result.lane).toBe('paid_outreach')
    expect(result.qualification).toBe('outreach_ready')
    expect(result.insertionLocation).toMatch(/Where to stay/i)
    expect(result.readerBenefit).toMatch(/private hot tubs/i)
    expect(result.scoreDetail).toMatch(/no claim that they accept/)
    expect(result.editorialScore).not.toBeNull()
  })

  it('does not exclude a site just because the domain contains inn when the page was not fetched', () => {
    const result = assessHhtPxPublisher({
      url: 'https://stonehillinn.com/post/vermont-getaway',
      domain: 'stonehillinn.com',
      pageType: 'travel_blog',
    })
    expect(result.lane).toBe('needs_review')
    expect(result.evidence).toBe('unknown')
  })

  it('excludes a lodging operator once the page shows it sells its own rooms', () => {
    const result = assessHhtPxPublisher({
      url: 'https://stonehillinn.com/post/vermont-getaway',
      domain: 'stonehillinn.com',
      inspection: inspectPublisherHtml(`
        <html><body>
          <h1>Our rooms</h1>
          <a href="/book">Book now</a>
          <p>Check availability for our guest rooms. Nightly rate includes breakfast.</p>
        </body></html>
      `),
    })
    expect(result.lane).toBe('excluded')
    expect(result.reason).toMatch(/Lodging operator/)
  })

  it('sends an official tourism page to the earned list', () => {
    const result = assessHhtPxPublisher({
      url: 'https://www.visitvermont.com/romantic',
      domain: 'visitvermont.com',
      inspection: inspectPublisherHtml(`
        <html><body>
          <p>The official travel site. Plan your visit with the visitors bureau.</p>
          <a href="https://www.vermont.gov/">Vermont</a>
        </body></html>
      `),
    })
    expect(result.lane).toBe('earned_partnership')
    expect(result.editorialScore).toBeNull()
  })

  it('downgrades babymoon articles on an otherwise independent blog', () => {
    const result = assessHhtPxPublisher({
      url: 'https://exampleblog.com/babymoon',
      domain: 'exampleblog.com',
      inspection: inspectPublisherHtml(`
        <html><body>
          <a href="/contact">Contact</a>
          <h2>Where to stay</h2>
          <p>Written by Alex. We stayed at two hotels on our babymoon. Best hotels for a babymoon.</p>
        </body></html>
      `),
    })
    expect(result.lane).toBe('paid_outreach')
    expect(result.qualification).toBe('downgraded')
    expect(result.qualificationReason).toMatch(/Babymoon/)
  })
})

describe('discovery seeds', () => {
  it('keeps the concrete pilot separate from the larger seed library', () => {
    const seeds = hhtPxDiscoverySeeds()
    const phrases = new Set(seeds.map((seed) => seed.phrase))
    expect(phrases.has('romantic getaways in the Hudson Valley')).toBe(true)
    expect(phrases.has('romantic getaways from New York City')).toBe(true)
    expect(phrases.has('romantic inns in Cape Cod')).toBe(true)
    expect(phrases.has('romantic getaways in Pennsylvania')).toBe(true)
    expect(seeds.length).toBeGreaterThanOrEqual(200)
    expect(seeds.length).toBeLessThanOrEqual(320)
    expect(seeds.filter((seed) => seed.pilot).length).toBeGreaterThanOrEqual(50)
    expect(new Set(seeds.map((seed) => seed.phrase.toLowerCase())).size).toBe(seeds.length)
  })
})
