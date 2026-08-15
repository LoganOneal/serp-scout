import { describe, expect, it } from 'vitest'
import { createSupplyFeed, MAX_LIMIT } from './feed.js'
import { safeEqual } from './auth.js'
import type { SupplyFeedConfig, SupplyItem } from './types.js'

const TOKEN = 'sk_supply_test'

const item = (id: string, over: Partial<SupplyItem> = {}): SupplyItem => ({
  id,
  supplierId: `prop_${id}`,
  supplierName: 'A Property',
  title: 'A Room',
  url: `https://hotelhottubs.com/rooms/${id}`,
  updatedAt: '2026-08-14T09:12:00.000Z',
  ...over,
})

function makeFeed(over: Partial<SupplyFeedConfig> = {}) {
  return createSupplyFeed({
    token: TOKEN,
    fetchPage: () => ({ items: [item('a'), item('b')], nextCursor: null }),
    counts: () => ({ totalItems: 2, totalSuppliers: 2 }),
    ...over,
  })
}

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`https://hotelhottubs.com${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
  })

describe('auth — fail closed', () => {
  /**
   * The single most consequential default in this package. An unset token that
   * served openly would publish the whole catalogue, pricing included, and would
   * return 200 the entire time — indistinguishable from working correctly.
   */
  it('503s every endpoint when no token is configured, rather than serving openly', async () => {
    const feed = makeFeed({ token: undefined })
    for (const route of ['/api/supply/health', '/api/supply/manifest', '/api/supply/items']) {
      const r = await feed.handler(new Request(`https://x.com${route}`))
      expect(r.status).toBe(503)
      expect((await r.json()).error.code).toBe('not_configured')
    }
  })

  it('rejects a wrong or missing bearer token', async () => {
    const feed = makeFeed()
    expect((await feed.handler(new Request('https://x.com/api/supply/items'))).status).toBe(401)
    const wrong = new Request('https://x.com/api/supply/items', {
      headers: { authorization: 'Bearer nope' },
    })
    expect((await feed.handler(wrong)).status).toBe(401)
  })

  /** An unauthenticated liveness probe confirms the feed exists to whoever finds it. */
  it('puts health behind auth too', async () => {
    const feed = makeFeed()
    expect((await feed.handler(new Request('https://x.com/api/supply/health'))).status).toBe(401)
    expect((await feed.handler(get('/api/supply/health'))).status).toBe(200)
  })

  it('safeEqual folds length into the accumulator so a prefix cannot pass', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'ab')).toBe(false)
    expect(safeEqual('ab', 'abc')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('read-only', () => {
  it('405s a POST and says why, rather than 404ing like a routing mistake', async () => {
    const feed = makeFeed()
    const r = await feed.handler(
      new Request('https://x.com/api/supply/items', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(r.status).toBe(405)
    expect((await r.json()).error.message).toMatch(/read-only/)
  })
})

describe('routing', () => {
  it('routes by the LAST path segment, so the feed works at any mount point', async () => {
    const feed = makeFeed()
    for (const base of ['/api/supply', '/supply', '/v2/integrations/rnr/supply']) {
      const r = await feed.handler(get(`${base}/manifest`))
      expect(r.status).toBe(200)
      expect((await r.json()).totalItems).toBe(2)
    }
  })

  it('names the three routes when asked for a fourth', async () => {
    const r = await makeFeed().handler(get('/api/supply/listings'))
    expect(r.status).toBe(404)
    expect((await r.json()).error.message).toMatch(/manifest.*items.*health/)
  })
})

describe('manifest', () => {
  it('serves the counts the consumer needs to detect a partial sync', async () => {
    const feed = makeFeed({
      counts: () => ({ totalItems: 5231, totalSuppliers: 418, lastModified: '2026-08-14T09:12:00Z' }),
    })
    const body = await (await feed.handler(get('/api/supply/manifest'))).json()
    expect(body).toMatchObject({
      schemaVersion: 1,
      totalItems: 5231,
      totalSuppliers: 418,
      lastModified: '2026-08-14T09:12:00Z',
      invalidItems: 0,
    })
  })

  /**
   * Invalid items are the publisher's own broken rows. Serving the count is what
   * makes "three listings we will never rank" visible to the only person who can
   * fix them — hiding it leaves a feed that looks complete and is not.
   */
  it('reports items dropped by validation, with examples', async () => {
    const feed = makeFeed({
      fetchPage: () => ({
        items: [item('a'), { ...item('b'), url: 'nope' }, { ...item('c'), title: '' }] as SupplyItem[],
        nextCursor: null,
      }),
    })
    const page = await (await feed.handler(get('/api/supply/items'))).json()
    expect(page.items).toHaveLength(1)
    expect(page.invalidInPage).toBe(2)

    const manifest = await (await feed.handler(get('/api/supply/manifest'))).json()
    expect(manifest.invalidItems).toBe(2)
    expect(manifest.invalidSamples).toEqual([
      { id: 'b', problem: 'url "nope" is not absolute http(s)' },
      { id: 'c', problem: 'missing title' },
    ])
  })
})

describe('items', () => {
  it('passes cursor and since through, and clamps the limit', async () => {
    const seen: unknown[] = []
    const feed = makeFeed({
      fetchPage: (args) => {
        seen.push(args)
        return { items: [], nextCursor: null }
      },
    })
    await feed.handler(get('/api/supply/items?cursor=abc&since=2026-01-01T00:00:00Z&limit=50'))
    await feed.handler(get('/api/supply/items?limit=50000'))
    expect(seen[0]).toEqual({ cursor: 'abc', since: '2026-01-01T00:00:00Z', limit: 50 })
    expect(seen[1]).toEqual({ cursor: null, since: null, limit: MAX_LIMIT })
  })

  /** A caller who asked for 50,000 and got 1,000 must be able to tell. */
  it('announces a clamped limit in a header rather than truncating silently', async () => {
    const r = await makeFeed().handler(get('/api/supply/items?limit=50000'))
    expect(r.headers.get('x-supply-limit-clamped')).toBe(String(MAX_LIMIT))
  })

  it('400s an unparseable since instead of ignoring it and returning everything', async () => {
    const r = await makeFeed().handler(get('/api/supply/items?since=yesterday'))
    expect(r.status).toBe(400)
  })

  /**
   * A page whose rows all failed validation returns zero items and a live
   * cursor. If "no items" meant "done", the walk would stop there and the rest
   * of the catalogue would silently never arrive.
   */
  it('keeps a non-null nextCursor even when every item in the page was invalid', async () => {
    const feed = makeFeed({
      fetchPage: () => ({ items: [{ id: 'x' } as SupplyItem], nextCursor: 'page2' }),
    })
    const body = await (await feed.handler(get('/api/supply/items'))).json()
    expect(body.items).toEqual([])
    expect(body.nextCursor).toBe('page2')
  })
})

describe('caching', () => {
  it('304s an unchanged page so a poll costs the publisher no database read', async () => {
    const feed = makeFeed()
    const first = await feed.handler(get('/api/supply/items'))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()
    const second = await feed.handler(get('/api/supply/items', { 'if-none-match': etag }))
    expect(second.status).toBe(304)
  })

  it('changes the etag when the catalogue changes', async () => {
    let n = 1
    const feed = makeFeed({ fetchPage: () => ({ items: [item(String(n++))], nextCursor: null }) })
    const a = (await feed.handler(get('/api/supply/items'))).headers.get('etag')
    const b = (await feed.handler(get('/api/supply/items'))).headers.get('etag')
    expect(a).not.toBe(b)
  })
})

describe('failures', () => {
  /**
   * "The catalogue is empty" and "the query threw" produce identical downstream
   * behaviour and have completely different causes. The publisher's message
   * survives so the consumer's operator knows which codebase to open.
   */
  it('surfaces a throwing fetchPage as JSON with its message intact', async () => {
    const feed = makeFeed({
      fetchPage: () => {
        throw new Error('relation "room" does not exist')
      },
    })
    const r = await feed.handler(get('/api/supply/items'))
    expect(r.status).toBe(500)
    const body = await r.json()
    expect(body.error.code).toBe('upstream_error')
    expect(body.error.message).toMatch(/relation "room" does not exist/)
  })

  it('rate limits per token and says how long to wait', async () => {
    let t = 0
    const feed = makeFeed({ rateLimitPerMinute: 2, now: () => t })
    expect((await feed.handler(get('/api/supply/health'))).status).toBe(200)
    expect((await feed.handler(get('/api/supply/health'))).status).toBe(200)
    const limited = await feed.handler(get('/api/supply/health'))
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    t = 61_000
    expect((await feed.handler(get('/api/supply/health'))).status).toBe(200)
  })
})
