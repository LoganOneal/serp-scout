/**
 * End-to-end ENRICH MODE run for one niche + locality.
 *
 * Stage 1 costs one Maps request ($0.002). Stages 2-5b are free. Majestic
 * (5a) and the registrar availability check (3e) are skipped — no credentials
 * are configured for either — so scores will list them as missing rather than
 * silently scoring those domains low.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-enrich-mode.mts [niche] [locationCode] [triageLimit]
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { collectBusinesses } from '../domains/collect-businesses.js'
import { enrichDomains } from '../domains/enrich-pipeline.js'

const niche = process.argv[2] ?? 'plumber'
const locationCode = Number(process.argv[3] ?? 1023191)
const triageLimit = Number(process.argv[4] ?? 25)

console.log(`Stage 1 — collecting "${niche}" @ location ${locationCode}`)
const collected = await collectBusinesses({ niche, locationCode, maxResults: 200 })
console.log(
  `  ${collected.businesses.length} business(es) · ${collected.withoutWebsite} with no website · ` +
    `${collected.requests} request · ${formatMicrosUsd(collected.costMicros, { precision: 4 })}\n`,
)

// Triage is free but slow (Wayback's index answers in ~10s), so the probe caps
// how many domains it walks. Cost is unaffected — Stage 1 already paid in full.
const subset = collected.businesses.slice(0, triageLimit)
console.log(`Stages 2-5 — triaging the first ${subset.length} listing(s)\n`)

const t0 = process.hrtime.bigint()
const result = await enrichDomains(subset, {
  concurrency: 6,
  nicheTerms: [niche],
  onProgress: (done, total) => {
    if (done % 5 === 0 || done === total) console.log(`  ...${done}/${total}`)
  },
})
const seconds = Number(process.hrtime.bigint() - t0) / 1e9

console.log(
  `\nunique domains ${result.stats.uniqueDomains} · skipped platform ${result.stats.skippedPlatform} · ` +
    `skipped no-domain ${result.stats.skippedNoDomain} · ${seconds.toFixed(1)}s\n`,
)

const acquirable = result.candidates.filter((c) => c.classification.status !== 'LIVE')
console.log(`=== ${acquirable.length} acquisition candidate(s), best first ===`)
console.log('domain'.padEnd(38), 'status'.padEnd(15), 'score'.padStart(5), '  age    reason')
console.log('-'.repeat(118))
for (const c of acquirable) {
  const age = c.classification.ageYears
  console.log(
    c.domain.padEnd(38),
    c.classification.status.padEnd(15),
    String(c.score.total).padStart(5),
    (age === null ? '—' : `${age.toFixed(1)}y`).padStart(6),
    ` ${c.classification.reason}`,
  )
}

console.log('\nby status:', JSON.stringify(result.stats.byStatus))
console.log(
  `total spend: ${formatMicrosUsd(collected.costMicros, { precision: 4 })} ` +
    `(stages 2-5 are free; Majestic and registrar checks not configured)`,
)
process.exit(0)
