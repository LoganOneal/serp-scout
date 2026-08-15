/**
 * Does the whole supply loop actually close?
 *
 * ==================== WHY A REAL SERVER, NOT A MOCK ====================
 * The unit tests fake `fetch`. That verifies the walk logic and verifies nothing
 * about whether @rnr/supply-feed and the consumer agree on the wire — which is
 * the only place they meet, and the one part neither package's own tests can
 * check. So this stands up the real package on a real socket and pulls it with
 * the real client.
 *
 * It also checks the two claims the whole feature rests on:
 *   · a locality with supply reaches BUILD and a locality without it does not
 *   · an UNRESOLVED locality changes nothing at all
 *
 * Costs $0 — no vendor is called. It writes a throwaway site and deletes it.
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-supply-e2e.mts
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { createSupplyFeed, type SupplyItem } from '@rnr/supply-feed'
import {
  assessKeyword,
  gateKeywordVerdict,
  supplyStatusFor,
  type SupplyStatus,
} from '@rnr/core'
import { db } from '../db.js'
import { researchGeos, sites, supplyCoverage } from '../schema.js'
import { geoSlugFor } from '../supply/resolve.js'
import { upsertAffiliateSite } from '../spaces/sites.js'
import { connectSupplySource, checkSupplySource } from '../supply/sources.js'
import { ingestSupply, listUnresolvedSuppliers } from '../supply/ingest.js'
import {
  coverageForKeyword,
  coverageKey,
  loadCoverageMap,
  supplyOpportunityReport,
} from '../supply/coverage.js'
import { searchSupplyItems, siteSupplyFact } from '../supply/query.js'

const TOKEN = 'probe-supply-token-do-not-reuse'
const DOMAIN = 'probe-supply-example.com'
process.env['PROBE_SUPPLY_TOKEN'] = TOKEN

const room = (
  id: string,
  city: string,
  region: string | undefined,
  priceUsd: number,
  available: boolean,
): SupplyItem => ({
  id,
  supplierId: `prop_${city.toLowerCase().replace(/\W+/g, '')}`,
  supplierName: `${city} Resort`,
  title: `Suite ${id}`,
  url: `https://${DOMAIN}/rooms/${id}`,
  affiliateUrl: `https://book.example.com/${id}`,
  ...(region === undefined ? { location: { city, country: 'US' } } : { location: { city, region, country: 'US' } }),
  attributes: { in_room_hot_tub: true },
  priceMicros: priceUsd * 1_000_000,
  currency: 'USD',
  available,
  updatedAt: '2026-08-14T09:00:00.000Z',
})

/**
 * ==================== THE MARKETS ARE READ, NOT ASSUMED ====================
 * The first version of this probe hardcoded Las Vegas and Aspen. Aspen is not in
 * this corpus, so it landed unresolved and every downstream assertion about
 * "measured zero supply" failed for a reason that had nothing to do with the
 * code under test. Two real markets are taken from research_geos instead, and
 * one deliberately fake one supplies the unresolved case.
 * ===========================================================================
 */
const geos = await db()
  .select({ market: researchGeos.market, stateAbbr: researchGeos.stateAbbr })
  .from(researchGeos)
  .where(and(eq(researchGeos.active, true), isNotNull(researchGeos.dataforseoLocationCode)))
  .orderBy(asc(researchGeos.market))
  .limit(2)

if (geos.length < 2) {
  console.error('needs at least 2 active resolved research_geos rows — run `pnpm ingest:geo` first')
  process.exit(1)
}

const HAVE = geos[0]!
const NONE = geos[1]!
const slugOf = (g: { market: string; stateAbbr: string | null }): string =>
  geoSlugFor(g.market, g.stateAbbr)

console.log(`have-supply market : ${HAVE.market}/${HAVE.stateAbbr} → ${slugOf(HAVE)}`)
console.log(`zero-supply market : ${NONE.market}/${NONE.stateAbbr} → ${slugOf(NONE)}\n`)

const CATALOGUE: SupplyItem[] = [
  room('lv1', HAVE.market, HAVE.stateAbbr ?? undefined, 240, true),
  room('lv2', HAVE.market, HAVE.stateAbbr ?? undefined, 480, true),
  room('lv3', HAVE.market, HAVE.stateAbbr ?? undefined, 360, true),
  room('as1', NONE.market, NONE.stateAbbr ?? undefined, 900, false),
  room('as2', NONE.market, NONE.stateAbbr ?? undefined, 700, false),
  room('zz1', 'Nowhereville', 'ZZ', 100, true),
  // Rejected by the feed's own validation. Must be counted in the manifest, must
  // NOT break reconciliation, and must NOT be served.
  { ...room('bad', HAVE.market, HAVE.stateAbbr ?? undefined, 100, true), url: 'not-absolute' },
]

const PAGE = 2
/** Items the manifest claims but the walk cannot return. See §11. */
let ghostItems = 0
let fail = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) fail += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- 1. Stand up the real feed on a real socket ------------------------------
const valid = CATALOGUE.filter((i) => i.url.startsWith('http'))
const feed = createSupplyFeed({
  token: process.env['PROBE_SUPPLY_TOKEN'],
  fetchPage: ({ cursor, limit }) => {
    const start = cursor ? CATALOGUE.findIndex((i) => i.id === cursor) + 1 : 0
    const slice = CATALOGUE.slice(start, start + limit)
    const last = slice[slice.length - 1]
    return {
      items: slice,
      nextCursor: start + limit < CATALOGUE.length && last ? last.id : null,
    }
  },
  counts: () => ({
    // The publisher's own row count, which INCLUDES rows their mapper produces
    // garbage for. That is the realistic convention — `db.room.count()` does not
    // know which rows will fail validation downstream.
    //
    // `ghostItems` is how §11 simulates a partial sync: a manifest claiming more
    // than the walk can return, which is the shape of a truncated feed.
    totalItems: CATALOGUE.length + ghostItems,
    totalSuppliers: new Set(valid.map((i) => i.supplierId)).size,
    lastModified: '2026-08-14T09:00:00.000Z',
  }),
})

const server = createServer(async (req, res) => {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
  }
  const response = await feed.handler(
    new Request(`http://localhost${req.url}`, { method: req.method ?? 'GET', headers }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(response.status === 304 ? undefined : await response.text())
})

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as AddressInfo).port
const baseUrl = `http://127.0.0.1:${port}/api/supply`
console.log(`feed up at ${baseUrl}\n`)

try {
  // --- 2. A throwaway affiliate site with a locality space -------------------
  const site = await upsertAffiliateSite(db(), {
    domain: DOMAIN,
    displayName: 'probe — supply e2e',
    status: 'parked',
    keywordSpace: {
      geoMode: 'in_keyword',
      audienceScope: 'country:US',
      serpLocationCode: 2840,
      dimensions: { locality: { source: 'research_geos', limit: 500 } },
      patterns: [{ template: 'hotels with hot tubs in room {locality}', label: 'hot-tub-locality' }],
      volumeFloor: 50,
    },
    notes: 'created by probe-supply-e2e; safe to delete',
  })

  const source = await connectSupplySource(db(), {
    siteId: site.id,
    baseUrl,
    tokenEnvVar: 'PROBE_SUPPLY_TOKEN',
    entityKind: 'locality',
  })

  // --- 3. check ------------------------------------------------------------
  const health = await checkSupplySource(db(), source.id)
  check('check reaches the feed and reports the manifest', health.ok, health.detail)
  check('manifest publishes the publisher’s own total', health.totalItems === CATALOGUE.length,
    `${health.totalItems}`)
  check('invalidItems is 0 before any page is walked', health.invalidItems === 0,
    'the feed can only count rows something has asked for — which is why ingest re-reads it after the walk')

  // --- 4. dry run writes nothing -------------------------------------------
  const dry = await ingestSupply(db(), { sourceId: source.id, dryRun: true, pageSize: PAGE })
  const afterDry = await db().select().from(supplyCoverage).where(eq(supplyCoverage.siteId, site.id))
  check('dry run reports what it would do', dry.itemsPulled === valid.length, `${dry.itemsPulled}`)
  check('dry run writes nothing', afterDry.length === 0 && dry.runId === null)

  // --- 5. the real pull ----------------------------------------------------
  const r = await ingestSupply(db(), { sourceId: source.id, pageSize: PAGE })
  console.log(`\npull: ${r.status} · ${r.itemsPulled}/${r.manifestTotalItems} · ${r.pagesFetched} pages`)
  for (const n of r.notes) console.log(`   · ${n}`)
  console.log()

  check('walked every page, not just the first', r.pagesFetched > 1, `${r.pagesFetched} pages`)
  check('the invalid item was never served', r.itemsPulled === valid.length, `${r.itemsPulled}`)
  /**
   * Reconciliation and resolution are separate failures that share one `status`.
   * This pull is legitimately `partial` because Nowhereville cannot resolve — so
   * the assertion is on the reconciliation NOTE, not on the status.
   */
  check('reconciles despite the invalid row — no PARTIAL SYNC note',
    !r.notes.some((n) => n.includes('PARTIAL SYNC')), r.notes.find((n) => n.includes('PARTIAL SYNC')) ?? '')
  check('and the sweep was therefore not skipped',
    !r.notes.some((n) => n.includes('sweep SKIPPED')))

  /**
   * The claim §4.1 is built on. Nowhereville, ZZ is not in research_geos, so its
   * supplier must land UNRESOLVED — counted, reported, and contributing to no
   * locality's coverage.
   */
  check('the unknown market resolved to nothing, loudly', r.unresolvedSuppliers === 1,
    `${r.unresolvedSuppliers} unresolved`)
  const unres = await listUnresolvedSuppliers(db(), source.id)
  check('and names it with a reason', unres.length === 1 && /not in research_geos/.test(unres[0]?.reason ?? ''),
    unres[0]?.reason?.slice(0, 60) ?? '(none)')

  // --- 6. coverage ---------------------------------------------------------
  const map = await loadCoverageMap(db(), site.id)
  // Via coverageKey, never a hand-built string. The first version of this probe
  // hardcoded a space separator, failed six assertions, and sent the debugging
  // at the ingest rather than at the test.
  const lv = map.get(coverageKey('locality', slugOf(HAVE)))
  const zero = map.get(coverageKey('locality', slugOf(NONE)))

  check(`${HAVE.market} has coverage`, lv?.availableItemCount === 3, `${lv?.availableItemCount}`)
  check('median price is the middle listing, not an average',
    lv?.medianPriceMicros === 360_000_000n, String(lv?.medianPriceMicros))
  check(`${NONE.market} is listed but unbookable — items yes, available zero`,
    zero?.itemCount === 2 && zero?.availableItemCount === 0,
    `${zero?.itemCount} items / ${zero?.availableItemCount} available`)
  check('the unresolved supplier contributes to no locality',
    ![...map.keys()].some((k) => k.includes('nowhere')))

  // --- 7. the three supply states --------------------------------------------
  const state = (slug: string | null): SupplyStatus =>
    supplyStatusFor(slug ? coverageForKeyword(map, { locality: slug }) : null).status

  check('have    → a locality with available inventory', state(slugOf(HAVE)) === 'have')
  check('none    → a locality measured at zero available', state(slugOf(NONE)) === 'none',
    state(slugOf(NONE)))
  check('unknown → a locality never resolved', state('nowhereville-zz') === 'unknown')

  // --- 8. the gate ----------------------------------------------------------
  const buildable = assessKeyword({
    position: null, positionMeasured: true, volume: 2400, difficulty: 30, volumeFloor: 50,
  })
  const g = (slug: string): ReturnType<typeof gateKeywordVerdict> =>
    gateKeywordVerdict(buildable, supplyStatusFor(coverageForKeyword(map, { locality: slug })))

  check('BUILD survives where supply exists', g(slugOf(HAVE)).verdict === 'BUILD')
  check('BUILD is blocked where supply is measured zero',
    g(slugOf(NONE)).verdict === 'IGNORE' && g(slugOf(NONE)).gated,
    g(slugOf(NONE)).reason.slice(0, 80))
  /**
   * THE REGRESSION THAT MATTERS MOST. An unresolved locality must not be read as
   * a locality with no hotels — otherwise one importer bug stops the portfolio
   * building pages.
   */
  check('BUILD is UNTOUCHED where supply is unknown',
    g('nowhereville-zz').verdict === 'BUILD' && !g('nowhereville-zz').gated)

  // --- 9. the 2x2 -----------------------------------------------------------
  const report = await supplyOpportunityReport(db(), site.id)
  const cell = (slug: string): string | undefined => report.rows.find((x) => x.entitySlug === slug)?.cell
  check(`${HAVE.market}: supply, no measured keyword → KEYWORD_GAP`,
    cell(slugOf(HAVE)) === 'KEYWORD_GAP', `${cell(slugOf(HAVE))}`)
  check(`${NONE.market}: no supply, no demand → IGNORE`,
    cell(slugOf(NONE)) === 'IGNORE', `${cell(slugOf(NONE))}`)

  // --- 10. search and the sourced fact --------------------------------------
  const found = await searchSupplyItems(db(), {
    siteId: site.id, entitySlug: slugOf(HAVE), attributes: { in_room_hot_tub: true }, maxPriceMicros: 400_000_000n,
  })
  check('attribute + price search returns only matching available rows',
    found.length === 2 && found.every((f) => f.priceMicros! <= 400_000_000n), `${found.length} rows`)

  const fact = await siteSupplyFact(db(), site.id)
  check('a sourced supply fact is produced for outreach',
    !!fact && /3 available/.test(fact.claim) && fact.source.includes('supply_coverage'), fact?.claim ?? '(none)')

  // --- 11. the soft delete --------------------------------------------------
  CATALOGUE.splice(CATALOGUE.findIndex((i) => i.id === 'lv3'), 1)

  const r2 = await ingestSupply(db(), { sourceId: source.id, pageSize: PAGE })
  const map2 = await loadCoverageMap(db(), site.id)
  check('a removed listing is soft-deleted on a reconciled full sync', r2.itemsMarkedGone === 1,
    `${r2.itemsMarkedGone} marked gone, run ${r2.status}`)
  check('and coverage drops accordingly',
    map2.get(coverageKey('locality', slugOf(HAVE)))?.availableItemCount === 2,
    `${map2.get(coverageKey('locality', slugOf(HAVE)))?.availableItemCount}`)

  /**
   * A pull that does not reconcile must NOT sweep. Simulated by lying in the
   * manifest — the same shape as a feed that returns a truncated page.
   */
  ghostItems = 5
  const r3 = await ingestSupply(db(), { sourceId: source.id, pageSize: PAGE })
  check('a partial sync is reported as partial, not ok', r3.status === 'partial', r3.status)
  check('and sweeps nothing', r3.itemsMarkedGone === 0, `${r3.itemsMarkedGone}`)
  const map3 = await loadCoverageMap(db(), site.id)
  check('so coverage is unchanged by the partial run',
    map3.get(coverageKey('locality', slugOf(HAVE)))?.availableItemCount === 2,
    `${map3.get(coverageKey('locality', slugOf(HAVE)))?.availableItemCount}`)

  console.log(`\n${fail === 0 ? 'PASS' : `FAIL — ${fail} check(s)`}`)
} finally {
  await db().delete(sites).where(eq(sites.domain, DOMAIN))
  server.close()
  await db().$client.end()
}

process.exit(fail === 0 ? 0 : 1)
