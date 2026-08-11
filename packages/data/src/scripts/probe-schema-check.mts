import 'dotenv/config'
import postgres from 'postgres'
const s = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })
const t = await s<Array<{ table_name: string }>>`
  SELECT table_name FROM information_schema.tables
   WHERE table_name IN ('domain_enrich_runs','domain_candidates')`
const c = await s<Array<{ column_name: string }>>`
  SELECT column_name FROM information_schema.columns
   WHERE table_name='domain_candidates'
     AND column_name IN ('authority_score','domain_rank','authority_note')`
console.log('tables (0014):', t.map((x) => x.table_name).join(', ') || 'MISSING')
console.log('columns (0015):', c.map((x) => x.column_name).join(', ') || 'MISSING')
await s.end()
