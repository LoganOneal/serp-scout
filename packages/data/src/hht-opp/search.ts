import 'server-only'
import {
  FixtureHhtOppSearchProvider,
  HHT_OPP_DISCOVERY_DEFAULTS,
  type SearchHit,
  type SearchProvider,
} from '@rnr/core'
import { DataForSeoClient } from '../providers/dataforseo/client.js'
import { fetchOrganicSerp } from '../providers/dataforseo/serp.js'
import { liveCallsEnabled, type EnvLike } from '../providers/index.js'

const US_LOCATION_CODE = 2840

/**
 * Live discovery uses DataForSEO organic SERP at page-1 depth. Fixture mode uses
 * the labeled HHT catalog — never the generic local-service SERP fixtures.
 */
export function createHhtOppSearchProvider(
  env: EnvLike = process.env,
  opts: { fixture?: boolean } = {},
): SearchProvider {
  if (opts.fixture || !liveCallsEnabled(env)) return new FixtureHhtOppSearchProvider()

  const login = env['DATAFORSEO_LOGIN']
  const password = env['DATAFORSEO_PASSWORD']
  if (!login || !password) {
    throw new Error(
      'LIVE_CALLS_ENABLED=true but DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are missing. ' +
        'Refusing to fall back to fixtures, which would present synthetic publishers as live search.',
    )
  }
  const timeoutMs = process.env['VERCEL'] ? 45_000 : 120_000
  return new DataForSeoHhtOppSearchProvider(new DataForSeoClient({ credentials: { login, password }, timeoutMs }))
}

class DataForSeoHhtOppSearchProvider implements SearchProvider {
  readonly id = 'dataforseo'
  readonly live = true

  constructor(private readonly client: DataForSeoClient) {}

  async search(query: string, limit = HHT_OPP_DISCOVERY_DEFAULTS.hitsPerQuery): Promise<SearchHit[]> {
    const snapshot = await fetchOrganicSerp(this.client, {
      keyword: query,
      locationCode: US_LOCATION_CODE,
      depth: Math.max(10, limit),
    })
    return snapshot.items.slice(0, limit).map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.description,
      domain: item.domain,
    }))
  }

  async searchSite(domain: string, query: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`site:${domain} ${query}`, limit)
  }

  async searchMentions(term: string, limit?: number): Promise<SearchHit[]> {
    return this.search(term, limit)
  }

  async searchRelated(domain: string, limit?: number): Promise<SearchHit[]> {
    return this.search(`related:${domain} travel publication`, limit)
  }
}
