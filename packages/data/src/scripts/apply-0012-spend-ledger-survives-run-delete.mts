import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const s = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, {
  max: 1,
})
await s.unsafe(
  readFileSync('packages/data/drizzle/0012_spend_ledger_survives_run_delete.sql', 'utf8'),
)
console.log('0012_spend_ledger_survives_run_delete applied')
await s.end()
