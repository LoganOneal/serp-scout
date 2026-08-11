import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, getEnrichRun, listDomainCandidates, queryOr } from '@rnr/data'
import {
  DomainCandidatesTable,
  type CandidateRow,
} from '@/components/domains/DomainCandidatesTable'

export const dynamic = 'force-dynamic'

const fmtUsd = (micros: bigint): string => `$${(Number(micros) / 1_000_000).toFixed(4)}`

/** One market's worth of domains, as a full-page table. */
export default async function DomainEnrichRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId: raw } = await params
  const runId = Number(raw)
  if (!Number.isInteger(runId) || runId <= 0) notFound()

  const database = db()
  const run = await queryOr('getEnrichRun', () => getEnrichRun(database, runId), null)
  if (!run) notFound()

  const raws = await queryOr(
    'listDomainCandidates',
    () => listDomainCandidates(database, { runId, limit: 2000 }),
    [],
  )

  const rows: CandidateRow[] = raws.map((r) => ({
    id: r.id,
    domain: r.domain,
    status: r.status,
    reason: r.reason,
    score: r.score,
    scoreMissing: r.scoreMissing,
    businessCount: r.businessCount,
    businesses: r.businesses,
    registrar: r.registrar,
    ageYears: r.ageYears,
    daysToExpiry: r.daysToExpiry,
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    httpOutcome: r.httpOutcome,
    redirectedTo: r.redirectedTo,
    parkingNameserver: r.parkingNameserver,
    trustFlow: r.trustFlow,
    citationFlow: r.citationFlow,
    referringDomains: r.referringDomains,
    referringSubnets: r.referringSubnets,
    totalSnapshots: r.totalSnapshots,
    yearsOfContent: r.yearsOfContent,
    sources: r.sources,
    serpRank: r.serpRank,
    seenKeyword: r.seenKeyword,
    spamScore: r.spamScore,
    rankedKeywords: r.rankedKeywords,
    authorityMatches: r.authorityMatches,
    // The run carries the market; a candidate row does not, and a directory
    // search without a locality returns the whole directory.
    market: run.locality.split(',')[0]?.trim() ?? null,
    stateAbbr: run.locality.split(',')[1]?.trim() ?? null,
  }))

  const active = run.status === 'running' || run.status === 'pending'

  return (
    <div className="opp-workspace">
      <div className="run-page-head">
        <div className="page-breadcrumb">
          <Link href="/domains">Domains</Link> <span className="app-topbar-sep">/</span> Searches <span className="app-topbar-sep">/</span> #{run.id}
        </div>
        <div className="run-page-title-row">
          <h1 className="page-title" style={{ margin: 0 }}>
            {run.niche} — {run.locality}
          </h1>
          <div className="page-header-actions">
            <Link href="/domains" className="btn">
              ← All runs
            </Link>
          </div>
        </div>
        <div className="sm-magic-meta">
          <span>
            Status: <strong>{run.status}</strong>
          </span>
          {active && <span className="job-spinner" aria-hidden />}
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Businesses: <strong>{run.businessesFound}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Unique domains: <strong>{run.uniqueDomains}</strong>
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span title="Listings on a platform we cannot acquire, plus listings with no website">
            Dropped: <strong>{run.skippedPlatform}</strong> platform ·{' '}
            <strong>{run.skippedNoDomain}</strong> no site
          </span>
          <span className="sm-magic-meta-sep">·</span>
          <span>
            Cost: <strong>{fmtUsd(run.costMicros)}</strong>
          </span>
        </div>
        {run.error && <div className="enrich-start-result err">{run.error}</div>}
        <div className="enrich-caveat">
          Trust Flow, Citation Flow and referring subnets need a Majestic key, which is not
          configured — those columns read <strong>—</strong> and affected rows are marked{' '}
          <em>partial</em> rather than scored down for missing data.
        </div>
      </div>

      <DomainCandidatesTable rows={rows} />
    </div>
  )
}
