import { resolveNs } from 'node:dns/promises'

/**
 * Domain availability via RDAP -- the registry's own protocol.
 *
 * Verisign runs the authoritative .com registry, so this is not a guess or a
 * reseller's cached view: 404 means the registry has no record of the domain.
 * Free, no auth, structured JSON.
 *
 * Verified live 2026-08-02:
 *   google.com                  -> 200 (registered)
 *   kenoshaplumbing.com         -> 200 (registered)
 *   kenoshatreeserviceco9x.com  -> 404 (available)
 *
 * ======================= THREE STATES, NOT TWO =======================
 * true  = confirmed available   (HTTP 404 from the registry)
 * false = confirmed registered  (HTTP 200)
 * null  = COULD NOT TELL        (429, 5xx, timeout, malformed body, network)
 *
 * `null` must never collapse into `true`. A rate-limited registry is not a yes.
 * The 30-day verdict gate requires `true` specifically, so a null here blocks
 * the only band that tells someone to go buy a domain -- which is the entire
 * point of keeping the third state.
 * =====================================================================
 */

export type Availability = true | false | null

export interface AvailabilityResult {
  domain: string
  available: Availability
  method: 'rdap' | 'dns' | 'none'
  httpStatus: number | null
  detail: string
}

/** .com only. An EMD works because it reads as the obvious business name, and
 * .net does not carry that -- so there is no point checking other TLDs. */
const RDAP_BASE = 'https://rdap.verisign.com/com/v1/domain'

export interface RdapOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Resolver injection for tests. */
  resolveNsImpl?: (hostname: string) => Promise<string[]>
}

export async function checkAvailability(
  domain: string,
  opts: RdapOptions = {},
): Promise<AvailabilityResult> {
  const d = domain.trim().toLowerCase()
  if (!d.endsWith('.com')) {
    return {
      domain: d,
      available: null,
      method: 'none',
      httpStatus: null,
      detail: 'Only .com is checked; RDAP endpoint here is the Verisign .com registry.',
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let status: number | null = null
  try {
    const res = await fetchImpl(`${RDAP_BASE}/${encodeURIComponent(d)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' },
    })
    status = res.status

    if (res.status === 404) {
      return {
        domain: d,
        available: true,
        method: 'rdap',
        httpStatus: 404,
        detail: 'Registry has no record of this domain.',
      }
    }
    if (res.status === 200) {
      return {
        domain: d,
        available: false,
        method: 'rdap',
        httpStatus: 200,
        detail: 'Registry returned a registration record.',
      }
    }

    // ANY other status. Explicitly NOT available -- unknown.
    // 429 in particular: being rate-limited tells us nothing about the domain,
    // and reading it as "available" would send someone to buy a taken name.
    const fallback = await dnsFallback(d, opts)
    return {
      ...fallback,
      httpStatus: res.status,
      detail: `RDAP returned HTTP ${res.status}, which is not an answer. ${fallback.detail}`,
    }
  } catch (e) {
    const fallback = await dnsFallback(d, opts)
    return {
      ...fallback,
      httpStatus: status,
      detail: `RDAP request failed (${(e as Error).name}: ${(e as Error).message}). ${fallback.detail}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * DNS nameserver fallback. ASYMMETRIC ON PURPOSE.
 *
 * Nameservers present  -> the domain is registered            -> false
 * Nameservers ABSENT   -> proves NOTHING                      -> null
 *
 * A registered domain can easily have no NS records: parked without delegation,
 * newly registered, expired-but-not-released, or held by a registrar. So the
 * absence of nameservers cannot be upgraded to "available" -- only the presence
 * of them is evidence, and it is evidence in one direction only.
 */
async function dnsFallback(domain: string, opts: RdapOptions): Promise<AvailabilityResult> {
  const resolver = opts.resolveNsImpl ?? resolveNs
  try {
    const ns = await resolver(domain)
    if (ns.length > 0) {
      return {
        domain,
        available: false,
        method: 'dns',
        httpStatus: null,
        detail: `DNS fallback found ${ns.length} nameserver(s), which proves the domain is registered.`,
      }
    }
    return {
      domain,
      available: null,
      method: 'dns',
      httpStatus: null,
      detail:
        'DNS fallback found no nameservers, which proves nothing -- registered domains are routinely undelegated.',
    }
  } catch {
    return {
      domain,
      available: null,
      method: 'dns',
      httpStatus: null,
      detail:
        'DNS fallback failed or returned NXDOMAIN, which proves nothing about registration.',
    }
  }
}

/**
 * PRIOR. Politeness delay between registry requests. RDAP is free and
 * unauthenticated; hammering it earns a 429, which -- correctly -- yields `null`
 * rather than a wrong answer, so the cost of being impolite is lost coverage.
 */
export const RDAP_THROTTLE_MS = 250

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sequential and throttled. Availability checks are free, so there is no reason to rush. */
export async function checkAvailabilityBatch(
  domains: string[],
  opts: RdapOptions & { throttleMs?: number } = {},
): Promise<Map<string, AvailabilityResult>> {
  const out = new Map<string, AvailabilityResult>()
  const throttle = opts.throttleMs ?? RDAP_THROTTLE_MS
  let first = true
  for (const domain of domains) {
    if (!first) await sleep(throttle)
    first = false
    out.set(domain.toLowerCase(), await checkAvailability(domain, opts))
  }
  return out
}

/** The candidate EMD for a (locality, niche) cell. */
export function emdDomain(localityName: string, nicheEmdToken: string): string {
  const city = localityName.toLowerCase().replace(/[^a-z0-9]/g, '')
  const niche = nicheEmdToken.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${city}${niche}.com`
}
