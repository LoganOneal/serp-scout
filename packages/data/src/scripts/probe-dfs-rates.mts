/**
 * What DataForSEO actually charges us, from DataForSEO.
 *
 * /appendix/user_data is FREE and returns the account's live rate card. We bill
 * runs from hardcoded constants in @rnr/core PRICE; this prints the truth so the
 * two can be compared. Run it whenever a run's billed cost looks wrong.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-dfs-rates.mts
 */
import 'dotenv/config'
import { DataForSeoClient } from '../providers/dataforseo/client.js'

const login = process.env['DATAFORSEO_LOGIN']?.trim()
const password = process.env['DATAFORSEO_PASSWORD']?.trim()
if (!login || !password) {
  console.error('DATAFORSEO_LOGIN / PASSWORD missing in .env')
  process.exit(1)
}

const client = new DataForSeoClient({
  credentials: { login, password },
  timeoutMs: 30_000,
})

const result = await client.get<
  Array<{ money?: Record<string, unknown>; price?: Record<string, unknown> }>
>('/appendix/user_data')
const row = Array.isArray(result) ? result[0] : undefined

const money = row?.money as { total?: number; balance?: number } | undefined
console.log(`balance $${money?.balance} · lifetime spend $${money?.total}`)

/** Flatten the price tree to "path → cost_type $cost" for normal priority only. */
const rates = new Map<string, string>()
const walk = (node: unknown, path: string[]): void => {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    const e = node[0] as { cost_type?: string; cost?: number } | undefined
    if (e) {
      // Priorities are all the same price for our endpoints; collapse to one row.
      const key = path.at(-1)?.startsWith('priority_') ? path.slice(0, -1) : path
      rates.set(key.join('/'), `${e.cost_type} $${e.cost}`)
    }
    return
  }
  if (typeof node === 'number') return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, [...path, k])
}
walk(row?.price, [])

console.log('\n=== endpoints the discovery runner calls ===')
for (const [path, rate] of [...rates].sort()) {
  if (
    /^serp\/google\/(organic|maps)\/live/.test(path) ||
    path === 'keywords_data/google_ads/search_volume/live'
  ) {
    console.log(`${path.padEnd(48)} ${rate}`)
  }
}

console.log('\n=== all serp/google organic+maps paths found ===')
for (const [path, rate] of [...rates].sort()) {
  if (path.startsWith('serp/google/organic') || path.startsWith('serp/google/maps')) {
    console.log(`${path.padEnd(52)} ${rate}`)
  }
}

const serp = (row?.price as Record<string, any> | undefined)?.serp
console.log('serp.live RAW:', JSON.stringify(serp?.live)?.slice(0, 900))

console.log('\n=== serp.task_post / task_get (queued SERP) ===')
console.log('task_post:', JSON.stringify(serp?.task_post)?.slice(0, 700))
console.log('task_get :', JSON.stringify(serp?.task_get)?.slice(0, 700))
