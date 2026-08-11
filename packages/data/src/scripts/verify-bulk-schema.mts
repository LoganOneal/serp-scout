import 'dotenv/config'
import postgres from 'postgres'

const url = process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']
if (!url) {
  console.error('No DATABASE_URL')
  process.exit(1)
}

const sql = postgres(url, { max: 1, prepare: false })
const tables = await sql`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
    and table_name in (
      'research_keywords',
      'research_geos',
      'research_keyword_imports',
      'research_geo_imports',
      'discovery_serp_metrics'
    )
  order by 1
`
const jobCols = await sql`
  select column_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'discovery_jobs'
    and column_name in ('device', 'os', 'depth', 'research_keyword_id', 'research_geo_id')
  order by 1
`
const runCols = await sql`
  select column_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'discovery_runs'
    and column_name in ('source', 'devices', 'include_near_me', 'selection_note', 'estimated_cost_micros')
  order by 1
`
console.log(
  JSON.stringify(
    {
      tables: tables.map((r) => r.table_name),
      discovery_jobs: jobCols.map((r) => r.column_name),
      discovery_runs: runCols.map((r) => r.column_name),
    },
    null,
    2,
  ),
)
const ok =
  tables.length >= 5 && jobCols.length >= 5 && runCols.length >= 4
await sql.end()
if (!ok) {
  console.error('Schema incomplete')
  process.exit(1)
}
console.log('bulk research schema OK')
