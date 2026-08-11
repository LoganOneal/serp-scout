/**
 * Queued vs live SERP, priced by balance delta.
 *
 * Uses raw fetch because DataForSeoClient treats any status_code other than
 * 20000 as a failure, and task_post answers 20100 "Task Created" -- which is
 * its SUCCESS code. Wiring queued SERPs means teaching the client that.
 */
import 'dotenv/config'

const login = process.env['DATAFORSEO_LOGIN']!
const password = process.env['DATAFORSEO_PASSWORD']!
const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')
const BASE = 'https://api.dataforseo.com/v3'

const call = async (path: string, body?: unknown): Promise<any> => {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return res.json()
}
const bal = async (): Promise<number> =>
  (await call('/appendix/user_data')).tasks?.[0]?.result?.[0]?.money?.balance ?? 0

const keyword = process.argv[2] ?? 'emergency plumber'
const loc = Number(process.argv[3] ?? 1023191)
const payload = [{ keyword, location_code: loc, language_code: 'en', device: 'desktop', depth: 10 }]

const b0 = await bal()
const live = await call('/serp/google/organic/live/advanced', payload)
const b1 = await bal()
const liveCost = b0 - b1
console.log(`live   : $${liveCost.toFixed(5)}  (task cost field: ${live.tasks?.[0]?.cost})`)

const t0 = Date.now()
const posted = await call('/serp/google/organic/task_post', payload)
const task = posted.tasks?.[0]
const taskId = task?.id
const b2 = await bal()
console.log(`post   : $${(b1 - b2).toFixed(5)}  status ${task?.status_code} "${task?.status_message}"  id=${taskId ?? 'none'}`)

let ready = false
for (let i = 0; i < 40 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 4000))
  const got = await call(`/serp/google/organic/task_get/advanced/${taskId}`)
  const t = got.tasks?.[0]
  const items = t?.result?.[0]?.items
  if (t?.status_code === 20000 && Array.isArray(items)) {
    ready = true
    const b3 = await bal()
    const queuedCost = b1 - b3
    console.log(`get    : $${(b2 - b3).toFixed(5)}  ready in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${items.length} items`)
    console.log(`\nqueued total $${queuedCost.toFixed(5)} vs live $${liveCost.toFixed(5)} -> ${((1 - queuedCost / liveCost) * 100).toFixed(0)}% cheaper`)
    for (const n of [2900, 8700, 23200]) {
      console.log(`  ${String(n).padStart(6)} SERPs: live $${(n * liveCost).toFixed(2)}  queued $${(n * queuedCost).toFixed(2)}`)
    }
  }
}
if (!ready) console.log('not ready within 160s')
process.exit(0)
