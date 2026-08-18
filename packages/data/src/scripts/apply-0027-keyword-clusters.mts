import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
const s = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1 })
await s.unsafe(readFileSync('packages/data/drizzle/0027_keyword_clusters.sql', 'utf8'))
console.log('0027_keyword_clusters applied')
await s.end()
