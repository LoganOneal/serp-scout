import 'server-only'
import { PRICE, type Micros } from '@rnr/core'
import type { DataForSeoClient } from '../providers/dataforseo/client.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'

/**
 * Second-pass reader for domains our own probe could not resolve.
 *
 * ==================== WHAT THIS FIXES, AND WHAT IT DOES NOT ====================
 * About 13% of rows land in UNKNOWN, from two different causes:
 *
 *   1. JavaScript-rendered sites. The markup is an empty shell and our probe
 *      runs no JS, so a working business reads as 67 characters.
 *   2. Bot-blocked sites. A datacenter IP gets 403 or a challenge page.
 *
 * A local headless browser fixes only (1) -- it would still fetch from the same
 * IP. DataForSEO renders AND crawls from its own network, so one call addresses
 * both. Measured on the known-hard set:
 *
 *   1sthvacrepairhoustontx.com   67 chars -> 1,213 words     FIXED
 *   greaterhoustonhvac.com       403      -> 1,684 words     FIXED
 *   chron.com                    thin     -> title "Client Challenge"
 *   macfelderplumbing.com        parked   -> 54 words        confirmed parked
 *   tesla.com, twdaz.com         403      -> still 403       NOT FIXABLE
 *
 * Roughly a third of the hard cases stay unreadable, and this says so rather
 * than inventing a verdict for them.
 *
 * NOTE: instant_pages returns no raw HTML at all -- verified. It does return
 * `meta.content.plain_text_word_count` and `meta.title`, which is precisely the
 * signal needed, so the missing markup does not matter here.
 * ==============================================================================
 */

/** Measured by balance delta 2026-08-07: $0.0306 for 6 rendered pages. */
export const RENDER_COST_MICROS: Micros = PRICE.onPageBrowserRender

/** A rendered page with this many words is a real site. */
const LIVE_WORD_FLOOR = 150

/** Below this, the page is a placeholder even after rendering. */
const PARKED_WORD_CEILING = 60

/**
 * Titles that mean we were challenged rather than served. chron.com renders to
 * "Client Challenge"; Cloudflare uses "Just a moment" and "Attention Required".
 */
const CHALLENGE_TITLE = /challenge|just a moment|attention required|access denied|are you a robot|verify/i

export type RenderVerdict = 'live' | 'parked' | 'blocked' | 'unresolved'

export interface RenderResult {
  domain: string
  statusCode: number | null
  wordCount: number | null
  title: string | null
  verdict: RenderVerdict
  detail: string
  costMicros: Micros
}

interface InstantPageItem {
  status_code?: number
  meta?: {
    title?: string | null
    content?: { plain_text_word_count?: number | null; plain_text_size?: number | null } | null
  } | null
}

/** Render one domain and decide what it actually is. One billable request. */
export async function renderAndClassify(
  client: DataForSeoClient,
  domain: string,
): Promise<RenderResult> {
  const base = { domain, costMicros: RENDER_COST_MICROS }
  try {
    const body = await client.post<Array<{ items?: InstantPageItem[] }>>(
      ENDPOINTS.ON_PAGE_INSTANT_PAGES,
      [{ url: `https://${domain}/`, enable_javascript: true, enable_browser_rendering: true }],
    )
    const item = body?.[0]?.items?.[0]
    const statusCode = typeof item?.status_code === 'number' ? item.status_code : null
    const wordCount = item?.meta?.content?.plain_text_word_count ?? null
    const title = (item?.meta?.title ?? null) || null

    if (statusCode != null && (statusCode === 403 || statusCode === 401 || statusCode >= 500)) {
      return {
        ...base,
        statusCode,
        wordCount,
        title,
        verdict: 'blocked',
        detail: `Renderer also received HTTP ${statusCode} — the site refuses automated access`,
      }
    }

    if (title && CHALLENGE_TITLE.test(title)) {
      return {
        ...base,
        statusCode,
        wordCount,
        title,
        verdict: 'blocked',
        detail: `Bot challenge served ("${title}") — still not the real page`,
      }
    }

    if (wordCount == null) {
      return {
        ...base,
        statusCode,
        wordCount,
        title,
        verdict: 'unresolved',
        detail: 'Renderer returned no content measurement',
      }
    }

    if (wordCount >= LIVE_WORD_FLOOR) {
      return {
        ...base,
        statusCode,
        wordCount,
        title,
        verdict: 'live',
        detail: `${wordCount} words after rendering${title ? ` — "${title}"` : ''}`,
      }
    }

    if (wordCount <= PARKED_WORD_CEILING) {
      return {
        ...base,
        statusCode,
        wordCount,
        title,
        verdict: 'parked',
        detail: `Only ${wordCount} words after rendering — a placeholder, not a site`,
      }
    }

    // Between the floor and the ceiling is genuinely ambiguous; say so.
    return {
      ...base,
      statusCode,
      wordCount,
      title,
      verdict: 'unresolved',
      detail: `${wordCount} words — too thin to call live, too much to call parked`,
    }
  } catch (err) {
    return {
      ...base,
      statusCode: null,
      wordCount: null,
      title: null,
      verdict: 'unresolved',
      // The request was still billed, so the cost stands even on failure.
      detail: `Render failed: ${(err as Error).message.slice(0, 80)}`,
    }
  }
}

export interface RenderPassResult {
  results: RenderResult[]
  costMicros: Micros
  resolved: number
}

/**
 * Render a batch of unresolved domains, cheapest-risk first.
 *
 * Capped, because this is the one stage in the whole triage that bills per
 * domain without a cheap pre-filter to hide behind.
 */
export async function renderUnresolved(
  domains: string[],
  opts: { maxRenders?: number; concurrency?: number } = {},
): Promise<RenderPassResult> {
  const targets = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(Boolean)
  const cap = opts.maxRenders ?? 100
  const slice = targets.slice(0, cap)
  if (slice.length === 0) return { results: [], costMicros: 0n, resolved: 0 }

  const client = createDfsClientFromEnv()
  if (!client) throw new Error('DataForSEO credentials are not configured.')

  const results: RenderResult[] = []
  let costMicros: Micros = 0n
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const domain = slice[cursor++]
      if (!domain) return
      const r = await renderAndClassify(client, domain)
      results.push(r)
      costMicros += r.costMicros
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, slice.length) }, worker))

  return {
    results,
    costMicros,
    resolved: results.filter((r) => r.verdict === 'live' || r.verdict === 'parked').length,
  }
}
