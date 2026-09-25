import { canonicalCompanyDomain, canonicalPageUrl } from './domains.js'
import { backlinkSourceKey, sourceNoteTitle, sourceRef } from './source-keys.js'
import type { AttioPlacementType, AttioSourceTarget } from './types.js'

export interface BacklinkProspectRow {
  id: number
  url: string
  normalizedUrl?: string | null
  title?: string | null
  rootDomain: string
  pageType?: string | null
  isProspectable: boolean
  suggestedHhtUrl?: string | null
  whyLink?: string | null
  opportunityScore?: number | null
  maxKeywordVolume?: number | null
  bestPosition?: number | null
  authorityScore?: number | null
  referringDomains?: number | null
  serpKeyword?: string | null
  serpPosition?: number | null
  keywordVolume?: number | null
  outboundLinks?: number | null
}

export function placementFromPageType(pageType: string | null | undefined): AttioPlacementType {
  if (!pageType) return 'Unknown'
  if (/spam|directory|coupon/.test(pageType)) return 'Unknown'
  return 'Link insertion'
}

export function buildBacklinkTargets(
  rows: readonly BacklinkProspectRow[],
): { targets: AttioSourceTarget[]; skipped: Array<{ id: string; reason: string }> } {
  const targets: AttioSourceTarget[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const seen = new Set<string>()

  for (const row of rows) {
    if (!row.isProspectable) {
      skipped.push({ id: String(row.id), reason: 'not_prospectable' })
      continue
    }
    const url = canonicalPageUrl(row.normalizedUrl || row.url)
    if (!url) {
      skipped.push({ id: String(row.id), reason: 'invalid_article_url' })
      continue
    }
    const key = backlinkSourceKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    const domain = canonicalCompanyDomain(row.rootDomain || url)
    const hhtPage = canonicalPageUrl(row.suggestedHhtUrl ?? null)
    targets.push({
      workstream: 'backlinks',
      sourceKey: key,
      sourceRef: sourceRef('serp-scout', `hht_px_prospect_pages#${row.id}`),
      companyName: domain?.domain ?? row.rootDomain,
      domain: domain?.domain ?? null,
      companyWebsiteUrl: domain?.websiteUrl ?? null,
      contact: null,
      noteTitle: sourceNoteTitle(key),
      noteBody: [
        row.title ? `Article: ${row.title}` : null,
        `URL: ${url}`,
        hhtPage ? `Suggested HHT URL: ${hhtPage}` : null,
        row.whyLink ? `Why a link fits: ${row.whyLink}` : null,
        row.serpKeyword ? `SERP: "${row.serpKeyword}"` : null,
        (row.serpPosition ?? row.bestPosition) != null ? `Best SERP position: ${row.serpPosition ?? row.bestPosition}` : null,
        (row.keywordVolume ?? row.maxKeywordVolume) != null ? `Keyword volume: ${row.keywordVolume ?? row.maxKeywordVolume}` : null,
        row.opportunityScore != null ? `Opportunity score: ${row.opportunityScore}` : null,
        row.authorityScore != null ? `Semrush authority: ${row.authorityScore}` : null,
        row.referringDomains != null ? `Referring domains: ${row.referringDomains}` : null,
        row.outboundLinks != null ? `Outbound links on page: ${row.outboundLinks}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      sourceOwned: {
        source_key: key,
        source_ref: sourceRef('serp-scout', `hht_px_prospect_pages#${row.id}`),
        target_article_url: url,
        article_title: row.title ?? null,
        hht_page_to_link: hhtPage,
        placement_type: placementFromPageType(row.pageType),
        serp_keyword: row.serpKeyword ?? null,
        serp_position: row.serpPosition ?? row.bestPosition ?? null,
        keyword_volume: row.keywordVolume ?? row.maxKeywordVolume ?? null,
        authority_score: row.authorityScore ?? null,
        referring_domains: row.referringDomains ?? null,
        outbound_links: row.outboundLinks ?? null,
        why_link: row.whyLink ?? null,
      },
    })
  }

  return { targets, skipped }
}
