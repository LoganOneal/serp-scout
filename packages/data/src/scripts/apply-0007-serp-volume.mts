import 'dotenv/config'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}

const sql = postgres(url, { max: 1 })
await sql.unsafe(`
  ALTER TABLE discovery_serp_metrics ADD COLUMN IF NOT EXISTS avg_monthly_searches integer;
  ALTER TABLE discovery_serp_metrics ADD COLUMN IF NOT EXISTS volume_source text;
  ALTER TABLE discovery_serp_metrics ADD COLUMN IF NOT EXISTS volume_geo_target text;
`)
console.log('0007_serp_volume applied')
await sql.end()
