/**
 * Is a queued SERP really 70% cheaper, and does task_get cost anything?
 *
 * Priced by balance delta, not the rate card. Also measures how long the task
 * takes to become ready, because that latency is the real trade.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'

const client = createDfsClientFromEnv()!
const bal = async (): Promise<number> => {
  const b = await client.get<any[]>(ENDPOINTS.USER_DATA)
  return b?.[0]?.money?.balance ?? 0
}

const keyword = process.argv[2] ?? 'emergency plumber'
const locationCode = Number(process.argv[3] ?? 1023191)

// ---- live, for the baseline ----
const b0 = await bal()
await client.post<any[]>(ENDPOINTS.SERP_ORGANIC_LIVE, [
  { keyword, location_code: locationCode, language_code: 'en', device: 'desktop', depth: 10 },
])
const b1 = await bal()
console.log(`live  : $${(b0 - b1).toFixed(5)}`)

// ---- queued ----
const t0 = Date.now()
const posted = await client.post<any[]>(ENDPOINTS.SERP_ORGANIC_TASK_POST, [
  { keyword, location_code: locationCode, language_code: 'en', device: 'desktop', depth: 10 },
])
const taskId = posted?.[0]?.id ?? (posted as any)?.id
const b2 = await bal()
console.log(`post  : $${(b1 - b2).toFixed(5)}  (task ${taskId ?? 'NO ID'})`)

if (!taskId) {
  console.log('no task id returned; response was:', JSON.stringify(posted).slice(0, 300))
} else {
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const got = await client.get<any[]>(`${ENDPOINTS.SERP_ORGANIC_TASK_GET}/${taskId}`)
      const items = got?.[0]?.items
      if (Array.isArray(items) && items.length > 0) {
        ready = true
        const b3 = await bal()
        console.log(
          `get   : $${(b2 - b3).toFixed(5)}  ready after ${((Date.now() - t0) / 1000).toFixed(0)}s · ${items.length} items`,
        )
        console.log(`\nqueued total: $${(b1 - b3).toFixed(5)} vs live $${(b0 - b1).toFixed(5)}`)
        const saving = 1 - (b1 - b3) / (b0 - b1)
        console.log(`saving: ${(saving * 100).toFixed(0)}%`)
        console.log(`\n58 niches x 50 markets x 3 kw, desktop (8,700 SERPs):`)
        console.log(`  live   $${(8700 * (b0 - b1)).toFixed(2)}`)
        console.log(`  queued $${(8700 * (b1 - b3)).toFixed(2)}`)
      }
    } catch { /* not ready yet */ }
  }
  if (!ready) console.log('task did not become ready within 120s')
}
process.exit(0)
