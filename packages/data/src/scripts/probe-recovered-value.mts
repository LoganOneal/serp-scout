import 'dotenv/config'
import { fetchWaybackHistory } from '../domains/wayback.js'
import { runQualityGates } from '../domains/quality-gates.js'

/**
 * The question the discovery probes did NOT answer: are the recovered domains
 * worth anything?
 *
 * ==================== WHY THIS IS THE DECIDING TEST ====================
 * probe-wayback-triage proved a 2013 directory archive surfaces domains that
 * are AVAILABLE today. That is a discovery result, and it says nothing about
 * value.
 *
 * This repo's own coverage plan predicts the opposite of a good outcome:
 *
 *   "Valuable drops never reach retail. Drop-catchers take anything with real
 *    metrics within seconds. If a domain reached AVAILABLE, that is evidence
 *    against its value, not for it."
 *   "Google resets dropped domains."
 *
 * If that holds, these are effectively fresh registrations with a vaguely
 * on-topic name -- the EMD product, not the expired-domain-with-equity product,
 * and they must not be presented as the latter.
 *
 * Two measurements decide it:
 *   archive depth  (free)  -- was there ever a real business here, for how long
 *   link profile   (~$0.03) -- did any of it survive
 * =====================================================================
 */

/** Status from probe-wayback-triage, so value can be read against it. */
const RECOVERED: Array<[string, string]> = [
  ['citysewercleanersservices.com', 'AVAILABLE'],
  ['buildingwatersplumbers.com', 'AVAILABLE'],
  ['mohrhusen.com', 'AVAILABLE'],
  ['villageplumber.biz', 'AVAILABLE'],
  ['superplumberusa.com', 'EXPIRING_SOON'],
  ['drainsruswi.com', 'UNKNOWN'],
  ['masterserviceslg.com', 'LIVE'],
  ['billingsleyeng.com', 'LIVE'],
  ['southportheating.com', 'LIVE'],
  ['daveburns.com', 'LIVE'],
]

console.log('--- ARCHIVE DEPTH (free) ---\n')
console.log(
  'domain'.padEnd(34) + 'status'.padEnd(15) + 'snaps'.padStart(6) + 'yrs'.padStart(5) + '  first → last content',
)

const archive = new Map<string, { years: number | null; snaps: number | null }>()

for (const [domain, status] of RECOVERED) {
  try {
    const w = await fetchWaybackHistory(domain)
    const years = w.ok ? w.yearsOfContinuousContent : null
    const snaps = w.ok ? w.totalSnapshots : null
    archive.set(domain, { years, snaps })
    const first = w.firstSnapshotAt ? w.firstSnapshotAt.toISOString().slice(0, 7) : '—'
    const last = w.lastContentSnapshotAt
      ? w.lastContentSnapshotAt.toISOString().slice(0, 7)
      : '—'
    console.log(
      domain.padEnd(34) +
        status.padEnd(15) +
        String(snaps ?? '—').padStart(6) +
        String(years ?? '—').padStart(5) +
        `  ${first} → ${last}`,
    )
  } catch (e) {
    console.log(`${domain.padEnd(34)}${status.padEnd(15)} ERROR ${(e as Error).message.slice(0, 40)}`)
  }
}

/**
 * One bulk request for all ten. This is the cheap gate -- it is the same call
 * the spam gate already makes, and it carries referring domains and rank.
 */
console.log('\n--- SURVIVING LINK PROFILE (one bulk request) ---\n')

const quality = await runQualityGates(
  RECOVERED.map(([d]) => d),
  { checkSpam: true },
)

console.log(`cost: $${(Number(quality.costMicros) / 1_000_000).toFixed(4)}\n`)
console.log(
  'domain'.padEnd(34) + 'status'.padEnd(15) + 'refdom'.padStart(7) + 'rank'.padStart(6) + 'spam'.padStart(6),
)

const byDomain = new Map(quality.rows.map((r) => [r.domain, r]))
for (const [domain, status] of RECOVERED) {
  const q = byDomain.get(domain)
  console.log(
    domain.padEnd(34) +
      status.padEnd(15) +
      String(q?.referringDomains ?? '—').padStart(7) +
      String(q?.domainRank ?? '—').padStart(6) +
      String(q?.spamScore ?? '—').padStart(6),
  )
}

// ---- The verdict, stated as a comparison rather than a vibe ----
console.log('\n--- VERDICT ---\n')
const buyable = RECOVERED.filter(([, s]) => s === 'AVAILABLE')
for (const [domain] of buyable) {
  const q = byDomain.get(domain)
  const a = archive.get(domain)
  const refdom = q?.referringDomains ?? 0
  const years = a?.years ?? 0
  // "Worth buying for its history" needs BOTH a real past and surviving links.
  const hasPast = years >= 3
  const hasEquity = refdom >= 5
  console.log(
    `${domain.padEnd(34)} archive ${String(years).padStart(2)}y · refdom ${String(refdom).padStart(4)} → ` +
      (hasPast && hasEquity
        ? 'EXPIRED DOMAIN WITH EQUITY'
        : hasPast
          ? 'had a business, links did not survive → EMD with a story, not equity'
          : 'no meaningful history → this is a fresh registration'),
  )
}
