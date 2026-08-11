/**
 * Push production environment variables to Vercel, derived from .env.
 *
 * ==================== WHY A SCRIPT AND NOT `vercel env add` BY HAND ====================
 * Every one of these values is a live credential, and the failure mode of typing them into
 * a terminal one at a time is a silently truncated secret that fails days later as an
 * unexplained 401. Reading them from the file that already works removes transcription
 * from the process entirely.
 *
 * Two values are DERIVED rather than copied, because copying them would be wrong:
 *   DATABASE_URL          -- port 6543, the transaction pooler. .env holds 5432 (session),
 *                            which is correct locally and exhausts under serverless load.
 *   DIRECT_DATABASE_URL   -- the 5432 URL, which is what drizzle-kit needs.
 *
 * PRODUCTION TARGET ONLY. A preview deployment carrying these would answer real phone
 * calls, send real texts and spend real money against the same accounts.
 * ====================================================================================
 *
 *   npx tsx packages/data/src/scripts/vercel-env.mts            # show the plan
 *   npx tsx packages/data/src/scripts/vercel-env.mts --confirm   # write it
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CONFIRM = process.argv.includes('--confirm')

function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out.set(line.slice(0, eq).trim(), value)
  }
  return out
}

const local = parseEnvFile(`${ROOT}.env`)
const auth = JSON.parse(
  readFileSync(`${process.env['APPDATA']}/com.vercel.cli/Data/auth.json`, 'utf8'),
) as { token: string }
const project = JSON.parse(readFileSync(`${ROOT}.vercel/project.json`, 'utf8')) as {
  projectId: string
  orgId: string
}

/** The transaction pooler, derived from the session-pooler URL in .env. */
function pooled(url: string, port: string): string {
  const u = new URL(url)
  u.port = port
  return u.toString()
}

const dbUrl = local.get('DATABASE_URL')
if (!dbUrl) throw new Error('DATABASE_URL is missing from .env')

const publicBaseUrl = process.env['DEPLOY_BASE_URL']?.trim()
if (!publicBaseUrl) {
  throw new Error(
    'DEPLOY_BASE_URL is not set. Pass the production URL, e.g.\n' +
      '  DEPLOY_BASE_URL=https://rank-and-rent.vercel.app npx tsx ...',
  )
}

const cronSecret =
  local.get('CRON_SECRET') ||
  // 32 bytes of real randomness. Generated once and echoed at the end so it can be put
  // into .env too -- the local worker does not need it, but `curl`ing the drain route does.
  (await import('node:crypto')).randomBytes(32).toString('hex')

/** Copied verbatim from .env. Missing or empty is a hard error, not a skip. */
const REQUIRED = [
  'LIVE_CALLS_ENABLED',
  'RETELL_API_KEY',
  'RETELL_AGENT_ID',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TRUNK_SID',
  'TWILIO_TERMINATION_URI',
  'TWILIO_SIP_CRED_USERNAME',
  'TWILIO_SIP_CRED_PASSWORD',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'SCAN_BUDGET_CAP_CENTS',
] as const

/**
 * Google Ads Keyword Planner (volume). All-or-nothing: partial config would
 * silently skip volume and look like zero demand.
 */
const GOOGLE_ADS = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_API_VERSION',
] as const

/**
 * Money ceilings, set EXPLICITLY in production even though the code has defaults.
 *
 * A spend cap that comes from a code default is a spend cap that can change under you in a
 * refactor, with the first evidence being the invoice. Written out so the value in effect is
 * visible in the dashboard next to the credentials it governs.
 */
const WITH_DEFAULTS: Record<string, string> = {
  SERP_MONITOR_DAILY_CAP_CENTS: '17', // ~$5/month per market
  GOOGLE_ADS_API_VERSION: 'v21',
}

const plan = new Map<string, string>()

// Derived first, so a stale DATABASE_URL in .env cannot leak through as production's.
plan.set('DATABASE_URL', pooled(dbUrl, '6543'))
plan.set('DIRECT_DATABASE_URL', pooled(dbUrl, '5432'))
plan.set('PUBLIC_BASE_URL', publicBaseUrl.replace(/\/$/, ''))
plan.set('CRON_SECRET', cronSecret)

const missing: string[] = []
for (const key of REQUIRED) {
  const value = local.get(key)
  if (!value) {
    missing.push(key)
    continue
  }
  plan.set(key, value)
}

for (const [key, fallback] of Object.entries(WITH_DEFAULTS)) {
  plan.set(key, local.get(key) || fallback)
}

const googleAdsMissing: string[] = []
for (const key of GOOGLE_ADS) {
  if (key === 'GOOGLE_ADS_API_VERSION') {
    plan.set(key, local.get(key) || WITH_DEFAULTS['GOOGLE_ADS_API_VERSION'] || 'v21')
    continue
  }
  const value = local.get(key)
  if (!value) {
    googleAdsMissing.push(key)
    continue
  }
  plan.set(key, value)
}

if (missing.length > 0) {
  console.error(`These are empty or absent in .env, so production would be misconfigured:`)
  for (const k of missing) console.error(`  - ${k}`)
  process.exit(1)
}

if (googleAdsMissing.length > 0) {
  console.error(`Google Ads volume incomplete in .env (all required for promote volume):`)
  for (const k of googleAdsMissing) console.error(`  - ${k}`)
  process.exit(1)
}

/**
 * LIVE_CALLS_ENABLED is checked against the EXACT string, here as well as at runtime.
 * "TRUE", "1" and "yes" all mean fixtures, which would look like a working deploy that
 * answers no real calls.
 */
if (plan.get('LIVE_CALLS_ENABLED') !== 'true') {
  console.error(
    `LIVE_CALLS_ENABLED in .env is ${JSON.stringify(plan.get('LIVE_CALLS_ENABLED'))}, not the ` +
      `exact string "true". Production would route every provider call to fixtures.`,
  )
  process.exit(1)
}

/**
 * RECORDINGS_DIR is deliberately NOT pushed: its absence, together with a blob token, is
 * what selects the Blob backend. Pushing it would send recordings to a filesystem that
 * does not survive the invocation.
 */
const NEVER_PUSH = ['RECORDINGS_DIR', 'DATABASE_SCHEMA', 'E2E_DATABASE_URL']

function mask(v: string): string {
  if (v.length <= 8) return '*'.repeat(v.length)
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`
}

const SHOW_PLAINLY = new Set([
  'LIVE_CALLS_ENABLED',
  'PUBLIC_BASE_URL',
  'SCAN_BUDGET_CAP_CENTS',
  'SERP_MONITOR_DAILY_CAP_CENTS',
  'TWILIO_TERMINATION_URI',
])

console.log(`Project : ${project.projectId}`)
console.log(`Target  : production only\n`)
for (const [k, v] of plan) {
  console.log(`  ${k.padEnd(30)} ${SHOW_PLAINLY.has(k) ? v : mask(v)}`)
}
console.log(`\n  not pushed: ${NEVER_PUSH.join(', ')}`)
console.log(`  BLOB_READ_WRITE_TOKEN is added by \`vercel blob store add\`, not by this script.`)

if (!CONFIRM) {
  console.log(`\nDry run. Re-run with --confirm to write these.`)
  process.exit(0)
}

const base = `https://api.vercel.com/v10/projects/${project.projectId}/env?teamId=${project.orgId}&upsert=true`

let wrote = 0
for (const [key, value] of plan) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      value,
      type: 'encrypted',
      target: ['production'],
    }),
  })
  if (!res.ok) {
    console.error(`  ${key}: FAILED ${res.status} ${JSON.stringify(await res.json())}`)
    continue
  }
  wrote += 1
  console.log(`  ${key}: ok`)
}

console.log(`\n${wrote}/${plan.size} written to production.`)
if (!local.get('CRON_SECRET')) {
  console.log(`\nAdd this to .env so you can call the drain route by hand:`)
  console.log(`CRON_SECRET=${cronSecret}`)
}
