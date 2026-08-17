/**
 * Is the price data on ingested supply plausible?
 *
 * ==================== WHY THIS IS NOT A COSMETIC QUESTION ====================
 * `orderValueFromSupply` turns a locality's MEDIAN listed price into an order
 * value, which `buildAdsPlan` feeds into break-even, which decides whether a
 * keyword may be bid on. Break-even is linear in order value, so a market whose
 * median is dragged down by junk rows demands an impossible conversion rate and
 * silently loses its keywords to SKIP.
 *
 * The mirror failure is worse: a market whose median is inflated authorises bids
 * it cannot pay back.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/peek-supply-prices.mts
 */
import 'dotenv/config'
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { formatMicrosUsd, MIN_ITEMS_FOR_MEDIAN, orderValueFromSupply } from '@rnr/core'
import { db } from '../db.js'
import { supplyItems, supplySuppliers } from '../schema.js'
import { coverageKey, loadCoverageMap } from '../supply/coverage.js'

const SITE_DOMAIN_ID = Number(process.argv[2] ?? '0')

const base = [isNull(supplyItems.goneAt), isNotNull(supplyItems.priceMicros)]
if (SITE_DOMAIN_ID > 0) base.push(eq(supplyItems.siteId, SITE_DOMAIN_ID))

const [stats] = await db()
  .select({
    n: sql<number>`count(*)::int`,
    min: sql<string>`min(${supplyItems.priceMicros})`,
    p10: sql<string>`(percentile_cont(0.10) within group (order by ${supplyItems.priceMicros}))::bigint`,
    median: sql<string>`(percentile_cont(0.50) within group (order by ${supplyItems.priceMicros}))::bigint`,
    p90: sql<string>`(percentile_cont(0.90) within group (order by ${supplyItems.priceMicros}))::bigint`,
    max: sql<string>`max(${supplyItems.priceMicros})`,
  })
  .from(supplyItems)
  .where(and(...base))

console.log('price distribution across ingested supply')
for (const [k, v] of Object.entries(stats ?? {})) {
  console.log(`  ${k.padEnd(7)} ${k === 'n' ? v : formatMicrosUsd(BigInt(v as string), { precision: 2 })}`)
}

/**
 * $20 is a POLICY line, not a measurement: no US hotel room with a private hot
 * tub rents for less. Anything under it is a scrape artefact — a resort fee, a
 * day-pass, a parsed-wrong currency — and it is priced as a night.
 */
const FLOOR = 20_000_000n

const [low] = await db()
  .select({ n: sql<number>`count(*)::int` })
  .from(supplyItems)
  .where(and(...base, lt(supplyItems.priceMicros, FLOOR)))

console.log(`\nbelow $20/night: ${low?.n ?? 0} of ${stats?.n ?? 0}`)

const worst = await db()
  .select({
    price: supplyItems.priceMicros,
    title: supplyItems.title,
    slug: supplySuppliers.entitySlug,
    url: supplyItems.url,
  })
  .from(supplyItems)
  .innerJoin(supplySuppliers, eq(supplyItems.supplierId, supplySuppliers.id))
  .where(and(...base, lt(supplyItems.priceMicros, FLOOR)))
  .orderBy(asc(supplyItems.priceMicros))
  .limit(12)

for (const w of worst) {
  console.log(
    `  ${formatMicrosUsd(w.price!, { precision: 2 }).padStart(8)}  ${(w.slug ?? '(unresolved)').padEnd(18)} ${w.title.slice(0, 46)}`,
  )
}

/**
 * The number that actually matters: markets whose MEDIAN is implausible. One
 * junk row in a market with twenty listings changes nothing; a market whose
 * median is $1 will price every keyword bound to it.
 */
const byEntity = await db()
  .select({
    slug: supplySuppliers.entitySlug,
    n: sql<number>`count(*)::int`,
    median: sql<string>`(percentile_cont(0.50) within group (order by ${supplyItems.priceMicros}))::bigint`,
  })
  .from(supplyItems)
  .innerJoin(supplySuppliers, eq(supplyItems.supplierId, supplySuppliers.id))
  .where(and(...base, isNotNull(supplySuppliers.entitySlug)))
  .groupBy(supplySuppliers.entitySlug)

const badMedians = byEntity.filter((e) => BigInt(e.median) < FLOOR)
console.log(`\nmarkets whose MEDIAN is below $20: ${badMedians.length} of ${byEntity.length}`)
for (const b of badMedians.slice(0, 10)) {
  console.log(`  ${formatMicrosUsd(BigInt(b.median), { precision: 2 }).padStart(8)}  ${b.slug}  (${b.n} listing(s))`)
}

/**
 * The mirror failure, and the more expensive one.
 *
 * A market whose median is too HIGH authorises bids it cannot pay back — the
 * break-even conversion rate looks easy, the plan says BUY, and the money is
 * real. $2,000 is again POLICY: suites exist above it, so a few rows over the
 * line are ordinary and a MEDIAN over it is not.
 */
const CEILING = 2_000_000_000n

const [high] = await db()
  .select({ n: sql<number>`count(*)::int` })
  .from(supplyItems)
  .where(and(...base, sql`${supplyItems.priceMicros} > ${CEILING}`))

console.log(`\nabove $2,000/night: ${high?.n ?? 0} of ${stats?.n ?? 0}`)

const highest = await db()
  .select({
    price: supplyItems.priceMicros,
    title: supplyItems.title,
    slug: supplySuppliers.entitySlug,
  })
  .from(supplyItems)
  .innerJoin(supplySuppliers, eq(supplyItems.supplierId, supplySuppliers.id))
  .where(and(...base, sql`${supplyItems.priceMicros} > ${CEILING}`))
  .orderBy(sql`${supplyItems.priceMicros} desc`)
  .limit(8)

for (const h of highest) {
  console.log(
    `  ${formatMicrosUsd(h.price!, { precision: 2 }).padStart(12)}  ${(h.slug ?? '(unresolved)').padEnd(18)} ${h.title.slice(0, 42)}`,
  )
}

const inflated = byEntity.filter((e) => BigInt(e.median) > CEILING)
console.log(`\nmarkets whose MEDIAN is above $2,000: ${inflated.length} of ${byEntity.length}`)
for (const b of inflated.slice(0, 10)) {
  console.log(`  ${formatMicrosUsd(BigInt(b.median), { precision: 2 }).padStart(12)}  ${b.slug}  (${b.n} listing(s))`)
}

/**
 * ==================== THE ONLY QUESTION THAT MATTERS ====================
 * An implausible median is harmless unless it can REACH the economics model.
 * `orderValueFromSupply` refuses a median computed from fewer than
 * MIN_ITEMS_FOR_MEDIAN listings, so this replays the real gate against every
 * suspect market rather than assuming either way.
 * =======================================================================
 */
const suspects = [...badMedians, ...inflated]
console.log(`\n--- would any suspect market actually price a keyword? ---`)
if (suspects.length === 0) {
  console.log('  no suspect markets')
} else {
  const [anyRow] = await db()
    .select({ siteId: supplySuppliers.siteId })
    .from(supplySuppliers)
    .where(isNotNull(supplySuppliers.entitySlug))
    .limit(1)
  const coverage = await loadCoverageMap(db(), anyRow?.siteId ?? 0)
  for (const s of suspects) {
    const cov = coverage.get(coverageKey('locality', s.slug!))
    const ov = orderValueFromSupply(cov)
    console.log(
      `  ${s.slug!.padEnd(20)} ${s.n} listing(s)  ->  ` +
        (ov === null
          ? `REFUSED (needs ${MIN_ITEMS_FOR_MEDIAN}+ listings) — cannot reach break-even`
          : `WOULD PRICE AT ${formatMicrosUsd(ov.orderValueMicros, { precision: 2 })}  <-- EXPOSED`),
    )
  }
}

console.log(
  `\nBreak-even is LINEAR in order value. A market priced at $1 demands an impossible\n` +
    `conversion rate and loses its keywords to SKIP; one priced too high authorises bids\n` +
    `it cannot pay back. A median over 3+ listings is robust to a single bad row, which\n` +
    `is why MIN_ITEMS_FOR_MEDIAN is the guard that carries this rather than an outlier\n` +
    `filter nobody would maintain.`,
)

await db().$client.end()
