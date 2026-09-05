import { readFileSync } from 'node:fs'
import type { Database } from '../db.js'
import { createSemrushClient, semrushApiKey, SemrushUnavailable } from './semrush/client.js'
import { normalizeRows } from './semrush/normalize.js'
import { upsertKeyword } from './store.js'
import type { KeywordOverview } from './semrush/client.js'
import { parseIntent } from './semrush/normalize.js'
import { numOrNull } from './semrush/normalize.js'

/**
 * Persist an MCP execute_report payload (or classic CSV) as first-class
 * keyword evidence. Used when the Cursor Semrush MCP ran a report and we
 * want the miner DB to keep it without a SEMRUSH_API_KEY HTTP call.
 */
export async function ingestSemrushHarvest(
  db: Database,
  args: { report: string; phrase?: string; country?: string; payload: unknown },
): Promise<{ rows: number; created: number }> {
  const rows = normalizeRows(args.payload)
  let created = 0
  if (semrushApiKey()) {
    const client = createSemrushClient(db, process.env, false)
    try {
      await client.ingestHarvest(args.report, { phrase: args.phrase, database: args.country ?? 'us' }, rows)
    } catch (e) {
      if (!(e instanceof SemrushUnavailable)) throw e
    }
  }
  for (const row of rows) {
    const keyword = String(row['keyword'] ?? args.phrase ?? '')
    if (!keyword) continue
    const metrics: KeywordOverview = {
      keyword,
      volume: numOrNull(row['volume']),
      cpc: numOrNull(row['cpc']),
      competition: numOrNull(row['competitive_density'] ?? row['competition']),
      keywordDifficulty: numOrNull(row['keyword_difficulty']),
      intent: parseIntent(row['intent']),
      results: numOrNull(row['results']),
      trend: row['trend'] == null ? null : String(row['trend']),
    }
    const r = await upsertKeyword(db, {
      keyword,
      country: args.country ?? 'us',
      sourceType: args.phrase ? 'related' : 'manual',
      sourceId: args.report,
      metrics: { ...metrics, metricsSource: 'semrush' },
    })
    if (r.created) created += 1
  }
  return { rows: rows.length, created }
}

export async function ingestSemrushHarvestFile(db: Database, path: string): Promise<{ rows: number; created: number }> {
  const raw = readFileSync(path, 'utf8')
  const parsed = raw.trim().startsWith('{') || raw.trim().startsWith('[') ? JSON.parse(raw) : raw
  const report = typeof parsed === 'object' && parsed && 'report' in parsed ? String(parsed.report) : 'phrase_related'
  const phrase = typeof parsed === 'object' && parsed && 'phrase' in parsed ? String(parsed.phrase) : undefined
  const payload = typeof parsed === 'object' && parsed && 'payload' in parsed ? parsed.payload : parsed
  return ingestSemrushHarvest(db, { report, phrase, payload })
}
