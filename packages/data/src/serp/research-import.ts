import 'server-only'
import { eq, sql } from 'drizzle-orm'
// sql used for locality name match
import { parseGoogleAdsSavedKeywordsStats, parseHomeServiceGeographiesCsv } from '@rnr/core'
import type { Database } from '../db.js'
import {
  localities,
  researchGeoImports,
  researchGeos,
  researchKeywordImports,
  researchKeywords,
} from '../schema.js'
import { softMatchNicheId } from './run-discovery.js'

export interface ResearchImportResult {
  importId: number
  inserted: number
  updated: number
  deactivated: number
  skipped: Array<{ line: number; reason: string }>
  rowCount: number
}

/**
 * Import Google Ads Saved Keywords Stats without creating any spend jobs.
 */
export async function importResearchKeywords(
  db: Database,
  args: { filename: string; text: string | Buffer },
): Promise<ResearchImportResult> {
  const parsed = parseGoogleAdsSavedKeywordsStats(args.text)

  const [imp] = await db
    .insert(researchKeywordImports)
    .values({
      sourceFilename: args.filename,
      sourceKind: 'google_ads_saved_keywords',
      rowCount: parsed.rows.length,
      skippedCount: parsed.skipped.length,
      dateRangeRaw: parsed.dateRangeRaw,
    })
    .returning()

  const importId = imp!.id
  let inserted = 0
  let updated = 0
  const normsInFile = new Set<string>()

  for (const row of parsed.rows) {
    normsInFile.add(row.keywordNorm)
    const nicheId = await softMatchNicheId(db, {
      label: row.seedKey,
      keywordPrimary: row.seedKey,
    })

    const existing = await db
      .select({ id: researchKeywords.id })
      .from(researchKeywords)
      .where(eq(researchKeywords.keywordNorm, row.keywordNorm))
      .limit(1)

    if (existing.length === 0) {
      await db.insert(researchKeywords).values({
        importId,
        keyword: row.keyword,
        keywordNorm: row.keywordNorm,
        seedKey: row.seedKey,
        variant: row.variant,
        avgMonthlySearches: row.avgMonthlySearches,
        competition: row.competition,
        competitionIndex: row.competitionIndex,
        topOfPageBidLowMicros: row.topOfPageBidLowMicros,
        topOfPageBidHighMicros: row.topOfPageBidHighMicros,
        topOfPageBidRaw: row.topOfPageBidRaw,
        inAccount: row.inAccount,
        monthlySeries: row.monthlySeries,
        nicheId,
        active: true,
        lineNumber: row.lineNumber,
      })
      inserted += 1
    } else {
      await db
        .update(researchKeywords)
        .set({
          importId,
          keyword: row.keyword,
          seedKey: row.seedKey,
          variant: row.variant,
          avgMonthlySearches: row.avgMonthlySearches,
          competition: row.competition,
          competitionIndex: row.competitionIndex,
          topOfPageBidLowMicros: row.topOfPageBidLowMicros,
          topOfPageBidHighMicros: row.topOfPageBidHighMicros,
          topOfPageBidRaw: row.topOfPageBidRaw,
          inAccount: row.inAccount,
          monthlySeries: row.monthlySeries,
          nicheId,
          active: true,
          lineNumber: row.lineNumber,
          updatedAt: new Date(),
        })
        .where(eq(researchKeywords.keywordNorm, row.keywordNorm))
      updated += 1
    }
  }

  // Deactivate keywords not present in this file (preserve FKs; no hard-delete).
  let deactivated = 0
  const allActive = await db
    .select({ id: researchKeywords.id, keywordNorm: researchKeywords.keywordNorm })
    .from(researchKeywords)
    .where(eq(researchKeywords.active, true))
  for (const r of allActive) {
    if (!normsInFile.has(r.keywordNorm)) {
      await db
        .update(researchKeywords)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(researchKeywords.id, r.id))
      deactivated += 1
    }
  }

  return {
    importId,
    inserted,
    updated,
    deactivated,
    skipped: parsed.skipped.map((s) => ({ line: s.line, reason: s.reason })),
    rowCount: parsed.rows.length,
  }
}

/**
 * Import home-service geos with pre-resolved DataForSEO codes. No spend.
 */
export async function importResearchGeos(
  db: Database,
  args: { filename: string; text: string },
): Promise<ResearchImportResult> {
  const parsed = parseHomeServiceGeographiesCsv(args.text)

  const [imp] = await db
    .insert(researchGeoImports)
    .values({
      sourceFilename: args.filename,
      sourceKind: 'home_service_geographies',
      rowCount: parsed.rows.length,
      skippedCount: parsed.skipped.length,
    })
    .returning()
  const importId = imp!.id

  let inserted = 0
  let updated = 0
  const touchedIds: number[] = []

  for (const row of parsed.rows) {
    let localityId: number | null = null
    if (row.dataforseoLocationCode !== null) {
      const [byCode] = await db
        .select({ id: localities.id })
        .from(localities)
        .where(eq(localities.providerLocationCode, row.dataforseoLocationCode))
        .limit(1)
      localityId = byCode?.id ?? null
    }
    if (localityId === null && row.stateAbbr) {
      const [byName] = await db
        .select({ id: localities.id })
        .from(localities)
        .where(
          sql`lower(${localities.name}) = ${row.market.toLowerCase()} AND ${localities.stateCode} = ${row.stateAbbr.toUpperCase()}`,
        )
        .limit(1)
      localityId = byName?.id ?? null
    }

    const resolveStatus =
      row.dataforseoLocationCode !== null
        ? ('resolved' as const)
        : localityId !== null
          ? ('resolved' as const)
          : ('unresolved' as const)
    const locationSource =
      row.dataforseoLocationCode !== null ? 'csv_preresolved' : localityId !== null ? 'dataforseo' : null

    // Upsert by code when present
    if (row.dataforseoLocationCode !== null) {
      const [ex] = await db
        .select({ id: researchGeos.id })
        .from(researchGeos)
        .where(eq(researchGeos.dataforseoLocationCode, row.dataforseoLocationCode))
        .limit(1)
      if (!ex) {
        const [created] = await db
          .insert(researchGeos)
          .values({
            importId,
            market: row.market,
            state: row.state,
            stateAbbr: row.stateAbbr,
            population2025: row.population2025,
            selectedRank: row.selectedRank,
            testTier: row.testTier,
            dataforseoLocationCode: row.dataforseoLocationCode,
            dataforseoLocationName: row.dataforseoLocationName,
            dataforseoLocationType: row.dataforseoLocationType,
            naturalQueryModifier: row.naturalQueryModifier,
            disambiguatedQueryModifier: row.disambiguatedQueryModifier,
            recommendedExplicitModifier: row.recommendedExplicitModifier,
            extra: row.extra,
            localityId,
            locationSource,
            resolveStatus,
            active: true,
            lineNumber: row.lineNumber,
          })
          .returning({ id: researchGeos.id })
        touchedIds.push(created!.id)
        inserted += 1
      } else {
        await db
          .update(researchGeos)
          .set({
            importId,
            market: row.market,
            state: row.state,
            stateAbbr: row.stateAbbr,
            population2025: row.population2025,
            selectedRank: row.selectedRank,
            testTier: row.testTier,
            dataforseoLocationName: row.dataforseoLocationName,
            dataforseoLocationType: row.dataforseoLocationType,
            naturalQueryModifier: row.naturalQueryModifier,
            disambiguatedQueryModifier: row.disambiguatedQueryModifier,
            recommendedExplicitModifier: row.recommendedExplicitModifier,
            extra: row.extra,
            localityId,
            locationSource,
            resolveStatus,
            active: true,
            lineNumber: row.lineNumber,
            updatedAt: new Date(),
          })
          .where(eq(researchGeos.id, ex.id))
        touchedIds.push(ex.id)
        updated += 1
      }
    } else {
      const [created] = await db
        .insert(researchGeos)
        .values({
          importId,
          market: row.market,
          state: row.state,
          stateAbbr: row.stateAbbr,
          population2025: row.population2025,
          selectedRank: row.selectedRank,
          testTier: row.testTier,
          dataforseoLocationCode: null,
          dataforseoLocationName: row.dataforseoLocationName,
          dataforseoLocationType: row.dataforseoLocationType,
          naturalQueryModifier: row.naturalQueryModifier,
          disambiguatedQueryModifier: row.disambiguatedQueryModifier,
          recommendedExplicitModifier: row.recommendedExplicitModifier,
          extra: row.extra,
          localityId,
          locationSource,
          resolveStatus,
          unmatchedReason: resolveStatus === 'unresolved' ? 'no_code_no_locality' : null,
          active: true,
          lineNumber: row.lineNumber,
        })
        .returning({ id: researchGeos.id })
      touchedIds.push(created!.id)
      inserted += 1
    }
  }

  // Deactivate geos not touched
  let deactivated = 0
  if (touchedIds.length > 0) {
    const all = await db.select({ id: researchGeos.id }).from(researchGeos).where(eq(researchGeos.active, true))
    const touched = new Set(touchedIds)
    for (const r of all) {
      if (!touched.has(r.id)) {
        await db.update(researchGeos).set({ active: false, updatedAt: new Date() }).where(eq(researchGeos.id, r.id))
        deactivated += 1
      }
    }
  }

  return {
    importId,
    inserted,
    updated,
    deactivated,
    skipped: parsed.skipped.map((s) => ({ line: s.line, reason: s.reason })),
    rowCount: parsed.rows.length,
  }
}

