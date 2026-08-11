import 'server-only'
import { desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db.js'
import {
  discoveryGeos,
  discoveryNiches,
  discoveryRuns,
  localities,
  niches,
  scanRuns,
} from '../schema.js'

/**
 * Unified research history for the single /research wizard page.
 * No new tables — presentation join over scan_runs + discovery_runs.
 */

export type ResearchHistoryKind = 'locality_scan' | 'cell_serp' | 'catalog_cell'

export interface ResearchHistoryRow {
  id: string
  kind: ResearchHistoryKind
  kindLabel: string
  place: string
  subject: string
  status: string
  jobsDone: number
  jobCount: number
  jobsFailed: number
  hitCount: number
  usedFixtures: boolean
  error: string | null
  createdAt: Date
  /** Locality scan detail */
  scanRunId: number | null
  /** Discovery run */
  discoveryRunId: number | null
  localitySlug: string | null
  nicheSlug: string | null
  label: string | null
}

/** Resolve locality + niche by id for the research wizard enqueue path. */
export async function resolveLocalityAndNiche(
  db: Database,
  args: { localityId: number; nicheId: number },
): Promise<{
  localityId: number
  nicheId: number
  localitySlug: string
  nicheSlug: string
  placeLabel: string
  nicheLabel: string
} | null> {
  const [loc] = await db
    .select({
      id: localities.id,
      slug: localities.slug,
      name: localities.name,
      stateCode: localities.stateCode,
    })
    .from(localities)
    .where(eq(localities.id, args.localityId))
    .limit(1)
  const [niche] = await db
    .select({
      id: niches.id,
      slug: niches.slug,
      label: niches.label,
    })
    .from(niches)
    .where(eq(niches.id, args.nicheId))
    .limit(1)
  if (!loc || !niche) return null
  return {
    localityId: loc.id,
    nicheId: niche.id,
    localitySlug: loc.slug,
    nicheSlug: niche.slug,
    placeLabel: `${loc.name}, ${loc.stateCode}`,
    nicheLabel: niche.label,
  }
}

export async function listResearchHistory(
  db: Database,
  opts?: { limit?: number },
): Promise<ResearchHistoryRow[]> {
  const limit = opts?.limit ?? 40

  const scans = await db
    .select({
      run: scanRuns,
      localityName: localities.name,
      stateCode: localities.stateCode,
      localitySlug: localities.slug,
      scored: sql<number>`(
        SELECT COUNT(*)::int FROM scan_targets st WHERE st.scan_run_id = ${scanRuns.id}
      )`,
    })
    .from(scanRuns)
    .innerJoin(localities, eq(scanRuns.localityId, localities.id))
    .orderBy(desc(scanRuns.createdAt))
    .limit(limit)

  const discoveries = await db
    .select()
    .from(discoveryRuns)
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(limit)

  const rows: ResearchHistoryRow[] = []

  for (const s of scans) {
    rows.push({
      id: `scan-${s.run.id}`,
      kind: 'locality_scan',
      kindLabel: 'Locality scan',
      place: `${s.localityName}, ${s.stateCode}`,
      subject: `${s.scored} niches scored`,
      status: s.run.status,
      jobsDone: s.scored,
      jobCount: s.run.nicheCount ?? s.scored,
      jobsFailed: 0,
      hitCount: 0,
      usedFixtures: s.run.usedFixtures,
      error: s.run.error,
      createdAt: s.run.createdAt,
      scanRunId: s.run.id,
      discoveryRunId: null,
      localitySlug: s.localitySlug,
      nicheSlug: null,
      label: null,
    })
  }

  for (const d of discoveries) {
    const isCatalog = d.source === 'catalog'
    const kind: ResearchHistoryKind = isCatalog ? 'catalog_cell' : 'cell_serp'
    let place = d.label ?? '—'
    let subject = d.label ?? 'Cell research'
    let localitySlug: string | null = null
    let nicheSlug: string | null = null

    // Best-effort: first geo + niche snapshot for this run
    const [geo] = await db
      .select({
        rawName: discoveryGeos.rawName,
        rawState: discoveryGeos.rawState,
        localitySlug: localities.slug,
        localityName: localities.name,
        stateCode: localities.stateCode,
      })
      .from(discoveryGeos)
      .leftJoin(localities, eq(discoveryGeos.localityId, localities.id))
      .where(eq(discoveryGeos.runId, d.id))
      .limit(1)

    const [niche] = await db
      .select({
        label: discoveryNiches.label,
        keywordPrimary: discoveryNiches.keywordPrimary,
        nicheSlug: niches.slug,
      })
      .from(discoveryNiches)
      .leftJoin(niches, eq(discoveryNiches.nicheId, niches.id))
      .where(eq(discoveryNiches.runId, d.id))
      .limit(1)

    if (geo) {
      place =
        geo.localityName && geo.stateCode
          ? `${geo.localityName}, ${geo.stateCode}`
          : [geo.rawName, geo.rawState].filter(Boolean).join(', ') || place
      localitySlug = geo.localitySlug
    }
    if (niche) {
      subject = niche.label || niche.keywordPrimary
      nicheSlug = niche.nicheSlug
    } else if (d.label) {
      // label often "keyword · place"
      subject = d.label
    }

    rows.push({
      id: `disc-${d.id}`,
      kind,
      kindLabel: isCatalog ? 'Catalog cell' : 'Cell SERP',
      place,
      subject,
      status: d.status,
      jobsDone: d.jobsDone,
      jobCount: d.jobCount,
      jobsFailed: d.jobsFailed,
      hitCount: d.hitCount,
      usedFixtures: d.usedFixtures,
      error: d.error,
      createdAt: d.createdAt,
      scanRunId: null,
      discoveryRunId: d.id,
      localitySlug,
      nicheSlug,
      label: d.label,
    })
  }

  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return rows.slice(0, limit)
}
