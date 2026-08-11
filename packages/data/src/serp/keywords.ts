import 'server-only'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { parseKeywordCsv, type KeywordImportResult, type SkippedRow } from '@rnr/core'
import type { Database } from '../db.js'
import { serpChecks, serpKeywords, serpTargets, type SerpKeyword } from '../schema.js'

/** Keyword import and listing for a cell. */

export interface ImportSummary {
  batch: string
  inserted: number
  updated: number
  /** Rows the parser rejected, each with a line number and reason. */
  skipped: SkippedRow[]
  columnsFound: string[]
  columnsIgnored: string[]
  delimiter: string
  total: number
}

/**
 * Import a Semrush CSV for a cell.
 *
 * Upserts on (siteId, keyword) so re-importing a refreshed export updates the context
 * numbers without orphaning the targets already attached to a keyword.
 *
 * Returns a full accounting -- inserted, updated, and every skipped row with its reason.
 * A silent partial import is the failure this is written against: monitoring 40 of 300
 * keywords while believing you cover all of them looks like success.
 */
export async function importKeywordCsv(
  db: Database,
  args: { siteId: number; csv: string; batchLabel?: string },
): Promise<ImportSummary> {
  const parsed: KeywordImportResult = parseKeywordCsv(args.csv)

  // Deterministic-ish batch id. No Date.now() in a pure module, but this is IO-land.
  const batch = args.batchLabel?.trim() || `import-${new Date().toISOString().slice(0, 19)}`

  /**
   * Classify before writing, in one query.
   *
   * An earlier version inferred "inserted" from `createdAt` being within two seconds of
   * now, which is a clock heuristic dressed as a fact -- it misreports under load and on a
   * re-import inside the same window. Reading the existing keywords first is exact.
   */
  const existing = new Set(
    (
      await db
        .select({ keyword: serpKeywords.keyword })
        .from(serpKeywords)
        .where(eq(serpKeywords.siteId, args.siteId))
    ).map((r) => r.keyword.toLowerCase()),
  )

  const inserted = parsed.rows.filter((r) => !existing.has(r.keyword.toLowerCase())).length
  const updated = parsed.rows.length - inserted

  if (parsed.rows.length > 0) {
    // One statement rather than a round trip per keyword -- a 300-row export was 300
    // sequential inserts. `excluded` is the row that would have been inserted.
    await db
      .insert(serpKeywords)
      .values(
        parsed.rows.map((row) => ({
          siteId: args.siteId,
          keyword: row.keyword,
          volume: row.volume,
          difficulty: row.difficulty,
          cpcMicros: row.cpcMicros,
          semrushPosition: row.position,
          semrushUrl: row.url,
          importBatch: batch,
          active: true,
        })),
      )
      .onConflictDoUpdate({
        target: [serpKeywords.siteId, serpKeywords.keyword],
        set: {
          volume: sql`excluded.volume`,
          difficulty: sql`excluded.difficulty`,
          cpcMicros: sql`excluded.cpc_micros`,
          semrushPosition: sql`excluded.semrush_position`,
          semrushUrl: sql`excluded.semrush_url`,
          importBatch: sql`excluded.import_batch`,
        },
      })
  }

  return {
    batch,
    inserted,
    updated,
    skipped: parsed.skipped,
    columnsFound: parsed.columnsFound,
    columnsIgnored: parsed.columnsIgnored,
    delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter,
    total: parsed.rows.length,
  }
}

export interface KeywordRow {
  keyword: SerpKeyword
  targetCount: number
  /** Latest check across this keyword's targets, for an at-a-glance state. */
  lastCheckedAt: Date | null
}

/**
 * Coerce a raw SQL timestamp into a Date.
 *
 * ==================== sql<Date> IS A CLAIM, NOT A CONVERSION ====================
 * A `sql<Date | null>` annotation on a raw subquery is a TYPE ASSERTION -- Drizzle applies no
 * runtime parsing to it, so postgres.js hands back a STRING and the compiler happily lets
 * `.toISOString()` through. It fails at request time with "toISOString is not a function",
 * several layers from the annotation that lied.
 *
 * Same family as the `RETURNING *` snake_case trap documented in queue.ts: raw SQL escapes
 * the mapping layer, so the boundary has to do the work the type pretended was already done.
 * =============================================================================
 */
function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

export async function listKeywordsForSite(db: Database, siteId: number): Promise<KeywordRow[]> {
  const rows = await db
    .select({
      keyword: serpKeywords,
      targetCount: sql<number>`(
        SELECT count(*)::int FROM ${serpTargets}
         WHERE ${serpTargets}.keyword_id = ${serpKeywords}.id AND ${serpTargets}.active
      )`,
      // Typed as unknown deliberately -- see asDate. Claiming Date here is what broke.
      lastCheckedAt: sql<unknown>`(
        SELECT max(${serpChecks}.checked_at) FROM ${serpChecks}
          JOIN ${serpTargets} ON ${serpTargets}.id = ${serpChecks}.target_id
         WHERE ${serpTargets}.keyword_id = ${serpKeywords}.id
      )`,
    })
    .from(serpKeywords)
    .where(and(eq(serpKeywords.siteId, siteId), eq(serpKeywords.active, true)))
    // Highest volume first, and NULLs last -- an unmeasured volume must not sort as the
    // most important keyword, the same rule as difficulty in scan_targets.
    .orderBy(sql`${serpKeywords.volume} DESC NULLS LAST`, asc(serpKeywords.keyword))

  return rows.map((r) => ({ ...r, lastCheckedAt: asDate(r.lastCheckedAt) }))
}

export async function setKeywordActive(
  db: Database,
  keywordId: number,
  active: boolean,
): Promise<void> {
  await db.update(serpKeywords).set({ active }).where(eq(serpKeywords.id, keywordId))
}

/** Remove a whole import batch, for when the wrong file was uploaded. */
export async function deleteKeywordBatch(
  db: Database,
  args: { siteId: number; batch: string },
): Promise<number> {
  const rows = await db
    .delete(serpKeywords)
    .where(and(eq(serpKeywords.siteId, args.siteId), eq(serpKeywords.importBatch, args.batch)))
    .returning({ id: serpKeywords.id })
  return rows.length
}

export async function listImportBatches(db: Database, siteId: number) {
  return db
    .select({
      batch: serpKeywords.importBatch,
      keywords: sql<number>`count(*)::int`,
      // Same reason as above: raw SQL bypasses Drizzle's date mapping.
      importedAt: sql<unknown>`max(${serpKeywords.createdAt})`,
    })
    .from(serpKeywords)
    .where(eq(serpKeywords.siteId, siteId))
    .groupBy(serpKeywords.importBatch)
    .orderBy(desc(sql`max(${serpKeywords.createdAt})`))
    .then((rows) => rows.map((r) => ({ ...r, importedAt: asDate(r.importedAt) })))
}
