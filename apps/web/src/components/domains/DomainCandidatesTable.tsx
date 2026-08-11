'use client'

import { useMemo, useState } from 'react'
import { buildDirectoryLinks } from '@rnr/core'

export interface CandidateRow {
  id: number
  domain: string
  status: string
  reason: string
  score: number
  scoreMissing: string[] | null
  businessCount: number
  businesses: Array<{
    name: string
    website: string | null
    placeId?: string | null
    cid?: string | null
    address?: string | null
  }> | null
  authorityMatches: Array<{ domain: string; kind: string }> | null
  market: string | null
  stateAbbr: string | null
  registrar: string | null
  ageYears: number | null
  daysToExpiry: number | null
  expiresAt: string | null
  httpOutcome: string | null
  redirectedTo: string | null
  parkingNameserver: string | null
  trustFlow: number | null
  citationFlow: number | null
  referringDomains: number | null
  referringSubnets: number | null
  totalSnapshots: number | null
  yearsOfContent: number | null
  sources: string[] | null
  serpRank: number | null
  seenKeyword: string | null
  spamScore: number | null
  rankedKeywords: number | null
}

/**
 * Status order is acquisition order, not alphabetical: the tab strip doubles as
 * the priority list, so AVAILABLE sits leftmost and LIVE — which is not a
 * candidate at all — sits last.
 */
const STATUS_ORDER = [
  'AVAILABLE',
  'PENDING_DELETE',
  'REDEMPTION',
  'EXPIRING_SOON',
  'PARKED_DEAD',
  'ACQUIRED_301',
  'BROKEN',
  'UNKNOWN',
  'LIVE',
] as const

const STATUS_TONE: Record<string, string> = {
  AVAILABLE: 'ok',
  PENDING_DELETE: 'ok',
  REDEMPTION: 'warn',
  EXPIRING_SOON: 'warn',
  PARKED_DEAD: '',
  ACQUIRED_301: '',
  BROKEN: 'warn',
  UNKNOWN: 'warn',
  LIVE: 'muted',
}

const STATUS_HELP: Record<string, string> = {
  AVAILABLE: 'Unregistered — buy at retail',
  PENDING_DELETE: 'In the drop window — backorder only',
  REDEMPTION: 'Expired, owner still has ~30 days to redeem',
  EXPIRING_SOON: 'Registered, expiry inside 90 days',
  PARKED_DEAD: 'Registered and renewed, but nothing is served',
  ACQUIRED_301: 'Already redirects to another brand',
  LIVE: 'A real business is serving content — not a candidate',
  BROKEN:
    'Server responding with a 5xx. Hosting is active and being paid for, so this is not an expired domain — often just a broken WordPress install.',
  UNKNOWN:
    'The probe timed out or was blocked, so nothing was established. Check these by hand — an unreadable live site looks exactly like this.',
}

/**
 * Statuses that are not acquisition candidates.
 *
 * LIVE serves content. BROKEN has an active host erroring. UNKNOWN was never
 * established. All three are worth a look on their own tab; none belongs on a
 * ranked shortlist, because each one looked like a find until it was checked.
 */
const NOT_CANDIDATES = new Set(['LIVE', 'BROKEN', 'UNKNOWN'])

/** Window for the expiry watchlist, in days. */
const EXPIRY_WATCH_DAYS = 90

type SortKey =
  | 'score'
  | 'domain'
  | 'ageYears'
  | 'daysToExpiry'
  | 'yearsOfContent'
  | 'businessCount'
  | 'serpRank'
  | 'spamScore'
  | 'rankedKeywords'

const num = (v: number | null): string => (v == null ? '—' : String(v))

export function DomainCandidatesTable({ rows }: { rows: CandidateRow[] }) {
  const [tab, setTab] = useState<string>('CANDIDATES')
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDesc, setSortDesc] = useState(true)

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])

  const candidateCount = rows.filter((r) => !NOT_CANDIDATES.has(r.status)).length
  const expiringCount = rows.filter(
    (r) => r.daysToExpiry != null && r.daysToExpiry <= EXPIRY_WATCH_DAYS,
  ).length

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = rows
    // UNKNOWN is excluded alongside LIVE: triage never concluded on those, so
    // they are a "go look yourself" pile rather than a shortlist. They remain
    // one click away on their own tab.
    if (tab === 'CANDIDATES') out = out.filter((r) => !NOT_CANDIDATES.has(r.status))
    else if (tab === 'EXPIRING') {
      /**
       * Deliberately ignores status.
       *
       * A LIVE business whose registration lapses is the single best
       * acquisition signal there is, and the EXPIRING_SOON status cannot carry
       * it: a working site with a renewal due is correctly LIVE, because most
       * businesses do renew. So the watchlist is a separate axis -- these are
       * domains to WATCH, not to buy today.
       */
      out = out.filter((r) => r.daysToExpiry != null && r.daysToExpiry <= EXPIRY_WATCH_DAYS)
    }
    else if (tab !== 'ALL') out = out.filter((r) => r.status === tab)

    if (q) {
      out = out.filter(
        (r) =>
          r.domain.toLowerCase().includes(q) ||
          (r.registrar ?? '').toLowerCase().includes(q) ||
          (r.businesses ?? []).some((b) => b.name.toLowerCase().includes(q)),
      )
    }

    const dir = sortDesc ? -1 : 1
    return [...out].sort((a, b) => {
      if (sortKey === 'domain') return dir * a.domain.localeCompare(b.domain)
      const av = a[sortKey]
      const bv = b[sortKey]
      // Nulls sort last in both directions: "unknown" is not "worst", and a
      // domain whose age we could not read must not masquerade as brand new.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir * (Number(av) - Number(bv))
    })
  }, [rows, tab, filter, sortKey, sortDesc])

  const sortBtn = (key: SortKey, label: string, title?: string) => (
    <button
      type="button"
      className={`sm-sort-btn${sortKey === key ? ' active' : ''}`}
      title={title}
      onClick={() => {
        if (sortKey === key) setSortDesc((d) => !d)
        else {
          setSortKey(key)
          setSortDesc(true)
        }
      }}
    >
      {label}
      {sortKey === key && <span className="sm-sort-caret">{sortDesc ? '▾' : '▴'}</span>}
    </button>
  )

  return (
    <div className="opp-tab-panel opp-fill">
      <div className="opp-tabs-wrap">
        <div className="opp-tabs">
          <button
            type="button"
            className={`opp-tab${tab === 'CANDIDATES' ? ' active' : ''}`}
            onClick={() => setTab('CANDIDATES')}
          >
            <span className="opp-tab-label">Candidates</span>
            <span className="opp-tab-badge">{candidateCount}</span>
          </button>
          <button
            type="button"
            title={`Every domain expiring within ${EXPIRY_WATCH_DAYS} days, whatever its status. Live sites are here to be watched — most renew — but a lapse is the strongest signal there is.`}
            className={`opp-tab${tab === 'EXPIRING' ? ' active' : ''}`}
            onClick={() => setTab('EXPIRING')}
          >
            <span className="opp-tab-label">Expiring ≤{EXPIRY_WATCH_DAYS}d</span>
            <span className="opp-tab-badge">{expiringCount}</span>
          </button>
          {STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
            <button
              key={s}
              type="button"
              title={STATUS_HELP[s]}
              className={`opp-tab${tab === s ? ' active' : ''}`}
              onClick={() => setTab(s)}
            >
              <span className="opp-tab-label">{s.replace(/_/g, ' ').toLowerCase()}</span>
              <span className="opp-tab-badge">{counts[s]}</span>
            </button>
          ))}
          <button
            type="button"
            className={`opp-tab${tab === 'ALL' ? ' active' : ''}`}
            onClick={() => setTab('ALL')}
          >
            <span className="opp-tab-label">All</span>
            <span className="opp-tab-badge">{rows.length}</span>
          </button>
        </div>
        <input
          className="sm-filter-input"
          placeholder="Filter domain, registrar, business…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          {rows.length === 0
            ? 'No domains triaged yet. Results appear as the run works through the market.'
            : `No rows match this view.`}
        </div>
      ) : (
        <div className="table-scroll sm-table-wrap">
          <table className="opp-grid-table sm-table">
            <thead>
              <tr>
                <th className="num">{sortBtn('score', 'Score', '0–100 ranking aid, not a valuation')}</th>
                <th>{sortBtn('domain', 'Domain')}</th>
                <th>Status</th>
                <th className="num">{sortBtn('ageYears', 'Age', 'Domain age — a primary value driver')}</th>
                <th className="num">{sortBtn('daysToExpiry', 'Expires', 'Days until registry expiry')}</th>
                <th>Registrar</th>
                <th className="num" title="Majestic Trust Flow">TF</th>
                <th className="num" title="Majestic Citation Flow">CF</th>
                <th className="num" title="Referring subnets — harder to fake than referring domains">
                  Subnets
                </th>
                <th className="num" title="Best organic position this domain was seen at">
                  {sortBtn('serpRank', 'SERP')}
                </th>
                <th className="num" title="Spam score 0-100. Blank = not checked, which is not the same as clean.">
                  {sortBtn('spamScore', 'Spam')}
                </th>
                <th className="num" title="Keywords this domain still ranks for. Blank = not checked.">
                  {sortBtn('rankedKeywords', 'Ranks')}
                </th>
                <th className="num">
                  {sortBtn('yearsOfContent', 'Archive', 'Longest run of consecutive years with content')}
                </th>
                <th className="num">{sortBtn('businessCount', 'Biz', 'Listings pointing at this domain')}</th>
                <th title="Everywhere this business is or was listed">Listings</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    <span className="sm-score">{r.score.toFixed(1)}</span>
                    {r.scoreMissing && r.scoreMissing.length > 0 && (
                      <span
                        className="sm-score-partial"
                        title={`Scored without: ${r.scoreMissing.join(', ')}. A low score here reflects missing data, not a weak domain.`}
                      >
                         partial
                      </span>
                    )}
                  </td>
                  <td>
                    <a
                      className="sm-link"
                      href={`https://${r.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.domain}
                    </a>
                    {r.businesses && r.businesses[0] && (
                      <div className="sm-sub">{r.businesses[0].name}</div>
                    )}
                    {r.sources && r.sources.length > 0 && (
                      <div className="sm-sub" title="Where this domain was found">
                        {r.sources.map((x) => x.replace(/_/g, ' ')).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_TONE[r.status] ?? ''}`} title={STATUS_HELP[r.status]}>
                      {r.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                  <td className="num">{r.ageYears == null ? '—' : `${r.ageYears.toFixed(1)}y`}</td>
                  <td className="num">
                    {r.daysToExpiry == null ? (
                      '—'
                    ) : (
                      <span
                        className={
                          r.daysToExpiry <= 30
                            ? 'sm-expiry-urgent'
                            : r.daysToExpiry <= EXPIRY_WATCH_DAYS
                              ? 'sm-expiry-soon'
                              : undefined
                        }
                        title={
                          r.status === 'LIVE' && r.daysToExpiry <= EXPIRY_WATCH_DAYS
                            ? 'Live site with a near expiry — watch whether it renews. Most do.'
                            : undefined
                        }
                      >
                        {r.daysToExpiry}d
                      </span>
                    )}
                  </td>
                  <td className="sm-sub">{r.registrar ?? '—'}</td>
                  <td className="num">{num(r.trustFlow)}</td>
                  <td className="num">{num(r.citationFlow)}</td>
                  <td className="num">{num(r.referringSubnets)}</td>
                  <td className="num">
                    {r.serpRank == null ? (
                      '—'
                    ) : (
                      <span className="sm-serp-rank" title={r.seenKeyword ?? undefined}>
                        #{r.serpRank}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.spamScore == null ? (
                      <span className="sm-unchecked" title="Not checked — enable the link-quality option when starting a run">
                        —
                      </span>
                    ) : (
                      <span className={r.spamScore >= 30 ? 'sm-spam-bad' : undefined}>
                        {r.spamScore}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.rankedKeywords == null ? (
                      <span className="sm-unchecked" title="Not checked — enable the still-ranking option when starting a run">
                        —
                      </span>
                    ) : (
                      <span className={r.rankedKeywords === 0 ? 'sm-spam-bad' : undefined}>
                        {r.rankedKeywords}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.yearsOfContent == null ? '—' : `${r.yearsOfContent}y`}
                    {r.totalSnapshots != null && (
                      <span className="sm-sub"> {r.totalSnapshots} snaps</span>
                    )}
                  </td>
                  <td className="num">{r.businessCount}</td>
                  <td className="sm-links-cell">
                    {(() => {
                      const b = r.businesses?.[0]
                      const links = buildDirectoryLinks({
                        domain: r.domain,
                        businessName: b?.name ?? null,
                        city: r.market,
                        state: r.stateAbbr,
                        placeId: b?.placeId ?? null,
                        cid: b?.cid ?? null,
                        /**
                         * Pass the whole match, not just the host. The URL is
                         * what turns a directory chip from a search that may
                         * find nothing into a link to the actual citation page.
                         */
                        confirmedCitations: r.authorityMatches ?? [],
                      })
                      return (
                        <div className="sm-links">
                          {links.map((l) => (
                            <a
                              key={l.label}
                              href={l.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={l.hint}
                              className={`sm-link-chip sm-link-${l.kind}`}
                            >
                              {l.label}
                            </a>
                          ))}
                        </div>
                      )
                    })()}
                  </td>
                  <td className="sm-sub sm-evidence">
                    {r.reason}
                    {r.redirectedTo && (
                      <>
                        {' → '}
                        <span className="sm-mono">{r.redirectedTo}</span>
                      </>
                    )}
                    {r.parkingNameserver && (
                      <div className="sm-mono">ns: {r.parkingNameserver}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
