'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  catalogBulkResearchAction,
  catalogCellMetricsAction,
  catalogCellResearchAction,
  type CatalogCellMetricsResult,
  type CatalogResearchResult,
} from '@/app/markets/actions'

export interface CatalogSummaryView {
  keywordCount: number
  primaryCount: number
  geoCount: number
  purchasableGeoCount: number
  softMatchedKeywords: number
  softMatchedGeos: number
}

export interface CatalogKeywordView {
  id: number
  keyword: string
  avgMonthlySearches: number | null
  variant: string
  nicheId: number | null
}

export interface CatalogGeoView {
  id: number
  market: string
  stateAbbr: string | null
  selectedRank: number | null
  dataforseoLocationCode: number | null
  localityId: number | null
}

export interface CatalogRunView {
  id: number
  status: string
  label: string | null
  jobsDone: number
  jobsFailed: number
  jobCount: number
  hitCount: number
  usedFixtures: boolean
  error: string | null
  createdAt: string
}

/**
 * #catalog — pick keyword × geo for cell research; optional bulk behind flag.
 */
export function ResearchCatalogPanel({
  summary,
  keywords,
  geos,
  recentRuns,
  bulkEnabled,
}: {
  summary: CatalogSummaryView
  keywords: CatalogKeywordView[]
  geos: CatalogGeoView[]
  recentRuns: CatalogRunView[]
  bulkEnabled: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [kwId, setKwId] = useState<number | ''>('')
  const [geoId, setGeoId] = useState<number | ''>('')
  const [kwFilter, setKwFilter] = useState('')
  const [geoFilter, setGeoFilter] = useState('')
  const [cellMsg, setCellMsg] = useState<CatalogResearchResult | null>(null)
  const [metrics, setMetrics] = useState<CatalogCellMetricsResult | null>(null)
  const [preview, setPreview] = useState<CatalogResearchResult | null>(null)
  const [budgetCents, setBudgetCents] = useState(1000)
  const [workerAck, setWorkerAck] = useState(false)
  const [confirmMsg, setConfirmMsg] = useState<CatalogResearchResult | null>(null)

  const empty = summary.keywordCount === 0 && summary.geoCount === 0

  const filteredKeywords = useMemo(() => {
    const q = kwFilter.trim().toLowerCase()
    if (!q) return keywords
    return keywords.filter(
      (k) =>
        k.keyword.toLowerCase().includes(q) ||
        String(k.avgMonthlySearches ?? '').includes(q),
    )
  }, [keywords, kwFilter])

  const filteredGeos = useMemo(() => {
    const q = geoFilter.trim().toLowerCase()
    if (!q) return geos
    return geos.filter((g) => {
      const label = `${g.market} ${g.stateAbbr ?? ''} ${g.dataforseoLocationCode ?? ''}`.toLowerCase()
      return label.includes(q)
    })
  }, [geos, geoFilter])

  const selectedKw = keywords.find((k) => k.id === kwId) ?? null
  const selectedGeo = geos.find((g) => g.id === geoId) ?? null
  const canRun = selectedKw !== null && selectedGeo !== null && !pending

  // Load metrics when both sides of the cell are chosen.
  useEffect(() => {
    if (kwId === '' || geoId === '') {
      setMetrics(null)
      return
    }
    const fd = new FormData()
    fd.set('researchKeywordId', String(kwId))
    fd.set('researchGeoId', String(geoId))
    let cancelled = false
    void catalogCellMetricsAction(fd).then((res) => {
      if (!cancelled) setMetrics(res)
    })
    return () => {
      cancelled = true
    }
  }, [kwId, geoId])

  const runCell = () => {
    if (kwId === '' || geoId === '') return
    const fd = new FormData()
    fd.set('researchKeywordId', String(kwId))
    fd.set('researchGeoId', String(geoId))
    startTransition(async () => {
      const res = await catalogCellResearchAction(fd)
      setCellMsg(res)
      if (res.ok) {
        // Re-fetch metrics after a short delay so fixture/fast path can land.
        window.setTimeout(() => {
          void catalogCellMetricsAction(fd).then(setMetrics)
        }, 2500)
      }
    })
  }

  return (
    <div className="card" id="catalog">
      <h3 style={{ marginTop: 0 }}>Research catalog</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Imported keyword seeds and geos. Import above is free. To research a SERP, pick one keyword
        and one market below, then run. That buys desktop + mobile (primary + near me) for that
        pair.
      </p>

      {empty ? (
        <div className="empty">No catalog rows yet. Import keywords and geos above.</div>
      ) : (
        <>
          <p className="sub mono" style={{ fontSize: 12 }}>
            {summary.primaryCount} primary keywords ({summary.keywordCount} total) ·{' '}
            {summary.purchasableGeoCount}/{summary.geoCount} purchasable geos · soft-matched{' '}
            {summary.softMatchedKeywords} kw / {summary.softMatchedGeos} geo
          </p>

          {/* ---- Cell research (the main action) ---- */}
          <div
            style={{
              marginTop: 12,
              marginBottom: 18,
              padding: 14,
              border: '1px solid var(--border, #333)',
              borderRadius: 8,
              background: 'var(--card-muted, transparent)',
            }}
          >
            <h4 style={{ marginTop: 0, marginBottom: 8 }}>Research one cell</h4>
            <p className="sub" style={{ marginTop: 0, fontSize: 12.5 }}>
              Select a keyword and a geography (click a table row or use the dropdowns). Cost: up to
              4 SERPs · ~$0.008 live · $0 in fixture mode.
            </p>

            <div
              className="flex"
              style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}
            >
              <label style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="sub" style={{ fontSize: 12 }}>
                  Keyword
                </span>
                <input
                  type="search"
                  placeholder="Filter keywords…"
                  value={kwFilter}
                  onChange={(e) => setKwFilter(e.target.value)}
                  style={{ fontSize: 12, marginBottom: 4 }}
                />
                <select
                  value={kwId === '' ? '' : String(kwId)}
                  onChange={(e) => setKwId(e.target.value ? Number(e.target.value) : '')}
                  style={{ fontSize: 13, minHeight: 34 }}
                >
                  <option value="">— pick keyword —</option>
                  {filteredKeywords.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.keyword}
                      {k.avgMonthlySearches != null ? ` · vol ${k.avgMonthlySearches}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="sub" style={{ fontSize: 12 }}>
                  Geography
                </span>
                <input
                  type="search"
                  placeholder="Filter markets…"
                  value={geoFilter}
                  onChange={(e) => setGeoFilter(e.target.value)}
                  style={{ fontSize: 12, marginBottom: 4 }}
                />
                <select
                  value={geoId === '' ? '' : String(geoId)}
                  onChange={(e) => setGeoId(e.target.value ? Number(e.target.value) : '')}
                  style={{ fontSize: 13, minHeight: 34 }}
                >
                  <option value="">— pick market —</option>
                  {filteredGeos.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.market}
                      {g.stateAbbr ? `, ${g.stateAbbr}` : ''}
                      {g.selectedRank != null ? ` · #${g.selectedRank}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="primary"
                disabled={!canRun}
                onClick={runCell}
                style={{ minHeight: 34 }}
              >
                {pending ? 'Queuing…' : 'Run local SERP research'}
              </button>
            </div>

            {(selectedKw || selectedGeo) && (
              <p className="sub mono" style={{ fontSize: 12, margin: '0 0 8px' }}>
                Selected:{' '}
                <strong>{selectedKw?.keyword ?? '…'}</strong>
                {' × '}
                <strong>
                  {selectedGeo
                    ? `${selectedGeo.market}${selectedGeo.stateAbbr ? ', ' + selectedGeo.stateAbbr : ''}`
                    : '…'}
                </strong>
              </p>
            )}

            {cellMsg && (
              <div className={cellMsg.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 8, fontSize: 13 }}>
                {cellMsg.error ?? cellMsg.detail}
              </div>
            )}

            {metrics && metrics.metrics.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h4 style={{ marginBottom: 6 }}>Latest metrics for this cell</h4>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Device</th>
                        <th>Keyword</th>
                        <th className="num">1st org abs</th>
                        <th className="num">Ads↑</th>
                        <th className="num">Local↑</th>
                        <th className="num">Organic</th>
                        <th className="num">Paid</th>
                        <th className="num">Reddit</th>
                        <th>Measured</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.metrics.map((m) => (
                        <tr key={m.device + m.keyword}>
                          <td>
                            <span className="badge">{m.device}</span>
                          </td>
                          <td className="mono" style={{ fontSize: 11.5 }}>
                            {m.keyword}
                          </td>
                          <td className="num">{m.firstOrganicRankAbsolute ?? '—'}</td>
                          <td className="num">{m.adsAboveOrganicCount}</td>
                          <td className="num">{m.localProfilesAboveOrganicCount}</td>
                          <td className="num">{m.organicCount}</td>
                          <td className="num">{m.paidCount}</td>
                          <td className="num">{m.redditHitCount}</td>
                          <td className="mono faint" style={{ fontSize: 11 }}>
                            {m.measuredAt.slice(0, 16).replace('T', ' ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {metrics.metrics.some((m) => m.relatedSearches && m.relatedSearches.length > 0) && (
                  <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
                    <strong>Related (not auto-researched):</strong>{' '}
                    {(
                      metrics.metrics.find((m) => m.relatedSearches?.length)?.relatedSearches ?? []
                    )
                      .slice(0, 8)
                      .join(' · ')}
                  </p>
                )}
              </div>
            )}
            {metrics && metrics.ok && metrics.metrics.length === 0 && selectedKw && selectedGeo && (
              <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
                No metrics yet for this pair. Run research, wait for the worker/cron, then re-select
                the cell or reload.
              </p>
            )}
          </div>

          <div className="flex" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 280px' }}>
              <h4 style={{ marginBottom: 6 }}>
                Keywords {kwFilter ? `(${filteredKeywords.length})` : ''}
              </h4>
              <p className="sub" style={{ fontSize: 11.5, marginTop: 0 }}>
                Click a row to select.
              </p>
              <div className="table-scroll" style={{ maxHeight: 280, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th className="num">Vol</th>
                      <th>Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredKeywords.slice(0, 100).map((k) => (
                      <tr
                        key={k.id}
                        onClick={() => setKwId(k.id)}
                        style={{
                          cursor: 'pointer',
                          background:
                            kwId === k.id ? 'var(--row-selected, rgba(80,140,255,0.15))' : undefined,
                        }}
                      >
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {k.keyword}
                        </td>
                        <td className="num">{k.avgMonthlySearches ?? '—'}</td>
                        <td style={{ fontSize: 11 }}>
                          {k.nicheId ? (
                            <span className="badge go">niche</span>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ flex: '1 1 280px' }}>
              <h4 style={{ marginBottom: 6 }}>
                Geos {geoFilter ? `(${filteredGeos.length})` : ''}
              </h4>
              <p className="sub" style={{ fontSize: 11.5, marginTop: 0 }}>
                Click a row to select.
              </p>
              <div className="table-scroll" style={{ maxHeight: 280, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th className="num">Rank</th>
                      <th className="num">Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGeos.slice(0, 100).map((g) => (
                      <tr
                        key={g.id}
                        onClick={() => setGeoId(g.id)}
                        style={{
                          cursor: 'pointer',
                          background:
                            geoId === g.id
                              ? 'var(--row-selected, rgba(80,140,255,0.15))'
                              : undefined,
                        }}
                      >
                        <td style={{ fontSize: 11.5 }}>
                          {g.market}
                          {g.stateAbbr ? `, ${g.stateAbbr}` : ''}
                        </td>
                        <td className="num">{g.selectedRank ?? '—'}</td>
                        <td className="num mono" style={{ fontSize: 11 }}>
                          {g.dataforseoLocationCode ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {recentRuns.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <h4 style={{ marginBottom: 6 }}>Recent catalog runs</h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Label</th>
                      <th>Status</th>
                      <th className="num">Jobs</th>
                      <th className="num">Hits</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">#{r.id}</td>
                        <td style={{ fontSize: 12, maxWidth: 280 }}>
                          {r.label ?? '—'}
                          {r.error && (
                            <div className="disabled-reason" style={{ fontSize: 11, marginTop: 3 }}>
                              {r.error.slice(0, 180)}
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            className={
                              r.status === 'done'
                                ? 'badge go'
                                : r.status === 'failed' || r.status === 'budget_exceeded'
                                  ? 'badge stop'
                                  : r.status === 'running' || r.status === 'pending'
                                    ? 'badge warn'
                                    : 'badge'
                            }
                          >
                            {r.status}
                          </span>
                          {r.usedFixtures ? (
                            <span className="badge warn" style={{ marginLeft: 4 }}>
                              fixture
                            </span>
                          ) : null}
                        </td>
                        <td className="num" title={`${r.jobsDone} done · ${r.jobsFailed} failed`}>
                          {r.jobsDone}/{r.jobCount}
                          {r.jobsFailed > 0 ? (
                            <span className="faint"> · {r.jobsFailed} fail</span>
                          ) : null}
                        </td>
                        <td className="num">{r.hitCount}</td>
                        <td className="mono faint" style={{ fontSize: 11 }}>
                          {r.createdAt.slice(0, 16).replace('T', ' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: 20, borderTop: '1px solid var(--border, #333)', paddingTop: 14 }}>
            <h4 style={{ marginTop: 0 }}>Bulk research</h4>
            {!bulkEnabled ? (
              <p className="sub" style={{ fontSize: 12.5 }}>
                Bulk grid is gated by <code>RESEARCH_BULK_ENABLED</code> (default off). Use{' '}
                <strong>Research one cell</strong> above for one keyword × one geo. Defaults when
                enabled: top 50 × top 50 × desktop+mobile → 5,000 jobs / $10.00 hard cap.
              </p>
            ) : (
              <>
                <p className="sub" style={{ fontSize: 12.5, marginTop: 0 }}>
                  Default grid: top 50 keywords by volume × top 50 geos by rank × desktop + mobile
                  (near_me off). Hard cap 5,000 jobs / $10.00. Auto-truncates if selection is larger.
                </p>
                <div className="flex" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={pending}
                    onClick={() => {
                      const fd = new FormData()
                      fd.set('dryRun', 'true')
                      startTransition(async () => {
                        const res = await catalogBulkResearchAction(fd)
                        setPreview(res)
                        setConfirmMsg(null)
                        if (res.defaultBudgetCapCents != null) {
                          setBudgetCents(res.defaultBudgetCapCents)
                        }
                      })
                    }}
                  >
                    {pending ? '…' : 'Dry-run preview'}
                  </button>
                  <label className="sub" style={{ fontSize: 12 }}>
                    Budget cap (¢){' '}
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={budgetCents}
                      onChange={(e) => setBudgetCents(Number(e.target.value) || 0)}
                      style={{ width: 90, marginLeft: 4 }}
                    />
                  </label>
                </div>

                {preview && (
                  <div
                    className={preview.ok ? 'okbox' : 'stopbox'}
                    style={{ marginTop: 12, fontSize: 13 }}
                  >
                    {preview.error ?? preview.detail}
                    {preview.ok && preview.previewOnly && (
                      <div style={{ marginTop: 10 }}>
                        {preview.requiresWorker && (
                          <label
                            style={{
                              display: 'flex',
                              gap: 8,
                              alignItems: 'center',
                              marginBottom: 8,
                              fontSize: 12.5,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={workerAck}
                              onChange={(e) => setWorkerAck(e.target.checked)}
                            />
                            Worker is running (<code>pnpm worker</code>) — required for live runs
                            &gt; 50 jobs
                          </label>
                        )}
                        <button
                          type="button"
                          className="primary"
                          disabled={pending || (preview.requiresWorker && !workerAck)}
                          onClick={() => {
                            const fd = new FormData()
                            fd.set('dryRun', 'false')
                            fd.set('budgetCapCents', String(budgetCents))
                            if (workerAck) fd.set('workerAck', 'true')
                            startTransition(async () => {
                              const res = await catalogBulkResearchAction(fd)
                              setConfirmMsg(res)
                              if (res.ok) setPreview(null)
                            })
                          }}
                        >
                          Confirm bulk research
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {confirmMsg && (
                  <div
                    className={confirmMsg.ok ? 'okbox' : 'stopbox'}
                    style={{ marginTop: 10, fontSize: 13 }}
                  >
                    {confirmMsg.error ?? confirmMsg.detail}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
