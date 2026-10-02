import 'server-only'
import { stringify } from 'csv-stringify/sync'
import { eq } from 'drizzle-orm'
import { HHT_PX_PAGE_TYPE_LABELS, HHT_PX_PUBLISHER_LANE_LABELS, hhtPxArticleLabel, hhtPxDiscoverySeeds, normalizeHhtPxKeyword } from '@rnr/core'
import { rawSql, type Database } from '../db.js'
import { hhtPxProspectDomains, hhtPxProspectPages } from '../schema.js'
import { listHhtPxDomains, listHhtPxKeywords, listHhtPxPages } from './dashboard.js'

export type HhtPxExportKind = 'keywords' | 'pages' | 'articles' | 'domains' | 'outreach' | 'seeds' | 'qualified' | 'queue' | 'earned' | 'exclusions'

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
          added_on: stamp(row.addedAt),
          publisher_lane: row.lane ? HHT_PX_PUBLISHER_LANE_LABELS[row.lane] : 'Unreviewed',
          qualification: row.qualification,
          editorial_score: row.editorialScore,
          feasibility_score: row.feasibilityScore,
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

  if (kind === 'articles') {
    const rows = await listHhtPxPages(database, { prospectableOnly: true, lane: 'primary', sort: 'score', direction: 'desc' }, 50_000)
    return {
      filename: 'hht-prospect-articles.csv',
      csv: stringify(rows.map(visibleArticleRow), { header: true }),
    }
  }

  if (kind === 'qualified') {
    const rows = await listHhtPxPages(database, { prospectableOnly: true, lane: 'paid_outreach', sort: 'feasibility', direction: 'desc' }, 50_000)
    const ready = rows.filter((row) => row.qualification === 'outreach_ready')
    return {
      filename: 'hht-px-qualified-articles.csv',
      csv: stringify(ready.map(detailArticleRow), { header: true }),
    }
  }

  if (kind === 'seeds') {
    const seeds = hhtPxDiscoverySeeds()
    const sql = rawSql()
    const yields = await sql<
      { keyword_norm: string; serp_status: string; volume: number | null; organic_rows: number; qualified_articles: number }[]
    >`
      select k.keyword_norm,
             k.serp_status,
             v.national_destination_volume as volume,
             count(distinct r.id)::int as organic_rows,
             count(distinct p.id) filter (
               where p.qualification = 'outreach_ready' and p.publisher_lane = 'paid_outreach'
             )::int as qualified_articles
      from hht_px_keywords k
      left join hht_px_keyword_volumes v on v.keyword_id = k.id
      left join hht_px_serp_snapshots s on s.keyword_id = k.id
      left join hht_px_serp_results r on r.snapshot_id = s.id
      left join hht_px_page_keyword_matches m on m.keyword_id = k.id
      left join hht_px_prospect_pages p on p.id = m.page_id
      where k.source = 'discovery_seed'
      group by k.keyword_norm, k.serp_status, v.national_destination_volume
    `
    const yieldByNorm = new Map(yields.map((row) => [row.keyword_norm, row]))
    return {
      filename: 'hht-px-seed-keywords.csv',
      csv: stringify(
        seeds.map((seed) => {
          const norm = normalizeHhtPxKeyword(seed.phrase)
          const measured = yieldByNorm.get(norm)
          const status = measured?.serp_status ?? 'not_in_library'
          const organic = measured?.organic_rows ?? 0
          const qualified = measured?.qualified_articles ?? 0
          const pulled = status === 'cached' || status === 'failed'
          return {
            phrase: seed.phrase,
            family: seed.family,
            geography: seed.geography,
            pilot: seed.pilot ? 'yes' : 'no',
            discovery_status: status,
            measured_volume: measured?.volume ?? '',
            qualified_articles: pulled ? qualified : '',
            notes: seedYieldNote(status, organic, qualified, measured?.volume ?? null),
          }
        }),
        { header: true },
      ),
    }
  }

  if (kind === 'queue' || kind === 'earned' || kind === 'exclusions') {
    const lane = kind === 'queue' ? 'paid_outreach' : kind === 'earned' ? 'earned_partnership' : 'excluded'
    const rows = await listHhtPxPages(database, { prospectableOnly: false, lane, sort: 'feasibility', direction: 'desc' }, 50_000)
    const filename = kind === 'queue' ? 'hht-px-domain-queue.csv' : kind === 'earned' ? 'hht-px-earned-partnerships.csv' : 'hht-px-exclusions.csv'
    if (kind !== 'queue') {
      return { filename, csv: stringify(rows.map(detailArticleRow), { header: true }) }
    }
    const byDomain = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byDomain.get(row.domain) ?? []
      list.push(row)
      byDomain.set(row.domain, list)
    }
    const domains = [...byDomain.values()]
      .map((list) => {
        const ranked = [...list].sort((a, b) => qualityBand(b.editorialScore) - qualityBand(a.editorialScore) || (b.feasibilityScore ?? -1) - (a.feasibilityScore ?? -1))
        const best = ranked[0]!
        return {
          ...detailArticleRow(best),
          alternative_articles: ranked.slice(1).map((row) => row.url).join(' '),
          quality_band: qualityBand(best.editorialScore),
        }
      })
      .sort((a, b) => b.quality_band - a.quality_band || Number(b.feasibility_score ?? 0) - Number(a.feasibility_score ?? 0))
    return { filename, csv: stringify(domains, { header: true }) }
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

type ArticleExportRow = Awaited<ReturnType<typeof listHhtPxPages>>[number]

function seedYieldNote(status: string, organic: number, qualified: number, volume: number | null): string {
  if (status === 'not_in_library') return 'Phrase is not in the keyword library.'
  if (status === 'failed') return 'SERP pull failed.'
  if (status !== 'cached') return 'SERP not pulled. Volume stays blank until measured.'
  if (organic === 0) return 'SERP cached. Semrush returned no organic record for this phrase.'
  const volumeNote = volume == null ? ' Search volume has not been measured.' : ''
  return `SERP cached. ${organic} organic results, ${qualified} outreach-ready articles.${volumeNote}`
}

function stamp(value: Date | string | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function qualityBand(score: number | null | undefined): number {
  if (score == null) return 0
  if (score >= 70) return 3
  if (score >= 55) return 2
  return 1
}

function visibleArticleRow(row: ArticleExportRow) {
  return {
    Keyword: row.keyword,
    Volume: row.volume,
    Pos: row.position,
    Article: hhtPxArticleLabel(row.title, row.url),
    URL: row.url,
    Domain: row.domain,
    Authority: row.authorityScore,
    'Prospect score': row.score == null ? '' : row.score.toFixed(1),
    Geo: row.geographies ?? 'National',
    Type: HHT_PX_PAGE_TYPE_LABELS[row.pageType],
    Added: stamp(row.addedAt),
    Lane: row.lane ? HHT_PX_PUBLISHER_LANE_LABELS[row.lane] : 'Unreviewed',
  }
}

function detailArticleRow(row: ArticleExportRow) {
  return {
    ...visibleArticleRow(row),
    qualification: row.qualification ?? '',
    qualification_reason: row.qualificationReason ?? '',
    editorial_score: row.editorialScore ?? '',
    feasibility_score: row.feasibilityScore ?? '',
    evidence: row.evidenceConfidence ?? '',
    insertion_location: row.insertionLocation ?? '',
    reader_benefit: row.readerBenefit ?? '',
    contact_url: row.contactUrl ?? '',
    suggested_hht_url: row.suggestedHhtUrl ?? '',
    score_detail: row.scoreDetail ?? '',
    publisher_reason: row.publisherReason ?? '',
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
