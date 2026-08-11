import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchPageHtml } from '../providers/dataforseo/instant-pages.js'
const client = createDfsClientFromEnv()!
for (const url of ['https://example.com', 'https://old.reddit.com/r/test']) {
  const r = await fetchPageHtml(client, url)
  console.log(`${url}\n  status=${r.statusCode}  html=${r.html.length} bytes`)
}
