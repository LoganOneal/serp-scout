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
import { ScanRunList, type ScanRunRow } from '@/components/research/ScanRunList'
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
  /**
   * Locality scans. They live under this step, beside the sweep runs, because
   * a scan IS a run -- listing them above the flow on the research page put a
   * history table between the operator and the thing they came to do.
   */
  scanRuns: ScanRunRow[]
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

type FunnelStep = 'screen' | 'keywords' | 'sweep'

/**
 * Provider errors arrive as raw JSON and were rendered verbatim -- a card in
 * the keyword review showed `503: { "error": { "code": 503, "message": ... }`
 * with a googleapis type URL, which tells an operator nothing except that
 * something broke. Keep the sentence a human wrote; keep the code, because
 * "temporarily unavailable" and "bad credentials" need different responses.
 */
function tidyProviderNote(note: string): string {
  const code = note.match(/^(\d{3})\b/)?.[1]
  const message = note.match(/"message"\s*:\s*"([^"]+)"/)?.[1]
  if (message) return code ? `${message} (${code})` : message
  return note.length > 150 ? `${note.slice(0, 150)}…` : note
}

/** True when `picked` is exactly the first `n` of `ordered`. */
function isTopN<T extends { id: number }>(picked: Set<number>, ordered: T[], n: number): boolean {
  if (picked.size !== n || ordered.length < n) return false
  return ordered.slice(0, n).every((x) => picked.has(x.id))
}

export function OpportunityFunnel(props: OpportunityFunnelProps) {
  const router = useRouter()
  /**
   * Linear, and named rather than numbered.
   *
   * The flow used to be two tabs, "Screen" and "Market sweep", with the buy
   * button on the first one -- so the only description of what a run would
   * actually query arrived after it had been paid for. `keywords` sits
   * between them because that is where the decision belongs: the list is free
   * to compute and the SERPs are not.
   */
  const [step, setStep] = useState<FunnelStep>('screen')
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
  const [advancedOpen, setAdvancedOpen] = useState(false)

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

  /**
   * Price the run AND show its keyword list, then move to the review step.
   *
   * This is the same dry run the old "Dry-run" button fired -- Google Ads
   * discovery is free and already ran inside it. The only thing that changed
   * is that its answer is no longer thrown away.
   */
  const reviewKeywords = () => {
    const fd = buildDeepDiveFd(true)
    startTransition(async () => {
      setMsg(null)
      const res = await opportunityDeepDiveAction(fd)
      setPreview(res)
      if (res.ok) setStep('keywords')
    })
  }

  const keywordPreview = preview?.keywordPreview ?? []
  const previewKeywordCount = useMemo(
    () => keywordPreview.reduce((n, d) => n + d.keywords.length, 0),
    [keywordPreview],
  )
  /**
   * Niches whose list is a template guess with no measured demand behind any
   * of it. Not an error -- the run still works -- but it is the difference
   * between sweeping what people search and sweeping what a rule invented,
   * and it is invisible once the SERPs are bought.
   */
  /**
   * Niches are keyed by slug in the discovery payload; the UI has always shown
   * people "Kitchen Remodeling", not "kitchen-remodeling". Falls back to the
   * slug so a niche the picker does not know about still renders.
   */
  const nicheLabel = useCallback(
    (slug: string) => nicheList.find((n) => n.slug === slug)?.label ?? slug,
    [nicheList],
  )

  /**
   * Most demand first, and template fallbacks last -- the order you would read
   * them in to decide whether the list is worth buying.
   */
  const orderedKeywordPreview = useMemo(
    () =>
      [...keywordPreview].sort((a, b) => {
        const measured = (d: typeof a) => (d.source === 'google_ads' ? 1 : 0)
        const vol = (d: typeof a) => d.keywords.reduce((n, k) => n + (k.volume ?? 0), 0)
        return measured(b) - measured(a) || vol(b) - vol(a)
      }),
    [keywordPreview],
  )

  const sharedKeywords = Math.max(
    0,
    previewKeywordCount - (preview?.keywordCount ?? previewKeywordCount),
  )
  const unmeasuredNiches = useMemo(
    () =>
      keywordPreview.filter(
        (d) => d.source === 'template' && d.keywords.every((k) => k.volume == null),
      ),
    [keywordPreview],
  )

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
        setStep('sweep')
        router.refresh()
        window.setTimeout(() => router.refresh(), 1200)
      }
    })
  }

  /**
   * The run in one sentence.
   *
   * "The top 10 niches across the top 20 markets" when the selection is still
   * the ranked head, because that is what it is and saying "10 niches" hides
   * the ordering the tool did for you. Once you edit it by hand, it stops
   * claiming an order it no longer has.
   */
  const scopeSentence = useMemo(() => {
    if (nicheIds.size === 0 || geoIds.size === 0) return 'Pick niches and markets to sweep'
    /**
     * "The top N" is a property of the selection being a prefix of the ranking,
     * not of N matching some preset -- so picking Top 5 in the list reads as
     * "the top 5 niches", and unticking one from the middle stops claiming an
     * order the selection no longer has.
     */
    const nicheTop = isTopN(nicheIds, nicheList, nicheIds.size)
    const geoTop = isTopN(geoIds, props.geos, geoIds.size)
    const n = `${nicheTop ? 'the top ' : ''}${nicheIds.size} niche${nicheIds.size === 1 ? '' : 's'}`
    const g = `${geoTop ? 'the top ' : ''}${geoIds.size} market${geoIds.size === 1 ? '' : 's'}`
    return `Sweep ${n} across ${g}`
  }, [nicheIds, geoIds, nicheList, props.geos])

  /**
   * Every setting, said out loud, with anything off-default marked.
   *
   * The point of folding the dials away is that you stop reading six controls
   * on every visit. The point of this line is that folding them away must not
   * let one hide -- "kw + city" doubles the SERP count, and a doubled bill
   * should never be a surprise hidden behind a closed disclosure.
   */
  const advancedSummary = useMemo(
    () => [
      { label: devices === 'both' ? 'Desktop + mobile' : 'Desktop only', isDefault: devices === 'both' },
      { label: `${kwPerNiche} kw/niche`, isDefault: kwPerNiche === KW_PER_NICHE },
      { label: fetchVolume ? 'Local volume on' : 'No local volume', isDefault: fetchVolume },
      ...(fetchMaps ? [{ label: 'Maps on', isDefault: false }] : []),
      ...(useQueuedSerp ? [{ label: 'Queued SERPs', isDefault: false }] : []),
      ...(includeGeoExplicit ? [{ label: '“kw + city” — 2× SERPs', isDefault: false }] : []),
    ],
    [devices, kwPerNiche, fetchVolume, fetchMaps, useQueuedSerp, includeGeoExplicit],
  )

  const runsUnderTab = props.deepDiveRuns.length + props.scanRuns.length
  const canRun = nicheIds.size > 0 && geoIds.size > 0
  const needsAck = localEst.jobs > 50 && props.live
  const jobsActive = props.deepDiveRuns.some(
    (r) => r.status === 'pending' || r.status === 'running' || r.status === 'claimed',
  )
  // Auto-refresh on any tab while sweep jobs are draining.
  useAutoRefresh(jobsActive, 4000)


  const tabs: Array<{ id: FunnelStep; label: string; ready: boolean; badge: string | null }> = [
    {
      id: 'screen',
      label: '1 · Select',
      ready: nicheList.length > 0 && props.geoTotal > 0,
      badge: canRun
        ? `${nicheIds.size} × ${geoIds.size}`
        : nicheList.length > 0
          ? `${nicheList.length}`
          : null,
    },
    {
      id: 'keywords',
      label: '2 · Keywords',
      ready: keywordPreview.length > 0,
      // Deduped, so the badge matches the number the summary and cost use.
      badge: keywordPreview.length > 0 ? `${preview?.keywordCount ?? previewKeywordCount}` : null,
    },
    {
      id: 'sweep',
      label: '3 · Sweep',
      ready: runsUnderTab > 0,
      // Counts scans too: they are listed under this tab, so the badge must
      // describe what is behind it rather than only half of it.
      badge: jobsActive
        ? 'live'
        : runsUnderTab > 0
          ? `${runsUnderTab} run${runsUnderTab === 1 ? '' : 's'}`
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

      {jobsActive && step !== 'sweep' && (
        <div
          className="job-live-banner"
          role="status"
          style={{ marginBottom: 14, cursor: 'pointer' }}
          onClick={() => setStep('sweep')}
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
      {step === 'screen' && (
        <section className="opp-step">
          {nicheList.length === 0 && (
            <div className="stopbox" style={{ marginBottom: 14 }}>
              No niches seeded. Run <code>pnpm seed:niches</code> and{' '}
              <code>pnpm enrich:niche-gads</code>.
            </div>
          )}

          {/**
           * ==================== SAY IT, DO NOT ASK IT AGAIN ====================
           * This screen used to carry 344 controls, including three separate
           * mechanisms for expressing one selection: presets on each list, and
           * combined presets on top of them.
           *
           * The bar is not another one. It states what the lists below already
           * say -- what is selected, what it will cost -- and offers the single
           * action that follows from it. Selection happens in one place, in the
           * lists, where you can see every row you are choosing between.
           * ====================================================================
           */}
          <div className="composer">
            <div className="composer-scope">
              <h2 className="composer-title">{scopeSentence}</h2>
              <div className="composer-cost">
                <strong className="composer-jobs">{localEst.jobs.toLocaleString()}</strong> SERPs
                <span className="composer-sep">·</span>
                <span className={props.live ? '' : 'faint'}>
                  {props.live ? `about $${localEst.usd.toFixed(2)}` : '$0 · fixtures'}
                </span>
              </div>
            </div>

            <div className="composer-controls">
            {/**
             * Settings said out loud. A toggle that doubles the SERP count must
             * not be able to hide inside a closed disclosure, so anything moved
             * off its default is named here and marked.
             */}
            <div className="composer-settings">
              {advancedSummary.map((s) => (
                <span
                  key={s.label}
                  className={s.isDefault ? 'composer-setting' : 'composer-setting is-changed'}
                  title={s.isDefault ? undefined : 'Changed from the default'}
                >
                  {s.label}
                </span>
              ))}
              <button
                type="button"
                className="composer-link"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? 'Hide settings' : 'Change'}
              </button>
            </div>

            <button
              type="button"
              className="primary composer-go"
              disabled={pending || !canRun}
              onClick={reviewKeywords}
              title="Free: asks Google Ads what these niches are actually searched as in these markets, and prices the run. Nothing is bought until the next step."
            >
              {pending ? 'Checking…' : 'Review keywords →'}
            </button>
            </div>

            {!canRun && (
              <p className="disabled-reason" style={{ margin: '10px 0 0' }}>
                Select at least one niche and one market to run.
              </p>
            )}

            <div className="composer-more">
              <button
                type="button"
                className="composer-disclosure"
                onClick={() => setSingleMarketOpen((v) => !v)}
                aria-expanded={singleMarketOpen}
              >
                <span aria-hidden>{singleMarketOpen ? '▾' : '▸'}</span> Research one market deeply
                <span className="faint"> one place × ~24 buy-intent keywords · ~$0.10</span>
              </button>
              <span className="composer-reassure faint">
                Nothing is bought yet — the next step shows the keywords first.
              </span>
            </div>

            {preview && !preview.ok && (
              <div className="stopbox" style={{ marginTop: 12 }}>
                {preview.error ?? preview.detail}
              </div>
            )}
            {msg && (
              <div className={msg.ok ? 'okbox' : 'stopbox'} style={{ marginTop: 12 }}>
                {msg.error ?? msg.detail}
                {msg.ok && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn tiny" onClick={() => setStep('sweep')}>
                      Watch progress →
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {advancedOpen && (
            <div className="advanced-panel card composer-panel">
              <div className="advanced-grid">
                <label
                  className="screen-device-label"
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
                <label className="screen-device-label">
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
              </div>
              <div className="advanced-toggles">
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
              </div>
              <p className="faint advanced-note">
                Hard cap 5,000 jobs ($10). SERPs use each market&apos;s geo location code, so they
                are the pages someone in that market would see. Volume is Google Ads at the market
                location, not map-pack listings.
              </p>
            </div>
          )}

          {singleMarketOpen && (
            <div className="card composer-panel">
              <p className="sub" style={{ fontSize: 12.5, marginTop: 0 }}>
                One locality, expanded into its full buy-intent keyword cluster — the follow-up
                after the grid picks a winner. Or scan every seed niche in one place at once.
              </p>
              {/* Opening the disclosure IS the "start one" gesture -- making it
                  render a button that opens the same thing again is one click
                  of pure ceremony. */}
              <ResearchWizard
                searchLocalities={props.searchLocalities}
                niches={props.niches}
                initialOpen
              />
            </div>
          )}

          {/**
           * The lists ARE the selection, and they fill the page.
           *
           * Folding them behind a disclosure cut the opening screen to ten
           * controls but took the answer to "which ones am I locked into" with
           * it, and left a card floating in an empty viewport. Two scrolling
           * panels answer that continuously and use the space the workspace was
           * built to give them; the composer above is what actually replaced
           * the scattered controls.
           */}
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

        </section>
      )}

      {/* ── Step 2: what this run would actually buy ─────────────────────── */}
      {step === 'keywords' && (
        <section className="opp-step">
          {/**
           * Same shape as step 1: a flush bar that states the run and offers the
           * one action, then the content taking the rest of the page.
           *
           * This step was a header paragraph, a floating summary card, a warning
           * box and a grid of cards adrift above empty space -- four visual
           * languages for one question: is this the right list to pay for?
           */}
          <div className="composer">
            <div className="composer-scope">
              <h2 className="composer-title">
                {preview?.keywordCount ?? previewKeywordCount} keyword
                {(preview?.keywordCount ?? previewKeywordCount) === 1 ? '' : 's'} across{' '}
                {keywordPreview.length} niche{keywordPreview.length === 1 ? '' : 's'}
              </h2>
              <div className="composer-cost">
                <strong className="composer-jobs">
                  {(preview?.jobCount ?? localEst.jobs).toLocaleString()}
                </strong>{' '}
                SERPs
                <span className="composer-sep">·</span>
                <span className={props.live ? '' : 'faint'}>
                  {props.live
                    ? `est. ${preview?.estimatedCost ?? `$${localEst.usd.toFixed(2)}`}`
                    : '$0 · fixtures'}
                </span>
              </div>
            </div>

            <div className="composer-controls">
              <span className="composer-settings">
                <span className="composer-setting">
                  {geoIds.size} market{geoIds.size === 1 ? '' : 's'}
                  {deviceN > 1 ? ' × 2 devices' : ''}
                </span>
                {/**
                 * Niches overlap. Without this the lists below add up to more
                 * than the number being bought, and the SERP count stops
                 * multiplying out.
                 */}
                {sharedKeywords > 0 && (
                  <span
                    className="composer-setting"
                    title="The per-niche lists below overlap; a keyword claimed by two niches is bought once."
                  >
                    {previewKeywordCount} picked, {sharedKeywords} shared
                  </span>
                )}
                <span className="composer-setting">
                  Volume is national; the sweep measures each one again per market
                </span>
              </span>

              {needsAck && (
                <label className="screen-ack" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={workerAck}
                    onChange={(e) => setWorkerAck(e.target.checked)}
                  />
                  I understand this large run drains via cron over many minutes
                </label>
              )}

              <button
                type="button"
                className="primary composer-go"
                disabled={pending || !canRun || (needsAck && !workerAck)}
                onClick={runConfirm}
              >
                {pending
                  ? 'Queuing…'
                  : `Buy ${(preview?.jobCount ?? localEst.jobs).toLocaleString()} SERPs`}
              </button>
            </div>

            <div className="composer-more">
              <button
                type="button"
                className="composer-disclosure"
                onClick={() => setStep('screen')}
              >
                ← Change selection
              </button>
              <span className="composer-reassure faint">
                Nothing has been bought yet. Google Ads was asked what each niche is actually
                searched as in these markets — free, and already done.
              </span>
            </div>
          </div>

          {/**
           * Named, not buried. A niche whose whole list is a template guess is
           * the case that produced "bathroom remodeling installation" -- a
           * phrase with no demand anywhere, swept at full price across every
           * market in the run.
           */}
          {unmeasuredNiches.length > 0 && (
            <div className="kwrev-warn">
              <strong>
                {unmeasuredNiches.length} niche{unmeasuredNiches.length === 1 ? '' : 's'} fell back
                to template keywords.
              </strong>{' '}
              Google Ads returned nothing usable for{' '}
              {unmeasuredNiches.map((d) => nicheLabel(d.nicheSlug)).join(', ')}, so those keywords
              are generated from a pattern and nobody has confirmed anyone searches them. They cost
              the same as the measured ones — go back and deselect those niches if you would rather
              not pay for guesses.
            </div>
          )}

          {keywordPreview.length === 0 ? (
            <div className="card empty" style={{ margin: 20, padding: 20 }}>
              No keyword list came back. Go back and select at least one niche.
            </div>
          ) : (
            <div className="kwrev-scroll">
              <div className="kwrev-grid">
                {orderedKeywordPreview.map((d) => {
                  const measured = d.keywords.filter((k) => k.volume != null)
                  const topVol = measured.reduce((m, k) => Math.max(m, k.volume ?? 0), 0)
                  const totalVol = measured.reduce((m, k) => m + (k.volume ?? 0), 0)
                  return (
                    <section key={d.nicheSlug} className="kwrev-niche">
                      <header className="kwrev-niche-head">
                        <span className="kwrev-niche-name">{nicheLabel(d.nicheSlug)}</span>
                        <span
                          className={`badge ${d.source === 'google_ads' ? 'go' : 'warn'}`}
                          title={
                            d.source === 'google_ads'
                              ? 'Keywords come from Google Ads search data for these markets.'
                              : d.note ?? 'Google Ads returned nothing; these are template-generated.'
                          }
                        >
                          {d.source === 'google_ads' ? 'measured' : 'template'}
                        </span>
                      </header>
                      <div className="kwrev-niche-meta">
                        {d.keywords.length} keyword{d.keywords.length === 1 ? '' : 's'}
                        {totalVol > 0 && (
                          <>
                            {' · '}
                            <strong>{formatVol(totalVol)}</strong> searches/mo
                          </>
                        )}
                        {d.rejected > 0 && (
                          <span title="Ideas discovery threw away for intent or volume.">
                            {' · '}
                            {d.rejected} rejected
                          </span>
                        )}
                      </div>
                      {d.note && d.source === 'template' && (
                        <div className="kwrev-note" title={d.note}>
                          {tidyProviderNote(d.note)}
                        </div>
                      )}
                      <ul className="kwrev-list">
                        {d.keywords.map((k) => (
                          <li key={k.keyword} className="kwrev-row">
                            <span className="kwrev-kw">{k.keyword}</span>
                            {k.volume == null ? (
                              <span
                                className="kwrev-novol"
                                title="Google Ads has no figure for this phrase, so nobody has confirmed it is searched."
                              >
                                no vol
                              </span>
                            ) : (
                              <span className="kwrev-vol">
                                {/* Bar in a fixed track: a percentage on a flex
                                    item resolves against whatever width the text
                                    left over, which made every bar the same tick. */}
                                <span className="kwrev-track" aria-hidden>
                                  <span
                                    className="kwrev-bar"
                                    style={{
                                      width: `${topVol > 0 ? Math.max(4, Math.round((k.volume / topVol) * 100)) : 4}%`,
                                    }}
                                  />
                                </span>
                                <span className="kwrev-num">{formatVol(k.volume)}</span>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}
              </div>

              {msg && (
                <div className={msg.ok ? 'okbox' : 'stopbox'} style={{ margin: '0 20px 20px' }}>
                  {msg.error ?? msg.detail}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Step 3: everything this workspace has run ───────────────────── */}
      {step === 'sweep' && (
        <section className="opp-step">
          {/**
           * The same bar as steps 1 and 2. This step's title and description are
           * hidden by the workspace CSS as restatements of the page header,
           * which left the header as an empty band with two buttons adrift in
           * the right of it -- chrome that said nothing and used 47px saying it.
           */}
          <div className="composer">
            <div className="composer-scope">
              <h2 className="composer-title">Runs</h2>
              <div className="composer-cost">
                <strong className="composer-jobs">{props.deepDiveRuns.length}</strong> sweep
                {props.deepDiveRuns.length === 1 ? '' : 's'}
                {props.scanRuns.length > 0 && (
                  <>
                    <span className="composer-sep">·</span>
                    <strong className="composer-jobs">{props.scanRuns.length}</strong> locality scan
                    {props.scanRuns.length === 1 ? '' : 's'}
                  </>
                )}
                {jobsActive && (
                  <>
                    <span className="composer-sep">·</span>
                    <span className="badge warn">live</span>
                  </>
                )}
              </div>
            </div>

            <div className="composer-controls">
              <span className="composer-settings">
                <span className="composer-setting">
                  Deleting a run clears its results so the same selection can be swept again
                </span>
              </span>
              <button
                type="button"
                className="btn composer-go"
                onClick={() => router.refresh()}
                disabled={pending}
              >
                {jobsActive ? 'Refreshing…' : 'Refresh'}
              </button>
              <a href="/portfolio" className="btn primary">
                Open Portfolio →
              </a>
            </div>
          </div>

          <div className="step-scroll">
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

            <DiscoveryRunStatus
              runs={props.deepDiveRuns}
              title="Sweep runs"
              emptyHint="No sweep runs yet. Pick niches × markets on Select and start one."
              autoRefresh={false}
              onDeleteRun={deleteDiscoveryRunAction}
              runHref={(id) => `/scout/runs/${id}`}
            />

            <ScanRunList runs={props.scanRuns} />
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
