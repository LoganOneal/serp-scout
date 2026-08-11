/**
 * Live check that the free triage stages (2, 3a-3d, 5b) reach sane verdicts.
 *
 * Every service used here is free and unauthenticated, so this probe costs
 * nothing to run and is the fastest way to confirm the classifier is not
 * mislabelling live businesses as acquisition candidates.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-domain-triage.mts [domain...]
 */
import { enrichDomains } from '../domains/enrich-pipeline.js'

const domains =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        'google.com', // unambiguously LIVE
        'wikipedia.org', // LIVE, different infrastructure
        'hugedomains.com', // a for-sale operator's own site
        'thisdomainreallyshouldnotexist9x7q.com', // expect AVAILABLE
        'example.com', // reserved, thin page — a known edge case
      ]

const result = await enrichDomains(
  domains.map((d) => ({ name: d, website: `https://${d}` })),
  { concurrency: 4, nicheTerms: [] },
)

console.log(
  `businesses ${result.stats.businesses} · unique domains ${result.stats.uniqueDomains} · ` +
    `skipped platform ${result.stats.skippedPlatform} · skipped no-domain ${result.stats.skippedNoDomain}\n`,
)

console.log('domain'.padEnd(42), 'status'.padEnd(15), 'score'.padStart(6), ' age  reason')
console.log('-'.repeat(120))
for (const c of result.candidates) {
  const age = c.classification.ageYears
  console.log(
    c.domain.padEnd(42),
    c.classification.status.padEnd(15),
    String(c.score.total).padStart(6),
    (age === null ? '  —  ' : `${age.toFixed(1)}y`).padStart(6),
    ` ${c.classification.reason}`,
  )
  console.log(
    `${' '.repeat(42)}  http=${c.http?.outcome}/${c.http?.httpStatus ?? '—'} ` +
      `text=${c.http?.visibleTextChars ?? 0}ch ` +
      `ns=${c.dns?.nameservers.length ?? 0}${c.dns?.parkingNameserver ? ` (parking: ${c.dns.parkingNameserver})` : ''} ` +
      `rdap=${c.rdap?.registered ?? 'null'} ` +
      `wayback=${c.wayback?.ok ? `${c.wayback.totalSnapshots} snaps, ${c.wayback.yearsOfContinuousContent}y run` : 'n/a'}`,
  )
}

console.log('\nby status:', JSON.stringify(result.stats.byStatus))
process.exit(0)
