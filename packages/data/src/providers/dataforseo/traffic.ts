import 'server-only'
import { PRICE, type Micros } from '@rnr/core'
import type { DataForSeoClient } from './client.js'

/**
 * Organic traffic for many domains at once — the filter that decides whether a
 * prospect list is real.
 *
 * ==================== MEASURED, AND IT IS 84x CHEAPER ====================
 * `/dataforseo_labs/google/bulk_traffic_estimation/live`, balance delta
 * 2026-08-14:
 *
 *     3 targets  → $0.012360
 *    15 targets  → $0.013800
 *
 *   request fee $0.012  +  $0.00012 per target
 *
 * Same shape as `ranked_keywords` (and the same per-row rate), but it takes up
 * to 1,000 targets in ONE request. So 500 prospects cost **$0.072** here versus
 * **$6.06** via a per-domain `ranked_keywords(limit: 1)` call.
 *
 * That measurement is why the traffic gate is affordable enough to run on every
 * prospect rather than on a sample — which is the whole point, since a sampled
 * quality filter tells you nothing about the rows it skipped.
 * ========================================================================
 */

/** DataForSEO's documented ceiling for this endpoint. */
export const TRAFFIC_BATCH_MAX = 1000

export interface TrafficEstimate {
  target: string
  /** Keywords this domain ranks for. THE gate — see prospect.ts §0.1. */
  rankedKeywords: number | null
  /** Vendor-modelled estimated traffic value. Ranking input, not a measurement. */
  organicEtv: number | null
}

export interface TrafficEstimationResult {
  estimates: Map<string, TrafficEstimate>
  /** Targets we asked about that came back with nothing. NOT zero-traffic. */
  unresolved: string[]
  requestCount: number
  costMicros: Micros
}

interface RawItem {
  target?: string
  metrics?: { organic?: { etv?: number | null; count?: number | null } }
}

/**
 * Batched at 1,000. A caller passing 5,000 domains issues 5 requests, not 5,000.
 *
 * A target the API does not return lands in `unresolved` rather than being
 * recorded as zero — "the vendor has nothing on this domain" and "this domain
 * ranks for nothing" are different facts, and only the second is a reason to
 * reject a prospect.
 */
export async function fetchTrafficEstimates(
  client: DataForSeoClient,
  targets: string[],
  opts: { locationCode?: number; languageCode?: string } = {},
): Promise<TrafficEstimationResult> {
  const unique = [...new Set(targets.map((t) => t.trim().toLowerCase()).filter(Boolean))]
  const estimates = new Map<string, TrafficEstimate>()
  let requestCount = 0
  let costMicros = 0n

  for (let i = 0; i < unique.length; i += TRAFFIC_BATCH_MAX) {
    const batch = unique.slice(i, i + TRAFFIC_BATCH_MAX)
    const body = await client.post<Array<{ items?: RawItem[] }>>(
      '/dataforseo_labs/google/bulk_traffic_estimation/live',
      [
        {
          targets: batch,
          location_code: opts.locationCode ?? 2840,
          language_code: opts.languageCode ?? 'en',
        },
      ],
    )
    requestCount += 1
    // Measured: request fee + per-target, same per-row rate as ranked_keywords.
    costMicros += PRICE.labsRankedKeywords + PRICE.labsRankedKeywordsRow * BigInt(batch.length)

    for (const item of body?.[0]?.items ?? []) {
      const target = item.target?.trim().toLowerCase()
      if (!target) continue
      estimates.set(target, {
        target,
        rankedKeywords: num(item.metrics?.organic?.count),
        organicEtv: num(item.metrics?.organic?.etv),
      })
    }
  }

  return {
    estimates,
    unresolved: unique.filter((t) => !estimates.has(t)),
    requestCount,
    costMicros,
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
