/**
 * Import keyword research and its clusters, and read the cluster board.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/clusters.mts <command>
 *
 *   import <domain> --dir=<path> [--dry-run]   import CSVs           $0
 *   refresh <domain>                           recompute aggregates  $0
 *   verdict <domain>                           decide every cluster  $0
 *   board   <domain> [--kind=locality] [--limit=40]                  $0
 *   members <domain> <clusterSlug>                                   $0
 */
import 'dotenv/config'
import { db } from '../db.js'
import { findSiteByDomain } from '../spaces/sites.js'
import {
  autoClusterByEntity,
  importClusterResearch,
  mergeDuplicateEntityClusters,
  refreshClusterAggregates,
} from '../spaces/import-clusters.js'
import { listClusterBoard, listClusterMembers, runClusterVerdicts } from '../spaces/clusters.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const bullet = (lines: string[]): void => lines.forEach((l) => console.log(`   · ${l}`))
const dash = (v: unknown): string => (v === null || v === undefined ? '—' : String(v))

async function site(domain: string | undefined) {
  if (!domain) throw new Error('a site domain is required')
  const s = await findSiteByDomain(db(), domain)
  if (!s) throw new Error(`no site for ${domain}`)
  return s
}

try {
  switch (command) {
    case 'import': {
      const s = await site(positional[0])
      const dir = opt('dir')
      if (!dir) throw new Error('--dir=<path to the CSV folder> is required')
      const r = await importClusterResearch(db(), {
        siteId: s.id,
        dir,
        dryRun: flag('dry-run'),
      })
      console.log(
        `run ${r.runId ?? '(dry)'} · ${r.filesRead.length} file(s) · ${r.rowsRead} row(s) read · ` +
          `${r.keywordsUpserted} keyword(s) · ${r.clustersUpserted} cluster(s) · ` +
          `${r.unresolvedEntities} unresolved · ${r.quarantined} quarantined`,
      )
      bullet(r.notes)
      break
    }

    case 'refresh': {
      const s = await site(positional[0])
      const n = await refreshClusterAggregates(db(), s.id)
      console.log(`recomputed ${n} cluster aggregate(s)`)
      break
    }

    case 'autocluster': {
      const s = await site(positional[0])
      const r = await autoClusterByEntity(db(), s.id)
      console.log(
        `considered ${r.considered} unclustered · assigned ${r.assigned} · ` +
          `${r.clustersCreated} cluster(s) created · ${r.ambiguous} ambiguous · ${r.unmatched} unmatched`,
      )
      bullet(r.notes)
      break
    }

    case 'merge': {
      const s = await site(positional[0])
      const r = await mergeDuplicateEntityClusters(db(), s.id)
      console.log(`merged ${r.merged} entit(ies) · removed ${r.removed} duplicate cluster(s)`)
      bullet(r.notes)
      break
    }

    case 'verdict': {
      const s = await site(positional[0])
      const r = await runClusterVerdicts(db(), s.id)
      console.log(`scored ${r.scored} cluster(s)`)
      for (const [k, v] of Object.entries(r.byVerdict)) console.log(`   ${k.padEnd(9)} ${v}`)
      bullet(r.notes)
      break
    }

    case 'board': {
      const s = await site(positional[0])
      const rows = await listClusterBoard(db(), s.id, {
        ...(opt('kind') ? { kinds: [opt('kind')!] } : {}),
        limit: Number(opt('limit') ?? '40'),
      })
      if (rows.length === 0) {
        console.log('no clusters')
        break
      }

      console.log(
        `${'verdict'.padEnd(8)} ${'cluster'.padEnd(24)} ${'kind'.padEnd(13)} ` +
          `${'vol(max)'.padStart(9)} ${'sum'.padStart(9)} ${'kd'.padStart(8)} ` +
          `${'supply'.padStart(14)} ${'kws'.padStart(4)}`,
      )
      for (const c of rows) {
        const kd = c.kdMin === null ? '—' : `${c.kdMin}/${dash(c.kdMedian)}`
        const supply =
          c.kind !== 'locality'
            ? 'n/a'
            : c.availableItems === null
              ? 'unknown'
              : c.staysNeeded > 0
                ? `${c.availableItems} · need ${c.staysNeeded}`
                : `${c.availableItems} ok`
        console.log(
          `${dash(c.verdict).padEnd(8)} ${c.slug.slice(0, 24).padEnd(24)} ${c.kind.padEnd(13)} ` +
            `${dash(c.volumeMax).padStart(9)} ${dash(c.volumeSum).padStart(9)} ${kd.padStart(8)} ` +
            `${supply.padStart(14)} ${String(c.memberCount).padStart(4)}`,
        )
      }
      console.log(
        `\nRanked on vol(max), never on sum. Summing a cluster's members double-counts ` +
          `near-identical\nphrasings — measured at 4.5x, 7.3x and 11.2x across three cities in ` +
          `this very export, which\nreorders them rather than merely inflating them.`,
      )
      break
    }

    case 'members': {
      const s = await site(positional[0])
      const slug = positional[1]
      if (!slug) throw new Error('a cluster slug is required')
      const rows = await listClusterMembers(db(), s.id, slug)
      if (rows.length === 0) {
        console.log('no members')
        break
      }
      for (const m of rows) {
        console.log(
          `${dash(m.semrushVolume).padStart(8)} ${dash(m.semrushKd).padStart(4)}  ` +
            `${(m.intent ?? '—').padEnd(5)} ${m.keyword}`,
        )
      }
      break
    }

    default:
      console.log(
        [
          'clusters <command>',
          '',
          '  import  <domain> --dir=<path> [--dry-run]   $0',
          '  refresh <domain>                            $0',
          '  autocluster <domain>   bind keywords to a market by name   $0',
          '  merge   <domain>       collapse clusters on the same entity   $0',
          '  verdict <domain>                            $0',
          '  board   <domain> [--kind=locality]          $0',
          '  members <domain> <clusterSlug>              $0',
          '',
          '  All free — a CSV import and a model change, no vendor calls.',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
