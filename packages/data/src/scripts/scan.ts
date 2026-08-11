/**
 * Run one scan synchronously from the CLI, bypassing the queue.
 *
 *   pnpm scan kenosha-wi
 *   pnpm scan kenosha-wi --cap-cents 25
 *
 * Useful for the step-7 live spot check: a single locality, an explicit cap, and
 * the full log in front of you rather than in a worker's output.
 */
import 'dotenv/config'
import { centsToMicros, formatMicrosUsd } from '@rnr/core'
import { closeDb, db } from '../db.js'
import { getLocalityBySlug, getRunResults } from '../queries.js'
import { enqueueScan, markRunStatus } from '../queue.js'
import { runScan } from '../pipeline/run-scan.js'
import { createProviders, liveCallsEnabled } from '../providers/index.js'
import { reconcileSpend } from '../budget.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--'))
  if (!slug) {
    console.error('Usage: pnpm scan <locality-slug> [--cap-cents N]')
    process.exit(1)
  }
  const capIdx = args.indexOf('--cap-cents')
  const capCents = capIdx >= 0 ? Number(args[capIdx + 1]) : Number(process.env['SCAN_BUDGET_CAP_CENTS'] ?? 200)

  const database = db()
  const locality = await getLocalityBySlug(database, slug)
  if (!locality) {
    console.error(`No locality with slug "${slug}". Run pnpm ingest:geo first.`)
    process.exit(1)
  }

  const providers = createProviders()
  console.log(
    `\n${locality.name}, ${locality.stateCode} (${locality.kind}), pop ${locality.population?.toLocaleString() ?? '?'}`,
  )
  console.log(`Provider location: ${locality.providerLocationCode ?? 'UNRESOLVED'}`)
  console.log(
    `Mode: ${liveCallsEnabled() ? 'LIVE — real money' : 'FIXTURES — $0'}, cap ${formatMicrosUsd(centsToMicros(capCents), { precision: 2 })}\n`,
  )

  const run = await enqueueScan(database, {
    localityId: locality.id,
    budgetCapMicros: centsToMicros(capCents),
    usedFixtures: !providers.live,
  })
  // Claim it ourselves so the worker cannot also pick it up.
  await markRunStatus(database, run.id, 'claimed')

  const result = await runScan({
    db: database,
    providers,
    runId: run.id,
    localityId: locality.id,
    budgetCapMicros: centsToMicros(capCents),
    log: (m) => console.log(`  ${m}`),
  })

  const rows = await getRunResults(database, run.id)
  const spend = await reconcileSpend(database, run.id)

  console.log(`\n=== ${result.status} — run #${run.id} ===`)
  if (result.error) console.log(`\n${result.error}\n`)
  console.log(
    `Spend ${formatMicrosUsd(result.spendMicros, { precision: 4 })} across ${spend.lineItems} ledger rows ` +
      `(reconciled: ${spend.matches ? 'yes' : 'NO — MISMATCH'})\n`,
  )

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
  console.log(
    `${pad('NICHE', 26)} ${'DIFF'.padStart(5)} ${'COV'.padStart(5)}  ${pad('VERDICT', 13)} ${'SEARCH'.padStart(7)} ${'RENT'.padStart(8)} ${'OPEN'.padStart(5)}  EMD`,
  )
  for (const r of rows) {
    const diff = r.difficulty === null ? '—' : String(r.difficulty)
    const rent = r.rentMicros === null ? '—' : `$${(r.rentMicros / 1_000_000n).toString()}`
    const avail = r.emdAvailable === true ? 'free' : r.emdAvailable === false ? 'taken' : '?'
    console.log(
      `${pad(r.nicheLabel, 26)} ${diff.padStart(5)} ${`${Math.round(r.weightCovered * 100)}%`.padStart(5)}  ` +
        `${pad(r.verdict, 13)} ${String(r.volumeEst ?? '—').padStart(7)} ${rent.padStart(8)} ` +
        `${`${r.slotsOpen}/10`.padStart(5)}  ${r.emdDomain} (${avail})`,
    )
  }

  const scored = rows.filter((r) => r.difficulty !== null).map((r) => r.difficulty!)
  if (scored.length > 1) {
    const mean = scored.reduce((a, b) => a + b, 0) / scored.length
    const sd = Math.sqrt(scored.reduce((a, b) => a + (b - mean) ** 2, 0) / scored.length)
    console.log(
      `\nDifficulty spread: min ${Math.min(...scored)}, max ${Math.max(...scored)}, ` +
        `mean ${mean.toFixed(1)}, stdev ${sd.toFixed(1)}, ${new Set(scored).size} distinct values.`,
    )
    console.log('A flat list here would hide every ordering bug in the model.')
  }
  console.log(
    '\nVolume is ESTIMATED from population. Rent is MODELLED. Verdicts are priors awaiting calibration.\n',
  )

  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
