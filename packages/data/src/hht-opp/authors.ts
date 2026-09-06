import 'server-only'
import { authorSearchQueries, excludeDiscoveryDomain, extractAuthors, hitRootDomain } from '@rnr/core'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../db.js'
import { hhtOppAuthorPublications, hhtOppAuthors, hhtOppCrawledPages } from '../schema.js'
import { researchHhtOppSeed, type ResearchSeedResult } from './research.js'
import { createHhtOppSearchProvider } from './search.js'

export async function collectHhtOppAuthors(db: Database, domainId?: number): Promise<number> {
  const pages = domainId
    ? await db.select().from(hhtOppCrawledPages).where(eq(hhtOppCrawledPages.domainId, domainId))
    : await db.select().from(hhtOppCrawledPages).limit(80)
  let saved = 0
  for (const page of pages) {
    for (const author of extractAuthors(page.rawHtml, `${page.title ?? ''}\n${page.pageText ?? ''}`)) {
      const [existing] = await db
        .select({ id: hhtOppAuthors.id })
        .from(hhtOppAuthors)
        .where(and(eq(hhtOppAuthors.domainId, page.domainId), eq(hhtOppAuthors.name, author.name)))
        .limit(1)
      if (existing) continue
      await db.insert(hhtOppAuthors).values({
        domainId: page.domainId,
        name: author.name,
        sourceUrl: page.url,
        sourceExcerpt: author.excerpt,
      })
      saved += 1
    }
  }
  return saved
}

export async function expandHhtOppAuthors(
  db: Database,
  options: { authorLimit?: number; domainLimit?: number; useFixture?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ authors: number; researched: ResearchSeedResult[] }> {
  await collectHhtOppAuthors(db)
  const authors = await db.select().from(hhtOppAuthors).limit(options.authorLimit ?? 5)
  const provider = createHhtOppSearchProvider(process.env, { fixture: options.useFixture })
  const researched: ResearchSeedResult[] = []
  const seen = new Set<string>()
  const domainLimit = Math.min(options.domainLimit ?? 6, 10)

  for (const author of authors) {
    for (const query of authorSearchQueries(author.name)) {
      const hits = await provider.search(query, 5)
      for (const hit of hits) {
        const root = hitRootDomain(hit)
        if (!root || seen.has(root) || excludeDiscoveryDomain(root).excluded) continue
        seen.add(root)
        const [existingPub] = await db
          .select({ id: hhtOppAuthorPublications.id })
          .from(hhtOppAuthorPublications)
          .where(and(eq(hhtOppAuthorPublications.authorId, author.id), eq(hhtOppAuthorPublications.domain, root)))
          .limit(1)
        if (!existingPub) {
          await db.insert(hhtOppAuthorPublications).values({ authorId: author.id, domain: root, url: hit.url })
        }
        if (researched.length >= domainLimit) continue
        researched.push(await researchHhtOppSeed(db, hit.url, { strategy: 'author_graph', fetchImpl: options.fetchImpl }))
      }
    }
  }

  return { authors: authors.length, researched }
}

export async function listHhtOppAuthors(db: Database) {
  const authors = await db.select().from(hhtOppAuthors).limit(100)
  const pubs = await db.select().from(hhtOppAuthorPublications).limit(200)
  return authors.map((author) => ({
    ...author,
    publications: pubs.filter((row) => row.authorId === author.id),
  }))
}
