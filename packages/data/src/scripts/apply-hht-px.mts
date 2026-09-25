import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, rawSql } from '../db.js'

const file = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0035_hht_prospecting.sql')

async function main() {
  const sql = rawSql()
  await sql.unsafe(readFileSync(file, 'utf8'))
  console.log('applied 0035_hht_prospecting.sql')
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
