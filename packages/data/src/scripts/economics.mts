/**
 * Affiliate economics: commission, order value, and observed conversion.
 *
 * ==================== THERE IS NO --conversion-rate FLAG ====================
 * `observe` takes CLICKS and ORDERS, and derives the rate. A rate typed in as a
 * number loses the only thing that makes it usable: "3% from 40 clicks" and "3%
 * from 40,000" are different facts, and the paid-search model treats them
 * differently or it is not doing its job.
 *
 * If you only know "about 3%", state the sample it came from. If you cannot,
 * enter nothing — the model will keep saying UNKNOWN, which is correct.
 * ==========================================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/economics.mts <command>
 *
 *   set        <domain> --commission-bps=750 [--order-value=300]
 *   set-vendor <domain> <entity-slug> --commission-bps=2000
 *   set-value  <domain> <entity-slug> --order-value=450 [--set=peptides]
 *   observe    <domain> --clicks=412 --orders=11 [--sale=3300] [--commission=247.50]
 *                       [--scope=entity:peptide-sciences] --from=2026-07-01 --to=2026-07-31
 *   show       <domain> [--keyword="..."]
 */
import 'dotenv/config'
import { formatMicrosUsd, usdToMicros, type AffiliateScopeKind } from '@rnr/core'
import { eq } from 'drizzle-orm'
import { db } from '../db.js'
import { sites } from '../schema.js'
import { findSiteByDomain } from '../spaces/sites.js'
import {
  forgetObservation,
  listObservations,
  loadEconomicsCatalog,
  recordObservation,
  resolveKeywordEconomics,
  setCommissionRate,
  setEntityOrderValue,
} from '../economics/store.js'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'help'
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const opt = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const bullet = (lines: string[]): void => lines.forEach((l) => console.log(`   · ${l}`))

async function siteId(domain: string | undefined): Promise<number> {
  if (!domain) throw new Error('a domain is required')
  const site = await findSiteByDomain(db(), domain)
  if (!site) throw new Error(`No site for ${domain}`)
  return site.id
}

const pct = (bps: number | null | undefined): string =>
  bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(2)}%`

async function set(domain: string | undefined): Promise<void> {
  const id = await siteId(domain)
  const bps = opt('commission-bps')
  const orderValue = opt('order-value')

  if (bps) {
    await setCommissionRate(db(), {
      siteId: id,
      entitySlug: null,
      commissionRateBps: Number(bps),
      ...(opt('from') ? { effectiveFrom: opt('from')! } : {}),
      ...(opt('note') ? { note: opt('note')! } : {}),
    })
    console.log(`${domain}: site commission ${pct(Number(bps))}`)
  }

  if (orderValue) {
    await db()
      .update(sites)
      .set({ affiliateOrderValueMicros: usdToMicros(Number(orderValue)), updatedAt: new Date() })
      .where(eq(sites.id, id))
    console.log(`${domain}: site order value ${formatMicrosUsd(usdToMicros(Number(orderValue)), { precision: 2 })}`)
    console.log(
      '   · This is ONE number for every keyword on the site. Order value varies more across ' +
        'destinations than commission varies across vendors — set per-entity values with ' +
        '`set-value` where it matters.',
    )
  }

  if (!bps && !orderValue) console.log('nothing to set — pass --commission-bps and/or --order-value')
}

async function setVendor(domain: string | undefined, slug: string | undefined): Promise<void> {
  const id = await siteId(domain)
  if (!slug) throw new Error('an entity slug is required, e.g. peptide-sciences')
  const bps = Number(opt('commission-bps'))
  if (!Number.isFinite(bps)) throw new Error('--commission-bps is required (2000 = 20%)')

  await setCommissionRate(db(), {
    siteId: id,
    entitySlug: slug,
    commissionRateBps: bps,
    ...(opt('from') ? { effectiveFrom: opt('from')! } : {}),
    ...(opt('note') ? { note: opt('note')! } : {}),
  })
  console.log(`${domain}: ${slug} commission ${pct(bps)}`)
}

async function setValue(domain: string | undefined, slug: string | undefined): Promise<void> {
  await siteId(domain)
  if (!slug) throw new Error('an entity slug is required')
  const usd = Number(opt('order-value'))
  if (!Number.isFinite(usd)) throw new Error('--order-value is required')

  await setEntityOrderValue(db(), {
    entitySlug: slug,
    ...(opt('set') ? { setSlug: opt('set')! } : {}),
    orderValueMicros: usdToMicros(usd),
  })
  console.log(`${slug}: order value ${formatMicrosUsd(usdToMicros(usd), { precision: 2 })}`)
}

async function observe(domain: string | undefined): Promise<void> {
  const id = await siteId(domain)
  const clicks = Number(opt('clicks'))
  const orders = Number(opt('orders'))

  if (!Number.isFinite(clicks) || !Number.isFinite(orders)) {
    throw new Error(
      '--clicks and --orders are BOTH required. There is no flag that takes a bare rate: the ' +
        'sample size is what makes the number usable.',
    )
  }

  const [kind, ref] = (opt('scope') ?? 'site').split(':')
  const today = new Date().toISOString().slice(0, 10)

  const r = await recordObservation(db(), {
    siteId: id,
    scopeKind: (kind ?? 'site') as AffiliateScopeKind,
    scopeRef: ref ?? null,
    periodStart: opt('from') ?? today,
    periodEnd: opt('to') ?? today,
    clicks,
    orders,
    ...(opt('sale') ? { saleValueMicros: usdToMicros(Number(opt('sale'))) } : {}),
    ...(opt('commission') ? { commissionMicros: usdToMicros(Number(opt('commission'))) } : {}),
    ...(opt('by') ? { enteredBy: opt('by')! } : {}),
    ...(opt('note') ? { note: opt('note')! } : {}),
  })

  console.log(`observation #${r.id} recorded for scope ${kind}${ref ? `:${ref}` : ''}`)
  console.log(`   conversion          ${pct(r.derived.conversionBps)}  (n = ${clicks} clicks)`)
  console.log(
    `   average order       ${r.derived.averageOrderValueMicros === null ? '—' : formatMicrosUsd(r.derived.averageOrderValueMicros, { precision: 2 })}`,
  )
  console.log(`   effective commission ${pct(r.derived.effectiveCommissionBps)}`)
  if (r.derived.effectiveCommissionBps === null) {
    bullet(['pass --sale and --commission to derive the EFFECTIVE rate, which is what actually landed'])
  }
}

async function show(domain: string | undefined): Promise<void> {
  const id = await siteId(domain)
  const catalog = await loadEconomicsCatalog(db(), id)

  console.log(`${domain} — economics as of ${catalog.asOf}`)
  console.log(
    `\nsite order value      ${catalog.siteDefaultOrderValueMicros === null ? '— (unset)' : formatMicrosUsd(catalog.siteDefaultOrderValueMicros, { precision: 2 })}`,
  )
  console.log(`vendor dimension      ${catalog.vendorDimension ?? '— (no brand entity set)'}`)
  console.log(`order-value dims      ${catalog.orderValueDimensions.join(', ') || '—'}`)

  console.log('\ncommission rates')
  if (catalog.commissionRates.length === 0) console.log('   — none set')
  for (const r of catalog.commissionRates.sort((a, b) =>
    (a.entitySlug ?? '').localeCompare(b.entitySlug ?? ''),
  )) {
    console.log(
      `   ${(r.entitySlug ?? '(site default)').padEnd(24)} ${pct(r.commissionRateBps).padStart(8)}   from ${r.effectiveFrom}`,
    )
  }

  console.log('\nobservations')
  if (catalog.observations.size === 0) {
    console.log('   — none. Every conversion rate will be UNKNOWN until one is recorded.')
  }
  for (const [scope, agg] of catalog.observations) {
    console.log(
      `   ${scope.padEnd(36)} ${String(agg.orders).padStart(6)} / ${String(agg.clicks).padStart(7)} clicks = ` +
        `${pct(Math.round((agg.orders / agg.clicks) * 10_000)).padStart(8)}   to ${agg.periodEnd}`,
    )
  }

  const keyword = opt('keyword')
  if (keyword) {
    console.log(`\nresolved for "${keyword}"`)
    const resolved = resolveKeywordEconomics(catalog, {
      keywordNorm: keyword,
      patternLabel: opt('pattern') ?? null,
      entities: opt('entities')
        ? Object.fromEntries(opt('entities')!.split(',').map((p) => p.split(':') as [string, string]))
        : null,
    })
    console.log(
      `   commission   ${pct(resolved.commissionRateBps.value).padStart(8)}   from ${resolved.commissionRateBps.resolvedFrom}`,
    )
    console.log(
      `   order value  ${(resolved.orderValueMicros.value === null ? '—' : formatMicrosUsd(resolved.orderValueMicros.value, { precision: 2 })).padStart(8)}   from ${resolved.orderValueMicros.resolvedFrom}${resolved.orderValueMicros.inherited ? ' (INHERITED)' : ''}`,
    )
    console.log(
      `   per conversion ${(resolved.valuePerConversionMicros === null ? '—' : formatMicrosUsd(resolved.valuePerConversionMicros, { precision: 2 })).padStart(6)}`,
    )
    if (resolved.conversion) {
      const c = resolved.conversion
      console.log(
        `   conversion   ${pct(c.meanBps).padStart(8)}   (10th-pct ${pct(c.lowerBps)}, raw ${pct(c.rawBps)}, n=${c.clicks})`,
      )
      console.log(`     from ${c.resolvedFrom}, own-data weight ${(c.ownDataWeight * 100).toFixed(0)}%, to ${c.periodEnd ?? '—'}`)
      for (const link of c.chain) {
        console.log(`       ${link.label.padEnd(34)} ${String(link.orders).padStart(5)}/${String(link.clicks).padStart(7)} = ${pct(link.rateBps)}`)
      }
    } else {
      console.log('   conversion   — no observations reach this keyword')
    }
  }
}

async function list(domain: string | undefined): Promise<void> {
  const id = await siteId(domain)
  const rows = await listObservations(db(), id)
  if (rows.length === 0) return void console.log('no observations recorded')
  console.log(`${'id'.padStart(5)}  ${'scope'.padEnd(30)} ${'orders/clicks'.padStart(15)}  period       source   note`)
  for (const r of rows) {
    console.log(
      `${String(r.id).padStart(5)}  ${r.scope.padEnd(30)} ${`${r.orders}/${r.clicks}`.padStart(15)}  ` +
        `${r.periodEnd}   ${r.source.padEnd(8)} ${r.note ?? ''}`,
    )
  }
}

async function forget(id: string | undefined): Promise<void> {
  if (!id) throw new Error('an observation id is required — see `list`')
  const removed = await forgetObservation(db(), Number(id))
  if (!removed) return void console.log(`no observation #${id}`)
  console.log(`removed #${id}: ${removed.orders}/${removed.clicks} on ${removed.scope}`)
}

try {
  switch (command) {
    case 'set':
      await set(positional[0])
      break
    case 'list':
      await list(positional[0])
      break
    case 'forget':
      await forget(positional[0])
      break
    case 'set-vendor':
      await setVendor(positional[0], positional[1])
      break
    case 'set-value':
      await setValue(positional[0], positional[1])
      break
    case 'observe':
      await observe(positional[0])
      break
    case 'show':
      await show(positional[0])
      break
    default:
      console.log(
        [
          'economics <command>',
          '',
          '  set        <domain> --commission-bps=750 [--order-value=300]',
          '  set-vendor <domain> <slug> --commission-bps=2000',
          '  set-value  <domain> <slug> --order-value=450 [--set=peptides]',
          '  observe    <domain> --clicks=412 --orders=11 [--sale=3300] [--commission=247.50]',
          '                      [--scope=entity:peptide-sciences] [--from=..] [--to=..]',
          '  show       <domain> [--keyword="..."] [--pattern=..] [--entities=vendor:slug]',
          '  list       <domain>                    every observation recorded',
          '  forget     <observationId>             remove a mistyped one',
          '',
          '  There is deliberately no --conversion-rate flag. `observe` takes clicks and',
          '  orders; the rate is derived and keeps its sample size.',
        ].join('\n'),
      )
  }
} finally {
  await db().$client.end()
}
