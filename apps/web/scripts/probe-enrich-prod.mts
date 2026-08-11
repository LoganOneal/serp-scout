/**
 * End-to-end ENRICH MODE against the deployed system.
 *
 * Creates the run row exactly as the server action does, then dispatches the
 * PRODUCTION Trigger.dev task — so the work runs inside the deployed bundle,
 * not this machine — and polls the row until it settles.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     apps/web/scripts/probe-enrich-prod.mts [niche] [locationCode] [locality]
 */
// The monorepo keeps one .env at the root; this script runs from apps/web, so
// dotenv's cwd default would find nothing. Same reason trigger.config.ts does it.
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

import { tasks } from '@trigger.dev/sdk/v3'
import { formatMicrosUsd } from '@rnr/core'
import { createEnrichRun, db, getEnrichRun, listDomainCandidates } from '@rnr/data'

const niche = process.argv[2] ?? 'plumber'
const locationCode = Number(process.argv[3] ?? 1023191)
const locality = process.argv[4] ?? `location ${locationCode}`

const database = db()

const runId = await createEnrichRun(database, {
  niche,
  locality,
  locationCode,
  maxResults: 200,
})
console.log(`created run #${runId} — "${niche}" @ ${locality} (${locationCode})`)

const handle = await tasks.trigger('domain-enrich', { runId })
console.log(`dispatched to Trigger.dev prod: ${handle.id}\n`)

const started = Date.now()
let last = ''
for (;;) {
  await new Promise((r) => setTimeout(r, 10_000))
  const run = await getEnrichRun(database, runId)
  if (!run) throw new Error('run vanished')

  const line =
    `${Math.round((Date.now() - started) / 1000)}s · ${run.status} · ` +
    `biz ${run.businessesFound} · domains ${run.uniqueDomains} · candidates ${run.candidateCount}`
  if (line !== last) {
    console.log(line)
    last = line
  }

  if (run.status === 'complete' || run.status === 'failed') {
    console.log(`\nfinal: ${run.status}${run.error ? ` — ${run.error}` : ''}`)
    console.log(
      `businesses ${run.businessesFound} · unique domains ${run.uniqueDomains} · ` +
        `dropped ${run.skippedPlatform} platform / ${run.skippedNoDomain} no-site · ` +
        `cost ${formatMicrosUsd(run.costMicros, { precision: 4 })}`,
    )

    const rows = await listDomainCandidates(database, { runId, includeLive: false, limit: 50 })
    console.log(`\n=== ${rows.length} acquisition candidate(s), best first ===`)
    for (const r of rows.slice(0, 20)) {
      console.log(
        `${String(r.score).padStart(5)}  ${r.domain.padEnd(38)} ${r.status.padEnd(14)} ` +
          `${(r.ageYears == null ? '—' : `${r.ageYears.toFixed(1)}y`).padStart(6)}  ` +
          `arch ${String(r.yearsOfContent ?? '—').padStart(2)}y  ${r.reason}`,
      )
    }
    console.log(`\nView: https://rank-and-rent-beta.vercel.app/domains/${runId}`)
    break
  }

  if (Date.now() - started > 25 * 60_000) {
    console.log('\ngave up waiting after 25 minutes')
    break
  }
}

process.exit(0)
