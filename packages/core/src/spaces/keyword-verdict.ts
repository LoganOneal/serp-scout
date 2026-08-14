/**
 * What to DO about one keyword on a site we already own.
 *
 * ==================== WHY NOT scoreDifficulty's VERDICTS ====================
 * `verdictEmd` and `verdictAcquired` answer "should I buy a domain for this
 * cell". That is the right question for rank-and-rent and the wrong one here:
 * the domain already exists, the operator is choosing what to publish next, and
 * the cheapest win is almost never a new page.
 *
 * So the split is by whether we already rank, because that is what changes the
 * action:
 *
 *   DEFEND   we are top-3 and something is closing
 *   IMPROVE  we are on page 1-2 — on-page work, no new page needed
 *   BUILD    nothing ranks and the SERP is enterable
 *   IGNORE   measured, and not worth it — with the reason kept
 *   UNKNOWN  a signal this decision needed was never measured
 * ===========================================================================
 *
 * UNKNOWN is a separate bucket rather than a flavour of IGNORE, for the same
 * reason `UNKNOWN_VALUE` is separate in `acquisition-value.ts`: "we checked and
 * it is not worth it" and "we never checked" are different facts, and a screen
 * that merges them hides its own coverage gaps behind a confident-looking list.
 */

export type KeywordVerdict = 'DEFEND' | 'IMPROVE' | 'BUILD' | 'IGNORE' | 'UNKNOWN'

/**
 * Top-3 is where the click share lives, so these are the rankings worth
 * protecting rather than growing.
 */
export const DEFEND_MAX_POSITION = 3

/**
 * Above this, an existing page is close enough that on-page work is cheaper
 * than a new one. Page 2 (11-20) is included deliberately — it is the band
 * where a page already has topical signals and needs a push, not a rewrite.
 */
export const IMPROVE_MAX_POSITION = 20

/**
 * POLICY, not a measurement.
 *
 * `scoreDifficulty` is calibrated on local SERPs and has never been calibrated
 * against affiliate ones, so any ceiling here is a starting position to be moved
 * once outcomes exist — which is exactly what `calibration.ts` is for. It is a
 * required option rather than a buried constant so that nobody reads it as
 * evidence.
 */
export const DEFAULT_BUILD_DIFFICULTY_CEILING = 60

export interface KeywordVerdictInput {
  /**
   * Our current organic position, 1-based. Null = we do not rank, OR nobody
   * looked. `positionMeasured` disambiguates — see below.
   */
  position: number | null
  /**
   * Did we actually check? Search Console silence and "we never asked Search
   * Console" are the same `null` position and completely different facts.
   */
  positionMeasured: boolean
  /** Avg monthly searches at the space's audienceScope. Null = never measured. */
  volume: number | null
  /** 0-100 from scoreDifficulty. Null = the SERP was never bought or never scored. */
  difficulty: number | null
  /** Scope-relative: only ever compared within one audienceScope. */
  volumeFloor: number
}

export interface KeywordVerdictResult {
  verdict: KeywordVerdict
  reason: string
  /** Signals that were null and were needed. Non-empty implies UNKNOWN. */
  missing: string[]
}

export interface KeywordVerdictOptions {
  buildDifficultyCeiling?: number
}

export function assessKeyword(
  input: KeywordVerdictInput,
  opts: KeywordVerdictOptions = {},
): KeywordVerdictResult {
  const ceiling = opts.buildDifficultyCeiling ?? DEFAULT_BUILD_DIFFICULTY_CEILING

  /**
   * Ranking is checked BEFORE nullity, and only for the bands where it settles
   * the answer on its own.
   *
   * A top-3 ranking is a DEFEND whether or not anyone bought a difficulty score
   * — we are already there, so how hard it was to get is history. Demanding a
   * full signal set first would push our best pages into UNKNOWN, which is the
   * mirror of the mistake `assessAcquisition` avoids with LIVE.
   */
  if (input.positionMeasured && input.position !== null && input.position <= DEFEND_MAX_POSITION) {
    return {
      verdict: 'DEFEND',
      reason: `Ranking #${input.position} — protect it`,
      missing: [],
    }
  }

  const missing: string[] = []
  if (!input.positionMeasured) missing.push('position')
  if (input.volume === null) missing.push('volume')

  if (missing.length > 0) {
    return {
      verdict: 'UNKNOWN',
      reason: `Not decidable — never measured: ${missing.join(', ')}`,
      missing,
    }
  }

  const volume = input.volume as number

  if (volume < input.volumeFloor) {
    return {
      verdict: 'IGNORE',
      reason: `${volume}/mo is below the ${input.volumeFloor} floor for this space`,
      missing: [],
    }
  }

  if (input.position !== null && input.position <= IMPROVE_MAX_POSITION) {
    return {
      verdict: 'IMPROVE',
      reason: `Ranking #${input.position} on ${volume}/mo — a page exists, on-page work is cheaper than a new one`,
      missing: [],
    }
  }

  /**
   * Difficulty gates BUILD only.
   *
   * An IMPROVE decision does not need it (we already rank, so the SERP is
   * demonstrably enterable) and demanding it would discard our closest
   * opportunities on a signal that is not load-bearing for that route.
   */
  if (input.difficulty === null) {
    return {
      verdict: 'UNKNOWN',
      reason: 'Not decidable — no SERP has been bought for this keyword, so difficulty is unmeasured',
      missing: ['difficulty'],
    }
  }

  if (input.difficulty > ceiling) {
    return {
      verdict: 'IGNORE',
      reason: `Difficulty ${input.difficulty} is above the ${ceiling} build ceiling`,
      missing: [],
    }
  }

  if (input.position !== null) {
    return {
      verdict: 'BUILD',
      reason:
        `Ranking #${input.position} on ${volume}/mo — the existing page is not competitive; ` +
        `treat as a new build rather than an edit`,
      missing: [],
    }
  }

  return {
    verdict: 'BUILD',
    reason: `Nothing ranks, ${volume}/mo, difficulty ${input.difficulty} — enterable`,
    missing: [],
  }
}
