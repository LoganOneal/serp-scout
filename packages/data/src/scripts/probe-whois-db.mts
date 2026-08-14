import 'dotenv/config'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'

/**
 * P1 — is `/domain_analytics/whois/overview/live` a QUERYABLE database?
 *
 * ==================== WHY THIS PROBE COMES FIRST ====================
 * Every discovery method this project has is presence-based: enumerate the
 * businesses that are visible, then ask whether their domains are dead. The
 * target population -- businesses that already died -- is invisible to all of
 * it. See plan-defunct-domain-discovery.md §0.
 *
 * If this endpoint accepts filters on the domain NAME, the expiration date and
 * backlink metrics, then the architecture inverts: instead of enumerating
 * businesses we query the domain space directly, and one request replaces the
 * whole collection stage.
 *
 * That is a large enough difference to be worth settling before anything else
 * is built, and it is one script.
 * ===================================================================
 *
 * Each step is measured by BALANCE DELTA, not by a rate card -- the same way
 * every other price in this repo was established.
 */

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing in .env')
  process.exit(1)
}

const client = new DataForSeoClient({ credentials: { login, password }, timeoutMs: 60_000 })
const WHOIS = '/domain_analytics/whois/overview/live'

/**
 * `/appendix/user_data` is rate limited to SIX REQUESTS A MINUTE.
 *
 * Measured the hard way: the first version of this probe called balance before
 * and after every step, which is two of the six per step, and it died on step 3
 * with 40202. The balance endpoint -- not the endpoint under test -- was the
 * limiting factor.
 *
 * So balance is sampled ONCE at each end and the per-request cost is derived
 * from the request count. Steps are also selectable, so a re-run does not
 * re-buy the steps that already answered.
 */
const balance = async (): Promise<number> => (await fetchAccountStatus(client)).balanceUsd

let requests = 0
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)
const wanted = (n: number): boolean => only.length === 0 || only.includes(n)

interface WhoisResult {
  total_count?: number
  items_count?: number
  items?: Array<Record<string, unknown>>
}

/**
 * Run one filter shape and report what came back.
 *
 * A failure here is a RESULT, not a crash: the whole point is to learn which
 * filters the endpoint accepts, so a rejected filter must be printed and the
 * probe must continue to the next one.
 */
async function step(n: number, name: string, payload: Record<string, unknown>): Promise<void> {
  if (!wanted(n)) return
  console.log(`\n${'='.repeat(70)}\n${n}. ${name}\n${'='.repeat(70)}`)
  console.log('payload:', JSON.stringify(payload))

  try {
    const res = await client.post<WhoisResult[]>(WHOIS, [payload])
    requests += 1
    const row = Array.isArray(res) ? res[0] : undefined

    /**
     * ================= A FILTER CAN BE "ACCEPTED" AND STILL BE WRONG =========
     * Step 4 asked for `epp_status_codes has redemptionPeriod` and got a clean
     * 20000 with zero rows and no total_count -- because the stored values are
     * snake_case (`redemption_period`). An unrecognised filter VALUE is not an
     * error here; it is an empty result set, which reads exactly like "no such
     * domains exist".
     *
     * That is this repo's core failure mode, so it is called out rather than
     * printed as a zero.
     * ========================================================================
     */
    const suspicious = (row?.items?.length ?? 0) === 0 && row?.total_count == null
    console.log(`  ACCEPTED${suspicious ? '  ⚠ ZERO ROWS AND NO total_count — suspect the filter VALUE, not the schema' : ''}`)
    console.log(`  total_count: ${row?.total_count ?? '—'}   returned: ${row?.items?.length ?? 0}`)

    const items = row?.items ?? []
    if (items[0]) {
      console.log(`  FIELDS: ${Object.keys(items[0]).join(', ')}`)
      // The nested shapes are where the filterable metrics live, and their key
      // names are not guessable -- `backlinks_info.rank` read null on step 1.
      for (const key of ['backlinks_info', 'metrics']) {
        const sub = items[0][key]
        if (sub && typeof sub === 'object') {
          console.log(`  ${key}: ${JSON.stringify(sub).slice(0, 400)}`)
        }
      }
    }
    for (const it of items.slice(0, 6)) {
      const b = it['backlinks_info'] as Record<string, unknown> | undefined
      console.log(
        `    ${String(it['domain']).padEnd(36)}` +
          ` exp ${String(it['expiration_datetime'] ?? '—').slice(0, 10)}` +
          ` created ${String(it['created_datetime'] ?? '—').slice(0, 10)}` +
          ` refdom ${String(b?.['referring_domains'] ?? '—').padStart(7)}` +
          ` epp ${JSON.stringify(it['epp_status_codes'] ?? null)}`,
      )
    }
  } catch (e) {
    // A rejected filter is the ANSWER, not a crash. Keep going.
    requests += 1
    console.log(`  REJECTED: ${(e as Error).name} — ${(e as Error).message.slice(0, 300)}`)
  }
}

const opening = await balance()
console.log(`Opening balance: $${opening.toFixed(4)}`)
console.log(`Steps: ${only.length === 0 ? 'all' : only.join(', ')}`)

// --- 1. Does it answer at all, and what fields does a row carry? ---
// ANSWERED 2026-08-13: yes. 251,821,316 domains. $0.126 per request.
await step(1, 'Bare call — shape discovery', { limit: 5 })

// --- 2. Filter on the domain NAME. The locality/niche hook. ---
// ANSWERED 2026-08-13: accepted. `%plumb%` matched 202,912 domains.
await step(2, 'Filter: domain LIKE %plumb%', {
  limit: 5,
  filters: [['domain', 'like', '%plumb%']],
})

// --- 3. Filter on expiry. The "obtainable soon" hook. ---
await step(3, 'Filter: expired before today', {
  limit: 6,
  filters: [['expiration_datetime', '<', '2026-08-13 00:00:00 +00:00']],
})

// --- 4. Registry state. redemptionPeriod / pendingDelete are the drop window. ---
await step(4, 'Filter: epp_status_codes contains redemptionPeriod', {
  limit: 6,
  filters: [['epp_status_codes', 'has', 'redemptionPeriod']],
})

/**
 * 5. The real query, and the only one that matters. If this shape is accepted
 *    the feature is largely a UI over one request per market.
 */
await step(5, 'COMBINED: name + expiry + links, ranked', {
  limit: 10,
  filters: [
    ['domain', 'like', '%plumb%'],
    'and',
    ['expiration_datetime', '<', '2026-11-13 00:00:00 +00:00'],
    'and',
    ['backlinks_info.referring_domains', '>', 5],
  ],
  order_by: ['backlinks_info.referring_domains,desc'],
})

// --- 6. Does a city token work as well as a niche token? ---
await step(6, 'Locality token: domain LIKE %kenosha%', {
  limit: 6,
  filters: [['domain', 'like', '%kenosha%']],
})

/**
 * 7. Registry state, with the casing the DATA uses rather than the casing RDAP
 *    uses. Step 4's `redemptionPeriod` returned zero rows silently.
 */
await step(7, 'Filter: epp_status_codes has redemption_period (snake_case)', {
  limit: 6,
  filters: [['epp_status_codes', 'has', 'redemption_period']],
})

/**
 * 8. THE PRODUCT QUERY. Locality token + a real link profile + still ranking.
 *    If this returns local operators rather than civic and news sites, one
 *    request per market replaces the entire collection stage.
 */
await step(8, 'PRODUCT QUERY: locality token + links + still ranking', {
  limit: 10,
  filters: [
    ['domain', 'like', '%kenosha%'],
    'and',
    ['backlinks_info.referring_domains', '>', 5],
    'and',
    ['metrics.organic.count', '>', 0],
  ],
  order_by: ['backlinks_info.referring_domains,desc'],
})

const closing = await balance()
console.log(`\n${'='.repeat(70)}`)
console.log(`Closing balance: $${closing.toFixed(4)}`)
console.log(
  `Spent $${(opening - closing).toFixed(4)} over ${requests} request(s)` +
    (requests > 0 ? ` = $${((opening - closing) / requests).toFixed(4)} each` : ''),
)
