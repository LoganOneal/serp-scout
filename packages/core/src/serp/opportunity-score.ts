/**
 * Transparent opportunity scoring for Reddit lead-gen market screens.
 * Pure. No IO.
 */

export interface OpportunityInputs {
  /**
   * Measured monthly searches for the exact query (Google Ads Keyword Planner).
   * Null = unknown / not measured. Do not pass catalog import volume here.
   */
  volume: number | null
  /** google_ads | fixture | skipped | null — labels reasons honestly. */
  volumeSource?: string | null
  /** Best Reddit absolute rank on page 1 (lower better). Null = no Reddit. */
  bestRedditAbsoluteRank: number | null
  /** At least one Reddit hit. */
  redditOnPage1: boolean
  /** True / false / null unknown. */
  commentable: boolean | null
  adsAboveOrganic: number
  localAboveOrganic: number
  /** 0–100 difficulty when measured. Null = unknown. */
  difficulty: number | null
  discussionsPackPresent: boolean
  /** Organic vs discussions best hit. */
  bestRedditSource: 'organic' | 'discussions_and_forums' | null
  /**
   * Lead sell price micros (ticket × commission). Boosts score for high-ticket niches.
   */
  leadValueMicros?: number | bigint | null
  /** Paid competition 0–100; high + Reddit visible = arbitrage boost. */
  competitionIndex?: number | null
}

export interface OpportunityScoreBreakdown {
  /** 0–100 composite for sorting. Null if no useful signal. */
  score: number | null
  demandNorm: number
  redditVisibility: number
  clutterNorm: number
  difficultyNorm: number
  commentableFactor: number
  reasons: string[]
}

/**
 * Rank score from absolute position: #1 → 1.0, #10 → ~0.1, missing → 0.
 */
export function rankScore(absoluteRank: number | null): number {
  if (absoluteRank === null || absoluteRank < 1) return 0
  return Math.max(0, Math.min(1, 1.1 - absoluteRank / 10))
}

/**
 * Composite opportunity for "comment phone on Reddit in SERP".
 *
 * Higher is better. Components are shown in the UI — not a black box.
 */
export function scoreRedditLeadOpportunity(input: OpportunityInputs): OpportunityScoreBreakdown {
  const reasons: string[] = []

  const vol = input.volume ?? 0
  // log-scale demand 0–1 (100 → ~0.5, 10k → ~0.8, 100k → 1)
  const demandNorm =
    vol <= 0 ? 0 : Math.min(1, Math.log10(vol + 1) / Math.log10(100_000 + 1))
  if (vol > 0) {
    const src =
      input.volumeSource === 'google_ads'
        ? 'Google Ads'
        : input.volumeSource && input.volumeSource !== 'fixture'
          ? input.volumeSource
          : 'measured'
    reasons.push(`${src} vol ${vol}`)
  } else {
    reasons.push('volume unmeasured')
  }

  let redditVisibility = 0
  if (!input.redditOnPage1 || input.bestRedditAbsoluteRank === null) {
    reasons.push('no Reddit on page 1')
  } else {
    const rs = rankScore(input.bestRedditAbsoluteRank)
    const packBonus =
      input.bestRedditSource === 'discussions_and_forums'
        ? 1
        : input.discussionsPackPresent
          ? 0.85
          : 0.7
    redditVisibility = rs * packBonus
    reasons.push(`Reddit abs #${input.bestRedditAbsoluteRank}`)
  }

  const commentableFactor =
    input.commentable === true ? 1 : input.commentable === false ? 0.15 : 0.6
  if (input.commentable === true) reasons.push('commentable')
  else if (input.commentable === false) reasons.push('comments closed')
  else if (input.redditOnPage1) reasons.push('commentable unknown')

  const clutter =
    Math.min(6, input.adsAboveOrganic) / 6 * 0.55 +
    Math.min(6, input.localAboveOrganic) / 6 * 0.45
  const clutterNorm = Math.min(1, clutter)
  if (input.adsAboveOrganic + input.localAboveOrganic > 0) {
    reasons.push(`ads↑${input.adsAboveOrganic} local↑${input.localAboveOrganic}`)
  }

  const difficultyNorm =
    input.difficulty === null ? 0.5 : Math.min(1, Math.max(0, input.difficulty / 100))
  if (input.difficulty !== null) reasons.push(`diff ${input.difficulty}`)

  // Lead $ weight: $20 → ~0.35, $100 → ~0.5, $500 → ~0.65, $2k → ~0.8
  const leadVal =
    input.leadValueMicros === null || input.leadValueMicros === undefined
      ? null
      : typeof input.leadValueMicros === 'bigint'
        ? Number(input.leadValueMicros)
        : input.leadValueMicros
  const moneyNorm =
    leadVal === null || leadVal <= 0
      ? 0.5
      : Math.min(1, Math.log10(leadVal / 1_000_000 + 1) / Math.log10(2000 + 1))
  if (leadVal !== null && leadVal > 0) {
    reasons.push(`lead $${Math.round(leadVal / 1_000_000)}`)
  }

  const comp = input.competitionIndex
  // High paid competition + Reddit access = arbitrage (slight boost later).
  const paidHeat =
    comp == null || !Number.isFinite(comp) ? 0.4 : Math.min(1, Math.max(0, comp / 100))

  if (redditVisibility <= 0) {
    const base = demandNorm > 0 ? demandNorm * 15 * (0.6 + 0.4 * moneyNorm) : null
    return {
      score: base === null ? null : Math.round(Math.min(25, base)),
      demandNorm,
      redditVisibility: 0,
      clutterNorm,
      difficultyNorm,
      commentableFactor,
      reasons,
    }
  }

  const arbitrageBoost = 1 + paidHeat * 0.12 * (redditVisibility > 0 ? 1 : 0)
  const moneyWeight = 0.55 + 0.45 * moneyNorm

  const raw =
    demandNorm *
    redditVisibility *
    commentableFactor *
    (1 - clutterNorm * 0.65) *
    (1 / Math.max(difficultyNorm, 0.15)) *
    moneyWeight *
    arbitrageBoost

  // Scale to 0–100 with soft ceiling
  const score = Math.round(Math.min(100, raw * 55))

  return {
    score,
    demandNorm,
    redditVisibility,
    clutterNorm,
    difficultyNorm,
    commentableFactor,
    reasons,
  }
}
