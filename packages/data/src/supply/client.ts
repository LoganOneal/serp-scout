import 'server-only'
import { SUPPLY_SCHEMA_VERSION, type SupplyItem, type SupplyManifest } from '@rnr/supply-feed'

/**
 * The consumer half of the supply contract.
 *
 * ==================== A READ MODEL, AND ONLY A READ MODEL ====================
 * There is no method here that writes to the publisher, and there will not be.
 * The site owns supply; this walks it. See docs/plan-supply.md §0.2 and the
 * `SiteStatus` comment in @rnr/core types.ts, which is the same lesson learned
 * once already.
 * ============================================================================
 *
 * ==================== THE FEED IS FREE, AND STILL HAS A BUDGET ==============
 * Unlike DataForSEO this costs no money — it costs the PUBLISHER'S DATABASE. An
 * unbounded walk against a 5,000-item catalogue with a 200-item page size is 26
 * queries; the same walk with a bug that never advances the cursor is infinite.
 * `maxPages` is a loop backstop, and hitting it is reported, never silent.
 * ===========================================================================
 */

export class SupplyFeedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface SupplyClientOptions {
  baseUrl: string
  token: string
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  /** Per-request timeout. A hung feed must not hang the ingest. */
  timeoutMs?: number
  pageSize?: number
  /** Loop backstop. Reported when hit — a truncated walk is a partial sync. */
  maxPages?: number
}

export const DEFAULT_PAGE_SIZE = 500
export const DEFAULT_MAX_PAGES = 200
export const DEFAULT_TIMEOUT_MS = 20_000

export interface WalkResult {
  items: SupplyItem[]
  pagesFetched: number
  /** True when maxPages stopped the walk. The pull is then a SAMPLE, not the set. */
  truncated: boolean
  /** Summed `invalidInPage` — items the publisher's own feed refused to serve. */
  invalidInPages: number
}

export class SupplyClient {
  private readonly base: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly pageSize: number
  private readonly maxPages: number

  constructor(opts: SupplyClientOptions) {
    // A trailing slash turns `${base}/manifest` into `//manifest`, which some
    // hosts serve and some 404. Normalised once, here.
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}/${path}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (e) {
      throw new SupplyFeedError(
        `${url.pathname} did not respond: ${(e as Error)?.message ?? 'network error'}`,
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      /**
       * The publisher's own structured error, surfaced verbatim.
       *
       * @rnr/supply-feed always answers with `{error:{code,message}}`, so a 503
       * says "no token configured on their side" rather than a bare status
       * number that sends the operator to the wrong codebase.
       */
      let detail = ''
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        if (body?.error?.message) detail = ` — ${body.error.code}: ${body.error.message}`
      } catch {
        detail = ''
      }
      throw new SupplyFeedError(`${url.pathname} returned ${res.status}${detail}`, res.status)
    }

    return (await res.json()) as T
  }

  async health(): Promise<{ ok: boolean; schemaVersion: number }> {
    return this.get('health')
  }

  async manifest(): Promise<SupplyManifest> {
    const m = await this.get<SupplyManifest>('manifest')
    /**
     * A newer schema is REFUSED rather than parsed optimistically.
     *
     * Reading version 2 with version 1's assumptions is how a renamed field
     * becomes a silently empty column, and a silently empty column here becomes
     * a locality with no supply — which is a decision, not a display bug.
     */
    if (typeof m.schemaVersion === 'number' && m.schemaVersion > SUPPLY_SCHEMA_VERSION) {
      throw new SupplyFeedError(
        `Feed publishes schema version ${m.schemaVersion}; this consumer understands ` +
          `${SUPPLY_SCHEMA_VERSION}. Refusing to read it with the wrong assumptions — upgrade ` +
          `@rnr/supply-feed here first.`,
      )
    }
    return m
  }

  /**
   * Walk every page.
   *
   * `nextCursor === null` is the ONLY stop signal. An empty `items` array with a
   * live cursor is legal — it is a page whose rows all failed the publisher's own
   * validation — and stopping there would silently drop the rest of the
   * catalogue.
   */
  async walk(opts: { since?: string | null } = {}): Promise<WalkResult> {
    const items: SupplyItem[] = []
    let cursor: string | null = null
    let pages = 0
    let invalidInPages = 0
    const seenCursors = new Set<string>()

    for (;;) {
      const params: Record<string, string> = { limit: String(this.pageSize) }
      if (cursor) params['cursor'] = cursor
      if (opts.since) params['since'] = opts.since

      const page = await this.get<{
        items: SupplyItem[]
        nextCursor: string | null
        invalidInPage?: number
      }>('items', params)

      pages += 1
      items.push(...(page.items ?? []))
      invalidInPages += page.invalidInPage ?? 0

      if (!page.nextCursor) return { items, pagesFetched: pages, truncated: false, invalidInPages }

      /**
       * A cursor that repeats is a publisher bug that would otherwise spin
       * forever against their database. Detected rather than left to maxPages,
       * because the two failures deserve different messages.
       */
      if (seenCursors.has(page.nextCursor)) {
        throw new SupplyFeedError(
          `The feed returned cursor "${page.nextCursor}" twice. It is not advancing — the walk ` +
            `would loop forever. Check the ORDER BY and cursor in your fetchPage.`,
        )
      }
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor

      if (pages >= this.maxPages) {
        return { items, pagesFetched: pages, truncated: true, invalidInPages }
      }
    }
  }
}
