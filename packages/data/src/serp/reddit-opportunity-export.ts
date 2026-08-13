import 'server-only'
import { sql } from 'drizzle-orm'
import { estimateRedditVisits } from '@rnr/core'
import type { Database } from '../db.js'

export type RedditOpportunityExportRow = {
  run_id: number
  geography: string
  niche: string
  exact_query: string
  device: string
  search_volume: number | null
  volume_source: string | null
  volume_geo_target: string | null
  estimated_reddit_visits: number | null
  top_reddit_serp_position: number | null
  top_reddit_organic_position: number | null
  reddit_url: string
}

type RawRedditOpportunityExportRow = Omit<
  RedditOpportunityExportRow,
  'estimated_reddit_visits'
> & {
  reddit_source_kind: string
}

export async function listRedditOpportunityExportRows(
  db: Database,
  args: { runId?: number | null } = {},
): Promise<RedditOpportunityExportRow[]> {
  const runFilter = args.runId == null ? sql`` : sql`AND r.id = ${args.runId}`
  const result = await db.execute<RawRedditOpportunityExportRow>(sql`
    WITH ranked AS (
      SELECT
        r.id AS run_id,
        concat_ws(
          ', ',
          COALESCE(rg.market, dg.raw_name, loc.name, 'Unknown market'),
          COALESCE(rg.state_abbr, dg.raw_state, loc.state_code)
        ) AS geography,
        COALESCE(n.label, dn.label, rk.keyword, j.keyword, 'Unknown niche') AS niche,
        COALESCE(j.keyword, rk.keyword, dn.keyword_primary, '') AS exact_query,
        j.device,
        m.avg_monthly_searches AS search_volume,
        m.volume_source,
        m.volume_geo_target,
        h.rank_absolute AS top_reddit_serp_position,
        h.organic_position AS top_reddit_organic_position,
        h.source_kind AS reddit_source_kind,
        h.reddit_url,
        row_number() OVER (
          PARTITION BY j.id
          ORDER BY
            h.rank_absolute ASC NULLS LAST,
            h.organic_position ASC NULLS LAST,
            h.id ASC
        ) AS reddit_rank
      FROM discovery_hits h
      INNER JOIN discovery_jobs j ON j.id = h.job_id
      INNER JOIN discovery_runs r ON r.id = j.run_id
      LEFT JOIN discovery_serp_metrics m ON m.job_id = j.id
      LEFT JOIN discovery_niches dn ON dn.id = j.discovery_niche_id
      LEFT JOIN niches n ON n.id = COALESCE(h.niche_id, dn.niche_id)
      LEFT JOIN research_keywords rk ON rk.id = j.research_keyword_id
      LEFT JOIN research_geos rg ON rg.id = j.research_geo_id
      LEFT JOIN discovery_geos dg ON dg.id = j.discovery_geo_id
      LEFT JOIN localities loc ON loc.id = j.locality_id
      WHERE j.kind = 'serp'
        ${runFilter}
    )
    SELECT
      run_id,
      geography,
      niche,
      exact_query,
      device,
      search_volume,
      volume_source,
      volume_geo_target,
      top_reddit_serp_position,
      top_reddit_organic_position,
      reddit_source_kind,
      reddit_url
    FROM ranked
    WHERE reddit_rank = 1
    ORDER BY
      search_volume DESC NULLS LAST,
      run_id DESC,
      geography ASC,
      niche ASC,
      exact_query ASC,
      device ASC
  `)
  const rows = result as unknown as RawRedditOpportunityExportRow[]
  return rows
    .map(({ reddit_source_kind, ...row }) => ({
      ...row,
      estimated_reddit_visits: estimateRedditVisits({
        volume: row.search_volume,
        organicPosition: row.top_reddit_organic_position,
        rankAbsolute: row.top_reddit_serp_position,
        fromPack: reddit_source_kind !== 'organic',
      }),
    }))
    .sort(
      (a, b) =>
        (b.estimated_reddit_visits ?? -1) - (a.estimated_reddit_visits ?? -1) ||
        (b.search_volume ?? -1) - (a.search_volume ?? -1) ||
        b.run_id - a.run_id ||
        a.geography.localeCompare(b.geography) ||
        a.niche.localeCompare(b.niche) ||
        a.exact_query.localeCompare(b.exact_query) ||
        a.device.localeCompare(b.device),
    )
}

function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  // Prevent spreadsheet software from evaluating provider/user-derived text.
  const raw = typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw
}

export function redditOpportunityRowsToCsv(rows: RedditOpportunityExportRow[]): string {
  const headers: Array<keyof RedditOpportunityExportRow> = [
    'run_id',
    'geography',
    'niche',
    'exact_query',
    'device',
    'search_volume',
    'volume_source',
    'volume_geo_target',
    'estimated_reddit_visits',
    'top_reddit_serp_position',
    'top_reddit_organic_position',
    'reddit_url',
  ]
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    '',
  ].join('\n')
}
