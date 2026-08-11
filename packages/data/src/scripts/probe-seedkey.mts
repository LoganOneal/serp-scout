import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const r = await sql<Array<{ seed_key: string; variant: string; keyword: string }>>`
  SELECT seed_key, variant, keyword FROM research_keywords
   WHERE keyword LIKE 'water damage restoration%' ORDER BY length(keyword) LIMIT 10`
for (const x of r) console.log(`seed=${x.seed_key.padEnd(28)} variant=${x.variant.padEnd(10)} kw=${x.keyword}`)
const v = await sql<Array<{ variant: string; n: number }>>`
  SELECT variant, count(*)::int AS n FROM research_keywords GROUP BY variant ORDER BY n DESC LIMIT 6`
console.log('\nvariant distribution:', v.map((x) => `${x.variant}=${x.n}`).join('  '))
await sql.end()
