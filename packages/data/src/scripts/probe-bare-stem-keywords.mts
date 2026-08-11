/**
 * Which catalog keywords are bare stems that lost the service intent?
 *
 * genericServiceIntentKeywords strips the service verb off a "repairish" noun
 * and adds the remainder as its own keyword: "foundation repair" -> "foundation".
 * Those queries are not the service -- "foundation" is makeup, "carpet" is
 * buying carpet -- and they carry huge volume that inflates every niche total.
 */
import 'dotenv/config'
import postgres from 'postgres'
const sql = postgres(process.env['DIRECT_DATABASE_URL']?.trim() || process.env['DATABASE_URL']!, { max: 1, prepare: false })

const SERVICE_WORDS =
  /\b(repair|service|services|cleaning|clean|removal|remove|control|install|installers?|installation|contractor|contractors|company|companies|replacement|replace|near me|cost|emergency|best|maintenance|inspection|restoration|remodel|remodeling|sweep|drilling|paving|washing|mowing|care|damage|rental|towing|plumber|electrician|locksmith|landscaping|handyman|roofing|movers|painters)\b/i

const rows = await sql<Array<any>>`
  SELECT k.id, k.keyword, k.avg_monthly_searches AS national, n.slug AS niche, n.keyword_noun AS noun
    FROM research_keywords k
    LEFT JOIN niches n ON n.id = k.niche_id
   WHERE k.active = true
   ORDER BY k.avg_monthly_searches DESC NULLS LAST`

const bare = rows.filter((r) => !SERVICE_WORDS.test(r.keyword))
console.log(`${rows.length} active keywords · ${bare.length} carry NO service word\n`)
console.log('keyword                    national   niche                    (noun)')
console.log('-'.repeat(88))
for (const b of bare.slice(0, 30))
  console.log(`${String(b.keyword).slice(0,26).padEnd(27)} ${String(b.national ?? '—').padStart(8)}   ${String(b.niche ?? '—').padEnd(24)} ${b.noun ?? ''}`)

const totalNat = bare.reduce((a, b) => a + (Number(b.national) || 0), 0)
console.log(`\ncombined national volume of bare-stem keywords: ${totalNat.toLocaleString()}`)
await sql.end()
