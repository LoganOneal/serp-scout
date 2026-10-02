/**
 * HHT SERP backlink prospecting CLI
 *
 *   pnpm hht:px schema
 *   pnpm hht:px seed
 *   pnpm hht:px volume --limit=200
 *   pnpm hht:px prioritize
 *   pnpm hht:px serp-preview --limit=25 --clusters=romantic_getaways,national_editorial
 *   pnpm hht:px serp --limit=25 --confirm   # queues keywords; does not call the HTTP API
 *   pnpm hht:px ingest-serp --file=harvests.json
 *   pnpm hht:px reclassify
 *   pnpm hht:px aggregate
 *   pnpm hht:px aggregate
 *   pnpm hht:px enrich --limit=15
 *   pnpm hht:px ingest-domains --file=domains.json
 *   pnpm hht:px export --kind=outreach
 */
import 'dotenv/config'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isHhtPxCluster, type HhtPxCluster } from '@rnr/core'
import { closeDb, db, rawSql } from '../db.js'
import {
  aggregateHhtPxProspects,
  enrichHhtPxDomains,
  expandHhtPxKeywordIdeas,
  exportHhtPxCsv,
  fetchHhtPxSerps,
  fetchHhtPxVolumes,
  getLatestHhtPxRun,
  ingestHhtPxMcpDomainEnrichment,
  ingestHhtPxMcpOrganicSerps,
  previewHhtPxSerpCalls,
  prioritizeHhtPxKeywords,
  reclassifyHhtPxSerpResults,
  insertHhtPxDiscoverySeeds,
  qualifyHhtPxPublishers,
  seedHhtPxLibrary,
  type HhtPxExportKind,
  type HhtPxMcpDomainHarvest,
  type HhtPxMcpOrganicHarvest,
} from '../index.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

function clusterList(): HhtPxCluster[] | undefined {
  const raw = opt('clusters')
  if (!raw) return undefined
  const clusters = raw.split(',').map((value) => value.trim()).filter(isHhtPxCluster)
  return clusters.length ? clusters : undefined
}

async function main(): Promise<void> {
  const database = db()
  switch (command) {
    case 'seed': {
      console.log(JSON.stringify(await seedHhtPxLibrary(database), null, 2))
      break
    }
    case 'volume': {
      console.log(
        JSON.stringify(
          await fetchHhtPxVolumes(database, {
            limit: Number(opt('limit') ?? 200),
            retryFailed: flag('retry-failed'),
            clusters: clusterList(),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'prioritize': {
      console.log(JSON.stringify(await prioritizeHhtPxKeywords(database), null, 2))
      break
    }
    case 'serp-preview': {
      console.log(
        JSON.stringify(
          await previewHhtPxSerpCalls(database, {
            limit: Number(opt('limit') ?? 10),
            refresh: flag('refresh'),
            includeExperimental: flag('experimental'),
            clusters: clusterList(),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'serp': {
      if (!flag('confirm')) {
        const preview = await previewHhtPxSerpCalls(database, {
          limit: Number(opt('limit') ?? 10),
          clusters: clusterList(),
        })
        console.log(JSON.stringify({ error: 'Pass --confirm to queue Semrush MCP SERP keywords', preview }, null, 2))
        break
      }
      console.log(
        JSON.stringify(
          await fetchHhtPxSerps(database, {
            limit: Number(opt('limit') ?? 10),
            refresh: flag('refresh'),
            includeExperimental: flag('experimental'),
            retryFailed: flag('retry-failed'),
            clusters: clusterList(),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'ingest-serp': {
      const file = opt('file')
      const dir = opt('dir')
      if (!file && !dir) {
        console.log(JSON.stringify({ error: 'Pass --file=harvests.json or --dir=csv-directory' }, null, 2))
        break
      }
      let harvests: HhtPxMcpOrganicHarvest[] = []
      if (file) {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as
          | { harvests?: HhtPxMcpOrganicHarvest[] }
          | HhtPxMcpOrganicHarvest[]
        harvests = Array.isArray(parsed) ? parsed : parsed.harvests ?? []
      }
      if (dir) {
        const names = await readdir(dir)
        for (const name of names) {
          const id = Number(name.replace(/\.(csv|txt|json)$/i, ''))
          if (!Number.isFinite(id)) continue
          harvests.push({ keywordId: id, payload: await readFile(join(dir, name), 'utf8') })
        }
      }
      console.log(JSON.stringify(await ingestHhtPxMcpOrganicSerps(database, harvests), null, 2))
      break
    }
    case 'ingest-domains': {
      const file = opt('file')
      if (!file) {
        console.log(JSON.stringify({ error: 'Pass --file=domains.json with { harvests: [{ domain, overviewPayload, backlinksPayload }] }' }, null, 2))
        break
      }
      const parsed = JSON.parse(await readFile(file, 'utf8')) as
        | { harvests?: HhtPxMcpDomainHarvest[] }
        | HhtPxMcpDomainHarvest[]
      const harvests = Array.isArray(parsed) ? parsed : parsed.harvests ?? []
      console.log(JSON.stringify(await ingestHhtPxMcpDomainEnrichment(database, harvests), null, 2))
      break
    }
    case 'reclassify': {
      console.log(JSON.stringify(await reclassifyHhtPxSerpResults(database), null, 2))
      break
    }
    case 'aggregate': {
      console.log(JSON.stringify(await aggregateHhtPxProspects(database), null, 2))
      break
    }
    case 'enrich': {
      console.log(
        JSON.stringify(await enrichHhtPxDomains(database, { limit: Number(opt('limit') ?? 15) }), null, 2),
      )
      break
    }
    case 'ideas': {
      console.log(JSON.stringify(await expandHhtPxKeywordIdeas(database), null, 2))
      break
    }
    case 'discovery-seeds': {
      console.log(JSON.stringify(await insertHhtPxDiscoverySeeds(database), null, 2))
      break
    }
    case 'qualify': {
      console.log(JSON.stringify(await qualifyHhtPxPublishers(database, { limit: Number(opt('limit') ?? 160) }), null, 2))
      break
    }
    case 'export': {
      const kind = (opt('kind') ?? 'outreach') as HhtPxExportKind
      const { filename, csv } = await exportHhtPxCsv(database, kind)
      const out = opt('out') ?? filename
      await writeFile(out, csv, 'utf8')
      console.log(out)
      break
    }
    case 'status': {
      console.log(JSON.stringify(await getLatestHhtPxRun(database), null, 2))
      break
    }
    case 'report': {
      const sql = rawSql()
      const counts = await sql`
        select
          (select count(*)::int from hht_px_keyword_volumes where retrieved_at is not null) as px_volumes,
          (select count(*)::int from keyword_volume_cache where location_code = 2840 and has_data) as cache_us,
          (select count(*)::int from om_semrush_cache) as semrush_cache,
          (select count(*)::int from hht_px_serp_snapshots) as serps,
          (select count(*)::int from hht_px_prospect_pages where is_prospectable) as prospect_pages,
          (select count(*)::int from hht_px_prospect_domains where is_prospectable) as domains
      `
      const top = await sql`
        select k.keyword, k.cluster, g.name as geo, g.state_code,
               v.national_destination_volume as volume
        from hht_px_keyword_volumes v
        join hht_px_keywords k on k.id = v.keyword_id
        left join hht_px_geographies g on g.id = k.geography_id
        where v.retrieved_at is not null
        order by v.national_destination_volume desc nulls last
        limit 25
      `
      const cache = await sql`
        select keyword, avg_monthly_searches as volume, source
        from keyword_volume_cache
        where has_data and location_code = 2840
          and (
            keyword ilike '%romantic%'
            or keyword ilike '%hot tub%'
            or keyword ilike '%getaway%'
            or keyword ilike '%jacuzzi%'
            or keyword ilike '%honeymoon%'
            or keyword ilike '%spa resort%'
          )
        order by avg_monthly_searches desc nulls last
        limit 25
      `
      const domains = await sql`
        select root_domain, page_count, geography_count, cluster_count,
               opportunity_score, competitor_strength, is_prospectable
        from hht_px_prospect_domains
        where is_prospectable
        order by opportunity_score desc nulls last
        limit 25
      `
      console.log(JSON.stringify({ counts, top, cache, domains }, null, 2))
      break
    }
    default:
      console.log(`Unknown command ${command}. See file header for usage.`)
  }
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
