/**
 * Dry-run winnability over stored SERPs. No SERP is re-bought; the only spend
 * is one batched backlinks pass, cached 90 days.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-winnability.mts [limit]
 */
import 'dotenv/config'
import { db } from '../db.js'
import { computeWinnability } from '../serp/serp-winnability.js'

const limit = Number(process.argv[2] ?? 40)
const t0 = Date.now()
const r = await computeWinnability(db(), { limit, apply: false })
const secs = ((Date.now() - t0) / 1000).toFixed(0)

console.log(
  `${r.results.length} row(s) scored · ${r.skippedNoRaw} skipped (no raw_items) · ${secs}s`,
)
console.log(
  `authorities: ${r.authority.cached} cached + ${r.authority.fetched} fetched · ` +
    `${r.authority.requestCount} request(s)${r.authority.failed ? ' · FETCH FAILED' : ''}`,
)
console.log(`EMDs checked: ${r.emdChecked}\n`)

console.log('diff  cov   open  plat  medRD  emd verdict     acquired verdict   emd domain')
console.log('-'.repeat(104))
for (const x of r.results.slice(0, 25)) {
  console.log(
    `${String(x.difficulty ?? '—').padStart(4)}  ${x.weightCovered.toFixed(2)}  ` +
      `${String(x.slotsOpen).padStart(4)}  ${String(x.platformHeldSlots).padStart(4)}  ` +
      `${String(x.medianRefDomains ?? '—').padStart(5)}  ` +
      `${String(x.emd?.verdict ?? '—').padEnd(15)} ${x.acquired.verdict.padEnd(16)} ` +
      `${x.emdDomainName ?? '—'}${x.emdAvailable === true ? ' (free)' : x.emdAvailable === false ? ' (taken)' : ''}`,
  )
}

const winnable = r.results.filter((x) => x.acquired.verdict === 'likely_30d' || x.acquired.verdict === 'likely_90d')
console.log(`\n${winnable.length}/${r.results.length} winnable within 90 days (acquired-domain path)`)
const byVerdict = new Map<string, number>()
for (const x of r.results) byVerdict.set(x.acquired.verdict, (byVerdict.get(x.acquired.verdict) ?? 0) + 1)
console.log('acquired verdicts:', [...byVerdict].map(([k, v]) => `${k}=${v}`).join('  '))
process.exit(0)
