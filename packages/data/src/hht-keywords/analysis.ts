import type { KeywordIdea } from '../providers/google-ads/keyword-ideas.js'

/** A destination whose name is part of the query, never the request geo. */
export interface HhtDestination {
  slug: string
  label: string
  aliases: string[]
  countryCode: 'US' | 'CA'
  googleAdsGeoTarget: number
  volumeScope: 'us/en' | 'ca/en'
  /** Restrict matching for ambiguous names such as Arlington, VA vs Arlington, TX. */
  matchAliases?: string[]
}

export type HhtIntentTier = 'room' | 'suite' | 'romantic' | 'lodging'

export interface HhtKeywordCandidate {
  city: string
  citySlug: string
  countryCode: 'US' | 'CA'
  googleAdsGeoTarget: number
  volumeScope: 'us/en' | 'ca/en'
  keyword: string
  keywordNorm: string
  avgMonthlySearches: number | null
  competitionIndex: number | null
  lowTopOfPageBidMicros: bigint | null
  highTopOfPageBidMicros: bigint | null
  intentTier: HhtIntentTier
  clusterKey: string
  sources: Array<'grid' | 'google_ads_idea'>
}

export interface HhtRejectedKeyword {
  city: string
  citySlug: string
  keyword: string
  reason:
    | 'missing_city'
    | 'missing_amenity'
    | 'missing_lodging'
    | 'wrong_inventory'
    | 'wrong_geography'
}

export interface HhtCityAggregate {
  city: string
  citySlug: string
  countryCode: 'US' | 'CA'
  googleAdsGeoTarget: number
  volumeScope: 'us/en' | 'ca/en'
  keywordCount: number
  measuredKeywordCount: number
  unmeasuredKeywordCount: number
  /** Straight sum. Useful for auditing, but close variants may overlap. */
  rawAggregateVolume: number
  /** Sum of the highest-volume phrase in each conservative intent cluster. */
  conservativeAggregateVolume: number
  clusterCount: number
  topKeyword: string | null
  topKeywordVolume: number | null
}

const AMENITY = /\b(?:hot\s*tubs?|hottubs?|jacuzzis?|whirlpools?|spa\s+tubs?|jetted\s+tubs?)\b/i
const LODGING = /\b(?:hotels?|motels?|resorts?|inns?|lodging|accommodations?|rooms?|suites?|stays?|getaways?)\b/i
const WRONG_INVENTORY =
  /\b(?:airbnbs?|vrbos?|cabins?|cottages?|vacation\s+rentals?|repair|repairs|service|services|maintenance|installation|install|installer|installers|dealers?|showrooms?|stores?|parts?|covers?|chemicals?|pumps?|filters?|inflatable|portable|backyard|home|homes|used|for\s+sale|buy|prices?|costco)\b/i

/** Common destination spellings that are safe in a hotel-intent query. */
const COMMON_CITY_ALIASES: Record<string, string[]> = {
  'new york city': ['new york', 'nyc'],
  'las vegas': ['vegas'],
  'new orleans': ['nola'],
  'philadelphia': ['philly'],
  'saint louis': ['st louis'],
  'st. louis': ['st louis'],
  'fort worth': ['ft worth'],
  'saint paul': ['st paul'],
  'st. paul': ['st paul'],
}

const US_STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', dc: 'district of columbia',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
  nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon',
  pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
  tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia',
  wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
}

const CANADIAN_PROVINCES: Record<string, string> = {
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', nt: 'northwest territories',
  nu: 'nunavut', on: 'ontario', pe: 'prince edward island', qc: 'quebec',
  sk: 'saskatchewan', yt: 'yukon',
}

const REGIONS: Record<string, string> = { ...US_STATES, ...CANADIAN_PROVINCES }

const STATE_CLUSTER_TERMS = new RegExp(
  `\\b(?:${[
    ...Object.keys(REGIONS),
    ...Object.values(REGIONS),
    'canada',
    'canadian',
    'united states',
    'usa',
  ]
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'g',
)

export function normalizeHhtText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function phraseIn(haystack: string, needle: string): boolean {
  const cleanNeedle = normalizeHhtText(needle)
  return cleanNeedle !== '' && ` ${haystack} `.includes(` ${cleanNeedle} `)
}

function expectedState(destination: HhtDestination): { abbreviation: string; name: string } | null {
  const label = normalizeHhtText(destination.label)
  for (const alias of destination.aliases.map(normalizeHhtText)) {
    if (!alias.startsWith(`${label} `)) continue
    const suffix = alias.slice(label.length + 1)
    if (REGIONS[suffix]) return { abbreviation: suffix, name: REGIONS[suffix] }
  }
  return null
}

/** Reject explicit references to another state without penalising an unqualified city query. */
function hasConflictingState(keywordNorm: string, destination: HhtDestination): boolean {
  const expected = expectedState(destination)
  if (!expected) return false
  const label = normalizeHhtText(destination.label)
  const cityNames = [label, ...(COMMON_CITY_ALIASES[label] ?? [])]

  for (const city of cityNames) {
    for (const [abbreviation, name] of Object.entries(REGIONS)) {
      if (abbreviation === expected.abbreviation) continue
      if (phraseIn(keywordNorm, `${city} ${name}`)) return true
      // IN, ME, and OR are ordinary query words as well as state abbreviations.
      if (
        !['in', 'me', 'on', 'or'].includes(abbreviation) &&
        phraseIn(keywordNorm, `${city} ${abbreviation}`)
      ) {
        return true
      }
    }
  }
  return false
}

export function destinationAliases(destination: HhtDestination): string[] {
  if (destination.matchAliases?.length) {
    return [...new Set(destination.matchAliases.map(normalizeHhtText).filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    )
  }
  const base = normalizeHhtText(destination.label)
  const aliases = [
    destination.label,
    ...destination.aliases,
    ...(COMMON_CITY_ALIASES[base] ?? []),
  ]
    .map(normalizeHhtText)
    .filter(Boolean)
  return [...new Set(aliases)].sort((a, b) => b.length - a.length)
}

function intentTier(keywordNorm: string): HhtIntentTier {
  if (/\b(?:room|rooms|in room|inside room|private)\b/.test(keywordNorm)) return 'room'
  if (/\bsuites?\b/.test(keywordNorm)) return 'suite'
  if (/\b(?:romantic|couples?|getaways?)\b/.test(keywordNorm)) return 'romantic'
  return 'lodging'
}

/**
 * A conservative grouping key for city totals.
 *
 * Google Ads often gives close variants the same bucketed volume. A raw sum is
 * still exported, but summing the maximum inside this cluster avoids claiming
 * that word order, pluralisation, and Jacuzzi/hot-tub synonyms are independent
 * audiences. The cluster is deliberately visible in the keyword CSV.
 */
export function hhtIntentCluster(keyword: string, destination: HhtDestination): string {
  let value = normalizeHhtText(keyword)
  for (const alias of destinationAliases(destination)) {
    value = ` ${value} `.replace(` ${alias} `, ' city ').trim()
  }
  value = value
    .replace(STATE_CLUSTER_TERMS, ' ')
    .replace(
      /\b(?:hot\s*tubs?|hottubs?|jacuzzis?(?:\s+tubs?)?|whirlpools?(?:\s+tubs?)?|spa\s+tubs?|jetted\s+tubs?)\b/g,
      ' amenity ',
    )
    .replace(/\btubs?\b/g, ' ')
    .replace(/\bhotels?\b/g, ' hotel ')
    .replace(/\bmotels?\b/g, ' motel ')
    .replace(/\bresorts?\b/g, ' resort ')
    .replace(/\binns?\b/g, ' inn ')
    .replace(/\brooms?\b/g, ' room ')
    .replace(/\bsuites?\b/g, ' suite ')
    .replace(/\b(?:with|in|inside|a|an|the|of|at|near|and)\b/g, ' ')

  return [...new Set(normalizeHhtText(value).split(' ').filter(Boolean))].sort().join(' ')
}

export function classifyHhtKeyword(
  keyword: string,
  destination: HhtDestination,
):
  | { eligible: true; keywordNorm: string; intentTier: HhtIntentTier; clusterKey: string }
  | { eligible: false; reason: HhtRejectedKeyword['reason'] } {
  const keywordNorm = normalizeHhtText(keyword)
  if (!destinationAliases(destination).some((alias) => phraseIn(keywordNorm, alias))) {
    return { eligible: false, reason: 'missing_city' }
  }
  if (hasConflictingState(keywordNorm, destination)) {
    return { eligible: false, reason: 'wrong_geography' }
  }
  if (!AMENITY.test(keywordNorm)) return { eligible: false, reason: 'missing_amenity' }
  if (!LODGING.test(keywordNorm)) return { eligible: false, reason: 'missing_lodging' }
  if (WRONG_INVENTORY.test(keywordNorm)) return { eligible: false, reason: 'wrong_inventory' }
  return {
    eligible: true,
    keywordNorm,
    intentTier: intentTier(keywordNorm),
    clusterKey: hhtIntentCluster(keywordNorm, destination),
  }
}

function chooseVolume(
  existing: HhtKeywordCandidate | undefined,
  incoming: KeywordIdea,
): number | null {
  if (incoming.avgMonthlySearches !== null) return incoming.avgMonthlySearches
  return existing?.avgMonthlySearches ?? null
}

/** Merge generated grid rows and Google ideas into one auditable city list. */
export function mergeHhtKeywords(args: {
  destination: HhtDestination
  grid: KeywordIdea[]
  ideas: KeywordIdea[]
}): { candidates: HhtKeywordCandidate[]; rejected: HhtRejectedKeyword[] } {
  const byKeyword = new Map<string, HhtKeywordCandidate>()
  const rejected: HhtRejectedKeyword[] = []

  const ingest = (idea: KeywordIdea, source: 'grid' | 'google_ads_idea') => {
    const classified = classifyHhtKeyword(idea.keyword, args.destination)
    if (!classified.eligible) {
      rejected.push({
        city: args.destination.label,
        citySlug: args.destination.slug,
        keyword: idea.keyword,
        reason: classified.reason,
      })
      return
    }

    const existing = byKeyword.get(classified.keywordNorm)
    const sources = existing ? [...new Set([...existing.sources, source])] : [source]
    byKeyword.set(classified.keywordNorm, {
      city: args.destination.label,
      citySlug: args.destination.slug,
      countryCode: args.destination.countryCode,
      googleAdsGeoTarget: args.destination.googleAdsGeoTarget,
      volumeScope: args.destination.volumeScope,
      keyword: idea.keyword.trim().toLowerCase().replace(/\s+/g, ' '),
      keywordNorm: classified.keywordNorm,
      avgMonthlySearches: chooseVolume(existing, idea),
      competitionIndex: idea.competitionIndex ?? existing?.competitionIndex ?? null,
      lowTopOfPageBidMicros:
        idea.lowTopOfPageBidMicros ?? existing?.lowTopOfPageBidMicros ?? null,
      highTopOfPageBidMicros:
        idea.highTopOfPageBidMicros ?? existing?.highTopOfPageBidMicros ?? null,
      intentTier: classified.intentTier,
      clusterKey: classified.clusterKey,
      sources,
    })
  }

  for (const row of args.grid) ingest(row, 'grid')
  for (const row of args.ideas) ingest(row, 'google_ads_idea')

  const candidates = [...byKeyword.values()].sort(
    (a, b) =>
      (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) ||
      a.keyword.localeCompare(b.keyword),
  )
  return { candidates, rejected }
}

export function aggregateHhtCity(
  destination: HhtDestination,
  candidates: HhtKeywordCandidate[],
): HhtCityAggregate {
  const measured = candidates.filter((row) => row.avgMonthlySearches !== null)
  const clusterMax = new Map<string, number>()
  for (const row of measured) {
    const volume = row.avgMonthlySearches ?? 0
    clusterMax.set(row.clusterKey, Math.max(clusterMax.get(row.clusterKey) ?? 0, volume))
  }
  const top = measured[0] ?? null
  return {
    city: destination.label,
    citySlug: destination.slug,
    countryCode: destination.countryCode,
    googleAdsGeoTarget: destination.googleAdsGeoTarget,
    volumeScope: destination.volumeScope,
    keywordCount: candidates.length,
    measuredKeywordCount: measured.length,
    unmeasuredKeywordCount: candidates.length - measured.length,
    rawAggregateVolume: measured.reduce((sum, row) => sum + (row.avgMonthlySearches ?? 0), 0),
    conservativeAggregateVolume: [...clusterMax.values()].reduce((sum, volume) => sum + volume, 0),
    clusterCount: clusterMax.size,
    topKeyword: top?.keyword ?? null,
    topKeywordVolume: top?.avgMonthlySearches ?? null,
  }
}
