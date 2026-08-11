/**
 * Authority-citation audit for one domain-search run's candidates.
 *
 * Proves the two-step cost control: a cheap bulk pass over every domain, then
 * paid per-domain lookups only where a citation could plausibly exist.
 *
 *   pnpm exec tsx --conditions=react-server \
 *     packages/data/src/scripts/probe-authority-audit.mts [runId] [minRefDomains]
 */
import 'dotenv/config'
import { formatMicrosUsd } from '@rnr/core'
import { db } from '../db.js'
import { listDomainCandidates } from '../domains/queries.js'
import { auditAuthorityLinks } from '../domains/authority-links.js'

const runId = Number(process.argv[2] ?? 2)
const minReferringDomains = Number(process.argv[3] ?? 5)

const rows = await listDomainCandidates(db(), { runId, limit: 500 })
console.log(`run #${runId}: ${rows.length} domain(s), ${rows.filter((r) => r.status !== 'LIVE').length} candidate(s)`)

const t0 = Date.now()
const audit = await auditAuthorityLinks(
  rows.map((r) => ({ domain: r.domain, status: r.status })),
  { minReferringDomains, maxLookups: 40 },
)
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(
  `\npaid lookups: ${audit.lookups} · total ${formatMicrosUsd(audit.costMicros, { precision: 4 })} · ${secs}s`,
)
console.log(
  `skipped: ${audit.skipped.live} live · ${audit.skipped.noBacklinks} below threshold · ${audit.skipped.overCap} over cap`,
)

const withCitations = audit.rows.filter((r) => (r.profile?.matches.length ?? 0) > 0)
console.log(`\n=== ${withCitations.length} domain(s) holding authority citations ===`)
for (const r of withCitations) {
  const status = rows.find((x) => x.domain === r.domain)?.status ?? '—'
  console.log(
    `\n${r.domain}  [${status}]  score ${r.profile!.score}  ` +
      `refDomains ${r.referringDomains ?? '—'}${r.profile!.hasHardToReplace ? '  HARD-TO-REPLACE' : ''}`,
  )
  for (const m of r.profile!.matches.slice(0, 6)) {
    console.log(`    ${m.kind.padEnd(18)} ${m.domain.padEnd(34)} rank ${m.rank ?? '—'}`)
  }
}

if (withCitations.length === 0) {
  console.log('(none — every checked domain had an ordinary link profile)')
}

const checkedNoCitations = audit.rows.filter((r) => r.profile && r.profile.matches.length === 0)
console.log(`\nchecked with no citations: ${checkedNoCitations.length}`)
process.exit(0)
