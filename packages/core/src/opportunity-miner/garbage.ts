import { extractConcepts } from './concepts.js'
import type { RejectionReason } from './types.js'

export interface GarbageInput {
  keywords: string[]
  brandedShare: number | null
  uniqueAdvertisers: number
  observedPriceCount: number
  weightedCpc: number | null
  majorPlatformOwned: boolean
}

export interface GarbageVerdict {
  penalize: boolean
  reject: boolean
  reasons: RejectionReason[]
  /** 0–1 multiplier applied to total score. */
  scoreMultiplier: number
}

export function evaluateGarbage(input: GarbageInput): GarbageVerdict {
  const reasons = new Set<RejectionReason>()
  const sample = input.keywords.slice(0, 40).map((k) => k.toLowerCase())
  const blob = sample.join(' | ')

  if (/(celebrit|oscar|grammy|super bowl|election|taylor swift|kardashian)/.test(blob)) {
    reasons.add('celebrity_news')
  }
  if (/(crack|nulled|warez|torrent|pirat|serial key)/.test(blob)) {
    reasons.add('piracy')
    reasons.add('illegal')
  }
  if (/(dark web|carding|ssn dump|stolen (card|credit))/.test(blob)) {
    reasons.add('illegal')
  }
  if (/(2024 election|world cup 2022|covid stimulus)/.test(blob)) {
    reasons.add('one_off_event')
  }
  if (sample.filter((k) => /^(what is|how to|meaning|definition|wikipedia)/.test(k)).length >= Math.max(3, sample.length * 0.6)) {
    reasons.add('purely_informational')
  }
  if ((input.brandedShare ?? 0) >= 0.75) reasons.add('navigational_cluster')
  if (input.majorPlatformOwned) reasons.add('owned_by_free_platform')

  const commercialish = sample.filter((k) =>
    /(software|app|tool|pricing|crm|automat|generator|tracker|planner)/.test(k),
  ).length
  if (
    commercialish === 0 &&
    input.uniqueAdvertisers === 0 &&
    input.observedPriceCount === 0 &&
    (input.weightedCpc ?? 0) < 0.4
  ) {
    reasons.add('no_monetization_path')
  }

  const novelty = sample.every((k) => /(generator|maker|quiz|name)/.test(k))
  const concepts = sample.map(extractConcepts)
  const recurring = average(concepts.map((c) => c.recurringUsageLikelihood))
  if (novelty && recurring <= 1.5 && (input.weightedCpc ?? 0) < 1.5) {
    reasons.add('low_frequency_novelty')
  }

  if (/(porn|xxx|onlyfans|casino|sportsbook|prescription)/.test(blob)) {
    reasons.add('adult_regulated')
  }

  const hard = [...reasons].some((r) => r === 'illegal' || r === 'piracy')
  const penalize = reasons.size > 0
  let multiplier = 1
  for (const r of reasons) multiplier *= REASON_MULT[r] ?? 0.85

  return {
    penalize,
    reject: hard,
    reasons: [...reasons],
    scoreMultiplier: hard ? 0.15 : Math.max(0.25, multiplier),
  }
}

const REASON_MULT: Partial<Record<RejectionReason, number>> = {
  celebrity_news: 0.35,
  piracy: 0.15,
  illegal: 0.1,
  one_off_event: 0.4,
  purely_informational: 0.45,
  impossible_regulation: 0.35,
  navigational_cluster: 0.4,
  no_monetization_path: 0.35,
  owned_by_free_platform: 0.4,
  low_frequency_novelty: 0.7,
  adult_regulated: 0.3,
  too_broad: 0.6,
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
