import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const connection = postgres(
  process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!,
  { max: 1 },
)
await connection.unsafe(
  readFileSync('packages/data/drizzle/0029_hht_reddit_country_scopes.sql', 'utf8'),
)
console.log('0029_hht_reddit_country_scopes applied')
await connection.end()
