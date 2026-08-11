import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
const client = createDfsClientFromEnv()!
for (const url of [process.argv[2] ?? 'https://example.com']) {
  const body = await client.post<any>(ENDPOINTS.ON_PAGE_INSTANT_PAGES, [
    { url, enable_javascript: false, store_raw_html: true },
  ])
  console.log('=== raw shape for', url)
  console.log(JSON.stringify(body, null, 1).slice(0, 1600))
}
