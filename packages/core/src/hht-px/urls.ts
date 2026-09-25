import { registrableDomain } from '../domains/normalize.js'

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'utm_campaign',
  'utm_content',
  'utm_id',
  'utm_medium',
  'utm_source',
  'utm_term',
  'utm_referrer',
  'ref',
  'referrer',
  'source',
])

export function normalizeHhtPxUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const raw = value.trim()
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
  if (parsed.port === '80' || parsed.port === '443') parsed.port = ''

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key)
  }
  parsed.searchParams.sort()
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  return parsed.toString()
}

export function hhtPxRootDomain(value: string | null | undefined): string | null {
  return registrableDomain(value)?.domain ?? null
}

export function hhtPxHost(value: string | null | undefined): string | null {
  const normalized = normalizeHhtPxUrl(value)
  if (!normalized) return null
  try {
    return new URL(normalized).hostname
  } catch {
    return null
  }
}

export function hhtPxSubdomain(value: string | null | undefined): string | null {
  const host = hhtPxHost(value)
  const root = hhtPxRootDomain(value)
  if (!host || !root) return null
  if (host === root) return null
  const suffix = `.${root}`
  if (!host.endsWith(suffix)) return null
  const prefix = host.slice(0, -suffix.length)
  return prefix || null
}

/** Visible article name when Semrush MCP organic rows have no title. */
export function hhtPxArticleLabel(title: string | null | undefined, url: string): string {
  const trimmed = title?.trim()
  if (trimmed) return trimmed
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? ''
    const words = decodeURIComponent(slug)
      .replace(/\.(html?|php|aspx)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    return words || url
  } catch {
    return url
  }
}
