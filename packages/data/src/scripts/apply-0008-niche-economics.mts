import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
await s.unsafe(readFileSync('packages/data/drizzle/0008_niche_economics.sql', 'utf8'))
console.log('0008_niche_economics applied')
await s.end()
