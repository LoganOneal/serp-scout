/**
 * What fields does the Maps endpoint actually return per business?
 *
 * Enrich mode's Stage 1 needs a business directory carrying a website and, if
 * possible, a business status — CLOSED_PERMANENTLY listings are the highest
 * value rows in the whole feature. The spec names Google Places; this checks
 * whether the Maps source we already pay $0.002 for carries the same fields,
 * because Places is ~16x the price per request and we hold no key for it.
 *
 * Costs one SERP_MAPS_LIVE request.
 *
 *   pnpm exec tsx packages/data/src/scripts/probe-maps-fields.mts [keyword] [locationCode]
 */
import 'dotenv/config'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { ENDPOINTS } from '../providers/dataforseo/endpoints.js'

const keyword = process.argv[2] ?? 'plumber'
const locationCode = Number(process.argv[3] ?? 1023191) // Tucson, AZ

const client = createDfsClientFromEnv()
const result = await client.post<Array<{ items?: Array<Record<string, unknown>> }>>(
  ENDPOINTS.SERP_MAPS_LIVE,
  [{ keyword, location_code: locationCode, language_code: 'en' }],
)

const items = (Array.isArray(result) ? result[0]?.items : undefined) ?? []
const maps = items.filter((i) => i['type'] === 'maps_search')
console.log(`keyword="${keyword}" location=${locationCode} · ${maps.length} maps_search item(s)\n`)

const first = maps[0]
if (!first) {
  console.log('No maps items returned.')
  process.exit(0)
}

console.log('=== every key on the first item ===')
for (const [k, v] of Object.entries(first)) {
  const preview =
    v === null || v === undefined
      ? String(v)
      : typeof v === 'object'
        ? `${Array.isArray(v) ? 'array' : 'object'} ${JSON.stringify(v).slice(0, 90)}`
        : String(v).slice(0, 90)
  console.log(`  ${k.padEnd(28)} ${preview}`)
}

// The fields Stage 1 depends on, across the whole result set.
const FIELDS = [
  'title',
  'domain',
  'url',
  'address',
  'phone',
  'rating',
  'category',
  'is_claimed',
  'business_status',
  'permanently_closed',
  'work_time',
  'cid',
  'place_id',
]
console.log('\n=== coverage across all items ===')
for (const f of FIELDS) {
  const present = maps.filter((m) => m[f] !== undefined && m[f] !== null).length
  console.log(`  ${f.padEnd(24)} ${String(present).padStart(3)}/${maps.length}`)
}

const withDomain = maps.filter((m) => typeof m['domain'] === 'string' && m['domain']).length
console.log(`\ndomains present: ${withDomain}/${maps.length}`)
process.exit(0)
