/**
 * Keyword research for an affiliate directory site, end to end.
 *
 * ==================== EVERYTHING HERE IS $0 UNLESS YOU ASK ====================
 * seed / expand / volume / verdict / board are FREE. Volume comes from Google
 * Ads, which we already hold credentials for and which has no paid fallback by
 * policy (keyword-volume-cache.ts).
 *
 * `rankings --labs`, `competitors` and `gap` are the only commands that spend,
 * they all require --live, and they all print what they cost.
 * ============================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/affiliate-research.mts <command> [args]
 *
 *   seed                      create/refresh both sites and their entity sets
 *   expand    <domain>        generate the keyword space           $0
 *   volume    <domain> --live measure demand for every keyword     $0
 *   rankings  <domain> --live what we rank for (Search Console)    $0
 *            [--labs]         ...or the paid vendor, deliberately  $
 *   verdict   <domain>        Improve / Build / Defend / Ignore    $0
 *   board     <domain>        print the board                      $0
 *   competitors <domain> --live                                    $
 *   gap       <domain> --live                                      $
 *   all       <domain> --live seed→expand→volume→rankings→verdict  $0
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { AFFILIATE_SITE_SEEDS, ENTITY_SET_SEEDS } from '../seed/affiliate-sites.js'
import { upsertEntitySet } from '../spaces/entities.js'
import { findSiteByDomain, upsertAffiliateSite } from '../spaces/sites.js'
import {
  expandSiteSpace,
  listKeywordBoard,
  runVerdictPass,
  runVolumePass,
} from '../spaces/research.js'
import { pullCompetitorGap, pullCompetitors, pullRankings } from '../spaces/rankings.js'
import { runDifficultyPass } from '../spaces/difficulty.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (name: string): boolean => argv.includes(`--${name}`)
const live = flag('live')

function bullet(lines: string[]): void {
  for (const l of lines) console.log(`   · ${l}`)
}

async function requireSite(domain: string | undefined): Promise<number> {
  if (!domain) throw new Error('a domain is required, e.g. hotelhottubs.com')
  const site = await findSiteByDomain(db(), domain)
  if (!site) throw new Error(`No site for ${domain}. Run \`seed\` first.`)
  return site.id
}

async function seed(): Promise<void> {
  for (const set of ENTITY_SET_SEEDS) {
    const r = await upsertEntitySet(db(), set)
    console.log(`entity set ${set.slug}: ${r.upserted} active, ${r.deactivated} deactivated`)
  }
  for (const s of AFFILIATE_SITE_SEEDS) {
    const site = await upsertAffiliateSite(db(), {
      domain: s.domain,
      displayName: s.displayName,
      keywordSpace: s.keywordSpace,
      platformVerticals: s.platformVerticals,
      notes: s.notes,
      /**
       * Economics are left NULL on purpose. Order value and commission are
       * operator inputs and conversion is a network measurement; seeding
       * plausible numbers would give every keyword a confident value derived
       * from a guess.
       */
    })
    console.log(`site ${site.domain} (#${site.id}) kind=${site.kind} status=${site.status}`)
  }
  console.log('\nEconomics are unset, so keywords will rank on demand and difficulty only.')
}

async function expand(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await expandSiteSpace(db(), siteId)
  console.log(
    `generated ${r.generated} · inserted ${r.inserted} · already present ${r.alreadyPresent} · dropped ${r.dropped}`,
  )
  if (r.notes.length) bullet(r.notes)
}

async function volume(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await runVolumePass(db(), siteId, { live })
  console.log(
    `scope ${r.scope} · requested ${r.requested} · measured ${r.measured} ` +
      `(of which zero: ${r.measuredZero}) · unmeasured ${r.unmeasured} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  if (!live) console.log('   · --live not passed, so nothing was fetched.')
  if (r.unmeasured > 0) {
    bullet([
      `${r.unmeasured} keyword(s) have NO measurement. That is not zero demand — they sort last and stay UNKNOWN.`,
    ])
  }
}

async function rankings(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await pullRankings(db(), siteId, { allowLabs: flag('labs'), live })
  console.log(
    `source ${r.source} · found ${r.keywordsFound} · new ${r.inserted} · updated ${r.updated} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  if (r.notes.length) bullet(r.notes)
}

async function difficulty(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const maxArg = argv.find((a) => a.startsWith('--max='))
  const r = await runDifficultyPass(db(), siteId, {
    live,
    ...(maxArg ? { max: Number(maxArg.slice('--max='.length)) } : {}),
  })
  console.log(
    `eligible ${r.eligible} · scored ${r.scored} · SERPs bought ${r.serpsBought} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  if (r.notes.length) bullet(r.notes)
}

async function verdict(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await runVerdictPass(db(), siteId)
  console.log(`scored ${r.scored}`)
  for (const [k, v] of Object.entries(r.byVerdict)) console.log(`   ${k.padEnd(8)} ${v}`)
  if (r.notes.length) bullet(r.notes)
}

async function board(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const rows = await listKeywordBoard(db(), siteId, { limit: 40 })
  if (rows.length === 0) return void console.log('nothing yet — run expand, volume, verdict')

  const dash = (v: unknown): string => (v === null || v === undefined ? '—' : String(v))
  console.log(
    `${'verdict'.padEnd(8)} ${'vol'.padStart(7)} ${'pos'.padStart(4)} ${'kd'.padStart(4)}  keyword`,
  )
  for (const r of rows) {
    console.log(
      `${dash(r.verdict).padEnd(8)} ${dash(r.volume).padStart(7)} ${dash(r.position).padStart(4)} ` +
        `${dash(r.difficulty).padStart(4)}  ${r.keyword}`,
    )
  }
  console.log(
    `\nvolume scope: ${rows[0]?.volumeScope ?? '—'} · '—' means UNMEASURED, never zero.`,
  )
}

async function competitors(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await pullCompetitors(db(), siteId, { live })
  console.log(
    `found ${r.found} · peers ${r.peers} · out of weight class ${r.giants} · undecided ${r.undecided} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  if (r.notes.length) bullet(r.notes)
}

async function gap(domain: string | undefined): Promise<void> {
  const siteId = await requireSite(domain)
  const r = await pullCompetitorGap(db(), siteId, { live })
  console.log(
    `peers queried ${r.peersQueried} · new keywords ${r.discovered} · cost ${formatMicrosUsd(r.costMicros)}`,
  )
  if (r.notes.length) bullet(r.notes)
}

try {
  switch (command) {
    case 'seed':
      await seed()
      break
    case 'expand':
      await expand(positional[0])
      break
    case 'volume':
      await volume(positional[0])
      break
    case 'rankings':
      await rankings(positional[0])
      break
    case 'difficulty':
      await difficulty(positional[0])
      break
    case 'verdict':
      await verdict(positional[0])
      break
    case 'board':
      await board(positional[0])
      break
    case 'competitors':
      await competitors(positional[0])
      break
    case 'gap':
      await gap(positional[0])
      break
    case 'all': {
      await seed()
      const domain = positional[0]
      console.log(`\n--- expand ---`)
      await expand(domain)
      console.log(`\n--- volume ---`)
      await volume(domain)
      console.log(`\n--- rankings ---`)
      await rankings(domain)
      console.log(`\n--- verdict ---`)
      await verdict(domain)
      console.log(`\n--- board ---`)
      await board(domain)
      break
    }
    default:
      console.log(
        [
          'affiliate-research <command> [domain] [--live] [--labs]',
          '',
          '  seed                       create/refresh both sites + entity sets   $0',
          '  expand      <domain>       generate the keyword space                $0',
          '  volume      <domain> --live measure demand                           $0',
          '  rankings    <domain> --live what we rank for (Search Console)        $0',
          '                       --labs ...or the paid vendor, deliberately      $',
          '  difficulty  <domain> --live buy SERPs for the volume survivors ONLY  $',
          '                       --max=N cap (default 25)',
          '  verdict     <domain>       Improve / Build / Defend / Ignore         $0',
          '  board       <domain>       print the board                           $0',
          '  competitors <domain> --live                                          $',
          '  gap         <domain> --live                                          $',
          '  all         <domain> --live everything free, in order                $0',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
