/**
 * Can we ask, for a given domain, WHICH high-authority sites link to it?
 *
 * This is the inbound index, which is the direction DataForSEO actually
 * indexes -- there is no "outbound links from bbb.org/<category>" product.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
const client = createDfsClientFromEnv()!
const target = process.argv[2] ?? 'baker-brothers.com'
try {
  const body = await client.post<any[]>('/backlinks/referring_domains/live', [
    { target, limit: 25, order_by: ['rank,desc'] },
  ])
  const res = body?.[0]
  console.log(`target=${target}  total=${res?.total_count}  items=${res?.items_count}`)
  for (const it of (res?.items ?? []).slice(0, 20)) {
    console.log(
      `  rank ${String(it.rank).padStart(4)}  ${String(it.domain).padEnd(38)} ` +
        `backlinks=${it.backlinks}  dofollow=${it.dofollow}  lost=${it.is_lost ?? '—'}`,
    )
  }
} catch (e) {
  console.log('FAILED:', (e as Error).message)
}
