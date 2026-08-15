/**
 * ITEM 0 — is `bulk_traffic_estimation` priced per REQUEST or per TARGET?
 *
 * ==================== IT DECIDES THE SHAPE OF STAGE ④ ====================
 * The traffic filter is the gate that decides whether a prospect list is real
 * (plan-link-outreach.md §0.1: authority is manufacturable, traffic is not).
 * There are two ways to buy it:
 *
 *   fetchRankedKeywords(target, limit: 1)   MEASURED $0.01212 per DOMAIN
 *   bulk_traffic_estimation                 up to 1,000 targets per request
 *
 * On 500 prospects the first is $6.06 — affordable, and the largest line in a
 * run. If the second is priced per request like the bulk backlinks endpoints,
 * it replaces $6.06 with cents.
 *
 * Same balance-delta method that found `ranked_keywords` was billed per row
 * ($0.012 + $0.00012/row) when the constant claimed flat. Measure before
 * building stage ④ around the per-domain call.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-traffic-estimation.mts --live
 */
import 'dotenv/config'
import { fetchAccountStatus } from '../providers/dataforseo/client.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'

const live = process.argv.includes('--live')

/** Real domains spanning the range: giant, mid, and a plausible link-network shape. */
const TARGETS_SMALL = ['booking.com', 'tripadvisor.com', 'oyster.com']
const TARGETS_LARGE = [
  ...TARGETS_SMALL,
  'thrillist.com',
  'timeout.com',
  'lonelyplanet.com',
  'fodors.com',
  'travelandleisure.com',
  'cntraveler.com',
  'tripsavvy.com',
  'visitacity.com',
  'hotels.com',
  'expedia.com',
  'agoda.com',
  'kayak.com',
]

interface Row {
  target: string
  organicEtv: number | null
  organicCount: number | null
}

async function estimate(
  client: ReturnType<typeof createDfsClientFromEnv>,
  targets: string[],
): Promise<{ rows: Row[]; error: string | null }> {
  if (!client) return { rows: [], error: 'no credentials' }
  try {
    const body = await client.post<
      Array<{
        items?: Array<{
          target?: string
          metrics?: { organic?: { etv?: number | null; count?: number | null } }
        }>
      }>
    >('/dataforseo_labs/google/bulk_traffic_estimation/live', [
      { targets, location_code: 2840, language_code: 'en' },
    ])
    const items = body?.[0]?.items ?? []
    return {
      rows: items.map((i) => ({
        target: i.target ?? '?',
        organicEtv: i.metrics?.organic?.etv ?? null,
        organicCount: i.metrics?.organic?.count ?? null,
      })),
      error: null,
    }
  } catch (e) {
    return { rows: [], error: (e as Error).message }
  }
}

async function main(): Promise<void> {
  const client = createDfsClientFromEnv()
  if (!client) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set')
  if (!live) {
    console.log('DRY RUN — pass --live. Two requests, expected well under $0.10.')
    return
  }

  const before = await fetchAccountStatus(client)
  console.log(`balance before: $${before.balanceUsd.toFixed(4)}`)

  const small = await estimate(client, TARGETS_SMALL)
  const afterSmall = await fetchAccountStatus(client)
  const deltaSmall = before.balanceUsd - afterSmall.balanceUsd

  if (small.error) {
    console.log(`\n!! ${TARGETS_SMALL.length} targets FAILED: ${small.error}`)
    console.log(
      'If this is "Invalid Path.", the endpoint name is wrong — that error arrives inside an\n' +
        'HTTP 200 (TRAP 2) and reads exactly like "no data". Stage ④ stays on ranked_keywords.',
    )
    return
  }

  console.log(`${TARGETS_SMALL.length} targets → ${small.rows.length} rows · delta $${deltaSmall.toFixed(6)}`)

  const large = await estimate(client, TARGETS_LARGE)
  const afterLarge = await fetchAccountStatus(client)
  const deltaLarge = afterSmall.balanceUsd - afterLarge.balanceUsd
  console.log(`${TARGETS_LARGE.length} targets → ${large.rows.length} rows · delta $${deltaLarge.toFixed(6)}`)

  console.log('\n--- what it returns (the §0.1 filter) ---')
  for (const r of large.rows.slice(0, 6)) {
    console.log(
      `  ${r.target.padEnd(24)} organic keywords ${String(r.organicCount ?? '—').padStart(9)} · ETV ${
        r.organicEtv === null ? '—' : Math.round(r.organicEtv).toLocaleString()
      }`,
    )
  }

  console.log('\n=== per request, or per target? ===')
  const rowSpread = large.rows.length - small.rows.length
  const costSpread = deltaLarge - deltaSmall

  if (deltaSmall <= 0 && deltaLarge <= 0) {
    console.log('Both deltas are zero. Either it is free, or the balance lags — re-run before concluding.')
    return
  }
  if (rowSpread <= 0) {
    console.log(`Row counts did not vary (${small.rows.length} vs ${large.rows.length}) — cannot separate the models.`)
    return
  }

  const perTarget = costSpread / rowSpread
  console.log(
    `${small.rows.length} targets cost $${deltaSmall.toFixed(6)}; ${large.rows.length} cost $${deltaLarge.toFixed(6)}.`,
  )
  console.log(`implied per-target cost: $${perTarget.toFixed(8)}`)

  const per500 = deltaSmall + perTarget * (500 - small.rows.length)
  console.log(
    Math.abs(costSpread) < 0.0005
      ? `>> FLAT PER REQUEST. 500 prospects cost ~$${deltaSmall.toFixed(4)} instead of $6.06 via ranked_keywords.\n` +
          `   Build stage ④ on this, batched 1,000 per request.`
      : `>> PER TARGET at $${perTarget.toFixed(6)}. 500 prospects ≈ $${per500.toFixed(4)}.\n` +
          `   ${per500 < 6.06 ? 'Still cheaper than ranked_keywords ($6.06) — use it.' : 'No cheaper than ranked_keywords — keep the per-domain call.'}`,
  )
}

await main()
