import type { SupplyFeed } from './feed.js'

/**
 * Framework adapters, deliberately thin.
 *
 * The core is a `Request -> Response` function, so the "Next.js adapter" is an
 * object with GET and HEAD pointing at it. If an adapter here ever grows logic,
 * that logic is in the wrong place — it belongs in feed.ts where every framework
 * gets it.
 */

export interface RouteHandlers {
  GET: (req: Request) => Promise<Response>
  HEAD: (req: Request) => Promise<Response>
  POST: (req: Request) => Promise<Response>
}

/**
 * Next.js App Router.
 *
 *   // app/api/supply/[endpoint]/route.ts
 *   export const { GET, HEAD, POST } = toRouteHandlers(feed)
 *
 * POST is exported so a mistaken write gets the feed's own 405 — with its
 * explanation of why there is no write path — rather than Next's bare
 * "405 Method Not Allowed", which reads like a routing mistake.
 */
export function toRouteHandlers(feed: SupplyFeed): RouteHandlers {
  return { GET: feed.handler, HEAD: feed.handler, POST: feed.handler }
}

/** The subset of an Express request this adapter reads. */
export interface ExpressLikeRequest {
  method: string
  originalUrl?: string
  url: string
  headers: Record<string, string | string[] | undefined>
  protocol?: string
  get?: (name: string) => string | undefined
}

/** The subset of an Express response this adapter writes. */
export interface ExpressLikeResponse {
  status: (code: number) => ExpressLikeResponse
  setHeader: (name: string, value: string) => void
  send: (body?: string) => void
  end: () => void
}

/**
 * Express / Connect.
 *
 *   app.use('/api/supply', toExpressHandler(feed))
 *
 * The absolute URL is reconstructed because `Request` requires one and Express
 * gives a path. The host comes from the Host header; when it is absent the
 * placeholder is used, and nothing downstream reads it — routing is by the last
 * path segment, and auth is by header.
 */
export function toExpressHandler(
  feed: SupplyFeed,
): (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<void> {
  return async (req, res) => {
    const hostHeader = req.get?.('host') ?? req.headers['host']
    const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) || 'supply-feed.invalid'
    const proto = req.protocol ?? 'https'
    const path = req.originalUrl ?? req.url

    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }

    const response = await feed.handler(
      new Request(`${proto}://${host}${path}`, { method: req.method, headers }),
    )

    res.status(response.status)
    response.headers.forEach((value, key) => res.setHeader(key, value))
    if (response.status === 304 || req.method === 'HEAD') return void res.end()
    res.send(await response.text())
  }
}
