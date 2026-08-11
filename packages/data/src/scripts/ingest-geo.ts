/**
 * Geography ingest. `pnpm ingest:geo`
 *
 * Downloads six keyless Census bulk files, builds the locality corpus, resolves
 * every locality against the provider's free location dump, persists, and prints
 * a coverage report.
 *
 * ==================== IT FAILS LOUDLY ON POOR COVERAGE ====================
 * An unresolved locality is silently EXCLUDED from scanning -- there is no error,
 * no empty state, nothing to notice. So a bad matching rule does not present as a
 * bug; it presents as "no data for half the country" months later.
 *
 * This script therefore asserts coverage thresholds and exits non-zero if they
 * are not met, and prints a sample of unmatched localities with reasons so a rule
 * regression is diagnosable rather than merely visible.
 * =========================================================================
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import {
  ProviderLocationIndex,
  VIABLE_POPULATION_BAND,
  assignSlugs,
  cleanCensusName,
  resolveLocality,
  shouldCreateMetro,
  shouldRollUpCounty,
  type LocalityKind,
} from '@rnr/core'
import { closeDb, db } from '../db.js'
import { localities } from '../schema.js'
import { createProviders } from '../providers/index.js'
import { CENSUS_SOURCES, STATE_NAMES } from '../ingest/census-sources.js'
import { downloadText, downloadZipEntry } from '../ingest/download.js'
import { GEOTARGETS_VINTAGE, fetchGeotargetLocations } from '../ingest/geotargets.js'
import {
  parseCbsaEst,
  parseGazetteerCbsa,
  parseGazetteerCounties,
  parseGazetteerPlaces,
  parsePlaceCounty,
  parseSubEst,
} from '../ingest/parse.js'

interface Draft {
  kind: LocalityKind
  name: string
  rawName: string
  stateCode: string
  stateName: string
  fips: string
  countyFips: string | null
  countyName: string | null
  population: number | null
  lat: number | null
  lon: number | null
  landAreaSqMi: number | null
}

async function main(): Promise<void> {
  const database = db()

  console.log('\n=== Census bulk files (all keyless, all public domain) ===')
  const [placeText, countyText, cbsaText, subEstText, cbsaEstText, placeCountyText] =
    await Promise.all([
      downloadZipEntry(
        CENSUS_SOURCES.gazetteerPlaces.url,
        CENSUS_SOURCES.gazetteerPlaces.fileInZip,
        CENSUS_SOURCES.gazetteerPlaces.cacheName,
      ),
      downloadZipEntry(
        CENSUS_SOURCES.gazetteerCounties.url,
        CENSUS_SOURCES.gazetteerCounties.fileInZip,
        CENSUS_SOURCES.gazetteerCounties.cacheName,
      ),
      downloadZipEntry(
        CENSUS_SOURCES.gazetteerCbsa.url,
        CENSUS_SOURCES.gazetteerCbsa.fileInZip,
        CENSUS_SOURCES.gazetteerCbsa.cacheName,
      ),
      downloadText(
        CENSUS_SOURCES.subCountyPopulation.url,
        CENSUS_SOURCES.subCountyPopulation.cacheName,
      ),
      downloadText(CENSUS_SOURCES.cbsaPopulation.url, CENSUS_SOURCES.cbsaPopulation.cacheName),
      downloadText(CENSUS_SOURCES.placeByCounty.url, CENSUS_SOURCES.placeByCounty.cacheName),
    ])

  const gazPlaces = parseGazetteerPlaces(placeText)
  const gazCounties = parseGazetteerCounties(countyText)
  const gazCbsas = parseGazetteerCbsa(cbsaText)
  const subEst = parseSubEst(subEstText)
  const cbsaEst = parseCbsaEst(cbsaEstText)
  const placeCounty = parsePlaceCounty(placeCountyText)

  console.log(
    `\nParsed: ${gazPlaces.length} gazetteer places, ${gazCounties.length} counties, ` +
      `${gazCbsas.length} CBSAs, ${subEst.length} population rows, ${cbsaEst.length} metro totals, ` +
      `${placeCounty.size} place->county mappings.`,
  )

  // --- Population lookups -------------------------------------------------
  const placePop = new Map<string, { population: number | null; rawName: string }>()
  const countyPop = new Map<string, { population: number | null; rawName: string }>()
  for (const r of subEst) {
    const target = r.sumlev === '162' ? placePop : countyPop
    target.set(r.geoid, { population: r.population, rawName: r.rawName })
  }
  const metroPop = new Map(cbsaEst.map((r) => [r.cbsaCode, r.population]))

  // --- Cities -------------------------------------------------------------
  const drafts: Draft[] = []
  for (const p of gazPlaces) {
    const pop = placePop.get(p.geoid)
    // No population estimate means it is not an incorporated place in the 2024
    // vintage (a CDP, or dissolved). Excluded by construction -- and excluded
    // with a REASON rather than defaulted to 0, which would make every CDP look
    // like a zero-demand market rather than an out-of-scope one.
    if (!pop) continue
    const county = placeCounty.get(p.geoid)
    const stateName = STATE_NAMES[p.stateCode] ?? p.stateCode
    // Prefer the sub-est name: it carries the legal suffix that cleanCensusName
    // and the consolidated-alias table are keyed on.
    const rawName = pop.rawName || p.rawName
    drafts.push({
      kind: 'city',
      name: cleanCensusName(rawName, p.stateCode),
      rawName,
      stateCode: p.stateCode,
      stateName,
      fips: p.geoid,
      countyFips: county?.countyGeoid ?? null,
      countyName: county?.countyName ?? null,
      population: pop.population,
      lat: p.lat,
      lon: p.lon,
      landAreaSqMi: p.landAreaSqMi,
    })
  }

  // --- Counties, subject to the 95% independent-city rule ------------------
  const placesByCounty = new Map<string, Array<{ name: string; population: number | null }>>()
  for (const d of drafts) {
    if (!d.countyFips) continue
    const list = placesByCounty.get(d.countyFips)
    const entry = { name: d.rawName, population: d.population }
    if (list) list.push(entry)
    else placesByCounty.set(d.countyFips, [entry])
  }

  let countiesSkipped = 0
  const skippedCountyExamples: string[] = []
  for (const c of gazCounties) {
    const pop = countyPop.get(c.geoid)
    const decision = shouldRollUpCounty({
      countyName: c.rawName,
      countyPopulation: pop?.population ?? null,
      members: placesByCounty.get(c.geoid) ?? [],
    })
    if (!decision.create) {
      countiesSkipped++
      if (skippedCountyExamples.length < 8) {
        skippedCountyExamples.push(`${c.rawName}, ${c.stateCode}: ${decision.reason}`)
      }
      continue
    }
    const stateName = STATE_NAMES[c.stateCode] ?? c.stateCode
    drafts.push({
      kind: 'county',
      name: cleanCensusName(c.rawName, c.stateCode),
      rawName: c.rawName,
      stateCode: c.stateCode,
      stateName,
      fips: c.geoid,
      countyFips: c.geoid,
      countyName: c.rawName,
      population: pop?.population ?? null,
      lat: c.lat,
      lon: c.lon,
      landAreaSqMi: null,
    })
  }

  // --- Metros -------------------------------------------------------------
  const biggestCityByState = new Map<string, number>()
  for (const d of drafts) {
    if (d.kind !== 'city' || d.population === null) continue
    const key = `${d.stateCode}:${d.name.toLowerCase()}`
    biggestCityByState.set(key, Math.max(biggestCityByState.get(key) ?? 0, d.population))
  }

  let metrosSkipped = 0
  for (const m of gazCbsas) {
    const population = metroPop.get(m.cbsaCode) ?? null
    // "Kenosha-Racine, WI" -> anchor "Kenosha", primary state "WI".
    const [namePart, statePart] = m.rawName.split(',').map((s) => s.trim())
    const anchor = (namePart ?? '').split('-')[0]!.trim()
    const stateCode = (statePart ?? '').split('-')[0]!.trim()
    const anchorPop = biggestCityByState.get(`${stateCode}:${anchor.toLowerCase()}`) ?? null

    const decision = shouldCreateMetro({
      metroPopulation: population,
      anchorCityPopulation: anchorPop,
    })
    if (!decision.create) {
      metrosSkipped++
      continue
    }
    drafts.push({
      kind: 'metro',
      // The full hyphenated name part, e.g. "Kenosha-Racine" or "Winston-Salem",
      // NOT just the first segment -- the resolver tries progressively shorter
      // prefixes itself, and "Winston" is not a place.
      name: (m.rawName.split(',')[0] ?? m.rawName).trim(),
      rawName: m.rawName,
      stateCode,
      stateName: STATE_NAMES[stateCode] ?? stateCode,
      fips: m.cbsaCode,
      countyFips: null,
      countyName: null,
      population,
      lat: m.lat,
      lon: m.lon,
      landAreaSqMi: null,
    })
  }

  console.log(
    `\nCorpus: ${drafts.filter((d) => d.kind === 'city').length} cities, ` +
      `${drafts.filter((d) => d.kind === 'county').length} counties, ` +
      `${drafts.filter((d) => d.kind === 'metro').length} metros = ${drafts.length} total.`,
  )
  console.log(
    `  skipped ${countiesSkipped} counties (95% dominant-place rule) and ${metrosSkipped} redundant metros.`,
  )
  if (skippedCountyExamples.length > 0) {
    console.log('\n  Sample of skipped counties (independent cities / consolidations):')
    for (const ex of skippedCountyExamples) console.log(`    - ${ex}`)
  }

  // --- Location index ----------------------------------------------------
  //
  // Two sources, and which one was used is recorded per locality:
  //
  //   'dataforseo'        AUTHORITATIVE. Free endpoint, but behind the account's
  //                       IP whitelist. Only these codes are cleared for spending.
  //   'google_geotargets' Free, keyless, complete (16,407 active US cities).
  //                       Documented to be the same criterion IDs, but UNVERIFIED
  //                       -- so runScan refuses to spend money on one.
  //
  // Without the fallback an unwhitelisted machine resolves nothing at all, and
  // every locality reads "no provider location code" from a perfectly good ingest.
  console.log('\n=== Location index ===')
  const providers = createProviders()
  let providerLocations: Awaited<ReturnType<typeof providers.fetchLocations>> = []
  let locationSource: 'dataforseo' | 'google_geotargets' = 'google_geotargets'

  if (providers.live) {
    try {
      providerLocations = await providers.fetchLocations()
      if (providerLocations.length > 1000) {
        locationSource = 'dataforseo'
        console.log(`  ${providerLocations.length} rows from DataForSEO (AUTHORITATIVE).`)
      } else {
        console.log(
          `  DataForSEO returned only ${providerLocations.length} rows -- too few to be the real dump. Falling back.`,
        )
        providerLocations = []
      }
    } catch (e) {
      console.log(`  DataForSEO locations unavailable: ${(e as Error).message.slice(0, 160)}`)
      providerLocations = []
    }
  }

  if (providerLocations.length === 0) {
    console.log(`  Falling back to Google Ads geo target constants (${GEOTARGETS_VINTAGE}).`)
    providerLocations = await fetchGeotargetLocations()
    locationSource = 'google_geotargets'
    console.log(`  ${providerLocations.length} US rows from Google (free, keyless).`)
    console.log(
      '  NOTE: these codes are UNVERIFIED against the DataForSEO API. Fixture scans work,\n' +
        '  but live scans will REFUSE to spend on them. Re-run with working credentials to verify.',
    )
  }

  const typeCounts = new Map<string, number>()
  for (const l of providerLocations) {
    typeCounts.set(l.locationType, (typeCounts.get(l.locationType) ?? 0) + 1)
  }
  console.log('  observed location_type vocabulary:')
  for (const [type, n] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(7)}  ${type}`)
  }

  const index = new ProviderLocationIndex(providerLocations)

  // --- Resolve ------------------------------------------------------------
  const withSlugs = assignSlugs(drafts)
  const resolvedRows: Array<typeof localities.$inferInsert> = []
  const unmatched: Array<{ draft: Draft; reason: string }> = []

  for (const d of withSlugs) {
    const result = resolveLocality(
      {
        kind: d.kind,
        rawName: d.rawName,
        stateName: d.stateName,
        stateCode: d.stateCode,
        countyName: d.countyName,
      },
      index,
    )
    const base = {
      slug: d.slug,
      kind: d.kind,
      name: d.name,
      rawName: d.rawName,
      stateCode: d.stateCode,
      stateName: d.stateName,
      fips: d.fips,
      countyFips: d.countyFips,
      countyName: d.countyName,
      population: d.population,
      lat: d.lat,
      lon: d.lon,
      landAreaSqMi: d.landAreaSqMi,
      searchText: `${d.name} ${d.stateCode} ${d.stateName}`.toLowerCase(),
      updatedAt: new Date(),
    }
    if (result.resolved) {
      resolvedRows.push({
        ...base,
        providerLocationCode: result.locationCode,
        providerLocationName: result.locationName,
        resolutionMethod: result.method,
        locationSource,
        unmatchedReason: null,
      })
    } else {
      resolvedRows.push({
        ...base,
        providerLocationCode: null,
        providerLocationName: null,
        resolutionMethod: null,
        locationSource: null,
        unmatchedReason: result.reason,
      })
      unmatched.push({ draft: d, reason: result.reason })
    }
  }

  // --- Persist ------------------------------------------------------------
  console.log('\n=== Persisting ===')
  const CHUNK = 500
  for (let i = 0; i < resolvedRows.length; i += CHUNK) {
    const batch = resolvedRows.slice(i, i + CHUNK)
    await database
      .insert(localities)
      .values(batch)
      .onConflictDoUpdate({
        // Conflict on (kind, fips), NOT on slug.
        //
        // FIPS-within-kind is the immutable identity of a place; the slug is
        // DERIVED from its name and legitimately changes when a naming rule
        // improves. Matching on slug means an improved rule inserts a second row
        // for the same place and then dies on the (kind, fips) index -- which is
        // exactly what happened when metro naming changed from "Albany" to
        // "Albany-Schenectady-Troy".
        target: [localities.kind, localities.fips],
        set: {
          slug: sqlExcluded('slug'),
          name: sqlExcluded('name'),
          rawName: sqlExcluded('raw_name'),
          population: sqlExcluded('population'),
          providerLocationCode: sqlExcluded('provider_location_code'),
          providerLocationName: sqlExcluded('provider_location_name'),
          resolutionMethod: sqlExcluded('resolution_method'),
          locationSource: sqlExcluded('location_source'),
          unmatchedReason: sqlExcluded('unmatched_reason'),
          searchText: sqlExcluded('search_text'),
          updatedAt: new Date(),
        },
      })
    process.stdout.write(`\r  ${Math.min(i + CHUNK, resolvedRows.length)}/${resolvedRows.length}`)
  }
  console.log('')

  // --- Report -------------------------------------------------------------
  report(resolvedRows, unmatched, locationSource === 'dataforseo')
  await closeDb()
}

/** drizzle helper for ON CONFLICT ... SET x = excluded.x */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`)
}

function report(
  rows: Array<typeof localities.$inferInsert>,
  unmatched: Array<{ draft: Draft; reason: string }>,
  live: boolean,
): void {
  const band = (pop: number | null): string => {
    if (pop === null) return 'unknown'
    if (pop >= 250_000) return '250k+'
    if (pop >= VIABLE_POPULATION_BAND.min) return '25k-250k'
    return 'under 25k'
  }

  const stats = new Map<string, { total: number; resolved: number }>()
  for (const r of rows) {
    const key = `${r.kind}/${band(r.population ?? null)}`
    const s = stats.get(key) ?? { total: 0, resolved: 0 }
    s.total++
    if (r.providerLocationCode !== null) s.resolved++
    stats.set(key, s)
  }

  console.log('\n=== Coverage ===')
  console.log('  kind/band                 resolved / total')
  for (const [key, s] of [...stats.entries()].sort()) {
    const pct = s.total === 0 ? 0 : (s.resolved / s.total) * 100
    console.log(`  ${key.padEnd(24)} ${String(s.resolved).padStart(6)} / ${String(s.total).padEnd(6)} ${pct.toFixed(1)}%`)
  }

  const totalResolved = rows.filter((r) => r.providerLocationCode !== null).length
  console.log(`\n  OVERALL: ${totalResolved} / ${rows.length} resolved.`)

  // A SAMPLE of unmatched, with reasons. An unmatched locality is silently
  // excluded from scanning, so this is the only place a bad rule becomes visible.
  if (unmatched.length > 0) {
    console.log(`\n=== Unmatched sample (${unmatched.length} total) ===`)
    const step = Math.max(1, Math.floor(unmatched.length / 30))
    for (let i = 0; i < unmatched.length && i / step < 30; i += step) {
      const u = unmatched[i]!
      const pop = u.draft.population === null ? '?' : u.draft.population.toLocaleString()
      console.log(`  ${u.draft.kind.padEnd(6)} ${`${u.draft.name}, ${u.draft.stateCode}`.padEnd(34)} pop ${pop.padStart(9)}`)
      console.log(`         ${u.reason}`)
    }
  }

  if (!live) {
    console.log(
      '\nNOTE: resolved against the small FIXTURE location set, not the real 267k-row dump.\n' +
        'Coverage assertions are skipped. Re-run with LIVE_CALLS_ENABLED=true and credentials\n' +
        'for a real coverage report.\n',
    )
    return
  }

  // --- Assertions ---------------------------------------------------------
  const check = (key: string, minPct: number): string | null => {
    const s = stats.get(key)
    if (!s || s.total === 0) return null
    const pct = (s.resolved / s.total) * 100
    return pct < minPct
      ? `${key}: ${pct.toFixed(1)}% resolved, expected at least ${minPct}%`
      : null
  }
  const failures = [check('city/250k+', 100), check('city/25k-250k', 99)].filter(
    (f): f is string => f !== null,
  )

  if (failures.length > 0) {
    console.error('\n=== INGEST FAILED ===')
    for (const f of failures) console.error(`  ${f}`)
    console.error(
      '\nA matching rule has regressed. Unresolved localities are silently excluded from\n' +
        'scanning, so this must fail here rather than surface later as "no data".\n' +
        'Check the unmatched sample above for the pattern.\n',
    )
    process.exit(1)
  }
  console.log('\nCoverage assertions passed.\n')
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
