import type { HhtOppType } from './types.js'

export const HHT_OPP_REFRESH = {
  activeDays: 30,
  highValueDays: 14,
  paidDays: 14,
  failedDays: 90,
} as const

export function refreshIntervalDays(input: {
  status: string
  eligibility: string
  priceStatus: string
  overallScore: number | null
}): number {
  if (['FAIL', 'REJECTED', 'ARCHIVED'].includes(input.status) || input.eligibility === 'FAIL') {
    return HHT_OPP_REFRESH.failedDays
  }
  if (input.priceStatus === 'FIXED' || input.priceStatus === 'QUOTE_REQUIRED') return HHT_OPP_REFRESH.paidDays
  if (input.eligibility === 'PASS' || (input.overallScore ?? 0) >= 70) return HHT_OPP_REFRESH.highValueDays
  return HHT_OPP_REFRESH.activeDays
}

export function isRefreshDue(lastCheckedAt: Date | null | undefined, intervalDays: number, now = new Date()): boolean {
  if (!lastCheckedAt) return true
  return now.getTime() - lastCheckedAt.getTime() >= intervalDays * 86_400_000
}

export interface StrategyYieldRow {
  strategy: string
  queries: number
  domainsFound: number
  pass: number
  yieldPct: number
}

export interface OutcomeRateRow {
  key: string
  sent: number
  replies: number
  acquired: number
  avgCost: number | null
}

export interface StrategyRecommendation {
  summary: string
  rationale: string
  evidence: Record<string, number | string>
}

export function proposeStrategyRecommendations(input: {
  yields: StrategyYieldRow[]
  outcomesByType: OutcomeRateRow[]
  outcomesByStrategy: OutcomeRateRow[]
}): StrategyRecommendation[] {
  const recs: StrategyRecommendation[] = []
  const usable = input.yields.filter((row) => row.domainsFound >= 5 || row.pass > 0)
  if (usable.length >= 2) {
    const ranked = [...usable].sort((a, b) => b.yieldPct - a.yieldPct)
    const best = ranked[0]!
    const rest = ranked.slice(1)
    const avg = rest.reduce((sum, row) => sum + row.yieldPct, 0) / rest.length
    if (avg > 0 && best.yieldPct >= avg * 2.5 && best.pass >= 2) {
      recs.push({
        summary: `Increase discovery allocation to ${label(best.strategy)}.`,
        rationale: `${label(best.strategy)} produced ${best.yieldPct.toFixed(1)}% PASS yield versus ${avg.toFixed(1)}% on the other strategies. Do not drop the others — shift the next batch toward this family.`,
        evidence: { strategy: best.strategy, yieldPct: best.yieldPct, baselineYieldPct: avg, pass: best.pass },
      })
    }
  }

  const acquiredTypes = input.outcomesByType.filter((row) => row.acquired > 0 && row.sent >= 2)
  for (const row of acquiredTypes) {
    const rate = row.sent > 0 ? row.acquired / row.sent : 0
    if (rate >= 0.2) {
      recs.push({
        summary: `${label(row.key)} outreach is converting — keep mining that type.`,
        rationale: `${row.acquired} of ${row.sent} sent pitches acquired a link (${(rate * 100).toFixed(0)}%). Use this as a human-approved bias, not an automatic filter.`,
        evidence: { type: row.key, sent: row.sent, acquired: row.acquired, replyRate: row.sent ? row.replies / row.sent : 0 },
      })
    }
  }

  const acquiredStrategies = input.outcomesByStrategy.filter((row) => row.acquired > 0 && row.sent >= 2)
  for (const row of acquiredStrategies) {
    recs.push({
      summary: `Pitches from ${label(row.key)} produced live links.`,
      rationale: `${row.acquired} acquired links from ${row.sent} sends. Recommend more queries in this strategy on the next run.`,
      evidence: { strategy: row.key, sent: row.sent, acquired: row.acquired },
    })
  }

  if (recs.length === 0) {
    recs.push({
      summary: 'Not enough outcome data to reallocate discovery yet.',
      rationale: 'Keep the mixed batch. Recommendations require either five domains found per strategy or at least two sent pitches with a result.',
      evidence: { strategies: input.yields.length, outcomeTypes: input.outcomesByType.length },
    })
  }

  return recs.slice(0, 8)
}

function label(value: string): string {
  return value.replaceAll('_', ' ')
}

export function mentionFeasibilityBoost(type: HhtOppType | string): number {
  return type === 'unlinked_mention' ? 18 : 0
}

export function competitorSeoBoost(competitorLinkCount: number | null | undefined): number {
  if (competitorLinkCount == null) return 0
  if (competitorLinkCount >= 3) return 14
  if (competitorLinkCount >= 2) return 10
  return 0
}
