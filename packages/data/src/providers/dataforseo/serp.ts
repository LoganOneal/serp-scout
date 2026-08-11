import type { MapPackSnapshot, SerpItem, SerpSnapshot } from '@rnr/core'
import { normaliseDomain } from '@rnr/core'
import type { DataForSeoClient } from './client.js'
import { ENDPOINTS } from './endpoints.js'

/**
 * Normalising DataForSEO SERP payloads into the plain shapes @rnr/core scores.
 *
 * Two things here are easy to get wrong and both shift every score on the page:
 *
 * 1. `items` CONTAINS NON-ORGANIC ENTRIES -- local_pack, people_also_ask,
 *    related_searches, video, top_stories. They must be filtered out, or
 *    directories and answer boxes get counted as competing pages.
 *
 * 2. `rank_absolute` counts every item type; `rank_group` is the rank WITHIN the
 *    organic type. Feeding rank_absolute into the CTR curve shifts the whole
 *    page down -- the true #1 organic result gets weighted as #2 or #3 because a
 *    local pack sat above it -- which systematically understates how strongly
 *    the top of the page is defended.
 */

interface DfsSerpItemRaw {
  type?: string
  rank_group?: number
  rank_absolute?: number
  domain?: string | null
  url?: string | null
  title?: string | null
  description?: string | null
  breadcrumb?: string | null
  /** Nested elements (discussions_and_forums, people_also_ask, …). */
  items?: DfsSerpItemRaw[] | null
}

interface DfsSerpResultRaw {
  keyword?: string
  location_code?: number
  item_types?: string[]
  items_count?: number
  items?: DfsSerpItemRaw[] | null
}

export interface OrganicSerpDetailed {
  snapshot: SerpSnapshot
  /**
   * Full DFS items array (all types). Used by Reddit discovery extraction.
   * NEVER written to serp_snapshots under se_type=organic — that cache is
   * organic-only normalised snapshots for scoring.
   */
  rawItems: Array<Record<string, unknown>>
}

/** Is the URL a bare homepage? Distinguishes a homepage defender from a deep page. */
export function isHomepageUrl(url: string): boolean {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(url)
  if (!m) return false
  const path = m[1]
  return path === undefined || path === '' || path === '/'
}

export function normaliseOrganicResult(result: DfsSerpResultRaw | undefined): SerpItem[] {
  const raw = result?.items ?? []
  const out: SerpItem[] = []
  for (const it of raw) {
    // Filter to organic ONLY. A local_pack entry is not a page we compete with.
    if (it.type !== 'organic') continue
    const url = it.url ?? ''
    const domain = normaliseDomain(it.domain ?? url)
    if (!domain) continue
    // rank_group, NOT rank_absolute -- see the header comment.
    const position = it.rank_group
    if (typeof position !== 'number' || position < 1) continue
    out.push({
      position,
      domain,
      url,
      title: it.title ?? '',
      description: it.description ?? null,
      isHomepage: isHomepageUrl(url),
      breadcrumb: it.breadcrumb ?? null,
    })
  }
  // Deduplicate by position, keeping the first, then sort.
  const byPosition = new Map<number, SerpItem>()
  for (const item of out) if (!byPosition.has(item.position)) byPosition.set(item.position, item)
  return [...byPosition.values()].sort((a, b) => a.position - b.position)
}

export function normaliseMapPackResult(result: DfsSerpResultRaw | undefined): {
  hasLocalPack: boolean
  entryCount: number
  domains: string[]
} {
  const raw = result?.items ?? []
  const entries = raw.filter((i) => i.type === 'maps_search')
  const domains = entries
    .map((i) => normaliseDomain(i.domain ?? ''))
    .filter((d): d is string => Boolean(d))
  return {
    // An EMPTY map pack is a measurement, not a gap: combined with no local
    // business in the top 10 it is what fires the not_a_local_query blocker.
    hasLocalPack: entries.length > 0,
    entryCount: entries.length,
    domains: [...new Set(domains)],
  }
}

// ---------------------------------------------------------------------------

export async function fetchOrganicSerp(
  client: DataForSeoClient,
  args: { keyword: string; locationCode: number; depth?: number },
): Promise<SerpSnapshot> {
  // Byte-stable for scoring: only the normalised organic snapshot leaves here.
  const detailed = await fetchOrganicSerpDetailed(client, args)
  return detailed.snapshot
}

/**
 * Organic SERP plus raw multi-type items for pack-aware discovery.
 *
 * depth defaults to **10** (page 1) for discovery cost/latency; scoring callers
 * keep using fetchOrganicSerp with depth 100 via the shared default when they
 * call this with depth: 100, or continue using fetchOrganicSerp (default 100).
 */
export async function fetchOrganicSerpDetailed(
  client: DataForSeoClient,
  args: {
    keyword: string
    locationCode: number
    depth?: number
    device?: 'desktop' | 'mobile'
    os?: 'windows' | 'android' | 'ios'
  },
): Promise<OrganicSerpDetailed> {
  const depth = args.depth ?? 100
  const device = args.device ?? 'desktop'
  const os = args.os ?? (device === 'mobile' ? 'android' : 'windows')
  const result = await client.post<DfsSerpResultRaw[]>(ENDPOINTS.SERP_ORGANIC_LIVE, [
    {
      keyword: args.keyword,
      location_code: args.locationCode,
      language_code: 'en',
      device,
      os,
      depth,
    },
  ])
  const block = Array.isArray(result) ? result[0] : undefined
  const rawItems = Array.isArray(block?.items)
    ? (block!.items as Array<Record<string, unknown>>)
    : []
  return {
    snapshot: {
      keyword: args.keyword,
      locationCode: args.locationCode,
      items: normaliseOrganicResult(block),
      fetchedAt: new Date().toISOString(),
      source: 'live',
    },
    rawItems,
  }
}

export async function fetchMapPack(
  client: DataForSeoClient,
  args: { keyword: string; locationCode: number },
): Promise<MapPackSnapshot> {
  const result = await client.post<DfsSerpResultRaw[]>(ENDPOINTS.SERP_MAPS_LIVE, [
    {
      keyword: args.keyword,
      location_code: args.locationCode,
      language_code: 'en',
    },
  ])
  const parsed = normaliseMapPackResult(Array.isArray(result) ? result[0] : undefined)
  return {
    keyword: args.keyword,
    locationCode: args.locationCode,
    ...parsed,
    fetchedAt: new Date().toISOString(),
    source: 'live',
  }
}

// ---------------------------------------------------------------------------

interface DfsLocationRaw {
  location_code?: number
  location_name?: string
  location_type?: string
  country_iso_code?: string
}

/**
 * The full location dump. Free, 267,107 rows.
 *
 * NOTE the shape difference: `result` here is a FLAT array of location rows, not
 * the `[{items: [...]}]` wrapper the backlinks endpoints use. Assuming one shape
 * for both yields zero rows with no error.
 */
export async function fetchLocations(client: DataForSeoClient): Promise<
  Array<{
    locationCode: number
    locationName: string
    locationType: string
    countryIsoCode: string
  }>
> {
  const result = await client.get<DfsLocationRaw[]>(ENDPOINTS.LOCATIONS)
  if (!Array.isArray(result)) return []
  const out: Array<{
    locationCode: number
    locationName: string
    locationType: string
    countryIsoCode: string
  }> = []
  for (const r of result) {
    if (typeof r?.location_code !== 'number' || !r.location_name || !r.location_type) continue
    out.push({
      locationCode: r.location_code,
      locationName: r.location_name,
      locationType: r.location_type,
      countryIsoCode: r.country_iso_code ?? '',
    })
  }
  return out
}
