/**
 * Template × entity keyword generation for guest-post discovery.
 *
 * The productive keywords are all "template + place" (`things to do in X`,
 * `weekend getaways from X`, `X road trip`). This module makes that explicit:
 * each bucket has templates, each template has a slot (city, state or region),
 * and the geography corpus supplies the places. Candidates are ranked by
 *
 *   template prior × entity tourism weight × novelty
 *
 * where the prior is the template's running pitchable-per-keyword yield,
 * smoothed toward the global yield, and novelty falls when the keyword sits
 * next to a saturated SERP neighborhood. Keywords the frontier would skip
 * anyway (`guestKeywordFetchDecision`) are not candidates at all.
 *
 * Pure functions only. Loading entities and history, and enqueuing, live in
 * packages/data/src/hht-opp/guest-templates.ts.
 */

import { normalizeFrontierKeyword } from '../hht-engine/keywords.js'
import type { GuestBucketId } from './guest-buckets.js'
import { guestKeywordFetchDecision, guestKeywordSimilarity, isGuestBucketKeyword, type FetchedGuestKeyword } from './guest-frontier.js'

export type GuestEntityKind = 'city' | 'state' | 'region'

export interface GuestTemplate {
  /** Stable id, `bucket.slug`. */
  id: string
  bucket: GuestBucketId
  /** Phrase with exactly one `{city}`, `{state}` or `{region}` slot. */
  pattern: string
}

export interface GuestEntity {
  kind: GuestEntityKind
  name: string
  /** 0–1. How much travel/lifestyle content the place attracts. */
  weight: number
}

const t = (bucket: GuestBucketId, slug: string, pattern: string): GuestTemplate => ({ id: `${bucket}.${slug}`, bucket, pattern })

export const GUEST_TEMPLATES: readonly GuestTemplate[] = [
  // Travel: the measured winners (plan section 1) plus their close relatives.
  t('travel', 'things-to-do', 'things to do in {city}'),
  t('travel', 'weekend-getaways-from', 'weekend getaways from {city}'),
  t('travel', 'state-road-trip', '{state} road trip'),
  t('travel', 'weekend-in', 'weekend in {city}'),
  t('travel', 'romantic-getaways-state', 'romantic getaways in {state}'),
  t('travel', 'city-itinerary', '{city} itinerary'),
  t('travel', 'hidden-gems-region', 'hidden gems in {region}'),
  t('travel', 'day-trips-from', 'day trips from {city}'),
  // Romance and couples.
  t('romance', 'date-ideas', 'date ideas in {city}'),
  t('romance', 'anniversary-ideas', 'anniversary ideas in {city}'),
  t('romance', 'romantic-things-to-do', 'romantic things to do in {city}'),
  t('romance', 'couples-getaways-state', 'couples getaways in {state}'),
  // Weddings and honeymoons.
  t('weddings', 'honeymoon-destinations-state', 'honeymoon destinations in {state}'),
  t('weddings', 'places-to-elope-state', 'places to elope in {state}'),
  t('weddings', 'bachelorette-weekend', 'bachelorette weekend in {city}'),
  t('weddings', 'babymoon-state', 'babymoon destinations in {state}'),
  // Wellness and spa.
  t('wellness', 'spa-weekend-state', 'spa weekend in {state}'),
  t('wellness', 'wellness-retreats-near', 'wellness retreats near {city}'),
  t('wellness', 'hot-springs-state', 'hot springs in {state}'),
  t('wellness', 'cabins-hot-tubs-region', 'cabins with hot tubs in {region}'),
  // Regional and city lifestyle magazines.
  t('lifestyle', 'this-weekend', 'things to do in {city} this weekend'),
  t('lifestyle', 'brunch', 'best brunch in {city}'),
  t('lifestyle', 'staycation-ideas', '{city} staycation ideas'),
  t('lifestyle', 'date-night', '{city} date night ideas'),
]

/** Plan section 3.1: retire a template below 0.3 pitchable per keyword after 10 fetches. */
export const GUEST_TEMPLATE_RETIRE_BELOW = 0.3
export const GUEST_TEMPLATE_RETIRE_AFTER = 10
/** Pseudo-fetches at the global yield that a template's prior starts from. */
export const GUEST_TEMPLATE_PRIOR_SMOOTHING = 3
/** SERP baseline from the tracker: about 3.6% of new domains end up pitchable. */
export const GUEST_PITCHABLE_PER_NEW_DOMAIN = 0.036

export function guestTemplateSlot(template: Pick<GuestTemplate, 'pattern'>): GuestEntityKind {
  const match = template.pattern.match(/\{(city|state|region)\}/)
  if (!match?.[1]) throw new Error(`Template has no slot: ${template.pattern}`)
  return match[1] as GuestEntityKind
}

export function renderGuestTemplate(template: Pick<GuestTemplate, 'pattern'>, entity: Pick<GuestEntity, 'name'>): string {
  return template.pattern.replace(/\{(?:city|state|region)\}/, entity.name).replace(/\s+/g, ' ').trim().toLowerCase()
}

const LEADING_MODIFIER = /^(?:(?:best|top|the)\s+)+/

function cleanKeyword(keyword: string): string {
  return keyword.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface CompiledTemplate {
  template: GuestTemplate
  regex: RegExp
  literalLength: number
}

function compileTemplates(templates: readonly GuestTemplate[]): CompiledTemplate[] {
  return templates
    .map((template) => {
      const pattern = cleanKeyword(template.pattern).replace(LEADING_MODIFIER, '')
      const [before = '', after = ''] = pattern.split(/\{(?:city|state|region)\}/)
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return {
        template,
        regex: new RegExp(`^${escape(before)}([a-z0-9.' -]+?)${escape(after)}$`),
        literalLength: before.length + after.length,
      }
    })
    // Most specific first: `things to do in X this weekend` before `things to do in X`.
    .sort((a, b) => b.literalLength - a.literalLength)
}

/** The template a stored keyword was (or could have been) generated from, by its text. */
export function matchGuestTemplate(
  keyword: string,
  templates: readonly GuestTemplate[] = GUEST_TEMPLATES,
): { template: GuestTemplate; entity: string } | null {
  const text = cleanKeyword(keyword).replace(LEADING_MODIFIER, '')
  for (const compiled of compileTemplates(templates)) {
    const entity = text.match(compiled.regex)?.[1]?.trim()
    if (entity && isPlaceLike(entity)) return { template: compiled.template, entity }
  }
  return null
}

/** Words that mean the slot captured another template's phrasing, not a place. */
const NOT_A_PLACE = new Set([
  'itinerary', 'road', 'trip', 'trips', 'day', 'days', 'week', 'weeks', 'weekend', 'travel', 'romantic',
  'luxury', 'anniversary', 'staycation', 'slow', 'ideas', 'guide', 'getaway', 'getaways', 'things', 'couples',
])

function isPlaceLike(entity: string): boolean {
  const tokens = entity.split(' ')
  return tokens.length <= 4 && !/\d/.test(entity) && !tokens.some((token) => NOT_A_PLACE.has(token))
}

// ---------------------------------------------------------------- entities

/**
 * Places that draw far more travel content than their population suggests.
 * A metro whose CBSA name contains one of these is labeled by it
 * (`North Port-Bradenton-Sarasota` → Sarasota) and gets the destination boost.
 */
const DESTINATION_CITIES = new Set([
  'asheville', 'atlanta', 'austin', 'bend', 'boston', 'boulder', 'branson', 'burlington', 'charleston',
  'charlottesville', 'chattanooga', 'chicago', 'denver', 'destin', 'duluth', 'flagstaff', 'fort myers',
  'galveston', 'gatlinburg', 'honolulu', 'kansas city', 'key west', 'las vegas', 'los angeles', 'louisville',
  'madison', 'memphis', 'miami', 'milwaukee', 'minneapolis', 'monterey', 'myrtle beach', 'naples',
  'napa', 'nashville', 'new orleans', 'new york', 'orlando', 'palm springs', 'panama city', 'philadelphia',
  'phoenix', 'pittsburgh', 'portland', 'providence', 'richmond', 'salt lake city', 'san antonio',
  'san diego', 'san francisco', 'san jose', 'santa barbara', 'santa cruz', 'santa fe', 'sarasota',
  'savannah', 'scottsdale', 'seattle', 'st. augustine', 'st. louis', 'tampa', 'traverse city', 'tucson',
  'washington dc', 'wilmington', 'asbury park', 'ocean city', 'virginia beach', 'kahului', 'anchorage',
])

const CITY_OVERRIDES: Record<string, string> = {
  'urban honolulu': 'Honolulu',
  washington: 'Washington DC',
  'boise city': 'Boise',
  'nashville-davidson': 'Nashville',
}

/** Usable city name from a CBSA title such as `Nashville-Davidson--Murfreesboro--Franklin`. */
export function metroPrincipalCity(cbsaName: string): string {
  const segments = cbsaName
    .split(/--|-|\//)
    .map((part) => part.trim())
    .filter(Boolean)
  const named = segments.map((part) => CITY_OVERRIDES[part.toLowerCase()] ?? part)
  return named.find((part) => DESTINATION_CITIES.has(part.toLowerCase())) ?? named[0] ?? cbsaName.trim()
}

/**
 * Top metros by population as `{city}` entities. Weight is 0.35–0.7 from log
 * population, plus 0.3 for a known destination.
 */
export function guestMetroEntities(
  rows: ReadonlyArray<{ name: string; population: number | null }>,
  options: { limit?: number } = {},
): GuestEntity[] {
  const limit = options.limit ?? 300
  const ranked = rows
    .filter((row) => (row.population ?? 0) > 0)
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
  const picked: Array<{ name: string; population: number }> = []
  const seen = new Set<string>()
  for (const row of ranked) {
    const name = metroPrincipalCity(row.name)
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ name, population: row.population ?? 0 })
    if (picked.length >= limit) break
  }
  if (picked.length === 0) return []
  const logs = picked.map((row) => Math.log(row.population))
  const max = Math.max(...logs)
  const min = Math.min(...logs)
  return picked.map((row) => {
    const popScore = max > min ? (Math.log(row.population) - min) / (max - min) : 1
    const destination = DESTINATION_CITIES.has(row.name.toLowerCase()) ? 0.3 : 0
    return { kind: 'city' as const, name: row.name, weight: round(0.35 + 0.35 * popScore + destination) }
  })
}

/** States with a large travel-blog footprint. The rest get 0.7. */
const DESTINATION_STATES = new Set([
  'arizona', 'california', 'colorado', 'florida', 'georgia', 'hawaii', 'maine', 'massachusetts', 'michigan',
  'montana', 'nevada', 'new mexico', 'new york', 'north carolina', 'oregon', 'south carolina', 'tennessee',
  'texas', 'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'alaska',
])

export function guestStateEntities(names: readonly string[]): GuestEntity[] {
  return names.map((name) => ({
    kind: 'state' as const,
    name,
    weight: DESTINATION_STATES.has(name.toLowerCase()) ? 1 : 0.7,
  }))
}

/** Named US tourism regions. Not in the Census corpus, so curated here. */
export const GUEST_TOURISM_REGIONS: readonly GuestEntity[] = (
  [
    ['Smoky Mountains', 1], ['Napa Valley', 1], ['Lake Tahoe', 1], ['Florida Keys', 1], ['Cape Cod', 1],
    ['Hill Country', 0.95], ['Hudson Valley', 0.95], ['Blue Ridge Mountains', 0.95], ['Outer Banks', 0.95],
    ['Finger Lakes', 0.95], ['Big Sur', 0.9], ['Sonoma County', 0.9], ['Catskills', 0.9], ['Adirondacks', 0.9],
    ['Berkshires', 0.9], ['Poconos', 0.9], ['White Mountains', 0.85], ['Upper Peninsula', 0.85],
    ['Door County', 0.85], ['Ozarks', 0.85], ['Black Hills', 0.8], ['Olympic Peninsula', 0.85],
    ['Columbia River Gorge', 0.8], ['Oregon Coast', 0.9], ['Central Coast', 0.85], ['Palm Springs', 0.9],
    ['Sedona', 0.95], ['Shenandoah Valley', 0.85], ['Lowcountry', 0.85], ['Emerald Coast', 0.85],
    ['Gulf Shores', 0.8], ['Hamptons', 0.85], ['Jersey Shore', 0.8], ['Coastal Maine', 0.9],
    ['Hocking Hills', 0.8], ['Willamette Valley', 0.8], ['Eastern Sierra', 0.8], ['New England', 0.95],
    ['Pacific Northwest', 0.95], ['Upstate New York', 0.85], ['Texas Gulf Coast', 0.75], ['Gold Country', 0.75],
  ] as const
).map(([name, weight]) => ({ kind: 'region' as const, name, weight }))

// ---------------------------------------------------------------- priors

export interface GuestTemplateHistoryRow {
  keyword: string
  /** A Semrush SERP pull happened (FETCHED, SATURATED, EXHAUSTED or NO_DATA). */
  fetched: boolean
  newDomains: number
  /** Tracker PURSUE count attributed to this keyword, when known. */
  pitchable: number | null
}

export interface GuestTemplateStats {
  templateId: string
  bucket: GuestBucketId
  fetches: number
  /** Fetches whose pitchable count comes from the tracker rather than the estimate. */
  observed: number
  pitchable: number
  newDomains: number
  pitchablePerKeyword: number | null
  newDomainsPerKeyword: number | null
  /** Smoothed pitchable per keyword used for ranking. */
  prior: number
  retired: boolean
}

export interface GuestYieldBaseline {
  /** Pitchable per new domain, used where the tracker has no count yet. */
  perNewDomain: number
  /** Pitchable per fetched keyword over all history: the prior's starting point. */
  perKeyword: number
}

function estimatedPitchable(row: GuestTemplateHistoryRow, perNewDomain: number): number {
  return row.pitchable ?? row.newDomains * perNewDomain
}

export function guestYieldBaseline(history: readonly GuestTemplateHistoryRow[]): GuestYieldBaseline {
  const fetched = history.filter((row) => row.fetched)
  const observed = fetched.filter((row) => row.pitchable != null && row.newDomains > 0)
  const observedNew = sum(observed.map((row) => row.newDomains))
  const perNewDomain = observedNew > 0 ? sum(observed.map((row) => row.pitchable ?? 0)) / observedNew : GUEST_PITCHABLE_PER_NEW_DOMAIN
  const perKeyword = fetched.length > 0
    ? sum(fetched.map((row) => estimatedPitchable(row, perNewDomain))) / fetched.length
    : 1
  return { perNewDomain, perKeyword }
}

/**
 * Running yield per template. Retirement uses the raw rate (pitchable per
 * fetched keyword); ranking uses the prior smoothed toward the global rate so
 * one lucky keyword does not dominate.
 */
export function guestTemplateStats(
  history: readonly GuestTemplateHistoryRow[],
  options: {
    templates?: readonly GuestTemplate[]
    baseline?: GuestYieldBaseline
    smoothing?: number
    retireBelow?: number
    retireAfter?: number
  } = {},
): Map<string, GuestTemplateStats> {
  const templates = options.templates ?? GUEST_TEMPLATES
  const baseline = options.baseline ?? guestYieldBaseline(history)
  const smoothing = options.smoothing ?? GUEST_TEMPLATE_PRIOR_SMOOTHING
  const retireBelow = options.retireBelow ?? GUEST_TEMPLATE_RETIRE_BELOW
  const retireAfter = options.retireAfter ?? GUEST_TEMPLATE_RETIRE_AFTER
  const totals = new Map(templates.map((template) => [template.id, { fetches: 0, observed: 0, pitchable: 0, newDomains: 0 }]))
  for (const row of history) {
    if (!row.fetched) continue
    const match = matchGuestTemplate(row.keyword, templates)
    if (!match) continue
    const total = totals.get(match.template.id)
    if (!total) continue
    total.fetches += 1
    if (row.pitchable != null) total.observed += 1
    total.pitchable += estimatedPitchable(row, baseline.perNewDomain)
    total.newDomains += row.newDomains
  }
  const out = new Map<string, GuestTemplateStats>()
  for (const template of templates) {
    const total = totals.get(template.id) ?? { fetches: 0, observed: 0, pitchable: 0, newDomains: 0 }
    const rate = total.fetches > 0 ? total.pitchable / total.fetches : null
    out.set(template.id, {
      templateId: template.id,
      bucket: template.bucket,
      fetches: total.fetches,
      observed: total.observed,
      pitchable: round(total.pitchable),
      newDomains: total.newDomains,
      pitchablePerKeyword: rate == null ? null : round(rate),
      newDomainsPerKeyword: total.fetches > 0 ? round(total.newDomains / total.fetches) : null,
      prior: round((total.pitchable + smoothing * baseline.perKeyword) / (total.fetches + smoothing)),
      retired: total.fetches >= retireAfter && rate != null && rate < retireBelow,
    })
  }
  return out
}

// ---------------------------------------------------------------- ranking

export interface GuestTemplateCandidate {
  keyword: string
  templateId: string
  bucket: GuestBucketId
  entity: GuestEntity
  prior: number
  novelty: number
  score: number
}

export interface GuestTemplateRanking {
  candidates: GuestTemplateCandidate[]
  skipped: {
    known: number
    retiredTemplate: number
    offTopic: number
    nearDuplicate: number
    neighborhoodSaturated: number
    perTemplateCap: number
  }
}

/**
 * Rank template × entity keywords for the guest frontier queue.
 *
 * Novelty is 1 − the highest token similarity to a keyword whose SERP came
 * back saturated, so places next to used-up neighborhoods sink. `perTemplate`
 * caps how many slots one template can take, so new buckets get explored.
 */
export function rankGuestTemplateCandidates(input: {
  entities: readonly GuestEntity[]
  stats: ReadonlyMap<string, GuestTemplateStats>
  known: Iterable<string>
  fetched: readonly FetchedGuestKeyword[]
  limit: number
  templates?: readonly GuestTemplate[]
  buckets?: readonly GuestBucketId[]
  perTemplate?: number
}): GuestTemplateRanking {
  const templates = (input.templates ?? GUEST_TEMPLATES).filter((template) => !input.buckets?.length || input.buckets.includes(template.bucket))
  const known = new Set([...input.known].map((keyword) => normalizeFrontierKeyword(keyword)).filter(Boolean))
  const saturated = input.fetched.filter((row) => row.neighborhood === 'saturated')
  const skipped: GuestTemplateRanking['skipped'] = {
    known: 0, retiredTemplate: 0, offTopic: 0, nearDuplicate: 0, neighborhoodSaturated: 0, perTemplateCap: 0,
  }
  const bySlot = new Map<GuestEntityKind, GuestEntity[]>()
  for (const entity of input.entities) bySlot.set(entity.kind, [...(bySlot.get(entity.kind) ?? []), entity])

  const all: GuestTemplateCandidate[] = []
  for (const template of templates) {
    const stats = input.stats.get(template.id)
    const entities = bySlot.get(guestTemplateSlot(template)) ?? []
    if (stats?.retired) {
      skipped.retiredTemplate += entities.length
      continue
    }
    const prior = stats?.prior ?? 1
    for (const entity of entities) {
      const keyword = renderGuestTemplate(template, entity)
      const key = normalizeFrontierKeyword(keyword)
      if (!key || known.has(key)) {
        skipped.known += 1
        continue
      }
      if (!isGuestBucketKeyword(keyword, template.bucket)) {
        skipped.offTopic += 1
        continue
      }
      const decision = guestKeywordFetchDecision(keyword, input.fetched)
      if (!decision.fetch) {
        if (decision.reason === 'near_duplicate') skipped.nearDuplicate += 1
        else skipped.neighborhoodSaturated += 1
        continue
      }
      known.add(key)
      let nearest = 0
      for (const row of saturated) nearest = Math.max(nearest, guestKeywordSimilarity(keyword, row.keyword))
      const novelty = round(1 - nearest)
      all.push({
        keyword,
        templateId: template.id,
        bucket: template.bucket,
        entity,
        prior,
        novelty,
        score: round(prior * entity.weight * novelty),
      })
    }
  }

  all.sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword))
  const cap = input.perTemplate ?? Math.max(3, Math.ceil(input.limit / 5))
  const perTemplate = new Map<string, number>()
  const candidates: GuestTemplateCandidate[] = []
  for (const candidate of all) {
    if (candidates.length >= input.limit) break
    const used = perTemplate.get(candidate.templateId) ?? 0
    if (used >= cap) {
      skipped.perTemplateCap += 1
      continue
    }
    perTemplate.set(candidate.templateId, used + 1)
    candidates.push(candidate)
  }
  return { candidates, skipped }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
