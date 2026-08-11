/**
 * How does DataForSEO's `cpc` relate to the top-of-page bid range Google Ads
 * returns? Picks the derivation for the free source from evidence rather than
 * guessing, since decision metrics read cpcMicros.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-cpc-derivation.mts
 */
import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const [counts] = await sql<Array<{ total: number; with_cpc: number; with_bids: number }>>`
  SELECT count(*)::int AS total,
         count(cpc_micros)::int AS with_cpc,
         count(high_top_of_page_bid_micros)::int AS with_bids
    FROM keyword_volume_cache
`
console.log(
  `cache rows: ${counts?.total} · with cpc: ${counts?.with_cpc} · with bids: ${counts?.with_bids}\n`,
)

const rows = await sql<
  Array<{ keyword: string; cpc: string | null; lo: string | null; hi: string | null }>
>`
  SELECT keyword, cpc_micros::text AS cpc,
         low_top_of_page_bid_micros::text AS lo,
         high_top_of_page_bid_micros::text AS hi
    FROM keyword_volume_cache
   WHERE cpc_micros IS NOT NULL
   ORDER BY keyword
   LIMIT 12
`
if (rows.length === 0) {
  console.log('No cached rows carry a DataForSEO cpc — nothing to calibrate against.')
} else {
  const usd = (m: string | null) => (m == null ? null : Number(m) / 1_000_000)
  console.log('keyword                        cpc     low    high   cpc/low  cpc/high')
  console.log('-'.repeat(74))
  for (const r of rows) {
    const c = usd(r.cpc)
    const lo = usd(r.lo)
    const hi = usd(r.hi)
    console.log(
      `${r.keyword.slice(0, 28).padEnd(28)} ${String(c ?? '—').padStart(6)} ` +
        `${String(lo ?? '—').padStart(6)} ${String(hi ?? '—').padStart(6)} ` +
        `${(c != null && lo ? (c / lo).toFixed(2) : '—').padStart(8)} ` +
        `${(c != null && hi ? (c / hi).toFixed(2) : '—').padStart(9)}`,
    )
  }
}

await sql.end()
