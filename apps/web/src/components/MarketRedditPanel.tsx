'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { NULL_DISPLAY } from '@/lib/format'
import {
  deleteDiscoveryRunAction,
  enqueueMarketRedditAction,
  promoteDiscoveryHitAction,
  type MarketRedditScanResult,
  type PromoteResultView,
} from '@/app/portfolio/actions'
import { VolumeSourceLink } from '@/components/VolumeSourceLink'
import { OpenLocalSerpLinks } from '@/components/OpenLocalSerpLinks'
import { DiscoveryRunStatus, JobsInFlightBanner } from '@/components/DiscoveryRunStatus'

export interface MarketHitView {
  id: number
  keyword: string
  redditUrl: string
  title: string | null
  subreddit: string | null
  sourceKind: string
  organicPosition: number | null
  rankAbsolute: number | null
  packPosition: number | null
  commentable: boolean | null
  promotedTargetId: number | null
  nicheId: number | null
}

export interface MarketRunView {
  id: number
  status: string
  jobsDone: number
  jobsFailed: number
  jobCount: number
  hitCount: number
  usedFixtures: boolean
  label: string | null
  error: string | null
  createdAt: string
  spendMicros?: string | null
  estimatedCostMicros?: string | null
}

export interface MarketMetricView {
  device: string
  /** Exact query string purchased in DataForSEO (city-free; geo is location_code). */
  keyword: string
  firstOrganicRankAbsolute: number | null
  adsAboveOrganicCount: number
  localProfilesAboveOrganicCount: number
  organicCount: number
  paidCount: number
  redditHitCount: number
  discussionsPackPresent: boolean
  relatedSearches: string[] | null
  measuredAt: string
  /** Local avg monthly searches (DataForSEO Keywords Data @ location_code). */
  avgMonthlySearches: number | null
  volumeSource: string | null
  volumeGeoTarget: string | null
  locationCode: number
  mapPresent?: boolean
  mapRankAbsolute?: number | null
  lsaCount?: number
  lsaAboveOrganicCount?: number
  lsaRankAbsolute?: number | null
  localBusinessCount?: number
  localBusinessAboveOrganicCount?: number
  localPackRankAbsolute?: number | null
  forumsCount?: number
  forumsRankAbsolute?: number | null
  bestRedditRankAbsolute?: number | null
  sponsoredAboveOrganicCount?: number
}

/**
 * Reddit opportunities for one market cell — not a top-level product surface.
 */
export function MarketRedditPanel({
  localitySlug,
  nicheSlug,
  nicheId,
  nicheLabel,
  localityName,
  stateCode,
  providerLocationName,
  lat,
  lon,
  keywordNoun,
  hits,
  recentRuns,
  metrics,
}: {
  localitySlug: string
  nicheSlug: string
  nicheId: number
  nicheLabel: string
  localityName: string
  stateCode: string
  /** Google geotarget name for UULE; null falls back to city+state guesswork. */
  providerLocationName?: string | null
  /** Market centroid. Preferred over the name — Google honours coordinates. */
  lat?: number | null
  lon?: number | null
  keywordNoun: string
  hits: MarketHitView[]
  recentRuns: MarketRunView[]
  metrics: MarketMetricView[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [scanMsg, setScanMsg] = useState<MarketRedditScanResult | null>(null)
  const [promoteMsg, setPromoteMsg] = useState<Record<number, PromoteResultView>>({})

  const inFlight = recentRuns.some(
    (r) => r.status === 'pending' || r.status === 'running' || r.status === 'claimed',
  )

  return (
    <div className="card" id="reddit">
      <h3 style={{ marginTop: 0 }}>Local SERP research</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Buys exact buy-intent queries for <strong>{keywordNoun}</strong> (city-free keyword text) with
        SERP geo set to{' '}
        <strong>
          {localityName}, {stateCode}
        </strong>
        . Volume is from <strong>DataForSEO</strong> (Google Ads metrics scoped to this market&apos;s
        location_code) — not map-pack listings and not a population estimate. Desktop + mobile
        layout metrics + Reddit ranks.
      </p>

      <div className="flex" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() => {
            const fd = new FormData()
            fd.set('localitySlug', localitySlug)
            fd.set('nicheSlug', nicheSlug)
            startTransition(async () => {
              const res = await enqueueMarketRedditAction(fd)
              setScanMsg(res)
              if (res.ok) router.refresh()
            })
          }}
        >
          {pending ? 'Queuing…' : inFlight ? 'Queuing another run…' : 'Run local SERP research'}
        </button>
        <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>
          Buy-intent cluster · desktop+mobile · local geo · {nicheLabel}
        </span>
      </div>

      {scanMsg && (
        <div className={scanMsg.ok ? 'okbox' : 'stopbox'} style={{ marginBottom: 12 }}>
          {scanMsg.error ?? scanMsg.detail}
        </div>
      )}

      {pending && (
        <JobsInFlightBanner
          active
          detail="Queuing SERP jobs for this market. Progress cards update automatically."
        />
      )}

      <DiscoveryRunStatus
        runs={recentRuns.map((r) => ({
          id: r.id,
          status: r.status,
          jobCount: r.jobCount,
          jobsDone: r.jobsDone,
          jobsFailed: r.jobsFailed,
          hitCount: r.hitCount,
          label: r.label ?? `${localityName}, ${stateCode} · ${nicheLabel}`,
          error: r.error,
          createdAt: r.createdAt,
          usedFixtures: r.usedFixtures,
          spendMicros: r.spendMicros,
          estimatedCostMicros: r.estimatedCostMicros,
        }))}
        title="Research jobs for this market"
        autoRefresh
        onDeleteRun={deleteDiscoveryRunAction}
      />

      {metrics.length > 0 && (
        <>
          <h4>Queries checked</h4>
          <p className="sub" style={{ fontSize: 12, marginTop: 0 }}>
            Exact query strings sent to DataForSEO. Volume = local search volume for that
            same string
            {metrics[0]?.volumeGeoTarget
              ? ` · geo ${metrics[0].volumeGeoTarget}`
              : ''}
            {metrics[0]?.locationCode
              ? ` · SERP location_code ${metrics[0].locationCode}`
              : ''}
            .
          </p>
          <OpenLocalSerpLinks
            query={metrics[0]?.keyword || keywordNoun}
            city={localityName}
            state={stateCode}
            canonicalLocation={providerLocationName}
            queryModifier={localityName}
            lat={lat}
            lon={lon}
            measuredDevice={
              metrics[0]?.device === 'mobile' || metrics[0]?.device === 'desktop'
                ? metrics[0].device
                : 'desktop'
            }
          />
          <div className="table-scroll" style={{ marginBottom: 16, maxHeight: 420, overflow: 'auto', marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Exact query</th>
                  <th>Device</th>
                  <th className="num">Vol / mo</th>
                  <th>Verify in Ads</th>
                  <th>Live SERP</th>
                  <th className="num" title="First organic rank_absolute">
                    1st org
                  </th>
                  <th className="num" title="Best Reddit rank_absolute">
                    Reddit #
                  </th>
                  <th className="num" title="Paid search ads above organic (not LSA)">
                    Ads↑
                  </th>
                  <th className="num" title="Local Services Ads (≠ paid search)">
                    LSA↑
                  </th>
                  <th className="num" title="Google Business listings above organic">
                    GBP↑
                  </th>
                  <th title="Map present">Map</th>
                  <th className="num" title="Forum threads">
                    Forums
                  </th>
                  <th>Measured</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.device + m.keyword}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {m.keyword}
                    </td>
                    <td>
                      <span className="badge">{m.device}</span>
                    </td>
                    <td className="num">
                      {m.avgMonthlySearches === null ? (
                        <span className="null" title="No local volume metric for this query">
                          {NULL_DISPLAY}
                        </span>
                      ) : (
                        <>
                          {m.avgMonthlySearches.toLocaleString()}
                          {(m.volumeSource === 'dataforseo_google_ads' ||
                            m.volumeSource === 'dataforseo' ||
                            m.volumeSource === 'google_ads') && (
                            <div className="faint" style={{ fontSize: 10 }}>
                              {m.volumeSource === 'google_ads' ? 'Google Ads' : 'DataForSEO local'}
                              {m.volumeGeoTarget
                                ? ` · ${m.volumeGeoTarget
                                    .replace('geoTargetConstants/', '')
                                    .replace('dataforseo location_code=', 'loc ')
                                    .replace(' (US national)', ' US')}`
                                : ''}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <VolumeSourceLink
                        linkOnly
                        volume={m.avgMonthlySearches}
                        keyword={m.keyword}
                        volumeSource={m.volumeSource}
                        volumeGeoTarget={m.volumeGeoTarget}
                        geoCriteriaId={m.locationCode}
                      />
                    </td>
                    <td>
                      <OpenLocalSerpLinks
                        compact
                        query={m.keyword}
                        city={localityName}
                        state={stateCode}
                        canonicalLocation={providerLocationName}
                        queryModifier={localityName}
                        lat={lat}
                        lon={lon}
                        measuredDevice={
                          m.device === 'mobile' || m.device === 'desktop' ? m.device : null
                        }
                      />
                    </td>
                    <td className="num">
                      {m.firstOrganicRankAbsolute === null
                        ? NULL_DISPLAY
                        : `#${m.firstOrganicRankAbsolute}`}
                    </td>
                    <td className="num">
                      {m.bestRedditRankAbsolute != null
                        ? `#${m.bestRedditRankAbsolute}`
                        : m.redditHitCount > 0
                          ? m.redditHitCount
                          : NULL_DISPLAY}
                    </td>
                    <td className="num" title="Paid search ads above first organic">
                      {m.adsAboveOrganicCount}
                      {m.paidCount > m.adsAboveOrganicCount ? (
                        <span className="faint" style={{ fontSize: 10 }}>
                          {' '}
                          /{m.paidCount}
                        </span>
                      ) : null}
                    </td>
                    <td className="num" title="LSA above organic / total LSA">
                      {m.lsaAboveOrganicCount ?? 0}
                      {(m.lsaCount ?? 0) > 0 ? (
                        <span className="faint" style={{ fontSize: 10 }}>
                          {' '}
                          /{m.lsaCount}
                        </span>
                      ) : null}
                    </td>
                    <td className="num" title="GBP above organic / total GBP on SERP">
                      {m.localBusinessAboveOrganicCount ?? m.localProfilesAboveOrganicCount}
                      {(m.localBusinessCount ?? 0) > 0 ? (
                        <span className="faint" style={{ fontSize: 10 }}>
                          {' '}
                          /{m.localBusinessCount}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ fontSize: 11 }}>
                      {m.mapPresent
                        ? `yes${m.mapRankAbsolute != null ? ` #${m.mapRankAbsolute}` : ''}`
                        : NULL_DISPLAY}
                    </td>
                    <td className="num">
                      {(m.forumsCount ?? 0) > 0
                        ? `${m.forumsCount}${
                            m.forumsRankAbsolute != null ? ` @#${m.forumsRankAbsolute}` : ''
                          }`
                        : m.discussionsPackPresent
                          ? 'pack'
                          : NULL_DISPLAY}
                    </td>
                    <td className="mono faint" style={{ fontSize: 11 }}>
                      {m.measuredAt.slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metrics.some((m) => m.relatedSearches && m.relatedSearches.length > 0) && (
            <p className="sub" style={{ fontSize: 12 }}>
              <strong>Related (long-tail hints, not auto-researched):</strong>{' '}
              {(metrics.find((m) => m.relatedSearches?.length)?.relatedSearches ?? [])
                .slice(0, 8)
                .join(' · ')}
            </p>
          )}
        </>
      )}

      <h4>Reddit hits</h4>
      {hits.length === 0 ? (
        <div className="empty">
          No Reddit hits yet. Run local SERP research to buy the keyword×device SERPs for this
          place.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Keyword</th>
                <th>Thread</th>
                <th>Source</th>
                <th className="num">Organic</th>
                <th className="num">Absolute</th>
                <th className="num">Pack</th>
                <th>Commentable</th>
                <th>Watch</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => {
                const msg = promoteMsg[h.id]
                return (
                  <tr key={h.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {h.keyword}
                    </td>
                    <td style={{ fontSize: 11.5, maxWidth: 240 }}>
                      <a href={h.redditUrl} target="_blank" rel="noreferrer">
                        {h.title ?? h.subreddit ?? 'thread'}
                      </a>
                      {h.subreddit && (
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          r/{h.subreddit}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 11 }}>
                      {h.sourceKind === 'discussions_and_forums' ? (
                        <span className="badge warn">discussions</span>
                      ) : (
                        <span className="badge">organic</span>
                      )}
                    </td>
                    <td className="num">
                      {h.organicPosition === null ? NULL_DISPLAY : `#${h.organicPosition}`}
                    </td>
                    <td className="num">
                      {h.rankAbsolute === null ? NULL_DISPLAY : h.rankAbsolute}
                    </td>
                    <td className="num">
                      {h.packPosition === null ? NULL_DISPLAY : `#${h.packPosition}`}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {h.commentable === null ? (
                        <span className="null">{NULL_DISPLAY}</span>
                      ) : h.commentable ? (
                        <span className="badge go">open</span>
                      ) : (
                        <span className="badge stop">closed</span>
                      )}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {h.promotedTargetId ? (
                        <span className="badge go">watching</span>
                      ) : (
                        <button
                          type="button"
                          className="primary"
                          disabled={pending}
                          onClick={() => {
                            const fd = new FormData()
                            fd.set('hitId', String(h.id))
                            fd.set('nicheId', String(h.nicheId ?? nicheId))
                            fd.set('localitySlug', localitySlug)
                            fd.set('nicheSlug', nicheSlug)
                            startTransition(async () => {
                              const res = await promoteDiscoveryHitAction(fd)
                              setPromoteMsg((m) => ({ ...m, [h.id]: res }))
                              if (res.ok) router.refresh()
                            })
                          }}
                        >
                          promote
                        </button>
                      )}
                      {msg && (
                        <div
                          className={msg.ok ? 'faint' : 'disabled-reason'}
                          style={{ fontSize: 10.5, marginTop: 4 }}
                        >
                          {msg.error ?? msg.warning ?? (msg.ok ? 'promoted' : '')}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
        After promote, threads appear under <strong>SERP monitoring</strong> below. Paste a comment
        permalink there when you engage. Volume is filled from Google Ads when live.
      </p>
    </div>
  )
}
