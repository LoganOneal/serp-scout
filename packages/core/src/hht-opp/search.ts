/**
 * Search is provider-independent. Do not scrape Google result pages.
 * Live discovery uses DataForSEO organic SERP. Offline mode uses a labeled
 * fixture catalog — never the generic local-service SERP fixtures.
 */
export interface SearchHit {
  url: string
  title: string | null
  snippet: string | null
  domain: string | null
}

export interface SearchProvider {
  id: string
  live: boolean
  search(query: string, limit?: number): Promise<SearchHit[]>
  searchSite(domain: string, query: string, limit?: number): Promise<SearchHit[]>
  searchMentions(term: string, limit?: number): Promise<SearchHit[]>
  searchRelated(domain: string, limit?: number): Promise<SearchHit[]>
}

export class UnconfiguredSearchProvider implements SearchProvider {
  readonly id = 'unconfigured'
  readonly live = false

  async search(): Promise<SearchHit[]> {
    return []
  }
  async searchSite(): Promise<SearchHit[]> {
    return []
  }
  async searchMentions(): Promise<SearchHit[]> {
    return []
  }
  async searchRelated(): Promise<SearchHit[]> {
    return []
  }
}
