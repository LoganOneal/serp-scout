import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  hhtRedditCityAggregates,
  hhtRedditKeywordRuns,
  hhtRedditKeywords,
  sites,
} from '../schema.js'
import { resolveHhtKeywordPage } from './pagination.js'

type CityInsert = Omit<typeof hhtRedditCityAggregates.$inferInsert, 'id' | 'runId'>
type KeywordInsert = Omit<typeof hhtRedditKeywords.$inferInsert, 'id' | 'runId'>

export interface HhtRedditAnalysisSummary {
  generatedAt: Date
  audienceScope: string
  googleAdsGeoTarget: number
  freeOnly: boolean
  destinationCount: number
  ideasReturned: number
  eligibleKeywordCount: number
  measuredKeywordCount: number
  positiveClusterCount: number
  measuredCityCount: number
  rejections: Record<string, number>
}

export interface HhtRedditAnalysisSnapshot {
  siteId: number
  summary: HhtRedditAnalysisSummary
  cities: CityInsert[]
  keywords: KeywordInsert[]
}

function snapshotHash(snapshot: HhtRedditAnalysisSnapshot): string {
  const { generatedAt: _generatedAt, ...stableSummary } = snapshot.summary
  const payload = JSON.stringify(
    { summary: stableSummary, cities: snapshot.cities, keywords: snapshot.keywords },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  )
  return createHash('sha256').update(payload).digest('hex')
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < rows.length; index += size) {
    output.push(rows.slice(index, index + size))
  }
  return output
}

/** Save one immutable snapshot. An identical rerun reuses its content hash. */
export async function saveHhtRedditAnalysis(
  database: Database,
  snapshot: HhtRedditAnalysisSnapshot,
): Promise<{ runId: number; reused: boolean; sourceHash: string }> {
  const sourceHash = snapshotHash(snapshot)
  return database.transaction(async (transaction) => {
    const [inserted] = await transaction
      .insert(hhtRedditKeywordRuns)
      .values({
        siteId: snapshot.siteId,
        sourceHash,
        ...snapshot.summary,
      })
      .onConflictDoNothing({
        target: [hhtRedditKeywordRuns.siteId, hhtRedditKeywordRuns.sourceHash],
      })
      .returning({ id: hhtRedditKeywordRuns.id })

    if (!inserted) {
      const [existing] = await transaction
        .select({ id: hhtRedditKeywordRuns.id })
        .from(hhtRedditKeywordRuns)
        .where(
          and(
            eq(hhtRedditKeywordRuns.siteId, snapshot.siteId),
            eq(hhtRedditKeywordRuns.sourceHash, sourceHash),
          ),
        )
        .limit(1)
      if (!existing) throw new Error('Keyword snapshot conflicted but could not be reloaded')
      return { runId: existing.id, reused: true, sourceHash }
    }

    await transaction
      .insert(hhtRedditCityAggregates)
      .values(snapshot.cities.map((row) => ({ ...row, runId: inserted.id })))
    // Stay well below Postgres's parameter limit with the wide keyword row.
    for (const batch of chunks(snapshot.keywords, 500)) {
      await transaction
        .insert(hhtRedditKeywords)
        .values(batch.map((row) => ({ ...row, runId: inserted.id })))
    }

    return { runId: inserted.id, reused: false, sourceHash }
  })
}

export async function getHhtRedditDashboard(
  database: Database,
  siteDomain = 'hotelhottubs.com',
  requestedCitySlug?: string,
  requestedPage?: number,
) {
  const [site] = await database
    .select({ id: sites.id, domain: sites.domain, displayName: sites.displayName })
    .from(sites)
    .where(eq(sites.domain, siteDomain))
    .limit(1)
  if (!site) throw new Error(`No site record exists for ${siteDomain}`)

  const [run] = await database
    .select()
    .from(hhtRedditKeywordRuns)
    .where(eq(hhtRedditKeywordRuns.siteId, site.id))
    .orderBy(desc(hhtRedditKeywordRuns.generatedAt))
    .limit(1)
  if (!run) {
    return {
      site,
      run: null,
      cities: [],
      selectedCity: null,
      keywordScope: 'all' as const,
      keywordPagination: resolveHhtKeywordPage(1, 0),
      keywords: [],
    }
  }

  const cities = await database
    .select()
    .from(hhtRedditCityAggregates)
    .where(eq(hhtRedditCityAggregates.runId, run.id))
    .orderBy(asc(hhtRedditCityAggregates.cityRank))

  const showAllCities = !requestedCitySlug || requestedCitySlug === 'all'
  const selectedCity = showAllCities
    ? null
    : (cities.find((city) => city.citySlug === requestedCitySlug) ?? cities[0] ?? null)
  const keywordPagination = resolveHhtKeywordPage(
    showAllCities ? requestedPage : 1,
    showAllCities ? run.eligibleKeywordCount : (selectedCity?.keywordCount ?? 0),
  )
  const keywords = showAllCities
    ? await database
        .select()
        .from(hhtRedditKeywords)
        .where(eq(hhtRedditKeywords.runId, run.id))
        .orderBy(asc(hhtRedditKeywords.globalRank))
        .limit(keywordPagination.pageSize)
        .offset(keywordPagination.offset)
    : selectedCity
      ? await database
          .select()
          .from(hhtRedditKeywords)
          .where(
            and(
              eq(hhtRedditKeywords.runId, run.id),
              eq(hhtRedditKeywords.citySlug, selectedCity.citySlug),
            ),
          )
          .orderBy(asc(hhtRedditKeywords.cityRank))
      : []

  return {
    site,
    run,
    cities,
    selectedCity,
    keywordScope: showAllCities ? ('all' as const) : ('city' as const),
    keywordPagination,
    keywords,
  }
}
