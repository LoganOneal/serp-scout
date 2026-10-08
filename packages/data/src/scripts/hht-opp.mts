/**
 * HHT Backlink Opportunity Engine CLI
 *
 *   pnpm hht:opp research --url=https://example.com/write-for-us
 *   pnpm hht:opp discover --limit=4 --domains=6
 *   pnpm hht:opp enrich --all-qualified
 *   pnpm hht:opp queries
 */
import 'dotenv/config'
import { expandQueryTemplates } from '@rnr/core'
import { closeDb, db } from '../db.js'
import {
  executeHhtOppDiscoveryRun,
  isHhtOppSearchStrategy,
  parseDiscoveryRunNotes,
  runHhtOppDiscovery,
} from '../hht-opp/discover.js'
import { applyHhtOppBacklinkSnapshot, enrichHhtOppDomains, enrichQualifiedHhtOppDomains } from '../hht-opp/enrich.js'
import { expandHhtOppAuthors } from '../hht-opp/authors.js'
import { scanHhtOppBrokenLinks } from '../hht-opp/broken.js'
import { mineHhtOppCompetitors } from '../hht-opp/competitors.js'
import { expandHhtOppGraph, mineHhtOppDirectories } from '../hht-opp/directories.js'
import { generateHhtOppRecommendations } from '../hht-opp/learning.js'
import { discoverHhtOppMentions } from '../hht-opp/mentions.js'
import { hhtOppOutcomeStats } from '../hht-opp/outcomes.js'
import { listDiscoveryRuns, listHhtOppOpportunities, strategyYield } from '../hht-opp/queries.js'
import { refreshStaleHhtOppOpportunities } from '../hht-opp/refresh.js'
import { readFileSync } from 'node:fs'
import { researchGuestPostUrls, scaleGuestPostDiscovery } from '../hht-opp/guest-scale.js'
import { expandGuestKeywordIdeas, runGuestPostFrontier } from '../hht-opp/guest-frontier.js'
import { researchHhtOppSeeds } from '../hht-opp/research.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

async function main(): Promise<void> {
  const database = db()
  switch (command) {
    case 'research': {
      const urls = argv.filter((a) => a.startsWith('--url=')).map((a) => a.slice(6))
      if (urls.length === 0) throw new Error('Pass one or more --url=https://...')
      const results = await researchHhtOppSeeds(database, urls)
      console.log(JSON.stringify(results, null, 2))
      break
    }
    case 'discover': {
      const runId = Number(opt('run-id') ?? '')
      if (Number.isInteger(runId) && runId > 0) {
        console.log(JSON.stringify(await executeHhtOppDiscoveryRun(database, runId), null, 2))
        break
      }
      const strategyRaw = opt('strategy') ?? ''
      console.log(
        JSON.stringify(
          await runHhtOppDiscovery(database, {
            queryLimit: Number(opt('limit') ?? 4),
            domainLimit: Number(opt('domains') ?? 6),
            strategies: isHhtOppSearchStrategy(strategyRaw) ? [strategyRaw] : undefined,
            name: opt('name'),
            useFixture: flag('fixture'),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'runs': {
      const runs = await listDiscoveryRuns(database)
      for (const run of runs) {
        const notes = parseDiscoveryRunNotes(run.notes)
        console.log(
          `#${run.id} ${run.status} ${notes.provider ?? '—'} queries=${notes.queries ?? 0} new=${notes.newDomains ?? 0} created=${notes.created ?? 0}`,
        )
      }
      break
    }
    case 'seo': {
      const domainId = Number(opt('domain-id') ?? '')
      if (!Number.isInteger(domainId) || domainId <= 0) throw new Error('Pass --domain-id=N')
      await applyHhtOppBacklinkSnapshot(database, domainId, {
        authorityScore: Number(opt('as') ?? '') || null,
        backlinks: Number(opt('backlinks') ?? '') || null,
        referringDomains: Number(opt('rd') ?? '') || null,
      })
      console.log(`stored seo for domain ${domainId}`)
      break
    }
    case 'enrich': {
      if (flag('all-qualified')) {
        console.log(JSON.stringify(await enrichQualifiedHhtOppDomains(database), null, 2))
        break
      }
      const ids = (opt('domain-ids') ?? '')
        .split(',')
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
      console.log(JSON.stringify(await enrichHhtOppDomains(database, ids), null, 2))
      break
    }
    case 'list': {
      const rows = await listHhtOppOpportunities(database, { sort: 'score' })
      if (flag('json')) {
        console.log(JSON.stringify(rows, null, 2))
        break
      }
      console.log(`${rows.length} opportunities`)
      for (const row of rows.slice(0, 30)) {
        console.log(`${row.overallScore?.toFixed(1) ?? '—'}  ${row.eligibility}  ${row.site}  ${row.opportunityType}`)
      }
      break
    }
    case 'strategies': {
      console.log(JSON.stringify(await strategyYield(database), null, 2))
      break
    }
    case 'competitors': {
      const seeds = (opt('seeds') ?? '').split(',').map((v) => v.trim()).filter(Boolean)
      console.log(
        JSON.stringify(
          await mineHhtOppCompetitors(database, {
            seeds: seeds.length ? seeds : undefined,
            domainLimit: Number(opt('domains') ?? 6),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'mentions': {
      console.log(JSON.stringify(await discoverHhtOppMentions(database, { useFixture: flag('fixture') }), null, 2))
      break
    }
    case 'broken': {
      console.log(JSON.stringify(await scanHhtOppBrokenLinks(database), null, 2))
      break
    }
    case 'authors': {
      console.log(JSON.stringify(await expandHhtOppAuthors(database, { useFixture: flag('fixture') }), null, 2))
      break
    }
    case 'directories': {
      console.log(JSON.stringify(await mineHhtOppDirectories(database), null, 2))
      break
    }
    case 'graph': {
      console.log(JSON.stringify(await expandHhtOppGraph(database), null, 2))
      break
    }
    case 'refresh': {
      console.log(JSON.stringify(await refreshStaleHhtOppOpportunities(database, { limit: Number(opt('limit') ?? 8) }), null, 2))
      break
    }
    case 'recommend': {
      console.log(JSON.stringify(await generateHhtOppRecommendations(database), null, 2))
      break
    }
    case 'outcomes': {
      console.log(JSON.stringify(await hhtOppOutcomeStats(database), null, 2))
      break
    }
    case 'guest-research': {
      const file = opt('urls-file')
      if (!file) throw new Error('Pass --urls-file=path')
      const urls = readFileSync(file, 'utf8').split('\n')
      console.log(
        JSON.stringify(
          await researchGuestPostUrls(database, urls, { domainLimit: Number(opt('domains') ?? 40) }),
          null,
          2,
        ),
      )
      break
    }
    case 'keyword-ideas': {
      console.log(JSON.stringify(await expandGuestKeywordIdeas(database, { ideaLimit: Number(opt('ideas') ?? 20) }), null, 2))
      break
    }
    case 'guest-frontier': {
      const maxRaw = opt('max')
      const maxKeywords = maxRaw == null ? null : Number(maxRaw)
      console.log(
        JSON.stringify(
          await runGuestPostFrontier(database, {
            maxKeywords: maxKeywords != null && Number.isFinite(maxKeywords) ? maxKeywords : null,
            ideaLimit: Number(opt('ideas') ?? 20),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'guest-scale': {
      console.log(
        JSON.stringify(
          await scaleGuestPostDiscovery(database, {
            serpDepth: Number(opt('serp') ?? 100),
            domainLimit: Number(opt('domains') ?? 50),
            ideaLimit: Number(opt('ideas') ?? 8),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'queries': {
      const templates = expandQueryTemplates()
      console.log(`${templates.length} query templates`)
      for (const row of templates.slice(0, 20)) console.log(`${row.strategy}\t${row.query}`)
      break
    }
    default:
      console.log(`Usage:
  pnpm hht:opp research --url=https://example.com/write-for-us
  pnpm hht:opp discover --limit=4 --domains=6
  pnpm hht:opp discover --fixture --limit=3 --domains=2
  pnpm hht:opp discover --run-id=1
  pnpm hht:opp runs
  pnpm hht:opp list
  pnpm hht:opp enrich --all-qualified
  pnpm hht:opp strategies
  pnpm hht:opp queries
  pnpm hht:opp guest-scale [--serp=100] [--domains=50] [--ideas=8]
  pnpm hht:opp keyword-ideas [--ideas=20]
  pnpm hht:opp guest-frontier [--max=10] [--ideas=20]
  pnpm hht:opp competitors [--seeds=a.com,b.com]
  pnpm hht:opp mentions [--fixture]
  pnpm hht:opp broken
  pnpm hht:opp authors [--fixture]
  pnpm hht:opp directories
  pnpm hht:opp graph
  pnpm hht:opp refresh
  pnpm hht:opp recommend
  pnpm hht:opp outcomes`)
  }
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
