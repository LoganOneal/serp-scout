import { describe, expect, it } from 'vitest'
import {
  extractAuthorBioLinks,
  extractBlogrollLinks,
  extractBlogrollWidgetLinks,
  extractListingPostLinks,
  PoliteFetcher,
  scrapeLookalikeSeed,
} from './guest-lookalike.js'

const POST = `<html><body>
<nav><a href="https://navlink.com/">Nav</a></nav>
<article><p>Long article text <a href="https://cited-source.com/">source</a></p></article>
<div class="author-box"><p>Jane Doe writes at <a href="https://janewanders.com/">Jane Wanders</a>.
<a href="https://instagram.com/jane">IG</a> <a href="/about">About</a></p></div>
<p>Sam Lee is a travel writer based in Ohio. Read more at <a href="https://samroams.net/blog/">Sam Roams</a>.</p>
</body></html>`

describe('lookalike HTML extraction', () => {
  it('takes external links from bio boxes and plain-text bios only', () => {
    const links = extractAuthorBioLinks(POST, 'https://seed.com/2024/post/').map((link) => link.url)
    expect(links).toContain('https://janewanders.com/')
    expect(links).toContain('https://instagram.com/jane')
    expect(links).toContain('https://samroams.net/blog/')
    expect(links).not.toContain('https://cited-source.com/')
    expect(links.some((url) => url.includes('seed.com'))).toBe(false)
  })

  it('reads blogroll page content but not nav or footer', () => {
    const html = `<body><header><a href="https://hdr.com/">h</a></header>
      <main><ul><li><a href="https://blog-one.com/">One</a></li><li><a href="https://seed.com/x">self</a></li>
      <li><a href="https://blog-two.org/">Two</a></li></ul></main><footer><a href="https://ftr.com/">f</a></footer></body>`
    expect(extractBlogrollLinks(html, 'https://seed.com/resources/').map((l) => l.url)).toEqual([
      'https://blog-one.com/',
      'https://blog-two.org/',
    ])
  })

  it('reads blogroll widgets by heading', () => {
    const html = `<aside><section class="widget"><h3>Blogs We Love</h3><a href="https://friend.com/">Friend</a></section>
      <section class="widget"><h3>Recent posts</h3><a href="https://seed.com/p">p</a><a href="https://ad.com/">ad</a></section></aside>`
    expect(extractBlogrollWidgetLinks(html, 'https://seed.com/').map((l) => l.url)).toEqual(['https://friend.com/'])
  })

  it('lists same-site posts on a guest listing page', () => {
    const html = `<article><h2><a href="https://seed.com/a-guest-post/">A</a></h2></article>
      <article><h2><a href="https://seed.com/category/guest/page/2/">next</a></h2></article>
      <article><h2><a href="https://other.com/x/">x</a></h2></article>`
    expect(extractListingPostLinks(html, 'https://seed.com/category/guest/')).toEqual(['https://seed.com/a-guest-post/'])
  })
})

describe('scrapeLookalikeSeed', () => {
  const page = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } })

  it('respects robots.txt and finds bio and blogroll links', async () => {
    const requested: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/robots.txt')) return page('User-agent: *\nDisallow: /private/')
      if (url === 'https://seed.com/') {
        return page(`<a href="/author/jane-doe/">Jane</a><a href="/blogs-we-love/">Blogs we love</a><a href="/private/resources/">Resources</a>`)
      }
      if (url === 'https://seed.com/author/jane-doe/') return page(`<div class="author-bio">Jane writes at <a href="https://janewanders.com/">JW</a></div>`)
      if (url === 'https://seed.com/blogs-we-love/') return page(`<main><a href="https://friend-blog.com/">Friend</a></main>`)
      return page('nope', 404)
    }) as typeof fetch
    const fetcher = new PoliteFetcher({ spacingMs: 0, fetchImpl, sleep: async () => undefined })
    const scraped = await scrapeLookalikeSeed(fetcher, 'seed.com', { signals: ['author_bio', 'blogroll'] })
    expect(scraped.hits).toEqual(
      expect.arrayContaining([
        { seed: 'seed.com', signal: 'author_bio', url: 'https://janewanders.com/' },
        { seed: 'seed.com', signal: 'blogroll', url: 'https://friend-blog.com/' },
      ]),
    )
    expect(requested).not.toContain('https://seed.com/private/resources/')
    expect(requested.filter((url) => url.endsWith('/robots.txt'))).toHaveLength(1)
  })
})
