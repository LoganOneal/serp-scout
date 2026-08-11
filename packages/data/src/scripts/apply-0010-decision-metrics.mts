import 'dotenv/config'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const s = postgres(process.env.DATABASE_URL!, { max: 1 })
await s.unsafe(readFileSync('packages/data/drizzle/0010_decision_metrics.sql', 'utf8'))
console.log('0010_decision_metrics applied')
await s.end()
