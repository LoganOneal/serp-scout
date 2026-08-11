import type { Blocker, DifficultyResult, EmdAssessment, Gate, Verdict } from '../types.js'
import {
  MIN_WEIGHT_COVERED_FOR_VERDICT,
  NINETY_DAY_MAX_DIFFICULTY,
  NOT_WINNABLE_COMMITTED_TOP5_COUNT,
  NOT_WINNABLE_MIN_REF_DOMAINS_TOP5,
  NOT_WINNABLE_POS1_REF_DOMAINS,
  SIX_MONTH_MAX_DIFFICULTY,
  SIX_MONTH_MIN_COMMITTED_TOP5,
  THIRTY_DAY_MAX_DIFFICULTY,
  THIRTY_DAY_MAX_EXACT_MATCH_TOP5,
  THIRTY_DAY_MAX_MEDIAN_REF_DOMAINS,
  THIRTY_DAY_MIN_PLATFORM_SLOTS,
  THIRTY_DAY_MIN_VOLUME,
} from './priors.js'

/**
 * Can `{locality}{niche}.com` rank here, and roughly how fast?
 *
 * Emits a BAND with named blockers, never a probability.
 *
 * WHY NOT a probability: the honest inputs are an unconditional base rate
 * (1.74% of new pages reach the top 10 within a year) and a conditional one
 * (~40.8% of pages that get there arrive within a month). We have no measured
 * conditional distribution over SERP softness -- only a plausible story about
 * one. Combining them into "72% chance" would be invention dressed as
 * measurement, on a screen someone buys domains from. A band plus the specific
 * reasons it isn't a better band is defensible; a number is not.
 */

export interface EmdInput {
  /** The candidate domain, e.g. `kenoshatreeservice.com`. */
  domain: string
  difficulty: DifficultyResult
  /** Modelled monthly searches. Estimated, see demand.ts. */
  volume: number
  /**
   * Three states, and they are not interchangeable. `null` means we could not
   * tell -- a rate-limited registry is not a yes.
   */
  domainAvailable: boolean | null
  /** Did Google return a local pack for this query in this locality? */
  hasLocalPack: boolean
  /** Is the candidate EMD itself already in these results? */
  emdAlreadyRanks: boolean
}

export function assessEmd(input: EmdInput): EmdAssessment {
  const d = input.difficulty
  const blockers: Blocker[] = []

  // ---------------------------------------------------------------------
  // Hard blockers. Any one of these is fatal regardless of difficulty.
  // ---------------------------------------------------------------------

  if (d.localBusinessesTop5Dedicated >= NOT_WINNABLE_COMMITTED_TOP5_COUNT) {
    blockers.push({
      code: 'committed_operators_top5',
      message: `${d.localBusinessesTop5Dedicated} of the top 5 are committed local operators. This market is already contested by people who will notice you.`,
      threshold: `>= ${NOT_WINNABLE_COMMITTED_TOP5_COUNT} top-5 local businesses with dedication >= 0.7`,
    })
  }

  if (
    d.minNonPlatformRefDomains !== null &&
    d.minNonPlatformRefDomains >= NOT_WINNABLE_MIN_REF_DOMAINS_TOP5
  ) {
    blockers.push({
      code: 'min_refdomains_too_high',
      message: `Even the weakest real defender has ${d.minNonPlatformRefDomains} referring main domains. A new domain cannot reach this page.`,
      threshold: `min refdomains among non-platform results >= ${NOT_WINNABLE_MIN_REF_DOMAINS_TOP5}`,
    })
  }

  if (
    d.pos1NonPlatformRefDomains !== null &&
    d.pos1NonPlatformRefDomains >= NOT_WINNABLE_POS1_REF_DOMAINS
  ) {
    blockers.push({
      code: 'pos1_fortress',
      message: `Position 1 is held by a real site with ${d.pos1NonPlatformRefDomains} referring main domains.`,
      threshold: `position-1 non-platform refdomains >= ${NOT_WINNABLE_POS1_REF_DOMAINS}`,
    })
  }

  if (input.emdAlreadyRanks) {
    blockers.push({
      code: 'emd_already_ranks',
      message: `${input.domain} already ranks on this SERP -- somebody has built this exact site.`,
      threshold: 'target EMD present in results',
    })
  }

  if (!input.hasLocalPack && !d.hasLocalBusinessTop10) {
    // The most valuable blocker in the list, because this SERP looks WIDE OPEN
    // on every structural signal: no local operators means no defenders, so
    // difficulty scores very low. It is not an opportunity -- Google does not
    // treat this query as local here, so a local site will never rank for it
    // no matter how well built. A guaranteed wasted build that the rest of the
    // model actively recommends.
    blockers.push({
      code: 'not_a_local_query',
      message:
        'No local pack and no local business in the top 10 -- Google does not treat this as a local query here. Structurally this SERP looks wide open, and it is a guaranteed wasted build.',
      threshold: 'no local pack AND no local business in top 10',
    })
  }

  if (blockers.length > 0) {
    return {
      domain: input.domain,
      verdict: 'not_winnable',
      blockers,
      gates: thirtyDayGates(input),
    }
  }

  // ---------------------------------------------------------------------
  // Not enough measured signal to make any claim.
  // ---------------------------------------------------------------------

  if (d.difficulty === null) {
    return {
      domain: input.domain,
      verdict: 'unknown',
      blockers: [
        {
          code: 'nothing_measured',
          message: 'No scoring component could be measured for this SERP.',
          threshold: null,
        },
      ],
      gates: thirtyDayGates(input),
    }
  }

  if (d.weightCovered < MIN_WEIGHT_COVERED_FOR_VERDICT) {
    return {
      domain: input.domain,
      verdict: 'unknown',
      blockers: [
        {
          code: 'insufficient_coverage',
          message: `Only ${Math.round(d.weightCovered * 100)}% of scoring signals were measured. Not enough to place a band.`,
          threshold: `weightCovered >= ${MIN_WEIGHT_COVERED_FOR_VERDICT}`,
        },
      ],
      gates: thirtyDayGates(input),
    }
  }

  // ---------------------------------------------------------------------
  // The 30-day band. ALL gates must pass.
  // ---------------------------------------------------------------------

  const gates = thirtyDayGates(input)
  const failed = gates.filter((g) => g.passed !== true)

  if (failed.length === 0) {
    return { domain: input.domain, verdict: 'likely_30d', blockers: [], gates }
  }

  // Not 30-day: report every failed gate as a named blocker so the operator can
  // see exactly what is missing rather than an opaque downgrade.
  const downgrade: Blocker[] = failed.map((g) => ({
    code: `gate_${g.code}`,
    message: g.detail,
    threshold: g.label,
  }))

  // A count of real defenders overrides the page average -- see
  // SIX_MONTH_MIN_COMMITTED_TOP5. You do not have to beat the mean, you have to
  // beat the people holding the slots.
  if (
    d.localBusinessesTop5Dedicated >= SIX_MONTH_MIN_COMMITTED_TOP5 &&
    d.difficulty <= SIX_MONTH_MAX_DIFFICULTY
  ) {
    return {
      domain: input.domain,
      verdict: 'likely_6m',
      blockers: [
        ...downgrade,
        {
          code: 'committed_operators_present',
          message: `${d.localBusinessesTop5Dedicated} committed local operators in the top 5. Aggregate difficulty is only ${d.difficulty}, but you have to displace them individually, not beat the page average.`,
          threshold: `>= ${SIX_MONTH_MIN_COMMITTED_TOP5} committed top-5 operators caps the band at 6 months`,
        },
      ],
      gates,
    }
  }

  if (d.difficulty <= NINETY_DAY_MAX_DIFFICULTY) {
    return { domain: input.domain, verdict: 'likely_90d', blockers: downgrade, gates }
  }
  if (d.difficulty <= SIX_MONTH_MAX_DIFFICULTY) {
    return { domain: input.domain, verdict: 'likely_6m', blockers: downgrade, gates }
  }
  return {
    domain: input.domain,
    verdict: 'not_winnable',
    blockers: [
      ...downgrade,
      {
        code: 'difficulty_above_ceiling',
        message: `Difficulty ${d.difficulty} is above the ceiling for any winnable band.`,
        threshold: `difficulty <= ${SIX_MONTH_MAX_DIFFICULTY}`,
      },
    ],
    gates,
  }
}

/**
 * The six 30-day gates, always all returned so the detail view can show which
 * ones passed rather than only the first failure.
 *
 * `passed: null` means the gate could not be evaluated, and for THIS band that
 * counts as a failure.
 *
 * ============================ THE ASYMMETRY =============================
 * Everywhere else in this model, an unmeasured signal is dropped leniently:
 * omitted from the difficulty score, weights renormalised, coverage reported.
 * Here it BLOCKS. That inconsistency is deliberate and it is the single rule
 * that protects money.
 *
 * `likely_30d` is the only output that says "go buy this domain and build".
 * Every other band says "wait" or "don't". So this band must be earned by
 * positive evidence, never granted by the absence of contrary evidence. An
 * unchecked domain is not a free one; a registry timeout is not availability;
 * and a SERP whose link profiles we failed to buy is not a soft SERP.
 * ========================================================================
 */
function thirtyDayGates(input: EmdInput): Gate[] {
  const d = input.difficulty

  return [
    {
      code: 'platform_slots',
      label: `>= ${THIRTY_DAY_MIN_PLATFORM_SLOTS} platform-held slots`,
      passed: d.platformHeldSlots >= THIRTY_DAY_MIN_PLATFORM_SLOTS,
      detail: `${d.platformHeldSlots} of 10 slots are held by platforms/directories (need >= ${THIRTY_DAY_MIN_PLATFORM_SLOTS}).`,
    },
    {
      code: 'median_refdomains',
      label: `median non-platform refdomains <= ${THIRTY_DAY_MAX_MEDIAN_REF_DOMAINS}`,
      passed:
        d.medianNonPlatformRefDomains === null
          ? null
          : d.medianNonPlatformRefDomains <= THIRTY_DAY_MAX_MEDIAN_REF_DOMAINS,
      detail:
        d.medianNonPlatformRefDomains === null
          ? 'Median non-platform referring domains was not measured.'
          : `Median non-platform referring main domains is ${d.medianNonPlatformRefDomains} (need <= ${THIRTY_DAY_MAX_MEDIAN_REF_DOMAINS}).`,
    },
    {
      code: 'exact_match_top5',
      label: `<= ${THIRTY_DAY_MAX_EXACT_MATCH_TOP5} exact-match homepage in top 5`,
      passed: d.exactMatchHomepagesTop5 <= THIRTY_DAY_MAX_EXACT_MATCH_TOP5,
      detail: `${d.exactMatchHomepagesTop5} exact-match homepages in the top 5 (allow <= ${THIRTY_DAY_MAX_EXACT_MATCH_TOP5}).`,
    },
    {
      code: 'difficulty',
      label: `difficulty <= ${THIRTY_DAY_MAX_DIFFICULTY}`,
      passed: d.difficulty === null ? null : d.difficulty <= THIRTY_DAY_MAX_DIFFICULTY,
      detail:
        d.difficulty === null
          ? 'Difficulty could not be scored.'
          : `Difficulty is ${d.difficulty} (need <= ${THIRTY_DAY_MAX_DIFFICULTY}).`,
    },
    {
      code: 'volume',
      label: `estimated volume >= ${THIRTY_DAY_MIN_VOLUME}`,
      passed: input.volume >= THIRTY_DAY_MIN_VOLUME,
      detail: `Estimated ${input.volume} monthly searches (need >= ${THIRTY_DAY_MIN_VOLUME}). Estimated from population, not measured.`,
    },
    {
      code: 'domain_available',
      label: 'domain CONFIRMED available',
      // null (couldn't check) is a failure here, not a pass.
      passed: input.domainAvailable === true,
      detail:
        input.domainAvailable === true
          ? `${input.domain} is confirmed available.`
          : input.domainAvailable === false
            ? `${input.domain} is already registered.`
            : `Could not confirm whether ${input.domain} is available. Unconfirmed is not available.`,
    },
    {
      code: 'link_data_measured',
      label: 'link data actually measured',
      passed: d.linkDataMeasured,
      detail: d.linkDataMeasured
        ? 'Referring-domain data was measured for at least one real defender.'
        : 'No referring-domain data was measured for any real defender. A SERP we could not measure is not a soft SERP.',
    },
  ]
}

/**
 * The same assessment, for a domain you intend to BUY rather than register.
 *
 * ==================== WHY THIS IS NOT A MAGIC `true` ====================
 * `assessEmd` will not award `likely_30d` unless the candidate exact-match
 * domain is CONFIRMED available, and that gate is correct when the plan is to
 * register one. It is simply not a constraint when the plan is to acquire an
 * aged domain instead: "can I obtain a domain" is answered by the domain
 * search, not by whether one specific string happens to be free.
 *
 * So availability is passed as satisfied and `emdAlreadyRanks` as false. That
 * is a statement about the ACQUISITION PATH, not a measurement, and it lives in
 * a named function precisely so nobody reads a bare `domainAvailable: true` at
 * a call site and concludes we checked.
 *
 * Every SERP-strength blocker still applies unchanged -- committed operators,
 * the refdomain walls, not_a_local_query. Only the registration gate is lifted.
 * =======================================================================
 */
export function assessAcquiredDomain(
  input: Omit<EmdInput, 'domain' | 'domainAvailable' | 'emdAlreadyRanks'>,
): EmdAssessment {
  return assessEmd({
    ...input,
    // Not a real domain; the acquisition target is chosen later, by the domain
    // search. Named so it cannot be mistaken for a measured candidate.
    domain: '(acquired domain)',
    domainAvailable: true,
    emdAlreadyRanks: false,
  })
}
