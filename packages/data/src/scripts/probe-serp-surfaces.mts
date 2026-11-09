/**
 * Does surface extraction actually work against a real Google SERP?
 *
 * ==================== THE UNKNOWN THIS BUYS ====================
 * `readSurfacesDetailed` walks each block's NESTED `items` array, because our
 * slot in a Discussions pack or an images strip is never a top-level result.
 * That logic is unit-tested against a shape I wrote, which proves the code does
 * what I think — not that Google's response has that shape.
 *
 * If the nesting differs in the wild, every non-organic surface reports THEIRS
 * forever: measured-looking, plausible, and always wrong in the same direction.
 * That failure is invisible without buying one real SERP.
 * ==============================================================
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-serp-surfaces.mts [kw ...] --live
 */
import 'dotenv/config'
import {
  PRICE,
  SURFACE_GLYPHS,
  SURFACE_LABELS,
  formatMicrosUsd,
  surfaceForItemType,
  surfaceState,
} from '@rnr/core'
import { db } from '../db.js'
import { findSiteByDomain } from '../spaces/sites.js'
import { createDfsClientFromEnv } from '../providers/dataforseo/keyword-volume.js'
import { fetchOrganicSerpDetailed } from '../providers/dataforseo/serp.js'
import { readSurfacesDetailed, recordSurfaces } from '../spaces/surfaces.js'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const positional = args.filter((a) => !a.startsWith('--'))
const KEYWORDS =
  positional.length > 0
    ? positional
    : ['hotels with jacuzzi in room chicago', 'hot tub suites gatlinburg']

const LOCATION = 2840 // United States

const site = await findSiteByDomain(db(), 'hotelhottubs.com')
if (!site?.domain) {
  console.error('hotelhottubs.com not found')
  process.exit(1)
}
const ourDomain = site.domain

console.log(
  `${KEYWORDS.length} SERP(s) at ${formatMicrosUsd(PRICE.serpOrganicLive)} each = ` +
    `${formatMicrosUsd(PRICE.serpOrganicLive * BigInt(KEYWORDS.length))}`,
)

if (!LIVE) {
  console.log('Pass --live to spend.')
  await db().$client.end()
  process.exit(0)
}

const client = createDfsClientFromEnv()
if (!client) {
  console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set')
  process.exit(1)
}

for (const keyword of KEYWORDS) {
  /**
   * One vendor-side failure must not lose the SERPs already bought. The first
   * run of this probe died on a 40101 from DataForSEO and threw away a
   * successful measurement it had already paid for.
   */
  let serp
  try {
    serp = await fetchOrganicSerpDetailed(client, { keyword, locationCode: LOCATION })
  } catch (e) {
    console.log(`
=== ${keyword}
  FAILED: ${(e as Error).message}`)
    continue
  }

  const rawTypes = [
    ...new Set(
      serp.rawItems
        .map((i) => (typeof i['type'] === 'string' ? (i['type'] as string).trim() : ''))
        .filter(Boolean),
    ),
  ]

  const detailed = readSurfacesDetailed(serp.rawItems, ourDomain)
  const present = detailed.filter((d) => d.present)

  console.log(`\n=== ${keyword}`)
  console.log(`  raw item types  : ${rawTypes.join(', ')}`)
  console.log(`  surfaces present: ${present.map((p) => p.surface).join(', ') || '(none)'}`)

  for (const p of present) {
    /**
     * The REAL state, not a two-way guess. The first run of this probe printed
     * "theirs" for every block that carried no domains — which is precisely the
     * false claim `unattributable` exists to prevent, so the probe reporting it
     * that way would hide the bug it was written to find.
     */
    const st = surfaceState(p)
    const label = st === 'held' ? `HELD #${p.ourRank}` : st
    console.log(
      `    ${SURFACE_LABELS[p.surface].padEnd(8)} ${SURFACE_GLYPHS[st]} ${label.padEnd(15)} ` +
        `holders: ${p.holders.slice(0, 4).join(', ') || '(none named)'}`,
    )
  }

  /**
   * A type we do not map is a NEW SURFACE arriving. Unnamed, nobody notices for
   * a year — so it is called out rather than silently ignored.
   */
  const ignorable = new Set(['related_searches', 'search_intent', 'answer_box', 'knowledge_graph'])
  const unmapped = rawTypes.filter((t) => surfaceForItemType(t) === null && !ignorable.has(t))
  if (unmapped.length > 0) {
    console.log(`  UNMAPPED        : ${unmapped.join(', ')}   <- add to surfaceForItemType`)
  }

  await recordSurfaces(db(), {
    siteId: site.id,
    keywordNorm: keyword.trim().toLowerCase().replace(/\s+/g, ' '),
    ourDomain,
    raw: serp.rawItems,
    locationCode: LOCATION,
    source: 'probe',
  })
}

console.log(
  '\nThe nested-items walk is what makes a Discussions or Images slot findable. If every\n' +
    'non-organic surface above says "theirs", suspect that first — not the SERP.',
)

await db().$client.end()
