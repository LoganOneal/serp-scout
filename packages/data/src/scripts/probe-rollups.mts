import 'dotenv/config'
import postgres from 'postgres'
import { DOMAIN_MARKETPLACES } from '@rnr/core'

/**
 * What the redirect data already in the database says about roll-ups.
 *
 * `httpTriage` has been writing `redirected_to` on every candidate since the
 * feature shipped, and nothing has ever grouped by it. A 301 to an unrelated
 * domain is classified `ACQUIRED_301` one row at a time -- but the interesting
 * object is the TARGET: when six local operators all redirect to the same
 * place, that is one acquirer holding six aged domains it does not want.
 *
 * Free. Reads rows that already exist.
 */

const s = postgres(process.env['DATABASE_URL']!, { max: 1 })

const [totals] = await s`
  select
    count(*)::int                                          as candidates,
    count(*) filter (where redirected_to is not null)::int  as with_redirect,
    count(*) filter (where status = 'ACQUIRED_301')::int    as acquired_301,
    count(distinct redirected_to)::int                      as distinct_targets
  from domain_candidates
`

const statusMix = await s`
  select status, count(*)::int as n
    from domain_candidates group by status order by n desc
`

/**
 * Two exclusions, both learned from the first run of this probe.
 *
 * Self-redirects are not acquisitions: `example.com -> www.example.com` and
 * http->https both land in this column, so the eTLD+1 must differ.
 *
 * Marketplaces are not acquirers. `classify.ts` already reads a redirect to
 * HugeDomains/Afternic/Sedo as "listed for sale" rather than "acquired" -- but
 * grouping by target without that exclusion re-introduces the same error one
 * level up, and reports a broker's inventory as a roll-up. The first run of
 * this probe did exactly that with hugedomains.com.
 */
const clusters = await s`
  select redirected_to,
         count(distinct domain)::int          as members,
         round(avg(age_years)::numeric, 1)    as avg_age,
         round(max(score)::numeric, 1)        as best_score,
         array_agg(distinct domain)           as domains
    from domain_candidates
   where redirected_to is not null
     and redirected_to <> domain
     and redirected_to <> all(${DOMAIN_MARKETPLACES as string[]})
   group by redirected_to
  having count(distinct domain) > 1
   order by members desc, avg_age desc nulls last
   limit 25
`

/** The other half of the same column: inventory sitting on a broker, with a price. */
const forSale = await s`
  select domain, redirected_to, round(score::numeric, 1) as score, age_years
    from domain_candidates
   where redirected_to = any(${DOMAIN_MARKETPLACES as string[]})
   order by score desc nulls last
   limit 20
`

console.log('TOTALS:', totals)
console.log('\nSTATUS MIX:')
for (const r of statusMix) console.log(`  ${String(r['status']).padEnd(16)} ${r['n']}`)

console.log(`\nMULTI-MEMBER REDIRECT CLUSTERS: ${clusters.length}`)
for (const c of clusters) {
  console.log(
    `  → ${c['redirected_to']}  (${c['members']} members, avg age ${c['avg_age'] ?? '—'}y, best score ${c['best_score']})`,
  )
  console.log(`      ${(c['domains'] as string[]).join(', ')}`)
}

if (clusters.length === 0) {
  console.log(
    '\n  No multi-member clusters. Either no roll-up is present in the markets\n' +
      '  triaged so far, or too few markets have been run to see one. This is a\n' +
      '  measurement, not a verdict on the method.',
  )
}

console.log(`\nLISTED FOR SALE ON A MARKETPLACE: ${forSale.length}`)
for (const r of forSale) {
  console.log(
    `  ${String(r['domain']).padEnd(38)} score ${String(r['score']).padStart(5)}  age ${r['age_years'] ?? '—'}y  via ${r['redirected_to']}`,
  )
}

await s.end()
