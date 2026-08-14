import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import postgres from 'postgres'
import { registrableDomain } from '@rnr/core'
import { collectBusinesses } from '../domains/collect-businesses.js'
import { db } from '../db.js'
import { spendLedger } from '../schema.js'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'

/**
 * The step that turns a lead into an actionable takeover: is the profile CLAIMED?
 *
 * ==================== WHAT THIS JOINS ====================
 * The backfill found 40 businesses that were in a Houston map pack and whose
 * website is now dead with 3+ years of archived history. The domain being dead
 * is the EVIDENCE the business is gone; the Google profile is the asset.
 *
 * Nothing so far knows whether those profiles are claimed, because `is_claimed`
 * was read from every listing and discarded before persistence (now fixed).
 * This re-pulls the map pack for each of the shortlist's niches and reads it.
 *
 * Three outcomes per lead, and all three are informative:
 *   still in the pack + UNCLAIMED -> takeover candidate
 *   still in the pack + claimed   -> somebody is managing it; not available
 *   gone from the pack            -> no profile left to take over
 * ========================================================
 *
 * ~$0.002 per niche. Ledgered, and capped.
 */

const BUDGET_USD = Number(process.env['GBP_BUDGET_USD'] ?? 0.25)
const LOCATION_CODE = 1026481 // Houston — where the whole map-pack corpus sits

const s = postgres(process.env['DATABASE_URL']!, { max: 1 })
const database = db()

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing')
  process.exit(1)
}
const client = new DataForSeoClient({ credentials: { login, password }, timeoutMs: 120_000 })

// ---------------------------------------------------------------------------
// 1. The shortlist and the niches that surfaced it
// ---------------------------------------------------------------------------

const DEAD = ['AVAILABLE', 'PENDING_DELETE', 'REDEMPTION', 'EXPIRING_SOON', 'PARKED_DEAD', 'BROKEN']

const leads = await s`
  with map_entries as (
    select distinct lower(trim(both '"' from d::text)) as domain, m.keyword
      from discovery_serp_metrics m, jsonb_array_elements(m.maps_domains) as d
     where m.maps_domains is not null
  )
  select c.domain,
         max(c.status)                        as status,
         max(c.age_years)                     as age_years,
         max(c.years_of_content)              as years_of_content,
         array_agg(distinct e.keyword)        as keywords
    from domain_candidates c
    join map_entries e on e.domain = c.domain
   where c.status = any(${DEAD})
     and coalesce(c.years_of_content, 0) >= 3
   group by c.domain
   order by max(c.years_of_content) desc nulls last
`

/**
 * ==================== ONE PACK PER LEAD, NOT PER KEYWORD ====================
 * The first version took every stored keyword for every lead and got 138
 * niches -- $0.276, an order of magnitude over the estimate, and the budget cap
 * stopped it.
 *
 * The reason: a single business is recorded under many near-identical queries
 * ("locksmith", "locksmith close to me", "24 hour locksmith", plus a Houston
 * variant of each). Those all return substantially the same map pack, so buying
 * one per variant pays repeatedly for the same listings.
 *
 * One canonical query per lead -- the shortest non-city keyword, which is
 * reliably the head term -- ties spend to LEADS rather than to keyword variants.
 * ===========================================================================
 */
const niches = new Set<string>()
for (const l of leads) {
  const candidates = (l['keywords'] as string[])
    .filter(Boolean)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => !/houston/i.test(k))
    .sort((a, b) => a.length - b.length)
  if (candidates[0]) niches.add(candidates[0])
}

console.log(`Shortlist: ${leads.length} businesses across ${niches.size} niches`)
console.log(`Estimated cost: $${(niches.size * 0.002).toFixed(3)} (cap $${BUDGET_USD.toFixed(2)})\n`)

if (niches.size * 0.002 > BUDGET_USD) {
  console.error(`Estimate exceeds the cap. Raise GBP_BUDGET_USD or narrow the shortlist.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2. Pull each pack and index every listing by domain
// ---------------------------------------------------------------------------

interface Listing {
  name: string
  isClaimed: boolean | null
  reviewCount: number | null
  rating: number | null
  placeId: string | null
  website: string | null
  niche: string
}

const opening = (await fetchAccountStatus(client)).balanceUsd
const byDomain = new Map<string, Listing>()
const allListings: Listing[] = []
let spent = 0

for (const niche of [...niches].sort()) {
  try {
    const r = await collectBusinesses({ niche, locationCode: LOCATION_CODE, maxResults: 700 })
    spent += Number(r.costMicros) / 1_000_000
    for (const b of r.businesses) {
      const listing: Listing = {
        name: b.name,
        isClaimed: b.isClaimed,
        reviewCount: b.reviewCount,
        rating: b.rating,
        placeId: b.placeId,
        website: b.website,
        niche,
      }
      allListings.push(listing)
      const n = registrableDomain(b.website)
      if (n && !byDomain.has(n.domain)) byDomain.set(n.domain, listing)
    }
    const unclaimed = r.businesses.filter((b) => b.isClaimed === false).length
    console.log(`  ${niche.padEnd(34)} ${String(r.businesses.length).padStart(4)} listings · ${unclaimed} unclaimed`)
  } catch (e) {
    console.log(`  ${niche.padEnd(34)} FAILED — ${(e as Error).message.slice(0, 60)}`)
  }
}

await database.insert(spendLedger).values({
  endpoint: 'serp/google/maps/live/advanced (gbp takeover)',
  costMicros: BigInt(Math.round(spent * 1_000_000)),
  rows: allListings.length,
  note: 'experiment=gbp-takeover',
})

/**
 * Persist every listing before printing anything.
 *
 * The first run of this script was piped through `head` and the second half of
 * its output -- the actual takeover list -- was discarded, which meant paying
 * for the same map packs twice to read a report that had already been
 * generated. Paid results get written to disk before they are formatted.
 */
const OUT = process.env['GBP_OUT'] ?? '.cache/gbp-listings.json'
writeFileSync(OUT, JSON.stringify(allListings, null, 2))
console.log(`\n  ${allListings.length} listings saved → ${OUT}`)

// ---------------------------------------------------------------------------
// 3. The answer, per lead
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(104)}`)
console.log(`SHORTLIST — IS THE PROFILE CLAIMED?`)
console.log(`${'='.repeat(104)}\n`)
console.log(
  'domain'.padEnd(36) + 'arch'.padStart(5) + '  profile'.padEnd(12) + 'claimed'.padEnd(10) +
    'reviews'.padStart(8) + '  business name',
)
console.log('-'.repeat(104))

let takeover = 0
let claimed = 0
let gone = 0

for (const l of leads) {
  const domain = String(l['domain'])
  const hit = byDomain.get(domain)
  let state: string
  let claimState: string
  if (!hit) {
    state = 'GONE'
    claimState = '—'
    gone += 1
  } else if (hit.isClaimed === false) {
    state = 'IN PACK'
    claimState = 'UNCLAIMED'
    takeover += 1
  } else {
    state = 'IN PACK'
    claimState = hit.isClaimed === true ? 'claimed' : 'unknown'
    if (hit.isClaimed === true) claimed += 1
  }
  console.log(
    domain.slice(0, 34).padEnd(36) +
      String(l['years_of_content'] ?? '—').padStart(5) +
      '  ' + state.padEnd(10) +
      claimState.padEnd(10) +
      String(hit?.reviewCount ?? '—').padStart(8) +
      '  ' + (hit?.name ?? '').slice(0, 34),
  )
}

console.log(
  `\n  UNCLAIMED (takeover candidates): ${takeover}` +
    `   ·   claimed: ${claimed}   ·   no longer in the pack: ${gone}`,
)

// ---------------------------------------------------------------------------
// 4. The wider opportunity: every unclaimed listing with real reviews
// ---------------------------------------------------------------------------

const unclaimedWithReviews = allListings
  .filter((l) => l.isClaimed === false && (l.reviewCount ?? 0) >= 10)
  .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0))

console.log(`\n${'='.repeat(104)}`)
console.log(`ALL UNCLAIMED LISTINGS WITH 10+ REVIEWS IN THESE NICHES: ${unclaimedWithReviews.length}`)
console.log(`${'='.repeat(104)}\n`)
console.log(
  'business'.padEnd(40) + 'reviews'.padStart(8) + 'rating'.padStart(7) + '  niche'.padEnd(26) + '  website',
)
console.log('-'.repeat(104))
for (const l of unclaimedWithReviews.slice(0, 45)) {
  console.log(
    l.name.slice(0, 38).padEnd(40) +
      String(l.reviewCount).padStart(8) +
      String(l.rating ?? '—').padStart(7) +
      '  ' + l.niche.slice(0, 24).padEnd(26) +
      (l.website ?? 'NO WEBSITE').slice(0, 34),
  )
}

const noSite = unclaimedWithReviews.filter((l) => !l.website)
console.log(
  `\n  ${noSite.length} of those have NO WEBSITE — the profile is the entire asset,\n` +
    `  and there is no site to diligence.`,
)

const closing = (await fetchAccountStatus(client)).balanceUsd
console.log(`\nSpend: $${(opening - closing).toFixed(4)} (ledgered as experiment=gbp-takeover)`)

await s.end()
await database.$client.end?.()
process.exit(0)
