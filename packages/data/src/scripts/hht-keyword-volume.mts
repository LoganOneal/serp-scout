/**
 * Free-only Hotel Hot Tubs keyword discovery and city-volume aggregation.
 *
 * This command calls Google Ads only. It never imports DataForSEO, Semrush, or
 * a SERP provider. Destination names stay in the keyword while every request is
 * scoped to each destination's country audience (US 2840 or Canada 2124).
 *
 *   node --import tsx --conditions=react-server \
 *     packages/data/src/scripts/hht-keyword-volume.mts --live
 */
import 'dotenv/config'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { KeywordSpace, SpaceEntity } from '@rnr/core'
import { closeDb, db } from '../db.js'
import {
  aggregateHhtCity,
  mergeHhtKeywords,
  normalizeHhtText,
  type HhtDestination,
  type HhtKeywordCandidate,
  type HhtRejectedKeyword,
} from '../hht-keywords/analysis.js'
import { HHT_CANADIAN_DESTINATIONS } from '../hht-keywords/markets.js'
import { saveHhtRedditAnalysis } from '../hht-keywords/store.js'
import { fetchKeywordIdeas, type KeywordIdea } from '../providers/google-ads/keyword-ideas.js'
import {
  GOOGLE_ADS_GEO_CA,
  GOOGLE_ADS_GEO_US,
} from '../providers/google-ads/keyword-volume.js'
import { siteKeywordTargets } from '../schema.js'
import { ensureKeywordVolumes } from '../serp/keyword-volume-cache.js'
import { loadDimensionEntities } from '../spaces/entities.js'
import { findSiteByDomain } from '../spaces/sites.js'

const argv = process.argv.slice(2)
const value = (name: string, fallback: string): string => {
  const exact = argv.indexOf(`--${name}`)
  if (exact >= 0) return argv[exact + 1] ?? fallback
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)
const positiveInt = (name: string, fallback: number): number => {
  const parsed = Number(value(name, String(fallback)))
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`)
  return parsed
}

const domain = value('domain', 'hotelhottubs.com')
const maxUsCities = positiveInt('max-cities', 195)
const maxCanadianCities = positiveInt('max-canadian-cities', HHT_CANADIAN_DESTINATIONS.length)
const pageSize = positiveInt('page-size', 100)
const delayMs = positiveInt('delay-ms', 1_100)
const live = has('live')
const refresh = has('refresh')
const persist = has('persist')
const outputDir = resolve(value('output-dir', 'exports/hht-keywords'))
const cacheDir = resolve(value('cache-dir', '.cache/hht-keyword-ideas-us-v1'))
const countries = new Set(
  value('countries', 'US,CA')
    .split(',')
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean),
)
for (const country of countries) {
  if (country !== 'US' && country !== 'CA') {
    throw new Error(`--countries only accepts US and CA; received ${country}`)
  }
}
if (countries.size === 0) throw new Error('--countries must include US, CA, or both')

if (!live && refresh) throw new Error('--refresh requires --live')

interface CachedIdeas {
  version: 1
  destination: HhtDestination
  seeds: string[]
  fetchedAt: string
  ideas: Array<{
    keyword: string
    avgMonthlySearches: number | null
    competitionIndex: number | null
    lowTopOfPageBidMicros: string | null
    highTopOfPageBidMicros: string | null
  }>
}

interface CityRun {
  destination: HhtDestination
  candidates: HhtKeywordCandidate[]
  rejected: HhtRejectedKeyword[]
  ideaCount: number
  source: 'cache' | 'google_ads' | 'unavailable'
  error: string | null
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function asDestination(entity: SpaceEntity): HhtDestination {
  return {
    slug: entity.slug,
    label: entity.label,
    aliases: entity.aliases,
    countryCode: 'US',
    googleAdsGeoTarget: GOOGLE_ADS_GEO_US,
    volumeScope: 'us/en',
  }
}

function serialiseIdeas(
  destination: HhtDestination,
  seeds: string[],
  ideas: KeywordIdea[],
): CachedIdeas {
  return {
    version: 1,
    destination,
    seeds,
    fetchedAt: new Date().toISOString(),
    ideas: ideas.map((idea) => ({
      keyword: idea.keyword,
      avgMonthlySearches: idea.avgMonthlySearches,
      competitionIndex: idea.competitionIndex,
      lowTopOfPageBidMicros: idea.lowTopOfPageBidMicros?.toString() ?? null,
      highTopOfPageBidMicros: idea.highTopOfPageBidMicros?.toString() ?? null,
    })),
  }
}

function deserialiseIdeas(cache: CachedIdeas): KeywordIdea[] {
  return cache.ideas.map((idea) => ({
    keyword: idea.keyword,
    avgMonthlySearches: idea.avgMonthlySearches,
    competitionIndex: idea.competitionIndex,
    lowTopOfPageBidMicros:
      idea.lowTopOfPageBidMicros === null ? null : BigInt(idea.lowTopOfPageBidMicros),
    highTopOfPageBidMicros:
      idea.highTopOfPageBidMicros === null ? null : BigInt(idea.highTopOfPageBidMicros),
  }))
}

async function readIdeasCache(path: string, seeds: string[]): Promise<KeywordIdea[] | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CachedIdeas
    if (parsed.version !== 1 || !Array.isArray(parsed.ideas)) return null
    if (JSON.stringify(parsed.seeds) !== JSON.stringify(seeds)) return null
    return deserialiseIdeas(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeIdeasCache(path: string, cache: CachedIdeas): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8')
  await rename(temp, path)
}

function gridIdea(row: {
  keyword: string
  volume: number | null
  competitionIndex: number | null
  bidLowMicros: bigint | null
  bidHighMicros: bigint | null
}): KeywordIdea {
  return {
    keyword: row.keyword,
    avgMonthlySearches: row.volume,
    competitionIndex: row.competitionIndex,
    lowTopOfPageBidMicros: row.bidLowMicros,
    highTopOfPageBidMicros: row.bidHighMicros,
  }
}

function csvCell(input: unknown): string {
  if (input === null || input === undefined) return ''
  const text = String(input)
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

function csv(headers: string[], rows: Array<Record<string, unknown>>): string {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    '',
  ].join('\n')
}

function usdFromMicros(value: bigint | null): string | null {
  if (value === null) return null
  return (Number(value) / 1_000_000).toFixed(2)
}

function isQuotaError(message: string): boolean {
  return /RESOURCE_(?:TEMPORARILY_)?EXHAUSTED|quota|rate.?limit/i.test(message)
}

async function fetchIdeasWithRetry(
  destination: HhtDestination,
  seeds: string[],
): Promise<{ ideas: KeywordIdea[]; error: string | null }> {
  let lastError: string | null = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await fetchKeywordIdeas(seeds, {
      // The destination is in every seed. This is its country audience, never its city code.
      geoTargetCriteriaIds: [destination.googleAdsGeoTarget],
      pageSize,
    })
    if (result.source === 'google_ads') return { ideas: result.ideas, error: null }
    lastError = result.error ?? 'Google Ads keyword ideas returned no source'
    if (!isQuotaError(lastError) || attempt === 3) break
    const retryMs = attempt * 5_000
    console.log(`  quota/rate response for ${destination.slug}; retrying in ${retryMs / 1000}s`)
    await sleep(retryMs)
  }
  return { ideas: [], error: lastError }
}

async function main(): Promise<void> {
  const database = db()
  const site = await findSiteByDomain(database, domain)
  if (!site?.keywordSpace) throw new Error(`No keyword space found for ${domain}`)
  const space = site.keywordSpace as KeywordSpace
  if (space.geoMode !== 'in_keyword') {
    throw new Error(
      `${domain} must use geoMode=in_keyword; refusing a city-bound request`,
    )
  }

  const entities = await loadDimensionEntities(database, space)
  const usDestinations = countries.has('US')
    ? (entities['locality'] ?? []).slice(0, maxUsCities).map(asDestination)
    : []
  const canadianDestinations = countries.has('CA')
    ? HHT_CANADIAN_DESTINATIONS.slice(0, maxCanadianCities)
    : []
  const destinations = [...usDestinations, ...canadianDestinations]
  if (destinations.length === 0) throw new Error('No locality entities resolved for this site')
  const destinationSlugs = new Set(destinations.map((destination) => destination.slug))
  const labelCounts = new Map<string, number>()
  for (const destination of destinations) {
    const label = `${destination.countryCode}:${normalizeHhtText(destination.label)}`
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
  }

  const gridRows = await database
    .select({
      id: siteKeywordTargets.id,
      keyword: siteKeywordTargets.keyword,
      volume: siteKeywordTargets.volume,
      competitionIndex: siteKeywordTargets.competitionIndex,
      bidLowMicros: siteKeywordTargets.bidLowMicros,
      bidHighMicros: siteKeywordTargets.bidHighMicros,
      entities: siteKeywordTargets.entities,
    })
    .from(siteKeywordTargets)
    .where(
      and(
        eq(siteKeywordTargets.siteId, site.id),
        eq(siteKeywordTargets.active, true),
        isNotNull(siteKeywordTargets.patternLabel),
      ),
    )

  const scopedGridRows = gridRows.filter((row) => {
    const slug = row.entities?.['locality']
    return slug !== undefined && destinationSlugs.has(slug)
  })

  console.log(
    `Hotel Hot Tubs free keyword run: ${destinations.length} destinations, ` +
      `${scopedGridRows.length} US grid seeds, ` +
      `${usDestinations.length} US markets + ${canadianDestinations.length} Canadian markets`,
  )
  console.log('Audience targets: US 2840, Canada 2124; city names stay inside the query.')
  console.log('Paid providers disabled by construction: no SERP, DataForSEO, or Semrush imports.')

  /**
   * Fill exact metrics for the known grid first. This is one logical free batch;
   * the provider internally observes Google's 1 QPS planning limit.
   */
  const exact = await ensureKeywordVolumes(database, {
    keywords: scopedGridRows.map((row) => row.keyword),
    locationCode: GOOGLE_ADS_GEO_US,
    live,
  })
  const exactMeasured = [...exact.volumes.values()].filter(
    (row) => row.avgMonthlySearches !== null,
  ).length
  console.log(
    `Exact grid volume: ${exactMeasured}/${scopedGridRows.length} rows measured; ` +
      `${exact.fetched} fetched this run; cost $0.`,
  )

  const rowsByCity = new Map<string, typeof scopedGridRows>()
  for (const row of scopedGridRows) {
    const slug = row.entities?.['locality']
    if (!slug) continue
    const list = rowsByCity.get(slug) ?? []
    const fresh = exact.volumes.get(row.keyword.trim().toLowerCase())
    list.push({
      ...row,
      volume: fresh?.avgMonthlySearches ?? row.volume,
      competitionIndex: fresh?.competitionIndex ?? row.competitionIndex,
      bidLowMicros: fresh?.lowTopOfPageBidMicros ?? row.bidLowMicros,
      bidHighMicros: fresh?.highTopOfPageBidMicros ?? row.bidHighMicros,
    })
    rowsByCity.set(slug, list)
  }

  await mkdir(cacheDir, { recursive: true })
  const runs: CityRun[] = []
  let liveCalls = 0
  let stoppedForQuota = false

  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index]!
    const cityGrid = rowsByCity.get(destination.slug) ?? []
    /**
     * A per-site keyword is unique, so two cities with the same bare name
     * cannot both own `hotels ... arlington`. Seed same-name markets with a
     * region-qualified phrase and require that explicit geography in ideas.
     * New Canadian markets also use qualified seeds, but retain bare-city
     * matches because the country-level request already disambiguates them.
     */
    const explicitLabel = destination.aliases[0] ?? destination.label
    const ambiguousWithinCountry =
      (labelCounts.get(
        `${destination.countryCode}:${normalizeHhtText(destination.label)}`,
      ) ?? 0) > 1
    const needsGeneratedSeeds = cityGrid.length === 0
    const analysisDestination: HhtDestination = ambiguousWithinCountry
      ? { ...destination, matchAliases: [explicitLabel] }
      : destination
    const seedPatterns = (label: string) =>
      space.patterns.map((pattern) => pattern.template.replaceAll('{locality}', label))
    const seeds = [
      ...new Set(
        ambiguousWithinCountry
          ? seedPatterns(explicitLabel)
          : needsGeneratedSeeds
            ? [...seedPatterns(destination.label), ...seedPatterns(explicitLabel)]
            : cityGrid.map((row) => row.keyword),
      ),
    ].slice(0, 20)
    const cacheFile =
      destination.countryCode === 'US'
        ? `${destination.slug}.json`
        : `${destination.countryCode.toLowerCase()}-${destination.slug}.json`
    const cachePath = join(cacheDir, cacheFile)
    let ideas = refresh ? null : await readIdeasCache(cachePath, seeds)
    let source: CityRun['source'] = ideas ? 'cache' : 'unavailable'
    let error: string | null = null

    if (!ideas && live && !stoppedForQuota) {
      const fetched = await fetchIdeasWithRetry(analysisDestination, seeds)
      ideas = fetched.ideas
      error = fetched.error
      if (error === null) {
        source = 'google_ads'
        liveCalls += 1
        await writeIdeasCache(cachePath, serialiseIdeas(analysisDestination, seeds, ideas))
      } else if (isQuotaError(error)) {
        stoppedForQuota = true
        console.log(`Google Ads quota boundary reached at ${destination.slug}: ${error}`)
      }
      // One KeywordPlanIdeaService request per second per customer ID.
      await sleep(delayMs)
    }

    const merged = mergeHhtKeywords({
      destination: analysisDestination,
      grid: cityGrid.map(gridIdea),
      ideas: ideas ?? [],
    })
    runs.push({
      destination,
      candidates: merged.candidates,
      rejected: merged.rejected,
      ideaCount: ideas?.length ?? 0,
      source,
      error,
    })

    if ((index + 1) % 10 === 0 || index + 1 === destinations.length) {
      const cached = runs.filter((run) => run.source === 'cache').length
      const fetched = runs.filter((run) => run.source === 'google_ads').length
      console.log(
        `Progress ${index + 1}/${destinations.length}: ${fetched} fetched, ${cached} cached, ` +
          `${runs.reduce((sum, run) => sum + run.candidates.length, 0)} eligible keywords`,
      )
    }
  }

  const candidates = runs
    .flatMap((run) => run.candidates)
    .sort(
      (a, b) =>
        (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) ||
        a.city.localeCompare(b.city) ||
        a.keyword.localeCompare(b.keyword),
    )
  const cityRank = new Map<string, number>()
  const keywordRows = candidates.map((row, index) => {
    const rank = (cityRank.get(row.citySlug) ?? 0) + 1
    cityRank.set(row.citySlug, rank)
    return {
      global_rank: index + 1,
      city_rank: rank,
      city: row.city,
      city_slug: row.citySlug,
      country_code: row.countryCode,
      google_ads_geo_target: row.googleAdsGeoTarget,
      keyword: row.keyword,
      avg_monthly_searches: row.avgMonthlySearches,
      intent_tier: row.intentTier,
      intent_cluster: row.clusterKey,
      competition_index: row.competitionIndex,
      low_top_of_page_bid_usd: usdFromMicros(row.lowTopOfPageBidMicros),
      high_top_of_page_bid_usd: usdFromMicros(row.highTopOfPageBidMicros),
      clears_50_volume_floor:
        row.avgMonthlySearches === null ? null : row.avgMonthlySearches >= space.volumeFloor,
      sources: row.sources.join('|'),
      volume_scope: row.volumeScope,
    }
  })

  /** One positive-volume representative per deduplication cluster: the practical check list. */
  const clusterRepresentatives = new Map<string, HhtKeywordCandidate>()
  for (const row of candidates) {
    if ((row.avgMonthlySearches ?? 0) <= 0) continue
    const key = `${row.citySlug}\u0000${row.clusterKey}`
    if (!clusterRepresentatives.has(key)) clusterRepresentatives.set(key, row)
  }
  const clusterCityRank = new Map<string, number>()
  const clusterRows = [...clusterRepresentatives.values()].map((row, index) => {
    const rank = (clusterCityRank.get(row.citySlug) ?? 0) + 1
    clusterCityRank.set(row.citySlug, rank)
    return {
      global_rank: index + 1,
      city_rank: rank,
      city: row.city,
      city_slug: row.citySlug,
      country_code: row.countryCode,
      google_ads_geo_target: row.googleAdsGeoTarget,
      keyword: row.keyword,
      avg_monthly_searches: row.avgMonthlySearches,
      intent_tier: row.intentTier,
      intent_cluster: row.clusterKey,
      competition_index: row.competitionIndex,
      low_top_of_page_bid_usd: usdFromMicros(row.lowTopOfPageBidMicros),
      high_top_of_page_bid_usd: usdFromMicros(row.highTopOfPageBidMicros),
      sources: row.sources.join('|'),
      volume_scope: row.volumeScope,
    }
  })

  const runBySlug = new Map(runs.map((run) => [run.destination.slug, run]))
  const aggregateRows = runs
    .map((run) => ({
      ...aggregateHhtCity(run.destination, run.candidates),
      ideasReturned: run.ideaCount,
      ideaSource: run.source,
      error: run.error,
    }))
    .sort(
      (a, b) =>
        b.conservativeAggregateVolume - a.conservativeAggregateVolume ||
        b.rawAggregateVolume - a.rawAggregateVolume ||
        a.city.localeCompare(b.city),
    )
    .map((row, index) => ({
      city_rank: index + 1,
      city: row.city,
      city_slug: row.citySlug,
      country_code: row.countryCode,
      google_ads_geo_target: row.googleAdsGeoTarget,
      conservative_aggregate_volume: row.conservativeAggregateVolume,
      raw_aggregate_volume: row.rawAggregateVolume,
      close_variant_overlap_delta: row.rawAggregateVolume - row.conservativeAggregateVolume,
      keyword_count: row.keywordCount,
      measured_keyword_count: row.measuredKeywordCount,
      unmeasured_keyword_count: row.unmeasuredKeywordCount,
      intent_cluster_count: row.clusterCount,
      top_keyword: row.topKeyword,
      top_keyword_volume: row.topKeywordVolume,
      ideas_returned: row.ideasReturned,
      idea_source: row.ideaSource,
      error: row.error,
      volume_scope: row.volumeScope,
    }))

  const keywordPath = join(outputDir, 'hotel-hot-tub-keywords.csv')
  const clusterPath = join(outputDir, 'hotel-hot-tub-keyword-clusters.csv')
  const aggregatePath = join(outputDir, 'hotel-hot-tub-city-aggregates.csv')
  const summaryPath = join(outputDir, 'hotel-hot-tub-summary.json')
  await mkdir(outputDir, { recursive: true })
  await writeFile(keywordPath, csv(Object.keys(keywordRows[0] ?? {}), keywordRows), 'utf8')
  await writeFile(clusterPath, csv(Object.keys(clusterRows[0] ?? {}), clusterRows), 'utf8')
  await writeFile(aggregatePath, csv(Object.keys(aggregateRows[0] ?? {}), aggregateRows), 'utf8')

  const rejectedCounts = new Map<string, number>()
  for (const row of runs.flatMap((run) => run.rejected)) {
    rejectedCounts.set(row.reason, (rejectedCounts.get(row.reason) ?? 0) + 1)
  }
  const generatedAt = new Date()
  const summary = {
    generatedAt: generatedAt.toISOString(),
    domain,
    freeOnly: true,
    audienceScope: countries.size > 1
      ? 'country:US+CA'
      : countries.has('US')
        ? 'country:US'
        : 'country:CA',
    googleAdsGeoTarget: countries.size === 1
      ? destinations[0]?.googleAdsGeoTarget ?? null
      : null,
    googleAdsGeoTargets: Object.fromEntries(
      [...countries].sort().map((country) => [
        country,
        country === 'US' ? GOOGLE_ADS_GEO_US : GOOGLE_ADS_GEO_CA,
      ]),
    ),
    destinationsRequested: destinations.length,
    destinationsWithIdeas: runs.filter((run) => run.source !== 'unavailable').length,
    destinationsFetchedLive: liveCalls,
    stoppedForQuota,
    gridSeeds: scopedGridRows.length,
    exactGridVolumesAvailable: exactMeasured,
    eligibleKeywords: candidates.length,
    measuredEligibleKeywords: candidates.filter((row) => row.avgMonthlySearches !== null).length,
    positiveVolumeKeywordClusters: clusterRows.length,
    citiesWithMeasuredKeywords: aggregateRows.filter((row) => row.measured_keyword_count > 0).length,
    ideasReturned: runs.reduce((sum, run) => sum + run.ideaCount, 0),
    rejections: Object.fromEntries([...rejectedCounts.entries()].sort()),
    outputs: { keywordPath, clusterPath, aggregatePath },
    notes: [
      'Raw aggregate volume is a direct sum and can overlap across close variants.',
      'Conservative aggregate volume sums the maximum-volume keyword in each visible intent_cluster.',
      'A null volume is unmeasured, never zero.',
      'Keyword Planner search volume includes Google close variants; it is not an exact-query count.',
      'Each city phrase is measured against its country audience, never a city-bound audience.',
      'No SERP, DataForSEO, Semrush, Maps, or Reddit API was called.',
    ],
  }
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

  if (persist) {
    const saved = await saveHhtRedditAnalysis(database, {
      siteId: site.id,
      summary: {
        generatedAt,
        audienceScope: summary.audienceScope,
        googleAdsGeoTarget: summary.googleAdsGeoTarget,
        freeOnly: summary.freeOnly,
        destinationCount: summary.destinationsRequested,
        ideasReturned: summary.ideasReturned,
        eligibleKeywordCount: summary.eligibleKeywords,
        measuredKeywordCount: summary.measuredEligibleKeywords,
        positiveClusterCount: summary.positiveVolumeKeywordClusters,
        measuredCityCount: summary.citiesWithMeasuredKeywords,
        rejections: summary.rejections,
      },
      cities: aggregateRows.map((row) => ({
        cityRank: row.city_rank,
        city: row.city,
        citySlug: row.city_slug,
        countryCode: row.country_code,
        googleAdsGeoTarget: row.google_ads_geo_target,
        volumeScope: row.volume_scope,
        conservativeAggregateVolume: row.conservative_aggregate_volume,
        rawAggregateVolume: row.raw_aggregate_volume,
        closeVariantOverlapDelta: row.close_variant_overlap_delta,
        keywordCount: row.keyword_count,
        measuredKeywordCount: row.measured_keyword_count,
        unmeasuredKeywordCount: row.unmeasured_keyword_count,
        intentClusterCount: row.intent_cluster_count,
        topKeyword: row.top_keyword,
        topKeywordVolume: row.top_keyword_volume,
        ideasReturned: row.ideas_returned,
        ideaSource: row.idea_source,
        error: row.error,
      })),
      keywords: candidates.map((row, index) => ({
        globalRank: index + 1,
        cityRank: Number(keywordRows[index]?.city_rank ?? 0),
        city: row.city,
        citySlug: row.citySlug,
        countryCode: row.countryCode,
        googleAdsGeoTarget: row.googleAdsGeoTarget,
        keyword: row.keyword,
        keywordNorm: row.keywordNorm,
        avgMonthlySearches: row.avgMonthlySearches,
        intentTier: row.intentTier,
        intentCluster: row.clusterKey,
        competitionIndex: row.competitionIndex,
        lowTopOfPageBidMicros: row.lowTopOfPageBidMicros,
        highTopOfPageBidMicros: row.highTopOfPageBidMicros,
        clearsVolumeFloor:
          row.avgMonthlySearches === null ? null : row.avgMonthlySearches >= space.volumeFloor,
        sources: row.sources,
        volumeScope: row.volumeScope,
      })),
    })
    console.log(
      `Persisted Reddit UI snapshot #${saved.runId}${saved.reused ? ' (unchanged)' : ''}.`,
    )
  }

  const leadingCity = aggregateRows[0]
  console.log(`\nDone: ${candidates.length} eligible keywords across ${aggregateRows.length} cities.`)
  console.log(
    `Measured ${summary.measuredEligibleKeywords}; ideas returned ${summary.ideasReturned}; ` +
      `provider cost $0.`,
  )
  if (leadingCity) {
    console.log(
      `Top city: ${leadingCity.city} — conservative ${leadingCity.conservative_aggregate_volume}, ` +
        `raw ${leadingCity.raw_aggregate_volume}.`,
    )
  }
  console.log(keywordPath)
  console.log(clusterPath)
  console.log(aggregatePath)
  console.log(summaryPath)

  // Keep this reference honest: every aggregate row must correspond to a completed city run.
  if (aggregateRows.some((row) => !runBySlug.has(String(row.city_slug)))) {
    throw new Error('Aggregate contained a city not present in the discovery run')
  }
}

try {
  await main()
} finally {
  await closeDb()
}
