import 'server-only'
import { stringify } from 'csv-stringify/sync'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtPxProspectDomains, hhtPxProspectPages } from '../schema.js'
import { listHhtPxDomains, listHhtPxKeywords, listHhtPxPages } from './dashboard.js'

export type HhtPxExportKind = 'keywords' | 'pages' | 'domains' | 'outreach'

export async function exportHhtPxCsv(database: Database, kind: HhtPxExportKind): Promise<{ filename: string; csv: string }> {
  if (kind === 'keywords') {
    const rows = await listHhtPxKeywords(database, { sort: 'score', direction: 'desc' }, 10_000)
    return {
      filename: 'hht-prospect-keywords.csv',
      csv: stringify(
        rows.map((row) => ({
          keyword: row.keyword,
          geo: row.geoName,
          state: row.state,
          cluster: row.cluster,
          variant_group: row.variantGroup,
          avg_monthly_volume: row.volume,
          recent_monthly_volume: row.recentVolume,
          trend: row.trend,
          competition: row.competition,
          hht_inventory: row.inventory,
          editorial_density: row.editorialDensity,
          prospectable_results: row.uniqueProspectDomains,
          direct_competitors: row.competitorCount,
          unique_prospect_domains: row.uniqueProspectDomains,
          opportunity_score: row.score,
          serp_status: row.serpStatus,
        })),
        { header: true },
      ),
    }
  }

  if (kind === 'pages') {
    const rows = await listHhtPxPages(database, { prospectableOnly: false, sort: 'volume', direction: 'desc' }, 10_000)
    return {
      filename: 'hht-prospect-pages.csv',
      csv: stringify(
        rows.map((row) => ({
          keyword: row.keyword,
          national_destination_volume: row.volume,
          serp_position: row.position,
          article: row.title,
          url: row.url,
          domain: row.domain,
          geography: row.geographies,
          cluster: row.cluster,
          page_type: row.pageType,
          score: row.score,
          domain_authority: row.authorityScore,
          link_fit: row.linkFit,
          competitor: row.competitor,
          suggested_hht_url: row.suggestedHhtUrl,
          why_link: row.whyLink,
          outreach_status: row.outreachStatus,
        })),
        { header: true },
      ),
    }
  }

  if (kind === 'domains') {
    const rows = await listHhtPxDomains(database, { prospectableOnly: false, sort: 'score', direction: 'desc' }, 10_000)
    return {
      filename: 'hht-prospect-domains.csv',
      csv: stringify(
        rows.map((row) => ({
          domain: row.rootDomain,
          domain_type: row.domainType,
          opportunity_score: row.opportunityScore,
          authority: row.authorityScore,
          organic_traffic: row.organicTraffic,
          qualifying_pages: row.pageCount,
          geographies: row.geographyCount,
          keyword_families: row.clusterCount,
          strongest_opportunity: row.strongest?.title ?? row.strongest?.url,
          competitor: row.competitorStrength,
          outreach_status: row.outreachStatus,
          notes: row.notes,
        })),
        { header: true },
      ),
    }
  }

  const pages = await listHhtPxPages(database, { prospectableOnly: true, sort: 'volume', direction: 'desc' }, 10_000)
  return {
    filename: 'hht-prospect-outreach.csv',
    csv: stringify(
      pages.map((row) => ({
        keyword: row.keyword,
        national_destination_volume: row.volume,
        serp_position: row.position,
        domain: row.domain,
        article: row.title,
        url: row.url,
        page_type: row.pageType,
        suggested_hht_url: row.suggestedHhtUrl,
        why_link_fits: row.whyLink,
        score: row.score,
        outreach_status: row.outreachStatus,
      })),
      { header: true },
    ),
  }
}

export async function updateHhtPxOutreach(
  database: Database,
  args: { pageId?: number; domainId?: number; status: 'not_contacted' | 'contacted' | 'in_conversation' | 'linked' | 'declined' | 'skipped'; notes?: string },
): Promise<void> {
  if (args.pageId) {
    await database
      .update(hhtPxProspectPages)
      .set({ outreachStatus: args.status, notes: args.notes, updatedAt: new Date() })
      .where(eq(hhtPxProspectPages.id, args.pageId))
  }
  if (args.domainId) {
    await database
      .update(hhtPxProspectDomains)
      .set({ outreachStatus: args.status, notes: args.notes, updatedAt: new Date() })
      .where(eq(hhtPxProspectDomains.id, args.domainId))
  }
}
