/**
 * What does the "does this domain still rank" check actually cost?
 *
 * Phase 4 of the coverage plan proposes DataForSEO Labs ranked_keywords as a
 * quality gate. Everything else in that phase reuses data already bought; this
 * is the one line item that is a genuinely new request, and it was unmeasured.
 * Priced by balance delta, not a rate card.
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'

const client = createDfsClientFromEnv()!
const bal = async (): Promise<number> => {
  const b = await client.get<any[]>(ENDPOINTS.USER_DATA)
  return b?.[0]?.money?.balance ?? 0
}

const target = process.argv[2] ?? 'hays-nyc.com'
const before = await bal()
let ranked = 0
try {
  const body = await client.post<any[]>('/dataforseo_labs/google/ranked_keywords/live', [
    { target, location_code: 2840, language_code: 'en', limit: 50 },
  ])
  const res = body?.[0]
  ranked = res?.items_count ?? 0
  console.log(`${target}: ${res?.total_count ?? 0} ranked keyword(s) total, ${ranked} returned`)
  for (const it of (res?.items ?? []).slice(0, 5)) {
    console.log(
      `   pos ${String(it.ranked_serp_element?.serp_item?.rank_absolute ?? '—').padStart(3)}  ` +
        `${it.keyword_data?.keyword ?? '—'}  vol ${it.keyword_data?.keyword_info?.search_volume ?? '—'}`,
    )
  }
} catch (e) {
  console.log('FAILED:', (e as Error).message.slice(0, 120))
}
const after = await bal()
const cost = before - after
console.log(`\ncost: $${cost.toFixed(4)} per domain`)
console.log(`  40 candidates/market  -> $${(cost * 40).toFixed(2)}`)
console.log(`  gated to top 15       -> $${(cost * 15).toFixed(2)}`)
