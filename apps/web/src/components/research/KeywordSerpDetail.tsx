'use client'

import { useState } from 'react'
import { estimateRedditVisits } from '@rnr/core'

/**
 * Everything one run measured for one keyword, per device.
 *
 * The SERP is rendered top to bottom in the order Google returned it, with
 * modules expanded in place, because the whole point is to see the page the
 * derived numbers came from. Nulls render as an em dash and never as zero --
 * "not measured" and "measured as none" are different findings everywhere else
 * in this codebase and must stay different here.
 */

export interface KeywordSerpMetricView {
  avgMonthlySearches: number | null
  volumeSource: string | null
  volumeGeoTarget: string | null
  cpcMicros: number | null
  serpCompetition: string | null
  serpCompetitionIndex: number | null
  difficulty: number | null
  weightCovered: number | null
  slotsOpen: number | null
  platformHeldSlots: number | null
  medianRefDomains: number | null
  linkDataMeasured: boolean | null
  verdictEmd: string | null
  verdictAcquired: string | null
  redditHitCount: number
  bestRedditRankAbsolute: number | null
  forumsCount: number | null
  discussionsPackPresent: boolean
  firstOrganicRankAbsolute: number | null
  adsAboveOrganicCount: number
  lsaAboveOrganicCount: number | null
  localBusinessAboveOrganicCount: number | null
  localPackCount: number | null
  organicCount: number | null
  paidCount: number | null
  hasAiOverview: boolean
  hasPeopleAlsoAsk: boolean
  mapsEntryCount: number | null
  itemTypes: string[] | null
  relatedSearches: string[] | null
  topOrganicDomains: Array<{ domain: string; rankAbsolute: number }> | null
  gbpLeaders: Array<{
    title: string
    domain: string | null
    rating: number | null
    reviewsCount: number | null
    rankAbsolute: number | null
  }> | null
}

export interface KeywordDeviceView {
  metricId: number
  jobId: number
  device: string
  measuredAt: string | null
  depth: number | null
  jobStatus: string
  jobError: string | null
  costMicros: string
  items: Array<Record<string, unknown>>
  redditHits: Array<{
    redditUrl: string
    title: string | null
    subreddit: string | null
    sourceKind: string
    organicPosition: number | null
    rankAbsolute: number | null
    packPosition: number | null
  }>
  metric: KeywordSerpMetricView
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null

/** Null is not zero: an unmeasured field shows a dash. */
const n = (v: number | null | undefined): string => (v == null ? '—' : String(v))

const EXPANDABLE = new Set([
  'local_pack',
  'perspectives',
  'discussions_and_forums',
  'people_also_ask',
  'top_stories',
  'popular_products',
  'short_videos',
  'video',
  'product_considerations',
])

interface FlatRow {
  rank: number | null
  type: string
  domain: string | null
  title: string | null
  url: string | null
  nested: boolean
}

function flatten(items: Array<Record<string, unknown>>): FlatRow[] {
  const out: FlatRow[] = []
  for (const item of items) {
    const type = str(item['type']) ?? 'unknown'
    out.push({
      rank: int(item['rank_absolute']),
      type,
      domain: str(item['domain']),
      title: str(item['title']),
      url: str(item['url']),
      nested: false,
    })
    const kids = item['items']
    if (!EXPANDABLE.has(type) || !Array.isArray(kids)) continue
    for (const kid of kids) {
      if (kid === null || typeof kid !== 'object') continue
      const k = kid as Record<string, unknown>
      out.push({
        rank: int(k['rank_absolute']),
        type: str(k['type']) ?? `${type}_element`,
        domain: str(k['domain']),
        title: str(k['title']) ?? str(k['question']) ?? str(k['snippet']),
        url: str(k['url']),
        nested: true,
      })
    }
  }
  return out
}

function Stat(props: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="kw-stat" title={props.hint}>
      <div className="kw-stat-label">{props.label}</div>
      <div className={`kw-stat-value${props.tone ? ` ${props.tone}` : ''}`}>{props.value}</div>
    </div>
  )
}

export function KeywordSerpDetail(props: { keyword: string; devices: KeywordDeviceView[] }) {
  const [active, setActive] = useState(0)
  const d = props.devices[active]

  if (!d) {
    return (
      <section className="sm-panel">
        <div className="empty" style={{ padding: 24 }}>
          No measurement stored for this keyword in this run.
        </div>
      </section>
    )
  }

  const m = d.metric
  const rows = flatten(d.items)
  const usd = Number(d.costMicros) / 1_000_000
  /**
   * Derived, not stored: the run table shows this per cell and the detail page
   * has to agree with it, so both go through the same estimator rather than one
   * of them inventing a second definition of "Reddit volume".
   */
  const best = d.redditHits.reduce<{ organic: number | null; abs: number | null; pack: boolean }>(
    (acc, h) => {
      const pos = h.organicPosition ?? h.rankAbsolute ?? null
      const cur = acc.organic ?? acc.abs
      if (pos != null && (cur == null || pos < cur)) {
        return { organic: h.organicPosition, abs: h.rankAbsolute, pack: h.sourceKind !== 'organic' }
      }
      return acc
    },
    { organic: null, abs: null, pack: false },
  )
  const redditVisits = estimateRedditVisits({
    volume: m.avgMonthlySearches,
    organicPosition: best.organic,
    rankAbsolute: best.abs,
    fromPack: best.pack,
  })

  return (
    <>
      {props.devices.length > 1 && (
        <div className="sm-panel" style={{ marginBottom: 0 }}>
          <div className="opp-tabs" style={{ padding: '8px 14px' }}>
            {props.devices.map((dev, i) => (
              <button
                key={dev.metricId}
                type="button"
                className={`opp-tab${i === active ? ' active' : ''}`}
                onClick={() => setActive(i)}
              >
                {dev.device}
                <span className="opp-tab-badge">{dev.metric.redditHitCount} reddit</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="sm-panel">
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">
            Measured
            <span className="sm-count">{d.device}</span>
          </div>
          <div className="sm-toolbar-actions faint" style={{ fontSize: 12 }}>
            job #{d.jobId} · {d.jobStatus} · ${usd.toFixed(4)}
            {d.depth != null && ` · depth ${d.depth}`}
            {d.measuredAt && ` · ${new Date(d.measuredAt).toLocaleString()}`}
          </div>
        </div>

        {d.jobError && (
          <div className="empty" style={{ padding: '10px 16px' }}>
            <strong>Job error:</strong> {d.jobError}
          </div>
        )}

        {/*
          Semrush leads with a few large numbers and files the rest underneath.
          The five here are the ones a decision actually turns on; everything
          else is reference and sits in the smaller grid below.
        */}
        <div className="kw-hero">
          <div className="kw-hero-metric">
            <div className="kw-hero-label">Volume</div>
            <div className="kw-hero-value">{n(m.avgMonthlySearches)}</div>
            <div className="kw-hero-sub">{m.volumeSource ?? 'not measured'}</div>
          </div>
          <div className="kw-hero-metric">
            <div className="kw-hero-label">Reddit vol</div>
            <div className={`kw-hero-value${redditVisits != null ? ' kw-hero-accent' : ''}`}>
              {n(redditVisits)}
            </div>
            <div className="kw-hero-sub">
              {m.redditHitCount > 0
                ? `${m.redditHitCount} thread${m.redditHitCount === 1 ? '' : 's'}`
                : 'no threads'}
            </div>
          </div>
          <div className="kw-hero-metric">
            <div className="kw-hero-label">Difficulty</div>
            <div className="kw-hero-value">{n(m.difficulty)}</div>
            <div className="kw-hero-sub">
              {m.weightCovered == null
                ? 'not computed'
                : `${Math.round(m.weightCovered * 100)}% measurable`}
            </div>
          </div>
          <div className="kw-hero-metric">
            <div className="kw-hero-label">CPC</div>
            <div className="kw-hero-value">
              {m.cpcMicros == null ? '—' : `$${(m.cpcMicros / 1_000_000).toFixed(2)}`}
            </div>
            <div className="kw-hero-sub">{m.serpCompetition?.toLowerCase() ?? 'competition —'}</div>
          </div>
          <div className="kw-hero-metric">
            <div className="kw-hero-label">Slots open</div>
            <div className="kw-hero-value">{n(m.slotsOpen)}</div>
            <div className="kw-hero-sub">
              {m.platformHeldSlots == null ? 'platforms —' : `${m.platformHeldSlots} platform-held`}
            </div>
          </div>
        </div>

        <div className="kw-stat-grid">
          <Stat label="Acquired" hint="Winnability if a domain is bought" value={m.verdictAcquired ?? '—'} />
          <Stat label="Fresh EMD" hint="Winnability registering a new exact-match domain" value={m.verdictEmd ?? '—'} />
          <Stat
            label="Reddit rank"
            value={n(m.bestRedditRankAbsolute)}
            hint={
              'Absolute rank -- counts every item on the page, including ads, ' +
              'AI overviews and packs. The threads below show ORGANIC position, ' +
              'which is the smaller number and the one the CTR curve uses.'
            }
          />
          <Stat
            label="Discussions"
            value={m.discussionsPackPresent ? `yes (${n(m.forumsCount)})` : 'no'}
          />
          <Stat
            label="Ref domains"
            value={m.linkDataMeasured ? n(m.medianRefDomains) : '—'}
            hint={m.linkDataMeasured ? undefined : 'Link data was never bought for this SERP'}
          />
          <Stat label="1st organic" value={n(m.firstOrganicRankAbsolute)} />
          <Stat label="Organic" value={n(m.organicCount)} />
          <Stat label="Ads above" hint="Paid results above the first organic" value={String(m.adsAboveOrganicCount)} />
          <Stat label="LSA above" hint="Local Services Ads above the first organic" value={n(m.lsaAboveOrganicCount)} />
          <Stat label="GBP above" hint="Local business profiles above the first organic" value={n(m.localBusinessAboveOrganicCount)} />
          <Stat label="AI overview" value={m.hasAiOverview ? 'yes' : 'no'} />
          <Stat label="Maps" value={n(m.mapsEntryCount)} />
        </div>
      </section>

      {d.redditHits.length > 0 && (
        <section className="sm-panel">
          <div className="sm-toolbar">
            <div className="sm-toolbar-title">
              Reddit threads
              <span className="sm-count">{d.redditHits.length}</span>
            </div>
            <div className="sm-toolbar-actions faint" style={{ fontSize: 12 }}>
              Position is organic where the thread has one, pack position otherwise
            </div>
          </div>
          {/*
            A list rather than a table: thread titles run to a full sentence and
            a fixed-width cell either clipped them or wrapped into a ragged
            block. Here the title gets the width and everything else is a chip.
          */}
          <ul className="kw-threads">
            {d.redditHits.map((h) => (
              <li key={h.redditUrl} className="kw-thread">
                <span className="kw-thread-rank" title="Organic position, or pack position">
                  {h.organicPosition != null
                    ? `#${h.organicPosition}`
                    : h.packPosition != null
                      ? `p${h.packPosition}`
                      : h.rankAbsolute != null
                        ? `#${h.rankAbsolute}`
                        : '—'}
                </span>
                <div className="kw-thread-body">
                  <a
                    className="kw-thread-title"
                    href={h.redditUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {h.title ?? h.redditUrl}
                  </a>
                  <div className="kw-thread-meta">
                    <span className="kw-chip">r/{h.subreddit ?? '?'}</span>
                    <span className={`kw-chip kw-chip-${h.sourceKind === 'organic' ? 'organic' : 'pack'}`}>
                      {h.sourceKind === 'organic' ? 'organic result' : 'discussion pack'}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sm-panel">
        <div className="sm-toolbar">
          <div className="sm-toolbar-title">
            Page 1, as returned
            <span className="sm-count">{rows.length} items</span>
          </div>
          <div className="sm-toolbar-actions faint" style={{ fontSize: 12 }}>
            Stored from the run. Free to re-read — this is not a fresh fetch.
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            No stored page for this job. Pages are kept for every completed SERP; a job that
            failed or is still queued has nothing to show.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="sm-table kw-serp-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Type</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={`${r.type}-${i}`}
                    className={r.nested ? 'stored-serp-nested' : undefined}
                  >
                    <td className="num kw-serp-rank">{r.rank ?? ''}</td>
                    <td>
                      <span className={`serp-type serp-type-${r.type.split('_')[0]}`}>
                        {r.type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="kw-serp-result">
                      {/*
                        Domain first and title beneath, each on one line with an
                        ellipsis. Perspectives titles are whole sentences, and in
                        a fixed cell they wrapped into a three-line block that
                        made the page unreadable.
                      */}
                      {r.domain && <div className="kw-serp-domain">{r.domain}</div>}
                      {r.url ? (
                        <a
                          className="kw-serp-title"
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={r.title ?? r.url}
                        >
                          {r.title ?? r.url}
                        </a>
                      ) : (
                        <div className="kw-serp-title" title={r.title ?? undefined}>
                          {r.title ?? '—'}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/*
        Compared explicitly rather than leaning on `&&`: two empty arrays give
        `0 || 0` -> 0, and React renders a bare 0 on the page rather than
        nothing. It did exactly that.
      */}
      {((m.relatedSearches?.length ?? 0) > 0 || (m.gbpLeaders?.length ?? 0) > 0) && (
        <section className="sm-panel">
          <div className="sm-toolbar">
            <div className="sm-toolbar-title">Also on the page</div>
          </div>
          <div className="kw-extras">
            {m.gbpLeaders && m.gbpLeaders.length > 0 && (
              <div className="kw-extra">
                <div className="kw-extra-head">Local pack</div>
                <ul className="kw-extra-list">
                  {m.gbpLeaders.map((g) => (
                    <li key={`${g.title}-${g.rankAbsolute}`}>
                      <strong>{g.title}</strong>
                      {g.domain && <span className="mono"> · {g.domain}</span>}
                      {g.rating != null && (
                        <span className="faint">
                          {' '}
                          · {g.rating}★ ({n(g.reviewsCount)})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {m.relatedSearches && m.relatedSearches.length > 0 && (
              <div className="kw-extra">
                <div className="kw-extra-head">Related searches</div>
                <ul className="kw-extra-list">
                  {m.relatedSearches.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  )
}
