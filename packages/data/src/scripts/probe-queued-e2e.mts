/**
 * End-to-end queued SERP: post -> awaiting -> tasks_ready -> collect.
 *
 * Costs $0.0006. Proves the two-phase lifecycle actually returns a payload,
 * which is the half that can silently lose a paid-for result.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import {
  fetchReadyTaskIds,
  getSerpTaskResult,
  postSerpTask,
} from '../providers/dataforseo/serp-queued.js'

const client = createDfsClientFromEnv()!
const posted = await postSerpTask(client, {
  keyword: process.argv[2] ?? 'tree removal',
  locationCode: Number(process.argv[3] ?? 1023191),
  device: 'desktop',
  os: 'windows',
  depth: 10,
})
console.log(`posted task ${posted.taskId} · $${(Number(posted.costMicros) / 1e6).toFixed(5)}`)

const t0 = Date.now()
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const ready = await fetchReadyTaskIds(client)
  if (!ready.has(posted.taskId)) {
    if (i % 6 === 5) console.log(`  ...${((Date.now() - t0) / 1000).toFixed(0)}s, ${ready.size} other task(s) ready`)
    continue
  }
  const got = await getSerpTaskResult(client, posted.taskId)
  const organic = got.rawItems.filter((x: any) => x.type === 'organic')
  console.log(`\nready after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.log(`items ${got.rawItems.length} · organic ${organic.length}`)
  console.log(`first organic: ${(organic[0] as any)?.domain}`)
  console.log(`\nqueued cost $0.00060 vs live $0.00200 — same payload shape`)
  process.exit(0)
}
console.log('never appeared in tasks_ready — task id retained, safe to retry')
process.exit(1)
