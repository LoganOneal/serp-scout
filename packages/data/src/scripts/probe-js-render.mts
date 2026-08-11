/**
 * Can a JS-capable renderer read the domains our own probe cannot?
 *
 * Two distinct causes hide inside UNKNOWN:
 *   - JS-rendered sites: the markup is an empty shell, we run no JavaScript
 *   - Bot-blocked sites: 403/timeout to a datacenter IP
 *
 * A local headless browser fixes only the first, because it would fetch from
 * the same IP. DataForSEO renders AND crawls from its own network, so this
 * tests whether one call fixes both.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'

const client = createDfsClientFromEnv()!
const bal = async (): Promise<number> => {
  const b = await client.get<any[]>(ENDPOINTS.USER_DATA)
  return b?.[0]?.money?.balance ?? 0
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['tesla.com', 'chron.com', 'twdaz.com', 'greaterhoustonhvac.com', '1sthvacrepairhoustontx.com', 'macfelderplumbing.com']

const before = await bal()
console.log('domain                             http  words  textB  title')
console.log('-'.repeat(96))
for (const d of targets) {
  try {
    const body = await client.post<any[]>(ENDPOINTS.ON_PAGE_INSTANT_PAGES, [
      { url: `https://${d}/`, enable_javascript: true, enable_browser_rendering: true },
    ])
    const item = body?.[0]?.items?.[0]
    const words = item?.meta?.content?.plain_text_word_count ?? null
    const bytes = item?.meta?.content?.plain_text_size ?? null
    const title = (item?.meta?.title ?? '').slice(0, 40)
    console.log(
      `${d.slice(0, 33).padEnd(34)} ${String(item?.status_code ?? '—').padStart(4)} ` +
        `${String(words ?? '—').padStart(6)} ${String(bytes ?? '—').padStart(6)}  ${title}`,
    )
  } catch (e) {
    console.log(`${d.slice(0, 33).padEnd(34)} FAILED ${(e as Error).message.slice(0, 44)}`)
  }
}
const after = await bal()
console.log(`\ncost for ${targets.length} rendered page(s): $${(before - after).toFixed(4)}`)
console.log(`  -> $${((before - after) / targets.length).toFixed(5)} each · 155 UNKNOWN rows = $${(((before - after) / targets.length) * 155).toFixed(2)}`)
