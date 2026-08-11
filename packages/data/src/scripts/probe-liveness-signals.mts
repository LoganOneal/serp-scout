/**
 * Signals that prove a site is alive WITHOUT fetching it.
 *
 * If a page refuses our probe and refuses DataForSEO's renderer, the answer is
 * not necessarily a proxy. Several independent facts are already free:
 *
 *   serpRank  Google is ranking the domain right now. It cannot be dead.
 *   MX        Mail is configured. Parked domains rarely bother.
 *   Wayback   Archive crawled it recently and got content.
 *
 * This measures how many of the still-unreadable rows any of them settle.
 */
import 'dotenv/config'
import { Resolver } from 'node:dns/promises'
import postgres from 'postgres'
import { fetchWaybackHistory } from '../domains/wayback.js'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<{ domain: string; serp_rank: number | null }>>`
  SELECT DISTINCT ON (domain) domain, serp_rank FROM domain_candidates
   WHERE status = 'UNKNOWN' ORDER BY domain LIMIT 30`
await sql.end()

const resolver = new Resolver({ timeout: 5000, tries: 2 })
resolver.setServers(['1.1.1.1', '8.8.8.8'])
const DAY = 86_400_000

console.log('domain                              serp   MX  waybackLast      verdict')
console.log('-'.repeat(92))
let settled = 0
for (const r of rows) {
  let mx = 0
  try { mx = (await resolver.resolveMx(r.domain)).length } catch { /* none */ }
  const wb = await fetchWaybackHistory(r.domain, { timeoutMs: 25_000 })
  const last = wb.lastContentSnapshotAt
  const daysOld = last ? Math.round((Date.now() - last.getTime()) / DAY) : null

  const liveBySerp = r.serp_rank != null
  const liveByWayback = daysOld != null && daysOld <= 400
  const verdict = liveBySerp
    ? 'LIVE — Google ranks it'
    : liveByWayback
      ? `LIVE — archived ${daysOld}d ago`
      : mx > 0
        ? 'probably live — mail configured'
        : 'still unresolved'
  if (verdict.startsWith('LIVE')) settled += 1
  console.log(
    `${r.domain.slice(0, 34).padEnd(36)} ${String(r.serp_rank ?? '—').padStart(4)} ${String(mx).padStart(4)}  ` +
      `${(last ? last.toISOString().slice(0, 10) : '—').padEnd(12)} ${verdict}`,
  )
}
console.log(`\nsettled by free signals alone: ${settled}/${rows.length}`)
process.exit(0)
