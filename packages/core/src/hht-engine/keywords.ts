import type { KeywordStatus } from './types.js'

const MODIFIERS = new Set(['best', 'top', 'the', 'a', 'an'])

export function normalizeFrontierKeyword(keyword: string): string {
  const tokens = keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !MODIFIERS.has(token))
    .map(singularize)
  return tokens.join(' ').trim()
}

function singularize(token: string): string {
  if (token.length <= 3) return token
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.endsWith('ses') || token.endsWith('shes') || token.endsWith('ches')) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

export interface BandYield {
  newQualifiedDomains: number
  reachedMaxDepth: boolean
}

/**
 * One thin band only lowers priority. Saturation takes two consecutive thin
 * bands, or a max-depth scan that found nothing new.
 */
export function nextKeywordStatus(input: {
  status: KeywordStatus
  consecutiveLowYieldBands: number
  band: BandYield
  lowYieldThreshold: number
}): { status: KeywordStatus; consecutiveLowYieldBands: number } {
  if (input.status === 'REJECTED_IRRELEVANT') {
    return { status: input.status, consecutiveLowYieldBands: input.consecutiveLowYieldBands }
  }
  const thin = input.band.newQualifiedDomains < input.lowYieldThreshold
  const consecutive = thin ? input.consecutiveLowYieldBands + 1 : 0
  if (thin && input.band.reachedMaxDepth && input.band.newQualifiedDomains === 0) {
    return { status: 'SATURATED', consecutiveLowYieldBands: consecutive }
  }
  if (thin && consecutive >= 2) {
    return { status: 'SATURATED', consecutiveLowYieldBands: consecutive }
  }
  if (thin) {
    return { status: 'LOW_YIELD_AT_CURRENT_DEPTH', consecutiveLowYieldBands: consecutive }
  }
  return { status: 'ACTIVE', consecutiveLowYieldBands: 0 }
}

export function volumeMidpoint(input: {
  avgMonthlySearches: number | null
  volumeLow: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
}): number {
  if (input.volumeIsRange) {
    const low = input.volumeLow ?? 0
    const high = input.volumeHigh ?? low
    return (low + high) / 2
  }
  return input.avgMonthlySearches ?? 0
}

export function volumeIsZero(input: {
  avgMonthlySearches: number | null
  volumeHigh: number | null
  volumeIsRange: boolean
}): boolean {
  if (input.volumeIsRange) return (input.volumeHigh ?? 0) <= 0
  return (input.avgMonthlySearches ?? 0) <= 0
}
