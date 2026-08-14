import type { DomainStatus } from './classify.js'

/**
 * Is this domain worth acquiring, and by which route?
 *
 * ==================== WHY THIS IS A SEPARATE JUDGEMENT FROM scoreDomain ======
 * `scoreDomain` produces a 0-100 number for SORTING a list. It deliberately
 * renormalises around missing signals so that an unmeasured domain is not
 * pushed to the bottom -- which is right for ranking and wrong for deciding.
 *
 * This answers a different question: would an operator actually spend money
 * here, and would they spend it at a registrar or on an email? Those are
 * different actions with different economics, and collapsing them into one
 * ranked list is what made the first pass of this feature recommend a spam-46
 * domain as its top available find.
 * ===========================================================================
 *
 * Every threshold below is set from a measurement recorded in
 * plan-domain-search-coverage.md or plan-defunct-domain-discovery.md, and each
 * one is named at its constant. None is a matter of taste.
 */

export type AcquisitionVerdict =
  /** Obtainable now, with a real past and surviving equity. Register or backorder. */
  | 'BUY'
  /** Someone still owns it and has stopped caring. The warm-outreach population. */
  | 'OUTREACH'
  /** Reachable and measured, but not worth money. */
  | 'NEITHER'
  /**
   * A required signal was never measured.
   *
   * NOT folded into NEITHER. "We checked and it is worthless" and "we never
   * checked" are different facts, and a rate that silently merges them
   * understates or overstates the yield depending on which way the gaps fall.
   * This is the repo's first rule applied to the experiment's own arithmetic.
   */
  | 'UNKNOWN_VALUE'

/**
 * Spam at or above this is a liability, not an asset.
 *
 * Measured: the coverage plan found 6 of the top 10 candidates in a live market
 * carrying spam 37-49 and called them liabilities. 30 sits below that band with
 * room to spare.
 */
export const SPAM_CEILING = 30

/**
 * Measured: of four AVAILABLE domains recovered from a 2013 archive, three had
 * 0-2 referring domains and one had 34. The gap is the signal.
 */
export const MIN_REFERRING_DOMAINS_BUY = 5

/**
 * Owned-but-idle domains are only worth an email if there is something to buy.
 * Set higher than the BUY bar because outreach costs operator time per domain,
 * where a registration costs $12 and no conversation.
 */
export const MIN_REFERRING_DOMAINS_OUTREACH = 20

/**
 * Above this, it is not a local business.
 *
 * ==================== ADDED AFTER THE FIRST STEP-0 RUN ====================
 * The first outreach list, sorted by referring domains, opened with
 * `networkadvertising.org` at 488,603 and continued through three Sears
 * domains, `openx.net` and `epri.com`. Every one arrived as a legitimate
 * outbound link from an archived directory page, and every one is useless: this
 * product buys LOCAL service domains.
 *
 * The named offenders are excluded by INFRASTRUCTURE_HOSTS, but a blocklist
 * only ever catches what has already been seen. A local plumber does not have
 * five thousand referring domains, so the shape of the profile is the general
 * test and the blocklist is the specific one.
 *
 * Deliberately generous: 500 is far above any local operator measured here
 * (`daveburns.com`, a real live plumber, has 295) and far below the national
 * brands it exists to reject.
 * =========================================================================
 */
export const MAX_REFERRING_DOMAINS_LOCAL = 500

/**
 * Measured: `buildingwatersplumbers.com` had one year of archived content and
 * two referring domains -- a parked page, not a business that existed. Three
 * years is the shortest span that implies somebody was actually trading.
 */
export const MIN_YEARS_OF_CONTENT = 3

/** Statuses an operator can obtain without asking anyone's permission. */
const OBTAINABLE: ReadonlySet<DomainStatus> = new Set<DomainStatus>([
  'AVAILABLE',
  'PENDING_DELETE',
  'REDEMPTION',
])

/**
 * Statuses where somebody still holds the registration.
 *
 * `UNKNOWN` is included deliberately: triage failing to conclude is not evidence
 * the domain is worthless, and `drainsruswi.com` -- 78 referring domains, spam
 * 15, eight years of content -- was the single best asset the archive probe
 * recovered and it landed here. Excluding UNKNOWN would have dropped it.
 */
const OWNED_BUT_IDLE: ReadonlySet<DomainStatus> = new Set<DomainStatus>([
  'PARKED_DEAD',
  'BROKEN',
  'EXPIRING_SOON',
  'ACQUIRED_301',
  'UNKNOWN',
])

export interface AcquisitionInput {
  status: DomainStatus
  /** Null = Wayback did not answer. Never treated as zero. */
  yearsOfContent: number | null
  /** Null = the backlinks index was never asked. Never treated as zero. */
  referringDomains: number | null
  /** Null = the spam gate never ran. Never treated as clean. */
  spamScore: number | null
}

export interface AcquisitionAssessment {
  verdict: AcquisitionVerdict
  /** Plain-language justification, so a disputed row can be argued with. */
  reason: string
  /** Signals that were null. Non-empty implies UNKNOWN_VALUE. */
  missing: string[]
}

/**
 * A LIVE business is never a candidate by either route, and that decision needs
 * no measurements at all -- so it is made before anything is checked for
 * nullity. Otherwise every live business with an unmeasured spam score would be
 * reported as UNKNOWN_VALUE and inflate the "we could not tell" bucket.
 */
export function assessAcquisition(input: AcquisitionInput): AcquisitionAssessment {
  if (input.status === 'LIVE') {
    return { verdict: 'NEITHER', reason: 'A live business is serving content', missing: [] }
  }

  const obtainable = OBTAINABLE.has(input.status)
  const ownedIdle = OWNED_BUT_IDLE.has(input.status)
  if (!obtainable && !ownedIdle) {
    return { verdict: 'NEITHER', reason: `Status ${input.status} is not a route`, missing: [] }
  }

  /**
   * Which signals this row NEEDED, not which exist in general.
   *
   * Archive depth only gates BUY: an owned domain with 78 referring domains is
   * a live asset whether or not Wayback managed to answer, so demanding archive
   * history for OUTREACH would discard rows on a signal that is not load
   * bearing for that route.
   */
  const missing: string[] = []
  if (input.referringDomains === null) missing.push('referringDomains')
  if (input.spamScore === null) missing.push('spamScore')
  if (obtainable && input.yearsOfContent === null) missing.push('yearsOfContent')

  if (missing.length > 0) {
    return {
      verdict: 'UNKNOWN_VALUE',
      reason: `Not assessable — never measured: ${missing.join(', ')}`,
      missing,
    }
  }

  // Non-null from here: the guard above returned on every null.
  const refdom = input.referringDomains as number
  const spam = input.spamScore as number
  const years = input.yearsOfContent

  if (spam >= SPAM_CEILING) {
    return {
      verdict: 'NEITHER',
      reason: `Spam score ${spam} is at or above the ${SPAM_CEILING} liability line`,
      missing: [],
    }
  }

  if (refdom > MAX_REFERRING_DOMAINS_LOCAL) {
    return {
      verdict: 'NEITHER',
      reason: `${refdom} referring domains — a national or infrastructure domain, not a local operator`,
      missing: [],
    }
  }

  if (obtainable) {
    if ((years as number) < MIN_YEARS_OF_CONTENT) {
      return {
        verdict: 'NEITHER',
        reason: `Only ${years}y of archived content — no business existed here long enough to matter`,
        missing: [],
      }
    }
    if (refdom < MIN_REFERRING_DOMAINS_BUY) {
      return {
        verdict: 'NEITHER',
        reason: `${refdom} referring domain(s) — a business existed but its equity did not survive`,
        missing: [],
      }
    }
    return {
      verdict: 'BUY',
      reason: `${years}y of content, ${refdom} referring domains, spam ${spam} — obtainable with equity intact`,
      missing: [],
    }
  }

  if (refdom < MIN_REFERRING_DOMAINS_OUTREACH) {
    return {
      verdict: 'NEITHER',
      reason: `${refdom} referring domain(s) — not enough to be worth an approach`,
      missing: [],
    }
  }
  return {
    verdict: 'OUTREACH',
    reason: `Still owned (${input.status}) with ${refdom} referring domains and spam ${spam} — approach the owner`,
    missing: [],
  }
}
