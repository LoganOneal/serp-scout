/**
 * Reddit placement extraction from DataForSEO organic SERP payloads.
 *
 * ==================== SEPARATE FROM SCORING NORMALISATION ====================
 * `normaliseOrganicResult` (in @rnr/data) keeps organic items only and feeds
 * difficulty / CTR. This module deliberately walks raw DFS `items`, including
 * discussions-and-forums pack entries, and never throws on unknown shapes.
 *
 * Share links (no post id) are skipped. Pack element type names are accepted
 * loosely until a live contract freezes them.
 * ============================================================================
 *
 * Pure. Takes plain objects, returns plain data. No IO.
 */

import { normaliseDomain } from '../scoring/platforms.js'
import { parseRedditPermalink } from './reddit.js'

export type RedditSerpSourceKind = 'organic' | 'discussions_and_forums'

export type RedditPlacementSourceKind = RedditSerpSourceKind | 'both'

export interface RedditSerpHit {
  url: string
  postId: string
  subreddit: string | null
  title: string | null
  sourceKind: RedditSerpSourceKind
  /** rank_group among organic results when source is organic. */
  organicPosition: number | null
  rankAbsolute: number | null
  /** 1-based index inside the discussions pack when source is pack. */
  packPosition: number | null
  domain: string
}

export interface RedditPlacement {
  organicPosition: number | null
  packPosition: number | null
  rankAbsolute: number | null
  sourceKind: RedditPlacementSourceKind | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return null
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function intPos(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1) return Math.trunc(n)
  }
  return null
}

function isRedditDomain(domain: string): boolean {
  return domain === 'reddit.com' || domain.endsWith('.reddit.com') || domain === 'redd.it'
}

function hitFromUrl(
  url: string,
  args: {
    title: string | null
    sourceKind: RedditSerpSourceKind
    organicPosition: number | null
    rankAbsolute: number | null
    packPosition: number | null
    domainHint?: string | null
  },
): RedditSerpHit | null {
  const parsed = parseRedditPermalink(url)
  if (!parsed) return null

  const domainRaw = args.domainHint ?? url
  const domain = normaliseDomain(domainRaw)
  if (domain && !isRedditDomain(domain) && !isRedditDomain(normaliseDomain(url))) {
    // URL parsed as Reddit but domain field was something else — still a Reddit URL.
  }
  const normalised = domain && isRedditDomain(domain) ? domain : 'reddit.com'

  return {
    url,
    postId: parsed.postId,
    subreddit: parsed.subreddit,
    title: args.title,
    sourceKind: args.sourceKind,
    organicPosition: args.organicPosition,
    rankAbsolute: args.rankAbsolute,
    packPosition: args.packPosition,
    domain: normalised,
  }
}

function itemUrl(item: Record<string, unknown>): string | null {
  return str(item['url']) ?? str(item['link']) ?? str(item['xpath'])
}

function itemTitle(item: Record<string, unknown>): string | null {
  return str(item['title']) ?? str(item['name'])
}

function itemDomain(item: Record<string, unknown>): string | null {
  return str(item['domain'])
}

/**
 * ==================== "PERSPECTIVES" IS THE DISCUSSIONS PACK ====================
 * Google renamed the Discussions-and-forums module to Perspectives, and
 * DataForSEO followed with `perspectives` / `perspectives_element`. This parser
 * was written against the old name only, so it went quietly blind.
 *
 * Measured across all 3,530 stored raw SERPs on 2026-08-07:
 *
 *   perspectives             940 modules   2,735 Reddit elements   <- unparsed
 *   discussions_and_forums    92 modules     117 Reddit elements   <- parsed
 *
 * So 96% of the Reddit threads sitting in the discussion surface were counted
 * as zero. "plumber" in New York City reported reddit_hit_count = 0 with a
 * Reddit thread right there in the payload.
 *
 * A caveat worth keeping: the module is not geo-filtered the way organic
 * results are, so a US market SERP can carry r/AusRenovation. These are real
 * page-1 placements and are reported as such -- judging whether a thread is
 * relevant to the market is a scoring question, not a parsing one.
 * ==============================================================================
 */
const DISCUSSION_PACK_TYPES = ['discussions_and_forums', 'perspectives'] as const

function isDiscussionsPack(type: string | null): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return DISCUSSION_PACK_TYPES.some((base) => t === base || t === `${base}_element` || t.includes(base))
}

/** True for the CONTAINER type only, not its leaf elements. */
function isDiscussionsContainer(type: string | null): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return (DISCUSSION_PACK_TYPES as readonly string[]).includes(t)
}

function isDiscussionsElement(type: string | null): boolean {
  if (!type) return false
  const t = type.toLowerCase()
  return (
    t === 'discussions_and_forums_element' ||
    t === 'discussions_element' ||
    t === 'perspectives_element' ||
    (t.includes('discussions') && t.includes('element')) ||
    (t.includes('perspectives') && t.includes('element'))
  )
}

/**
 * Extract every Reddit thread on page 1 from a raw DFS organic result.
 *
 * Never throws: unknown nest shapes are ignored. Share links are skipped.
 * The same post may appear twice when it ranks organically and in the pack —
 * both are returned with distinct `sourceKind` (caller unique-keys on post+kind).
 */
export function extractRedditHitsFromDfsResult(result: {
  items?: Array<Record<string, unknown>> | null
}): RedditSerpHit[] {
  const raw = result.items
  if (!Array.isArray(raw) || raw.length === 0) return []

  const out: RedditSerpHit[] = []
  const seen = new Set<string>()

  const push = (hit: RedditSerpHit | null) => {
    if (!hit) return
    const key = `${hit.postId}\0${hit.sourceKind}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(hit)
  }

  for (const unknownItem of raw) {
    const item = asRecord(unknownItem)
    if (!item) continue
    const type = str(item['type'])

    if (type === 'organic') {
      const url = itemUrl(item)
      if (!url) continue
      const domain = normaliseDomain(itemDomain(item) ?? url)
      if (!isRedditDomain(domain)) continue
      push(
        hitFromUrl(url, {
          title: itemTitle(item),
          sourceKind: 'organic',
          organicPosition: intPos(item['rank_group']),
          rankAbsolute: intPos(item['rank_absolute']),
          packPosition: null,
          domainHint: domain,
        }),
      )
      continue
    }

    if (isDiscussionsContainer(type)) {
      const nested = item['items']
      if (!Array.isArray(nested)) continue
      let packOrdinal = 0
      for (const elUnknown of nested) {
        const el = asRecord(elUnknown)
        if (!el) continue
        const elType = str(el['type'])
        // Accept typed elements or bare objects that merely carry a Reddit URL.
        if (elType && !isDiscussionsElement(elType) && !isDiscussionsPack(elType)) {
          const urlProbe = itemUrl(el)
          if (!urlProbe || !parseRedditPermalink(urlProbe)) continue
        }
        const url = itemUrl(el)
        if (!url) continue
        const parsed = parseRedditPermalink(url)
        if (!parsed) continue
        const domain = normaliseDomain(itemDomain(el) ?? url)
        packOrdinal += 1
        push(
          hitFromUrl(url, {
            title: itemTitle(el),
            sourceKind: 'discussions_and_forums',
            organicPosition: null,
            rankAbsolute: intPos(el['rank_absolute']) ?? intPos(item['rank_absolute']),
            packPosition: packOrdinal,
            domainHint: isRedditDomain(domain) ? domain : 'reddit.com',
          }),
        )
      }
      continue
    }

    // Standalone pack element at top level (some payload shapes).
    if (type && isDiscussionsElement(type)) {
      const url = itemUrl(item)
      if (!url) continue
      const domain = normaliseDomain(itemDomain(item) ?? url)
      if (!parseRedditPermalink(url)) continue
      push(
        hitFromUrl(url, {
          title: itemTitle(item),
          sourceKind: 'discussions_and_forums',
          organicPosition: null,
          rankAbsolute: intPos(item['rank_absolute']),
          packPosition: intPos(item['rank_group']) ?? 1,
          domainHint: isRedditDomain(domain) ? domain : 'reddit.com',
        }),
      )
    }
  }

  return out
}

/**
 * Locate a known Reddit post across organic results and the discussions pack.
 *
 * Shared by discovery promote / monitoring. null sourceKind means not found.
 */
export function findRedditPlacement(
  items: Array<Record<string, unknown>>,
  postId: string,
): RedditPlacement {
  const wanted = postId.toLowerCase().replace(/^t3_/, '')
  if (wanted === '') {
    return { organicPosition: null, packPosition: null, rankAbsolute: null, sourceKind: null }
  }

  let organicPosition: number | null = null
  let packPosition: number | null = null
  let rankAbsolute: number | null = null

  let packOrdinal = 0
  for (const unknownItem of items) {
    const item = asRecord(unknownItem)
    if (!item) continue
    const type = str(item['type'])

    if (type === 'organic') {
      const url = itemUrl(item)
      if (!url) continue
      const parsed = parseRedditPermalink(url)
      if (!parsed || parsed.postId !== wanted) continue
      organicPosition = intPos(item['rank_group'])
      rankAbsolute = intPos(item['rank_absolute']) ?? rankAbsolute
      continue
    }

    if (isDiscussionsContainer(type)) {
      const nested = item['items']
      if (!Array.isArray(nested)) continue
      for (const elUnknown of nested) {
        const el = asRecord(elUnknown)
        if (!el) continue
        const url = itemUrl(el)
        if (!url) continue
        const parsed = parseRedditPermalink(url)
        if (!parsed) continue
        packOrdinal += 1
        if (parsed.postId === wanted) {
          packPosition = packOrdinal
          rankAbsolute = intPos(el['rank_absolute']) ?? intPos(item['rank_absolute']) ?? rankAbsolute
        }
      }
      continue
    }

    if (type && isDiscussionsElement(type)) {
      const url = itemUrl(item)
      if (!url) continue
      const parsed = parseRedditPermalink(url)
      if (!parsed) continue
      packOrdinal += 1
      if (parsed.postId === wanted) {
        packPosition = intPos(item['rank_group']) ?? packOrdinal
        rankAbsolute = intPos(item['rank_absolute']) ?? rankAbsolute
      }
    }
  }

  let sourceKind: RedditPlacementSourceKind | null = null
  if (organicPosition !== null && packPosition !== null) sourceKind = 'both'
  else if (organicPosition !== null) sourceKind = 'organic'
  else if (packPosition !== null) sourceKind = 'discussions_and_forums'

  return { organicPosition, packPosition, rankAbsolute, sourceKind }
}
