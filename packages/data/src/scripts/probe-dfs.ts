/**
 * Capture REAL DataForSEO payloads into __contracts__/.
 *
 * Gated: prints balance and account status from the free endpoint, prints an
 * itemised cost estimate, and waits for you to type `yes` before spending
 * anything. Estimated total ~$0.08.
 *
 *   pnpm probe:dfs
 *
 * Everything free is captured unconditionally (user_data, locations). The paid
 * calls use two targets and one keyword -- the minimum that still proves each
 * endpoint's field set.
 */
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { formatMicrosUsd, PRICE, sumMicros, type Micros } from '@rnr/core'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
import { writeContract } from '../providers/dataforseo/contracts.js'
import { AccountIssueError } from '../providers/dataforseo/errors.js'

const PROBE_TARGETS = ['yelp.com', 'kenoshatreeservice.com']
const PROBE_KEYWORD = 'kenosha tree service'
/**
 * A market with a real map pack.
 *
 * `kenosha tree service` returns 40102 "No Search Results" from the maps
 * endpoint -- twice, so not a blip -- which left the map-pack fixture empty.
 *
 * NOT used to capture the discussions fixture. That was tried and is a trap:
 * the module is not deterministic, one capture came back with no perspectives
 * block at all, and it overwrote a purpose-built scenario fixture that three
 * tests depend on. See serp_organic_with_discussions.__meta.constructed.
 */
const PROBE_MAPS_KEYWORD = 'plumber new york city'
const PROBE_MAPS_LOCATION_CODE = 1023191
/** Kenosha, Wisconsin. Verified City code. */
const PROBE_LOCATION_CODE = 1015254

interface Step {
  name: string
  path: string
  costMicros: Micros
  run: (client: DataForSeoClient) => Promise<unknown>
}

const FREE_STEPS: Step[] = [
  {
    name: 'user_data',
    path: ENDPOINTS.USER_DATA,
    costMicros: 0n,
    run: (c) => c.get(ENDPOINTS.USER_DATA),
  },
  {
    name: 'locations',
    path: ENDPOINTS.LOCATIONS,
    costMicros: 0n,
    run: (c) => c.get(ENDPOINTS.LOCATIONS),
  },
]

const PAID_STEPS: Step[] = [
  {
    name: 'bulk_ranks',
    path: ENDPOINTS.BACKLINKS_BULK_RANKS,
    costMicros: PRICE.backlinksBulkRequest + PRICE.backlinksBulkRow * BigInt(PROBE_TARGETS.length),
    run: (c) => c.post(ENDPOINTS.BACKLINKS_BULK_RANKS, [{ targets: PROBE_TARGETS }]),
  },
  {
    name: 'bulk_referring_domains',
    path: ENDPOINTS.BACKLINKS_BULK_REFERRING_DOMAINS,
    costMicros: PRICE.backlinksBulkRequest + PRICE.backlinksBulkRow * BigInt(PROBE_TARGETS.length),
    run: (c) => c.post(ENDPOINTS.BACKLINKS_BULK_REFERRING_DOMAINS, [{ targets: PROBE_TARGETS }]),
  },
  {
    name: 'bulk_spam_score',
    path: ENDPOINTS.BACKLINKS_BULK_SPAM_SCORE,
    costMicros: PRICE.backlinksBulkRequest + PRICE.backlinksBulkRow * BigInt(PROBE_TARGETS.length),
    run: (c) => c.post(ENDPOINTS.BACKLINKS_BULK_SPAM_SCORE, [{ targets: PROBE_TARGETS }]),
  },
  {
    name: 'serp_organic',
    path: ENDPOINTS.SERP_ORGANIC_LIVE,
    costMicros: PRICE.serpOrganicLive,
    run: (c) =>
      c.post(ENDPOINTS.SERP_ORGANIC_LIVE, [
        {
          keyword: PROBE_KEYWORD,
          location_code: PROBE_LOCATION_CODE,
          language_code: 'en',
          device: 'desktop',
          os: 'windows',
          depth: 100,
        },
      ]),
  },
  {
    name: 'serp_maps',
    path: ENDPOINTS.SERP_MAPS_LIVE,
    costMicros: PRICE.serpMapsLive,
    /**
     * Deliberately NOT the small-market probe keyword. Two captures of
     * "kenosha tree service" came back 40102 "No Search Results" -- the maps
     * index simply has nothing for it there, so the fixture recorded an empty
     * pack and the map-pack assertions had nothing real to run against.
     */
    run: (c) =>
      c.post(ENDPOINTS.SERP_MAPS_LIVE, [
        {
          keyword: PROBE_MAPS_KEYWORD,
          location_code: PROBE_MAPS_LOCATION_CODE,
          language_code: 'en',
        },
      ]),
  },
]

/**
 * The captured payload must be the FULL envelope, not just the result. The
 * contract tests assert on tasks[0].status_code and on the outer status_code --
 * that is the whole point of the Trap 4 fixture.
 */
async function captureFullEnvelope(
  credentials: { login: string; password: string },
  step: Step,
  body: unknown[] | null,
): Promise<unknown> {
  const auth = Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')
  const res = await fetch(`https://api.dataforseo.com/v3${step.path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(
      `${step.path} returned a non-JSON body under HTTP ${res.status}: ${raw.slice(0, 300)}`,
    )
  }
}

const BODIES: Record<string, unknown[] | null> = {
  user_data: null,
  locations: null,
  bulk_ranks: [{ targets: PROBE_TARGETS }],
  bulk_referring_domains: [{ targets: PROBE_TARGETS }],
  bulk_spam_score: [{ targets: PROBE_TARGETS }],
  serp_organic: [
    {
      keyword: PROBE_KEYWORD,
      location_code: PROBE_LOCATION_CODE,
      language_code: 'en',
      device: 'desktop',
      os: 'windows',
      depth: 100,
    },
  ],
  serp_maps: [
    {
      keyword: PROBE_MAPS_KEYWORD,
      location_code: PROBE_MAPS_LOCATION_CODE,
      language_code: 'en',
    },
  ],
}


/**
 * Strip account identity and finances from the user_data capture.
 *
 * ==================== A FIXTURE IS A COMMITTED FILE ====================
 * The first live capture wrote the account's real login address, its balance
 * and its lifetime spend into a file in the repository. None of that is what
 * the contract test is for -- the test asserts the SHAPE of the envelope and
 * that `client.post` unwraps tasks[0].result -- so the values are replaced
 * with stable placeholders and the structure is kept intact.
 *
 * `price` and `rates` are left alone: they carry no identity, and the rate
 * card is the whole reason to look at this endpoint.
 * ======================================================================
 */
function redactUserData(payload: unknown): unknown {
  const p = payload as {
    tasks?: Array<{
      result?: Array<{
        login?: string
        timezone?: string
        money?: { total?: number; balance?: number }
      }> | null
    }>
  }
  const row = p?.tasks?.[0]?.result?.[0]
  if (!row) return payload

  /**
   * These are the values the fixture carried before it was ever captured, kept
   * so the account's real figures never land in git and the long-standing
   * client tests keep their meaning. The balance must stay ABOVE ZERO --
   * fetchAccountStatus derives `canMakeRequests` from `balance > 0`, so
   * redacting it to 0 would turn the healthy-account fixture into a
   * suspended-account one and quietly invert what that test proves.
   */
  row.login = 'operator@example.com'
  row.timezone = 'UTC'
  if (row.money) {
    row.money.total = 100
    row.money.balance = 41.7382
  }
  return payload
}

/** Trim the enormous locations dump to a representative sample before writing. */
function sampleLocations(payload: unknown): unknown {
  const p = payload as {
    tasks?: Array<{ result?: Array<{ location_name?: string; location_type?: string }> | null }>
  }
  const rows = p?.tasks?.[0]?.result
  if (!Array.isArray(rows)) return payload

  const wanted = [
    'Kenosha,Wisconsin,United States',
    'Wisconsin,United States',
    'McKinney,Collin County,Texas,United States',
    'Orange,Orange,California,United States',
    'Kenosha County,Wisconsin,United States',
    'Milwaukee WI,United States',
  ]
  const picked = rows.filter((r) => r.location_name && wanted.includes(r.location_name))
  // Plus one row of each distinct type, so the type vocabulary is on record.
  const seenTypes = new Set(picked.map((r) => r.location_type))
  for (const r of rows) {
    if (r.location_type && !seenTypes.has(r.location_type)) {
      seenTypes.add(r.location_type)
      picked.push(r)
    }
  }
  p.tasks![0]!.result = picked
  return { ...p, __probe_note: `sampled ${picked.length} of ${rows.length} rows` }
}

/**
 * `--only a,b` limits the run to named steps.
 *
 * Without it, re-capturing a single $0.002 fixture that came back empty costs
 * the $0.078 price of the whole sheet.
 */
function selectedSteps(): Step[] {
  const all = [...FREE_STEPS, ...PAID_STEPS]
  const flag = process.argv.find((a) => a.startsWith('--only'))
  if (!flag) return all
  const raw = flag.includes('=') ? flag.split('=')[1] : process.argv[process.argv.indexOf(flag) + 1]
  const names = (raw ?? '').split(',').map((n) => n.trim()).filter(Boolean)
  if (names.length === 0) return all
  const unknown = names.filter((n) => !all.some((s) => s.name === n))
  if (unknown.length > 0) {
    console.error(`
Unknown step(s): ${unknown.join(', ')}`)
    console.error(`Known: ${all.map((s) => s.name).join(', ')}
`)
    process.exit(1)
  }
  return all.filter((s) => names.includes(s.name))
}

async function main(): Promise<void> {
  const login = process.env['DATAFORSEO_LOGIN']
  const password = process.env['DATAFORSEO_PASSWORD']
  if (!login || !password) {
    console.error(
      '\nDATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set.\n' +
        'Copy .env.example to .env and fill them in, then re-run.\n',
    )
    process.exit(1)
  }

  const client = new DataForSeoClient({ credentials: { login, password } })

  // --- Free preflight -----------------------------------------------------
  console.log('\nChecking account status (free)...')
  let status
  try {
    status = await fetchAccountStatus(client)
  } catch (e) {
    if (e instanceof AccountIssueError) {
      console.error(`\nACCOUNT PROBLEM: ${e.message}\nNothing was spent. Aborting.\n`)
      process.exit(1)
    }
    throw e
  }

  console.log(`  login:   ${status.login}`)
  console.log(`  balance: $${status.balanceUsd.toFixed(4)}`)
  console.log(`  usable:  ${status.canMakeRequests ? 'yes' : 'NO'}`)

  if (!status.canMakeRequests) {
    console.error('\nBalance is zero or unavailable. Aborting before spending anything.\n')
    process.exit(1)
  }

  // --- Cost estimate ------------------------------------------------------
  const steps = selectedSteps()
  const freeSteps = steps.filter((s) => s.costMicros === 0n)
  const paidSteps = steps.filter((s) => s.costMicros !== 0n)
  const total = sumMicros(paidSteps.map((s) => s.costMicros))
  console.log('\nThis will capture the following:\n')
  for (const s of freeSteps) console.log(`  free    ${s.name.padEnd(24)} ${s.path}`)
  for (const s of paidSteps) {
    console.log(`  ${formatMicrosUsd(s.costMicros).padEnd(8)}${s.name.padEnd(24)} ${s.path}`)
  }
  console.log(`\n  TOTAL:  ${formatMicrosUsd(total)}  (${paidSteps.length} paid calls)\n`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question('Proceed and spend this? Type "yes" to continue: ')).trim()
  rl.close()
  if (answer !== 'yes') {
    console.log('Aborted. Nothing was spent.\n')
    process.exit(0)
  }

  // --- Capture ------------------------------------------------------------
  const credentials = { login, password }
  let spent = 0n
  const failures: string[] = []

  for (const step of steps) {
    process.stdout.write(`  capturing ${step.name.padEnd(24)}`)
    try {
      let payload = await captureFullEnvelope(credentials, step, BODIES[step.name] ?? null)
      if (step.name === 'locations') payload = sampleLocations(payload)
      if (step.name === 'user_data') payload = redactUserData(payload)

      // Record the task-level status even when it is a failure: a captured
      // failure is more useful than no capture, and the contract tests read it.
      const taskStatus = (payload as { tasks?: Array<{ status_code?: number }> })?.tasks?.[0]
        ?.status_code
      const taskOk = taskStatus === 20000
      writeContract(step.name, payload, `captured live from ${step.path}`, taskOk)
      spent += step.costMicros
      console.log(taskOk ? 'ok' : `wrote, but task status ${taskStatus} — left UNVERIFIED`)
      if (!taskOk) failures.push(`${step.name} (task status ${taskStatus})`)
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message.slice(0, 120)}`)
      failures.push(step.name)
      if (e instanceof AccountIssueError) {
        console.error('\nAccount issue mid-probe. Stopping.\n')
        break
      }
    }
  }

  console.log(`\nSpent approximately ${formatMicrosUsd(spent)}.`)
  if (failures.length > 0) {
    console.log(`\nIncomplete: ${failures.join(', ')}`)
    console.log(
      'Those were captured but the task itself failed, so they stay marked\n' +
        'unverified and the provenance gate will keep reporting them. Re-run to retry.',
    )
  }
  console.log('\nNow run:  pnpm test\n')
  console.log('If a field assertion breaks, the mechanism worked. Fix the adapter, not the fixture.\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
