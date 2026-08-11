import type { Verdict } from '@rnr/core'

/**
 * Display formatting. Imports only @rnr/core, which is pure -- so this module is
 * safe in client components.
 */

/**
 * Null renders as an em dash. NEVER as 0.
 *
 * A 0 where a measurement is missing is the visual form of the bug this whole
 * codebase is organised against: on a difficulty column it reads as the easiest
 * market on the page, and on a rent column it reads as a worthless one.
 */
export const NULL_DISPLAY = '—'

export function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return NULL_DISPLAY
  return v.toLocaleString('en-US')
}

/** Money from micros. Accepts a string because bigint cannot cross the RSC boundary. */
export function money(micros: string | null | undefined, opts?: { decimals?: number }): string {
  if (micros === null || micros === undefined) return NULL_DISPLAY
  const m = BigInt(micros)
  const decimals = opts?.decimals ?? 0
  const whole = m / 1_000_000n
  if (decimals === 0) return `$${whole.toLocaleString('en-US')}`
  const frac = (m % 1_000_000n).toString().padStart(6, '0').slice(0, decimals)
  return `$${whole.toLocaleString('en-US')}.${frac}`
}

export function percent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return NULL_DISPLAY
  return `${(v * 100).toFixed(digits)}%`
}

// ---------------------------------------------------------------------------

export interface VerdictStyle {
  label: string
  tone: 'go' | 'warn' | 'neutral' | 'stop' | 'unknown'
  meaning: string
}

/**
 * ONLY `likely_30d` is green.
 *
 * It is the only verdict that says "go buy this domain and build". Every other
 * band says wait or don't, and colouring 90-day green too would blur the one
 * distinction the operator acts on.
 */
export const VERDICT_STYLES: Record<Verdict, VerdictStyle> = {
  likely_30d: {
    label: '~30 days',
    tone: 'go',
    meaning:
      'Every gate passed, including a confirmed-available domain and actually-measured link data.',
  },
  likely_90d: {
    label: '~90 days',
    tone: 'warn',
    meaning: 'Winnable, but not inside a month on this model.',
  },
  likely_6m: {
    label: '~6 months',
    tone: 'neutral',
    meaning: 'There are real defenders here who have to be displaced individually.',
  },
  not_winnable: {
    label: 'not winnable',
    tone: 'stop',
    meaning: 'A hard blocker fired, or difficulty is above every winnable ceiling.',
  },
  unknown: {
    label: 'unknown',
    tone: 'unknown',
    meaning: 'Too little was measured to place a band. Not the same as "hard".',
  },
}

export function verdictStyle(v: Verdict): VerdictStyle {
  return VERDICT_STYLES[v] ?? VERDICT_STYLES.unknown
}

/** Difficulty bar colour. Easiest-first is the primary sort, so green = low. */
export function difficultyColor(d: number | null): string {
  if (d === null) return 'var(--text-faint)'
  if (d <= 20) return '#2ea043'
  if (d <= 35) return '#7cb342'
  if (d <= 50) return '#d29922'
  if (d <= 70) return '#e0762b'
  return '#d0453b'
}

/** Availability, three states, each phrased so `null` cannot read as a yes. */
export function availabilityLabel(available: boolean | null): {
  text: string
  tone: 'go' | 'stop' | 'unknown'
} {
  if (available === true) return { text: 'available', tone: 'go' }
  if (available === false) return { text: 'taken', tone: 'stop' }
  return { text: 'unconfirmed', tone: 'unknown' }
}

export function kindLabel(kind: string): string {
  if (kind === 'metro') return 'metro'
  if (kind === 'county') return 'county'
  return 'city'
}
