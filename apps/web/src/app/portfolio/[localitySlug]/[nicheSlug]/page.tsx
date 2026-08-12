import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Verdict } from '@rnr/core'
import {
  db,
  getCellDetail,
  listDiscoveryHitsForCell,
  listDiscoveryRunsForLocality,
  listEnrichRunsForMarket,
  listKeywordsForSite,
  listRunsForCell,
  listSerpMetricsForCell,
  listStoredSerpsForCell,
  listSerpTargets,
  queryOr,
  resolveMarketLocationCode,
} from '@rnr/data'
import { SiteDashboard } from '@/components/SiteDashboard'
import { SerpPanel } from '@/components/SerpPanel'
import { StartTargeting } from '@/components/StartTargeting'
import { MarketRedditPanel } from '@/components/MarketRedditPanel'
import {
  addSerpTargetAction,
  importKeywordsAction,
  removeKeywordAction,
  startTargetingAction,
} from '@/app/portfolio/actions'
import { MarketManagePanel } from '@/components/MarketManagePanel'
import { MarketDomainsPanel } from '@/components/markets/MarketDomainsPanel'
import { CellRunPicker } from '@/components/markets/CellRunPicker'
import { StoredSerpPanel } from '@/components/markets/StoredSerpPanel'
import { PipelineRowActions } from '@/components/PipelineRowActions'
import { NULL_DISPLAY, money, num, percent, verdictStyle } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * One locality+niche cell — the whole tool in one page.
 *
 * ==================== KEYED BY THE CELL, NOT A SITE ID ====================
 * Research exists before a site does, so a page addressed by site id could never show a cell
 * you have merely scanned. Both slugs are unique, so the pair addresses the cell directly and
 * the URL stays stable across the entire lifecycle: scanned → shortlisted → targeted → rented.
 * =======================================================================
 */
export default async function CellPage({
  params,
  searchParams,
}: {
  params: Promise<{ localitySlug: string; nicheSlug: string }>
  searchParams: Promise<{ run?: string }>
}) {
  const { localitySlug, nicheSlug } = await params
  const { run: runParam } = await searchParams
  const database = db()

  const cell = await getCellDetail(database, { localitySlug, nicheSlug })
  if (cell === null) notFound()

  /**
   * Which run this page is showing.
   *
   * The cell URL stays stable across the lifecycle (see above), so the run
   * lives in a query string rather than the path. Defaulting to the newest run
   * rather than to "all runs merged" is the actual fix: merging produced a
   * market that existed at no single moment and changed under the operator
   * whenever any run touched the cell.
   */
  const cellRuns = await queryOr(
    'listRunsForCell',
    () => listRunsForCell(database, { localityId: cell.localityId, nicheId: cell.nicheId }),
    [],
  )
  const requestedRun = runParam === 'all' ? null : Number(runParam)
  const selectedRunId =
    runParam === 'all'
      ? null
      : Number.isFinite(requestedRun) && cellRuns.some((r) => r.runId === requestedRun)
        ? requestedRun
        : (cellRuns[0]?.runId ?? null)

  // Sequential, each with a deadline. See the note on /markets: concurrent queries against
  // the transaction pooler are what made every database-backed page hang for 300 seconds.
  const site = cell.site
  const keywords = site
    ? await queryOr('listKeywordsForSite', () => listKeywordsForSite(database, site.id), [])
    : []
  const targets = site
    ? await queryOr('listSerpTargets', () => listSerpTargets(database, site.id), [])
    : []
  const redditHits = await queryOr(
    'listDiscoveryHitsForCell',
    () =>
      listDiscoveryHitsForCell(database, {
        localityId: cell.localityId,
        nicheId: cell.nicheId,
        runId: selectedRunId,
      }),
    [],
  )
  const redditRuns = await queryOr(
    'listDiscoveryRunsForLocality',
    () => listDiscoveryRunsForLocality(database, cell.localityId, 5),
    [],
  )
  const serpMetrics = await queryOr(
    'listSerpMetricsForCell',
    () =>
      listSerpMetricsForCell(database, {
        localityId: cell.localityId,
        nicheId: cell.nicheId,
        runId: selectedRunId,
      }),
    [],
  )
  const storedSerps = await queryOr(
    'listStoredSerpsForCell',
    () =>
      listStoredSerpsForCell(database, {
        localityId: cell.localityId,
        nicheId: cell.nicheId,
        runId: selectedRunId,
      }),
    [],
  )
  const marketGeo = await queryOr(
    'resolveMarketLocationCode',
    () => resolveMarketLocationCode(database, cell.localityId),
    null,
  )
  const domainRuns =
    marketGeo == null
      ? []
      : await queryOr(
          'listEnrichRunsForMarket',
          () =>
            listEnrichRunsForMarket(database, {
              locationCode: marketGeo.locationCode,
              niche: cell.nicheLabel,
            }),
          [],
        )

  return (
    <div>
      <div className="page-breadcrumb">
        <Link href="/portfolio">Markets</Link>
        <span className="faint"> / </span>
        {cell.localityName}, {cell.stateCode}
        <span className="faint"> / </span>
        {cell.nicheLabel}
      </div>
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ marginBottom: 4 }}>
          {cell.localityName}, {cell.stateCode} · {cell.nicheLabel}
        </h1>
        <Link href="/portfolio" className="btn tiny">
          ← All markets
        </Link>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        {site?.domain ? (
          <span className="mono">{site.domain}</span>
        ) : site ? (
          <span className="badge warn" title="You are targeting this cell but have not registered a domain.">
            no domain yet
          </span>
        ) : (
          <span className="badge unknown">not targeted</span>
        )}
        {site && (
          <>
            {' · '}
            <span className={`badge ${statusTone(site.status)}`}>{site.status}</span>
          </>
        )}
        {cell.population !== null && <> · pop {num(cell.population)}</>}
      </p>

      {site !== null && (
        <MarketManagePanel
          siteId={site.id}
          domain={site.domain}
          displayName={site.displayName}
          status={site.status}
          notes={site.notes}
          label={`${cell.localityName}, ${cell.stateCode} · ${cell.nicheLabel}`}
        />
      )}

      {/* --- Research: what the model said -------------------------------- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Research</h3>
        {cell.latestScan === null && cell.shortlist === null ? (
          <div className="empty">
            This cell has never been scanned. Run a scan from{' '}
            <Link href="/scout">Run research</Link> to measure it — targeting a cell without
            research is allowed, it just means there is no prediction to compare against.
          </div>
        ) : (
          <div className="kv">
            {cell.latestScan !== null && (
              <>
                <span>Difficulty (latest scan)</span>
                <span>
                  {cell.latestScan.difficulty === null ? (
                    <span className="null" title="Nothing could be measured. Never sorts as easiest.">
                      {NULL_DISPLAY}
                    </span>
                  ) : (
                    cell.latestScan.difficulty
                  )}{' '}
                  <span className="faint" style={{ fontSize: 11 }}>
                    scored on {percent(cell.latestScan.weightCovered)} of signals
                  </span>
                </span>

                <span>Verdict</span>
                <span>
                  <span className={`badge ${verdictStyle(cell.latestScan.verdict as Verdict).tone}`}>
                    {verdictStyle(cell.latestScan.verdict as Verdict).label}
                  </span>
                </span>

                <span>Modelled rent</span>
                <span>
                  {cell.latestScan.rentMicros === null ? (
                    <span className="null" title="Could not be modelled. Not zero.">
                      {NULL_DISPLAY}
                    </span>
                  ) : (
                    <>
                      {money(cell.latestScan.rentMicros, { decimals: 0 })}
                      <span className="faint" style={{ fontSize: 11 }}> /mo, modelled</span>
                    </>
                  )}
                </span>

                <span>Modelled demand (not search volume)</span>
                <span>
                  {cell.latestScan.volumeEst === null ? (
                    <span className="null">{NULL_DISPLAY}</span>
                  ) : (
                    <>
                      {num(cell.latestScan.volumeEst)}
                      <span className="faint" style={{ fontSize: 11 }}>
                        {' '}
                        = population × niche prior — <strong>not</strong> Google Ads or DataForSEO.
                        See Local SERP research below for exact queries + Keyword Planner volume.
                      </span>
                    </>
                  )}
                </span>

                <span>Scanned</span>
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {cell.latestScan.createdAt.toISOString().slice(0, 10)}{' '}
                  <Link href={`/scout/scans/${cell.latestScan.scanRunId}/${cell.latestScan.scanTargetId}`}>
                    full audit →
                  </Link>
                </span>
              </>
            )}

            {cell.shortlist !== null && (
              <>
                <span>Shortlisted</span>
                <span>
                  <span className={`badge ${verdictStyle(cell.shortlist.verdictAtSave as Verdict).tone}`}>
                    {verdictStyle(cell.shortlist.verdictAtSave as Verdict).label}
                  </span>{' '}
                  <span className="faint" style={{ fontSize: 11 }}>
                    frozen at {cell.shortlist.savedAt.toISOString().slice(0, 10)} — calibration
                    compares outcomes against what the model said then, not now
                  </span>
                </span>
                <span>EMD considered</span>
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {cell.shortlist.emdDomain}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* --- Targeting ---------------------------------------------------- */}
      {site === null ? (
        <div className="card">
          <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <h3 style={{ marginTop: 0 }}>Not targeted yet</h3>
              <p className="sub" style={{ marginTop: 0 }}>
                Starting to target this cell creates the one record everything else hangs off —
                calls, leads, keywords and SERP monitoring. A domain is optional: you can begin
                watching keywords before you register one.
              </p>
            </div>
            {cell.shortlist !== null && (
              <PipelineRowActions
                shortlistId={cell.shortlist.id}
                href={`/portfolio/${cell.localitySlug}/${cell.nicheSlug}`}
                label={`${cell.localityName}, ${cell.stateCode} · ${cell.nicheLabel}`}
                showOpen={false}
              />
            )}
          </div>
          <StartTargeting
            localitySlug={cell.localitySlug}
            nicheSlug={cell.nicheSlug}
            suggestedDomain={cell.shortlist?.emdDomain ?? null}
            onStart={startTargetingAction}
          />
        </div>
      ) : (
        <SiteDashboard siteId={site.id} />
      )}

      {/* --- Reddit opportunities (market-scoped) ------------------------- */}
      <MarketDomainsPanel
        niche={cell.nicheLabel}
        locality={`${cell.localityName}, ${cell.stateCode}`}
        locationCode={marketGeo?.locationCode ?? null}
        locationName={marketGeo?.locationName ?? null}
        runs={domainRuns.map((r) => ({
          id: r.id,
          status: r.status,
          uniqueDomains: r.uniqueDomains,
          candidateCount: r.candidateCount,
          bestScore: r.bestScore,
          costMicros: String(r.costMicros),
          createdAt: r.createdAt.toISOString(),
          error: r.error,
        }))}
      />

      <CellRunPicker
        basePath={`/portfolio/${cell.localitySlug}/${cell.nicheSlug}`}
        selectedRunId={selectedRunId}
        runs={cellRuns.map((r) => ({
          runId: r.runId,
          source: r.source,
          status: r.status,
          label: r.label,
          measuredAt: r.measuredAt ? r.measuredAt.toISOString() : null,
          keywords: r.keywords,
          storedSerps: r.storedSerps,
        }))}
      />

      <StoredSerpPanel
        serps={storedSerps.map((s) => ({
          jobId: s.jobId,
          runId: s.runId,
          keyword: s.keyword,
          keywordVariant: s.keywordVariant,
          device: s.device,
          depth: s.depth,
          measuredAt: s.measuredAt ? s.measuredAt.toISOString() : null,
          items: s.items,
        }))}
      />

      <MarketRedditPanel
        localitySlug={cell.localitySlug}
        nicheSlug={cell.nicheSlug}
        nicheId={cell.nicheId}
        nicheLabel={cell.nicheLabel}
        localityName={cell.localityName}
        stateCode={cell.stateCode}
        providerLocationName={cell.providerLocationName}
        lat={cell.lat}
        lon={cell.lon}
        keywordNoun={cell.keywordNoun}
        hits={redditHits.map((h) => ({
          id: h.id,
          keyword: h.keyword,
          redditUrl: h.redditUrl,
          title: h.title,
          subreddit: h.subreddit,
          sourceKind: h.sourceKind,
          organicPosition: h.organicPosition,
          rankAbsolute: h.rankAbsolute,
          packPosition: h.packPosition,
          commentable: h.commentable,
          promotedTargetId: h.promotedTargetId,
          nicheId: h.nicheId,
        }))}
        recentRuns={redditRuns.map((r) => ({
          id: r.id,
          status: r.status,
          jobsDone: r.jobsDone,
          jobsFailed: r.jobsFailed,
          jobCount: r.jobCount,
          hitCount: r.hitCount,
          usedFixtures: r.usedFixtures,
          label: r.label,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          spendMicros: r.spendMicros != null ? String(r.spendMicros) : '0',
          estimatedCostMicros:
            r.estimatedCostMicros != null ? String(r.estimatedCostMicros) : null,
        }))}
        metrics={serpMetrics.map((m) => ({
          device: m.device,
          keyword: m.keyword,
          firstOrganicRankAbsolute: m.firstOrganicRankAbsolute,
          adsAboveOrganicCount: m.adsAboveOrganicCount,
          localProfilesAboveOrganicCount: m.localProfilesAboveOrganicCount,
          organicCount: m.organicCount,
          paidCount: m.paidCount,
          redditHitCount: m.redditHitCount,
          discussionsPackPresent: m.discussionsPackPresent,
          relatedSearches: m.relatedSearches,
          measuredAt: m.measuredAt.toISOString(),
          avgMonthlySearches: m.avgMonthlySearches,
          volumeSource: m.volumeSource,
          volumeGeoTarget: m.volumeGeoTarget,
          locationCode: m.locationCode,
          mapPresent: m.mapPresent,
          mapRankAbsolute: m.mapRankAbsolute,
          lsaCount: m.lsaCount,
          lsaAboveOrganicCount: m.lsaAboveOrganicCount,
          lsaRankAbsolute: m.lsaRankAbsolute,
          localBusinessCount: m.localBusinessCount,
          localBusinessAboveOrganicCount: m.localBusinessAboveOrganicCount,
          localPackRankAbsolute: m.localPackRankAbsolute,
          forumsCount: m.forumsCount,
          forumsRankAbsolute: m.forumsRankAbsolute,
          bestRedditRankAbsolute: m.bestRedditRankAbsolute,
          sponsoredAboveOrganicCount: m.sponsoredAboveOrganicCount,
        }))}
      />

      {/* --- SERP monitoring ---------------------------------------------- */}
      {site !== null && (
        <SerpPanel
          siteId={site.id}
          keywords={keywords.map((k) => ({
            id: k.keyword.id,
            keyword: k.keyword.keyword,
            volume: k.keyword.volume,
            difficulty: k.keyword.difficulty,
            semrushPosition: k.keyword.semrushPosition,
            targetCount: k.targetCount,
            lastCheckedAt: k.lastCheckedAt?.toISOString() ?? null,
          }))}
          targets={targets.map((t) => ({
            id: t.target.id,
            keyword: t.keyword,
            url: t.target.url,
            label: t.target.label,
            commentPermalink: t.target.commentPermalink,
            nextCheckAt: t.target.nextCheckAt.toISOString(),
            lastCheckedAt: t.target.lastCheckedAt?.toISOString() ?? null,
            serpPosition: t.latest?.serpPosition ?? null,
            serpPackPosition: t.latest?.serpPackPosition ?? null,
            serpSourceKind: t.latest?.serpSourceKind ?? null,
            serpMeasured: t.latest?.serpMeasured ?? false,
            commentRank: t.latest?.commentRank ?? null,
            commentPresent: t.latest?.commentPresent ?? null,
            error: t.latest?.error ?? null,
            regressions: t.regressions,
          }))}
          onImport={importKeywordsAction}
          onAddTarget={addSerpTargetAction}
          onRemoveKeyword={removeKeywordAction}
        />
      )}
    </div>
  )
}

function statusTone(status: string): string {
  if (status === 'rented' || status === 'live') return 'go'
  if (status === 'building') return 'warn'
  if (status === 'dropped') return 'stop'
  return 'neutral'
}
