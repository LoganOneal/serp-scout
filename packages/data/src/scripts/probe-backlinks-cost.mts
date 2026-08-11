import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'
const client = createDfsClientFromEnv()!
const bal = async (): Promise<number> => {
  const b = await client.get<any[]>(ENDPOINTS.USER_DATA)
  return b?.[0]?.money?.balance ?? 0
}
const before = await bal()
await client.post<any[]>('/backlinks/referring_domains/live', [
  { target: 'baker-brothers.com', limit: 100, order_by: ['rank,desc'] },
])
const after = await bal()
console.log(`balance ${before} -> ${after}`)
console.log(`one referring_domains request (limit 100) = $${(before - after).toFixed(4)}`)
console.log(`118 domains would cost = $${((before - after) * 118).toFixed(2)}`)
