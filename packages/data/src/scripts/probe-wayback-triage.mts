import 'dotenv/config'
import { triageDomain } from '../domains/enrich-pipeline.js'

/**
 * P3, end to end: take domains recovered from a 2011-2013 YellowPages archive
 * and run them through the EXISTING free triage.
 *
 * ==================== WHAT THIS IS ACTUALLY TESTING ====================
 * Not the triage -- that is built and works. The claim under test is the one
 * the whole plan rests on: that a decade-old directory snapshot surfaces
 * businesses which are now GONE, and which no present-tense source (map pack,
 * organic SERP) can reach, because they stopped being visible years ago.
 *
 * If most of these come back LIVE, the archive route is redundant with what the
 * sweep already buys and the plan is wrong. If a meaningful share come back
 * dead or available, it is the only route to a population nothing else reaches.
 * ======================================================================
 *
 * Free: DNS, HTTP, RDAP and Wayback only. No DataForSEO, no spend.
 */

/** Recovered by probe-wayback-yp from YP Kenosha 2013 and Milwaukee 2011. */
const RECOVERED = [
  // Kenosha, WI — 2013 snapshot
  'masterserviceslg.com',
  'citysewercleanersservices.com',
  'billingsleyeng.com',
  'buildingwatersplumbers.com',
  'southportheating.com',
  'drainsruswi.com',
  // Milwaukee, WI — 2011 snapshot
  'daveburns.com',
  'superplumberusa.com',
  'mohrhusen.com',
  'villageplumber.biz',
]

console.log(`Triaging ${RECOVERED.length} domains recovered from YP archives (free stages only)\n`)

const results = []
for (const domain of RECOVERED) {
  try {
    const c = await triageDomain(domain, [{ name: domain, website: `https://${domain}` }])
    results.push(c)
    const age = c.classification.ageYears
    console.log(
      `${domain.padEnd(34)} ${c.classification.status.padEnd(14)}` +
        ` age ${age == null ? '  —' : age.toFixed(1).padStart(5)}y` +
        ` score ${c.score.total.toFixed(1).padStart(5)}` +
        `  ${c.classification.reason.slice(0, 62)}`,
    )
  } catch (e) {
    console.log(`${domain.padEnd(34)} ERROR — ${(e as Error).message.slice(0, 60)}`)
  }
}

const byStatus = new Map<string, number>()
for (const r of results) {
  byStatus.set(r.classification.status, (byStatus.get(r.classification.status) ?? 0) + 1)
}

console.log(`\n${'='.repeat(72)}`)
console.log('STATUS MIX:')
for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(16)} ${n}`)
}

const obtainable = results.filter(
  (r) => !['LIVE', 'BROKEN', 'UNKNOWN'].includes(r.classification.status),
)
console.log(
  `\nNot a live business: ${obtainable.length}/${results.length}` +
    ` (${((obtainable.length / Math.max(1, results.length)) * 100).toFixed(0)}%)`,
)
console.log(
  'Compare: the present-tense pipeline is 84% LIVE across 1,371 triaged candidates\n' +
    '(1,157 LIVE — measured by probe-rollups on the current database).',
)
