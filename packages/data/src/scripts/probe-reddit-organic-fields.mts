import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const rows = await sql<Array<any>>`
  SELECT raw_items FROM discovery_jobs WHERE raw_items IS NOT NULL AND raw_items::text ILIKE '%reddit.com%' LIMIT 60`
await sql.end()

let organicSample: any = null
const counts = new Map<string, number>()
for (const r of rows) {
  for (const item of r.raw_items as any[]) {
    if (item.type !== 'organic') continue
    if (!/reddit\.com/i.test(String(item.url ?? item.domain ?? ''))) continue
    counts.set('organic reddit', (counts.get('organic reddit') ?? 0) + 1)
    if (!organicSample) organicSample = item
  }
}
console.log('organic Reddit results found:', counts.get('organic reddit') ?? 0)
if (organicSample) {
  console.log('\nfields:', Object.keys(organicSample).join(', '))
  const interesting = ['url','title','timestamp','rank_absolute','rank_group','extended_snippet','about_this_result','description','links','rating','is_featured_snippet']
  console.log('\nvalues of interest:')
  for (const k of interesting) {
    if (organicSample[k] !== undefined)
      console.log(`  ${k.padEnd(20)} ${JSON.stringify(organicSample[k]).slice(0, 120)}`)
  }
}
