'use client'

import { useEffect, useState } from 'react'

/**
 * The paid-stage picker.
 *
 * ==================== WHY THIS IS A MODAL AND NOT A CHECKBOX ROW ====================
 * Discovery and triage are free at any volume -- DNS, HTTP, RDAP and Wayback
 * cost nothing -- so the run itself is effectively $0.002 no matter how many
 * domains it looks at. These two stages are the only ones billed per domain,
 * and they are the only decision an operator actually has to make.
 *
 * Putting them behind a deliberate step, with the price recomputed as the
 * toggles move, means nobody spends money by not noticing a checkbox.
 * ====================================================================================
 */

export interface PaidOptionsValue {
  checkSpam: boolean
  checkRankings: boolean
  maxRankingLookups: number
  checkAuthority: boolean
  renderUnknown: boolean
  maxRenders: number
}

export const DEFAULT_PAID_OPTIONS: PaidOptionsValue = {
  // Both OFF. The free run is genuinely useful on its own, and an operator who
  // wants a grade should choose to pay for one.
  checkSpam: false,
  checkRankings: false,
  maxRankingLookups: 15,
  checkAuthority: false,
  renderUnknown: false,
  maxRenders: 100,
}

/** Prices measured by balance delta, not a rate card. Kept in sync with core/money.ts. */
const USD = {
  bulkRequest: 0.024,
  bulkRow: 0.000036,
  rankedKeyword: 0.012,
  /** /backlinks/backlinks/live -- measured by balance delta 2026-08-10. */
  citationLookup: 0.0242,
  mapPack: 0.002,
  browserRender: 0.0051,
}

/** Rough candidate count a market yields, for the estimate before a run exists. */
const ASSUMED_CANDIDATES = 40

/**
 * The citation audit pre-filters hard: LIVE, BROKEN and UNKNOWN rows are
 * skipped, as is anything with too few referring domains to hold a citation.
 * On a real market that leaves roughly 15 of ~40 candidates.
 */
const ASSUMED_CITATION_LOOKUPS = 15

/**
 * Roughly one row in eight lands in UNKNOWN -- measured at 155 of ~1,160 --
 * because a datacenter IP gets blocked or the site renders client-side.
 */
const ASSUMED_UNKNOWN = 25

export function estimateUsd(v: PaidOptionsValue, candidates = ASSUMED_CANDIDATES): number {
  let total = USD.mapPack
  if (v.checkSpam) {
    total += USD.bulkRequest * Math.ceil(candidates / 1000) + USD.bulkRow * candidates * 3
  }
  if (v.checkRankings) total += USD.rankedKeyword * Math.min(candidates, v.maxRankingLookups)
  if (v.checkAuthority) {
    total += USD.citationLookup * Math.min(candidates, ASSUMED_CITATION_LOOKUPS)
  }
  if (v.renderUnknown) total += USD.browserRender * Math.min(ASSUMED_UNKNOWN, v.maxRenders)
  return total
}

export function EnrichOptionsModal(props: {
  open: boolean
  onClose: () => void
  onConfirm: (value: PaidOptionsValue) => void
  niche: string
  locality: string
  pending?: boolean
}) {
  const [value, setValue] = useState<PaidOptionsValue>(DEFAULT_PAID_OPTIONS)

  // Escape closes. A modal that traps an operator is worse than no modal.
  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props])

  if (!props.open) return null

  const total = estimateUsd(value)
  const set = (patch: Partial<PaidOptionsValue>) => setValue((v) => ({ ...v, ...patch }))

  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Domain search options"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title">Run domain search</h2>
          <div className="sm-sub">
            {props.niche} — {props.locality}
          </div>
        </div>

        <div className="modal-body">
          <div className="opt-free">
            <div className="opt-free-head">
              <span className="badge ok">Free</span>
              <strong>Always included</strong>
            </div>
            <ul className="opt-list">
              <li>Live map pack for this market ($0.002, the only fixed cost)</li>
              <li>
                Every domain already seen in this market&rsquo;s organic SERPs and map packs —
                bought by earlier sweeps, so it costs nothing to reuse
              </li>
              <li>DNS, HTTP, registry (RDAP) and Wayback triage on every domain found</li>
            </ul>
            <div className="sm-sub">
              Triage is free at any volume, so a wider search does not cost more — only time.
            </div>
          </div>

          <div className="opt-paid">
            <div className="opt-free-head">
              <span className="badge warn">Optional · billed per domain</span>
            </div>

            <label className="opt-row">
              <input
                type="checkbox"
                checked={value.checkSpam}
                onChange={(e) => set({ checkSpam: e.target.checked })}
              />
              <span>
                <strong>Link quality &amp; spam score</strong>
                <span className="sm-sub">
                  {' '}
                  — one bulk request covers the whole market. Worth it: 6 of the top 10 candidates
                  in a real market scored 37–49 for spam, which makes them liabilities rather than
                  assets.
                </span>
                <div className="opt-price">
                  ≈ ${(USD.bulkRequest + USD.bulkRow * ASSUMED_CANDIDATES * 3).toFixed(3)} per market
                </div>
              </span>
            </label>

            <label className="opt-row">
              <input
                type="checkbox"
                checked={value.renderUnknown}
                onChange={(e) => set({ renderUnknown: e.target.checked })}
              />
              <span>
                <strong>Re-read unreadable sites with a browser</strong>
                <span className="sm-sub">
                  {' '}
                  — about 1 row in 8 comes back <em>unknown</em> because the site renders in
                  JavaScript or refuses our server. Rendering resolved most of them in testing:
                  one site went from 67 characters to 1,213 words, another from a 403 to a full
                  page. Sites behind a hard bot-wall stay unknown.
                </span>
                <div className="opt-price">
                  ${USD.browserRender.toFixed(4)} per domain re-read · only unknown rows
                </div>
              </span>
            </label>

            <label className="opt-row">
              <input
                type="checkbox"
                checked={value.checkRankings}
                onChange={(e) => set({ checkRankings: e.target.checked })}
              />
              <span>
                <strong>Still-ranking check</strong>
                <span className="sm-sub">
                  {' '}
                  — whether a domain still ranks for anything, which age and archive depth cannot
                  tell you. The #3 candidate in a real market ranked for zero keywords.
                </span>
                <div className="opt-price">${USD.rankedKeyword.toFixed(3)} per domain checked</div>
              </span>
            </label>

            <label className="opt-row">
              <input
                type="checkbox"
                checked={value.checkAuthority}
                onChange={(e) => set({ checkAuthority: e.target.checked })}
              />
              <span>
                <strong>Authority citations</strong>
                <span className="sm-sub">
                  {' '}
                  — which BBB, chamber, .gov and .edu pages still link to the domain, and{' '}
                  <em>the exact page each link is on</em>. Without this the directory links on
                  each row are name searches, which often find nothing.
                </span>
                <div className="opt-price">
                  ${USD.citationLookup.toFixed(4)} per qualifying domain (~
                  {ASSUMED_CITATION_LOOKUPS} of them)
                </div>
              </span>
            </label>

            {value.checkRankings && (
              <label className="opt-row opt-row-sub">
                <span>Check the top</span>
                <input
                  type="number"
                  className="sm-filter-input opt-number"
                  min={1}
                  max={100}
                  value={value.maxRankingLookups}
                  onChange={(e) =>
                    set({ maxRankingLookups: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
                  }
                />
                <span>candidates by score</span>
              </label>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <div className="opt-total">
            Estimated total <strong>${total.toFixed(3)}</strong>
            <span className="sm-sub"> · assumes ~{ASSUMED_CANDIDATES} candidates</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={props.onClose} disabled={props.pending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={props.pending}
              onClick={() => props.onConfirm(value)}
            >
              {props.pending ? 'Starting…' : `Run · $${total.toFixed(3)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
