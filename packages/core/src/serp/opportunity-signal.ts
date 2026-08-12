/**
 * What a row is actually offering, as a claim rather than as evidence.
 *
 * ==================== 27 COLUMNS, NO CONCLUSION ====================
 * The grid shows difficulty, slots, verdicts, Reddit rank, Reddit visits,
 * volume, CPC, layout counts -- every one of them evidence, none of them a
 * finding. An operator scanning it has to reconstruct "this is a Reddit play"
 * from six numbers per row, which is the work the tool should already have done.
 *
 * A signal names a PLAY YOU CAN RUN. Each rule below maps to a different action
 * and a different cost, which is why they are separate signals rather than one
 * blended score:
 *
 *   reddit   comment on a thread that already ranks -- no site, no domain
 *   build    buy a domain and rank it -- weeks of work, real money
 *   domain   acquire the exact-match domain before someone else does
 *   partial  something is here, but its evidence is incomplete
 *
 * `partial` earns its place. Reddit visits are volume x CTR, so a keyword
 * Google Ads has no figure for produces null however many threads sit on page
 * one -- and null rendered as the same em dash as "no Reddit at all", in the
 * first column anyone reads. Splitting those apart is the difference between
 * "nothing here" and "we could not compute it".
 * ===================================================================
 */

export type OpportunitySignal = 'reddit' | 'build' | 'domain' | 'partial'

export interface SignalInput {
  /** Estimated monthly visits reaching a Reddit thread. Null = not computable. */
  redditVisits?: number | null
  /** Reddit threads found on page 1. */
  redditHitCount?: number | null
  /** Measured monthly searches. Null = Google Ads had no figure. */
  volume?: number | null
  /** Winnability if a domain is acquired. */
  verdictAcquired?: string | null
  /** Page-one slots not held by a platform. */
  slotsOpen?: number | null
  /** The exact-match domain is registrable. */
  emdAvailable?: boolean | null
}

/**
 * Thresholds, in one place because they are judgement rather than measurement.
 *
 * Chosen to be legible rather than tuned: a number an operator can hold in
 * their head and argue with beats one derived from a model nobody can inspect.
 * Every one of them is a single constant to change once real markets have been
 * worked.
 */
export const SIGNAL_THRESHOLDS = {
  /** Estimated visits that make a thread worth commenting on. */
  redditVisits: 25,
  /** Volume that makes a thread worth it even before visits are computable. */
  redditVolume: 100,
  /** Open page-one slots a new site needs to have somewhere to land. */
  slotsOpen: 3,
} as const

const WINNABLE_VERDICTS = new Set(['likely_30d', 'likely_90d'])

/** Every signal a row supports, strongest first. */
export function opportunitySignals(row: SignalInput): OpportunitySignal[] {
  const out: OpportunitySignal[] = []

  const threads = row.redditHitCount ?? 0
  const visits = row.redditVisits ?? null
  const volume = row.volume ?? null

  const redditByVisits = visits != null && visits >= SIGNAL_THRESHOLDS.redditVisits
  const redditByVolume = threads > 0 && volume != null && volume >= SIGNAL_THRESHOLDS.redditVolume
  if (redditByVisits || redditByVolume) out.push('reddit')

  if (
    row.verdictAcquired != null &&
    WINNABLE_VERDICTS.has(row.verdictAcquired) &&
    (row.slotsOpen ?? 0) >= SIGNAL_THRESHOLDS.slotsOpen
  ) {
    out.push('build')
  }

  if (row.emdAvailable === true) out.push('domain')

  /**
   * Only when nothing stronger fired. A row already carrying `reddit` does not
   * also need telling that its evidence is thin -- the claim was made.
   */
  if (out.length === 0 && threads > 0) out.push('partial')

  return out
}

/**
 * Sort key. Higher is more interesting.
 *
 * Deliberately not a weighted blend of the underlying numbers: the column
 * exists to say WHICH PLAY a row offers, and a blend would rank a mediocre
 * example of the best play below a strong example of the worst one. Ties fall
 * back to the caller's existing ordering.
 */
export function signalStrength(row: SignalInput): number {
  const signals = opportunitySignals(row)
  if (signals.length === 0) return 0
  const rank: Record<OpportunitySignal, number> = {
    reddit: 400,
    build: 300,
    domain: 200,
    partial: 100,
  }
  const best = Math.max(...signals.map((s) => rank[s]))
  // A row offering two plays outranks one offering a single play of that kind.
  return best + (signals.length - 1) * 10
}

export const SIGNAL_LABEL: Record<OpportunitySignal, string> = {
  reddit: 'REDDIT',
  build: 'BUILD',
  domain: 'DOMAIN',
  partial: 'PARTIAL',
}

/** Said in full on hover, so a chip never has to be guessed at. */
export function signalExplanation(signal: OpportunitySignal, row: SignalInput): string {
  const threads = row.redditHitCount ?? 0
  switch (signal) {
    case 'reddit':
      return row.redditVisits != null
        ? `${threads} Reddit thread${threads === 1 ? '' : 's'} on page 1, an estimated ${row.redditVisits} visits a month reaching them. Comment, no site needed.`
        : `${threads} Reddit thread${threads === 1 ? '' : 's'} on page 1 against ${row.volume ?? 0} searches a month. Comment, no site needed.`
    case 'build':
      return `Winnable on an acquired domain (${row.verdictAcquired}), with ${row.slotsOpen} page-one slots not held by a platform.`
    case 'domain':
      return 'The exact-match domain is registrable. Acquire it before someone else does.'
    case 'partial':
      return `${threads} Reddit thread${threads === 1 ? '' : 's'} on page 1, but Google Ads returned no volume for this keyword, so reach cannot be estimated.`
  }
}
