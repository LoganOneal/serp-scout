import type { DomainAuthority, MapPackSnapshot, Micros, ProviderLocation, SerpSnapshot } from '@rnr/core'
import { PRICE } from '@rnr/core'
import { DataForSeoClient, fetchAccountStatus, type AccountStatus } from './dataforseo/client.js'
import { fetchBulkBacklinks } from './dataforseo/backlinks.js'
import {
  fetchLocations,
  fetchMapPack,
  fetchOrganicSerp,
  fetchOrganicSerpDetailed,
} from './dataforseo/serp.js'
import { fetchPageHtml } from './dataforseo/instant-pages.js'
import { fixtureRedditThread } from './fixtures/reddit.js'
import {
  archetypeFor,
  fixtureBulkBacklinks,
  fixtureMapPack,
  fixtureOrganicSerp,
  fixtureOrganicSerpDetailed,
  type FixtureContext,
} from './fixtures/index.js'

/**
 * The provider seam.
 *
 * ==================== DEFAULTS TO FIXTURES, DELIBERATELY ====================
 * Live calls require LIVE_CALLS_ENABLED to be the exact string 'true'. Anything
 * else -- unset, empty, 'TRUE', '1', 'yes', a typo -- routes to the offline
 * fixture implementations at zero cost.
 *
 * The polarity matters. If the default were live, a missing or misspelled env var
 * would fail toward spending money on a machine nobody intended to spend money
 * from. Failing toward $0 costs a confused developer five minutes; failing toward
 * live costs real money and pollutes the cache with results nobody asked for.
 * ===========================================================================
 */

export interface SerpFetch {
  snapshot: SerpSnapshot
  costMicros: Micros
}

/** Organic snapshot + raw multi-type items (never cached as scoring organic). */
export interface SerpDetailedFetch {
  snapshot: SerpSnapshot
  rawItems: Array<Record<string, unknown>>
  costMicros: Micros
}

export interface MapPackFetch {
  snapshot: MapPackSnapshot
  costMicros: Micros
}

export interface BacklinksFetch {
  authorities: Map<string, DomainAuthority>
  /** Targets the API had no data for. Negative-cached by the caller. */
  unresolved: string[]
  costMicros: Micros
}

export interface PageFetch {
  html: string
  costMicros: Micros
  /** HTTP status the crawler saw. Null when the provider did not report one. */
  statusCode: number | null
}

export interface Providers {
  /** True only when real money can be spent. Persisted on every scan_run. */
  readonly live: boolean
  /**
   * Fetch an arbitrary page's HTML.
   *
   * Exists because Reddit 403s server IPs, so SERP monitoring reads comment order through
   * DataForSEO rather than through Reddit directly. Behind the same seam as everything else,
   * so the parser is developed offline against a fixture.
   */
  fetchPageHtml(url: string): Promise<PageFetch>
  fetchOrganicSerp(ctx: FixtureContext): Promise<SerpFetch>
  /**
   * Additive discovery path. Snapshot stays organic-only via normaliseOrganicResult;
   * rawItems carry discussions packs. Must never write rawItems into serp_snapshots
   * under se_type=organic.
   */
  fetchOrganicSerpDetailed(
    ctx: FixtureContext,
    opts?: {
      depth?: number
      device?: 'desktop' | 'mobile'
      os?: 'windows' | 'android' | 'ios'
    },
  ): Promise<SerpDetailedFetch>
  fetchMapPack(ctx: FixtureContext): Promise<MapPackFetch>
  fetchBulkBacklinks(targets: string[]): Promise<BacklinksFetch>
  fetchLocations(): Promise<ProviderLocation[]>
  /** null for fixtures -- there is no account to check. */
  accountStatus(): Promise<AccountStatus | null>
}

// ---------------------------------------------------------------------------

class FixtureProviders implements Providers {
  readonly live = false

  async fetchOrganicSerp(ctx: FixtureContext): Promise<SerpFetch> {
    return { snapshot: fixtureOrganicSerp(ctx), costMicros: 0n }
  }

  async fetchOrganicSerpDetailed(
    ctx: FixtureContext,
    opts?: { depth?: number; device?: 'desktop' | 'mobile'; os?: string },
  ): Promise<SerpDetailedFetch> {
    const { snapshot, rawItems } = fixtureOrganicSerpDetailed(ctx, {
      device: opts?.device ?? 'desktop',
    })
    return { snapshot, rawItems, costMicros: 0n }
  }

  async fetchMapPack(ctx: FixtureContext): Promise<MapPackFetch> {
    return { snapshot: fixtureMapPack(ctx), costMicros: 0n }
  }

  async fetchBulkBacklinks(targets: string[]): Promise<BacklinksFetch> {
    return { ...fixtureBulkBacklinks(targets), costMicros: 0n }
  }

  async fetchPageHtml(url: string): Promise<PageFetch> {
    return { html: fixtureRedditThread(url), costMicros: 0n, statusCode: 200 }
  }

  async fetchLocations(): Promise<ProviderLocation[]> {
    // A small set that exercises the resolver offline: the Region row a widening
    // bug would match, plus all three county-qualification forms.
    //
    // These codes and canonical names are transcribed from the REAL Google Ads
    // geo target constants (2023-05-03), not invented. An earlier version used
    // made-up numbers -- 1015254 for Kenosha, which is actually Atlanta, and
    // 21159 for Wisconsin, which is actually Montana. Fabricated identifiers in
    // a fixture are the same class of problem as a fabricated market: they look
    // authoritative and quietly encode a wrong belief.
    return [
      { locationCode: 1028029, locationName: 'Kenosha,Wisconsin,United States', locationType: 'City', countryIsoCode: 'US' },
      { locationCode: 21182, locationName: 'Wisconsin,United States', locationType: 'State', countryIsoCode: 'US' },
      { locationCode: 9059912, locationName: 'Kenosha County,Wisconsin,United States', locationType: 'County', countryIsoCode: 'US' },
      // Plain form -- no county segment.
      { locationCode: 1026607, locationName: 'McKinney,Texas,United States', locationType: 'City', countryIsoCode: 'US' },
      // County segment WITHOUT the word "County". Real, and exactly as briefed.
      { locationCode: 1014090, locationName: 'Orange,Orange,California,United States', locationType: 'City', countryIsoCode: 'US' },
      // County segment WITH the word "County".
      { locationCode: 1013614, locationName: 'Brentwood,Contra Costa County,California,United States', locationType: 'City', countryIsoCode: 'US' },
      { locationCode: 1014369, locationName: 'Ventura,California,United States', locationType: 'City', countryIsoCode: 'US' },
      { locationCode: 1013509, locationName: 'Tucson,Arizona,United States', locationType: 'City', countryIsoCode: 'US' },
    ]
  }

  async accountStatus(): Promise<AccountStatus | null> {
    return null
  }
}

class LiveProviders implements Providers {
  readonly live = true

  constructor(private readonly client: DataForSeoClient) {}

  async fetchOrganicSerp(ctx: FixtureContext): Promise<SerpFetch> {
    const snapshot = await fetchOrganicSerp(this.client, {
      keyword: ctx.keyword,
      locationCode: ctx.locationCode,
    })
    return { snapshot, costMicros: PRICE.serpOrganicLive }
  }

  async fetchOrganicSerpDetailed(
    ctx: FixtureContext,
    opts?: {
      depth?: number
      device?: 'desktop' | 'mobile'
      os?: 'windows' | 'android' | 'ios'
    },
  ): Promise<SerpDetailedFetch> {
    const detailed = await fetchOrganicSerpDetailed(this.client, {
      keyword: ctx.keyword,
      locationCode: ctx.locationCode,
      depth: opts?.depth ?? 10,
      device: opts?.device ?? 'desktop',
      os: opts?.os ?? (opts?.device === 'mobile' ? 'android' : 'windows'),
    })
    return {
      snapshot: detailed.snapshot,
      rawItems: detailed.rawItems,
      costMicros: PRICE.serpOrganicLive,
    }
  }

  async fetchMapPack(ctx: FixtureContext): Promise<MapPackFetch> {
    const snapshot = await fetchMapPack(this.client, {
      keyword: ctx.keyword,
      locationCode: ctx.locationCode,
    })
    return { snapshot, costMicros: PRICE.serpMapsLive }
  }

  async fetchBulkBacklinks(targets: string[]): Promise<BacklinksFetch> {
    const out = await fetchBulkBacklinks(this.client, targets)
    // Charged per request PLUS per row, on all three endpoints.
    const rows = out.billedRows.ranks + out.billedRows.refdomains + out.billedRows.spam
    const costMicros =
      PRICE.backlinksBulkRequest * BigInt(out.requestCount) +
      PRICE.backlinksBulkRow * BigInt(rows)
    return { authorities: out.authorities, unresolved: out.unresolved, costMicros }
  }

  async fetchPageHtml(url: string): Promise<PageFetch> {
    return fetchPageHtml(this.client, url)
  }

  async fetchLocations(): Promise<ProviderLocation[]> {
    const rows = await fetchLocations(this.client)
    return rows.map((r) => ({
      locationCode: r.locationCode,
      locationName: r.locationName,
      locationType: r.locationType,
      countryIsoCode: r.countryIsoCode,
    }))
  }

  async accountStatus(): Promise<AccountStatus | null> {
    return fetchAccountStatus(this.client)
  }
}

// ---------------------------------------------------------------------------

/** A plain record rather than NodeJS.ProcessEnv, so tests can pass a literal. */
export type EnvLike = Record<string, string | undefined>

export function liveCallsEnabled(env: EnvLike = process.env): boolean {
  // Exact string match. See the polarity comment at the top of this file.
  return env['LIVE_CALLS_ENABLED'] === 'true'
}

export function createProviders(env: EnvLike = process.env): Providers {
  if (!liveCallsEnabled(env)) return new FixtureProviders()

  const login = env['DATAFORSEO_LOGIN']
  const password = env['DATAFORSEO_PASSWORD']
  if (!login || !password) {
    // LIVE_CALLS_ENABLED=true with no credentials is a configuration error, not a
    // reason to silently fall back to fixtures. Falling back would produce a
    // scan full of synthetic markets labelled as real.
    throw new Error(
      'LIVE_CALLS_ENABLED=true but DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are missing. ' +
        'Refusing to fall back to fixtures, which would present synthetic markets as real.',
    )
  }
  // On Vercel: long enough for one organic call, short enough to requeue before
  // the drain headroom (28s) and budget (180s) are exhausted. Abort is retriable.
  const timeoutMs = process.env['VERCEL'] ? 45_000 : 120_000
  return new LiveProviders(
    new DataForSeoClient({ credentials: { login, password }, timeoutMs }),
  )
}

export { archetypeFor }
export type { FixtureContext, AccountStatus }
