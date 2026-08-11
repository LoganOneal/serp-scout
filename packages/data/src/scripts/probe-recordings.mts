import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
  prepare: false,
})

const calls = await sql`
  select id, site_id, retell_call_id, direction, ingest_state, simulated,
         recording_url_upstream is not null as has_upstream,
         left(coalesce(recording_url_upstream, ''), 100) as upstream_prefix,
         recording_path, recording_bytes, recording_fetched_at,
         recording_missing_reason,
         transcript is not null as has_transcript,
         started_at, ended_at, created_at
  from calls
  order by id desc
  limit 8
`
console.log('=== recent calls ===')
for (const c of calls) console.log(JSON.stringify(c))

const jobs = await sql`
  select id, kind, call_id, status, attempts, last_error, run_after, claimed_at, finished_at, created_at
  from voice_jobs
  where kind = 'fetch_recording'
  order by id desc
  limit 15
`
console.log('=== fetch_recording jobs ===')
for (const j of jobs) console.log(JSON.stringify(j))

const pending = await sql`
  select status, count(*)::int as n from voice_jobs group by 1 order by 1
`
console.log('=== voice_jobs by status ===', pending)

console.log(
  'BLOB_READ_WRITE_TOKEN set?',
  Boolean(process.env['BLOB_READ_WRITE_TOKEN']?.trim()),
  'len',
  process.env['BLOB_READ_WRITE_TOKEN']?.trim()?.length ?? 0,
)
console.log('VERCEL?', process.env['VERCEL'])
console.log('RECORDINGS_DIR', process.env['RECORDINGS_DIR'])
console.log('RETELL_API_KEY set?', Boolean(process.env['RETELL_API_KEY']?.trim()))
console.log('LIVE_CALLS_ENABLED', process.env['LIVE_CALLS_ENABLED'])

await sql.end()
