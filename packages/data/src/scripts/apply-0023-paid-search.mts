import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
const s = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1 })
await s.unsafe(readFileSync('packages/data/drizzle/0023_paid_search.sql', 'utf8'))
console.log('0023_paid_search applied')
await s.end()
