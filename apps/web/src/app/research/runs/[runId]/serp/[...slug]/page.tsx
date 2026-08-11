import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, getRunKeywordDetail, queryOr, resolveRunKeywordPath } from '@rnr/data'
import { OpenLocalSerpLinks } from '@/components/OpenLocalSerpLinks'
import { KeywordSerpDetail } from '@/components/research/KeywordSerpDetail'

export const dynamic = 'force-dynamic'

/**
 * One keyword, as one run measured it.
 *
 * ==================== WHY THIS PAGE EXISTS ====================
 * The run grid answers "which cells look interesting". It cannot answer "what
 * did page 1 actually look like, and why is this score what it is" -- there are
 * 27 columns of derived numbers and no way to see the page they were derived
 * from. The SERPs have been stored since the sweep was written; nothing showed
 * them.
 *
 * Addressed by metrics id because that is the only stable handle on a grid row:
 * researchKeywordId + researchGeoId does not identify one, since the
 * geo-explicit variant reuses the primary's keyword row and each pair is
 * measured once per device. The page then widens back out to the keyword and
 * shows every device, because desktop and mobile are two readings of one
 * question and the interesting differences show up when they disagree.
 * =============================================================
 */
export default async function RunKeywordPage({
  params,
}: {
  params: Promise<{ runId: string; slug: string[] }>
}) {
  const { runId: rawRun, slug } = await params
  const runId = Number(rawRun)
  if (!Number.isInteger(runId) || runId <= 0) notFound()

  const segments = (slug ?? []).map((s) => decodeURIComponent(s))
  const resolved = await queryOr(
    'resolveRunKeywordPath',
    () => resolveRunKeywordPath(db(), { runId, segments }),
    { kind: 'missing' as const },
  )
  if (resolved.kind === 'missing') notFound()

  /**
   * A bare keyword slug can match more than one market inside a run -- a
   * catalog sweep measures the same keyword across many. Showing the choice is
   * the only honest answer; opening the first would put a different city's SERP
   * under a URL that named neither.
   */
  if (resolved.kind === 'ambiguous') {
    return (
      <div className="opp-workspace">
        <div className="run-page-head">
          <div className="page-breadcrumb">
            <Link href={`/research/runs/${runId}`}>Run #{runId}</Link>{' '}
            <span className="app-topbar-sep">/</span> {segments.join('/')}
          </div>
          <h1 className="page-title" style={{ margin: 0 }}>
            Measured in {resolved.options.length} markets
          </h1>
        </div>
        <section className="sm-panel">
          <div className="cell-run-list">
            {resolved.options.map((o) => (
              <Link
                key={o.path}
                href={`/research/runs/${runId}/serp/${o.path}`}
                className="cell-run-chip"
              >
                <span className="cell-run-id">
                  {[o.market, o.stateAbbr].filter(Boolean).join(', ')}
                </span>
                <span className="cell-run-meta">
                  {o.redditHits} reddit · {o.devices.join(' + ')}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    )
  }

  const detail = await queryOr(
    'getRunKeywordDetail',
    () => getRunKeywordDetail(db(), { runId, metricId: resolved.metricId }),
    null,
  )
  if (!detail) notFound()

  const market = [detail.market, detail.stateAbbr].filter(Boolean).join(', ')

  return (
    <div className="opp-workspace">
      <div className="run-page-head">
        <div className="page-breadcrumb">
          <Link href="/research">Research</Link> <span className="app-topbar-sep">/</span>{' '}
          <Link href="/research">Market sweep runs</Link>{' '}
          <span className="app-topbar-sep">/</span>{' '}
          <Link href={`/research/runs/${runId}`}>#{runId}</Link>{' '}
          <span className="app-topbar-sep">/</span> {detail.keyword}
        </div>

        <div className="run-page-title-row">
          <h1 className="page-title" style={{ margin: 0 }}>
            {detail.keyword}
          </h1>
          <Link href={`/research/runs/${runId}`} className="btn tiny">
            ← Back to run
          </Link>
        </div>

        <div className="run-page-meta">
          <span>
            Market: <strong>{market || '—'}</strong>
          </span>
          {detail.nicheLabel && (
            <span>
              · Niche: <strong>{detail.nicheLabel}</strong>
            </span>
          )}
          {detail.keywordVariant && detail.keywordVariant !== 'primary' && (
            <span>
              · Variant: <strong>{detail.keywordVariant}</strong>
            </span>
          )}
          {detail.locationCode != null && <span> · location_code {detail.locationCode}</span>}
          <span>
            {' '}
            · Run <strong>#{runId}</strong> ({detail.runStatus})
          </span>
          {detail.localitySlug && detail.nicheSlug && (
            <span>
              {' '}
              ·{' '}
              <Link href={`/markets/${detail.localitySlug}/${detail.nicheSlug}`}>
                Market page →
              </Link>
            </span>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <OpenLocalSerpLinks
            query={detail.keyword}
            city={detail.market ?? ''}
            state={detail.stateAbbr}
            canonicalLocation={detail.geoTargetName}
            queryModifier={detail.queryModifier}
            lat={detail.lat}
            lon={detail.lon}
            compact
          />
        </div>
      </div>

      <KeywordSerpDetail
        keyword={detail.keyword}
        devices={detail.devices.map((d) => ({
          metricId: d.metricId,
          jobId: d.jobId,
          device: d.device,
          measuredAt: d.measuredAt ? d.measuredAt.toISOString() : null,
          depth: d.depth,
          jobStatus: d.jobStatus,
          jobError: d.jobError,
          costMicros: d.costMicros.toString(),
          items: d.items,
          redditHits: d.redditHits,
          metric: {
            avgMonthlySearches: d.metric.avgMonthlySearches,
            volumeSource: d.metric.volumeSource,
            volumeGeoTarget: d.metric.volumeGeoTarget,
            cpcMicros: d.metric.cpcMicros == null ? null : Number(d.metric.cpcMicros),
            serpCompetition: d.metric.serpCompetition,
            serpCompetitionIndex: d.metric.serpCompetitionIndex,
            difficulty: d.metric.difficulty,
            weightCovered: d.metric.weightCovered,
            slotsOpen: d.metric.slotsOpen,
            platformHeldSlots: d.metric.platformHeldSlots,
            medianRefDomains: d.metric.medianRefDomains,
            linkDataMeasured: d.metric.linkDataMeasured,
            verdictEmd: d.metric.verdictEmd,
            verdictAcquired: d.metric.verdictAcquired,
            redditHitCount: d.metric.redditHitCount,
            bestRedditRankAbsolute: d.metric.bestRedditRankAbsolute,
            forumsCount: d.metric.forumsCount,
            discussionsPackPresent: d.metric.discussionsPackPresent,
            firstOrganicRankAbsolute: d.metric.firstOrganicRankAbsolute,
            adsAboveOrganicCount: d.metric.adsAboveOrganicCount,
            lsaAboveOrganicCount: d.metric.lsaAboveOrganicCount,
            localBusinessAboveOrganicCount: d.metric.localBusinessAboveOrganicCount,
            localPackCount: d.metric.localPackCount,
            organicCount: d.metric.organicCount,
            paidCount: d.metric.paidCount,
            hasAiOverview: d.metric.hasAiOverview,
            hasPeopleAlsoAsk: d.metric.hasPeopleAlsoAsk,
            mapsEntryCount: d.metric.mapsEntryCount,
            itemTypes: d.metric.itemTypes,
            relatedSearches: d.metric.relatedSearches,
            topOrganicDomains: d.metric.topOrganicDomains,
            gbpLeaders: d.metric.gbpLeaders,
          },
        }))}
      />
    </div>
  )
}
