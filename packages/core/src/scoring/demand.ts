import type { DemandEstimate, Niche } from '../types.js'

/**
 * Monthly search volume, MODELLED from population.
 *
 * This is not a measurement and cannot be made into one with the current data
 * sources. DataForSEO's /dataforseo_labs/locations_and_languages returns 94 rows
 * and stops at Country -- it enumerates which keyword DATABASES exist, not
 * queryable places. There is no city-level search volume to buy there.
 *
 * So the return type carries `estimated: true` as a LITERAL, not a boolean. A
 * caller cannot construct a DemandEstimate that claims to be measured, and the
 * flag propagates to the UI by construction rather than by anyone remembering
 * to pass it along.
 */
export function estimateDemand(args: {
  population: number | null
  niche: Pick<Niche, 'demandPerCapitaPer1k' | 'label'>
}): DemandEstimate | null {
  const { population, niche } = args
  // No population => no estimate. NOT zero: a zero-volume niche would fail the
  // 30-day volume gate for an honest-looking reason, when the truth is we have
  // no idea.
  if (population === null || population <= 0) return null

  const monthlySearches = Math.round((population / 1000) * niche.demandPerCapitaPer1k)
  return {
    monthlySearches,
    estimated: true,
    basis: `${population.toLocaleString()} residents x ${niche.demandPerCapitaPer1k}/1k for ${niche.label}. Modelled from population -- city-level search volume cannot be purchased from any configured provider.`,
  }
}
