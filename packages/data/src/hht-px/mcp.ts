import { normalizeRows, numOrNull } from '../opportunity-miner/semrush/normalize.js'

export const HHT_PX_MCP_SERP_MESSAGE =
  'SERP collection uses Semrush MCP phrase_organic. The HTTP API key is not used. Ingest payloads with ingestHhtPxMcpOrganicSerps.'

export const HHT_PX_MCP_ENRICH_MESSAGE =
  'Domain enrichment uses Semrush MCP domain_rank / backlinks_overview. The HTTP API key is not used. Ingest payloads with ingestHhtPxMcpDomainEnrichment.'

export interface HhtPxSerpRawRow {
  position: number | null
  domain: string
  url: string | null
  features: string | null
  title: string | null
  snippet: string | null
}

export interface HhtPxMcpOrganicHarvest {
  keywordId?: number
  keyword?: string
  payload: unknown
}

export interface HhtPxMcpDomainHarvest {
  domain: string
  overviewPayload?: unknown
  backlinksPayload?: unknown
}

export function mcpPayloadError(payload: unknown): string | null {
  const text =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object' && 'csv' in payload
        ? String((payload as { csv?: unknown }).csv ?? '')
        : payload && typeof payload === 'object' && 'text' in payload
          ? String((payload as { text?: unknown }).text ?? '')
          : ''
  const trimmed = text.trim()
  if (/^ERROR\b/i.test(trimmed)) return trimmed.slice(0, 300)
  const embedded = trimmed.match(/(?:^|\n)(?:get \S+:\s*)?(ERROR\s+\d+[^\n]*)/i)
  return embedded?.[1]?.slice(0, 300) ?? null
}

export function mcpNothingFound(error: string | null): boolean {
  return Boolean(error && /ERROR\s+50|NOTHING FOUND/i.test(error))
}

export function serpRowsFromMcpPayload(payload: unknown): HhtPxSerpRawRow[] {
  return normalizeRows(payload)
    .map((row, index) => {
      const domain = String(row.domain ?? '')
      const url = row.url == null ? null : String(row.url)
      const features = row.triggered_serp_features ?? row.keywords_serp_features ?? row.serp_features
      return {
        position: numOrNull(row.position) ?? index + 1,
        domain,
        url,
        features: features == null ? null : String(features),
        title: row.title == null ? null : String(row.title),
        snippet:
          row.snippet == null && row.description == null ? null : String(row.snippet ?? row.description),
      }
    })
    .filter((row) => row.domain || row.url)
}

export function domainOverviewFromMcpPayload(payload: unknown): {
  organicTraffic: number | null
  rankingKeywords: number | null
} | null {
  const row = normalizeRows(payload)[0]
  if (!row) return null
  return {
    organicTraffic: numOrNull(row.organic_traffic),
    rankingKeywords: numOrNull(row.organic_keywords),
  }
}

export function backlinksFromMcpPayload(payload: unknown): {
  authorityScore: number | null
  backlinks: number | null
  referringDomains: number | null
} | null {
  const row = normalizeRows(payload)[0]
  if (!row) return null
  return {
    authorityScore: numOrNull(row.authority_score ?? row.ascore ?? row.score),
    backlinks: numOrNull(row.total ?? row.backlinks),
    referringDomains: numOrNull(row.domains_num ?? row.referring_domains),
  }
}
