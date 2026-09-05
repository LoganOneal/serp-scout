import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, rawSql } from '../db.js'

const sqlPath = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0032_opportunity_miner.sql')
const ddl = readFileSync(sqlPath, 'utf8')

async function main() {
  const sql = rawSql()
  await sql.unsafe(ddl)
  console.log('applied 0032_opportunity_miner.sql')
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
