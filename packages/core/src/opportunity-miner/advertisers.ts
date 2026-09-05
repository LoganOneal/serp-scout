/**
 * Persistent advertiser score, 0–100.
 *
 * Long-lived paid presence is evidence that traffic may be monetizable.
 * It is not proof of profitability.
 */
export function persistentAdvertiserScore(args: {
  uniqueAdvertisers: number
  recurringAdvertisers: number
  monthsObserved: number
  adDensity: number | null
}): number {
  const { uniqueAdvertisers, recurringAdvertisers, monthsObserved } = args
  if (uniqueAdvertisers <= 0) return 0
  let score = 15
  if (uniqueAdvertisers === 1 && recurringAdvertisers === 0) score = 18
  if (uniqueAdvertisers === 1 && recurringAdvertisers >= 1) score = 32
  if (uniqueAdvertisers >= 2) score = 45
  if (uniqueAdvertisers >= 4) score = 62
  if (uniqueAdvertisers >= 7) score = 74
  if (recurringAdvertisers >= 3 && monthsObserved >= 3) score += 12
  if (recurringAdvertisers >= 5 && monthsObserved >= 6) score += 10
  if ((args.adDensity ?? 0) >= 0.4) score += 6
  return Math.min(100, score)
}

export function brandedShare(keywords: Array<{ keyword: string; volume: number | null }>, brandTokens: string[]): number {
  const brands = brandTokens.map((b) => b.toLowerCase()).filter(Boolean)
  if (brands.length === 0) return 0
  let branded = 0
  let total = 0
  for (const k of keywords) {
    const vol = k.volume ?? 0
    total += vol
    if (brands.some((b) => k.keyword.toLowerCase().includes(b))) branded += vol
  }
  return total === 0 ? 0 : branded / total
}
