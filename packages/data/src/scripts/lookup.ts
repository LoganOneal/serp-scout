/** Inspect how one locality resolved. `pnpm lookup tucson` */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '../db.js'

async function main(): Promise<void> {
  const q = (process.argv[2] ?? '').toLowerCase()
  if (!q) {
    console.error('usage: pnpm lookup <name fragment>')
    process.exit(1)
  }

  const rows = await db().execute(sql`
    SELECT slug, kind, name, state_code, population, provider_location_code,
           provider_location_name, resolution_method, location_source, unmatched_reason
      FROM localities
     WHERE search_text LIKE ${`${q}%`}
     ORDER BY population DESC NULLS LAST
     LIMIT 12`)

  const list = rows as unknown as Array<Record<string, unknown>>
  if (list.length === 0) {
    console.log(`\nNothing matches "${q}".\n`)
    await closeDb()
    return
  }

  for (const r of list) {
    const resolved = r['provider_location_code'] !== null
    console.log(`\n${r['name']}, ${r['state_code']}  (${r['kind']})`)
    console.log(`  slug          ${r['slug']}`)
    console.log(`  population    ${Number(r['population'] ?? 0).toLocaleString()}`)
    if (resolved) {
      console.log(`  SCANNABLE     yes -- location code ${r['provider_location_code']}`)
      console.log(`  provider name ${r['provider_location_name']}`)
      console.log(`  matched via   ${r['resolution_method']}`)
      console.log(
        `  code source   ${r['location_source']}` +
          (r['location_source'] === 'dataforseo'
            ? '  (authoritative -- cleared for live spend)'
            : '  (UNVERIFIED -- live scans refuse; fixture scans fine)'),
      )
    } else {
      console.log('  SCANNABLE     NO')
      console.log(`  reason        ${r['unmatched_reason']}`)
    }
  }
  console.log('')
  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
