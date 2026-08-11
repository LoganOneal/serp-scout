import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
const client = createDfsClientFromEnv()!
for (const url of process.argv.slice(2)) {
  const body = await client.post<any[]>(ENDPOINTS.ON_PAGE_INSTANT_PAGES, [
    { url, enable_javascript: false, store_raw_html: true },
  ])
  const res = body?.[0]
  const item = res?.items?.[0]
  console.log(`\n=== ${url}`)
  console.log(`  result keys: ${res ? Object.keys(res).join(', ') : '(none)'}`)
  console.log(`  crawl_progress=${res?.crawl_progress} items_count=${res?.items_count}`)
  if (!item) { console.log('  NO ITEM'); continue }
  console.log(`  item keys: ${Object.keys(item).join(', ')}`)
  console.log(`  status_code=${item.status_code}  raw_html len=${(item.raw_html ?? '').length}`)
  console.log(`  external_links_count=${item.meta?.external_links_count}  internal=${item.meta?.internal_links_count}`)
}
