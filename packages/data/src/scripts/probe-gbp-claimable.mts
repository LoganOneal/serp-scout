import 'dotenv/config'
import { collectBusinesses } from '../domains/collect-businesses.js'
import { DataForSeoClient, fetchAccountStatus } from '../providers/dataforseo/client.js'

/**
 * B0(c) — is there a claimable population at all?
 *
 * ==================== THE RISK THAT DECIDES PART B ====================
 * The orphaned-GBP join found 24 businesses in a map pack whose website is
 * dead. It cannot say whether their PROFILES are takeable, because `is_claimed`
 * is read from every listing in collect-businesses.ts and then discarded before
 * anything persists it.
 *
 * The plan named the disqualifying case up front: if `is_claimed` is
 * near-universally true in competitive local niches, there is no claim path and
 * Part B is over. That is one Maps request per market to find out.
 *
 * $0.002 per (niche, market). Nothing else here costs anything.
 * =====================================================================
 */

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing')
  process.exit(1)
}
const client = new DataForSeoClient({ credentials: { login, password }, timeoutMs: 120_000 })

/** Houston is where the existing map-pack corpus already sits. */
const CELLS = [
  { niche: 'ac repair', locationCode: 1026481, label: 'AC repair · Houston' },
  { niche: 'roofing contractor', locationCode: 1026481, label: 'Roofing · Houston' },
  { niche: 'plumber', locationCode: 1026481, label: 'Plumber · Houston' },
]

const opening = (await fetchAccountStatus(client)).balanceUsd
console.log(`Opening balance: $${opening.toFixed(4)}\n`)

let totalListings = 0
let totalUnclaimed = 0
let totalUnclaimedWithReviews = 0
const takeoverCandidates: Array<{
  name: string
  reviews: number
  rating: number | null
  website: string | null
  cell: string
  placeId: string | null
}> = []

for (const cell of CELLS) {
  let result
  try {
    result = await collectBusinesses({
      niche: cell.niche,
      locationCode: cell.locationCode,
      // Billed per REQUEST, not per result — 700 costs the same as 200.
      maxResults: 700,
    })
  } catch (e) {
    console.log(`${cell.label}: FAILED — ${(e as Error).message.slice(0, 90)}`)
    continue
  }

  const b = result.businesses
  const claimed = b.filter((x) => x.isClaimed === true).length
  const unclaimed = b.filter((x) => x.isClaimed === false)
  const unknown = b.filter((x) => x.isClaimed === null).length
  const noWebsite = b.filter((x) => !x.website).length

  // An unclaimed profile with real review history is the actual target: the
  // reviews are the asset, and nobody is managing them.
  const withReviews = unclaimed.filter((x) => (x.reviewCount ?? 0) >= 10)

  totalListings += b.length
  totalUnclaimed += unclaimed.length
  totalUnclaimedWithReviews += withReviews.length

  console.log(`${cell.label}`)
  console.log(`  listings ${b.length} · claimed ${claimed} · UNCLAIMED ${unclaimed.length} · unknown ${unknown}`)
  console.log(
    `  unclaimed with >=10 reviews: ${withReviews.length}` +
      `   ·   listings with no website at all: ${noWebsite}`,
  )

  for (const x of withReviews.slice(0, 12)) {
    takeoverCandidates.push({
      name: x.name,
      reviews: x.reviewCount ?? 0,
      rating: x.rating,
      website: x.website,
      cell: cell.label,
      placeId: x.placeId,
    })
  }
}

const closing = (await fetchAccountStatus(client)).balanceUsd

console.log(`\n${'='.repeat(76)}`)
console.log(
  `TOTAL: ${totalListings} listings · ${totalUnclaimed} unclaimed ` +
    `(${((totalUnclaimed / Math.max(1, totalListings)) * 100).toFixed(1)}%) · ` +
    `${totalUnclaimedWithReviews} unclaimed with >=10 reviews`,
)

if (takeoverCandidates.length > 0) {
  console.log(`\nTAKEOVER CANDIDATES (unclaimed, real review history):\n`)
  console.log('business'.padEnd(42) + 'reviews'.padStart(8) + 'rating'.padStart(7) + '  website')
  for (const c of takeoverCandidates.sort((a, b) => b.reviews - a.reviews).slice(0, 30)) {
    console.log(
      c.name.slice(0, 40).padEnd(42) +
        String(c.reviews).padStart(8) +
        String(c.rating ?? '—').padStart(7) +
        '  ' +
        (c.website ?? 'NO WEBSITE').slice(0, 46),
    )
  }
  console.log(
    `\nA listing with reviews and NO WEBSITE is the strongest shape here:\n` +
      `the profile is the entire asset and there is no site to check.`,
  )
} else {
  console.log(`\nNo unclaimed listings with review history.`)
  console.log(`If is_claimed is null across the board, the field is not being returned`)
  console.log(`at this depth and needs a different endpoint — that is a coverage`)
  console.log(`problem, NOT evidence that every profile is claimed.`)
}

console.log(`\nSpend: $${(opening - closing).toFixed(4)}`)
