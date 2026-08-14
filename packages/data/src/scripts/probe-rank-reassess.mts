import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { runQualityGates } from '../domains/quality-gates.js'
import { db } from '../db.js'
import { spendLedger } from '../schema.js'

/**
 * A0 — re-assess the step-0 population on DOMAIN RANK, not referring domains.
 *
 * ==================== THE METRIC WAS WRONG ====================
 * The step-0 BUY rule used `referring_domains` as the proxy for authority.
 * DataForSEO returns an actual **domain rank (0-1000)** in the same bulk
 * response, and it was fetched and never gated on.
 *
 * The two domains step 0 called BUY have 33 and 9 referring domains. The goal
 * is an AGED HIGH-AUTHORITY domain, and neither qualifies under any reading --
 * so the honest question is not "what did the rule pass" but "does a high-rank
 * domain appear anywhere in this population, and if so, can it be bought?"
 * =============================================================
 *
 * Reads the cached measurements; re-buys only the bulk metrics (~$0.07).
 */

const CACHE = process.env['STEP0_CACHE'] ?? '.cache/step0-measurements.json'

interface CachedRow {
  domain: string
  arms: string[]
  status: string
  years: number | null
  refdom: number | null
  spam: number | null
}

const rows = JSON.parse(readFileSync(CACHE, 'utf8')) as CachedRow[]
console.log(`Loaded ${rows.length} cached step-0 domains\n`)

const database = db()
const quality = await runQualityGates(
  rows.map((r) => r.domain),
  { checkSpam: true },
)
const costUsd = Number(quality.costMicros) / 1_000_000
await database.insert(spendLedger).values({
  endpoint: 'backlinks/bulk_* (A0 rank reassess)',
  costMicros: quality.costMicros,
  rows: quality.rows.length,
  note: 'experiment=step0',
})
console.log(`Bought domain rank for ${quality.rows.length} domains — $${costUsd.toFixed(4)}\n`)

const byDomain = new Map(quality.rows.map((r) => [r.domain, r]))

/**
 * The bar, calibrated against real local operators measured in this project:
 * daveburns.com 243, southportheating.com 237, masterserviceslg.com 194.
 * A domain at rank 150+ is in the same class as an established local business.
 */
const RANK_BAR = 150
const OBTAINABLE = ['AVAILABLE', 'PENDING_DELETE', 'REDEMPTION']

const enriched = rows.map((r) => ({
  ...r,
  rank: byDomain.get(r.domain)?.domainRank ?? null,
}))

const ranked = enriched.filter((r) => r.rank != null)
const highRank = enriched.filter((r) => (r.rank ?? 0) >= RANK_BAR)

console.log(`${'='.repeat(76)}`)
console.log(`DOMAIN RANK DISTRIBUTION (n=${rows.length})`)
console.log(`${'='.repeat(76)}`)
console.log(`  with a rank measured : ${ranked.length}`)
console.log(`  rank >= ${RANK_BAR}          : ${highRank.length}  (${((highRank.length / rows.length) * 100).toFixed(1)}%)`)

const buckets: Array<[string, (r: { rank: number | null }) => boolean]> = [
  ['rank 0 / none', (r) => (r.rank ?? 0) === 0],
  ['1-49', (r) => (r.rank ?? 0) >= 1 && (r.rank ?? 0) < 50],
  ['50-149', (r) => (r.rank ?? 0) >= 50 && (r.rank ?? 0) < 150],
  ['150-249', (r) => (r.rank ?? 0) >= 150 && (r.rank ?? 0) < 250],
  ['250+', (r) => (r.rank ?? 0) >= 250],
]
console.log()
for (const [label, test] of buckets) {
  console.log(`  ${label.padEnd(16)} ${String(enriched.filter(test).length).padStart(4)}`)
}

// ---- The question that matters: are any of the high-rank ones obtainable? ----
console.log(`\n${'='.repeat(76)}`)
console.log(`HIGH-RANK DOMAINS (>= ${RANK_BAR}) BY OBTAINABILITY`)
console.log(`${'='.repeat(76)}\n`)

const obtainableHigh = highRank.filter((r) => OBTAINABLE.includes(r.status))
const ownedHigh = highRank.filter((r) => !OBTAINABLE.includes(r.status))

console.log(`  obtainable at a registrar : ${obtainableHigh.length}`)
console.log(`  still owned               : ${ownedHigh.length}`)

if (highRank.length > 0) {
  console.log(
    `\n${'domain'.padEnd(40)}${'rank'.padStart(6)}${'refdom'.padStart(8)}${'spam'.padStart(6)}  status`,
  )
  for (const r of highRank.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 30)) {
    const mark = OBTAINABLE.includes(r.status) ? ' <-- OBTAINABLE' : ''
    console.log(
      r.domain.padEnd(40) +
        String(r.rank).padStart(6) +
        String(r.refdom ?? '—').padStart(8) +
        String(r.spam ?? '—').padStart(6) +
        '  ' +
        r.status +
        mark,
    )
  }
}

console.log(`\n${'='.repeat(76)}`)
if (obtainableHigh.length === 0) {
  console.log(
    `VERDICT: not one domain at rank >= ${RANK_BAR} was obtainable at a registrar.\n` +
      `Aged authority in this population is held by owners. Buying it means\n` +
      `outreach or auction, not registration — which is exactly what A3 and A1\n` +
      `in plan-aged-assets.md exist to test.`,
  )
} else {
  console.log(
    `VERDICT: ${obtainableHigh.length} obtainable domain(s) at rank >= ${RANK_BAR}. ` +
      `The registrar route is not dead after all — re-examine.`,
  )
}

await database.$client.end?.()
process.exit(0)
