import { describe, expect, it } from 'vitest'
import { SupplyClient, SupplyFeedError } from './client.js'
import type { SupplyItem } from '@rnr/supply-feed'

const item = (id: string): SupplyItem => ({
  id,
  supplierId: `p_${id}`,
  supplierName: 'A Property',
  title: 'A Room',
  url: `https://x.com/${id}`,
  updatedAt: '2026-08-14T00:00:00.000Z',
})

/** A fake feed: `pages` is keyed by the cursor that requests it. */
function fakeFeed(
  pages: Record<string, { items: SupplyItem[]; nextCursor: string | null; invalidInPage?: number }>,
  manifest: Record<string, unknown> = { schemaVersion: 1, totalItems: 0, totalSuppliers: 0, invalidItems: 0 },
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    const u = new URL(url)
    if (u.pathname.endsWith('/manifest')) return Response.json(manifest)
    if (u.pathname.endsWith('/health')) return Response.json({ ok: true, schemaVersion: 1 })
    const page = pages[u.searchParams.get('cursor') ?? '']
    if (!page) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no page' } }), { status: 404 })
    return Response.json(page)
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

const client = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new SupplyClient({ baseUrl: 'https://x.com/api/supply/', token: 't', fetchImpl, ...over })

describe('walk', () => {
  it('follows cursors to the end and concatenates every page', async () => {
    const { fetchImpl, urls } = fakeFeed({
      '': { items: [item('a')], nextCursor: 'c1' },
      c1: { items: [item('b')], nextCursor: 'c2' },
      c2: { items: [item('c')], nextCursor: null },
    })
    const r = await client(fetchImpl).walk()
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(r.pagesFetched).toBe(3)
    expect(r.truncated).toBe(false)
    // Trailing slash on the base URL must not produce `//items`.
    expect(urls.every((u) => !u.includes('//items'))).toBe(true)
  })

  /**
   * A page whose rows all failed the publisher's validation returns zero items
   * and a live cursor. Treating "no items" as "done" would silently drop the
   * rest of the catalogue.
   */
  it('keeps walking through an empty page with a live cursor', async () => {
    const { fetchImpl } = fakeFeed({
      '': { items: [], nextCursor: 'c1', invalidInPage: 3 },
      c1: { items: [item('b')], nextCursor: null },
    })
    const r = await client(fetchImpl).walk()
    expect(r.items.map((i) => i.id)).toEqual(['b'])
    expect(r.invalidInPages).toBe(3)
  })

  /**
   * A cursor that does not advance would spin forever against the publisher's
   * database. Detected explicitly rather than left to the page backstop, because
   * "your cursor is broken" and "your catalogue is huge" need different fixes.
   */
  it('detects a non-advancing cursor and names the fix', async () => {
    const { fetchImpl } = fakeFeed({
      '': { items: [item('a')], nextCursor: 'stuck' },
      stuck: { items: [item('a')], nextCursor: 'stuck' },
    })
    await expect(client(fetchImpl).walk()).rejects.toThrow(/not advancing/)
  })

  it('reports truncation at the page backstop rather than pretending it finished', async () => {
    const pages: Record<string, { items: SupplyItem[]; nextCursor: string | null }> = {}
    for (let i = 0; i < 10; i += 1) {
      pages[i === 0 ? '' : `c${i}`] = { items: [item(String(i))], nextCursor: `c${i + 1}` }
    }
    const { fetchImpl } = fakeFeed(pages)
    const r = await client(fetchImpl, { maxPages: 3 }).walk()
    expect(r.truncated).toBe(true)
    expect(r.pagesFetched).toBe(3)
  })

  it('passes `since` through on every page', async () => {
    const { fetchImpl, urls } = fakeFeed({
      '': { items: [item('a')], nextCursor: 'c1' },
      c1: { items: [], nextCursor: null },
    })
    await client(fetchImpl).walk({ since: '2026-01-01T00:00:00Z' })
    const itemUrls = urls.filter((u) => u.includes('/items'))
    expect(itemUrls).toHaveLength(2)
    expect(itemUrls.every((u) => u.includes('since=2026-01-01'))).toBe(true)
  })
})

describe('manifest', () => {
  /**
   * Reading version 2 with version 1's assumptions turns a renamed field into a
   * silently empty column — and an empty column here becomes a locality with no
   * supply, which is a decision rather than a display bug.
   */
  it('refuses a schema version newer than this consumer understands', async () => {
    const { fetchImpl } = fakeFeed({}, { schemaVersion: 99, totalItems: 1, totalSuppliers: 1 })
    await expect(client(fetchImpl).manifest()).rejects.toThrow(/schema version 99/)
  })

  it('accepts the current version', async () => {
    const { fetchImpl } = fakeFeed({}, { schemaVersion: 1, totalItems: 5231, totalSuppliers: 418 })
    expect((await client(fetchImpl).manifest()).totalItems).toBe(5231)
  })
})

describe('errors', () => {
  /**
   * The publisher's structured error, kept verbatim. A bare "503" would send the
   * operator to this codebase when the fix — a token that is not configured — is
   * in theirs.
   */
  it('surfaces the feed’s own error code and message', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'not_configured', message: 'No SUPPLY_FEED_TOKEN' } }),
        { status: 503 },
      )) as unknown as typeof fetch
    const err = await client(fetchImpl)
      .manifest()
      .catch((e: SupplyFeedError) => e)
    expect((err as SupplyFeedError).status).toBe(503)
    expect((err as Error).message).toMatch(/not_configured: No SUPPLY_FEED_TOKEN/)
  })

  it('reports a network failure as a feed error rather than an unhandled throw', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    await expect(client(fetchImpl).health()).rejects.toThrow(/did not respond.*ENOTFOUND/)
  })

  it('survives an HTML error page instead of failing to parse it', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch
    await expect(client(fetchImpl).manifest()).rejects.toThrow(/returned 502/)
  })
})
