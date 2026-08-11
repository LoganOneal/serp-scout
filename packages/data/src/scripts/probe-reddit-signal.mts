import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const cols = await sql<Array<any>>`
  SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = 'discovery_hits' ORDER BY ordinal_position`
console.log('discovery_hits columns:')
for (const c of cols) console.log(`  ${c.column_name.padEnd(26)} ${c.data_type}`)
const [n] = await sql<Array<any>>`SELECT count(*)::int total FROM discovery_hits`
console.log(`\nrows: ${n.total}`)
const comm = await sql<Array<any>>`
  SELECT commentable, count(*)::int n FROM discovery_hits GROUP BY 1 ORDER BY n DESC`
console.log('commentable:', comm.map((c) => `${c.commentable ?? 'NULL'}=${c.n}`).join('  '))
const detail = await sql<Array<any>>`
  SELECT commentable_detail, count(*)::int n FROM discovery_hits
   GROUP BY 1 ORDER BY n DESC LIMIT 5`
console.log('commentable_detail:', detail.map((d) => `${(d.commentable_detail ?? 'NULL').slice(0,40)}=${d.n}`).join(' | '))
const sample = await sql<Array<any>>`
  SELECT keyword, subreddit, organic_position, rank_absolute, commentable, reddit_url
    FROM discovery_hits ORDER BY rank_absolute NULLS LAST LIMIT 6`
console.log('\nsample hits:')
for (const s2 of sample)
  console.log(`  abs ${String(s2.rank_absolute ?? '—').padStart(3)} org ${String(s2.organic_position ?? '—').padStart(3)} r/${String(s2.subreddit ?? '?').padEnd(20)} commentable=${s2.commentable ?? 'null'} ${String(s2.keyword).slice(0,30)}`)
await sql.end()
