/**
 * What does the SERP payload already tell us about a Reddit thread?
 *
 * We hold every raw item. Before paying to fetch reddit.com (which 403s both
 * its HTML and its JSON to a datacenter IP), check what DataForSEO already
 * returned about these threads.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const rows = await sql<Array<any>>`
  SELECT raw_items FROM discovery_jobs
   WHERE raw_items IS NOT NULL AND raw_items::text ILIKE '%reddit%' LIMIT 40`
await sql.end()

const keysByType = new Map<string, Set<string>>()
let sampleForum: any = null
let sampleOrganic: any = null

for (const r of rows) {
  for (const item of r.raw_items as any[]) {
    const txt = JSON.stringify(item)
    if (!/reddit/i.test(txt)) continue
    const t = String(item.type)
    if (!keysByType.has(t)) keysByType.set(t, new Set())
    for (const k of Object.keys(item)) keysByType.get(t)!.add(k)
    if (t === 'discussions_and_forums' && !sampleForum) sampleForum = item
    if (t === 'organic' && !sampleOrganic) sampleOrganic = item
  }
}

console.log('Reddit-bearing item types and their fields:\n')
for (const [t, keys] of keysByType) console.log(`${t}:\n  ${[...keys].join(', ')}\n`)

if (sampleForum) {
  console.log('--- discussions_and_forums sample ---')
  console.log(JSON.stringify(sampleForum, null, 1).slice(0, 1400))
}
