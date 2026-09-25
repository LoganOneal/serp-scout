/**
 * Company-domain canonicalization for Attio.
 *
 * This is not the acquisition helper in domains/normalize.ts. Outreach
 * identifies a hotel or publication by the host people actually visit, so
 * `flagstaff.littleamerica.com` stays a subdomain instead of collapsing to
 * the registrable parent.
 */

const OTA_AND_PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  'booking.com',
  'kayak.com',
  'expedia.com',
  'hotels.com',
  'tripadvisor.com',
  'airbnb.com',
  'vrbo.com',
  'tubstays.com',
  'tubhotels.com',
  'hotelhottubs.com',
])

export interface CanonicalDomain {
  /** Hostname used as the Attio Company domain. */
  domain: string
  host: string
  websiteUrl: string
}

export function stripProtocolAndWww(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
}

export function canonicalCompanyDomain(input: string | null | undefined): CanonicalDomain | null {
  if (!input?.trim()) return null
  const raw = input.trim()
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  if (!host.includes('.')) return null
  return {
    domain: host,
    host,
    websiteUrl: `https://${host}`,
  }
}

/** True when a URL is an OTA/affiliate listing rather than the target's own site. */
export function isNonOfficialHotelHost(input: string | null | undefined): boolean {
  const canonical = canonicalCompanyDomain(input)
  if (!canonical) return true
  const parts = canonical.domain.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.')
    if (OTA_AND_PLATFORM_HOSTS.has(candidate)) return true
  }
  return false
}

export function officialCompanyDomain(input: string | null | undefined): CanonicalDomain | null {
  const canonical = canonicalCompanyDomain(input)
  if (!canonical) return null
  if (isNonOfficialHotelHost(canonical.domain)) return null
  return canonical
}

export function canonicalPageUrl(input: string | null | undefined): string | null {
  if (!input?.trim()) return null
  const raw = input.trim()
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  parsed.protocol = 'https:'
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  parsed.hash = ''
  parsed.search = ''
  if (parsed.port === '80' || parsed.port === '443') parsed.port = ''
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  return parsed.toString()
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input?.trim()) return null
  const deobfuscated = input
    .trim()
    .replace(/\s*\[at\]\s*/gi, '@')
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s*\(dot\)\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '')
    .toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deobfuscated)) return null
  return deobfuscated
}

export function extractExplicitEmail(text: string | null | undefined): string | null {
  if (!text?.trim()) return null
  const obfuscated = text.match(/([A-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*([A-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s|\.)\s*([A-Z]{2,})/i)
  if (obfuscated) {
    return normalizeEmail(`${obfuscated[1]}@${obfuscated[2]}.${obfuscated[3]}`)
  }
  const direct = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return direct ? normalizeEmail(direct[0]) : null
}

export function nameKey(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}
