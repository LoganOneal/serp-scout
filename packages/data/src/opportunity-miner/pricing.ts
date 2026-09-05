import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { omDomains, omMarketDomains, omPricingObservations } from '../schema.js'

const PRICE_RE = /\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/\s*(?:mo|month)|per month|\/mo)?/gi

/**
 * Fetch public pricing pages for competitor domains.
 * Observed prices only — never invent a number when the page is silent.
 */
export async function enrichMarketPricing(
  db: Database,
  marketId: number,
  opts: { live?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ observations: number }> {
  if (!opts.live) return { observations: 0 }
  const links = await db.select().from(omMarketDomains).where(eq(omMarketDomains.marketId, marketId))
  const domains = []
  for (const link of links.slice(0, 6)) {
    const [d] = await db.select().from(omDomains).where(eq(omDomains.id, link.domainId)).limit(1)
    if (d) domains.push(d)
  }
  let observations = 0
  const fetchImpl = opts.fetchImpl ?? fetch
  for (const domain of domains) {
    const url = `https://${domain.domain.replace(/^https?:\/\//, '')}/pricing`
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'serp-scout-opportunity-miner/0.1' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const html = (await res.text()).slice(0, 80_000)
      const prices = [...html.matchAll(PRICE_RE)].map((m) => Number(m[1])).filter((n) => n >= 5 && n <= 2000)
      if (prices.length === 0) continue
      const sorted = [...new Set(prices)].sort((a, b) => a - b)
      await db.insert(omPricingObservations).values({
        domainId: domain.id,
        marketId,
        sourceUrl: url,
        cheapestPaid: sorted[0] ?? null,
        popularPlan: sorted[Math.floor(sorted.length / 2)] ?? null,
        highestSelfServe: sorted[sorted.length - 1] ?? null,
        rawExcerpt: sorted.slice(0, 8).map((n) => `$${n}`).join(', '),
        confidence: 'observed',
      })
      observations += 1
    } catch {
      // Page missing or blocked — leave price unknown, do not infer here.
    }
  }
  return { observations }
}
