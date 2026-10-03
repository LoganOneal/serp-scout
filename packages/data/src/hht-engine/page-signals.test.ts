import { describe, expect, it } from 'vitest'
import { parsePageSignals } from './page-signals.js'

describe('page signals', () => {
  it('reads JSON-LD, a byline, and an affiliate link', () => {
    const html = `
      <html><head>
        <title>Romantic inns in western NC</title>
        <meta name="description" content="A weekend list.">
        <meta property="og:type" content="article">
        <meta property="article:published_time" content="2024-05-01">
        <script type="application/ld+json">{"@type":"BlogPosting","author":{"@type":"Person","name":"Ada"}}</script>
      </head><body>
        <article><h1>Romantic inns</h1><p class="byline">Ada</p><p>${'word '.repeat(900)}</p>
        <a href="https://www.booking.com/hotel/us.html?aid=123">Stay</a>
        <a href="https://www.expedia.com/Hotel-Search">Stay</a>
        </article>
      </body></html>`
    const parsed = parsePageSignals(html, 'https://imfixintoblog.com/romantic-inns-western-nc/')
    expect(parsed.signals.schemaTypes).toContain('BlogPosting')
    expect(parsed.signals.hasAuthor).toBe(true)
    expect(parsed.signals.hasAffiliate).toBe(true)
    expect(parsed.signals.outboundHotelOrOta).toBeGreaterThanOrEqual(2)
    expect(parsed.excerpt.split(' ').length).toBeLessThanOrEqual(300)
    expect(parsed.title).toContain('Romantic inns')
  })
})
