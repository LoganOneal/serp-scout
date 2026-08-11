/**
 * SERP layout metrics from raw DataForSEO organic advanced items.
 *
 * Distinguishes:
 *  - Paid *search* ads (text/shopping-ish paid blocks) vs Local Services Ads (LSA)
 *  - Google Business / local pack presence + business slot counts
 *  - Map block presence + rank
 *  - Forums / discussions pack
 *  - First organic rank_absolute (everything sponsored + local above it is already
 *    reflected in that absolute index from DFS)
 *
 * Pure. Never confuses with organic-only scoring normaliser.
 */

export interface SerpLayoutMetrics {
  /** First true organic result rank_absolute (null if none). */
  firstOrganicRankAbsolute: number | null
  /**
   * Paid *search* ads with rank_absolute strictly above first organic.
   * Does **not** include LSA.
   */
  adsAboveOrganicCount: number
  /**
   * Local pack / Maps / finder *containers* strictly above first organic.
   * (Legacy field — prefer localBusinessAboveOrganicCount for slot counts.)
   */
  localProfilesAboveOrganicCount: number
  /** Organic results count (non-paid type=organic). */
  organicCount: number
  /** Paid search ads total (excludes LSA). */
  paidCount: number
  /** Local pack / maps_search / local_finder *containers* on the page. */
  localPackCount: number
  /** Discussions-and-forums pack present. */
  discussionsPackPresent: boolean
  relatedSearches: string[]
  itemTypes: string[]

  // --- Map ---
  /** Any map / maps UI block or local pack that surfaces a map. */
  mapPresent: boolean
  /** rank_absolute of the first map-related block. */
  mapRankAbsolute: number | null

  // --- Local Services Ads (distinct from paid search) ---
  /** LSA blocks / ads on the SERP. */
  lsaCount: number
  /** LSA with rank strictly above first organic. */
  lsaAboveOrganicCount: number
  /** First LSA rank_absolute. */
  lsaRankAbsolute: number | null

  // --- Google Business / local pack slots ---
  /**
   * Count of GBP / maps_search *listings* (nested under local_pack when present).
   * Falls back to container count when DFS omits nested items.
   */
  localBusinessCount: number
  /** Local business slots strictly above first organic. */
  localBusinessAboveOrganicCount: number
  /** rank_absolute of the first local pack / maps container. */
  localPackRankAbsolute: number | null

  // --- Forums ---
  /** Forum / discussion thread elements (nested under discussions pack). */
  forumsCount: number
  /** rank_absolute of the discussions_and_forums container. */
  forumsRankAbsolute: number | null

  /**
   * Sponsored total above organic = paid search ads + LSA above organic.
   * Convenience for “how much paid clutter before organic?”
   */
  sponsoredAboveOrganicCount: number

  /** Top organic domains (rank order), for competitor type (directory vs local). */
  topOrganicDomains: Array<{ domain: string; rankAbsolute: number }>
  /** Top GBP / maps_search listings from local pack (name, rating, reviews). */
  gbpLeaders: Array<{
    title: string
    domain: string | null
    rating: number | null
    reviewsCount: number | null
    rankAbsolute: number | null
  }>
  hasAiOverview: boolean
  hasPeopleAlsoAsk: boolean
}

export type OrganicDomainHit = { domain: string; rankAbsolute: number }
export type GbpLeader = {
  title: string
  domain: string | null
  rating: number | null
  reviewsCount: number | null
  rankAbsolute: number | null
}

function intPos(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1) return Math.trunc(n)
  }
  return null
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function typeOf(item: Record<string, unknown>): string {
  return str(item['type'])?.toLowerCase() ?? ''
}

export function isOrganicItem(item: Record<string, unknown>): boolean {
  const type = typeOf(item)
  if (type !== 'organic') return false
  if (item['is_paid'] === true) return false
  return true
}

/**
 * Paid **search** ads only. Excludes LSA (`local_services*`), local pack, maps.
 */
export function isPaidSearchItem(item: Record<string, unknown>): boolean {
  if (isLsaItem(item)) return false
  if (isLocalProfileContainer(item)) return false
  if (isMapBlock(item)) return false

  const type = typeOf(item)
  if (item['is_paid'] === true && type === 'organic') return true
  if (type === 'organic') return false
  if (type === 'paid' || type === 'paid_ad' || type === 'ads') return true
  if (type.startsWith('paid')) return true
  // Shopping etc. ignored for home-service above-organic clutter.
  return false
}

/** @deprecated Use isPaidSearchItem — same semantics for layout. */
export function isPaidItem(item: Record<string, unknown>): boolean {
  return isPaidSearchItem(item)
}

/** Local Services Ads (Google Guaranteed / LSA) — not classic paid search. */
export function isLsaItem(item: Record<string, unknown>): boolean {
  const type = typeOf(item)
  return (
    type === 'local_services' ||
    type === 'local_services_element' ||
    type.startsWith('local_services') ||
    type === 'google_local_services' ||
    type.includes('local_services')
  )
}

/** Local pack / Maps / Local Finder containers. */
export function isLocalProfileContainer(item: Record<string, unknown>): boolean {
  const type = typeOf(item)
  return type === 'local_pack' || type === 'maps_search' || type === 'local_finder'
}

/** Map chrome / map block (including local_pack which hosts the map UI). */
export function isMapBlock(item: Record<string, unknown>): boolean {
  const type = typeOf(item)
  if (type === 'map' || type === 'maps' || type === 'google_map') return true
  if (type.includes('map') && type !== 'maps_search') return true
  // Local pack is the classic SERP map + 3-pack unit.
  if (type === 'local_pack') return true
  if (type === 'local_finder') return true
  return false
}

/**
 * Google renamed this module to Perspectives and DataForSEO followed suit, so
 * matching only the old name reported `discussionsPackPresent: false` on 940 of
 * the 1,032 SERPs that actually had the module. See discovery.ts for the counts.
 */
function isDiscussionsPack(item: Record<string, unknown>): boolean {
  const type = typeOf(item)
  return (
    type === 'discussions_and_forums' ||
    type === 'perspectives' ||
    type.includes('discussions_and_forums') ||
    type.includes('perspectives')
  )
}

/**
 * Count GBP / local business *listings* on a container or leaf.
 */
export function countLocalBusinessListings(item: Record<string, unknown>): number {
  const type = typeOf(item)
  if (type === 'maps_search' || type === 'local_pack_element' || type === 'maps_search_element') {
    return 1
  }
  if (type === 'local_pack' || type === 'local_finder') {
    const nested = item['items']
    if (Array.isArray(nested) && nested.length > 0) {
      let n = 0
      for (const el of nested) {
        const r = asRecord(el)
        if (!r) continue
        const t = typeOf(r)
        if (
          t === 'maps_search' ||
          t === 'local_pack_element' ||
          t === 'maps_search_element' ||
          t === 'local_pack' ||
          // Some payloads use generic elements with title+domain
          (t.includes('local') && t.includes('element'))
        ) {
          n += 1
        } else if (str(r['title']) || str(r['domain'])) {
          n += 1
        }
      }
      return n > 0 ? n : 1
    }
    // DFS sometimes returns featureless container — still one pack slot.
    return 1
  }
  return 0
}

/** Count forum threads under discussions pack. */
export function countForumElements(item: Record<string, unknown>): number {
  if (!isDiscussionsPack(item)) return 0
  const nested = item['items']
  if (!Array.isArray(nested) || nested.length === 0) return 1
  let n = 0
  for (const el of nested) {
    const r = asRecord(el)
    if (!r) continue
    const t = typeOf(r)
    if (
      t.includes('discussions') ||
      t.includes('forum') ||
      str(r['url']) ||
      str(r['title'])
    ) {
      n += 1
    }
  }
  return n > 0 ? n : 1
}

/** Cap related_searches extracted from SERP (zero marginal cost). */
export const RELATED_SEARCHES_CAP = 8

export function extractRelatedSearches(items: Array<Record<string, unknown>>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const item = asRecord(raw)
    if (!item) continue
    const type = typeOf(item)
    if (type !== 'related_searches' && type !== 'related_searches_element') continue
    const nested = item['items']
    if (Array.isArray(nested)) {
      for (const el of nested) {
        const r = asRecord(el)
        if (!r) continue
        const q = str(r['title']) ?? str(r['query']) ?? str(r['keyword'])
        if (!q) continue
        const key = q.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(q)
        if (out.length >= RELATED_SEARCHES_CAP) return out
      }
    }
    const q = str(item['title']) ?? str(item['query'])
    if (q) {
      const key = q.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(q)
        if (out.length >= RELATED_SEARCHES_CAP) return out
      }
    }
  }
  return out
}

/**
 * Layout metrics: paid search, LSA, map, local business, forums, first organic.
 */
export function extractSerpLayoutMetrics(
  items: Array<Record<string, unknown>> | null | undefined,
): SerpLayoutMetrics {
  const raw = Array.isArray(items) ? items : []
  const itemTypes = [
    ...new Set(
      raw
        .map((i) => str(asRecord(i)?.['type'] ?? '')?.toLowerCase())
        .filter((t): t is string => Boolean(t)),
    ),
  ]

  const ranked: Array<{ item: Record<string, unknown>; abs: number }> = []
  for (const unknown of raw) {
    const item = asRecord(unknown)
    if (!item) continue
    const abs = intPos(item['rank_absolute'])
    if (abs === null) continue
    ranked.push({ item, abs })
  }
  ranked.sort((a, b) => a.abs - b.abs)

  let firstOrganicRankAbsolute: number | null = null
  for (const { item, abs } of ranked) {
    if (isOrganicItem(item)) {
      firstOrganicRankAbsolute = abs
      break
    }
  }

  const paid = ranked.filter(({ item }) => isPaidSearchItem(item))
  const lsa = ranked.filter(({ item }) => isLsaItem(item))
  const localContainers = ranked.filter(({ item }) => isLocalProfileContainer(item))
  const organic = ranked.filter(({ item }) => isOrganicItem(item))
  const mapBlocks = ranked.filter(({ item }) => isMapBlock(item))
  const forumPacks = ranked.filter(({ item }) => isDiscussionsPack(item))

  const discussionsPackPresent = forumPacks.length > 0

  let adsAboveOrganicCount: number
  let localProfilesAboveOrganicCount: number
  let lsaAboveOrganicCount: number
  if (firstOrganicRankAbsolute === null) {
    adsAboveOrganicCount = paid.length
    localProfilesAboveOrganicCount = localContainers.length
    lsaAboveOrganicCount = lsa.length
  } else {
    const firstAbs = firstOrganicRankAbsolute
    adsAboveOrganicCount = paid.filter((p) => p.abs < firstAbs).length
    localProfilesAboveOrganicCount = localContainers.filter((p) => p.abs < firstAbs).length
    lsaAboveOrganicCount = lsa.filter((p) => p.abs < firstAbs).length
  }

  // Business listings (slots) — sum nested where possible.
  let localBusinessCount = 0
  let localBusinessAboveOrganicCount = 0
  for (const { item, abs } of ranked) {
    const slots = countLocalBusinessListings(item)
    if (slots === 0) continue
    localBusinessCount += slots
    if (firstOrganicRankAbsolute === null || abs < firstOrganicRankAbsolute) {
      localBusinessAboveOrganicCount += slots
    }
  }
  // Avoid double-count if both parent local_pack and nested maps_search are ranked.
  // Prefer container-only when both appear with ranks.
  const hasRankedNestedMaps = ranked.some(({ item }) => typeOf(item) === 'maps_search')
  const hasRankedPack = ranked.some(({ item }) => typeOf(item) === 'local_pack')
  if (hasRankedNestedMaps && hasRankedPack) {
    localBusinessCount = 0
    localBusinessAboveOrganicCount = 0
    for (const { item, abs } of ranked) {
      if (typeOf(item) !== 'maps_search' && typeOf(item) !== 'local_pack_element') continue
      const slots = countLocalBusinessListings(item)
      localBusinessCount += slots
      if (firstOrganicRankAbsolute === null || abs < firstOrganicRankAbsolute) {
        localBusinessAboveOrganicCount += slots
      }
    }
    if (localBusinessCount === 0) {
      for (const { item, abs } of ranked) {
        if (typeOf(item) !== 'local_pack') continue
        const slots = countLocalBusinessListings(item)
        localBusinessCount += slots
        if (firstOrganicRankAbsolute === null || abs < firstOrganicRankAbsolute) {
          localBusinessAboveOrganicCount += slots
        }
      }
    }
  }

  let forumsCount = 0
  for (const { item } of forumPacks) {
    forumsCount += countForumElements(item)
  }

  const mapPresent = mapBlocks.length > 0
  const mapRankAbsolute = mapBlocks[0]?.abs ?? null
  const lsaRankAbsolute = lsa[0]?.abs ?? null
  const localPackRankAbsolute = localContainers[0]?.abs ?? null
  const forumsRankAbsolute = forumPacks[0]?.abs ?? null

  return {
    firstOrganicRankAbsolute,
    adsAboveOrganicCount,
    localProfilesAboveOrganicCount,
    organicCount: organic.length,
    paidCount: paid.length,
    localPackCount: localContainers.length,
    discussionsPackPresent,
    relatedSearches: extractRelatedSearches(raw),
    itemTypes,
    mapPresent,
    mapRankAbsolute,
    lsaCount: lsa.length,
    lsaAboveOrganicCount,
    lsaRankAbsolute,
    localBusinessCount,
    localBusinessAboveOrganicCount,
    localPackRankAbsolute,
    forumsCount,
    forumsRankAbsolute,
    sponsoredAboveOrganicCount: adsAboveOrganicCount + lsaAboveOrganicCount,
    topOrganicDomains: extractTopOrganicDomains(ranked, 5),
    gbpLeaders: extractGbpLeaders(raw, 5),
    hasAiOverview: itemTypes.some(
      (t) => t === 'ai_overview' || t.includes('ai_overview') || t === 'chatgpt',
    ),
    hasPeopleAlsoAsk: itemTypes.some(
      (t) => t === 'people_also_ask' || t.includes('people_also_ask'),
    ),
  }
}

/** Top organic domains by rank_absolute (page-1 style, capped). */
export function extractTopOrganicDomains(
  ranked: Array<{ item: Record<string, unknown>; abs: number }>,
  limit = 5,
): OrganicDomainHit[] {
  const out: OrganicDomainHit[] = []
  for (const { item, abs } of ranked) {
    if (!isOrganicItem(item)) continue
    const domain = normaliseDomainLoose(str(item['domain']) ?? str(item['url']))
    if (!domain) continue
    out.push({ domain, rankAbsolute: abs })
    if (out.length >= limit) break
  }
  return out
}

/** GBP / local pack leaders with rating when DFS provides them. */
export function extractGbpLeaders(
  items: Array<Record<string, unknown>>,
  limit = 5,
): GbpLeader[] {
  const out: GbpLeader[] = []
  const push = (item: Record<string, unknown>, abs: number | null) => {
    const title = str(item['title']) ?? str(item['name'])
    if (!title) return
    const ratingRaw = item['rating']
    let rating: number | null = null
    let reviewsCount: number | null = null
    if (typeof ratingRaw === 'number' && Number.isFinite(ratingRaw)) {
      rating = ratingRaw
    } else {
      const r = asRecord(ratingRaw)
      if (r) {
        const v = r['value'] ?? r['rating']
        if (typeof v === 'number' && Number.isFinite(v)) rating = v
        const rc = r['votes_count'] ?? r['votesCount'] ?? r['votes']
        if (typeof rc === 'number' && Number.isFinite(rc)) reviewsCount = Math.trunc(rc)
      }
    }
    const rc2 = item['reviews_count'] ?? item['rating_votes_count']
    if (reviewsCount == null && typeof rc2 === 'number' && Number.isFinite(rc2)) {
      reviewsCount = Math.trunc(rc2)
    }
    out.push({
      title,
      domain: normaliseDomainLoose(str(item['domain']) ?? str(item['url'])),
      rating,
      reviewsCount,
      rankAbsolute: abs,
    })
  }

  for (const unknown of items) {
    const item = asRecord(unknown)
    if (!item) continue
    const type = typeOf(item)
    const abs = intPos(item['rank_absolute'])
    if (type === 'maps_search' || type === 'local_pack_element') {
      push(item, abs)
    } else if (type === 'local_pack' || type === 'local_finder') {
      const nested = item['items']
      if (Array.isArray(nested)) {
        for (const el of nested) {
          const r = asRecord(el)
          if (r) push(r, abs)
          if (out.length >= limit) return out.slice(0, limit)
        }
      }
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

function normaliseDomainLoose(raw: string | null): string | null {
  if (!raw) return null
  let s = raw.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '')
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(0, slash)
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  return s || null
}
