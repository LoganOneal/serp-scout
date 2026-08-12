'use client'

import { useMemo, useState, useTransition, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteDiscoveryRunAction,
  deleteOpportunityCellAction,
  deleteOpportunityCellsBulkAction,
  opportunityDeepDiveAction,
  type CatalogResearchResult,
} from '@/app/portfolio/actions'
import { ResearchWizard } from '@/components/research/ResearchWizard'
import type { PickerOption } from '@/components/LocalityPicker'
import type { NicheOption } from '@/components/research/ResearchWizard'
import { VolumeSourceLink } from '@/components/VolumeSourceLink'
import { OpenLocalSerpLinks } from '@/components/OpenLocalSerpLinks'
import { DiscoveryRunStatus } from '@/components/DiscoveryRunStatus'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'

export interface ScreenGeo {
  id: number
  market: string
  stateAbbr: string | null
  selectedRank: number | null
  population2025: number | null
  dataforseoLocationCode: number | null
}

export type NicheEconomicsRow = {
  id: number
  slug: string
  label: string
  keywordNoun: string
  category: string
  avgTicketMicros: number | null
  leadCommissionRateBps: number | null
  leadValueMicros: number | null
  economicsSource: string | null
  gadsAvgMonthlySearches: number | null
  gadsCompetitionIndex: number | null
  gadsCompetition: string | null
  gadsTopOfPageBidHighMicros: number | null
  compositeScore: number | null
  adsFitScore: number | null
  redditPriorityScore: number | null
  scoreReasons: string[]
}

export type OpportunityFunnelProps = {
  /** Purchasable research geos (markets). */
  geoTotal: number
  geos: ScreenGeo[]
  defaultGeoIds: number[]
  /** Ranked niches with GAds + ticket priors — primary Screen selection. */
  nicheEconomics: NicheEconomicsRow[]
  deepDiveRuns: Array<{
    id: number
    status: string
    jobCount: number
    jobsDone: number
    jobsFailed: number
    jobsSkipped?: number
    hitCount: number
    label: string | null
    error: string | null
    createdAt: string
    usedFixtures?: boolean
    spendMicros?: string | null
    estimatedCostMicros?: string | null
  }>
  searchLocalities: (q: string) => Promise<PickerOption[]>
  niches: NicheOption[]
  live: boolean
}

/** /serp/google/organic/live/advanced — $0.002 per call. */
const UNIT = 0.002
/**
 * /keywords_data/google_ads/search_volume/live — $0.09 PER REQUEST.
 *
 * Batched to one request per MARKET (up to 1000 keywords each), so this scales
 * with markets, not with markets x keywords. Cached across runs, so a repeat
 * over the same markets pays nothing — this is the cold-cache ceiling.
 */
/**
 * Free. Volume comes from Google Ads, which we already hold credentials for;
 * the $0.09-per-request DataForSEO endpoint was removed by policy. Kept as a
 * named constant so the toggle's price stays honest if that ever changes.
 */
const VOLUME_UNIT = 0
/** /serp/google/maps/live/advanced — once per (niche, location). */
const MAPS_UNIT = 0.002

function estCost(
  kw: number,
  geo: number,
  devices: number,
  niches = 0,
  extras: { volume: boolean; maps: boolean } = { volume: false, maps: false },
): { jobs: number; usd: number; serpUsd: number; volumeUsd: number } {
  const jobs = kw * geo * devices
  const serpUsd = jobs * UNIT
  // One batched volume request per market, not per keyword x market.
  const volumeUsd = extras.volume ? geo * VOLUME_UNIT : 0
  const mapsUsd = extras.maps ? niches * geo * MAPS_UNIT : 0
  return { jobs, usd: serpUsd + volumeUsd + mapsUsd, serpUsd, volumeUsd }
}

function formatVol(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function formatPop(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

function formatUsdMicros(n: number | null): string {
  if (n == null) return '—'
  const usd = n / 1_000_000
  if (usd >= 1000) return `$${Math.round(usd / 100) / 10}k`
  return `$${Math.round(usd)}`
}

/** Header checkbox: checked / unchecked / indeterminate from selection vs visible ids */
function SelectAllCheckbox({
  visibleIds,
  selected,
  onChange,
  label,
}: {
  visibleIds: number[]
  selected: Set<number>
  onChange: (checked: boolean) => void
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const selectedVisible = visibleIds.filter((id) => selected.has(id)).length
  const all = visibleIds.length > 0 && selectedVisible === visibleIds.length
  const some = selectedVisible > 0 && !all

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some
  }, [some])

  return (
    <label className="screen-select-all" title={label}>
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        disabled={visibleIds.length === 0}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  )
}

/**
 * Research funnel: Screen (niches × markets) → Market sweep (SERPs + DataForSEO local volume).
 * A niche expands to ~KW_PER_NICHE buy-intent keywords at enqueue time — not keyword×market pick.
 */
const KW_PER_NICHE = 8

export function OpportunityFunnel(props: OpportunityFunnelProps) {
  const router = useRouter()
  const [step, setStep] = useState<2 | 3>(2)
  const nicheList = props.nicheEconomics
  const defaultNicheIds = useMemo(
    () => new Set(nicheList.slice(0, 10).map((n) => n.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nicheList.length],
  )
  const [nicheIds, setNicheIds] = useState<Set<number>>(() => defaultNicheIds)
  const [geoIds, setGeoIds] = useState<Set<number>>(
    () => new Set(props.defaultGeoIds.slice(0, 20)),
  )
  const [devices, setDevices] = useState<'desktop' | 'both'>('both')
  /**
   * Keywords bought per niche. THE cost dial.
   *
   * A niche is not one query — it expands to service-intent variants ("roofing",
   * "roofing cost", "emergency roofing", "roofing contractor"…), and each one is
   * a SERP call per market per device. At the old hardcoded 8 a 50x50 screen was
   * 20,000 calls ($40); at 1 it is 2,500 ($5). Wide screens want the head term
   * only — you sweep the winners afterwards.
   */
  const [kwPerNiche, setKwPerNiche] = useState<number>(KW_PER_NICHE)
  /**
   * Paid extras, OFF by default — see discoveryRuns in schema.ts. On a wide
   * screen they cost more than the SERPs they annotate, and neither earns that
   * while you are still filtering. Turn them on for the shortlist.
   */
  // On by default: free, and three other columns are blank without it.
  const [fetchVolume, setFetchVolume] = useState(true)
  const [useQueuedSerp, setUseQueuedSerp] = useState(false)
  const [fetchMaps, setFetchMaps] = useState(false)
  const [includeGeoExplicit, setIncludeGeoExplicit] = useState(false)
  const [workerAck, setWorkerAck] = useState(false)
  const [pending, startTransition] = useTransition()
  const [preview, setPreview] = useState<CatalogResearchResult | null>(null)
  const [msg, setMsg] = useState<CatalogResearchResult | null>(null)
  const [nicheFilter, setNicheFilter] = useState('')
  const [geoFilter, setGeoFilter] = useState('')
  const [singleMarketOpen, setSingleMarketOpen] = useState(false)

  const deviceN = devices === 'both' ? 2 : 1
  /**
   * Estimated SERPs = niches × keywords/niche × markets × devices.
   *
   * The geo-explicit variant buys a second SERP per keyword, so it enters here
   * as a keyword multiplier rather than a separate line — the estimate has to
   * move when the toggle does, or the operator agrees to a number that is half
   * the real one.
   */
  const localEst = useMemo(
    () =>
      estCost(
        nicheIds.size * kwPerNiche * (includeGeoExplicit ? 2 : 1),
        geoIds.size,
        deviceN,
        nicheIds.size,
        { volume: fetchVolume, maps: fetchMaps },
      ),
    [nicheIds.size, geoIds.size, deviceN, kwPerNiche, fetchVolume, fetchMaps, includeGeoExplicit],
  )

  const filteredNiches = useMemo(() => {
    const q = nicheFilter.trim().toLowerCase()
    if (!q) return nicheList
    return nicheList.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.keywordNoun.toLowerCase().includes(q) ||
        n.category.toLowerCase().includes(q),
    )
  }, [nicheList, nicheFilter])

  const filteredGeos = useMemo(() => {
    const q = geoFilter.trim().toLowerCase()
    if (!q) return props.geos
    return props.geos.filter(
      (g) =>
        g.market.toLowerCase().includes(q) ||
        (g.stateAbbr?.toLowerCase().includes(q) ?? false),
    )
  }, [props.geos, geoFilter])

  const filteredGeoIds = useMemo(() => filteredGeos.map((g) => g.id), [filteredGeos])

  const toggleNiche = useCallback((id: number) => {
    setNicheIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    setPreview(null)
  }, [])

  const toggleGeo = useCallback((id: number) => {
    setGeoIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    setPreview(null)
  }, [])

  const setVisibleGeo = (checked: boolean) => {
    setGeoIds((prev) => {
      const n = new Set(prev)
      for (const id of filteredGeoIds) {
        if (checked) n.add(id)
        else n.delete(id)
      }
      return n
    })
    setPreview(null)
  }

  const selectTopNiches = (n: number) => {
    setNicheIds(new Set(nicheList.slice(0, n).map((x) => x.id)))
    setPreview(null)
  }
  const selectAllNiches = () => {
    setNicheIds(new Set(nicheList.map((x) => x.id)))
    setPreview(null)
  }
  const deselectAllNiches = () => {
    setNicheIds(new Set())
    setPreview(null)
  }
  const selectTopGeo = (n: number) => {
    setGeoIds(new Set(props.geos.slice(0, n).map((g) => g.id)))
    setPreview(null)
  }
  const selectAllGeo = () => {
    setGeoIds(new Set(props.geos.map((g) => g.id)))
    setPreview(null)
  }
  const deselectAllGeo = () => {
    setGeoIds(new Set())
    setPreview(null)
  }

  const buildDeepDiveFd = (dryRun: boolean) => {
    const fd = new FormData()
    fd.set('dryRun', dryRun ? 'true' : 'false')
    fd.set('nicheIds', [...nicheIds].join(','))
    fd.set('geoIds', [...geoIds].join(','))
    fd.set('devices', devices === 'both' ? 'both' : 'desktop')
    fd.set('maxKeywordsPerNiche', String(kwPerNiche))
    fd.set('fetchVolume', fetchVolume ? 'true' : 'false')
    fd.set('useQueuedSerp', useQueuedSerp ? 'true' : 'false')
    fd.set('fetchMaps', fetchMaps ? 'true' : 'false')
    fd.set('includeGeoExplicit', includeGeoExplicit ? 'true' : 'false')
    return fd
  }

  const runPreview = () => {
    const fd = buildDeepDiveFd(true)
    startTransition(async () => {
      setMsg(null)
      setPreview(await opportunityDeepDiveAction(fd))
    })
  }

  const runConfirm = () => {
    const fd = buildDeepDiveFd(false)
    if (workerAck) fd.set('workerAck', 'true')
    if (preview?.defaultBudgetCapCents != null) {
      fd.set('budgetCapCents', String(preview.defaultBudgetCapCents))
    }
    startTransition(async () => {
      const res = await opportunityDeepDiveAction(fd)
      setMsg(res)
      if (res.ok) {
        setStep(3)
        router.refresh()
        window.setTimeout(() => router.refresh(), 1200)
      }
    })
  }

  const canRun = nicheIds.size > 0 && geoIds.size > 0
  const needsAck = localEst.jobs > 50 && props.live
  const jobsActive = props.deepDiveRuns.some(
    (r) => r.status === 'pending' || r.status === 'running' || r.status === 'claimed',
  )
  // Auto-refresh on any tab while sweep jobs are draining.
  useAutoRefresh(jobsActive, 4000)


  const tabs = [
    {
      id: 2 as const,
      label: 'Screen',
      ready: nicheList.length > 0 && props.geoTotal > 0,
      badge: canRun
        ? `${nicheIds.size} × ${geoIds.size}`
        : nicheList.length > 0
          ? `${nicheList.length}`
          : null,
    },
    {
      id: 3 as const,
      label: 'Market sweep',
      ready: props.deepDiveRuns.length > 0,
      badge: jobsActive
        ? 'live'
        : props.deepDiveRuns.length > 0
          ? `${props.deepDiveRuns.length} run${props.deepDiveRuns.length === 1 ? '' : 's'}`
          : null,
    },
  ]

  return (
    <div className="opp-funnel opp-fill">
      <div className="opp-tabs-wrap">
        <div className="opp-tabs" role="tablist" aria-label="Research tabs">
          {tabs.map((t) => {
            const selected = step === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`opp-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`opp-panel-${t.id}`}
                tabIndex={selected ? 0 : -1}
                className={`opp-tab${selected ? ' is-active' : ''}${t.ready && !selected ? ' is-ready' : ''}`}
                onClick={() => setStep(t.id)}
              >
                <span className="opp-tab-label">{t.label}</span>
                {t.badge && <span className="opp-tab-badge">{t.badge}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div
        className="opp-tab-panel"
        role="tabpanel"
        id={`opp-panel-${step}`}
        aria-labelledby={`opp-tab-${step}`}
      >

      {jobsActive && step !== 3 && (
        <div
          className="job-live-banner"
          role="status"
          style={{ marginBottom: 14, cursor: 'pointer' }}
          onClick={() => setStep(3)}
        >
          <span className="job-spinner" aria-hidden />
          <div>
            <strong>Sweep jobs are running</strong>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              Auto-refreshing · click to open the Market sweep tab for progress.
            </div>
          </div>
        </div>
      )}

      {/* ── Screen: niches × markets (SEMrush Keyword Magic layout) ── */}
      {step === 2 && (
        <section className="opp-step">
          <header className="opp-step-head sm-magic-page-head">
            <div>
              <h2 className="opp-step-title">Niche × market screen</h2>
              <p className="opp-step-desc" style={{ marginBottom: 0 }}>
                Evaluate <strong>niches</strong> against <strong>markets</strong> — not raw keywords.
                Each niche expands to {kwPerNiche} buy-intent keyword{kwPerNiche === 1 ? '' : 's'} when you sweep.
              </p>
              <div className="sm-magic-meta">
                <span>
                  Database: <strong>United States</strong>
                </span>
                <span className="sm-magic-meta-sep">·</span>
                <span>
                  Niches: <strong>{nicheList.length}</strong>
                </span>
                <span className="sm-magic-meta-sep">·</span>
                <span>
                  Markets: <strong>{props.geoTotal}</strong>
                </span>
                <span className="sm-magic-meta-sep">·</span>
                <span>
                  Niche priors + GAds national · Market sweep volume = DataForSEO @ market location
                </span>
              </div>
            </div>
          </header>

          {nicheList.length === 0 && (
            <div className="stopbox" style={{ marginBottom: 14 }}>
              No niches seeded. Run <code>pnpm seed:niches</code> and{' '}
              <code>pnpm enrich:niche-gads</code>.
            </div>
          )}

          {/* SEMrush-style: Topics (niches) | Markets table */}
          <div className="sm-magic">
            <aside className="sm-magic-topics" aria-label="Niches">
              <div className="sm-magic-topics-head">
                <div className="sm-magic-topics-tabs">
                  <span className="sm-magic-topics-tab is-active">
                    Topics
                    <span className="sm-badge-new">niches</span>
                  </span>
                </div>
                <span className="sm-count">
                  {nicheIds.size}/{nicheList.length}
                </span>
              </div>
              <input
                type="search"
                className="sm-filter-input sm-magic-search"
                placeholder="Filter niches…"
                value={nicheFilter}
                onChange={(e) => setNicheFilter(e.target.value)}
                aria-label="Filter niches"
              />
              <div className="sm-magic-topics-actions">
                <div className="seg">
                  <button type="button" onClick={() => selectTopNiches(5)}>
                    Top 5
                  </button>
                  <button type="button" onClick={() => selectTopNiches(10)}>
                    Top 10
                  </button>
                  <button type="button" onClick={selectAllNiches}>
                    All
                  </button>
                  <button type="button" onClick={deselectAllNiches}>
                    None
                  </button>
                </div>
              </div>
              <div className="sm-topic-cols">
                <span>Niche</span>
                <span className="num">Score</span>
              </div>
              <button
                type="button"
                className={`sm-topic-row sm-topic-all${
                  nicheIds.size === nicheList.length && nicheList.length > 0 ? ' is-active' : ''
                }`}
                onClick={() => {
                  if (nicheIds.size === nicheList.length) deselectAllNiches()
                  else selectAllNiches()
                }}
              >
                <span className="sm-topic-name">All niches</span>
                <span className="sm-topic-count">{nicheList.length}</span>
              </button>
              <div className="sm-topic-list">
                {filteredNiches.map((n) => {
                  const on = nicheIds.has(n.id)
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`sm-topic-row${on ? ' is-selected' : ''}`}
                      onClick={() => toggleNiche(n.id)}
                      title={n.scoreReasons?.slice(0, 3).join(' · ') || n.category}
                    >
                      <input type="checkbox" checked={on} readOnly tabIndex={-1} aria-hidden />
                      <span className="sm-topic-name">
                        {n.label}
                        <span className="sm-topic-meta">
                          {formatVol(n.gadsAvgMonthlySearches)} vol
                          {n.gadsCompetitionIndex != null
                            ? ` · comp ${n.gadsCompetitionIndex}`
                            : ''}
                          {' · '}
                          {formatUsdMicros(n.leadValueMicros)} lead
                        </span>
                      </span>
                      <span className="sm-topic-count sm-score">{n.compositeScore ?? '—'}</span>
                    </button>
                  )
                })}
                {filteredNiches.length === 0 && (
                  <div className="empty" style={{ padding: 16, fontSize: 12 }}>
                    No niches match “{nicheFilter}”.
                  </div>
                )}
              </div>
            </aside>

            <div className="sm-magic-main sm-panel">
              {/* Summary strip — mirrors SEMrush “All keywords / Total volume” */}
              <div className="sm-magic-summary">
                <div className="sm-magic-summary-stats">
                  <span>
                    Selected niches: <strong>{nicheIds.size}</strong>
                  </span>
                  <span className="sm-magic-meta-sep">·</span>
                  <span>
                    Keywords/niche: <strong>{kwPerNiche}</strong>
                  </span>
                  <span className="sm-magic-meta-sep">·</span>
                  <span>
                    Selected markets: <strong>{geoIds.size}</strong>
                    <span className="faint"> / {props.geos.length}</span>
                  </span>
                  <span className="sm-magic-meta-sep">·</span>
                  <span>
                    Est. SERPs:{' '}
                    <strong className="sm-score">{localEst.jobs.toLocaleString()}</strong>
                  </span>
                  <span className="sm-magic-meta-sep">·</span>
                  <span className={props.live ? '' : 'faint'}>
                    {props.live ? `$${localEst.usd.toFixed(2)}` : '$0 fixtures'}
                  </span>
                </div>
                <div className="sm-magic-summary-actions">
                  <label
                    className="screen-device-label sm-device-inline"
                    title="Each niche expands to this many service-intent queries. Every query is a SERP call per market per device — this multiplies the whole run."
                  >
                    Keywords / niche
                    <select
                      value={kwPerNiche}
                      onChange={(e) => {
                        setKwPerNiche(Number(e.target.value))
                        setPreview(null)
                      }}
                    >
                      <option value={1}>1 · head term (widest screen)</option>
                      <option value={3}>3 · head + 2 variants</option>
                      <option value={8}>8 · full intent cluster</option>
                    </select>
                  </label>
                  <label className="screen-device-label sm-device-inline">
                    Devices
                    <select
                      value={devices}
                      onChange={(e) => {
                        setDevices(e.target.value as 'desktop' | 'both')
                        setPreview(null)
                      }}
                    >
                      <option value="desktop">Desktop</option>
                      <option value="both">Desktop + mobile</option>
                    </select>
                  </label>
                  <label
                    className="screen-extra-toggle"
                    title="Per-market search volume and competition from Google Ads. Free — this project already holds the credentials, and the paid DataForSEO route was removed. Leave it on: without it the Vol column, the Reddit-volume estimate and the 30-day winnability band are all blank. Markets Google Ads cannot resolve come back empty rather than being bought elsewhere."
                  >
                    <input
                      type="checkbox"
                      checked={fetchVolume}
                      onChange={(e) => {
                        setFetchVolume(e.target.checked)
                        setPreview(null)
                      }}
                    />
                    Local volume
                    <span className="faint"> free</span>
                  </label>
                  <label
                    className="screen-extra-toggle"
                    title="Google Maps pack depth and the domains competing in it — $0.002 per niche x market. Off by default: nothing scores off it, it fills one display column."
                  >
                    <input
                      type="checkbox"
                      checked={fetchMaps}
                      onChange={(e) => {
                        setFetchMaps(e.target.checked)
                        setPreview(null)
                      }}
                    />
                    Maps
                    <span className="faint">
                      {' '}
                      +${(nicheIds.size * geoIds.size * MAPS_UNIT).toFixed(2)}
                    </span>
                  </label>
                  <label
                    className="screen-extra-toggle"
                    title="Buy SERPs through DataForSEO's queue: $0.0006 each instead of $0.0020, a 70% saving. Results arrive in minutes rather than seconds, so the run finishes later — use it for big sweeps, not when you need an answer now."
                  >
                    <input
                      type="checkbox"
                      checked={useQueuedSerp}
                      onChange={(e) => {
                        setUseQueuedSerp(e.target.checked)
                        setPreview(null)
                      }}
                    />
                    Queued SERPs
                    <span className="faint"> −70%</span>
                  </label>
                  <label
                    className="screen-extra-toggle"
                    title={
                      'Also measure "<keyword> <city>" — e.g. "plumber new york city" — alongside the city-free keyword. ' +
                      'The two return different pages: the city-free keyword at a location code shows who holds the local slots, ' +
                      'while the typed-out string is where city-specific Reddit threads live. ' +
                      'Doubles the SERP count for this run.'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={includeGeoExplicit}
                      onChange={(e) => {
                        setIncludeGeoExplicit(e.target.checked)
                        setPreview(null)
                      }}
                    />
                    “kw + city”
                    <span className="faint"> ×2 SERPs</span>
                  </label>
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={pending || !canRun}
                    onClick={runPreview}
                  >
                    {pending ? '…' : 'Dry-run'}
                  </button>
                  <button
                    type="button"
                    className="primary sm-send-btn"
                    disabled={pending || !canRun || (needsAck && !workerAck)}
                    onClick={runConfirm}
                  >
                    {pending ? 'Queuing…' : 'Start sweep'}
                  </button>
                </div>
              </div>

              <div className="sm-toolbar">
                <div className="sm-toolbar-title">
                  Markets
                  <span className="sm-count">
                    {geoIds.size} selected
                  </span>
                </div>
                <div className="sm-toolbar-actions">
                  <input
                    type="search"
                    className="sm-filter-input"
                    placeholder="Filter markets…"
                    value={geoFilter}
                    onChange={(e) => setGeoFilter(e.target.value)}
                    aria-label="Filter markets"
                  />
                  <div className="seg">
                    <button type="button" onClick={() => selectTopGeo(20)}>
                      Top 20
                    </button>
                    <button type="button" onClick={() => selectTopGeo(50)}>
                      Top 50
                    </button>
                    <button type="button" onClick={selectAllGeo}>
                      All
                    </button>
                    <button type="button" onClick={deselectAllGeo}>
                      None
                    </button>
                  </div>
                </div>
              </div>

              <div className="sm-bulkbar">
                <div className="sm-bulkbar-left">
                  <SelectAllCheckbox
                    visibleIds={filteredGeoIds}
                    selected={geoIds}
                    onChange={setVisibleGeo}
                    label="Select all visible markets"
                  />
                  <span className="faint" style={{ fontSize: 12 }}>
                    {filteredGeos.length === props.geos.length
                      ? `${props.geos.length} markets`
                      : `${filteredGeos.length} of ${props.geos.length} markets`}
                    {geoIds.size > 0 && (
                      <>
                        {' '}
                        · <strong>{geoIds.size}</strong> selected
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => {
                      selectTopNiches(5)
                      selectTopGeo(20)
                    }}
                  >
                    Top 5 niches × 20 mkts
                  </button>
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => {
                      selectTopNiches(10)
                      selectTopGeo(50)
                    }}
                  >
                    Top 10 × Top 50
                  </button>
                </div>
              </div>

              <div className="table-scroll sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th className="sm-check-col">
                        <SelectAllCheckbox
                          visibleIds={filteredGeoIds}
                          selected={geoIds}
                          onChange={setVisibleGeo}
                          label="Select all visible markets"
                        />
                      </th>
                      <th>Market</th>
                      <th className="num">Rank</th>
                      <th className="num">Population</th>
                      <th className="num">Location code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGeos.map((g) => {
                      const on = geoIds.has(g.id)
                      return (
                        <tr
                          key={g.id}
                          className={on ? 'row-selected' : undefined}
                          onClick={() => toggleGeo(g.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="sm-check-col" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleGeo(g.id)}
                              aria-label={`Select ${g.market}`}
                            />
                          </td>
                          <td className="sm-kw-cell">
                            <span className="sm-kw-text">
                              {g.market}
                              {g.stateAbbr ? (
                                <span className="faint">, {g.stateAbbr}</span>
                              ) : null}
                            </span>
                          </td>
                          <td className="num">{g.selectedRank ?? '—'}</td>
                          <td className="num">{formatPop(g.population2025)}</td>
                          <td className="num mono faint" style={{ fontSize: 11 }}>
                            {g.dataforseoLocationCode ?? '—'}
                          </td>
                        </tr>
                      )
                    })}
                    {filteredGeos.length === 0 && (
                      <tr>
                        <td colSpan={5} className="empty" style={{ padding: 24 }}>
                          No markets match “{geoFilter}”.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Secondary actions live below the grid, capped so the table keeps the page. */}
          <div className="screen-footer">
          {/* Run / ack footer */}
          <div className="screen-run card">
            <div className="screen-run-summary">
              <strong>
                Market sweep · {nicheIds.size} niche{nicheIds.size === 1 ? '' : 's'} × {kwPerNiche}{' '}
                keywords × {geoIds.size} market{geoIds.size === 1 ? '' : 's'}
                {deviceN > 1 ? ` × ${deviceN} devices` : ''} = {localEst.jobs.toLocaleString()} SERPs
              </strong>
              <span className="sub">
                Keywords are generated from each niche&apos;s service-intent cluster at enqueue —
                you pick niches and markets only. Est.{' '}
                {props.live ? `$${localEst.usd.toFixed(2)}` : '$0 fixtures'} · hard cap 5,000 jobs
                ($10). SERPs use each market&apos;s geo location code.
              </span>
            </div>

            {needsAck && (
              <label className="screen-ack">
                <input
                  type="checkbox"
                  checked={workerAck}
                  onChange={(e) => setWorkerAck(e.target.checked)}
                />
                I understand this large run drains via cron over many minutes
              </label>
            )}

            <div className="screen-run-actions">
              <button
                type="button"
                className="btn"
                disabled={pending || !canRun}
                onClick={runPreview}
              >
                {pending ? '…' : 'Dry-run preview'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={pending || !canRun || (needsAck && !workerAck)}
                onClick={runConfirm}
              >
                {pending ? 'Queuing…' : 'Start sweep'}
              </button>
              <button type="button" className="btn" onClick={() => setStep(3)}>
                Market sweep tab →
              </button>
            </div>

            {!canRun && (
              <p className="disabled-reason" style={{ marginBottom: 0 }}>
                Select at least one niche and one market to run.
              </p>
            )}

            {preview && (
              <div className={preview.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 12 }}>
                {preview.error ?? preview.detail}
              </div>
            )}
            {msg && (
              <div className={msg.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 12 }}>
                {msg.error ?? msg.detail}
                {msg.ok && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn tiny" onClick={() => setStep(3)}>
                      Watch progress on Market sweep tab →
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="screen-single">
            <button
              type="button"
              className="screen-single-toggle"
              onClick={() => setSingleMarketOpen((v) => !v)}
              aria-expanded={singleMarketOpen}
            >
              <span>{singleMarketOpen ? '▾' : '▸'}</span>
              Deepen one market (full service cluster)
              <span className="faint" style={{ fontWeight: 400, marginLeft: 6 }}>
                ~24 buy-intent keywords × devices · ~$0.10
              </span>
            </button>
            {singleMarketOpen && (
              <div className="screen-single-body">
                <p className="sub" style={{ fontSize: 12.5, marginTop: 0 }}>
                  After you find winners on the grid, expand one locality into a full buy-intent
                  keyword cluster.
                </p>
                <ResearchWizard searchLocalities={props.searchLocalities} niches={props.niches} />
              </div>
            )}
          </div>
          </div>
        </section>
      )}

      {/* ── Step 3: Market sweep results ────────────────────────────────── */}
      {step === 3 && (
        <section className="opp-step">
          <header className="opp-step-head">
            <div className="opp-step-head-row">
              <div>
                <h2 className="opp-step-title">Market sweep</h2>
                <p className="opp-step-desc">
                  Job progress is live while work is queued. The grid below fills as SERPs finish
                  (auto-refresh). <strong>Live SERP</strong> opens Google with a local{' '}
                  <code>uule</code> so you can verify what a person in that market would see
                  (desktop / mobile). Prefer a private window. Volume is DataForSEO local search
                  volume for the exact query @ market location_code.
                </p>
              </div>
              <div className="opp-step-actions" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => router.refresh()}
                  disabled={pending}
                >
                  {jobsActive ? 'Refreshing…' : 'Refresh now'}
                </button>
                <button type="button" className="btn" onClick={() => setStep(2)}>
                  ← Screen tab
                </button>
              </div>
            </div>
          </header>

          <DiscoveryRunStatus
            runs={props.deepDiveRuns}
            title="Sweep runs"
            emptyHint="No sweep runs yet. Use the Screen tab to pick niches × markets and start one."
            autoRefresh={false}
            onDeleteRun={deleteDiscoveryRunAction}
            runHref={(id) => `/scout/runs/${id}`}
          />

          {pending && (
            <div className="job-live-banner" role="status" style={{ marginBottom: 16 }}>
              <span className="job-spinner" aria-hidden />
              <div>
                <strong>Queuing sweep…</strong>
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                  Creating SERP jobs. Status cards update when the run appears.
                </div>
              </div>
            </div>
          )}

          {/* Per-run drill-down: the flat all-runs grid moved to /research/runs/[id]. */}

          <div className="opp-step-actions">
            <button type="button" className="btn" onClick={() => setStep(2)}>
              ← Screen tab
            </button>
            <button type="button" className="btn" onClick={() => router.refresh()}>
              Refresh results
            </button>
            <a href="/pipeline" className="btn primary">
              Go to Pipeline
            </a>
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
