import { describe, expect, it, vi } from 'vitest'
import {
  extractHotelBlPage,
  extractHotelBlSitemapIndexUrls,
  extractHotelBlSitemapUrls,
  fetchHotelBlPage,
  parseHotelBlRobots,
} from './crawl.js'

const pressHtml = `<!doctype html><html><head>
  <title>Press & Awards | Cedar House</title>
  <meta property="article:modified_time" content="2026-07-14T10:00:00Z">
</head><body>
  <h1>In the press</h1>
  <p>Cedar House was featured by <a href="https://travelweekly.example/story">Travel Weekly</a>.</p>
  <p>Also covered by <a href="https://smalltravel.example/cedar" rel="nofollow">Small Travel</a>.</p>
  <p><a href="https://instagram.com/cedarhouse">Instagram</a></p>
  <p><a href="https://booking.com/hotel/cedar">Book now</a></p>
  <p>Media contact: Jane Rivera, Director of Communications — <a href="mailto:press@cedarhouse.example">press@cedarhouse.example</a></p>
  <footer>Managed by <a href="https://cedarhospitality.example/portfolio">Cedar Hospitality</a></footer>
  <a href="/media-kit">Download our media kit</a>
</body></html>`

describe('Hotel Backlink Scout page extraction', () => {
  it('extracts editorial follow state, freshness, public contacts, and supported alternate entities', () => {
    const result = extractHotelBlPage(pressHtml, 'https://cedarhouse.example/press')
    expect(result.pageType).toBe('press')
    expect(result.editorialLinks).toHaveLength(2)
    expect(result.editorialLinks.map((link) => link.followed)).toEqual([true, false])
    expect(result.editorialLinks.some((link) => link.destinationDomain === 'instagram.com')).toBe(false)
    expect(result.latestContentDate?.toISOString()).toBe('2026-07-14T10:00:00.000Z')
    expect(result.dateConfidence).toBe(0.9)
    expect(result.contacts).toContainEqual(expect.objectContaining({ email: 'press@cedarhouse.example', contactType: 'pr' }))
    expect(result.alternateEntities).toContainEqual(expect.objectContaining({ relationshipType: 'management_company', domain: 'cedarhospitality.example', confidence: 0.82 }))
    expect(result.hasPressKit).toBe(true)
  })

  it('reads only explicit sitemap dates and relevant URLs can be filtered downstream', () => {
    expect(extractHotelBlSitemapUrls(`<?xml version="1.0"?><urlset><url><loc>https://hotel.test/press</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://hotel.test/image.jpg</loc></url></urlset>`)).toEqual([
      { url: 'https://hotel.test/press', lastModified: new Date('2026-01-02T00:00:00.000Z') },
      { url: 'https://hotel.test/image.jpg', lastModified: null },
    ])
    expect(extractHotelBlSitemapIndexUrls('<sitemapindex><sitemap><loc>https://hotel.test/pages.xml</loc></sitemap><sitemap><loc>https://hotel.test/press.xml</loc></sitemap></sitemapindex>')).toEqual([
      'https://hotel.test/pages.xml',
      'https://hotel.test/press.xml',
    ])
  })

  it('honors wildcard robots disallows', () => {
    const robots = 'User-agent: *\nDisallow: /private\nDisallow: /admin\n'
    expect(parseHotelBlRobots(robots, '/press')).toBe(true)
    expect(parseHotelBlRobots(robots, '/private/media')).toBe(false)
  })

  it('recognizes an explicit featured-in block on a homepage as editorial behavior', () => {
    const result = extractHotelBlPage(
      '<html><head><title>Cedar House</title></head><body><section><h2>As seen in</h2><a href="https://travelpress.example/cedar">Travel Press</a></section></body></html>',
      'https://cedarhouse.example/',
    )
    expect(result.pageType).toBe('other')
    expect(result.editorialLinks).toEqual([
      expect.objectContaining({ destinationDomain: 'travelpress.example', followed: true }),
    ])
  })

  it('requires directional relationship evidence instead of broad management prose', () => {
    const result = extractHotelBlPage(`
      <article>
        <p>Remington, a hotel management company, assumed management of
          <a href="https://marriott.example/courtyard">Courtyard Downtown</a>.
        </p>
        <p>This hotel is managed by
          <a href="https://remington.example">Remington Hospitality</a>.
        </p>
        <p>Media contact: <a href="mailto:press@agency.example">press@agency.example</a></p>
      </article>
    `, 'https://cedarhouse.example/about')
    expect(result.alternateEntities).toEqual([
      expect.objectContaining({ relationshipType: 'management_company', domain: 'remington.example' }),
    ])
  })

  it('retries transient responses with backoff and follows redirects', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>\0ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const result = await fetchHotelBlPage('https://hotel.test/press', { fetchImpl, sleep: async () => undefined })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
    expect(result.html).toBe('<html>ok</html>')
  })
})
