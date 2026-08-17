import { registrableDomain } from '../domains/normalize.js'

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'msclkid',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
])

export function normalizeHhtBlDomain(value: string | null | undefined): string | null {
  return registrableDomain(value)?.domain ?? null
}

export function normalizeHhtBlUrl(value: string | null | undefined): string | null {
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

export interface DedupedBacklinkInput {
  sourceUrl: string
  targetUrl: string
  researchSite: string
  [key: string]: unknown
}

export function exactBacklinkKey(input: DedupedBacklinkInput): string | null {
  const source = normalizeHhtBlUrl(input.sourceUrl)
  const target = normalizeHhtBlUrl(input.targetUrl)
  const site = normalizeHhtBlDomain(input.researchSite)
  if (!source || !target || !site) return null
  return `${source}\n${target}\n${site}`
}

export function referringRelationshipKey(input: DedupedBacklinkInput): string | null {
  const referring = normalizeHhtBlDomain(input.sourceUrl)
  const site = normalizeHhtBlDomain(input.researchSite)
  if (!referring || !site) return null
  return `${referring}\n${site}`
}

export function dedupeHhtBlBacklinks<T extends DedupedBacklinkInput>(rows: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) {
    const key = exactBacklinkKey(row)
    if (key && !byKey.has(key)) byKey.set(key, row)
  }
  return [...byKey.values()]
}

