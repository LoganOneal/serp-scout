import 'server-only'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  aggregateCluster,
  inferClusterKind,
  normaliseKeyword,
  type ClusterKind,
  type ClusterMember,
} from '@rnr/core'
import type { Database } from '../db.js'
import { keywordClusters, keywordImportRuns, researchGeos, siteKeywordTargets } from '../schema.js'
import { geoSlugFor } from '../supply/resolve.js'

/**
 * Import Semrush keyword research and its hand-built clusters.
 *
 * ==================== FOUR SHAPES, ONE IMPORTER ====================
 *   magic-*.PARTIAL.csv    keyword,intent,relevance,volume,kd_percent,cpc_usd
 *   keyword-standouts      + cluster, why_it_matters, source_seed
 *   *-architecture.csv     cluster,primary_keyword,volume,primary_url,supporting_urls
 *   the city/state rollups imported as PROVENANCE, never as truth
 *
 * The rollups are deliberately not trusted. Their volume column is the SUMMED
 * one, which is inflated 4.5-11.2x by near-duplicate phrasings and — because the
 * inflation is uneven — reorders cities rather than merely inflating them.
 * Recording what was believed on 2026-08-05 is useful; feeding it back in would
 * import the bug. See @rnr/core aggregateCluster.
 * ===================================================================
 */

// --- CSV ---------------------------------------------------------------------

/**
 * A minimal RFC-4180 reader. No dependency, because @rnr/data should not take
 * one for 40 lines, and the files genuinely need quote handling — several
 * columns contain commas inside quotes (`"SEMrush Keyword Magic, seed ..."`).
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)

  const header = rows.shift()
  if (!header) return []
  return rows.map((r) => {
    const o: Record<string, string> = {}
    header.forEach((h, i) => (o[h.trim()] = (r[i] ?? '').trim()))
    return o
  })
}

const int = (v: string | undefined): number | null => {
  if (!v) return null
  const n = Number(v.replace(/[, ]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

// --- The staged keyword ------------------------------------------------------

interface Staged {
  keyword: string
  keywordNorm: string
  volume: number | null
  kd: number | null
  intent: string | null
  seeds: Set<string>
  clusterLabel: string | null
  notes: string | null
}

export interface ImportResult {
  runId: number | null
  filesRead: string[]
  rowsRead: number
  keywordsUpserted: number
  clustersUpserted: number
  unresolvedEntities: number
  quarantined: number
  notes: string[]
}

export interface ImportArgs {
  siteId: number
  dir: string
  dryRun?: boolean
}

export async function importClusterResearch(
  db: Database,
  args: ImportArgs,
): Promise<ImportResult> {
  const notes: string[] = []
  const files = readdirSync(args.dir).filter((f) => f.toLowerCase().endsWith('.csv')).sort()

  const staged = new Map<string, Staged>()
  let rowsRead = 0

  const stage = (
    keyword: string,
    fields: { volume?: number | null; kd?: number | null; intent?: string | null },
    seed: string,
    clusterLabel?: string | null,
    noteText?: string | null,
  ): void => {
    const norm = normaliseKeyword(keyword)
    if (!norm) return
    const existing = staged.get(norm)
    if (!existing) {
      staged.set(norm, {
        keyword: keyword.trim(),
        keywordNorm: norm,
        volume: fields.volume ?? null,
        kd: fields.kd ?? null,
        intent: fields.intent ?? null,
        seeds: new Set([seed]),
        clusterLabel: clusterLabel ?? null,
        notes: noteText ?? null,
      })
      return
    }
    existing.seeds.add(seed)
    /**
     * MAX on collision, not last-write-wins.
     *
     * 524 of 2,359 keywords appear in more than one seed export, and the exports
     * disagree — a keyword pulled under two seeds can carry two volumes. Taking
     * the larger keeps the number a lower bound in the same direction as every
     * other volume in this system; last-write-wins would make the result depend
     * on filename order, which is not a fact about demand.
     */
    if (fields.volume !== null && fields.volume !== undefined) {
      existing.volume = Math.max(existing.volume ?? 0, fields.volume)
    }
    if (fields.kd !== null && fields.kd !== undefined) {
      existing.kd = existing.kd === null ? fields.kd : Math.min(existing.kd, fields.kd)
    }
    if (!existing.intent && fields.intent) existing.intent = fields.intent
    // An explicit cluster assignment always wins over none.
    if (clusterLabel && !existing.clusterLabel) existing.clusterLabel = clusterLabel
    if (noteText && !existing.notes) existing.notes = noteText
  }

  const clusterUrls = new Map<string, { primary: string | null; supporting: string[] }>()

  for (const file of files) {
    const text = readFileSync(join(args.dir, file), 'utf8')
    const rows = parseCsv(text)
    const cols = new Set(Object.keys(rows[0] ?? {}))
    const name = basename(file)

    // --- Keyword Magic exports -----------------------------------------------
    if (cols.has('keyword') && cols.has('kd_percent')) {
      const seed = name.replace(/^magic-/, '').replace(/\.PARTIAL\.csv$/i, '').replace(/\.csv$/i, '')
      for (const r of rows) {
        rowsRead += 1
        stage(r['keyword']!, { volume: int(r['volume']), kd: int(r['kd_percent']), intent: r['intent'] || null }, seed)
      }
      continue
    }

    // --- Standouts: the authoritative cluster assignment ----------------------
    if (cols.has('keyword') && cols.has('cluster')) {
      for (const r of rows) {
        rowsRead += 1
        stage(
          r['keyword']!,
          { volume: int(r['volume']), kd: int(r['kd']), intent: r['intent'] || null },
          r['source_seed'] || 'standouts',
          r['cluster'] || null,
          r['why_it_matters'] || null,
        )
      }
      continue
    }

    // --- Architecture: cluster -> page ---------------------------------------
    if (cols.has('cluster') && cols.has('primary_url')) {
      for (const r of rows) {
        rowsRead += 1
        const label = (r['cluster'] || '').trim()
        if (!label) continue
        if (r['primary_keyword']) {
          stage(r['primary_keyword'], { volume: int(r['volume']) }, 'architecture', label, r['notes'] || null)
        }
        const existing = clusterUrls.get(label)
        const supporting = (r['supporting_urls'] || '')
          .split(/[;|]/)
          .map((u) => u.trim())
          .filter(Boolean)
        clusterUrls.set(label, {
          primary: existing?.primary ?? (r['primary_url'] || null),
          supporting: [...new Set([...(existing?.supporting ?? []), ...supporting])],
        })
      }
      continue
    }

    // --- Plain keyword lists (unmatched) -------------------------------------
    if (cols.has('keyword') && (cols.has('volume_per_mo') || cols.has('volume'))) {
      for (const r of rows) {
        rowsRead += 1
        stage(
          r['keyword']!,
          { volume: int(r['volume_per_mo'] ?? r['volume']), kd: int(r['kd']) },
          name.replace(/\.csv$/i, ''),
        )
      }
      continue
    }

    /**
     * Everything else is a rollup. Counted and named, never ingested — see the
     * banner: their volume column is the inflated sum.
     */
    notes.push(`${name}: rollup, recorded as provenance only (${rows.length} rows, not ingested)`)
  }

  notes.push(
    `${rowsRead} row(s) read → ${staged.size} distinct keyword(s). ` +
      `${rowsRead - staged.size} duplicate(s) collapsed, keeping the larger volume.`,
  )

  // --- Resolve locality clusters to the grid's entity slugs -------------------
  const geos = await db
    .select({ market: researchGeos.market, stateAbbr: researchGeos.stateAbbr })
    .from(researchGeos)
    .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))

  const byName = new Map<string, string[]>()
  for (const g of geos) {
    const key = g.market.trim().toLowerCase()
    const list = byName.get(key) ?? []
    list.push(geoSlugFor(g.market, g.stateAbbr))
    byName.set(key, list)
  }

  const labels = new Set(
    [...staged.values()].map((s) => s.clusterLabel).filter((l): l is string => Boolean(l)),
  )
  for (const l of clusterUrls.keys()) labels.add(l)

  /**
 * Colloquial city names the research uses and the Census-derived corpus does not.
 *
 * Extended DELIBERATELY, one entry at a time, never by fuzzy matching: "nyc" is
 * unambiguously New York City, but a matcher loose enough to find it would also
 * bind "north jersey" to something, and a wrong market silently attributes a
 * cluster's demand to the wrong supply.
 */
const CITY_ALIASES: Readonly<Record<string, string>> = {
  nyc: 'new york city',
  'new york': 'new york city',
  la: 'los angeles',
  sf: 'san francisco',
  dc: 'washington',
  vegas: 'las vegas',
}

interface PlannedCluster {
    slug: string
    kind: ClusterKind
    label: string
    entitySlug: string | null
    unresolvedReason: string | null
  }

  const planned = new Map<string, PlannedCluster>()
  let unresolved = 0
  const unresolvedExamples: string[] = []

  for (const label of labels) {
    const kind = inferClusterKind(label)
    let entitySlug: string | null = null
    let reason: string | null = null

    if (kind === 'locality') {
      const prefix = /^(city|state|region)_/.exec(label)?.[1] ?? 'city'
      const raw = label.replace(/^(city|state|region)_/, '').replace(/_/g, ' ').trim()
      const name = CITY_ALIASES[raw] ?? raw

      if (prefix !== 'city') {
        /**
         * `research_geos` is a CITY-level corpus, so a state or multi-city
         * region has no single market to bind to. Reporting that specifically
         * matters: the generic "not in research_geos" reads as a gap in the
         * corpus and sends somebody looking for a row that should not exist.
         */
        reason =
          `"${raw}" is a ${prefix}, and research_geos is a city-level corpus — there is no single ` +
          `market to bind it to. The cluster is real and simply gates on nothing.`
      } else {
        const hits = byName.get(name) ?? []
        if (hits.length === 1) entitySlug = hits[0]!
        else if (hits.length > 1) {
          reason = `"${name}" matches ${hits.length} markets (${hits.slice(0, 3).join(', ')}). Ambiguous, so not bound.`
        } else {
          reason = `"${name}" is not in research_geos. UNKNOWN coverage, not zero — the cluster still exists, it just gates on nothing.`
        }
      }

      if (!entitySlug) {
        unresolved += 1
        if (unresolvedExamples.length < 6) unresolvedExamples.push(`${label}: ${reason}`)
      }
    }

    planned.set(label, { slug: label, kind, label, entitySlug, unresolvedReason: reason })
  }

  const quarantined = [...planned.values()].filter((c) => c.kind === 'quarantine').length
  if (quarantined > 0) {
    notes.push(
      `${quarantined} cluster(s) quarantined (e.g. data_anomaly). They are stored but excluded ` +
        `from every board — a flag on bad data is not a page.`,
    )
  }
  if (unresolved > 0) {
    notes.push(
      `${unresolved} locality cluster(s) did NOT resolve to a market slug. They keep their ` +
        `keywords and simply gate on nothing — unresolved is UNKNOWN, never zero.`,
    )
    for (const e of unresolvedExamples) notes.push(`  · ${e}`)
  }

  const result: ImportResult = {
    runId: null,
    filesRead: files,
    rowsRead,
    keywordsUpserted: 0,
    clustersUpserted: 0,
    unresolvedEntities: unresolved,
    quarantined,
    notes,
  }

  if (args.dryRun) {
    notes.push('DRY RUN — nothing was written.')
    result.keywordsUpserted = staged.size
    result.clustersUpserted = planned.size
    return result
  }

  const [run] = await db
    .insert(keywordImportRuns)
    .values({ siteId: args.siteId, sourceDir: args.dir, files })
    .returning({ id: keywordImportRuns.id })
  result.runId = run?.id ?? null

  // --- Clusters first, so keywords can point at them -------------------------
  const clusterIdBySlug = new Map<string, number>()
  const clusterRows = [...planned.values()]
  for (const batch of chunk(clusterRows, 200)) {
    const written = await db
      .insert(keywordClusters)
      .values(
        batch.map((c) => ({
          siteId: args.siteId,
          slug: c.slug,
          kind: c.kind,
          label: c.label,
          entityKind: c.entitySlug ? 'locality' : null,
          entitySlug: c.entitySlug,
          unresolvedReason: c.unresolvedReason,
          primaryUrl: clusterUrls.get(c.label)?.primary ?? null,
          supportingUrls: clusterUrls.get(c.label)?.supporting ?? null,
          source: 'semrush-import',
        })),
      )
      .onConflictDoUpdate({
        target: [keywordClusters.siteId, keywordClusters.slug],
        set: {
          kind: sqlExcluded('kind'),
          label: sqlExcluded('label'),
          entityKind: sqlExcluded('entity_kind'),
          entitySlug: sqlExcluded('entity_slug'),
          unresolvedReason: sqlExcluded('unresolved_reason'),
          primaryUrl: sqlExcluded('primary_url'),
          supportingUrls: sqlExcluded('supporting_urls'),
          updatedAt: new Date(),
        },
      })
      .returning({ id: keywordClusters.id, slug: keywordClusters.slug })
    for (const w of written) clusterIdBySlug.set(w.slug, w.id)
  }
  result.clustersUpserted = clusterIdBySlug.size

  // --- Keywords --------------------------------------------------------------
  const now = new Date()
  const rows = [...staged.values()].map((s) => ({
    siteId: args.siteId,
    keyword: s.keyword,
    keywordNorm: s.keywordNorm,
    clusterId: s.clusterLabel ? (clusterIdBySlug.get(s.clusterLabel) ?? null) : null,
    semrushVolume: s.volume,
    semrushKd: s.kd,
    intent: s.intent,
    seeds: [...s.seeds],
    seedKey: 'semrush-import',
    sources: ['semrush_import'],
    updatedAt: now,
  }))

  for (const batch of chunk(rows, 500)) {
    await db
      .insert(siteKeywordTargets)
      .values(batch)
      .onConflictDoUpdate({
        target: [siteKeywordTargets.siteId, siteKeywordTargets.keywordNorm],
        /**
         * Only vendor columns and the cluster link are written.
         *
         * `volume`, `position` and `difficulty` are OURS — measured by the free
         * passes at a known scope — and an import must never overwrite a
         * measurement with a vendor's number. That is the whole reason
         * semrush_volume and semrush_kd are separate columns.
         */
        set: {
          clusterId: sqlExcluded('cluster_id'),
          semrushVolume: sqlExcluded('semrush_volume'),
          semrushKd: sqlExcluded('semrush_kd'),
          intent: sqlExcluded('intent'),
          seeds: sqlExcluded('seeds'),
          updatedAt: now,
        },
      })
  }
  result.keywordsUpserted = rows.length

  await refreshClusterAggregates(db, args.siteId)

  await db
    .update(keywordImportRuns)
    .set({
      rowsRead: result.rowsRead,
      keywordsUpserted: result.keywordsUpserted,
      clustersUpserted: result.clustersUpserted,
      unresolvedEntities: result.unresolvedEntities,
      quarantined: result.quarantined,
      notes: result.notes,
      finishedAt: new Date(),
    })
    .where(eq(keywordImportRuns.id, result.runId!))

  return result
}

/**
 * Recompute every cluster's aggregates from its members.
 *
 * The aggregation itself lives in @rnr/core so the max/sum bound is stated once
 * and testable without a database.
 */
export async function refreshClusterAggregates(db: Database, siteId: number): Promise<number> {
  const clusters = await db
    .select({ id: keywordClusters.id })
    .from(keywordClusters)
    .where(eq(keywordClusters.siteId, siteId))

  if (clusters.length === 0) return 0

  const members = await db
    .select({
      clusterId: siteKeywordTargets.clusterId,
      keywordNorm: siteKeywordTargets.keywordNorm,
      semrushVolume: siteKeywordTargets.semrushVolume,
      volume: siteKeywordTargets.volume,
      semrushKd: siteKeywordTargets.semrushKd,
      position: siteKeywordTargets.position,
      positionMeasuredAt: siteKeywordTargets.positionMeasuredAt,
    })
    .from(siteKeywordTargets)
    .where(
      and(
        eq(siteKeywordTargets.siteId, siteId),
        inArray(
          siteKeywordTargets.clusterId,
          clusters.map((c) => c.id),
        ),
      ),
    )

  const byCluster = new Map<number, ClusterMember[]>()
  for (const m of members) {
    if (m.clusterId === null) continue
    const list = byCluster.get(m.clusterId) ?? []
    list.push({
      keywordNorm: m.keywordNorm,
      /**
       * OUR measurement first, the vendor's as fallback. A free Google Ads
       * volume measured at a known scope beats an imported snapshot, and the
       * fallback is what makes the cluster board useful before that pass runs.
       */
      volume: m.volume ?? m.semrushVolume,
      semrushKd: m.semrushKd,
      position: m.position,
      positionMeasured: m.positionMeasuredAt !== null,
    })
    byCluster.set(m.clusterId, list)
  }

  const now = new Date()
  let updated = 0
  for (const c of clusters) {
    const a = aggregateCluster(byCluster.get(c.id) ?? [])
    await db
      .update(keywordClusters)
      .set({
        memberCount: a.memberCount,
        volumeMax: a.volume.max,
        volumeSum: a.volume.sum,
        kdMin: a.kdMin,
        kdMedian: a.kdMedian === null ? null : Math.round(a.kdMedian),
        bestPosition: a.bestPosition,
        positionMeasured: a.positionMeasured,
        primaryKeywordNorm: a.primaryKeywordNorm,
        updatedAt: now,
      })
      .where(eq(keywordClusters.id, c.id))
    updated += 1
  }
  return updated
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * `excluded.<col>` — what a multi-row upsert needs in its SET clause.
 *
 * A literal value could only carry one row's data, so a batched upsert has to
 * name the column Postgres is holding for the row it tried to insert.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`)
}
