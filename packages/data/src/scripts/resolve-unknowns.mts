/**
 * Re-read every UNKNOWN row through the renderer and persist what it resolves.
 *
 * A sample of 25 resolved 18 (72%), every one of them to LIVE -- so UNKNOWN was
 * systematically holding working businesses, which is exactly what six operator
 * spot-checks kept finding by hand.
 */
import 'dotenv/config'
import postgres from 'postgres'
import { formatMicrosUsd } from '@rnr/core'
import { renderUnresolved } from '../domains/js-render.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<{ domain: string }>>`
  SELECT DISTINCT domain FROM domain_candidates WHERE status = 'UNKNOWN' ORDER BY domain`
console.log(`${rows.length} distinct UNKNOWN domain(s)\n`)

const r = await renderUnresolved(rows.map((x) => x.domain), { maxRenders: rows.length, concurrency: 6 })

let updated = 0
for (const res of r.results) {
  if (res.verdict !== 'live' && res.verdict !== 'parked') continue
  const status = res.verdict === 'live' ? 'LIVE' : 'PARKED_DEAD'
  const out = await sql`
    UPDATE domain_candidates
       SET status = ${status}, reason = ${`Rendered: ${res.detail}`}
     WHERE domain = ${res.domain} AND status = 'UNKNOWN'`
  updated += out.count
}

const by = new Map<string, number>()
for (const x of r.results) by.set(x.verdict, (by.get(x.verdict) ?? 0) + 1)
console.log(`verdicts: ${[...by].map(([k, v]) => `${k}=${v}`).join('  ')}`)
console.log(`rows updated: ${updated} · cost ${formatMicrosUsd(r.costMicros, { precision: 4 })}`)

const after = await sql<Array<{ status: string; n: number }>>`
  SELECT status, count(*)::int n FROM domain_candidates GROUP BY status ORDER BY n DESC`
console.log('\nall rows:', after.map((x) => `${x.status}=${x.n}`).join('  '))
await sql.end()
