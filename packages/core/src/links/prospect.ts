import type { Micros } from '../money.js'
import { SPAM_CEILING } from '../domains/acquisition-value.js'

/**
 * Is this referring domain worth approaching, and what is a link on it worth?
 *
 * ==================== TRAFFIC FIRST, AUTHORITY SECOND ====================
 * This repo has already run the naive version and it failed. The P2
 * citation-hub probe pulled referring domains for two local hubs and got back
 * `seo-anomaly-top-34.xyz`, `kilo-wiki.win`, `m98ufa.com` — SEO spam, platform
 * hosts, and nothing usable (plan-defunct-domain-discovery.md §1.5).
 *
 * Those pass an authority filter because AUTHORITY IS MANUFACTURABLE AND
 * TRAFFIC IS NOT. A private blog network buys expired domains with real link
 * profiles; its rank and referring-domain counts look fine. What it cannot fake
 * cheaply is ranking for things humans actually search.
 *
 * So `rankedKeywords` is the first gate and `dfsRank` is a tie-breaker, not the
 * other way round.
 *
 * ==================== AND IT IS dfsRank, NOT DA OR AS ====================
 * "Domain Authority" is Moz's proprietary metric; "Authority Score" is
 * Semrush's. This project holds NEITHER. What we have is DataForSEO's `rank`
 * (0-1000). They correlate loosely and are not interchangeable, so every field,
 * screen and message says `dfsRank` rather than borrow a name we cannot compute.
 * ========================================================================
 *
 * See docs/plan-link-outreach.md §0 and §3.
 */

export type ProspectVerdict =
  /** Real traffic, clean profile, and the bid clears a plausible ask. */
  | 'PURSUE'
  /** Qualifies, but the bid is thin. Batch it; do not chase it. */
  | 'MARGINAL'
  /** Rejected, with a named reason. */
  | 'REJECT'
  /** A required signal was never measured. NEVER folded into REJECT. */
  | 'UNKNOWN'

/**
 * Below this, the domain ranks for essentially nothing and the authority
 * metrics are decoration.
 *
 * POLICY, and deliberately generous: a small but genuine niche blog can rank
 * for a few hundred keywords. The link networks this exists to catch rank for
 * ~zero, so the line does not need to be aggressive to do its job.
 */
export const MIN_RANKED_KEYWORDS = 50

/**
 * Spam at or above this is a liability.
 *
 * IMPORTED, not restated. `acquisition-value.ts` already derived it from a
 * measurement — the coverage plan found 6 of the top 10 candidates in a live
 * market at spam 37-49 and called them liabilities. Re-declaring the number
 * here would let the two features drift apart on the same underlying question,
 * and a duplicate export is exactly how that starts.
 */
export { SPAM_CEILING } from '../domains/acquisition-value.js'

/**
 * How many of OUR competitors a domain links to before it reads as a
 * marketplace rather than an editorial mention.
 *
 * This is the §0.2 signal and it is free — a GROUP BY over rows stage ① already
 * bought. It points BOTH ways: a 6-competitor site is the easiest sale and the
 * worst footprint, which is why the count is carried as a number next to the
 * bid rather than folded into a score that hides it.
 */
export const MARKETPLACE_COMPETITOR_COUNT = 4

export interface ProspectSignals {
  domain: string
  /** DataForSEO `rank`, 0-1000. NOT Moz DA and NOT Semrush AS. */
  dfsRank: number | null
  referringDomains: number | null
  spamScore: number | null
  /**
   * Keywords this domain ranks for. THE FIRST GATE.
   * Null = never measured, which is not the same as zero.
   */
  rankedKeywords: number | null
  /** Estimated organic traffic value. Vendor-modelled. */
  organicEtv: number | null
  /** How many of our competitors link to this domain. See §0.2. */
  competitorLinkCount: number
  /** True when we already have a link from here. */
  alreadyLinked: boolean
}

export interface ProspectAssessment {
  verdict: ProspectVerdict
  reason: string
  /** Signals that were null and needed. Non-empty implies UNKNOWN. */
  missing: string[]
  /** Non-blocking observations — the marketplace footprint lives here. */
  warnings: string[]
}

export function assessProspect(signals: ProspectSignals): ProspectAssessment {
  const warnings: string[] = []

  if (signals.alreadyLinked) {
    return {
      verdict: 'REJECT',
      reason: 'We already have a link from this domain',
      missing: [],
      warnings,
    }
  }

  /**
   * The marketplace warning is raised BEFORE the traffic gate, so it survives
   * onto a rejected row too. "We rejected a marketplace" and "we rejected a
   * dead site" are different facts about our competitor set, and a operator
   * reading the reject list should see which.
   */
  if (signals.competitorLinkCount >= MARKETPLACE_COMPETITOR_COUNT) {
    warnings.push(
      `Links to ${signals.competitorLinkCount} of our competitors — this is a marketplace, not an ` +
        `editorial mention. Easiest sale, worst footprint: everyone in the niche is buying here.`,
    )
  }

  const missing: string[] = []
  if (signals.rankedKeywords === null) missing.push('rankedKeywords')
  if (signals.referringDomains === null) missing.push('referringDomains')

  if (missing.length > 0) {
    return {
      verdict: 'UNKNOWN',
      reason: `Not assessable — never measured: ${missing.join(', ')}`,
      missing,
      warnings,
    }
  }

  const ranked = signals.rankedKeywords as number

  /**
   * THE GATE THAT DECIDES WHETHER ANY OF THIS IS REAL.
   *
   * Checked before spam and before authority, because a domain that ranks for
   * nothing is not a low-quality link — it is not a website. `dfsRank` on such a
   * domain is a purchased number.
   */
  if (ranked < MIN_RANKED_KEYWORDS) {
    return {
      verdict: 'REJECT',
      reason:
        `Ranks for ${ranked} keyword(s) — below the ${MIN_RANKED_KEYWORDS} floor. ` +
        `Authority metrics are manufacturable; traffic is not, and there is none here.`,
      missing: [],
      warnings,
    }
  }

  if (signals.spamScore !== null && signals.spamScore >= SPAM_CEILING) {
    return {
      verdict: 'REJECT',
      reason: `Spam score ${signals.spamScore} is at or above the ${SPAM_CEILING} liability line`,
      missing: [],
      warnings,
    }
  }
  if (signals.spamScore === null) {
    warnings.push('Spam score was never measured — this row passed on the other signals only')
  }

  /**
   * A high-traffic domain that links to many competitors still qualifies. The
   * footprint is priced into the BID (see qualityMultiplier), not used as a
   * veto — vetoing it would discard the entire realistic supply in a commercial
   * niche and leave a list nobody can actually buy from.
   */
  return {
    verdict: 'PURSUE',
    reason:
      `Ranks for ${ranked.toLocaleString()} keywords, ${signals.referringDomains} referring domains` +
      `${signals.spamScore === null ? '' : `, spam ${signals.spamScore}`} — a real site`,
    missing: [],
    warnings,
  }
}

// --- The bid ----------------------------------------------------------------

export interface LinkValueInput {
  /**
   * Monthly revenue delta between our current positions and the target ones,
   * across the keywords this campaign is for. From site_keyword_targets and
   * resolveKeywordEconomics.
   */
  prizeMicrosPerMonth: Micros | null
  /** Median non-platform referring domains on the target SERPs. The wall. */
  serpAuthorityWall: number | null
  /** Our own referring domains. */
  ourReferringDomains: number | null
  /**
   * P(the campaign moves rankings AND nothing gets penalised).
   *
   * MODELLED, with nothing behind it, and it is one of the two terms that most
   * moves the answer. Required rather than defaulted so it never reads as
   * evidence — and note what it has to include: paid links violate Google's
   * link spam policy, so a penalised site is not worth zero, it is worth
   * NEGATIVE. This term carries that downside or the bid is overstated.
   */
  pSuccess: number
  /** Fraction of link value still present at 12 months. MODELLED. */
  decay: number
  /** Months over which the prize is counted. */
  horizonMonths: number
}

export interface LinkValueResult {
  linksNeeded: number | null
  valuePerLinkMicros: Micros | null
  missing: string[]
  /** Terms with no measurement behind them, for the on-screen banner. */
  modelled: string[]
}

export function estimateLinkValue(input: LinkValueInput): LinkValueResult {
  const missing: string[] = []
  if (input.prizeMicrosPerMonth === null) missing.push('prizeMicrosPerMonth')
  if (input.serpAuthorityWall === null) missing.push('serpAuthorityWall')
  if (input.ourReferringDomains === null) missing.push('ourReferringDomains')

  const modelled = ['pSuccess', 'decay']

  if (missing.length > 0) {
    return { linksNeeded: null, valuePerLinkMicros: null, missing, modelled }
  }

  /**
   * At least 1, always. A site already at or above the wall does not need zero
   * links — the wall is a median, not a threshold, and dividing by zero would
   * report an infinite value per link on exactly the SERPs where we least need
   * to buy.
   */
  const linksNeeded = Math.max(
    1,
    Math.round((input.serpAuthorityWall as number) - (input.ourReferringDomains as number)),
  )

  const prize = (input.prizeMicrosPerMonth as Micros) * BigInt(Math.max(1, Math.round(input.horizonMonths)))
  const adjustedBps = BigInt(Math.round(input.pSuccess * input.decay * 10_000))
  const valuePerLinkMicros = (prize * adjustedBps) / 10_000n / BigInt(linksNeeded)

  return { linksNeeded, valuePerLinkMicros, missing: [], modelled }
}

/**
 * How much THIS placement is worth relative to the average.
 *
 * Three factors, all bounded, all named:
 *
 *   traffic       more real traffic, more real link. Log-scaled — the
 *                 difference between 1k and 10k monthly visits matters far more
 *                 than between 100k and 1M.
 *   authority     dfsRank as a mild tie-breaker, NOT the primary term (§0.1)
 *   marketplace   falls with competitor count. This is the §0.2 signal priced
 *                 in: a link everyone in the niche has bought is worth less
 *                 than an editorial one at identical metrics, because it sits
 *                 in a cluster that is visible to anyone looking.
 */
export function qualityMultiplier(signals: ProspectSignals): number {
  const etv = Math.max(0, signals.organicEtv ?? 0)
  // 1.0 at ~10k ETV, ~1.3 at 100k, ~0.7 at 1k. Bounded either side.
  const traffic = clamp(0.4 + Math.log10(etv + 10) / 5, 0.4, 1.6)

  const rank = signals.dfsRank ?? 0
  const authority = clamp(0.7 + rank / 2000, 0.7, 1.2)

  /**
   * 1.0 at a single competitor, 0.4 at six or more. Deliberately steep: the
   * strongest argument in the plan for weighting AGAINST high counts is that
   * the easiest placements to buy are the ones that put our sites in the same
   * visible cluster as everyone else's.
   */
  const marketplace = clamp(1 - Math.max(0, signals.competitorLinkCount - 1) * 0.12, 0.4, 1)

  return traffic * authority * marketplace
}

export interface BidInput {
  value: LinkValueResult
  signals: ProspectSignals
  /**
   * How far below computed value we are willing to bid. POLICY.
   *
   * 2 means "only pay half what we think it is worth", which is the honest
   * response to pSuccess and decay being guesses.
   */
  safetyMargin?: number
}

export interface BidResult {
  maxBidMicros: Micros | null
  qualityMultiplier: number
  reason: string
}

export const DEFAULT_SAFETY_MARGIN = 2

export function computeMaxBid(input: BidInput): BidResult {
  const q = qualityMultiplier(input.signals)
  const margin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN

  if (input.value.valuePerLinkMicros === null) {
    return {
      maxBidMicros: null,
      qualityMultiplier: q,
      reason: `Not computable — missing: ${input.value.missing.join(', ')}`,
    }
  }

  const maxBidMicros =
    (input.value.valuePerLinkMicros * BigInt(Math.round(q * 10_000))) /
    10_000n /
    BigInt(Math.max(1, Math.round(margin)))

  return {
    maxBidMicros,
    qualityMultiplier: q,
    reason:
      `${input.value.linksNeeded} link(s) needed · quality ×${q.toFixed(2)} · ` +
      `${margin}× safety margin. pSuccess and decay are modelled with nothing behind them.`,
  }
}

/** The sentence that must appear beside any bid. Generated next to the model. */
export function bidDisclosure(): string {
  return (
    'This is what a link would have to be worth to justify the price — not a prediction that it ' +
    'will work. pSuccess and decay are modelled with no measurement behind them, and pSuccess must ' +
    'carry the downside that a penalised site is worth negative, not zero.'
  )
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}
