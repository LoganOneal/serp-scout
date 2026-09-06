import 'server-only'
import { HHT_OPP_MENTION_QUERIES, excludeDiscoveryDomain, hitRootDomain } from '@rnr/core'
import type { Database } from '../db.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'
import { createHhtOppSearchProvider } from './search.js'

export async function discoverHhtOppMentions(
  db: Database,
  options: { domainLimit?: number; useFixture?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ queries: number; hits: number; researched: ResearchSeedResult[] }> {
  const provider = createHhtOppSearchProvider(process.env, { fixture: options.useFixture })
  const domainLimit = Math.min(Math.max(options.domainLimit ?? 6, 1), 12)
  const seen = new Set<string>()
  const researched: ResearchSeedResult[] = []
  let hits = 0

  for (const query of HHT_OPP_MENTION_QUERIES) {
    const results = await provider.searchMentions(query, 10)
    for (const hit of results) {
      const root = hitRootDomain(hit)
      if (!root || seen.has(root) || excludeDiscoveryDomain(root).excluded) continue
      seen.add(root)
      hits += 1
      if (researched.length >= domainLimit) continue
      researched.push(await researchHhtOppSeed(db, hit.url, { strategy: 'unlinked_mentions', fetchImpl: options.fetchImpl }))
    }
  }

  return { queries: HHT_OPP_MENTION_QUERIES.length, hits, researched }
}
