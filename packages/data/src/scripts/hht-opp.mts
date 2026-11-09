/**
 * HHT Backlink Opportunity Engine CLI
 *
 *   pnpm hht:opp research --url=https://example.com/write-for-us
 *   pnpm hht:opp discover --limit=4 --domains=6
 *   pnpm hht:opp enrich --all-qualified
 *   pnpm hht:opp queries
 *
 * Handoff to the guest-post-pitches skill:
 *   pnpm hht:opp archive                          snapshot every hht_opp_* table to exports/archive
 *   pnpm hht:opp export-backlog [--tiers=A,B,C] [--size=50] [--dry-run]
 *   pnpm hht:opp guest-frontier --plan --max=15 [--no-expand] [--out=plan.json]
 *       pick the next 15 queued keywords (seeds, then guest-templates and keyword ideas) and write
 *       exports/guest-frontier/serp-plan-*.json. No Semrush call.
 *   pnpm hht:opp guest-frontier --serp-from=serps.json
 *       store SERPs a Claude session pulled with the Semrush MCP, then yields and saturation as before.
 *       File: {"<keyword>": {"data": <execute_report data>, "units": N}} (or {"error": "..."} to leave it queued).
 *
 *   Semrush is reached only through the Semrush MCP tools in a Claude session (Kai, 2026-11-08), never the
 *   repo API key or engine login. For each plan request the session calls:
 *     execute_report(report="phrase_organic", params={"phrase": "<keyword>", "database": "us",
 *       "display_limit": 100, "positions_type": "organic", "export_columns": ["position", "domain", "url"]})
 *   and stores the returned data and its api units under the keyword. Keyword ideas stay on Google Ads (free).
 *   pnpm hht:opp export-leads [--keyword-ids=1,2] [--limit=50] [--link-limit=50] [--size=25] [--dry-run]
 *   pnpm hht:opp reset-exhausted                   requeue queries marked exhausted without a fetch
 *   pnpm hht:opp guest-templates [--limit=25] [--buckets=travel,wellness] [--per-template=N] [--json]
 *                                                  preview template × place keywords (no API calls, no writes)
 *   pnpm hht:opp guest-templates --enqueue [--limit=25]  volume-check (Google Ads only) and queue them for guest-frontier
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { researchGuestPostUrls } from '../hht-opp/guest-scale.js'
import {
  expandGuestKeywordIdeas,
  GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED,
  ingestGuestFrontierSerps,
  planGuestPostFrontier,
  resetUnfetchedExhausted,
} from '../hht-opp/guest-frontier.js'
import { enqueueGuestTemplates, previewGuestTemplates } from '../hht-opp/guest-templates.js'
import { GUEST_BUCKET_IDS, type GuestBucketId } from '@rnr/core'
import { archiveHhtOpp, exportLegacyBacklog, exportSerpLeads, type LegacyTier } from '../hht-opp/handoff.js'
import { researchHhtOppSeeds } from '../hht-opp/research.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
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
      const serpFrom = opt('serp-from')
      if (serpFrom) {
        const result = await ingestGuestFrontierSerps(database, JSON.parse(readFileSync(serpFrom, 'utf8')))
        console.log(JSON.stringify(result, null, 2))
        console.error(`Semrush units recorded: ${result.units}`)
        break
      }
      if (!flag('plan')) throw new Error(GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED)
      const maxKeywords = Number(opt('max') ?? 15)
      if (!Number.isInteger(maxKeywords) || maxKeywords <= 0) throw new Error('--max must be a positive integer')
      const plan = await planGuestPostFrontier(database, {
        maxKeywords,
        ideaLimit: Number(opt('ideas') ?? 20),
        expand: !flag('no-expand'),
      })
      const out = resolve(opt('out') ?? join(REPO_ROOT, 'exports/guest-frontier', `serp-plan-${plan.createdAt.replace(/[:.]/g, '-')}.json`))
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`)
      console.log(JSON.stringify({ planFile: out, stop: plan.stop, keywordsSkipped: plan.keywordsSkipped, error: plan.error, keywords: plan.requests.map((r) => r.keyword) }, null, 2))
      console.error(`Pull each request with Semrush MCP execute_report(report, params), save {"<keyword>": {"data": <data>, "units": N}}, then: pnpm hht:opp guest-frontier --serp-from=<file>`)
      break
    }
    case 'guest-scale': {
      // Legacy guest discovery through the repo's Semrush API key. Semrush goes through the MCP only.
      throw new Error(`guest-scale is disabled. ${GUEST_FRONTIER_DIRECT_SEMRUSH_DISABLED}`)
    }
    case 'guest-templates': {
      const buckets = (opt('buckets') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const unknown = buckets.filter((value) => !GUEST_BUCKET_IDS.includes(value as GuestBucketId))
      if (unknown.length > 0) throw new Error(`Unknown bucket(s): ${unknown.join(', ')}. Use ${GUEST_BUCKET_IDS.join(', ')}.`)
      const perTemplate = opt('per-template') ? Number(opt('per-template')) : undefined
      const options = {
        limit: Number(opt('limit') ?? 25),
        buckets: buckets as GuestBucketId[],
        perTemplate,
        metros: opt('metros') ? Number(opt('metros')) : undefined,
        yieldsPath: opt('yields'),
      }
      if (flag('enqueue')) {
        console.log(JSON.stringify(await enqueueGuestTemplates(database, options), null, 2))
        break
      }
      const preview = await previewGuestTemplates(database, options)
      if (flag('json')) {
        console.log(JSON.stringify(preview, null, 2))
        break
      }
      console.log(`Yields: ${preview.yieldsFile ?? 'none (new-domain estimate only)'}`)
      console.log(`Baseline: ${preview.baseline.perKeyword.toFixed(2)} pitchable/kw, ${(preview.baseline.perNewDomain * 100).toFixed(1)}% of new domains`)
      console.log(`Entities: ${preview.entities.cities} cities, ${preview.entities.states} states, ${preview.entities.regions} regions\n`)
      console.log('prior  pitch/kw  new/kw  fetches  template')
      for (const row of preview.templates) {
        console.log(`${row.prior.toFixed(2).padStart(5)}  ${(row.pitchablePerKeyword?.toFixed(2) ?? '—').padStart(8)}  ${(row.newDomainsPerKeyword?.toFixed(1) ?? '—').padStart(6)}  ${String(row.fetches).padStart(7)}  ${row.templateId}${row.retired ? '  RETIRED' : ''}`)
      }
      console.log(`\nSkipped: ${JSON.stringify(preview.skipped)}`)
      console.log(`\nTop ${preview.candidates.length} candidates (score = prior × weight × novelty):`)
      for (const row of preview.candidates) {
        console.log(`${row.score.toFixed(3)}  ${row.prior.toFixed(2)} × ${row.entity.weight.toFixed(2)} × ${row.novelty.toFixed(2)}  ${row.keyword}  [${row.templateId}]`)
      }
      break
    }
    case 'reset-exhausted': {
      console.log(JSON.stringify({ reset: await resetUnfetchedExhausted(database) }, null, 2))
      break
    }
    case 'archive': {
      console.log(JSON.stringify(await archiveHhtOpp(database), null, 2))
      break
    }
    case 'export-leads': {
      console.log(
        JSON.stringify(
          await exportSerpLeads(database, {
            limit: Number(opt('limit') ?? 50),
            linkLimit: Number(opt('link-limit') ?? 50),
            fileSize: opt('size') ? Number(opt('size')) : undefined,
            keywordIds: opt('keyword-ids')?.split(',').map(Number),
            dryRun: flag('dry-run'),
          }),
          null,
          2,
        ),
      )
      break
    }
    case 'export-backlog': {
      const tiers = (opt('tiers') ?? 'A')
        .split(',')
        .map((tier) => tier.trim().toUpperCase())
        .filter((tier): tier is LegacyTier => tier === 'A' || tier === 'B' || tier === 'C')
      console.log(
        JSON.stringify(
          await exportLegacyBacklog(database, {
            tiers,
            fileSize: Number(opt('size') ?? 50),
            dryRun: flag('dry-run'),
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
  pnpm hht:opp keyword-ideas [--ideas=20]
  pnpm hht:opp guest-frontier --plan [--max=15] [--ideas=20] [--no-expand] [--out=plan.json]
  pnpm hht:opp guest-frontier --serp-from=serps.json
  pnpm hht:opp guest-templates [--limit=25] [--buckets=travel,romance,weddings,wellness,lifestyle] [--per-template=N] [--metros=300] [--yields=path.csv] [--json]
  pnpm hht:opp guest-templates --enqueue [--limit=25]
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
