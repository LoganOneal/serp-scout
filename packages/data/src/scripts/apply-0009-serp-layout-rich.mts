import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
await s.unsafe(readFileSync('packages/data/drizzle/0009_serp_layout_rich.sql', 'utf8'))
console.log('0009_serp_layout_rich applied')
await s.end()
