/**
 * Stage 4 — assign exactly one status, and Stage 6 — rank what survives.
 *
 * Every input here is a signal gathered by a cheaper stage. Nothing in this
 * file performs I/O, so the whole decision is unit-testable and a disputed row
 * can be replayed from its stored signals.
 */

export type DomainStatus =
  /** Not registered. Buy it at retail. */
  | 'AVAILABLE'
  /** In the 5-day drop window. Only reachable by backorder (DropCatch et al). */
  | 'PENDING_DELETE'
  /** Expired, ~30-day owner grace. Redeemable by the owner, not by us, yet. */
  | 'REDEMPTION'
  /** Registered, expiry inside the watch window. Worth queueing a backorder. */
  | 'EXPIRING_SOON'
  /** Registered and renewed, but nothing is served. The broker-approach bucket. */
  | 'PARKED_DEAD'
  /** Redirects off-domain to an unrelated brand — someone already bought it. */
  | 'ACQUIRED_301'
  /** A real business is serving real content. Not a candidate. */
  | 'LIVE'
  /**
   * A server is running and returning 5xx.
   *
   * Not a candidate: an erroring host is an active, paid-for host. The domain
   * may still lapse later, but right now somebody is running a server on it,
   * and that is evidence against abandonment rather than for it.
   */
  | 'BROKEN'
  /**
   * Triage never concluded — the probe timed out, was blocked, or the site
   * failed in a way that proves nothing.
   *
   * ============ WHY THIS EXISTS DESPITE THE SPEC'S SEVEN ============
   * The spec lists seven statuses and assumes triage always reaches one. It
   * does not: slow hosts, bot protection and broken TLS all end in silence.
   * Those rows were landing in PARKED_DEAD, so one label meant both "nothing is
   * served" and "we could not look".
   *
   * That is not cosmetic. quixservice.com -- 3 A records, 2 nameservers, expiry
   * 402 days out -- was reported as a top acquisition target holding a BBB
   * citation, on the strength of a probe that had returned nothing at all. An
   * operator cannot audit a distinction the schema refuses to make.
   * =================================================================
   */
  | 'UNKNOWN'

/** Default watch window for EXPIRING_SOON, in days. */
export const EXPIRING_SOON_DAYS = 90

export interface HttpTriage {
  /**
   * What the HTTP probe concluded.
   *  - `dead`      — connection refused, host absent, or 404
   *  - `broken`    — 5xx: a server IS running and failing. Hosting is active.
   *  - `parked`    — parking page, for-sale page, or registrar placeholder
   *  - `redirect`  — landed off-domain on a different registrable domain
   *  - `live`      — real content served from the domain
   *  - `unknown`   — probe did not complete; do not treat as evidence of life
   */
  outcome: 'dead' | 'broken' | 'parked' | 'redirect' | 'live' | 'unknown'
  /** Registrable domain the redirect chain ended on, when it left the domain. */
  redirectedTo?: string | null
}

export interface DnsTriage {
  hasNameservers: boolean
  /** Nameserver matched a known parking operator. */
  parkingNameserver: string | null
  hasAddressRecord: boolean
}

export interface RdapFacts {
  /**
   * Whether the domain is registered at all. `null` means RDAP did not answer —
   * which is not the same as available, and never classified as such.
   */
  registered: boolean | null
  createdAt: Date | null
  expiresAt: Date | null
  registrar: string | null
  /** Normalized EPP status codes, lowercase (`pending delete`, `redemption period`). */
  statuses: string[]
}

export interface ClassifyInput {
  dns?: DnsTriage | null
  http?: HttpTriage | null
  rdap?: RdapFacts | null
  /**
   * Best organic position this domain was seen at in our own SERP data.
   *
   * ============ THE STRONGEST FREE SIGNAL WE HAD AND IGNORED ============
   * Google does not rank domains that serve nothing. If a page refuses our
   * probe AND refuses a rendering crawler, but Google is listing it at #4,
   * the site is alive and blocking us -- that is a completely different fact
   * from "nothing is served", and it costs nothing to know.
   *
   * merriam-webster.com sat in UNKNOWN while ranked #4. So did
   * olshanfoundation.com, johnmooreservices.com and poweroutage.us at #6.
   * ======================================================================
   */
  serpRank?: number | null
  /** Most recent Wayback snapshot that returned content, if known. */
  lastContentSnapshotAt?: Date | null
  /** Domain has MX records — mail is configured. */
  hasMx?: boolean | null
  /** Registrar availability API, when one is configured. Overrides RDAP inference. */
  registrarAvailable?: boolean | null
  now?: Date
  expiringSoonDays?: number
}

export interface Classification {
  status: DomainStatus
  /** Human-readable justification, stored on the row so a call can be audited. */
  reason: string
  /** Days until expiry when known and in the future. */
  daysToExpiry: number | null
  /** Domain age in years when the creation date is known. */
  ageYears: number | null
  /**
   * Whether the triage stages actually proved something.
   *
   * False means we never got a straight answer — a timed-out or blocked HTTP
   * probe on a domain that otherwise looks healthy. The status still has to be
   * one of the seven, so such a row lands in PARKED_DEAD, and this flag is what
   * stops it being ranked as though we had confirmed it was dead.
   */
  conclusive: boolean
}

const DAY_MS = 86_400_000

/**
 * Domain brokers and marketplaces.
 *
 * A domain sitting on one of these is inventory: it is for sale, which makes it
 * a candidate, not a competitor's asset and not a live business.
 */
export const DOMAIN_MARKETPLACES: readonly string[] = [
  'hugedomains.com',
  'afternic.com',
  'dan.com',
  'sedo.com',
  'undeveloped.com',
  'brandbucket.com',
  'squadhelp.com',
  'atom.com',
  'buydomains.com',
  'domainmarket.com',
  'saw.com',
  'flippa.com',
  'godaddy.com',
  'namecheap.com',
  'domainagents.com',
  'efty.com',
  'parkingcrew.net',
  'bodis.com',
  'sedoparking.com',
]

export function isDomainMarketplace(domain: string | null | undefined): boolean {
  if (!domain) return false
  const d = domain.trim().toLowerCase()
  return DOMAIN_MARKETPLACES.some((m) => d === m || d.endsWith(`.${m}`))
}

const hasStatus = (statuses: string[], needle: string): boolean =>
  statuses.some((s) => s.toLowerCase().replace(/[_-]/g, ' ').includes(needle))

/**
 * Assign exactly one status.
 *
 * Precedence follows the cost order of the stages that produced the evidence,
 * with one deliberate exception: a domain serving real content is LIVE no
 * matter what its expiry says. A working business site with a renewal due in
 * six weeks is not an acquisition candidate, it is a business that is about to
 * renew, and putting it in EXPIRING_SOON would fill the report with false
 * positives that each cost an operator a manual check to dismiss.
 */
export function classifyDomain(input: ClassifyInput): Classification {
  const now = input.now ?? new Date()
  const window = input.expiringSoonDays ?? EXPIRING_SOON_DAYS
  const { dns, http, rdap } = input

  const createdAt = rdap?.createdAt ?? null
  const expiresAt = rdap?.expiresAt ?? null
  const ageYears =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? Math.max(0, (now.getTime() - createdAt.getTime()) / (DAY_MS * 365.25))
      : null
  const daysToExpiry =
    expiresAt && !Number.isNaN(expiresAt.getTime())
      ? Math.round((expiresAt.getTime() - now.getTime()) / DAY_MS)
      : null

  const done = (
    status: DomainStatus,
    reason: string,
    conclusive = true,
  ): Classification => ({
    status,
    reason,
    daysToExpiry,
    ageYears,
    conclusive,
  })

  const statuses0 = rdap?.statuses ?? []

  /**
   * ============ THE REGISTRY OUTRANKS THE PAGE ============
   * These checks sit ABOVE the LIVE short-circuit deliberately.
   *
   * A domain in redemptionPeriod or pendingDelete IS expired. The registrar
   * very often keeps serving something on it -- a parking page, an ad feed, a
   * "this domain may be for sale" splash -- and a marketplace page can easily
   * be long enough and un-templated enough to read as real content. Letting
   * "something is served" outrank the registry would silently drop exactly the
   * domains this tool exists to find.
   *
   * Same for an unregistered domain: if RDAP has no record, nothing served on
   * it can make it unavailable.
   * =======================================================
   */
  if (input.registrarAvailable === true) {
    return done('AVAILABLE', 'Registrar availability API reports unregistered')
  }
  if (input.registrarAvailable !== false && rdap?.registered === false) {
    return done('AVAILABLE', 'RDAP has no record for this domain')
  }
  if (hasStatus(statuses0, 'pending delete')) {
    return done('PENDING_DELETE', 'RDAP status pendingDelete — drop window, backorder only')
  }
  if (hasStatus(statuses0, 'redemption')) {
    return done('REDEMPTION', 'RDAP status redemptionPeriod — expired, owner grace ~30 days')
  }

  // A live site ends the enquiry, exactly as Stage 3c does.
  if (http?.outcome === 'live') {
    return done('LIVE', 'Serving live business content')
  }

  /**
   * ============ AN EXPIRY DATE IS NOT AN OPPORTUNITY ============
   * Every domain expires; almost every domain renews. EXPIRING_SOON is only
   * meaningful once we have ESTABLISHED the site is not live, and two guards
   * enforce that:
   *
   * 1. Triage must have concluded. tesla.com returned 403 to our probe, so
   *    LIVE could not fire, and this branch then claimed "expires in 88 days"
   *    about a domain that obviously renews. An unreadable site is UNKNOWN.
   *
   * 2. Registry delete-locks mean actively managed. `serverDeleteProhibited`
   *    is set by the registry on domains nobody is letting go -- tesla.com
   *    carries it alongside MarkMonitor, a corporate brand-protection
   *    registrar. `clientDeleteProhibited` alone is far too common to mean
   *    anything, so only the server-level lock disqualifies.
   * ==============================================================
   */
  const conclusivelyNotLive = http?.outcome === 'dead' || http?.outcome === 'parked'
  const registryLocked = hasStatus(statuses0, 'server delete prohibited')

  if (
    daysToExpiry !== null &&
    daysToExpiry >= 0 &&
    daysToExpiry <= window &&
    conclusivelyNotLive &&
    !registryLocked
  ) {
    return done('EXPIRING_SOON', `Expires in ${daysToExpiry} day(s), and nothing is served`)
  }

  if (http?.outcome === 'redirect' && http.redirectedTo) {
    /**
     * A redirect to a MARKETPLACE is a for-sale sign, not an acquisition.
     * aaatotal.com pointing at hugedomains.com was being reported as
     * ACQUIRED_301 -- "someone already bought it" -- when it is in fact a
     * broker inviting offers, which is a live lead.
     */
    if (isDomainMarketplace(http.redirectedTo)) {
      return done('PARKED_DEAD', `Listed for sale via ${http.redirectedTo}`)
    }
    return done('ACQUIRED_301', `Redirects off-domain to ${http.redirectedTo}`)
  }

  if (http?.outcome === 'broken') {
    return done('BROKEN', 'Server responding but erroring (5xx) — hosting is active')
  }
  if (http?.outcome === 'parked') {
    return done('PARKED_DEAD', 'Parking or for-sale page served')
  }
  if (http?.outcome === 'dead') {
    return done('PARKED_DEAD', 'Registered but nothing is served')
  }
  if (dns && !dns.hasAddressRecord) {
    return done('PARKED_DEAD', 'Registered with no address record')
  }
  if (dns?.parkingNameserver) {
    return done('PARKED_DEAD', `Parking nameserver ${dns.parkingNameserver}`)
  }

  /**
   * The probe told us nothing. Before giving up, use what we already know.
   *
   * Only `serpRank` is allowed to decide. Mail can outlive a website, and
   * Wayback counts any 200 + HTML as content -- including a parking page -- so
   * neither proves a business exists. They are recorded as supporting detail
   * and nothing more, because a signal that cannot distinguish a parked domain
   * from a live one must not be allowed to call one live.
   */
  const supporting: string[] = []
  if (input.hasMx) supporting.push('mail configured')
  if (input.lastContentSnapshotAt) {
    const days = Math.round((now.getTime() - input.lastContentSnapshotAt.getTime()) / DAY_MS)
    if (days >= 0) supporting.push(`archived ${days}d ago`)
  }
  const suffix = supporting.length > 0 ? ` (${supporting.join(', ')})` : ''

  if (input.serpRank != null && input.serpRank > 0) {
    return done(
      'LIVE',
      `Ranked #${input.serpRank} organically — the probe was blocked, not the site${suffix}`,
    )
  }

  // Nothing proved life and nothing proved death. Say exactly that.
  return done('UNKNOWN', `No conclusive signal; triage did not complete${suffix}`, false)
}

/**
 * Statuses worth putting in front of an operator as candidates, best-first.
 *
 * UNKNOWN is deliberately absent. Those rows are real and worth showing, but
 * they are a "go look yourself" pile, not a shortlist, and mixing them in is
 * how an unreadable live site reaches the top of a ranked list.
 */
export const ACQUIRABLE_STATUSES: readonly DomainStatus[] = [
  'AVAILABLE',
  'PENDING_DELETE',
  'REDEMPTION',
  'EXPIRING_SOON',
  'PARKED_DEAD',
  'ACQUIRED_301',
]

export interface ScoreInput {
  status: DomainStatus
  ageYears: number | null
  trustFlow: number | null
  citationFlow: number | null
  referringDomains: number | null
  /**
   * Referring SUBNETS, not domains. The spec asks for it because 400 referring
   * domains across 6 subnets is one person's link farm, while 40 domains across
   * 38 subnets is genuine editorial history.
   */
  referringSubnets: number | null
  /** Share (0-100) of Topical Trust Flow in a category relevant to the niche. */
  topicalRelevancePct: number | null
  yearsOfContent: number | null
  /** More than one business on the domain — a roll-up or shared template. */
  businessCount: number
  /** False when triage never proved the domain was actually dead. */
  conclusiveTriage?: boolean
}

export interface Score {
  /** 0-100. A ranking aid, not a valuation. */
  total: number
  components: Record<string, number>
  /** Signals that were missing, so a low score is not read as a low-value domain. */
  missing: string[]
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * Rank acquisition candidates.
 *
 * ============================ WHAT THIS IS NOT ============================
 * This is a transparent, additive heuristic for SORTING a long list, not an
 * appraisal. The weights are a starting point chosen to reflect the spec's own
 * emphasis (age is "a primary value driver"; subnets over raw referring
 * domains), and they have not been calibrated against realised acquisition
 * outcomes, because no such outcome data exists in this system yet.
 *
 * `missing` is returned alongside for that reason: a domain that scores 20
 * because Majestic was never configured is a different thing from one that
 * scores 20 on complete data, and the UI must be able to tell them apart.
 * =========================================================================
 */
export function scoreDomain(input: ScoreInput): Score {
  const components: Record<string, number> = {}
  const missing: string[] = []

  // Age — up to 25. Ramps to full credit at 15 years.
  if (input.ageYears === null) {
    missing.push('age')
    components['age'] = 0
  } else {
    components['age'] = clamp((input.ageYears / 15) * 25, 0, 25)
  }

  // Trust Flow — up to 25. TF is 0-100 but rarely exceeds 40 for local sites.
  if (input.trustFlow === null) {
    missing.push('trustFlow')
    components['trustFlow'] = 0
  } else {
    components['trustFlow'] = clamp((input.trustFlow / 40) * 25, 0, 25)
  }

  // Referring subnets — up to 20. Full credit at 50 distinct subnets.
  if (input.referringSubnets === null) {
    missing.push('referringSubnets')
    components['referringSubnets'] = 0
  } else {
    components['referringSubnets'] = clamp((input.referringSubnets / 50) * 20, 0, 20)
  }

  // A TF far below CF is the classic spam-link signature; penalise up to -10.
  if (input.trustFlow !== null && input.citationFlow !== null && input.citationFlow > 0) {
    const ratio = input.trustFlow / input.citationFlow
    components['trustRatio'] = ratio < 0.35 ? -10 * (1 - ratio / 0.35) : 0
  }

  // Topical relevance — up to 15.
  if (input.topicalRelevancePct === null) {
    missing.push('topicalRelevance')
    components['topicalRelevance'] = 0
  } else {
    components['topicalRelevance'] = clamp((input.topicalRelevancePct / 60) * 15, 0, 15)
  }

  // Years of real archived content — up to 15. Full credit at 10 years.
  if (input.yearsOfContent === null) {
    missing.push('yearsOfContent')
    components['yearsOfContent'] = 0
  } else {
    components['yearsOfContent'] = clamp((input.yearsOfContent / 10) * 15, 0, 15)
  }

  // Acquirability — how much standing between us and the domain.
  const acquirability: Record<DomainStatus, number> = {
    AVAILABLE: 10,
    PENDING_DELETE: 7,
    EXPIRING_SOON: 5,
    REDEMPTION: 3,
    PARKED_DEAD: 2,
    ACQUIRED_301: 0,
    LIVE: 0,
    BROKEN: 0,
    UNKNOWN: 0,
  }
  // An unproven row scores no acquirability credit and is reported as missing
  // that signal. Without this an old, well-archived domain that merely timed
  // out ranks alongside one we confirmed is dead — which is how a live
  // manufacturer's site reached second place in a real run.
  if (input.conclusiveTriage === false) {
    components['acquirability'] = 0
    missing.push('triage')
  } else {
    components['acquirability'] = acquirability[input.status]
  }

  const total = clamp(
    Object.values(components).reduce((a, b) => a + b, 0),
    0,
    100,
  )
  return { total: Math.round(total * 10) / 10, components, missing }
}
