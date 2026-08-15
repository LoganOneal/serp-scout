import { describe, expect, it } from 'vitest'
import { cleanEmail, fetchContactPages, htmlToText } from './contacts.js'

describe('htmlToText', () => {
  /**
   * The failure this hoisting exists to prevent: an address published ONLY as a
   * mailto href, which a naive tag-strip deletes along with the tag — losing
   * exactly the field the fetch was for.
   */
  it('hoists mailto addresses out of hrefs before stripping tags', () => {
    const html = `<p>Reach the team <a href="mailto:editor@example.com">here</a>.</p>`
    const text = htmlToText(html)
    expect(text).toMatch(/editor@example\.com/)
  })

  it('drops script and style bodies rather than treating them as page text', () => {
    const html = `<script>var secret="editor@evil.com"</script><style>.a{}</style><p>Hello</p>`
    const text = htmlToText(html)
    expect(text).not.toMatch(/evil/)
    expect(text).toMatch(/Hello/)
  })

  it('decodes the entities that appear in contact blocks', () => {
    expect(htmlToText('<p>Jones&nbsp;&amp;&nbsp;Co</p>')).toMatch(/Jones & Co/)
  })
})

describe('cleanEmail — reject, never repair', () => {
  it('de-obfuscates the forms publishers actually use', () => {
    expect(cleanEmail('editor [at] example [dot] com')).toBe('editor@example.com')
    expect(cleanEmail('editor (at) example (dot) com')).toBe('editor@example.com')
    expect(cleanEmail('editor at example dot com')).toBe('editor@example.com')
  })

  it('normalises case and whitespace', () => {
    expect(cleanEmail('  Editor@Example.COM ')).toBe('editor@example.com')
  })

  /**
   * A repaired-but-wrong address is worse than none: it bounces, and bounces
   * are what destroy a sending domain. Anything not plausibly an address is
   * discarded rather than patched into one.
   */
  it('returns null for anything that is not plausibly an address', () => {
    for (const bad of ['editor', 'editor@', '@example.com', 'editor@example', 'not an email', '']) {
      expect(cleanEmail(bad)).toBeNull()
    }
  })

  it('returns null for null', () => {
    expect(cleanEmail(null)).toBeNull()
  })
})

describe('fetchContactPages', () => {
  const html = (body: string): string => `<html><body>${body}</body></html>`

  it('stops once it has enough pages rather than walking every path', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(html('<p>' + 'contact details here. '.repeat(20) + '</p>'), { status: 200 })
    }) as unknown as typeof fetch

    const r = await fetchContactPages('example.com', { fetchImpl, maxPages: 2 })
    expect(r.pages).toHaveLength(2)
    expect(calls).toBe(2)
  })

  it('records a 403 as BLOCKED rather than as "no contact published"', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const r = await fetchContactPages('cloudflared.com', { fetchImpl })
    expect(r.blocked).toBe(true)
    expect(r.pages).toEqual([])
  })

  it('ignores pages too thin to contain anything', async () => {
    const fetchImpl = (async () => new Response(html('<p>404</p>'), { status: 200 })) as unknown as typeof fetch
    const r = await fetchContactPages('example.com', { fetchImpl })
    expect(r.pages).toEqual([])
  })

  it('survives a throwing fetch without failing the whole domain', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    const r = await fetchContactPages('dead.example', { fetchImpl })
    expect(r.pages).toEqual([])
    expect(r.blocked).toBe(false)
  })
})
