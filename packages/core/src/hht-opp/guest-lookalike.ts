/**
 * Lookalike expansion for guest-post discovery (plan section 3.2).
 *
 * Seeds are the PURSUE sites in the Guest Post Master Tracker. Three signals
 * turn a seed into candidate domains:
 *   - organic_competitor: Semrush domain_organic_organic rows for the seed
 *   - author_bio:         links in guest-author bio boxes on the seed's posts
 *   - blogroll:           outbound links on the seed's resources / favourite
 *                         blogs / collaboration pages and blogroll widgets
 *
 * Everything here is pure. Fetching, Semrush and the database live in
 * packages/data/src/hht-opp/guest-lookalike.ts.
 *
 * Candidates reach the guest-post-pitches skill through the same rows the
 * SERP frontier writes: one hht_opp_guest_keywords row per (signal, seed) with
 * source_type = bucket = 'lookalike', and one hht_opp_guest_serp_results row
 * per candidate. `pnpm hht:opp export-leads` then treats them like SERP hits,
 * so the lead CSV's bucket column reads `lookalike` and source_query names the
 * seed and signal.
 */

import { registrableDomain } from '../domains/normalize.js'
import { serpHitJunkReason } from './serp-leads.js'
import { HHT_SITE_DOMAIN } from './types.js'

export const LOOKALIKE_SIGNALS = ['organic_competitor', 'author_bio', 'blogroll'] as const
export type LookalikeSignal = (typeof LOOKALIKE_SIGNALS)[number]

export const LOOKALIKE_BUCKET = 'lookalike'
export const LOOKALIKE_SOURCE_TYPE = 'lookalike'
/** Status for lookalike keyword rows. Never NEW, so the SERP frontier never tries to fetch them. */
export const LOOKALIKE_KEYWORD_STATUS = 'LOOKALIKE'

export const LOOKALIKE_DEFAULTS = {
  /** Rows requested per seed from domain_organic_organic. */
  competitorRows: 15,
  /** Competitors above this much estimated organic traffic are brands, not small blogs. */
  maxCompetitorTraffic: 250_000,
  minCommonKeywords: 5,
  /** Pages fetched per seed (homepage + pitch page + listing/bio/blogroll pages), robots.txt excluded. */
  maxPagesPerSeed: 8,
  maxGuestPages: 4,
  maxBlogrollPages: 2,
  /** Outbound links kept per blogroll page. Larger lists are link farms. */
  maxLinksPerBlogrollPage: 80,
  /** Minimum gap between two requests to the same host. */
  hostSpacingMs: 1_500,
} as const

/** SERP baseline the pilot is compared against: pitchable per new domain. */
export const SERP_BASELINE_PITCHABLE_RATE = 0.036

// ---------------------------------------------------------------------------
// Tracker seeds
// ---------------------------------------------------------------------------

export interface TrackerSeedSet {
  /** PURSUE domains, in tracker order, deduped. */
  seeds: string[]
  /** Every registrable domain anywhere in the tracker (any verdict). */
  tracked: Set<string>
}

/** Turn tracker rows (header-keyed) into PURSUE seeds and the set of every tracked domain. */
export function trackerSeeds(rows: ReadonlyArray<Record<string, unknown>>): TrackerSeedSet {
  const seeds: string[] = []
  const seen = new Set<string>()
  const tracked = new Set<string>()
  for (const row of rows) {
    const root = registrableDomain(String(row['site'] ?? row['domain'] ?? '').trim())?.domain
    if (!root) continue
    tracked.add(root)
    const verdict = String(row['verdict'] ?? '').trim().toUpperCase()
    if (verdict !== 'PURSUE' || seen.has(root)) continue
    seen.add(root)
    seeds.push(root)
  }
  return { seeds, tracked }
}

// ---------------------------------------------------------------------------
// Keyword rows (the bridge into the export-leads flow)
// ---------------------------------------------------------------------------

export function lookalikeKeyword(signal: LookalikeSignal, seed: string): string {
  return `lookalike ${signal} ${seed}`
}

/** Stored in normalized_keyword (unique). Kept verbatim so two seeds can never collide. */
export function lookalikeKeywordKey(signal: LookalikeSignal, seed: string): string {
  return `lookalike:${signal}:${seed}`
}

export function parseLookalikeKeyword(keyword: string): { signal: LookalikeSignal; seed: string } | null {
  const match = /^lookalike[ :]([a-z_]+)[ :](\S+)$/.exec(keyword.trim())
  if (!match) return null
  const signal = match[1] as LookalikeSignal
  if (!LOOKALIKE_SIGNALS.includes(signal)) return null
  return { signal, seed: match[2]! }
}

// ---------------------------------------------------------------------------
// Signal 1: organic competitors
// ---------------------------------------------------------------------------

export interface OrganicCompetitorRow {
  domain: string
  relevance: number | null
  commonKeywords: number | null
  organicKeywords: number | null
  organicTraffic: number | null
}

const num = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function pick(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in record) return record[name]
  }
  return undefined
}

function toCompetitor(record: Record<string, unknown>): OrganicCompetitorRow | null {
  const domain = String(pick(record, 'domain', 'Domain', 'dn', 'Dn') ?? '').trim().toLowerCase()
  if (!domain) return null
  return {
    domain,
    relevance: num(pick(record, 'competition_level', 'competitor relevance', 'Competitor Relevance', 'cr', 'Cr')),
    commonKeywords: num(pick(record, 'common_keywords', 'common keywords', 'Common Keywords', 'np', 'Np')),
    organicKeywords: num(pick(record, 'organic_keywords', 'organic keywords', 'Organic Keywords', 'or', 'Or')),
    organicTraffic: num(pick(record, 'organic_traffic', 'organic traffic', 'Organic Traffic', 'ot', 'Ot')),
  }
}

/** Parse a domain_organic_organic payload: an array of records or the raw `;`-separated export. */
export function parseOrganicCompetitors(data: unknown): OrganicCompetitorRow[] {
  if (Array.isArray(data)) {
    return data.flatMap((row) => {
      const parsed = row && typeof row === 'object' ? toCompetitor(row as Record<string, unknown>) : null
      return parsed ? [parsed] : []
    })
  }
  if (typeof data !== 'string' || !data.trim()) return []
  const lines = data.trim().split(/\r?\n/).filter(Boolean)
  const first = lines[0] ?? ''
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ','
  const header = first.split(delimiter).map((cell) => cell.trim().toLowerCase())
  const out: OrganicCompetitorRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter)
    const record: Record<string, unknown> = {}
    header.forEach((name, index) => {
      record[name] = cells[index]?.trim() ?? ''
    })
    const parsed = toCompetitor(record)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Drop brands (too much traffic) and weak overlaps; keep Semrush's relevance order. */
export function selectOrganicCompetitors(
  rows: readonly OrganicCompetitorRow[],
  options: { maxTraffic?: number; minCommonKeywords?: number } = {},
): Array<OrganicCompetitorRow & { rank: number; dropped?: string }> {
  const maxTraffic = options.maxTraffic ?? LOOKALIKE_DEFAULTS.maxCompetitorTraffic
  const minCommon = options.minCommonKeywords ?? LOOKALIKE_DEFAULTS.minCommonKeywords
  return rows.map((row, index) => {
    const rank = index + 1
    if (row.organicTraffic != null && row.organicTraffic > maxTraffic) {
      return { ...row, rank, dropped: `organic traffic ${row.organicTraffic} > ${maxTraffic}` }
    }
    if (row.commonKeywords != null && row.commonKeywords < minCommon) {
      return { ...row, rank, dropped: `only ${row.commonKeywords} common keywords` }
    }
    return { ...row, rank }
  })
}

// ---------------------------------------------------------------------------
// Signals 2 and 3: link classification on seed pages
// ---------------------------------------------------------------------------

const AUTHOR_ARCHIVE = /\/(?:author|authors|writer|writers|contributor|contributors)\/([a-z0-9][a-z0-9-]{1,60})\/?$/i
const OWNER_SLUG = /^(?:admin|administrator|editor|editors|staff|team|webmaster|guest|guest-author|guest-post|guests)$/i
const GUEST_LISTING = /\/(?:category|tag|topics?)\/[^/]*(?:guest|contributor|contributed)[^/]*\/?$/i
const GUEST_ANCHOR = /\bguest (?:post|author|blogger|writer|contributor)s?\b|\bcontributors?\b|\bour writers\b/i

/** An author archive (not the house account). Archive pages usually carry the author's bio. */
export function isAuthorArchiveUrl(url: string): boolean {
  const path = pathOf(url)
  const match = AUTHOR_ARCHIVE.exec(path)
  return !!match && !OWNER_SLUG.test(match[1] ?? '')
}

/** Category/tag pages and anchors that list guest posts. */
export function isGuestListingLink(url: string, anchor: string): boolean {
  return GUEST_LISTING.test(pathOf(url)) || GUEST_ANCHOR.test(anchor)
}

const BLOGROLL_PATH =
  /\/(?:[^/]*-)?(?:blogroll|favou?rite-(?:travel-)?blogs?|blogs?-(?:we|i)-(?:love|follow|read)|(?:travel-)?blogs?-to-follow|fellow-(?:travel-)?bloggers|friends|links|useful-links|recommended-(?:blogs|sites|links|reading)|(?:travel-)?resources|collaborat(?:e|ions?)|partners|blog-love|link-love)(?:[/.?#-]|$)/i
const BLOGROLL_ANCHOR =
  /\bblogroll\b|\bfavou?rite (?:travel )?blogs\b|\bblogs (?:we|i) (?:love|follow|read)\b|\bfellow bloggers\b|\b(?:travel )?resources\b|\bcollaborat(?:e|ions?)\b|\bblog love\b|\blink love\b|\brecommended (?:blogs|sites|reading)\b/i

/** Resources, favourite-blogs, blogroll and collaboration pages worth reading for outbound links. */
export function isBlogrollPageLink(url: string, anchor: string): boolean {
  return BLOGROLL_PATH.test(pathOf(url)) || BLOGROLL_ANCHOR.test(anchor)
}

/** Headings of sidebar widgets that list other blogs. */
export const BLOGROLL_WIDGET_HEADING =
  /\bblogroll\b|\bblogs (?:we|i) (?:love|follow|read)\b|\bfavou?rite blogs\b|\bfriends\b|\bfellow bloggers\b|\bblog love\b/i

/** Rank same-site links for the guest-author signal: author archives first, then guest listings. */
export function guestPageCandidates(
  links: ReadonlyArray<{ url: string; anchor: string }>,
  seed: string,
  limit: number = LOOKALIKE_DEFAULTS.maxGuestPages,
): { authors: string[]; listings: string[] } {
  const authors: string[] = []
  const listings: string[] = []
  const seen = new Set<string>()
  for (const link of links) {
    if (registrableDomain(link.url)?.domain !== seed) continue
    const key = link.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    if (isAuthorArchiveUrl(link.url)) authors.push(link.url)
    else if (isGuestListingLink(link.url, link.anchor)) listings.push(link.url)
  }
  return { authors: authors.slice(0, limit), listings: listings.slice(0, 2) }
}

export function blogrollPageCandidates(
  links: ReadonlyArray<{ url: string; anchor: string }>,
  seed: string,
  limit: number = LOOKALIKE_DEFAULTS.maxBlogrollPages,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const link of links) {
    if (registrableDomain(link.url)?.domain !== seed) continue
    if (!isBlogrollPageLink(link.url, link.anchor)) continue
    const key = link.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link.url)
    if (out.length >= limit) break
  }
  return out
}

/**
 * WordPress `/wp-json/wp/v2/users`: each author's website field and the links in
 * their description are the guest-author graph in one request; `link` is the
 * author archive (which usually renders the bio box too).
 */
export function parseWpUsers(body: string | null | undefined, seed: string): { bioUrls: string[]; archiveUrls: string[] } {
  const out = { bioUrls: [] as string[], archiveUrls: [] as string[] }
  if (!body) return out
  let users: unknown
  try {
    users = JSON.parse(body)
  } catch {
    return out
  }
  if (!Array.isArray(users)) return out
  const archives: Array<{ url: string; external: boolean }> = []
  for (const user of users.slice(0, 100)) {
    if (!user || typeof user !== 'object') continue
    const record = user as Record<string, unknown>
    const slug = String(record['slug'] ?? '')
    const urls = [String(record['url'] ?? '')]
    for (const match of String(record['description'] ?? '').matchAll(/https?:\/\/[^\s"'<>)]+/g)) urls.push(match[0].replace(/[.,;:!]+$/, ''))
    let external = false
    for (const url of urls) {
      const root = registrableDomain(url)?.domain
      if (!root || root === seed || !/^https?:\/\//i.test(url)) continue
      external = true
      if (!out.bioUrls.includes(url)) out.bioUrls.push(url)
    }
    const link = String(record['link'] ?? '')
    if (registrableDomain(link)?.domain === seed && !OWNER_SLUG.test(slug)) archives.push({ url: link, external })
  }
  // Authors who list an outside site first: their archive bio is the likeliest to carry more links.
  out.archiveUrls = archives.sort((a, b) => Number(b.external) - Number(a.external)).map((a) => a.url)
  return out
}

// ---------------------------------------------------------------------------
// Merging hits into candidates
// ---------------------------------------------------------------------------

export interface LookalikeHit {
  seed: string
  signal: LookalikeSignal
  /** Domain or URL as found. */
  url: string
  /** Rank within the signal (organic competitor order); null for scraped links. */
  rank?: number | null
}

export interface LookalikeCandidate {
  domain: string
  url: string
  seeds: string[]
  signals: LookalikeSignal[]
  /** Distinct (seed, signal) pairs that found the domain. */
  hits: number
  /** Lowest synthetic SERP position across hits; export-leads ranks on 100 - position. */
  position: number
}

export interface MergeLookalikeResult {
  candidates: LookalikeCandidate[]
  /** One row per (seed, signal, candidate), ready for hht_opp_guest_serp_results. */
  rows: Array<{ seed: string; signal: LookalikeSignal; domain: string; url: string; position: number }>
  known: number
  knownSample: string[]
  junk: Array<{ domain: string; reason: string }>
}

/**
 * Synthetic SERP position for a hit, so `export-leads` scoring (100 - best
 * position, +10 per extra keyword row) ranks lookalikes sensibly:
 * a guest-author bio link is the strongest single signal, then the top organic
 * competitors, then blogrolls.
 */
export function lookalikePosition(hit: Pick<LookalikeHit, 'signal' | 'rank'>): number {
  if (hit.signal === 'author_bio') return 10
  if (hit.signal === 'blogroll') return 30
  const rank = Math.max(1, hit.rank ?? 10)
  return Math.min(60, 5 + 3 * rank)
}

function homepage(root: string, url: string): string {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    if (registrableDomain(parsed.hostname)?.domain === root && parsed.pathname.length > 1) return parsed.toString()
    return `https://${parsed.hostname}/`
  } catch {
    return `https://${root}/`
  }
}

/**
 * Group hits by registrable domain; drop seeds themselves, HHT, anything already
 * known (tracker, guest tables, exclusion CSVs) and junk (the export-leads
 * deterministic filter). Candidates sort by hit count, then best position.
 */
export function mergeLookalikeHits(
  hits: readonly LookalikeHit[],
  known: ReadonlySet<string>,
): MergeLookalikeResult {
  const groups = new Map<string, { url: string; pairs: Map<string, { seed: string; signal: LookalikeSignal; url: string; position: number }> }>()
  const junk = new Map<string, string>()
  const knownHit = new Set<string>()
  for (const hit of hits) {
    const root = registrableDomain(hit.url)?.domain
    if (!root || root === hit.seed || root === HHT_SITE_DOMAIN) continue
    if (known.has(root)) {
      knownHit.add(root)
      continue
    }
    const url = homepage(root, hit.url)
    const reason = serpHitJunkReason(url, root)
    if (reason) {
      if (!junk.has(root)) junk.set(root, reason)
      continue
    }
    const group = groups.get(root) ?? { url, pairs: new Map() }
    const key = `${hit.signal}|${hit.seed}`
    const position = lookalikePosition(hit)
    const prior = group.pairs.get(key)
    if (!prior || position < prior.position) group.pairs.set(key, { seed: hit.seed, signal: hit.signal, url, position })
    groups.set(root, group)
  }

  const candidates: LookalikeCandidate[] = []
  const rows: MergeLookalikeResult['rows'] = []
  for (const [domain, group] of groups) {
    const pairs = [...group.pairs.values()]
    candidates.push({
      domain,
      url: `https://${new URL(group.url).hostname}/`,
      seeds: [...new Set(pairs.map((p) => p.seed))].sort(),
      signals: LOOKALIKE_SIGNALS.filter((signal) => pairs.some((p) => p.signal === signal)),
      hits: pairs.length,
      position: Math.min(...pairs.map((p) => p.position)),
    })
    for (const pair of pairs) rows.push({ ...pair, domain })
  }
  candidates.sort((a, b) => b.hits - a.hits || a.position - b.position || a.domain.localeCompare(b.domain))
  return {
    candidates,
    rows,
    known: knownHit.size,
    knownSample: [...knownHit].slice(0, 15),
    junk: [...junk.entries()].map(([domain, reason]) => ({ domain, reason })),
  }
}

/** Keep the top `limit` candidates and only the rows that belong to them. */
export function capLookalikeCandidates(merged: MergeLookalikeResult, limit: number | null): MergeLookalikeResult {
  if (limit == null || merged.candidates.length <= limit) return merged
  const candidates = merged.candidates.slice(0, Math.max(0, limit))
  const keep = new Set(candidates.map((c) => c.domain))
  return { ...merged, candidates, rows: merged.rows.filter((row) => keep.has(row.domain)) }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
