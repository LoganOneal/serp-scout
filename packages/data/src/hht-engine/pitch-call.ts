import { eq } from 'drizzle-orm'
import { judgePitchPages, type PitchPage } from '@rnr/core'
import type { EngineDatabase } from './db.js'
import { hhtEngineDomains, hhtEngineOpportunities } from './schema.js'

const PATHS = ['/', '/write-for-us', '/guest-post', '/guest-posts', '/contribute', '/submissions']

export async function evaluateGuestPostPitchCalls(
  db: EngineDatabase,
  options: { concurrency?: number } = {},
): Promise<{ evaluated: number; counts: Record<string, number> }> {
  const leads = await db.select({ domain: hhtEngineOpportunities.rootDomain })
    .from(hhtEngineOpportunities)
    .where(eq(hhtEngineOpportunities.type, 'guest_post'))
  const domains = [...new Set(leads.map((lead) => lead.domain))]
  const counts: Record<string, number> = {}
  let cursor = 0
  const concurrency = options.concurrency ?? 2

  async function worker() {
    while (cursor < domains.length) {
      const domain = domains[cursor++]
      const pages = await loadPages(domain)
      const judgement = judgePitchPages(domain, pages)
      await db.update(hhtEngineDomains).set({
        pitchCall: judgement.verdict,
        pitchCallUrl: judgement.pitchUrl,
        pitchCallQuote: (judgement.quote || judgement.notes).slice(0, 500),
        pitchCallAt: new Date(),
      }).where(eq(hhtEngineDomains.rootDomain, domain))
      counts[judgement.verdict] = (counts[judgement.verdict] ?? 0) + 1
      if (domains.indexOf(domain) % 20 === 0) {
        console.log(`${countsTotal(counts)} / ${domains.length} ${domain} ${judgement.verdict}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { evaluated: domains.length, counts }
}

function countsTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0)
}

async function loadPages(domain: string): Promise<PitchPage[]> {
  const pages = await Promise.all(PATHS.map((path) => fetchPage(`https://${domain}${path}`)))
  return pages.filter((page): page is PitchPage => page !== null)
}

async function fetchPage(url: string): Promise<PitchPage | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HotelHotTubsFeasibility/1.0)' },
    })
    const html = (await response.text()).slice(0, 400_000)
    if (/wp-json|oembed|\/feed\/?$/i.test(response.url) || /\.(png|jpe?g|webp|gif|pdf)(\?|$)/i.test(response.url)) {
      return { url: response.url, status: response.status, text: '', hasContact: false }
    }
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#8217;|&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    const hasContact = /mailto:|\/contact(?:-us)?\/?|@[a-z0-9.-]+\.[a-z]{2,}/i.test(html)
    return { url: response.url || url, status: response.status, text, hasContact }
  } catch {
    return { url, status: null, text: '', hasContact: false }
  } finally {
    clearTimeout(timer)
  }
}
