/**
 * Which referring domains are high-authority CITATIONS rather than noise.
 *
 * ==================== WHAT THIS IS ACTUALLY FOR ====================
 * An expired domain is worth more when the links it still holds are the ones
 * nobody can buy: a BBB profile, a chamber of commerce member listing, a city
 * licensing page, a trade association directory. Those are earned by having
 * been a real business in a real place, and they survive the business closing.
 *
 * A domain with 400 referring domains that are all blog-comment spam is worth
 * nothing; a domain with six, two of which are bbb.org and the state licensing
 * board, is a genuine asset. Counting links cannot tell those apart. Naming the
 * sources can.
 * ==================================================================
 */

export type AuthorityKind =
  /** Better Business Bureau — the canonical local trust citation. */
  | 'bbb'
  /** Chamber of commerce member directories. */
  | 'chamber'
  /** .gov — licensing boards, city vendor lists, permit records. */
  | 'government'
  /** .edu — rare for a contractor, and very hard to replace. */
  | 'education'
  /** Industry bodies and certification programmes. */
  | 'trade_association'
  /** Mainstream local business directories. */
  | 'directory'
  /** Local press and trade publications. */
  | 'news'

export interface AuthorityMatch {
  domain: string
  kind: AuthorityKind
  /** Why it matched, so a questionable row can be argued with. */
  reason: string
  /** DataForSEO domain rank 0-1000 when known. */
  rank: number | null
  backlinks: number | null
  /**
   * The actual page the link sits on, e.g. the BBB profile itself.
   *
   * ==================== WHY THIS IS NOT OPTIONAL DECORATION ====================
   * Without it the UI could only offer a SEARCH of the directory -- "look for
   * this business on bbb.org" -- and operators reported those links landing on
   * nothing, because a common business name in a big city returns a page of
   * maybes or an empty result. The citation was real; the link was a guess.
   *
   * /backlinks/backlinks/live returns url_from and costs $0.0242 per target,
   * measured off the balance -- the SAME price as the referring-domains
   * endpoint it replaced, which returned only the host.
   * ============================================================================
   */
  urlFrom: string | null
  /**
   * HTTP status of that page when the index last fetched it, and whether the
   * link is still there. A citation on a 404 is still a fact about the domain's
   * history, but it must not be offered as something to click.
   */
  pageStatus: number | null
  isLost: boolean
}

/** Weight per kind when summarising a domain's citation profile. */
export const AUTHORITY_WEIGHT: Record<AuthorityKind, number> = {
  government: 10,
  education: 8,
  bbb: 7,
  chamber: 6,
  trade_association: 5,
  news: 3,
  directory: 2,
}

const EXACT: Array<{ domain: string; kind: AuthorityKind }> = [
  { domain: 'bbb.org', kind: 'bbb' },
  { domain: 'yelp.com', kind: 'directory' },
  { domain: 'yellowpages.com', kind: 'directory' },
  { domain: 'angi.com', kind: 'directory' },
  { domain: 'angieslist.com', kind: 'directory' },
  { domain: 'homeadvisor.com', kind: 'directory' },
  { domain: 'houzz.com', kind: 'directory' },
  { domain: 'thumbtack.com', kind: 'directory' },
  { domain: 'manta.com', kind: 'directory' },
  { domain: 'chamberofcommerce.com', kind: 'chamber' },
  { domain: 'uschamber.com', kind: 'chamber' },
  { domain: 'nrca.net', kind: 'trade_association' },
  { domain: 'acca.org', kind: 'trade_association' },
  { domain: 'phccweb.org', kind: 'trade_association' },
  { domain: 'nari.org', kind: 'trade_association' },
  { domain: 'iicrc.org', kind: 'trade_association' },
  { domain: 'nahb.org', kind: 'trade_association' },
]

/**
 * Suffix rules, checked after the exact list.
 *
 * `.gov` and `.edu` are registration-restricted in the US, which is exactly why
 * they are the strongest signal here — you cannot buy your way onto one.
 */
const SUFFIX: Array<{ suffix: string; kind: AuthorityKind; reason: string }> = [
  { suffix: '.gov', kind: 'government', reason: 'Government domain (restricted registration)' },
  { suffix: '.mil', kind: 'government', reason: 'Military domain (restricted registration)' },
  { suffix: '.edu', kind: 'education', reason: 'Education domain (restricted registration)' },
]

/** Substring rules for families too numerous to enumerate. */
const CONTAINS: Array<{ needle: string; kind: AuthorityKind; reason: string }> = [
  { needle: 'chamber', kind: 'chamber', reason: 'Chamber of commerce directory' },
  { needle: 'bbb.', kind: 'bbb', reason: 'Better Business Bureau property' },
]

export interface ReferringDomainInput {
  domain: string
  rank?: number | null
  backlinks?: number | null
  /** Page the link is on. Null for rows captured before this was collected. */
  urlFrom?: string | null
  pageStatus?: number | null
  isLost?: boolean | null
}

/**
 * Classify one referring domain, or null when it is ordinary.
 *
 * Deliberately conservative: an unrecognised domain returns null rather than a
 * guessed tier. A false "authority citation" would inflate a domain's apparent
 * worth, and the whole point of this feature is to tell a genuine asset from a
 * pile of spam.
 */
export function classifyAuthority(input: ReferringDomainInput): AuthorityMatch | null {
  const domain = input.domain.trim().toLowerCase()
  if (!domain) return null

  const base = {
    domain,
    rank: input.rank ?? null,
    backlinks: input.backlinks ?? null,
    urlFrom: input.urlFrom?.trim() || null,
    pageStatus: input.pageStatus ?? null,
    isLost: input.isLost === true,
  }

  const exact = EXACT.find((e) => domain === e.domain || domain.endsWith(`.${e.domain}`))
  if (exact) {
    return { ...base, kind: exact.kind, reason: `Known ${exact.kind.replace(/_/g, ' ')}: ${exact.domain}` }
  }

  const suffix = SUFFIX.find((s) => domain.endsWith(s.suffix))
  if (suffix) return { ...base, kind: suffix.kind, reason: suffix.reason }

  const contains = CONTAINS.find((c) => domain.includes(c.needle))
  if (contains) return { ...base, kind: contains.kind, reason: contains.reason }

  return null
}

export interface AuthorityProfile {
  matches: AuthorityMatch[]
  /** Weighted total across matches. A ranking aid, not a valuation. */
  score: number
  /** Distinct kinds present — breadth matters more than repetition. */
  kinds: AuthorityKind[]
  /** True when at least one restricted-registration or BBB citation is held. */
  hasHardToReplace: boolean
}

const HARD_TO_REPLACE: readonly AuthorityKind[] = ['government', 'education', 'bbb', 'chamber']

/**
 * Summarise a domain's citation profile.
 *
 * Each KIND is counted once no matter how many domains of that kind link in:
 * fifteen directory listings are not five times better than three, and letting
 * them stack would let the cheapest, most replaceable citations dominate the
 * score. Breadth across kinds is the signal.
 */
export function summariseAuthority(referring: ReferringDomainInput[]): AuthorityProfile {
  const matches: AuthorityMatch[] = []
  for (const r of referring) {
    const m = classifyAuthority(r)
    if (m) matches.push(m)
  }

  const kinds = [...new Set(matches.map((m) => m.kind))]
  const score = kinds.reduce((sum, k) => sum + AUTHORITY_WEIGHT[k], 0)

  matches.sort(
    (a, b) => AUTHORITY_WEIGHT[b.kind] - AUTHORITY_WEIGHT[a.kind] || (b.rank ?? 0) - (a.rank ?? 0),
  )

  return {
    matches,
    score,
    kinds,
    hasHardToReplace: kinds.some((k) => HARD_TO_REPLACE.includes(k)),
  }
}
