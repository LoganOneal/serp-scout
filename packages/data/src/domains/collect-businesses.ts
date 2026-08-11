import 'server-only'
import { PRICE, type Micros } from '@rnr/core'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
import type { BusinessInput } from './enrich-pipeline.js'

/**
 * Stage 1 — enumerate the businesses in a niche + locality.
 *
 * ==================== WHY MAPS AND NOT PLACES ====================
 * The spec names the Google Places API. This uses the DataForSEO Maps endpoint
 * instead, for two measured reasons:
 *
 *   price  — Maps returns 100 businesses for $0.002. Places needs a Text Search
 *            per 20 results plus a Details call per business to reach a website
 *            field, which prices 200 businesses near $3.70. That is ~900x for
 *            the same list.
 *   access — there is no Google Places key in this project's environment. Maps
 *            runs on the DataForSEO credentials already wired to the ledger.
 *
 * Measured coverage on a live 100-business result (2026-08-06):
 *   title 100/100 · place_id 100/100 · phone 99/100 · address 86/100
 *   domain 73/100 · business_status 0/100
 *
 * ---- THE ONE THING THIS SOURCE DOES NOT GIVE US ----
 * `business_status` is absent, so CLOSED_PERMANENTLY listings — which the spec
 * calls the highest-value rows — cannot be identified here. Google's search
 * surfaces largely exclude closed businesses anyway, so Places Text Search
 * would not reliably surface them either; reaching them means a Places Details
 * call per `place_id`, and every row carries a place_id for exactly that
 * purpose. `placeId` is therefore retained on every business even though
 * nothing consumes it yet.
 * =================================================================
 */

export interface CollectedBusiness extends BusinessInput {
  placeId: string | null
  cid: string | null
  address: string | null
  phone: string | null
  category: string | null
  rating: number | null
  reviewCount: number | null
  isClaimed: boolean | null
  latitude: number | null
  longitude: number | null
}

export interface CollectBusinessesResult {
  businesses: CollectedBusiness[]
  costMicros: Micros
  requests: number
  /** Businesses whose listing carried no website at all. */
  withoutWebsite: number
}

interface MapsItemRaw {
  type?: string
  title?: string | null
  domain?: string | null
  url?: string | null
  address?: string | null
  phone?: string | null
  category?: string | null
  place_id?: string | null
  cid?: string | null
  is_claimed?: boolean | null
  latitude?: number | null
  longitude?: number | null
  rating?: { value?: number | null; votes_count?: number | null } | null
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/**
 * One niche + locality, up to `maxResults` businesses.
 *
 * `depth` is what DataForSEO bills on: the endpoint charges per request, and a
 * request may carry up to 700 results, so asking for 200 in one call costs the
 * same $0.002 as asking for 100. There is no reason to paginate by hand.
 */
export async function collectBusinesses(args: {
  niche: string
  locationCode: number
  maxResults?: number
  languageCode?: string
}): Promise<CollectBusinessesResult> {
  const depth = Math.min(Math.max(args.maxResults ?? 200, 1), 700)
  const client = createDfsClientFromEnv()
  if (!client) {
    // No credentials is a configuration problem, not an empty market. Returning
    // zero businesses here would read downstream as "this niche has no
    // operators", which is a far worse failure than refusing to start.
    throw new Error(
      'DataForSEO credentials are not configured; Stage 1 cannot enumerate businesses.',
    )
  }

  const result = await client.post<Array<{ items?: MapsItemRaw[] }>>(ENDPOINTS.SERP_MAPS_LIVE, [
    {
      keyword: args.niche,
      location_code: args.locationCode,
      language_code: args.languageCode ?? 'en',
      depth,
    },
  ])

  const items = (Array.isArray(result) ? result[0]?.items : undefined) ?? []
  const maps = items.filter((i) => i.type === 'maps_search')

  const businesses: CollectedBusiness[] = maps.map((m) => ({
    name: str(m.title) ?? '(untitled)',
    // `domain` is the bare host; `url` is the full link. Either is fine — the
    // normaliser reduces both to eTLD+1 — but url is preferred because it
    // survives listings where domain is null and url is not.
    website: str(m.url) ?? str(m.domain),
    placeId: str(m.place_id),
    cid: str(m.cid),
    address: str(m.address),
    phone: str(m.phone),
    category: str(m.category),
    rating: num(m.rating?.value),
    reviewCount: num(m.rating?.votes_count),
    isClaimed: typeof m.is_claimed === 'boolean' ? m.is_claimed : null,
    latitude: num(m.latitude),
    longitude: num(m.longitude),
  }))

  return {
    businesses,
    costMicros: PRICE.serpMapsLive,
    requests: 1,
    withoutWebsite: businesses.filter((b) => !b.website).length,
  }
}
