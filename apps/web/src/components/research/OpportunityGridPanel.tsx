'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { groupByNicheMarket } from '@rnr/core'
import { useRouter } from 'next/navigation'
import {
  deleteOpportunityCellAction,
  deleteOpportunityCellsBulkAction,
} from '@/app/markets/actions'
import { VolumeSourceLink } from '@/components/VolumeSourceLink'
import { OpenLocalSerpLinks } from '@/components/OpenLocalSerpLinks'

/**
 * One measured niche × market cell as the grid renders it.
 *
 * Lives here rather than in OpportunityFunnel because the run detail page shows
 * the same table for a single run, and two copies of a 50-field row shape drift
 * the moment a column is added.
 */
export interface OpportunityGridRowView {
  /** Addresses the per-keyword detail page. See getRunKeywordDetail. */
  metricId?: number
  /**
   * Path under /research/runs/<id>/serp/ for this keyword. Computed per run so
   * it is short when the keyword is unique there and market-qualified when a
   * sweep measured it in several markets.
   */
  serpPath?: string
  researchKeywordId: number
  researchGeoId: number
  /** Clusters keyword variations of one service. */
  seedKey: string
  variant: string
  nicheId: number | null
  /** Null = not computed, never "easy". Renders as an em dash and sorts LAST. */
  /** Estimated monthly searches reaching a Reddit thread on this query. */
  redditVisits?: number | null
  redditBestPosition?: number | null
  difficulty?: number | null
  weightCovered?: number | null
  slotsOpen?: number | null
  platformHeldSlots?: number | null
  medianRefDomains?: number | null
  linkDataMeasured?: boolean | null
  verdictEmd?: string | null
  verdictAcquired?: string | null
  blockersAcquired?: Array<{ code: string; message: string }> | null
  emdDomain?: string | null
  emdAvailable?: boolean | null
  keyword: string
  exactQuery: string
  volume: number | null
  volumeSource: string | null
  volumeGeoTarget: string | null
  market: string
  stateAbbr: string | null
  /** Google geotarget name, for a UULE link Google will actually honour. */
  geoTargetName?: string | null
  /** Locality as typed ("new york city"), appended to the Live SERP query. */
  queryModifier?: string | null
  redditHitCount: number
  bestRedditAbsoluteRank: number | null
  commentable: boolean | null
  adsAboveOrganic: number
  localAboveOrganic: number
  firstOrganicRankAbsolute?: number | null
  discussionsPackPresent?: boolean
  mapPresent?: boolean
  mapRankAbsolute?: number | null
  lsaCount?: number
  lsaAboveOrganic?: number
  lsaRankAbsolute?: number | null
  localBusinessCount?: number
  localBusinessAboveOrganic?: number
  localPackRankAbsolute?: number | null
  forumsCount?: number
  forumsRankAbsolute?: number | null
  sponsoredAboveOrganic?: number
  paidCount?: number
  device?: string
  monthlySearches?: Array<{ year: number; month: number; searchVolume: number }> | null
  serpCompetitionIndex?: number | null
  serpCompetition?: string | null
  cpcMicros?: number | null
  topOrganicDomains?: Array<{ domain: string; rankAbsolute: number }> | null
  gbpLeaders?: Array<{
    title: string
    domain: string | null
    rating: number | null
    reviewsCount: number | null
    rankAbsolute: number | null
  }> | null
  hasAiOverview?: boolean
  hasPeopleAlsoAsk?: boolean
  mapsEntryCount?: number | null
  mapsDomains?: string[] | null
  mapsKeyword?: string | null
  opportunityScore: number | null
  opportunityReasons: string[]
  measuredAt: string | null
  runStatus: string | null
  marketHref: string | null
  localitySlug: string | null
  /** Market centroid — drives the coordinate UULE the Live SERP links use. */
  lat?: number | null
  lon?: number | null
  nicheSlug: string | null
  avgTicketMicros: number | null
  leadValueMicros: number | null
  competitionIndex: number | null
}

function formatVol(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function formatUsdMicros(n: number | null): string {
  if (n == null) return '—'
  const usd = n / 1_000_000
  if (usd >= 1000) return `$${Math.round(usd / 100) / 10}k`
  return `$${Math.round(usd)}`
}

export interface OpportunityGridPanelProps {
  rows: OpportunityGridRowView[]
  /** Shown in the toolbar. */
  title?: string
  /** Live badge + no "go screen" prompt while a run is still draining. */
  jobsActive?: boolean
  /** Rendered in the empty state (e.g. a link back to Screen). */
  emptyAction?: React.ReactNode
  /** Fill the viewport and scroll the table body instead of the page. */
  fullHeight?: boolean
  /**
   * When the grid is scoped to one run, the keyword links to that run's
   * per-keyword page. Omitted on the cross-run funnel, where a row is the
   * newest measurement rather than a specific one, so there is no single
   * measurement to open.
   */
  runId?: number
}


/**
 * ==================== WHY COLUMNS ARE DATA ====================
 * The grid reached 27 columns -- roughly 2,660px of content against ~1,220px of
 * viewport -- and four of them were added at the FRONT this week, which pushed
 * "Niche / keyword" to position 7. The one column an operator scans by became
 * the one most likely to be scrolled past.
 *
 * Presets exist because there is no single right answer: the Reddit lead-gen
 * play and the buy-a-domain play read different numbers off the same rows.
 * ==============================================================
 */
export type ColumnId =
  | 'select' | 'keyword' | 'market' | 'redditVol' | 'redditRank' | 'volume'
  | 'leadValue' | 'score' | 'liveSerp' | 'difficulty' | 'slotsOpen' | 'winnable'
  | 'cpc' | 'comp' | 'device' | 'firstOrganic' | 'ads' | 'lsa' | 'gbp' | 'map'
  | 'maps' | 'forums' | 'topOrganic' | 'gbpLeaders' | 'openQ' | 'why' | 'actions'

/** Always rendered: identity and the row controls. Never hideable. */
const PINNED: ColumnId[] = ['select', 'keyword', 'market', 'actions']

export const COLUMN_PRESETS: Record<string, { label: string; columns: ColumnId[] }> = {
  reddit: {
    label: 'Reddit',
    columns: ['redditVol', 'redditRank', 'volume', 'leadValue', 'score', 'liveSerp'],
  },
  rankAndRent: {
    label: 'Rank & rent',
    columns: ['volume', 'difficulty', 'slotsOpen', 'winnable', 'leadValue', 'cpc', 'liveSerp'],
  },
  serpLayout: {
    label: 'SERP layout',
    columns: [
      'firstOrganic', 'ads', 'lsa', 'gbp', 'map', 'maps', 'forums',
      'topOrganic', 'gbpLeaders',
    ],
  },
  all: {
    label: 'All',
    columns: [
      'score', 'redditVol', 'difficulty', 'slotsOpen', 'winnable', 'volume', 'cpc',
      'comp', 'leadValue', 'liveSerp', 'device', 'firstOrganic', 'redditRank', 'ads',
      'lsa', 'gbp', 'map', 'maps', 'forums', 'topOrganic', 'gbpLeaders', 'openQ', 'why',
    ],
  },
}

/** Label shown in the picker. Kept beside the presets so the two cannot drift. */
const COLUMN_LABELS: Record<ColumnId, string> = {
  select: 'Select', keyword: 'Niche / keyword', market: 'Market', redditVol: 'Reddit vol',
  redditRank: 'Reddit #', volume: 'Vol', leadValue: 'Lead $', score: 'Score',
  liveSerp: 'Live SERP', difficulty: 'Diff', slotsOpen: 'Open', winnable: 'Winnable?',
  cpc: 'CPC', comp: 'Comp', device: 'Device', firstOrganic: '1st org', ads: 'Ads↑',
  lsa: 'LSA↑', gbp: 'GBP↑', map: 'Map', maps: 'Maps', forums: 'Forums',
  topOrganic: 'Top organic', gbpLeaders: 'GBP leaders', openQ: 'Open?', why: 'Why',
  actions: 'Actions',
}

const STORAGE_KEY = 'rnr.grid.columns.v1'

const VERDICT_LABEL: Record<string, string> = {
  likely_30d: '30d',
  likely_90d: '90d',
  likely_6m: '6m',
  not_winnable: 'no',
  unknown: '?',
}

const VERDICT_TONE: Record<string, string> = {
  likely_30d: 'sm-verdict-fast',
  likely_90d: 'sm-verdict-good',
  likely_6m: 'sm-verdict-slow',
  not_winnable: 'sm-verdict-no',
  unknown: 'sm-verdict-unknown',
}

/**
 * Two bands side by side: registering a fresh exact-match domain vs acquiring
 * one. They only diverge when a SERP is weak enough to reach 30 days and the
 * exact-match string happens to be taken -- and that divergence is precisely
 * the "buy a domain, do not register one" signal.
 */
function VerdictPair(props: {
  emd: string | null
  acquired: string | null
  emdDomain: string | null
  emdAvailable: boolean | null
  blockers: Array<{ code: string; message: string }> | null
}) {
  if (!props.emd && !props.acquired) return <span className="null">—</span>
  const blockerText =
    props.blockers && props.blockers.length > 0
      ? props.blockers.map((b) => b.message).join('\n')
      : 'No blockers.'
  return (
    <span className="sm-verdicts">
      <span
        className={`sm-verdict ${props.emd ? VERDICT_TONE[props.emd] : ''}`}
        title={`Registering ${props.emdDomain ?? 'an exact-match domain'}${
          props.emdAvailable === false
            ? ' — that domain is TAKEN'
            : props.emdAvailable === true
              ? ' — available'
              : ' — availability unknown'
        }`}
      >
        {props.emd ? (VERDICT_LABEL[props.emd] ?? props.emd) : '—'}
      </span>
      <span className="sm-verdict-sep">/</span>
      <span
        className={`sm-verdict ${props.acquired ? VERDICT_TONE[props.acquired] : ''}`}
        title={`Acquiring a domain.\n\n${blockerText}`}
      >
        {props.acquired ? (VERDICT_LABEL[props.acquired] ?? props.acquired) : '—'}
      </span>
    </span>
  )
}

/**
 * The opportunities table: filter + bulk select + the wide metric grid.
 */
export function OpportunityGridPanel(props: OpportunityGridPanelProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  /** Selected opportunity cells: "kwId:geoId" */
  const [gridSel, setGridSel] = useState<Set<string>>(new Set())
  const [gridFilter, setGridFilter] = useState('')

  const cellKey = (kwId: number, geoId: number) => `${kwId}:${geoId}`

  const filteredGrid = useMemo(() => {
    const q = gridFilter.trim().toLowerCase()
    if (!q) return props.rows
    return props.rows.filter(
      (r) =>
        r.exactQuery.toLowerCase().includes(q) ||
        r.market.toLowerCase().includes(q) ||
        (r.stateAbbr?.toLowerCase().includes(q) ?? false) ||
        (r.nicheSlug?.toLowerCase().includes(q) ?? false) ||
        (r.keyword?.toLowerCase().includes(q) ?? false) ||
        r.opportunityReasons.some((x) => x.toLowerCase().includes(q)),
    )
  }, [props.rows, gridFilter])

  /**
   * One row per niche x market, not per keyword variation.
   *
   * A sweep buys a SERP per variation, so eight phrasings of the same service
   * in one market arrived as eight rows and read as eight opportunities. They
   * are one decision, so they collapse here and expand on demand.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * A run page opens with its groups EXPANDED.
   *
   * Collapsed, the only visible row is the niche aggregate, and an aggregate
   * has no single SERP -- so its "open" goes to the market page, which spans
   * every run. An operator looking at run 38 and clicking open landed on
   * /markets/san-jose-ca/roofing, which is the opposite of what a run-scoped
   * row is offering. The individual keywords ARE the run's content, so on a run
   * they are shown, not hidden behind a disclosure.
   *
   * The cross-run funnel keeps collapsing: there the aggregate IS the answer.
   */
  const collapseByDefault = props.runId == null
  const isGroupOpen = (key: string): boolean =>
    collapseByDefault ? expanded.has(key) : !expanded.has(key)
  const [winnableOnly, setWinnableOnly] = useState(false)

  /**
   * Column choice is a per-person preference and there is no user table, so it
   * lives in localStorage rather than Postgres. Read in an effect, not in the
   * initialiser: this component server-renders, and touching localStorage
   * during render is a hydration mismatch.
   */
  const [preset, setPreset] = useState<string>('reddit')
  const [overrides, setOverrides] = useState<Partial<Record<ColumnId, boolean>>>({})
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as { preset?: string; overrides?: Record<string, boolean> }
      if (saved.preset && COLUMN_PRESETS[saved.preset]) setPreset(saved.preset)
      if (saved.overrides) setOverrides(saved.overrides as Partial<Record<ColumnId, boolean>>)
    } catch {
      // A corrupt or unavailable store must not stop the grid rendering.
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, overrides }))
    } catch {
      /* private mode, quota — the grid still works, the choice just will not stick */
    }
  }, [preset, overrides])

  const visibleColumns = useMemo(() => {
    const base = new Set<ColumnId>([...PINNED, ...(COLUMN_PRESETS[preset]?.columns ?? [])])
    for (const [id, on] of Object.entries(overrides)) {
      if (PINNED.includes(id as ColumnId)) continue
      if (on) base.add(id as ColumnId)
      else base.delete(id as ColumnId)
    }
    return base
  }, [preset, overrides])

  /** Every th and its matching td share this guard, so they cannot drift apart. */
  const show = (id: ColumnId): boolean => visibleColumns.has(id)

  const hasOverrides = Object.keys(overrides).length > 0
  const toggleColumn = (id: ColumnId) =>
    setOverrides((prev) => ({ ...prev, [id]: !show(id) }))

  const tableRef = useRef<HTMLTableElement>(null)

  /**
   * A <th> rendered while its <td> is hidden shifts every column after it. That
   * reads as wrong data rather than a broken layout, which is exactly the kind
   * of bug that ships. Fail loudly in dev the moment a column is added without
   * its partner, instead of in front of an operator.
   */
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const table = tableRef.current
    if (!table) return
    const headers = table.querySelectorAll('thead > tr > th').length
    const firstRow = table.querySelector('tbody > tr')
    if (!firstRow) return
    const cells = firstRow.querySelectorAll(':scope > td, :scope > th').length
    if (headers !== cells) {
      console.error(
        `[OpportunityGridPanel] column misalignment: ${headers} header cells vs ${cells} body cells. ` +
          'A th and its td are guarded by different show() ids.',
      )
    }
  }, [visibleColumns, filteredGrid])

  const groupedAll = useMemo(() => groupByNicheMarket(filteredGrid), [filteredGrid])
  const grouped = useMemo(
    () =>
      winnableOnly
        ? groupedAll.filter(
            (g) => g.verdictAcquired === 'likely_30d' || g.verdictAcquired === 'likely_90d',
          )
        : groupedAll,
    [groupedAll, winnableOnly],
  )
  const toggleExpanded = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const filteredGridKeys = useMemo(
    () => filteredGrid.map((r) => cellKey(r.researchKeywordId, r.researchGeoId)),
    [filteredGrid],
  )

  const allFilteredSelected =
    filteredGridKeys.length > 0 && filteredGridKeys.every((k) => gridSel.has(k))
  const someFilteredSelected =
    filteredGridKeys.some((k) => gridSel.has(k)) && !allFilteredSelected

  const selectAllGrid = () => {
    setGridSel(new Set(props.rows.map((r) => cellKey(r.researchKeywordId, r.researchGeoId))))
  }
  const deselectAllGrid = () => setGridSel(new Set())

  const toggleGridRow = (kwId: number, geoId: number) => {
    const k = cellKey(kwId, geoId)
    setGridSel((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  const setFilteredGridSelection = (checked: boolean) => {
    setGridSel((prev) => {
      const n = new Set(prev)
      for (const k of filteredGridKeys) {
        if (checked) n.add(k)
        else n.delete(k)
      }
      return n
    })
  }

  const bulkDeleteSelected = () => {
    if (gridSel.size === 0) return
    if (
      !window.confirm(
        `Delete ${gridSel.size} selected opportunit${gridSel.size === 1 ? 'y' : 'ies'}?\n\nClears their metrics so you can sweep them again from Screen.`,
      )
    ) {
      return
    }
    const pairs = [...gridSel].map((k) => {
      const [a, b] = k.split(':')
      return { researchKeywordId: Number(a), researchGeoId: Number(b) }
    })
    const fd = new FormData()
    fd.set('cells', JSON.stringify(pairs))
    startTransition(async () => {
      await deleteOpportunityCellsBulkAction(fd)
      setGridSel(new Set())
      router.refresh()
    })
  }

  const jobsActive = props.jobsActive ?? false

  return (
  <div className={`sm-panel${props.fullHeight ? ' sm-panel-fill' : ''}`}>
    <div className="sm-toolbar">
      <div className="sm-toolbar-title">
        {props.title ?? 'Opportunities'}
        <span className="sm-count">{props.rows.length}</span>
        {gridSel.size > 0 && (
          <span className="sm-count sm-count-sel">{gridSel.size} selected</span>
        )}
      </div>
      <div className="sm-toolbar-actions">
        {jobsActive && <span className="badge warn">updating live</span>}
        <input
          type="search"
          className="sm-filter-input"
          placeholder="Filter niche, keyword, or market…"
          value={gridFilter}
          onChange={(e) => setGridFilter(e.target.value)}
          aria-label="Filter opportunities"
        />
        <button type="button" className="btn tiny" onClick={() => router.refresh()}>
          Refresh
        </button>
      </div>
    </div>

    {props.rows.length > 0 && (
      <div className="sm-presetbar">
        <div className="opp-tabs">
          {Object.entries(COLUMN_PRESETS).map(([key, cfg]) => (
            <button
              key={key}
              type="button"
              className={`opp-tab${preset === key && !hasOverrides ? ' active' : ''}`}
              onClick={() => {
                setPreset(key)
                /*
                 * Switching preset clears per-column tweaks. Otherwise a column
                 * hidden under the old preset survives into a set that is
                 * supposed to show it, and the preset name lies about what is
                 * on screen.
                 */
                setOverrides({})
              }}
            >
              {cfg.label}
            </button>
          ))}
          {hasOverrides && (
            <button
              type="button"
              className="opp-tab active"
              title="Individual columns changed. Click to go back to the preset."
              onClick={() => setOverrides({})}
            >
              Custom ×
            </button>
          )}
        </div>
        <div className="sm-colpicker">
          <button
            type="button"
            className="btn tiny"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            + Columns ({visibleColumns.size})
          </button>
          {pickerOpen && (
            <>
              {/* Click-away layer: a menu that only closes via its own button
                  is a menu people leave open by accident. */}
              <button
                type="button"
                className="sm-colpicker-backdrop"
                aria-label="Close column picker"
                onClick={() => setPickerOpen(false)}
              />
              <div className="sm-colpicker-menu">
                {(Object.keys(COLUMN_LABELS) as ColumnId[])
                  .filter((id) => !PINNED.includes(id))
                  .map((id) => (
                    <label key={id} className="sm-colpicker-item">
                      <input type="checkbox" checked={show(id)} onChange={() => toggleColumn(id)} />
                      {COLUMN_LABELS[id]}
                    </label>
                  ))}
                <div className="sm-colpicker-note">
                  Niche / keyword, market and actions are always shown.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    )}

    {/* Bulk action bar (SEMrush-style) */}
    {props.rows.length > 0 && (
      <div className={`sm-bulkbar${gridSel.size > 0 ? ' is-active' : ''}`}>
        <div className="sm-bulkbar-left">
          <button type="button" className="btn tiny" onClick={selectAllGrid}>
            Select all
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={deselectAllGrid}
            disabled={gridSel.size === 0}
          >
            Deselect all
          </button>
          {gridFilter && (
            <button
              type="button"
              className="btn tiny"
              onClick={() => setFilteredGridSelection(true)}
            >
              Select filtered ({filteredGrid.length})
            </button>
          )}
        </div>
        <div className="sm-bulkbar-right">
          <button
            type="button"
            className="btn tiny danger"
            disabled={pending || gridSel.size === 0}
            onClick={bulkDeleteSelected}
          >
            {pending ? 'Deleting…' : `Delete selected${gridSel.size ? ` (${gridSel.size})` : ''}`}
          </button>
        </div>
      </div>
    )}

    {props.rows.length === 0 ? (
      <div className="empty" style={{ padding: 24 }}>
        {jobsActive ? (
          <>
            <div className="flex" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <span className="job-spinner" aria-hidden />
              <strong>Waiting for the first SERP results…</strong>
            </div>
            Results show here when jobs finish. Keep the worker/cron draining the queue.
          </>
        ) : (
          <>
            No sweep metrics yet. Complete <strong>Screen</strong> and start a market sweep.
            {props.emptyAction && <div style={{ marginTop: 12 }}>{props.emptyAction}</div>}
          </>
        )}
      </div>
    ) : filteredGrid.length === 0 ? (
      <div className="empty" style={{ padding: 20 }}>
        No rows match “{gridFilter}”.
        <button type="button" className="btn tiny" style={{ marginLeft: 8 }} onClick={() => setGridFilter('')}>
          Clear filter
        </button>
      </div>
    ) : (
      <div className="table-scroll sm-table-wrap">
        <table className="opp-grid-table sm-table" ref={tableRef}>
          <thead>
            <tr>

              {show('select') && (
              <th className="sm-check-col">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someFilteredSelected
                  }}
                  onChange={(e) => setFilteredGridSelection(e.target.checked)}
                  aria-label="Select all visible opportunities"
                />
              </th>
              )}

              {show('score') && (
              <th className="num">Score</th>
              )}

              {show('redditVol') && (
              <th
                className="num"
                title="Estimated monthly searches that actually reach a Reddit thread here — keyword volume x the click-through of the position the best thread holds, summed across the niche's keywords. Blank means volume was never bought, not that there is no audience."
              >
                Reddit vol
              </th>
              )}

              {show('difficulty') && (
              <th
                className="num"
                title="SERP difficulty 0-100 from the defenders' link strength, slot types and intent lock. Blank = not computed, which is not the same as easy."
              >
                Diff
              </th>
              )}

              {show('slotsOpen') && (
              <th className="num" title="Slots not held by a committed local operator, of 10">
                Open
              </th>
              )}

              {show('winnable') && (
              <th title="How fast a site could rank here. Left = registering a fresh exact-match domain; right = acquiring one.">
                Winnable?
              </th>
              )}

              {show('keyword') && (
              <th className="opp-col-keyword">Niche / keyword</th>
              )}

              {show('volume') && (
              <th className="num">Vol</th>
              )}

              {show('cpc') && (
              <th className="num" title="City CPC from Keywords Data">
                CPC
              </th>
              )}

              {show('comp') && (
              <th className="num" title="Paid competition 0–100 @ city">
                Comp
              </th>
              )}

              {show('leadValue') && (
              <th className="num">Lead $</th>
              )}

              {show('market') && (
              <th>Market</th>
              )}

              {show('liveSerp') && (
              <th>Live SERP</th>
              )}

              {show('device') && (
              <th className="num">Device</th>
              )}

              {show('firstOrganic') && (
              <th className="num" title="First organic rank_absolute">
                1st org
              </th>
              )}

              {show('redditRank') && (
              <th className="num" title="Best Reddit rank_absolute">
                Reddit #
              </th>
              )}

              {show('ads') && (
              <th className="num" title="Paid search ads above organic (not LSA)">
                Ads↑
              </th>
              )}

              {show('lsa') && (
              <th className="num" title="Local Services Ads (≠ paid search)">
                LSA↑
              </th>
              )}

              {show('gbp') && (
              <th className="num" title="Google Business / local pack listings above organic">
                GBP↑
              </th>
              )}

              {show('map') && (
              <th title="Map present + rank">Map</th>
              )}

              {show('maps') && (
              <th className="num" title="Maps SERP competitor count (1× niche×city)">
                Maps
              </th>
              )}

              {show('forums') && (
              <th className="num" title="Forum / discussions threads">
                Forums
              </th>
              )}

              {show('topOrganic') && (
              <th title="Top organic domains">Top organic</th>
              )}

              {show('gbpLeaders') && (
              <th title="Local pack business names">GBP leaders</th>
              )}

              {show('openQ') && (
              <th>Open?</th>
              )}

              {show('why') && (
              <th>Why</th>
              )}

              {show('actions') && (
              <th className="sm-col-actions">Actions</th>
              )}
                  </tr>
          </thead>
          <tbody>
            {grouped.flatMap((g) => {
              const isOpen = isGroupOpen(g.key)
              /**
               * The head row reuses the strongest variation's object so every
               * column keeps rendering exactly as before, with only the
               * aggregated figures overridden. Anything not aggregated (SERP
               * layout, maps, lead economics) belongs to that variation, which
               * is why the expander is one click away.
               */
              const head = {
                ...g.bestVariation,
                exactQuery: g.label,
                volume: g.volume,
                firstOrganicRankAbsolute: g.firstOrganicRankAbsolute,
                bestRedditAbsoluteRank: g.bestRedditAbsoluteRank,
                opportunityScore: g.opportunityScore,
              }
              const entries = [
                { row: head, isHead: true },
                ...(isOpen ? g.variations.map((v) => ({ row: v, isHead: false })) : []),
              ]
              const groupKeys = g.variations.map((v) =>
                cellKey(v.researchKeywordId, v.researchGeoId),
              )
              return entries.map(({ row, isHead }, i) => {
              /**
               * Inside a run, "open" means THIS run's SERP for this keyword.
               *
               * Both the row click and the Open button used marketHref, so
               * opening a row from run 38 landed on /markets/san-jose-ca/roofing
               * -- a page that aggregates every run that ever touched the cell,
               * which is the opposite of what a run-scoped row is offering.
               *
               * Same rule as the keyword link: only a row standing for exactly
               * one measurement gets the SERP href. A group head aggregating
               * several keywords has no single SERP to open, so it keeps the
               * market page. The market stays reachable from every row via its
               * own action.
               */
              const serpHref =
                props.runId != null && row.serpPath && (!isHead || g.variations.length === 1)
                  ? `/research/runs/${props.runId}/serp/${row.serpPath}`
                  : null
              const href = serpHref ?? row.marketHref
              const marketLabel = `${row.market}${row.stateAbbr ? `, ${row.stateAbbr}` : ''}`
              const key = cellKey(row.researchKeywordId, row.researchGeoId)
              const selected = isHead
                ? groupKeys.length > 0 && groupKeys.every((k) => gridSel.has(k))
                : gridSel.has(key)
              return (
                <tr
                  key={`${g.key}-${isHead ? 'head' : row.researchKeywordId}-${i}`}
                  className={`${selected ? 'row-selected' : ''}${href ? ' opp-grid-row-link' : ''}${isHead ? '' : ' opp-variation-row'}`}
                >

                  {show('select') && (
                  <td
                    className="sm-check-col"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        // Selecting the cell selects the NICHE in that market,
                        // so it covers every variation behind it. Otherwise a
                        // bulk delete would clear the head and silently leave
                        // the other seven measurements in place.
                        if (!isHead) {
                          toggleGridRow(row.researchKeywordId, row.researchGeoId)
                          return
                        }
                        setGridSel((prev) => {
                          const n = new Set(prev)
                          if (groupKeys.every((k) => n.has(k))) {
                            for (const k of groupKeys) n.delete(k)
                          } else {
                            for (const k of groupKeys) n.add(k)
                          }
                          return n
                        })
                      }}
                      aria-label={`Select ${row.exactQuery} ${marketLabel}`}
                    />
                  </td>
                  )}

                  {show('score') && (
                  <td className="num">
                    <strong className="sm-score">{row.opportunityScore ?? '—'}</strong>
                  </td>
                  )}

                  {show('redditVol') && (
                  <td className="num">
                    {(() => {
                      const v = isHead ? g.redditVisits : row.redditVisits
                      const pos = isHead ? g.redditBestPosition : row.redditBestPosition
                      const rank = isHead ? g.bestRedditAbsoluteRank : row.bestRedditAbsoluteRank
                      const threads = isHead ? g.redditHitCount : row.redditHitCount

                      /**
                       * ==================== A THREAD WITH NO VOLUME IS NOT NOTHING ====================
                       * Visits are volume x CTR, so a keyword Google Ads has no
                       * figure for produces null however many threads are on the
                       * page. This column then printed a bare em dash -- the same
                       * mark it prints when there is no Reddit at all -- in the
                       * FIRST column of the Reddit preset.
                       *
                       * "bathroom remodeling installation chicago" holds a Reddit
                       * result at organic #7 and read as empty here, while the
                       * evidence sat in a Reddit # column far to the right.
                       * Operators reasonably concluded the SERP had no Reddit.
                       *
                       * So: no estimate but a thread shows the RANK, muted, and
                       * says why the number is missing. Only a cell with neither
                       * gets the em dash.
                       * ==============================================================================
                       */
                      if (v == null && threads > 0) {
                        /**
                         * ABSOLUTE rank, deliberately -- it is what the Reddit #
                         * column beside it shows. Using organic position here
                         * printed "#3" next to a "#7" for the same thread, which
                         * reads as one of them being wrong. The organic position
                         * is the more meaningful of the two, so it goes in the
                         * tooltip rather than being dropped.
                         */
                        const at = rank ?? pos
                        return (
                          <span
                            className="sm-reddit-novol"
                            title={
                              `${threads} Reddit thread${threads === 1 ? '' : 's'} on this SERP` +
                              (at != null ? `, best at absolute #${at}` : '') +
                              (pos != null ? ` (organic #${pos})` : '') +
                              '. Visits cannot be estimated because Google Ads returned no volume ' +
                              'for this keyword.'
                            }
                          >
                            {at != null ? `#${at}` : '✓'}
                            <span className="sm-sub"> no vol</span>
                          </span>
                        )
                      }
                      if (v == null) {
                        return (
                          <span
                            className="null"
                            title="No Reddit thread on this SERP, and no volume to estimate with."
                          >
                            —
                          </span>
                        )
                      }
                      return (
                        <span className="sm-reddit-vol" title={pos ? `best thread at organic #${pos}` : undefined}>
                          {formatVol(v)}
                          {pos != null && <span className="sm-sub"> #{pos}</span>}
                        </span>
                      )
                    })()}
                  </td>
                  )}

                  {show('difficulty') && (
                  <td className="num">
                    {isHead ? (
                      g.difficulty == null ? (
                        <span
                          className="null"
                          title="Not computed — run the winnability backfill. This is not a claim that the SERP is easy."
                        >
                          —
                        </span>
                      ) : (
                        <span
                          className={
                            g.difficulty <= 30
                              ? 'sm-diff-easy'
                              : g.difficulty <= 55
                                ? 'sm-diff-mid'
                                : 'sm-diff-hard'
                          }
                          title={
                            row.weightCovered != null && row.weightCovered < 1
                              ? `Only ${Math.round(row.weightCovered * 100)}% of the model could be measured`
                              : undefined
                          }
                        >
                          {g.difficulty}
                        </span>
                      )
                    ) : (
                      (row.difficulty ?? '—')
                    )}
                  </td>
                  )}

                  {show('slotsOpen') && (
                  <td className="num">
                    {(isHead ? g.slotsOpen : row.slotsOpen) ?? '—'}
                    {row.platformHeldSlots != null && (
                      <span className="sm-sub"> ({row.platformHeldSlots}p)</span>
                    )}
                  </td>
                  )}

                  {show('winnable') && (
                  <td style={{ fontSize: 11 }}>
                    {isHead ? (
                      <VerdictPair
                        emd={g.verdictEmd}
                        acquired={g.verdictAcquired}
                        emdDomain={row.emdDomain ?? null}
                        emdAvailable={row.emdAvailable ?? null}
                        blockers={row.blockersAcquired ?? null}
                      />
                    ) : (
                      <span className="sm-sub">{row.verdictAcquired ?? '—'}</span>
                    )}
                  </td>
                  )}

                  {show('keyword') && (
                  <td
                    style={{ fontSize: 12 }}
                    className={`opp-col-keyword${isHead ? '' : ' opp-variation-cell'}`}
                  >
                    {isHead && row.nicheSlug && (
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>
                        {row.nicheSlug.replace(/-/g, ' ')}
                      </div>
                    )}
                    {/*
                      The head row is an AGGREGATE: it carries bestVariation's
                      fields but g.label as its text, so linking it to
                      bestVariation.metricId opened a keyword the label did not
                      name -- "fence company" pointing at the SERP for "fence
                      company houston". A row only links when it stands for
                      exactly one measurement.
                    */}
                    {props.runId != null &&
                    row.serpPath &&
                    (!isHead || g.variations.length === 1) ? (
                      <a
                        className="mono opp-kw-link"
                        style={{ fontSize: 11.5 }}
                        href={`/research/runs/${props.runId}/serp/${row.serpPath}`}
                        title="Open the stored SERP and every measurement for this keyword"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {row.exactQuery}
                      </a>
                    ) : (
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        {row.exactQuery}
                      </span>
                    )}
                    {!isHead && g.devices.length > 1 && (
                      <span className="sm-sub"> · {row.device ?? 'desktop'}</span>
                    )}
                    {isHead && g.variations.length > 1 && (
                      <button
                        type="button"
                        className="opp-expand"
                        aria-expanded={isOpen}
                        title="Keyword variations measured for this niche in this market"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleExpanded(g.key)
                        }}
                      >
                        {isOpen ? '▾' : '▸'} {g.variationCount} keyword
                        {g.variationCount === 1 ? '' : 's'}
                        {g.devices.length > 1 ? ` × ${g.devices.length} devices` : ''}
                      </button>
                    )}
                    <div onClick={(e) => e.stopPropagation()}>
                      <VolumeSourceLink
                        linkOnly
                        volume={row.volume}
                        keyword={row.exactQuery}
                        volumeSource={row.volumeSource}
                        volumeGeoTarget={row.volumeGeoTarget}
                      />
                    </div>
                  </td>
                  )}

                  {show('volume') && (
                  <td className="num">
                    {row.volume == null ? (
                      <span className="null">—</span>
                    ) : (
                      <>
                        {formatVol(row.volume)}
                        {row.monthlySearches && row.monthlySearches.length > 0 && (
                          <div
                            className="faint"
                            style={{ fontSize: 10 }}
                            title={row.monthlySearches
                              .slice(0, 12)
                              .map((p) => `${p.year}-${p.month}:${p.searchVolume}`)
                              .join(' · ')}
                          >
                            12mo
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  )}

                  {show('cpc') && (
                  <td className="num">
                    {row.cpcMicros != null
                      ? `$${(row.cpcMicros / 1_000_000).toFixed(2)}`
                      : '—'}
                  </td>
                  )}

                  {show('comp') && (
                  <td className="num">
                    {row.serpCompetitionIndex ?? row.competitionIndex ?? '—'}
                    {row.serpCompetition ? (
                      <div className="faint" style={{ fontSize: 10 }}>
                        {row.serpCompetition}
                      </div>
                    ) : null}
                  </td>
                  )}

                  {show('leadValue') && (
                  <td className="num">{formatUsdMicros(row.leadValueMicros ?? null)}</td>
                  )}

                  {show('market') && (
                  <td style={{ fontSize: 12.5 }}>
                    {href ? (
                      <a href={href} className="sm-link">
                        {marketLabel}
                      </a>
                    ) : (
                      marketLabel
                    )}
                  </td>
                  )}

                  {show('liveSerp') && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <OpenLocalSerpLinks
                      compact
                      query={row.exactQuery}
                      city={row.market}
                      state={row.stateAbbr}
                      canonicalLocation={row.geoTargetName}
                      queryModifier={row.queryModifier}
                      lat={row.lat}
                      lon={row.lon}
                      measuredDevice={
                        row.device === 'mobile' || row.device === 'desktop'
                          ? row.device
                          : 'desktop'
                      }
                    />
                  </td>
                  )}

                  {show('device') && (
                  <td className="num" style={{ fontSize: 11 }}>
                    {isHead ? (
                      /* The cell was measured on each of these; the per-device
                         numbers are in the expanded variations below. */
                      <span title={`Measured on ${g.devices.join(' and ')}`}>
                        {g.devices.length > 1 ? g.devices.join(' + ') : (g.devices[0] ?? '—')}
                      </span>
                    ) : (
                      (row.device ?? '—')
                    )}
                  </td>
                  )}

                  {show('firstOrganic') && (
                  <td className="num">
                    {row.firstOrganicRankAbsolute != null
                      ? `#${row.firstOrganicRankAbsolute}`
                      : '—'}
                  </td>
                  )}

                  {show('redditRank') && (
                  <td className="num">
                    {row.bestRedditAbsoluteRank != null
                      ? `#${row.bestRedditAbsoluteRank}`
                      : row.redditHitCount > 0
                        ? 'yes'
                        : '—'}
                  </td>
                  )}

                  {show('ads') && (
                  <td className="num" title="Paid search ads above first organic">
                    {row.adsAboveOrganic}
                    {(row.paidCount ?? 0) > row.adsAboveOrganic ? (
                      <span className="faint" style={{ fontSize: 10 }}>
                        {' '}
                        /{row.paidCount}
                      </span>
                    ) : null}
                  </td>
                  )}

                  {show('lsa') && (
                  <td className="num" title="Local Services Ads above organic (not paid search)">
                    {row.lsaAboveOrganic ?? 0}
                    {(row.lsaCount ?? 0) > 0 ? (
                      <span className="faint" style={{ fontSize: 10 }}>
                        {' '}
                        /{row.lsaCount}
                      </span>
                    ) : null}
                  </td>
                  )}

                  {show('gbp') && (
                  <td
                    className="num"
                    title="Google Business listings above organic / total on SERP"
                  >
                    {row.localBusinessAboveOrganic ?? row.localAboveOrganic}
                    {(row.localBusinessCount ?? 0) > 0 ? (
                      <span className="faint" style={{ fontSize: 10 }}>
                        {' '}
                        /{row.localBusinessCount}
                      </span>
                    ) : null}
                  </td>
                  )}

                  {show('map') && (
                  <td style={{ fontSize: 11 }}>
                    {row.mapPresent ? (
                      <span title={`Map at rank ${row.mapRankAbsolute ?? '?'}`}>
                        yes
                        {row.mapRankAbsolute != null ? ` #${row.mapRankAbsolute}` : ''}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  )}

                  {show('maps') && (
                  <td className="num" title={row.mapsKeyword ? `Maps query: ${row.mapsKeyword}` : undefined}>
                    {row.mapsEntryCount != null ? row.mapsEntryCount : '—'}
                    {row.mapsDomains && row.mapsDomains.length > 0 ? (
                      <div className="faint" style={{ fontSize: 10, maxWidth: 90 }}>
                        {row.mapsDomains.slice(0, 2).join(', ')}
                      </div>
                    ) : null}
                  </td>
                  )}

                  {show('forums') && (
                  <td className="num" title="Forum threads / pack rank">
                    {(row.forumsCount ?? 0) > 0
                      ? `${row.forumsCount}${
                          row.forumsRankAbsolute != null ? ` @#${row.forumsRankAbsolute}` : ''
                        }`
                      : row.discussionsPackPresent
                        ? 'pack'
                        : '—'}
                  </td>
                  )}

                  {show('topOrganic') && (
                  <td style={{ fontSize: 10.5, maxWidth: 120 }}>
                    {row.topOrganicDomains && row.topOrganicDomains.length > 0 ? (
                      <span title={row.topOrganicDomains.map((d) => `#${d.rankAbsolute} ${d.domain}`).join('\n')}>
                        {row.topOrganicDomains
                          .slice(0, 3)
                          .map((d) => d.domain)
                          .join(', ')}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                    {(row.hasAiOverview || row.hasPeopleAlsoAsk) && (
                      <div className="faint" style={{ fontSize: 10 }}>
                        {row.hasAiOverview ? 'AIO ' : ''}
                        {row.hasPeopleAlsoAsk ? 'PAA' : ''}
                      </div>
                    )}
                  </td>
                  )}

                  {show('gbpLeaders') && (
                  <td style={{ fontSize: 10.5, maxWidth: 130 }}>
                    {row.gbpLeaders && row.gbpLeaders.length > 0 ? (
                      <span
                        title={row.gbpLeaders
                          .map(
                            (g) =>
                              `${g.title}${g.rating != null ? ` ★${g.rating}` : ''}${
                                g.reviewsCount != null ? ` (${g.reviewsCount})` : ''
                              }`,
                          )
                          .join('\n')}
                      >
                        {row.gbpLeaders
                          .slice(0, 2)
                          .map((g) => g.title)
                          .join(' · ')}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  )}

                  {show('openQ') && (
                  <td style={{ fontSize: 11 }}>
                    {row.commentable === true ? (
                      <span className="badge go">open</span>
                    ) : row.commentable === false ? (
                      <span className="badge stop">closed</span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  )}

                  {show('why') && (
                  <td className="faint" style={{ fontSize: 10.5, maxWidth: 160 }}>
                    {row.opportunityReasons.slice(0, 2).join(' · ')}
                  </td>
                  )}

                  {show('actions') && (
                  <td className="sm-col-actions">
                    <div className="row-actions">
                      {href && (
                        <a
                          className="btn tiny"
                          href={href}
                          title={
                            serpHref
                              ? 'Open the SERP this run stored for this keyword'
                              : 'Open the market page for this niche'
                          }
                        >
                          {serpHref ? 'SERP' : 'Open'}
                        </a>
                      )}

                      <button
                        type="button"
                        className="btn tiny danger"
                        disabled={pending}
                        title="Delete this opportunity so you can re-run it"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Delete “${row.exactQuery}” × ${marketLabel}?\n\nClears metrics so you can sweep again.`,
                            )
                          ) {
                            return
                          }
                          const fd = new FormData()
                          fd.set('researchKeywordId', String(row.researchKeywordId))
                          fd.set('researchGeoId', String(row.researchGeoId))
                          startTransition(async () => {
                            await deleteOpportunityCellAction(fd)
                            setGridSel((prev) => {
                              const n = new Set(prev)
                              n.delete(key)
                              return n
                            })
                            router.refresh()
                          })
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                  )}
                  </tr>
              )
              })
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
  )
}
