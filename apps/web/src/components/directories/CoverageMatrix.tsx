import {
  OCCUPIABLE_SURFACES,
  SURFACE_GLYPHS,
  SURFACE_LABELS,
  type SerpSurface,
  type SurfaceState,
} from '@rnr/core'
import type { CoverageRow } from '@rnr/data'
import { NULL_DISPLAY, num } from '@/lib/format'

/**
 * The coverage matrix: clusters × SERP surfaces.
 *
 * ==================== FOUR STATES, GLYPH FIRST ====================
 * ●  we hold it     ○  someone else holds it
 * ·  surface absent  ▪  never measured
 *
 * Three of those look like "no" and mean completely different things — go
 * compete, nothing to win here, go and buy a SERP. A grid that paints them as
 * one empty cell is worse than a table, because a grid actively invites the eye
 * to read empty as bad.
 *
 * Colour is the SECOND channel, never the first: status encodings ship with a
 * glyph so they survive colourblindness, greyscale print, and a screenshot
 * pasted into Slack.
 * ==================================================================
 *
 * ==================== AND IT IS NOT SORTED ON COVERAGE ====================
 * Ordered by `vol (max)`, like every other board here. Sorting by surfaces held
 * would put a five-surface keyword with 20 searches above a one-surface keyword
 * with 1,900 — permanently, and it would feel like progress. Occupancy is a
 * proxy; a leaderboard on a proxy is how the proxy becomes the goal.
 * =========================================================================
 */
export function CoverageMatrix({ rows }: { rows: CoverageRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No clusters to measure yet.</div>
  }

  const anyMeasured = rows.some((r) => !r.tally.unmeasured)

  return (
    <>
      {!anyMeasured && (
        <div className="sm-panel-hint">
          Nothing measured yet. Every cell is <span className="cov cov-unmeasured">▪</span> — which
          means <em>no SERP has been bought</em>, not that we hold nothing. Run{' '}
          <code className="mono">affiliate-research.mts difficulty &lt;domain&gt; --live</code>; it
          records coverage from the same SERPs it already buys for difficulty.
        </div>
      )}

      <div className="sm-table-wrap">
        <table className="sm-table cov-table">
          <thead>
            <tr>
              <th className="cov-th-name">Cluster</th>
              {OCCUPIABLE_SURFACES.map((s) => (
                <th key={s} className="cov-th" title={surfaceHint(s)}>
                  {SURFACE_LABELS[s]}
                </th>
              ))}
              <th className="cov-th-held" title="Surfaces held over surfaces AVAILABLE — absent surfaces are excluded, so a keyword with no video carousel is not penalised for missing one.">
                Held
              </th>
              <th className="num" title="Highest single member. A lower bound, and the sort key.">
                vol (max)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.slug}>
                <td className="cov-name">
                  <span className="sm-kw-text">{r.slug}</span>
                  <span className="cov-kind">{r.kind.replace(/_/g, ' ')}</span>
                </td>

                {OCCUPIABLE_SURFACES.map((s) => (
                  <Cell key={s} surface={s} state={r.states[s]} />
                ))}

                <td className="cov-held">
                  <HeldMeter tally={r.tally} />
                </td>

                <td className="num">
                  {r.volumeMax === null ? (
                    <span className="null">{NULL_DISPLAY}</span>
                  ) : (
                    num(r.volumeMax)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A legend is always present — identity is never colour alone. */}
      <div className="cov-legend">
        <span><span className="cov cov-held">●</span> we hold it</span>
        <span><span className="cov cov-theirs">○</span> someone else holds it</span>
        <span><span className="cov cov-absent">·</span> surface not on this SERP</span>
        <span><span className="cov cov-unattributable">?</span> present, but the response names no domains — ownership unknown</span>
        <span><span className="cov cov-unmeasured">▪</span> never measured — no SERP bought</span>
      </div>
    </>
  )
}

function Cell({ surface, state }: { surface: SerpSurface; state: SurfaceState }) {
  return (
    <td className={`cov-cell cov-${state}`} title={`${SURFACE_LABELS[surface]}: ${stateHint(state)}`}>
      <span className={`cov cov-${state}`}>{SURFACE_GLYPHS[state]}</span>
    </td>
  )
}

/**
 * A single ratio against a limit is a METER, not a pie and not a one-bar chart.
 *
 * Unmeasured renders as an em dash rather than 0/6: zero-of-six is a claim about
 * the SERP, and we have not looked at it.
 */
function HeldMeter({ tally }: { tally: CoverageRow['tally'] }) {
  if (tally.unmeasured) {
    return <span className="null" title="No SERP bought for this cluster.">{NULL_DISPLAY}</span>
  }
  const pct = tally.available === 0 ? 0 : (tally.held / tally.available) * 100
  return (
    <span className="meter" title={`${tally.held} of ${tally.available} available surfaces held`}>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${Math.max(pct, pct > 0 ? 6 : 0)}%` }} />
      </span>
      <span className="meter-label num">
        {tally.held}/{tally.available}
      </span>
    </span>
  )
}

function stateHint(state: SurfaceState): string {
  if (state === 'held') return 'we occupy a slot'
  if (state === 'theirs') return 'the surface exists and someone else holds it — go compete'
  if (state === 'absent') return 'Google does not return this surface for this query — nothing to win'
  if (state === 'unattributable') {
    return 'the surface is on the page but the response names no domains, so we cannot tell who holds it'
  }
  return 'never measured — no SERP has been bought for this keyword'
}

function surfaceHint(s: SerpSurface): string {
  const hints: Partial<Record<SerpSurface, string>> = {
    organic: 'The ten blue links.',
    discussions: 'Discussions and Forums pack — Reddit threads. We hold it by having a post or comment in a ranking thread.',
    images: 'Image pack — Pinterest pins and our own images.',
    video: 'Video carousel — YouTube and indexed reels.',
    paa: 'People Also Ask.',
    ai_overview: 'AI Overview. Being CITED is not the same as holding a slot, and is a weaker claim.',
  }
  return hints[s] ?? SURFACE_LABELS[s]
}
