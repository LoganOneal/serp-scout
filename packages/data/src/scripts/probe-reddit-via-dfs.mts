/**
 * Can DataForSEO's renderer reach reddit.com? It resolved other 403s earlier.
 * If it cannot, archived/locked status is unobtainable without a residential
 * proxy and the ranking model must use proxies for those signals.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
const client = createDfsClientFromEnv()!
for (const url of [
  'https://www.reddit.com/r/Tucson/comments/13f2vzm/what_are_some_good_hvac_companies_in_tucson/',
  'https://old.reddit.com/r/Tucson/comments/13f2vzm/',
]) {
  try {
    const body = await client.post<any[]>(ENDPOINTS.ON_PAGE_INSTANT_PAGES, [
      { url, enable_javascript: true, enable_browser_rendering: true },
    ])
    const it = body?.[0]?.items?.[0]
    console.log(`${url.slice(0, 62)}\n   status ${it?.status_code} · words ${it?.meta?.content?.plain_text_word_count ?? '—'} · title "${(it?.meta?.title ?? '').slice(0,50)}"`)
  } catch (e) {
    console.log(`${url.slice(0, 62)}\n   FAILED ${(e as Error).message.slice(0, 70)}`)
  }
}
