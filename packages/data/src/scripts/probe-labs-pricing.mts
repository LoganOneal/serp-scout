/**
 * ARM A — is `ranked_keywords` billed per REQUEST, or per request PLUS per row?
 *
 * ==================== WHY THIS IS A BUG HUNT, NOT A FEATURE PROBE ====================
 * `PRICE.labsRankedKeywords = 12_000n` ($0.012) is modelled as FLAT. Every call
 * that produced that figure passed `limit: 1` and read `total_count`
 * (quality-gates.ts) — so what was actually measured is the REQUEST fee, and
 * per-row billing has never been tested.
 *
 * The shape to worry about is one this repo already models correctly two
 * constants away: `backlinksBulkRequest` ($0.024) + `backlinksBulkRow`
 * ($0.000036). If Labs bills the same way, every expired-domain run that touches
 * the rankings gate is under-ledgering today, and a 5,000-row keyword pull would
 * ledger $0.012 and spend something else entirely.
 *
 * Balance delta is the only honest instrument here — a rate card is a claim, the
 * meter is a measurement. Same technique as PRICE.backlinksReferringDomains.
 * ===================================================================================
 *
 * Cost: 3 requests. ~$0.036 if flat. HARD CAPPED at $0.50 — it stops rather than
 * discovers the answer on the invoice.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-labs-pricing.mts --live
 */
import 'dotenv/config'
import { PRICE, formatMicrosUsd } from '@rnr/core'
import { fetchAccountStatus } from '../providers/dataforseo/client.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { LABS_LOCATION_US, fetchRankedKeywords } from '../providers/dataforseo/labs.js'

const live = process.argv.includes('--live')

/** Hard cap in USD. Enforced between requests, not hoped for. */
const BUDGET_USD = 0.5

/**
 * A domain with a large, certain keyword footprint, so `limit` is the only
 * variable. Using one of our own sites would confound a small footprint with a
 * small bill.
 */
const TARGET = 'booking.com'

const LIMITS = [1, 10, 100]

async function main(): Promise<void> {
  const client = createDfsClientFromEnv()
  if (!client) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set')
  if (!live) {
    console.log('DRY RUN — pass --live. This probe spends real money (~$0.04, capped at $0.50).')
    return
  }

  const before = await fetchAccountStatus(client)
  console.log(`balance before: $${before.balanceUsd.toFixed(4)}`)

  const measurements: Array<{ limit: number; rows: number; deltaUsd: number; totalCount: number | null }> = []
  let last = before.balanceUsd

  for (const limit of LIMITS) {
    const spent = before.balanceUsd - last
    if (spent >= BUDGET_USD) {
      console.log(`\n!! BUDGET CAP: $${spent.toFixed(4)} spent, cap $${BUDGET_USD}. Stopping.`)
      break
    }

    const r = await fetchRankedKeywords(client, {
      target: TARGET,
      locationCode: LABS_LOCATION_US,
      limit,
    })
    const after = await fetchAccountStatus(client)
    const delta = last - after.balanceUsd
    last = after.balanceUsd

    measurements.push({ limit, rows: r.rowsReturned, deltaUsd: delta, totalCount: r.totalCount })
    console.log(
      `limit ${String(limit).padStart(4)} → ${String(r.rowsReturned).padStart(4)} rows · ` +
        `delta $${delta.toFixed(6)} · vendor total_count ${r.totalCount ?? '—'}`,
    )
  }

  console.log(`\nbalance after: $${last.toFixed(4)} · total spent $${(before.balanceUsd - last).toFixed(4)}`)

  // --- the verdict ----------------------------------------------------------
  console.log('\n=== is it per-row? ===')
  const usable = measurements.filter((m) => m.deltaUsd > 0)
  if (usable.length < 2) {
    console.log(
      'Not enough non-zero deltas to tell. DataForSEO balance can lag; re-run before concluding it is free.',
    )
    return
  }

  const lo = usable[0]!
  const hi = usable[usable.length - 1]!
  const rowSpread = hi.rows - lo.rows
  const costSpread = hi.deltaUsd - lo.deltaUsd

  if (rowSpread <= 0) {
    console.log(`Row counts did not vary (${lo.rows} vs ${hi.rows}) — cannot separate the two models.`)
    return
  }

  const perRow = costSpread / rowSpread
  const perRowMicros = Math.round(perRow * 1_000_000)

  console.log(
    `${lo.rows} rows cost $${lo.deltaUsd.toFixed(6)}; ${hi.rows} rows cost $${hi.deltaUsd.toFixed(6)}.`,
  )
  console.log(`implied per-row cost: $${perRow.toFixed(8)} (${perRowMicros} micros)`)

  if (Math.abs(costSpread) < 0.0005) {
    console.log(
      `>> FLAT. PRICE.labsRankedKeywords (${formatMicrosUsd(PRICE.labsRankedKeywords)}) stands, and ` +
        `PRICE.labsRankedKeywordsRow correctly stays 0n. Wide pulls are safe to price at the request fee.`,
    )
  } else {
    console.log(
      `>> PER-ROW. Set PRICE.labsRankedKeywordsRow = ${perRowMicros}n.\n` +
        `   Until that lands, every rankings-gate call in quality-gates.ts is UNDER-LEDGERING, and a\n` +
        `   5,000-row pull would cost ~$${(PRICE.labsRankedKeywords === 0n ? 0 : 0.012) + perRow * 5000}.`,
    )
  }

  const firstTotal = measurements[0]?.totalCount
  if (firstTotal != null) {
    console.log(
      `\nNote: the vendor holds ${firstTotal.toLocaleString()} keywords for ${TARGET}. Every result above ` +
        `is a PAGE, and fetchRankedKeywords reports \`truncated\` for exactly this reason.`,
    )
  }
}

await main()
