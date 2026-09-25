import type { HhtPxGeneratedKeyword, HhtPxGeographySeed, HhtPxKeywordTemplateSeed } from './types.js'
import { hhtPxGeographyKey } from './geographies.js'

export function normalizeHhtPxKeyword(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function fillGeoTemplate(template: string, geographyName: string): string {
  return template.replaceAll('[GEO]', geographyName.toLowerCase()).replace(/\s+/g, ' ').trim()
}

export function generateHhtPxKeywords(
  templates: readonly HhtPxKeywordTemplateSeed[],
  geographies: readonly HhtPxGeographySeed[],
): HhtPxGeneratedKeyword[] {
  const enabledGeos = geographies.filter((geo) => geo.active && geo.type !== 'neighborhood')
  const seen = new Set<string>()
  const out: HhtPxGeneratedKeyword[] = []

  for (const template of templates) {
    if (!template.enabled) continue
    if (!template.geographic) {
      const keyword = template.template
      const keywordNorm = normalizeHhtPxKeyword(keyword)
      if (seen.has(keywordNorm)) continue
      seen.add(keywordNorm)
      out.push({
        keyword,
        keywordNorm,
        geographyKey: null,
        template: template.template,
        cluster: template.cluster,
        variantGroup: template.variantGroup,
        source: 'template',
        priority: template.priority,
        expectedLinkability: template.expectedLinkability,
      })
      continue
    }

    for (const geo of enabledGeos) {
      const keyword = fillGeoTemplate(template.template, geo.queryName)
      const keywordNorm = normalizeHhtPxKeyword(keyword)
      const dedupeKey = `${keywordNorm}|${hhtPxGeographyKey(geo)}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push({
        keyword,
        keywordNorm,
        geographyKey: hhtPxGeographyKey(geo),
        template: template.template,
        cluster: template.cluster,
        variantGroup: template.variantGroup,
        source: 'template',
        priority: template.priority,
        expectedLinkability: template.expectedLinkability,
      })
    }
  }

  return out
}

export interface VolumeForRepresentative {
  keywordId: number
  geographyId: number | null
  variantGroup: string
  volume: number | null
  priorityScore: number
}

/**
 * One Semrush call per geography × variant group: the highest-volume keyword.
 * Unmeasured volume does not beat a measured zero; missing volume sorts last.
 */
export function pickVariantRepresentatives(rows: VolumeForRepresentative[]): Set<number> {
  const best = new Map<string, VolumeForRepresentative>()
  for (const row of rows) {
    const key = `${row.geographyId ?? 'national'}|${row.variantGroup}`
    const current = best.get(key)
    if (!current || compareRepresentative(row, current) < 0) best.set(key, row)
  }
  return new Set([...best.values()].map((row) => row.keywordId))
}

function compareRepresentative(a: VolumeForRepresentative, b: VolumeForRepresentative): number {
  const aVol = a.volume
  const bVol = b.volume
  if (aVol == null && bVol == null) return b.priorityScore - a.priorityScore || a.keywordId - b.keywordId
  if (aVol == null) return 1
  if (bVol == null) return -1
  if (bVol !== aVol) return bVol - aVol
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore
  return a.keywordId - b.keywordId
}

export function serpUrlOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const other = new Set(b)
  let hits = 0
  for (const url of a) if (other.has(url)) hits += 1
  return hits / Math.max(a.length, b.length)
}

export function recentMonthlyVolume(
  monthly: ReadonlyArray<{ year: number; month: number; searchVolume: number }>,
): number | null {
  if (monthly.length === 0) return null
  const latest = [...monthly].sort((a, b) => a.year - b.year || a.month - b.month).at(-1)
  return latest?.searchVolume ?? null
}

export function monthlyTrendSlope(
  monthly: ReadonlyArray<{ year: number; month: number; searchVolume: number }>,
): number | null {
  if (monthly.length < 3) return null
  const ordered = [...monthly].sort((a, b) => a.year - b.year || a.month - b.month)
  const first = ordered.slice(0, 3).reduce((sum, row) => sum + row.searchVolume, 0) / 3
  const last = ordered.slice(-3).reduce((sum, row) => sum + row.searchVolume, 0) / 3
  if (first <= 0 && last <= 0) return 0
  if (first <= 0) return 1
  return (last - first) / first
}
