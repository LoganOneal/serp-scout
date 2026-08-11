'use client'

import type { Verdict } from '@rnr/core'
import {
  NULL_DISPLAY,
  availabilityLabel,
  difficultyColor,
  percent,
  verdictStyle,
} from '@/lib/format'

/** Small presentational pieces. Import only @rnr/core (pure) plus local format. */

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const s = verdictStyle(verdict)
  return (
    <span className={`badge ${s.tone}`} title={s.meaning}>
      {s.label}
    </span>
  )
}

/**
 * Difficulty with its bar and its COVERAGE.
 *
 * Coverage sits next to the number deliberately: a difficulty of 14 scored on 45%
 * of signals is a different claim from a 14 scored on all of them, and without
 * the percentage on screen the two are indistinguishable.
 */
export function DifficultyCell({
  difficulty,
  weightCovered,
}: {
  difficulty: number | null
  weightCovered: number
}) {
  const partial = weightCovered < 0.999
  return (
    <div className="diff">
      <span className="diff-value" style={{ color: difficultyColor(difficulty) }}>
        {difficulty === null ? NULL_DISPLAY : difficulty}
      </span>
      <span className="diff-track">
        {difficulty !== null && (
          <span
            className="diff-fill"
            style={{ width: `${Math.max(2, difficulty)}%`, background: difficultyColor(difficulty) }}
          />
        )}
      </span>
      <span
        className={`coverage ${partial ? 'partial' : ''}`}
        title={
          partial
            ? `Scored on ${percent(weightCovered)} of signals. Unmeasured components were omitted and the weights renormalised — they were not counted as zero.`
            : 'All scoring components measured.'
        }
      >
        {percent(weightCovered)}
      </span>
    </div>
  )
}

export function AvailabilityBadge({
  available,
  detail,
}: {
  available: boolean | null
  detail?: string | null
}) {
  const a = availabilityLabel(available)
  return (
    <span
      className={`badge ${a.tone}`}
      title={
        detail ??
        (available === null
          ? 'Could not confirm. Unconfirmed is not available — this blocks the 30-day band.'
          : '')
      }
    >
      {a.text}
    </span>
  )
}

/** Renders null as an em dash, never as 0. */
export function Nullable({ value, suffix }: { value: number | string | null; suffix?: string }) {
  if (value === null) return <span className="null">{NULL_DISPLAY}</span>
  return (
    <>
      {typeof value === 'number' ? value.toLocaleString('en-US') : value}
      {suffix}
    </>
  )
}
