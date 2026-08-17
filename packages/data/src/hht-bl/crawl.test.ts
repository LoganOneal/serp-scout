import { describe, expect, it, vi } from 'vitest'
import { crawlHhtBlPage, extractHhtBlLinkContext } from './crawl.js'

const html = `<!doctype html>
<html>
  <head><title>Chicago travel guide</title><link rel="canonical" href="/guides/chicago"></head>
  <body>
    <main>
      <h1>Chicago</h1>
      <section>
        <h2>Where to stay</h2>
        <p>For a private spa experience, see <a href="https://www.tubhotels.com/hotel-with-jacuzzi-in-room-in-chicago/?utm_source=guide">Chicago hotels with Jacuzzi</a>.</p>
        <p><a href="https://other.example/hotels">Other hotels</a></p>
      </section>
    </main>
  </body>
</html>`

describe('HHT backlink crawling and evidence extraction', () => {
  it('retries a transient response and preserves the successful page evidence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ) as unknown as typeof fetch
    const result = await crawlHhtBlPage('https://guide.example/story', {
      fetchImpl,
      sleep: async () => undefined,
    })
    expect(result.attempts).toBe(2)
    expect(result.title).toBe('Chicago travel guide')
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.rawHtml).toContain('Where to stay')
  })

  it('extracts the specific linked paragraph, section, headings, and nearby links', () => {
    const result = extractHhtBlLinkContext(
      html,
      'https://guide.example/guides/chicago',
      'https://tubhotels.com/hotel-with-jacuzzi-in-room-in-chicago/',
    )
    expect(result.located).toBe(true)
    expect(result.anchor).toBe('Chicago hotels with Jacuzzi')
    expect(result.surroundingParagraph).toContain('private spa experience')
    expect(result.surroundingSection).toContain('Other hotels')
    expect(result.nearbyOutboundLinks).toHaveLength(2)
    expect(result.domContext).toContain('tubhotels.com')
  })
})

