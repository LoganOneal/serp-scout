/**
 * Supply: connect a directory site's inventory feed and read what it implies.
 *
 * ==================== NOTHING HERE WRITES TO YOUR SITE ====================
 * Every command is a read of the feed plus a write to OUR read model. The site
 * owns supply; this system holds a cache and says when it last refreshed. See
 * docs/plan-supply.md §0.2.
 * =========================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/supply.mts <command>
 *
 *   connect  --site=hotelhottubs.com --url=https://hotelhottubs.com/api/supply
 *            [--token-env=SUPPLY_FEED_TOKEN] [--entity-kind=locality|entity_set:vendors|none]
 *   sources  [--site=...]
 *   check    <sourceId>                       reach the feed, write nothing
 *   pull     <sourceId> [--since=ISO] [--dry-run] [--page-size=500] [--max-pages=200]
 *   board    --site=... [--cell=SUPPLY_GAP] [--limit=40]      the 2x2
 *   items    --site=... [--entity=aspen-co] [--q=...] [--max-price=400]
 *   unresolved <sourceId> [--limit=50]
 *   runs     <sourceId> [--limit=10]
 *   forget   <sourceId> --yes                 delete a source and its rows
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { findSiteByDomain } from '../spaces/sites.js'
import {
  checkSupplySource,
  connectSupplySource,
  listSupplySources,
} from '../supply/sources.js'
import { forgetSource, ingestSupply, listIngestRuns, listUnresolvedSuppliers } from '../supply/ingest.js'
import { supplyOpportunityReport } from '../supply/coverage.js'
import { searchSupplyItems } from '../supply/query.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (n: string): boolean => argv.includes(`--${n}`)
const opt = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const bullet = (lines: string[]): void => lines.forEach((l) => console.log(`   · ${l}`))
const dash = (v: unknown): string => (v === null || v === undefined ? '—' : String(v))

async function requireSite(): Promise<{ id: number; domain: string }> {
  const domain = opt('site')
  if (!domain) throw new Error('--site=hotelhottubs.com is required')
  const site = await findSiteByDomain(db(), domain)
  if (!site) throw new Error(`no site for ${domain}`)
  return { id: site.id, domain: site.domain ?? domain }
}

const requireId = (v: string | undefined, what: string): number => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`a ${what} is required`)
  return n
}

async function connect(): Promise<void> {
  const site = await requireSite()
  const url = opt('url')
  if (!url) throw new Error('--url=https://yoursite.com/api/supply is required')

  const kindArg = opt('entity-kind') ?? 'locality'
  const entityKind = kindArg === 'none' ? null : kindArg

  const source = await connectSupplySource(db(), {
    siteId: site.id,
    baseUrl: url,
    ...(opt('token-env') ? { tokenEnvVar: opt('token-env')! } : {}),
    entityKind,
    ...(opt('notes') ? { notes: opt('notes')! } : {}),
  })

  console.log(`source #${source.id} · ${source.baseUrl} · entity_kind ${dash(source.entityKind)}`)
  bullet([
    `Set ${source.tokenEnvVar} here to the same value as on the site. The token is NOT stored ` +
      `in the database — only the name of the variable holding it.`,
    `Then: supply check ${source.id}`,
  ])
}

async function sources(): Promise<void> {
  const domain = opt('site')
  const site = domain ? await findSiteByDomain(db(), domain) : null
  const rows = await listSupplySources(db(), site?.id)
  if (rows.length === 0) return void console.log('no supply sources')
  for (const s of rows) {
    const m = s.lastManifest as { totalItems?: number } | null
    console.log(
      `#${String(s.id).padEnd(3)} ${(s.entityKind ?? 'none').padEnd(22)} ` +
        `${String(m?.totalItems ?? '—').padStart(7)} items  ` +
        `pulled ${s.lastPulledAt?.toISOString().slice(0, 16).replace('T', ' ') ?? 'never'}  ${s.baseUrl}`,
    )
  }
}

async function check(): Promise<void> {
  const id = requireId(positional[0], 'source id')
  const r = await checkSupplySource(db(), id)
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.detail}`)
  if (!r.ok) {
    bullet([
      'Four different things look like "no supply" from here and this separates them: the feed ' +
        'is unreachable, the token is wrong, no token is configured on THEIR side (503), or the ' +
        'catalogue is genuinely empty.',
    ])
  }
}

async function pull(): Promise<void> {
  const id = requireId(positional[0], 'source id')
  const r = await ingestSupply(db(), {
    sourceId: id,
    since: opt('since') ?? null,
    dryRun: flag('dry-run'),
    ...(opt('page-size') ? { pageSize: Number(opt('page-size')) } : {}),
    ...(opt('max-pages') ? { maxPages: Number(opt('max-pages')) } : {}),
  })

  console.log(
    `run ${r.runId ?? '(dry)'} · ${r.status.toUpperCase()} · ${r.mode} · ` +
      `${r.itemsPulled} pulled / ${r.manifestTotalItems ?? '—'} in manifest · ` +
      `${r.suppliersUpserted} supplier(s), ${r.unresolvedSuppliers} unresolved · ` +
      `${r.itemsMarkedGone} marked gone · ${r.entitiesCovered} entities covered`,
  )
  if (r.notes.length) bullet(r.notes)
}

async function board(): Promise<void> {
  const site = await requireSite()
  const report = await supplyOpportunityReport(db(), site.id, {
    ...(opt('floor') ? { volumeFloor: Number(opt('floor')) } : {}),
  })

  console.log(
    Object.entries(report.byCell)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · '),
  )
  console.log()

  const cell = opt('cell')
  const rows = (cell ? report.rows.filter((r) => r.cell === cell) : report.rows).slice(
    0,
    Number(opt('limit') ?? '40'),
  )

  console.log(
    `${'cell'.padEnd(12)} ${'entity'.padEnd(26)} ${'sup'.padStart(4)} ${'items'.padStart(6)} ` +
      `${'median'.padStart(9)} ${'kws'.padStart(5)} ${'vol'.padStart(8)}`,
  )
  for (const r of rows) {
    console.log(
      `${r.cell.padEnd(12)} ${r.entitySlug.slice(0, 26).padEnd(26)} ` +
        `${String(r.supplierCount).padStart(4)} ${String(r.availableItemCount).padStart(6)} ` +
        `${(r.medianPriceMicros === null ? '—' : formatMicrosUsd(r.medianPriceMicros, { precision: 0 })).padStart(9)} ` +
        `${String(r.keywordCount).padStart(5)} ${dash(r.bestVolume).padStart(8)}`,
    )
  }

  if (report.notes.length) {
    console.log()
    bullet(report.notes)
  }
  console.log(
    `\nSUPPLY_GAP = demand we cannot fulfil: do not build, do not bid. KEYWORD_GAP = inventory ` +
      `nobody can\nfind, and the cheapest page in the portfolio. UNKNOWN is an unmeasured signal, ` +
      `never a zero.`,
  )
}

async function items(): Promise<void> {
  const site = await requireSite()
  const maxPrice = opt('max-price')
  const rows = await searchSupplyItems(db(), {
    siteId: site.id,
    entitySlug: opt('entity') ?? null,
    q: opt('q') ?? null,
    maxPriceMicros: maxPrice ? BigInt(Math.round(Number(maxPrice) * 1_000_000)) : null,
    availableOnly: !flag('include-unavailable'),
    limit: Number(opt('limit') ?? '25'),
  })
  if (rows.length === 0) return void console.log('no items')
  for (const r of rows) {
    console.log(
      `${(r.priceMicros === null ? '—' : formatMicrosUsd(r.priceMicros, { precision: 0 })).padStart(8)} ` +
        `${(r.entitySlug ?? '—').padEnd(20)} ${r.supplierName.slice(0, 24).padEnd(24)} ${r.title}`,
    )
  }
}

async function unresolved(): Promise<void> {
  const id = requireId(positional[0], 'source id')
  const rows = await listUnresolvedSuppliers(db(), id, Number(opt('limit') ?? '50'))
  if (rows.length === 0) return void console.log('every supplier resolved')
  for (const r of rows) {
    console.log(
      `${String(r.items).padStart(4)} item(s)  ${r.name.slice(0, 30).padEnd(30)} ` +
        `${[r.rawCity, r.rawRegion].filter(Boolean).join(', ') || '(no location)'}`,
    )
    if (r.reason) console.log(`              ${r.reason}`)
  }
  console.log(
    `\nThese contribute to NO entity's coverage and are never counted as a zero for one. ` +
      `An\nunresolved supplier is an importer problem; a locality with no hotels is a supply one.`,
  )
}

async function runs(): Promise<void> {
  const id = requireId(positional[0], 'source id')
  const rows = await listIngestRuns(db(), id, Number(opt('limit') ?? '10'))
  for (const r of rows) {
    console.log(
      `#${String(r.id).padEnd(4)} ${r.status.padEnd(8)} ${r.mode.padEnd(12)} ` +
        `${String(r.itemsPulled).padStart(6)}/${dash(r.manifestTotalItems).padStart(6)} · ` +
        `unresolved ${r.unresolvedSuppliers} · gone ${r.itemsMarkedGone} · ` +
        `${r.startedAt.toISOString().slice(0, 16).replace('T', ' ')}`,
    )
    if (r.error) console.log(`      ! ${r.error}`)
    if (r.notes?.length) bullet(r.notes)
  }
}

async function forget(): Promise<void> {
  const id = requireId(positional[0], 'source id')
  if (!flag('yes')) throw new Error('pass --yes: this deletes the source and every row it ingested')
  await forgetSource(db(), id)
  console.log(`source #${id} and its items, suppliers and runs deleted`)
}

try {
  switch (command) {
    case 'connect': await connect(); break
    case 'sources': await sources(); break
    case 'check': await check(); break
    case 'pull': await pull(); break
    case 'board': await board(); break
    case 'items': await items(); break
    case 'unresolved': await unresolved(); break
    case 'runs': await runs(); break
    case 'forget': await forget(); break
    default:
      console.log(
        [
          'supply <command>',
          '',
          '  connect  --site=... --url=https://.../api/supply                  $0',
          '           [--token-env=SUPPLY_FEED_TOKEN] [--entity-kind=locality]',
          '  sources  [--site=...]                                            $0',
          '  check    <sourceId>            reach the feed, write nothing      $0',
          '  pull     <sourceId> [--since=ISO] [--dry-run]                     $0',
          '  board    --site=... [--cell=SUPPLY_GAP]        the 2x2            $0',
          '  items    --site=... [--entity=...] [--q=...] [--max-price=400]    $0',
          '  unresolved <sourceId>          what the ingest could not place    $0',
          '  runs     <sourceId>                                              $0',
          '  forget   <sourceId> --yes                                        $0',
          '',
          '  All free — a supply feed costs no vendor money, only the publisher’s database.',
          '  Nothing here writes to your site. Start with `connect`, then `check`, then `pull`.',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
