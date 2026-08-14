import 'dotenv/config'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'
import { registrableDomain, NON_ACQUIRABLE_HOSTS } from '@rnr/core'

/**
 * P2 — do the domains linking TO a local citation hub skew LOCAL?
 *
 * ==================== THE COMPLEMENT TO THE NAME-TOKEN ROUTE ====================
 * The WHOIS database (P1) finds domains whose NAME contains a city or niche
 * token. That misses every local business trading as `acmeservices.com` -- which
 * is most of them.
 *
 * This is the other half: a local business is linked from local things -- the
 * chamber, the paper, the city's contractor list -- and those pages OUTLIVE the
 * business. Ask who links to one hub and you get a locality-scoped list of
 * businesses, living and dead, regardless of what they called themselves.
 *
 * The economics are the point: cost is per HUB, not per domain found.
 * ==============================================================================
 *
 * Measured at $0.025/target by this repo's own balance-delta reading
 * (domain-search-backlog §3). This probe verifies that price and the skew.
 */

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing in .env')
  process.exit(1)
}

const client = new DataForSeoClient({ credentials: { login, password }, timeoutMs: 120_000 })
const REFERRING_DOMAINS = '/backlinks/referring_domains/live'

/**
 * One hub. Kept to a single target so the probe costs $0.025, not $0.125 --
 * the question is whether the skew exists at all, and one hub answers it.
 *
 * kenoshanews.com was chosen over a chamber domain because P1 already measured
 * it at 7,564 referring domains, so there is a real population to look at.
 */
const HUB = process.argv[2] ?? 'kenoshanews.com'
const LOCALITY_TOKENS = (process.argv[3] ?? 'kenosha,wisconsin,wi,racine,pleasantprairie')
  .split(',')
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean)

interface RefDomainItem {
  domain?: string
  rank?: number
  backlinks?: number
  first_seen?: string
  lost_date?: string | null
  broken_backlinks?: number
}

const balance = async (): Promise<number> => (await fetchAccountStatus(client)).balanceUsd

const opening = await balance()
console.log(`Hub: ${HUB}`)
console.log(`Locality tokens: ${LOCALITY_TOKENS.join(', ')}`)
console.log(`Opening balance: $${opening.toFixed(4)}\n`)

const res = await client.post<Array<{ total_count?: number; items?: RefDomainItem[] }>>(
  REFERRING_DOMAINS,
  [
    {
      target: HUB,
      limit: 1000,
      /** Weakest profiles first: a local plumber is not a high-rank domain. */
      order_by: ['rank,asc'],
      backlinks_status_type: 'all',
    },
  ],
)

const closing = await balance()
const row = Array.isArray(res) ? res[0] : undefined
const items = row?.items ?? []

console.log(`cost (balance delta): $${(opening - closing).toFixed(6)}`)
console.log(`total referring domains: ${row?.total_count ?? '—'}   returned: ${items.length}\n`)

let acquirable = 0
let localHits = 0
const localDomains: RefDomainItem[] = []

for (const it of items) {
  const n = registrableDomain(it.domain ?? null)
  if (!n || n.nonAcquirable || NON_ACQUIRABLE_HOSTS.has(n.domain)) continue
  acquirable += 1
  if (LOCALITY_TOKENS.some((t) => n.domain.includes(t))) {
    localHits += 1
    localDomains.push(it)
  }
}

console.log(`acquirable (platforms/directories removed): ${acquirable}`)
console.log(
  `locality-token matches: ${localHits}` +
    ` (${((localHits / Math.max(1, acquirable)) * 100).toFixed(1)}% of acquirable)`,
)

console.log(`\nLOCALITY-TOKEN DOMAINS (the ones a name-token WHOIS query would also find):`)
for (const d of localDomains.slice(0, 25)) {
  console.log(
    `  ${String(d.domain).padEnd(40)} rank ${String(d.rank ?? '—').padStart(4)}` +
      ` backlinks ${String(d.backlinks ?? '—').padStart(6)}` +
      ` lost ${d.lost_date ?? '—'}`,
  )
}

/**
 * The whole point of this route: domains with NO locality token in the name.
 * A WHOIS name query can never reach these, and they are most local businesses.
 */
console.log(`\nLOW-RANK ACQUIRABLE DOMAINS WITHOUT A LOCALITY TOKEN (the unique yield):`)
let shown = 0
for (const it of items) {
  if (shown >= 25) break
  const n = registrableDomain(it.domain ?? null)
  if (!n || n.nonAcquirable || NON_ACQUIRABLE_HOSTS.has(n.domain)) continue
  if (LOCALITY_TOKENS.some((t) => n.domain.includes(t))) continue
  console.log(
    `  ${n.domain.padEnd(40)} rank ${String(it.rank ?? '—').padStart(4)}` +
      ` backlinks ${String(it.backlinks ?? '—').padStart(6)}` +
      ` lost ${it.lost_date ?? '—'}`,
  )
  shown += 1
}

console.log(`\nClosing balance: $${closing.toFixed(4)}`)
