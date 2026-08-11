/**
 * End-to-end wide run: live map pack + everything the sweep already bought.
 * Paid gates OFF, so this measures the free path only.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-wide-run.mts [locationCode] [niche]
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { runEnrich } from '../domains/run-enrich.js'
import { listDomainCandidates } from '../domains/queries.js'

const locationCode = Number(process.argv[2] ?? 1013462)
const niche = process.argv[3] ?? 'fire damage restoration'
const t0 = Date.now()

const r = await runEnrich(db(), {
  niche,
  locality: `location ${locationCode}`,
  locationCode,
  maxResults: 700,
  options: { concurrency: 10 },
  paidOptions: {},
})
const secs = ((Date.now() - t0) / 1000).toFixed(0)

console.log(
  `\nrun #${r.runId}: ${r.uniqueDomains} unique domains · ${r.candidates} candidates · ` +
    `${formatMicrosUsd(r.costMicros, { precision: 4 })} · ${secs}s`,
)

const rows = await listDomainCandidates(db(), { runId: r.runId, includeLive: false, limit: 40 })
console.log(`\n=== top candidates ===`)
for (const x of rows.slice(0, 14)) {
  console.log(
    `${String(x.score).padStart(5)}  ${x.domain.padEnd(36)} ${String(x.status).padEnd(14)} ` +
      `serp ${String(x.serpRank ?? '—').padStart(3)}  [${(x.sources ?? []).join('+')}]`,
  )
}
process.exit(0)
