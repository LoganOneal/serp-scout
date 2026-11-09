import {
  OCCUPIABLE_SURFACES,
  RANK_BAND_LABELS,
  SURFACE_LABELS,
  earnsTraffic,
  rankBand,
  type SerpSurface,
  type SurfaceState,
} from '@rnr/core'
import type { CoverageRow } from '@rnr/data'
import { num } from '@/lib/format'

/**
 * The conquest board: one territory per cluster.
 *
 * ==================== WHY A BOARD AND NOT THE TABLE ====================
 * A cluster is one page competing for a set of SERP slots — territory with
 * positions in it. The table rendered that as grey dots in acres of whitespace:
 * complete, and it told you nothing at a glance.
 * ======================================================================
 *
 * ==================== A POSITION IS NOT A CONQUEST ====================
 * The first version of this board lit a pip for ANY rank and counted the whole
 * cluster's volume as won. Against real data that produced "18 holding ground ·
 * 86% of demand held" for a site whose best organic position was #13 and whose
 * average was #34.
 *
 * Nobody gets traffic at #34. A binary encoding does not merely flatter — it
 * inverts the instruction, saying "you hold this, go elsewhere" when the truth
 * is "you are close, push". So control is graded, only page one counts as won,
 * and every held slot shows its actual rank.
 * ======================================================================
 *
 * ==================== FOG OF WAR IS THE HONEST METAPHOR ================
 * `unscouted` is not "we hold nothing", it is "we have not looked". Fog says
 * exactly that, and it is the one game metaphor here that makes the system more
 * honest rather than less.
 * =======================================================================
 *
 * Territories are ordered and sized by the PRIZE, never by how much we hold.
 * Sorting by conquest would put a fully-held 20-search cluster above a
 * contested 2,900-search one, permanently, and it would feel like winning.
 */

type Stance = 'unscouted' | 'earning' | 'fringe' | 'contested' | 'empty'

function stanceOf(row: CoverageRow): Stance {
  if (row.tally.unmeasured) return 'unscouted'
  if (row.control.earning > 0) return 'earning'
  if (row.control.fringe > 0) return 'fringe'
  if (row.tally.available === 0) return 'empty'
  return 'contested'
}

const STANCE_LABEL: Record<Stance, string> = {
  unscouted: 'Unscouted',
  earning: 'Page 1',
  fringe: 'Fringe',
  contested: 'Contested',
  empty: 'No ground',
}

export function ConquestBoard({ rows }: { rows: CoverageRow[] }) {
  if (rows.length === 0) return <div className="empty">No territories yet.</div>

  const scouted = rows.filter((r) => !r.tally.unmeasured)
  const earning = scouted.filter((r) => r.control.earning > 0)
  const fringe = scouted.filter((r) => r.control.earning === 0 && r.control.fringe > 0)

  const prize = rows.reduce((n, r) => n + (r.volumeMax ?? 0), 0)
  /**
   * Only PAGE-ONE demand counts as won. Summing every cluster we are merely
   * indexed against reported 86% of demand held for a portfolio earning from
   * none of it.
   */
  const wonPrize = earning.reduce((n, r) => n + (r.volumeMax ?? 0), 0)
  const fringePrize = fringe.reduce((n, r) => n + (r.volumeMax ?? 0), 0)

  const pctWon = prize === 0 ? 0 : (wonPrize / prize) * 100
  const pctFringe = prize === 0 ? 0 : (fringePrize / prize) * 100

  return (
    <>
      <div className="cq-campaign">
        <div className="cq-camp-stat">
          <div className="cq-camp-value">{num(rows.length)}</div>
          <div className="cq-camp-label">Territories</div>
        </div>
        <div
          className="cq-camp-stat"
          title="At least one surface on page one. The only positions that earn clicks."
        >
          <div className="cq-camp-value cq-ink-held">{num(earning.length)}</div>
          <div className="cq-camp-label">On page 1</div>
        </div>
        <div
          className="cq-camp-stat"
          title="Indexed but past page one: close, and earning nothing. Push these before building anything new."
        >
          <div className="cq-camp-value cq-ink-contested">{num(fringe.length)}</div>
          <div className="cq-camp-label">Fringe</div>
        </div>
        <div className="cq-camp-stat">
          <div className="cq-camp-value cq-ink-fog">{num(rows.length - scouted.length)}</div>
          <div className="cq-camp-label">Unscouted</div>
        </div>

        <div className="cq-camp-bar-wrap">
          <div
            className="cq-camp-label"
            title="Only page-one positions count as won. Being indexed at #34 earns nothing, so it is shown separately rather than added in."
          >
            Demand on page 1 · {num(wonPrize)} of {num(prize)} searches/mo
            {fringePrize > 0 ? (
              <span className="cq-camp-sub">
                {' '}
                · {num(fringePrize)} within reach on the fringe
              </span>
            ) : null}
          </div>
          <div className="cq-camp-bar">
            <span className="cq-camp-fill" style={{ width: `${pctWon}%` }} />
            <span className="cq-camp-fill-fringe" style={{ width: `${pctFringe}%` }} />
          </div>
        </div>
      </div>

      <div className="cq-grid">
        {rows.map((r) => (
          <Territory key={r.slug} row={r} />
        ))}
      </div>
    </>
  )
}

function Territory({ row }: { row: CoverageRow }) {
  const stance = stanceOf(row)
  const best = row.control.bestRank
  const band = rankBand(best)

  /** Progress is toward page one, not toward "any slot". */
  const pct =
    best === null ? 0 : earnsTraffic(best) ? 100 : Math.max(8, Math.min(90, (10 / best) * 100))

  return (
    <article className={`cq-card cq-${stance}`}>
      <header className="cq-head">
        <div className="cq-name" title={row.primaryKeywordNorm ?? row.slug}>
          {row.slug}
        </div>
        <span className={`cq-stance cq-stance-${stance}`}>{STANCE_LABEL[stance]}</span>
      </header>

      <div className="cq-prize">
        <span className="cq-prize-value">{row.volumeMax === null ? '—' : num(row.volumeMax)}</span>
        <span className="cq-prize-unit">searches/mo</span>
      </div>

      <div className="cq-slots">
        {OCCUPIABLE_SURFACES.map((s) => (
          <Slot key={s} surface={s} state={row.states[s]} rank={row.ranks[s] ?? null} />
        ))}
      </div>

      <footer className="cq-foot">
        {row.tally.unmeasured ? (
          <span className="cq-fogline">Not scouted — buy a SERP to reveal</span>
        ) : best === null ? (
          <span className="cq-fogline">No position on any surface</span>
        ) : (
          <>
            <span className="cq-bar">
              <span
                className={earnsTraffic(best) ? 'cq-bar-fill' : 'cq-bar-fill cq-bar-fringe'}
                style={{ width: `${pct}%` }}
              />
            </span>
            {/* The rank itself. #34 and #3 must never look alike. */}
            <span className="cq-count" title={band ? RANK_BAND_LABELS[band] : undefined}>
              best #{best}
            </span>
          </>
        )}
        <span className="cq-kws">{row.memberCount} kw</span>
      </footer>
    </article>
  )
}

function Slot({
  surface,
  state,
  rank,
}: {
  surface: SerpSurface
  state: SurfaceState
  rank: number | null
}) {
  const hint: Record<SurfaceState, string> = {
    held: 'we occupy a slot here',
    theirs: 'contested — the surface exists and someone else holds it',
    absent: 'no ground — Google does not return this surface here',
    unattributable: 'present, but the response names no domains — we cannot tell',
    unmeasured: 'unscouted — no SERP bought',
  }

  /** A held slot is graded by band, so page 2 never looks like page 1. */
  const band = state === 'held' ? rankBand(rank) : null
  const cls = band ? `cq-slot-band-${band}` : `cq-slot-${state}`
  const label = band
    ? `${SURFACE_LABELS[surface]} — #${rank} (${RANK_BAND_LABELS[band]})`
    : `${SURFACE_LABELS[surface]} — ${hint[state]}`

  return (
    <span className={`cq-slot ${cls}`} title={label}>
      <span className="cq-slot-tag">{band ? `#${rank}` : SURFACE_LABELS[surface].slice(0, 3)}</span>
    </span>
  )
}
