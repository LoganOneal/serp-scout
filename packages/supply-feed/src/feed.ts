import { authenticate, RateLimiter } from './auth.js'
import { partitionItems } from './validate.js'
import {
  SUPPLY_SCHEMA_VERSION,
  type FetchPageResult,
  type SupplyErrorBody,
  type SupplyFeedConfig,
  type SupplyItem,
  type SupplyManifest,
} from './types.js'

/**
 * The feed: three endpoints, and only three.
 *
 * ==================== WHY A Request -> Response FUNCTION ====================
 * Not an Express middleware, not a Next.js route module. Web-standard
 * `Request`/`Response` is the one calling convention that Next.js App Router,
 * Remix, Hono, Deno, Bun, Cloudflare Workers and Vercel Edge all speak natively
 * — and the one Express can be adapted to in a dozen lines (see ./adapters).
 *
 * A framework-shaped core would have made this package care which framework
 * hotelhottubs.com is built with, which is precisely the coupling that would
 * make it useless for the next site.
 * ===========================================================================
 *
 * ==================== WHY CURSORS, NOT OFFSETS ====================
 * `?offset=200` is stable only if nothing is written between pages. A catalogue
 * being edited while we walk it shifts rows across the offset boundary: some are
 * returned twice, some are never returned at all, and NOTHING ANNOUNCES EITHER.
 * A cursor over (updated_at, id) survives concurrent writes because it names a
 * position in the data rather than a count of rows already seen.
 * =================================================================
 */

export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120

export interface SupplyFeed {
  /** Mount this at any path. Routing is by the LAST segment. */
  handler: (req: Request) => Promise<Response>
  /** Direct access, already validated. For tests and for non-HTTP callers. */
  manifest: () => Promise<SupplyManifest>
  items: (args: { cursor?: string | null; limit?: number; since?: string | null }) => Promise<{
    items: SupplyItem[]
    nextCursor: string | null
    invalidInPage: number
  }>
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  })

/**
 * A structured error body, always — never an HTML error page.
 *
 * An HTML 500 parsed as JSON two systems away produces "Unexpected token '<'",
 * which says nothing about what went wrong and sends the reader to the wrong
 * codebase to find out.
 */
const fail = (
  status: number,
  code: SupplyErrorBody['error']['code'],
  message: string,
  headers: Record<string, string> = {},
): Response => json({ error: { code, message } } satisfies SupplyErrorBody, { status, headers })

/**
 * FNV-1a over the response body. A CACHE VALIDATOR, not a security primitive.
 *
 * ETags exist here so an unchanged page costs the publisher a 304 instead of a
 * database read. Nothing trusts this value for integrity, which is why a
 * non-cryptographic hash with no imports is the right trade.
 */
function weakEtag(body: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `W/"${body.length.toString(36)}-${h.toString(36)}"`
}

function clampLimit(raw: string | null, fallback: number, max: number): { limit: number; clamped: boolean } {
  if (raw === null) return { limit: fallback, clamped: false }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return { limit: fallback, clamped: true }
  if (n > max) return { limit: max, clamped: true }
  return { limit: Math.floor(n), clamped: false }
}

export function createSupplyFeed(config: SupplyFeedConfig): SupplyFeed {
  const now = config.now ?? (() => Date.now())
  const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT
  const maxLimit = config.maxLimit ?? MAX_LIMIT
  const limiter = new RateLimiter(config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, now)

  /** Collected per page and surfaced in the manifest, so drops are never silent. */
  const invalidSeen = new Map<string, string>()

  async function readPage(args: {
    cursor?: string | null
    limit?: number
    since?: string | null
  }): Promise<{ items: SupplyItem[]; nextCursor: string | null; invalidInPage: number }> {
    const raw: FetchPageResult = await config.fetchPage({
      cursor: args.cursor ?? null,
      limit: Math.min(Math.max(1, Math.floor(args.limit ?? defaultLimit)), maxLimit),
      since: args.since ?? null,
    })
    const { valid, invalid } = partitionItems(raw.items ?? [])
    for (const bad of invalid) invalidSeen.set(bad.id, bad.problem)
    return { items: valid, nextCursor: raw.nextCursor ?? null, invalidInPage: invalid.length }
  }

  async function readManifest(): Promise<SupplyManifest> {
    const counts = await config.counts()
    const manifest: SupplyManifest = {
      schemaVersion: SUPPLY_SCHEMA_VERSION,
      totalItems: counts.totalItems,
      totalSuppliers: counts.totalSuppliers,
      invalidItems: invalidSeen.size,
      invalidSamples: [...invalidSeen.entries()].slice(0, 10).map(([id, problem]) => ({ id, problem })),
    }
    if (counts.lastModified) manifest.lastModified = counts.lastModified
    if (counts.meta) manifest.meta = counts.meta
    return manifest
  }

  async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      /**
       * There is no write path and there never will be — the publisher owns
       * supply, and a second writable copy of a catalogue is two catalogues.
       * 405 rather than 404 so a misdirected POST says WHY.
       */
      return fail(405, 'bad_request', 'This feed is read-only. Only GET is supported.', {
        allow: 'GET, HEAD',
      })
    }

    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)
    const route = segments[segments.length - 1] ?? ''

    const auth = authenticate(config.token, req.headers)
    if (!auth.ok) {
      if (auth.reason === 'not_configured') {
        return fail(
          503,
          'not_configured',
          'No SUPPLY_FEED_TOKEN is configured on this feed, so it refuses to serve. ' +
            'An unset secret fails toward publishing nothing, never toward publishing openly.',
        )
      }
      /**
       * `health` is behind auth too, on purpose. An unauthenticated liveness
       * endpoint confirms the feed exists to anyone who finds the path, which is
       * the first thing you would want to know before guessing at the others.
       */
      return fail(401, 'unauthorized', 'Missing or invalid bearer token.', {
        'www-authenticate': 'Bearer',
      })
    }

    const wait = limiter.check(auth.token)
    if (wait !== null) {
      return fail(429, 'rate_limited', `Rate limit exceeded. Retry in ${wait}s.`, {
        'retry-after': String(wait),
      })
    }

    try {
      if (route === 'health') {
        return json({ ok: true, schemaVersion: SUPPLY_SCHEMA_VERSION })
      }

      if (route === 'manifest') {
        const body = JSON.stringify(await readManifest())
        return respondCacheable(req, body, 'no-cache')
      }

      if (route === 'items') {
        const { limit, clamped } = clampLimit(url.searchParams.get('limit'), defaultLimit, maxLimit)
        const since = url.searchParams.get('since')
        if (since !== null && Number.isNaN(Date.parse(since))) {
          return fail(400, 'bad_request', `since="${since}" is not a parseable ISO 8601 timestamp.`)
        }
        const page = await readPage({ cursor: url.searchParams.get('cursor'), limit, since })
        const body = JSON.stringify({
          items: page.items,
          nextCursor: page.nextCursor,
          invalidInPage: page.invalidInPage,
        })
        const headers: Record<string, string> = {}
        // Silent truncation reads as "you asked for everything and got it".
        if (clamped) headers['x-supply-limit-clamped'] = String(limit)
        return respondCacheable(req, body, 'private, max-age=60', headers)
      }

      return fail(
        404,
        'not_found',
        `Unknown route "${route}". This feed serves /manifest, /items and /health.`,
      )
    } catch (e) {
      /**
       * The publisher's own error, surfaced as JSON with its message intact.
       *
       * Swallowing it into a generic "internal error" would leave the consumer
       * to guess whether the catalogue is empty or the query threw — and those
       * two produce identical downstream behaviour with completely different
       * causes.
       */
      return fail(500, 'upstream_error', (e as Error)?.message ?? 'fetchPage threw')
    }
  }

  function respondCacheable(
    req: Request,
    body: string,
    cacheControl: string,
    extra: Record<string, string> = {},
  ): Response {
    const etag = weakEtag(body)
    const headers = { etag, 'cache-control': cacheControl, ...extra }
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }
    const withType = { ...headers, 'content-type': 'application/json; charset=utf-8' }
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: withType })
    return new Response(body, { status: 200, headers: withType })
  }

  return {
    handler,
    manifest: readManifest,
    items: readPage,
  }
}
