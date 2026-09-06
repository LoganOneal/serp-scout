import 'server-only'
import { classifyCompetitorLinkReason, excludeDiscoveryDomain, HHT_SITE_DOMAIN, intersectReferringDomains } from '@rnr/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { createSemrushClient, SemrushUnavailable } from '../opportunity-miner/semrush/client.js'
import { hhtOppCompetitorHits, hhtOppDomains } from '../schema.js'
import { crawlHhtOppPage } from './crawl.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'
import { getHhtOppCompetitors } from './settings.js'

export interface CompetitorMineResult {
  competitors: string[]
  overlaps: number
  researched: number
  created: number
  updated: number
  error: string | null
}

export async function mineHhtOppCompetitors(
  db: Database,
  options: {
    competitors?: string[]
    seeds?: string[]
    domainLimit?: number
    fetchImpl?: typeof fetch
    live?: boolean
  } = {},
): Promise<CompetitorMineResult> {
  const competitors = options.competitors ?? (await getHhtOppCompetitors(db))
  const domainLimit = Math.min(Math.max(options.domainLimit ?? 8, 1), 20)
  const result: CompetitorMineResult = {
    competitors,
    overlaps: 0,
    researched: 0,
    created: 0,
    updated: 0,
    error: null,
  }

  let overlaps: Array<{ domain: string; competitorCount: number; competitors: string[]; alreadyLinksToHht: boolean }>
  if (options.seeds?.length) {
    overlaps = options.seeds
      .map((value) => value.trim().toLowerCase())
      .filter((domain) => domain && !excludeDiscoveryDomain(domain).excluded)
      .map((domain) => ({ domain, competitorCount: 2, competitors, alreadyLinksToHht: false }))
  } else {
    try {
      const client = createSemrushClient(db, process.env, options.live ?? true)
      const byCompetitor: Record<string, Awaited<ReturnType<typeof client.referringDomains>>> = {}
      for (const domain of competitors) {
        byCompetitor[domain] = await client.referringDomains(domain, 40)
      }
      let hhtRefs: string[] = []
      try {
        hhtRefs = (await client.referringDomains(HHT_SITE_DOMAIN, 40)).map((row) => row.domain)
      } catch {
        hhtRefs = []
      }
      overlaps = intersectReferringDomains(byCompetitor, hhtRefs, 2)
    } catch (error) {
      result.error =
        error instanceof SemrushUnavailable
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Competitor mining failed.'
      return result
    }
  }

  result.overlaps = overlaps.length
  let remaining = domainLimit
  for (const overlap of overlaps) {
    const [existing] = await db
      .select({ id: hhtOppCompetitorHits.id })
      .from(hhtOppCompetitorHits)
      .where(eq(hhtOppCompetitorHits.referringDomain, overlap.domain))
      .limit(1)
    if (existing) {
      await db
        .update(hhtOppCompetitorHits)
        .set({
          competitorCount: overlap.competitorCount,
          competitors: overlap.competitors,
          alreadyLinksToHht: overlap.alreadyLinksToHht,
        })
        .where(eq(hhtOppCompetitorHits.id, existing.id))
    } else {
      await db.insert(hhtOppCompetitorHits).values({
        referringDomain: overlap.domain,
        competitorCount: overlap.competitorCount,
        competitors: overlap.competitors,
        alreadyLinksToHht: overlap.alreadyLinksToHht,
      })
    }

    if (remaining <= 0 || overlap.alreadyLinksToHht) continue
    const researched = await researchOverlap(db, overlap.domain, options.fetchImpl)
    remaining -= 1
    result.researched += 1
    result.created += researched.created
    result.updated += researched.updated
    const [domain] = await db
      .select({ id: hhtOppDomains.id })
      .from(hhtOppDomains)
      .where(eq(hhtOppDomains.rootDomain, overlap.domain))
      .limit(1)
    if (domain) {
      await db
        .update(hhtOppCompetitorHits)
        .set({ domainId: domain.id, reason: researched.error })
        .where(eq(hhtOppCompetitorHits.referringDomain, overlap.domain))
    }
  }

  return result
}

async function researchOverlap(
  db: Database,
  domain: string,
  fetchImpl?: typeof fetch,
): Promise<ResearchSeedResult> {
  const page = await crawlHhtOppPage(`https://${domain}`, { fetchImpl })
  const reason = classifyCompetitorLinkReason(`${page.title ?? ''}\n${page.pageText ?? ''}`)
  const seed = page.finalUrl ?? `https://${domain}`
  return researchHhtOppSeed(db, seed, { strategy: 'competitor_backlinks', fetchImpl })
}
