/**
 * Compute winnability for every stored sweep SERP.
 *
 * No SERP is re-bought -- the organic list is recovered from
 * discovery_jobs.raw_items. The only spend is one batched backlinks pass over
 * the distinct defenders, cached 90 days.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/backfill-serp-winnability.mts [apply]
 */
import 'dotenv/config'
import { db } from '../db.js'
import { computeWinnability } from '../serp/serp-winnability.js'

const apply = process.argv[2] === 'apply'
const t0 = Date.now()
const r = await computeWinnability(db(), { apply, limit: 5000 })
const secs = ((Date.now() - t0) / 1000).toFixed(0)

console.log(`${r.results.length} row(s) scored · ${r.skippedNoRaw} skipped (no raw_items) · ${secs}s`)
console.log(
  `authorities: ${r.authority.cached} cached + ${r.authority.fetched} fetched · ` +
    `${r.authority.requestCount} request set(s)${r.authority.failed ? ' · FETCH FAILED (coverage reduced)' : ''}`,
)

const byVerdict = new Map<string, number>()
for (const x of r.results) byVerdict.set(x.acquired.verdict, (byVerdict.get(x.acquired.verdict) ?? 0) + 1)
console.log('acquired verdicts:', [...byVerdict].map(([k, v]) => `${k}=${v}`).join('  '))

const diffs = r.results.map((x) => x.difficulty).filter((d): d is number => d !== null).sort((a, b) => a - b)
if (diffs.length > 0) {
  console.log(
    `difficulty: min ${diffs[0]} · median ${diffs[Math.floor(diffs.length / 2)]} · max ${diffs[diffs.length - 1]}`,
  )
}
const disagree = r.results.filter((x) => x.emd && x.emd.verdict !== x.acquired.verdict)
console.log(`rows where the two verdicts disagree: ${disagree.length}`)
console.log(apply ? '\npersisted' : '\n(dry run — re-run with `apply`)')
process.exit(0)
