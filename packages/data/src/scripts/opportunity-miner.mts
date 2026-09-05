/**
 * Opportunity Miner CLI
 *
 *   pnpm miner seed
 *   pnpm miner discover --country=us --max-depth=3 --live
 *   pnpm miner expand-keyword "roofing estimating software" --live
 *   pnpm miner analyze-domain example.com --live
 *   pnpm miner cluster
 *   pnpm miner score
 *   pnpm miner anomalies
 *   pnpm miner run --live
 *   pnpm miner export --min-score=80
 *   pnpm miner ingest path.json
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { closeDb, db } from '../db.js'
import { analyzeDomain } from '../opportunity-miner/domains.js'
import { expandNamedKeyword, seedQueue } from '../opportunity-miner/discovery.js'
import { exportOpportunitiesCsv } from '../opportunity-miner/export.js'
import { ingestSemrushHarvestFile } from '../opportunity-miner/harvest.js'
import { listAnomalies, minerStats } from '../opportunity-miner/queries.js'
import { drainQueue, runDaily, runSeed } from '../opportunity-miner/run.js'
import { clusterMarkets } from '../opportunity-miner/cluster.js'
import { scoreAllMarkets } from '../opportunity-miner/score.js'
import { upsertDomain } from '../opportunity-miner/store.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

async function main(): Promise<void> {
  const database = db()
  const live = flag('live')
  const country = opt('country') ?? 'us'
  const maxDepth = Number(opt('max-depth') ?? '3')
  const family = opt('seed-family')

  switch (command) {
    case 'seed': {
      const r = await runSeed(database, {
        country,
        live,
        ...(family ? { seedFamily: family } : {}),
        firstRunOnly: !family,
        limit: opt('limit') ? Number(opt('limit')) : 120,
      })
      console.log(`seeded ${r.seeded}, enqueued ${r.enqueued}`)
      break
    }
    case 'discover': {
      if (flag('seed') || !(await minerStats(database)).pending) {
        await seedQueue(database, {
          country,
          ...(family ? { seedFamily: family } : {}),
          firstRunOnly: !family,
          limit: opt('limit') ? Number(opt('limit')) : 60,
        })
      }
      const r = await drainQueue(database, {
        country,
        maxDepth,
        live,
        jobs: opt('jobs') ? Number(opt('jobs')) : 20,
        ...(family ? { seedFamily: family } : {}),
      })
      console.log(`processed ${r.processed}, failed ${r.failed}`)
      break
    }
    case 'expand-keyword': {
      const keyword = positional[0]
      if (!keyword) throw new Error('keyword is required')
      const r = await expandNamedKeyword(database, keyword, { country, live, maxDepth })
      console.log(`keyword #${r.keywordId} found ${r.result.found} new ${r.result.created}`)
      break
    }
    case 'analyze-domain': {
      const domain = positional[0]
      if (!domain) throw new Error('domain is required')
      const id = await upsertDomain(database, domain)
      const r = await analyzeDomain(database, id, { country, live })
      console.log(`${domain} organic ${r.organic} paid ${r.paid} adjacent ${r.adjacent}`)
      break
    }
    case 'cluster': {
      const r = await clusterMarkets(database, country)
      console.log(`created ${r.created}, updated ${r.updated}`)
      break
    }
    case 'score': {
      const r = await scoreAllMarkets(database)
      console.log(`scored ${r.scored}, anomalies ${r.anomalies}`)
      break
    }
    case 'anomalies': {
      const rows = await listAnomalies(database)
      for (const row of rows) {
        console.log(`${row.anomaly.kind.padEnd(32)} ${row.market.name} — ${row.anomaly.why}`)
      }
      if (!rows.length) console.log('no anomalies yet')
      break
    }
    case 'run': {
      const r = await runDaily(database, {
        country,
        live,
        maxDepth,
        limit: opt('jobs') ? Number(opt('jobs')) : 15,
        ...(family ? { seedFamily: family } : {}),
      })
      console.log(JSON.stringify(r, null, 2))
      break
    }
    case 'export': {
      const csv = await exportOpportunitiesCsv(database, Number(opt('min-score') ?? '0'))
      const dest = opt('out') ?? 'opportunity-miner.csv'
      writeFileSync(dest, csv)
      console.log(`wrote ${dest}`)
      break
    }
    case 'ingest': {
      const path = positional[0]
      if (!path) throw new Error('path to harvest JSON/CSV is required')
      const r = await ingestSemrushHarvestFile(database, path)
      console.log(`ingested ${r.rows} rows, ${r.created} new`)
      break
    }
    case 'stats': {
      console.log(await minerStats(database))
      break
    }
    default:
      console.log(`unknown command: ${command}`)
      console.log('seed | discover | expand-keyword | analyze-domain | cluster | score | anomalies | run | export | ingest | stats')
  }

  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
