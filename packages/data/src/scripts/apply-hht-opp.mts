import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, rawSql } from '../db.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const files = ['0033_hht_opportunity_engine.sql', '0034_hht_opp_phases.sql']

async function main() {
  const sql = rawSql()
  for (const file of files) {
    const ddl = readFileSync(join(dir, file), 'utf8')
    await sql.unsafe(ddl)
    console.log(`applied ${file}`)
  }
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
