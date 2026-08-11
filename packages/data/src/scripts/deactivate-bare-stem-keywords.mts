/**
 * Retire the bare-stem keywords the expansion should never have generated.
 *
 * Deactivated rather than deleted: the SERPs were bought and the measurements
 * are real, so the audit trail and the spend ledger stay intact. The grid now
 * filters on `active`, so they stop counting toward any total.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/deactivate-bare-stem-keywords.mts [apply]
 */
import 'dotenv/config'
import postgres from 'postgres'

const apply = process.argv[2] === 'apply'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const STRIP = /\s+(repair|service|services|cleaning|removal|control|company|contractor|installers?)\s*$/i
const niches = await sql<Array<any>>`SELECT slug, keyword_noun AS noun FROM niches`
const stems = new Set<string>()
for (const n of niches) {
  const stem = String(n.noun).replace(STRIP, '').trim().toLowerCase()
  if (stem && stem !== String(n.noun).toLowerCase()) stems.add(stem)
}

const targets = await sql<Array<any>>`
  SELECT id, keyword, active FROM research_keywords
   WHERE lower(trim(keyword)) = ANY(${[...stems]}) AND active = true`

console.log(`${targets.length} bare-stem keyword(s) still active:`)
for (const t of targets) console.log(`  ${t.keyword}`)

if (apply && targets.length > 0) {
  await sql`UPDATE research_keywords SET active = false WHERE id = ANY(${targets.map((t) => t.id)})`
  console.log(`\ndeactivated ${targets.length}`)
}

// What the grid will now total for the affected markets.
const after = await sql<Array<any>>`
  SELECT l.name AS locality, count(DISTINCT m.keyword)::int kws,
         sum(DISTINCT m.avg_monthly_searches)::int vol
    FROM discovery_serp_metrics m
    JOIN research_keywords k ON k.id = m.research_keyword_id
    LEFT JOIN localities l ON l.id = m.locality_id
   WHERE m.keyword ILIKE '%foundation%' AND m.avg_monthly_searches IS NOT NULL
     AND k.active = true
   GROUP BY 1 ORDER BY vol DESC`
console.log('\nfoundation-repair local totals with active keywords only:')
for (const a of after) console.log(`  ${String(a.locality ?? '?').padEnd(26)} ${a.kws} kw -> ${a.vol}`)
await sql.end()
