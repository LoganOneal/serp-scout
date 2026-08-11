/**
 * Pre-geo niche ranking for lead-sell businesses (Google Ads + Reddit comments).
 * Pure. No IO.
 *
 * Goal: maximize revenue from selling leads — volume × ability to close × lead $ —
 * while accounting for paid competition (CPC / competition index).
 */

export interface LeadGenNicheInputs {
  /** Measured Google Ads avg monthly searches (national). Null = unmeasured. */
  volume: number | null
  /** Avg job ticket micros. Null = unknown. */
  avgTicketMicros: bigint | number | null
  /** Commission bps (1000 = 10%). Used if leadValueMicros missing. */
  leadCommissionRateBps: number | null
  /** Explicit lead sell price micros (preferred). */
  leadValueMicros: bigint | number | null
  /** Keyword Planner competition 0–100. */
  competitionIndex: number | null
  /** High top-of-page bid micros (CPC proxy). */
  topOfPageBidHighMicros: bigint | number | null
}

export interface LeadGenNicheScore {
  /** Default sort key 0–100. */
  compositeScore: number | null
  /** Fitness for buying Google Ads traffic. */
  adsFitScore: number | null
  /** Priority for Reddit-comment arbitrage (high paid cost can help). */
  redditPriorityScore: number | null
  demandNorm: number
  economicsNorm: number
  adsCostNorm: number
  /** Resolved lead value micros (or null). */
  leadValueMicros: number | null
  avgTicketMicros: number | null
  reasons: string[]
}

function toNum(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number(v)
  return Number.isFinite(v) ? v : null
}

function resolveLeadValue(input: LeadGenNicheInputs): number | null {
  const explicit = toNum(input.leadValueMicros)
  if (explicit !== null && explicit > 0) return explicit
  const ticket = toNum(input.avgTicketMicros)
  const bps = input.leadCommissionRateBps
  if (ticket !== null && ticket > 0 && bps !== null && bps > 0) {
    return Math.round((ticket * bps) / 10_000)
  }
  return null
}

/**
 * Rank a niche for lead-gen ROI before city deep dives.
 */
export function scoreLeadGenNiche(input: LeadGenNicheInputs): LeadGenNicheScore {
  const reasons: string[] = []
  const vol = input.volume ?? 0
  const demandNorm =
    vol <= 0 ? 0 : Math.min(1, Math.log10(vol + 1) / Math.log10(100_000 + 1))
  if (vol > 0) reasons.push(`vol ${vol.toLocaleString()}`)
  else reasons.push('volume unmeasured')

  const leadValueMicros = resolveLeadValue(input)
  const avgTicketMicros = toNum(input.avgTicketMicros)
  // $20 lead → ~0.4, $100 → ~0.55, $500 → ~0.7, $2000 → ~0.85
  const economicsNorm =
    leadValueMicros === null || leadValueMicros <= 0
      ? 0
      : Math.min(1, Math.log10(leadValueMicros / 1_000_000 + 1) / Math.log10(2000 + 1))
  if (leadValueMicros !== null && leadValueMicros > 0) {
    reasons.push(`lead $${(leadValueMicros / 1_000_000).toFixed(0)}`)
  } else {
    reasons.push('lead $ unknown')
  }
  if (avgTicketMicros !== null && avgTicketMicros > 0) {
    reasons.push(`ticket $${(avgTicketMicros / 1_000_000).toFixed(0)}`)
  }

  const comp = input.competitionIndex
  const bidHigh = toNum(input.topOfPageBidHighMicros)
  // Competition index 0–100 → 0–0.7 weight; bid $0–$50 → 0–0.3
  const compPart =
    comp === null || !Number.isFinite(comp) ? 0.35 : Math.min(1, Math.max(0, comp / 100))
  const bidUsd = bidHigh === null ? null : bidHigh / 1_000_000
  const bidPart =
    bidUsd === null || bidUsd <= 0
      ? 0.35
      : Math.min(1, Math.log10(bidUsd + 1) / Math.log10(50 + 1))
  const adsCostNorm = Math.min(1, compPart * 0.65 + bidPart * 0.35)
  if (comp !== null) reasons.push(`comp ${comp}`)
  if (bidUsd !== null) reasons.push(`bid~$${bidUsd.toFixed(1)}`)

  if (demandNorm <= 0 && economicsNorm <= 0) {
    return {
      compositeScore: null,
      adsFitScore: null,
      redditPriorityScore: null,
      demandNorm,
      economicsNorm,
      adsCostNorm,
      leadValueMicros,
      avgTicketMicros,
      reasons,
    }
  }

  // Ads fit: want demand × money, penalize expensive clicks.
  const adsRaw =
    demandNorm * Math.max(economicsNorm, 0.15) * (1 - adsCostNorm * 0.7)
  const adsFitScore = Math.round(Math.min(100, Math.max(0, adsRaw * 120)))

  // Reddit priority: demand × money; high paid cost *boosts* (arbitrage).
  const redditRaw =
    demandNorm * Math.max(economicsNorm, 0.15) * (0.55 + adsCostNorm * 0.45)
  const redditPriorityScore = Math.round(Math.min(100, Math.max(0, redditRaw * 110)))

  // Operator is Reddit-first by default.
  const compositeScore = Math.round(
    Math.min(100, adsFitScore * 0.4 + redditPriorityScore * 0.6),
  )

  return {
    compositeScore,
    adsFitScore,
    redditPriorityScore,
    demandNorm,
    economicsNorm,
    adsCostNorm,
    leadValueMicros,
    avgTicketMicros,
    reasons,
  }
}
