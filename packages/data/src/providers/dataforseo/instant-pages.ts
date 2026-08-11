import { PRICE, type Micros } from '@rnr/core'
import type { DataForSeoClient } from './client.js'
import { ENDPOINTS } from './endpoints.js'

/**
 * Fetch an arbitrary page's HTML through DataForSEO.
 *
 * ==================== WHY NOT JUST fetch() ====================
 * Reddit answers 403 to server IPs. Verified during planning: `www.reddit.com`,
 * `old.reddit.com` and `api.reddit.com` all returned a 190KB "blocked / bot / network
 * security" HTML page, not a rate-limit. And self-service OAuth registration closed in
 * 2026, so there is no token to go get.
 *
 * DataForSEO crawls for a living, so it reaches pages a datacenter IP cannot -- and it is
 * already the vendor whose credentials, pricing and spend ledger this codebase understands.
 * =============================================================
 */

export interface PageFetchResult {
  html: string
  costMicros: Micros
  statusCode: number | null
}

/**
 * One page, live.
 *
 * `enable_javascript` is deliberately OFF: `old.reddit.com` server-renders its comment tree,
 * so rendering would cost 8x ($0.00125 vs $0.00015) for markup we already have.
 */
export async function fetchPageHtml(
  client: DataForSeoClient,
  url: string,
): Promise<PageFetchResult> {
  const body = await client.post<InstantPagesResult>(ENDPOINTS.ON_PAGE_INSTANT_PAGES, [
    {
      url,
      enable_javascript: false,
      store_raw_html: true,
      // Reddit varies markup by user agent; a desktop UA gets the classic tree.
      custom_user_agent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    },
  ])

  /**
   * ==================== THE CLIENT ALREADY UNWRAPPED THIS ====================
   * `client.post` returns `tasks[0].result`, not the envelope. Reaching for
   * `body.tasks[0].result[0].items[0]` therefore matched NOTHING, every time,
   * and `html` fell through to '' -- silently, on an HTTP 200, while the
   * request was still billed. Every Reddit commentability check has been
   * reading an empty page and paying $0.00015 to do it.
   *
   * The envelope shape is still accepted below because it costs one `??` and
   * the failure it guards against is invisible.
   * ==========================================================================
   */
  const results: InstantPagesResultBlock[] = Array.isArray(body)
    ? body
    : (body?.tasks?.[0]?.result ?? [])
  const item = results[0]?.items?.[0]
  const statusCode = typeof item?.status_code === 'number' ? item.status_code : null

  /**
   * The HTML can arrive under either key depending on which sub-product answered, and an
   * empty string is a real possibility even on a 200.
   *
   * Returned as-is rather than thrown on: the caller distinguishes "blocked page" from
   * "comment absent" by INSPECTING the html, and throwing here would collapse those two
   * into one failure -- which is exactly the mistake that would report a deleted comment.
   */
  const html = item?.raw_html ?? item?.html ?? ''

  return { html, costMicros: PRICE.onPageInstantPage, statusCode }
}

interface InstantPagesItem {
  status_code?: number
  raw_html?: string
  html?: string
}

interface InstantPagesResultBlock {
  items?: InstantPagesItem[]
}

/**
 * What `client.post` hands back: the unwrapped `result` array. The optional
 * `tasks` branch is the raw envelope, tolerated defensively.
 */
type InstantPagesResult =
  | InstantPagesResultBlock[]
  | { tasks?: Array<{ result?: InstantPagesResultBlock[] }> }
