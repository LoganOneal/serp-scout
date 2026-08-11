import type { RdapFacts } from '@rnr/core'

/**
 * Stage 3d — the full registration record, not just "is it taken".
 *
 * `providers/rdap.ts` answers one question (is this EMD free?) for .com only.
 * Enrich mode needs the creation date, the expiry, the registrar and the EPP
 * status codes, across whatever TLD a local business happens to sit on, so this
 * resolves the right registry through the IANA bootstrap file instead of
 * hardcoding Verisign.
 *
 * The three-state discipline from the older module carries over unchanged:
 * `registered: null` means the registry did not answer, and must never be read
 * as available.
 */

/** IANA's authoritative map of TLD -> registry RDAP base URL. */
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/** Used until the bootstrap file loads, and if it ever fails to. */
const FALLBACK_SERVICES: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
}

interface BootstrapFile {
  services?: Array<[string[], string[]]>
}

let bootstrapCache: Map<string, string> | null = null
let bootstrapInFlight: Promise<Map<string, string>> | null = null

async function loadBootstrap(fetchImpl: typeof fetch): Promise<Map<string, string>> {
  if (bootstrapCache) return bootstrapCache
  if (bootstrapInFlight) return bootstrapInFlight

  bootstrapInFlight = (async () => {
    const map = new Map<string, string>(Object.entries(FALLBACK_SERVICES))
    try {
      const res = await fetchImpl(BOOTSTRAP_URL, { headers: { Accept: 'application/json' } })
      if (res.ok) {
        const body = (await res.json()) as BootstrapFile
        for (const [tlds, urls] of body.services ?? []) {
          const url = urls.find((u) => u.startsWith('https://')) ?? urls[0]
          if (!url) continue
          for (const tld of tlds) map.set(tld.toLowerCase(), url.endsWith('/') ? url : `${url}/`)
        }
      }
    } catch {
      // Fallback table already seeded; .com/.net/.org cover most local business
      // domains, and an unknown TLD simply yields `registered: null`.
    }
    bootstrapCache = map
    return map
  })()

  return bootstrapInFlight
}

/** Test seam — lets a suite install a known service map. */
export function __setRdapBootstrap(map: Map<string, string> | null): void {
  bootstrapCache = map
  bootstrapInFlight = null
}

interface RdapEvent {
  eventAction?: string
  eventDate?: string
}

interface RdapEntity {
  roles?: string[]
  vcardArray?: unknown
}

interface RdapResponse {
  events?: RdapEvent[]
  status?: string[]
  entities?: RdapEntity[]
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function eventDate(events: RdapEvent[], action: string): Date | null {
  const hit = events.find((e) => (e.eventAction ?? '').toLowerCase() === action)
  return parseDate(hit?.eventDate)
}

/**
 * Registrar name out of the jCard blob.
 *
 * vcardArray is `["vcard", [["version",{},"text","4.0"], ["fn",{},"text","Name"]]]`,
 * which is awkward enough to be worth isolating here rather than inline.
 */
function registrarName(entities: RdapEntity[]): string | null {
  const registrar = entities.find((e) => (e.roles ?? []).includes('registrar'))
  const vcard = registrar?.vcardArray
  if (!Array.isArray(vcard) || vcard.length < 2) return null
  const fields = vcard[1]
  if (!Array.isArray(fields)) return null
  for (const field of fields) {
    if (Array.isArray(field) && field[0] === 'fn' && typeof field[3] === 'string') {
      return field[3]
    }
  }
  return null
}

export interface RdapRecordResult extends RdapFacts {
  lastChangedAt: Date | null
  httpStatus: number | null
  detail: string
}

const UNKNOWN = (detail: string): RdapRecordResult => ({
  registered: null,
  createdAt: null,
  expiresAt: null,
  registrar: null,
  statuses: [],
  lastChangedAt: null,
  httpStatus: null,
  detail,
})

export interface RdapRecordOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function fetchRdapRecord(
  domain: string,
  opts: RdapRecordOptions = {},
): Promise<RdapRecordResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const d = domain.trim().toLowerCase()
  const tld = d.split('.').pop() ?? ''
  if (!tld) return UNKNOWN('Domain has no TLD.')

  const services = await loadBootstrap(fetchImpl)
  const base = services.get(tld)
  if (!base) {
    return UNKNOWN(`No RDAP service is published for .${tld}; registration data is unavailable.`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await fetchImpl(`${base}domain/${encodeURIComponent(d)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' },
    })

    if (res.status === 404) {
      return {
        ...UNKNOWN('Registry has no record of this domain.'),
        registered: false,
        httpStatus: 404,
        detail: 'Registry has no record of this domain.',
      }
    }
    if (res.status !== 200) {
      // 429 above all: rate limiting says nothing about the domain.
      return { ...UNKNOWN(`RDAP returned HTTP ${res.status}, which is not an answer.`), httpStatus: res.status }
    }

    const body = (await res.json()) as RdapResponse
    const events = body.events ?? []
    return {
      registered: true,
      createdAt: eventDate(events, 'registration'),
      expiresAt: eventDate(events, 'expiration'),
      lastChangedAt: eventDate(events, 'last changed'),
      registrar: registrarName(body.entities ?? []),
      statuses: (body.status ?? []).map((s) => s.toLowerCase()),
      httpStatus: 200,
      detail: 'Registry returned a registration record.',
    }
  } catch (e) {
    return UNKNOWN(`RDAP request failed (${(e as Error).name}: ${(e as Error).message}).`)
  } finally {
    clearTimeout(timer)
  }
}

/** RDAP is free and unauthenticated; the cost of impatience is a 429. */
export const RDAP_RECORD_THROTTLE_MS = 250
