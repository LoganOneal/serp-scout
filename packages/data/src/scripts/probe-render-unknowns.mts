/** Render a sample of real UNKNOWN rows and measure the resolution rate. */
import 'dotenv/config'
import postgres from 'postgres'
import { formatMicrosUsd } from '@rnr/core'
import { renderUnresolved } from '../domains/js-render.js'

const limit = Number(process.argv[2] ?? 25)
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<{ domain: string }>>`
  SELECT DISTINCT domain FROM domain_candidates WHERE status = 'UNKNOWN' ORDER BY domain LIMIT ${limit}`
await sql.end()

const r = await renderUnresolved(rows.map((x) => x.domain), { maxRenders: limit, concurrency: 5 })
const by = new Map<string, number>()
for (const x of r.results) by.set(x.verdict, (by.get(x.verdict) ?? 0) + 1)

console.log(`rendered ${r.results.length} · ${formatMicrosUsd(r.costMicros, { precision: 4 })}\n`)
for (const x of r.results.sort((a, b) => a.verdict.localeCompare(b.verdict))) {
  console.log(`  ${x.verdict.padEnd(11)} ${x.domain.slice(0, 36).padEnd(38)} ${x.detail.slice(0, 60)}`)
}
console.log(`\nverdicts: ${[...by].map(([k, v]) => `${k}=${v}`).join('  ')}`)
console.log(`resolved ${r.resolved}/${r.results.length} (${Math.round((r.resolved / r.results.length) * 100)}%)`)
process.exit(0)
