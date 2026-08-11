import { Resolver } from 'node:dns/promises'
import type { DnsTriage } from '@rnr/core'

/**
 * Stage 3a/3b — the cheapest question we can ask about a domain.
 *
 * DNS is free and answers in milliseconds, so it runs before anything that
 * costs money or seconds. A domain with no nameservers, or nameservers pointing
 * at a parking operator, is already interesting enough to advance without ever
 * opening an HTTP connection.
 */

/**
 * Nameservers that mean "this domain is inventory, not a business".
 *
 * Matched as substrings against the lowercased nameserver hostname, which is
 * why `uniregistry` covers `ns1.uniregistry.net` and friends without a pattern.
 */
export const PARKING_NAMESERVERS: readonly string[] = [
  'sedoparking',
  'above.com',
  'bodis',
  'parkingcrew',
  'dan.com',
  'afternic',
  'hugedomains',
  'uniregistry',
  'parklogic',
  'sedo.com',
  'domainmarket',
  'namefind', // GoDaddy's own for-sale inventory
  'cashparking',
  'parking.',
  'undeveloped',
  'brandbucket',
  'squadhelp',
]

/** Public resolvers, so a flaky local DNS setup does not read as a dead domain. */
const RESOLVER_ADDRESSES = ['1.1.1.1', '8.8.8.8']

export interface DnsTriageResult extends DnsTriage {
  nameservers: string[]
  addresses: string[]
  /**
   * Mail exchangers. Free to ask for, and a domain running mail is usually a
   * going concern -- though mail routinely outlives a website, so this informs
   * rather than decides.
   */
  mxCount: number
  /** True when lookups failed for a reason other than "no such record". */
  errored: boolean
}

function matchParking(nameservers: string[]): string | null {
  for (const ns of nameservers) {
    const lower = ns.toLowerCase()
    const hit = PARKING_NAMESERVERS.find((p) => lower.includes(p))
    if (hit) return ns
  }
  return null
}

/**
 * NXDOMAIN and NODATA are answers; everything else is a failure.
 *
 * The distinction matters more than it looks. "No A record" advances a domain
 * to the next stage; "the resolver timed out" must not, or a network blip
 * silently turns live businesses into acquisition candidates.
 */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ENXDOMAIN'])

async function resolveOrNull(
  fn: () => Promise<string[]>,
): Promise<{ records: string[]; errored: boolean }> {
  try {
    return { records: await fn(), errored: false }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (NO_RECORD_CODES.has(code)) return { records: [], errored: false }
    return { records: [], errored: true }
  }
}

export async function dnsTriage(
  domain: string,
  opts: { timeoutMs?: number } = {},
): Promise<DnsTriageResult> {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? 5_000, tries: 2 })
  resolver.setServers([...RESOLVER_ADDRESSES])

  const ns = await resolveOrNull(() => resolver.resolveNs(domain))
  const [v4, v6, mx] = await Promise.all([
    resolveOrNull(() => resolver.resolve4(domain)),
    resolveOrNull(() => resolver.resolve6(domain)),
    resolveOrNull(async () => (await resolver.resolveMx(domain)).map((m) => m.exchange)),
  ])

  const nameservers = ns.records.map((n) => n.toLowerCase())
  const addresses = [...v4.records, ...v6.records]

  return {
    nameservers,
    addresses,
    hasNameservers: nameservers.length > 0,
    parkingNameserver: matchParking(nameservers),
    hasAddressRecord: addresses.length > 0,
    mxCount: mx.records.length,
    errored: ns.errored || v4.errored || v6.errored,
  }
}
