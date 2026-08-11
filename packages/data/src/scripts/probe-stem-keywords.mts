/**
 * Keywords that are EXACTLY the stem of their niche's noun.
 *
 * genericServiceIntentKeywords:110 strips the trailing service verb and adds
 * the remainder as a keyword in its own right. "foundation repair" therefore
 * produced "foundation" -- a query about makeup and nonprofits, carrying 2,900
 * searches/mo in Seattle alone and 73% of that niche's apparent local demand.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const STRIP = /\s+(repair|service|services|cleaning|removal|control|company|contractor|installers?)\s*$/i

const niches = await sql<Array<any>>`SELECT id, slug, keyword_noun AS noun FROM niches`
const stems = new Map<string, { slug: string; noun: string }>()
for (const n of niches) {
  const stem = String(n.noun).replace(STRIP, '').trim().toLowerCase()
  if (stem && stem !== String(n.noun).toLowerCase()) stems.set(stem, { slug: n.slug, noun: n.noun })
}
console.log(`${stems.size} niche(s) produce a bare stem:\n`)

const kws = await sql<Array<any>>`
  SELECT id, keyword, avg_monthly_searches AS national, active FROM research_keywords`
const hits = kws.filter((k) => stems.has(String(k.keyword).trim().toLowerCase()))

console.log('stem keyword          national   from niche              (noun)')
console.log('-'.repeat(80))
let total = 0
for (const h of hits.sort((a, b) => (Number(b.national) || 0) - (Number(a.national) || 0))) {
  const src = stems.get(String(h.keyword).trim().toLowerCase())!
  total += Number(h.national) || 0
  console.log(`${String(h.keyword).padEnd(21)} ${String(h.national ?? '—').padStart(8)}   ${src.slug.padEnd(22)} ${src.noun}`)
}
console.log(`\n${hits.length} bare-stem keyword row(s) · ${total.toLocaleString()} national searches/mo of non-service intent`)

const measured = await sql<Array<any>>`
  SELECT m.keyword, count(*)::int cells, sum(m.avg_monthly_searches)::int local_sum
    FROM discovery_serp_metrics m
   WHERE lower(trim(m.keyword)) = ANY(${[...stems.keys()]})
     AND m.avg_monthly_searches IS NOT NULL
   GROUP BY 1 ORDER BY local_sum DESC`
console.log('\nalready measured in sweeps (inflating local totals):')
for (const m of measured) console.log(`  ${String(m.keyword).padEnd(20)} ${m.cells} cell(s) · ${m.local_sum} local searches counted`)
await sql.end()
