/**
 * The correct queued flow: task_post -> poll tasks_ready -> task_get once.
 * Polling task_get directly marks a task "Handed" and loses the result.
 */
import 'dotenv/config'
const auth = 'Basic ' + Buffer.from(`${process.env['DATAFORSEO_LOGIN']}:${process.env['DATAFORSEO_PASSWORD']}`).toString('base64')
const BASE = 'https://api.dataforseo.com/v3'
const call = async (p: string, body?: unknown) =>
  (await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })).json()
const bal = async () => (await call('/appendix/user_data')).tasks?.[0]?.result?.[0]?.money?.balance ?? 0

const b0 = await bal()
const posted = await call('/serp/google/organic/task_post', [
  { keyword: 'gutter cleaning', location_code: 1023191, language_code: 'en', device: 'desktop', depth: 10 },
])
const id = posted.tasks?.[0]?.id
console.log(`posted ${id} · $${(b0 - (await bal())).toFixed(5)}`)

const t0 = Date.now()
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const ready = await call('/serp/google/organic/tasks_ready')
  const list = ready.tasks?.[0]?.result ?? []
  const mine = list.find((x: any) => x.id === id)
  if (!mine) continue
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const b1 = await bal()
  const got = await call(`/serp/google/organic/task_get/advanced/${id}`)
  const items = got.tasks?.[0]?.result?.[0]?.items ?? []
  const b2 = await bal()
  console.log(`ready after ${secs}s · tasks_ready cost $${(b1 - b2).toFixed(5)} for the fetch`)
  console.log(`items ${items.length} · organic ${items.filter((x: any) => x.type === 'organic').length}`)
  console.log(`first organic: ${items.find((x: any) => x.type === 'organic')?.domain}`)
  process.exit(0)
}
console.log('never appeared in tasks_ready within 225s')
process.exit(0)
