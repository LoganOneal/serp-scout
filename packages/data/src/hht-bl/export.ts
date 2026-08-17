import 'server-only'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stringify } from 'csv-stringify/sync'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtBlRunEvents, hhtBlRuns } from '../schema.js'
import { workspaceRoot } from '../paths.js'
import { getHhtBlDashboard } from './dashboard.js'

export async function exportHhtBlRun(
  db: Database,
  runId: number,
  outputDir = resolve(workspaceRoot(), 'exports', 'hht-bl', `run-${runId}`),
): Promise<string[]> {
  const [sites, backlinks, opportunities, strategies] = await Promise.all([
    getHhtBlDashboard(db, 'hotelhottubs.com', 'sites'),
    getHhtBlDashboard(db, 'hotelhottubs.com', 'backlinks'),
    getHhtBlDashboard(db, 'hotelhottubs.com', 'opportunities'),
    getHhtBlDashboard(db, 'hotelhottubs.com', 'strategies'),
  ])
  if (!sites.run || sites.run.id !== runId) {
    throw new Error(`Run ${runId} is not the latest HotelHotTubs backlink run`)
  }
  await mkdir(outputDir, { recursive: true })
  const files: Array<[string, unknown[]]> = [
    ['candidate_sites.csv', sites.candidateSites],
    ['research_sites.csv', sites.researchSites],
    ['backlinks_normalized.csv', backlinks.backlinks],
    ['opportunities_ranked.csv', opportunities.opportunities],
    ['strategy_clusters.csv', strategies.clusters],
    ['campaign_candidates.csv', strategies.campaigns],
  ]
  const written: string[] = []
  for (const [name, rows] of files) {
    const path = resolve(outputDir, name)
    await writeFile(path, stringify(rows, { header: true }), 'utf8')
    written.push(path)
  }
  const finishedAt = new Date()
  await db
    .update(hhtBlRuns)
    .set({ status: 'COMPLETE', currentStage: 'export', finishedAt, updatedAt: finishedAt })
    .where(eq(hhtBlRuns.id, runId))
  await db.insert(hhtBlRunEvents).values({
    runId,
    stage: 'export',
    message: `Exported ${written.length} pilot datasets`,
    recordsProcessed: files.reduce((sum, [, rows]) => sum + rows.length, 0),
    details: { files: written },
  })
  return written
}
