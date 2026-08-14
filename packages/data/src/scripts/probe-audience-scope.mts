/**
 * ARM G — what does the `country:US` choice cost, and how big is the §0.1 error?
 *
 * ==================== TWO NUMBERS HELD ON REASONING ALONE ====================
 * plan-affiliate-directory-sites.md §0.2 chose `audienceScope: country:US` on an
 * argument ("most destinations are domestic-traveller markets, so the ranking is
 * preserved"). §0.1 asserts that buying a destination's own location code is a
 * systematic undercount. Neither has been measured.
 *
 * Both are free to measure, and this measures them together. Twenty keywords,
 * three ways:
 *
 *   US 2840          the number we will actually ship
 *   worldwide        what §0.2 gave up — AND whether the gap varies by
 *                    destination, which is the only part that changes rankings
 *   destination code what §0.1 costs — the number the tool would report if the
 *                    invariant were violated
 *
 * ==================== THE PRE-REGISTERED RULE ====================
 * If the worldwide/US ratio varies by more than 2x between the highest and
 * lowest destination, `country:US` is systematically reordering the grid and
 * §0.2 must be revisited. A UNIFORM gap of any size is fine — it divides out of
 * the ranking. A VARYING gap does not.
 * ================================================================
 *
 * Cost: $0. Google Ads volume is free and there is no paid fallback by policy.
 * The worldwide arm is the one unknown — `fetchKeywordIdeas` never throws, it
 * returns `source: 'skipped'`, so a rejected empty geo target degrades to zero
 * ideas with only a console line. That is reported here as a FAILURE, not as
 * "no demand".
 *
 *   pnpm tsx --conditions=react-server packages/data/src/scripts/probe-audience-scope.mts --live
 */
import 'dotenv/config'
import { LOCATION_US } from '@rnr/core'
import { fetchKeywordVolumes } from '../providers/google-ads/keyword-volume.js'

const live = process.argv.includes('--live')

/**
 * Destinations chosen to SPAN international share, because a uniform gap is the
 * result that vindicates §0.2 and only a varying one refutes it.
 *
 * Las Vegas / Miami carry real overseas demand. Gatlinburg and Wisconsin Dells
 * are close to purely domestic. Location codes are Google criteria IDs, which
 * DataForSEO reuses.
 */
const DESTINATIONS: Array<{ label: string; code: number; expect: string }> = [
  { label: 'Las Vegas', code: 1014221, expect: 'high international share' },
  { label: 'Miami', code: 1015116, expect: 'high international share' },
  { label: 'Gatlinburg', code: 1926377, expect: 'domestic only' },
  { label: 'Wisconsin Dells', code: 1025403, expect: 'domestic only' },
]

const PATTERNS = [
  (city: string) => `hotels with hot tubs in room ${city}`,
  (city: string) => `${city} jacuzzi suites`,
  (city: string) => `hot tub suites ${city}`,
  (city: string) => `romantic hotels with hot tub ${city}`,
  (city: string) => `${city} hotels with jacuzzi in room`,
]

const keywordsFor = (city: string): string[] => PATTERNS.map((p) => p(city.toLowerCase()))

interface Column {
  label: string
  volumes: Map<string, number | null>
  ok: boolean
  error: string | null
}

/** Failures seen across the whole run. A degraded run must not read as a measured one. */
const failures: string[] = []

async function measure(
  keywords: string[],
  geoTargetCriteriaIds: number[],
  label: string,
): Promise<Column> {
  const volumes = new Map<string, number | null>()
  if (!live) {
    for (const k of keywords) volumes.set(k, null)
    return { label, volumes, ok: false, error: 'not live' }
  }
  const r = await fetchKeywordVolumes(keywords, { live: true, geoTargetCriteriaIds })
  for (const row of r.rows) volumes.set(row.keyword.toLowerCase(), row.avgMonthlySearches)
  const anyMeasured = r.rows.some((x) => x.avgMonthlySearches != null)
  /**
   * `source: 'google_ads'` alone is not success. The provider returns `skipped`
   * on failure and never throws, so a rejected request and a market with
   * genuinely no data look identical from the outside. Requiring at least one
   * populated row is what separates them.
   */
  const ok = r.source === 'google_ads' && anyMeasured
  const error = r.error ?? (anyMeasured ? null : 'answered, but no keyword carried a figure')
  if (!ok && error) failures.push(`${label}: ${error}`)
  return { label, volumes, ok, error }
}

/** Mean is dominated by tiny-volume rows where a ratio of 1.0 is noise. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const fmt = (v: number | null | undefined): string => (v == null ? '—' : String(v))

async function main(): Promise<void> {
  if (!live) {
    console.log('DRY RUN — pass --live to measure. Nothing below is real.\n')
  }

  const rows: Array<{
    destination: string
    expect: string
    keyword: string
    us: number | null
    worldwide: number | null
    destinationCode: number | null
  }> = []

  let worldwideWorks: boolean | null = null
  let worldwideError: string | null = null

  for (const dest of DESTINATIONS) {
    const keywords = keywordsFor(dest.label)

    const us = await measure(keywords, [LOCATION_US], 'us')
    /**
     * ==================== THIS ARM CANNOT RUN, AND THAT IS THE FINDING ====================
     * Passing an empty geo list does NOT reach Google with no geo target.
     * `normalizeGeoIds` (keyword-volume.ts:142-152) converts `[]` to
     * `[GOOGLE_ADS_GEO_US]` before the request is built, so this column is US
     * measured a second time.
     *
     * The first run of this probe reported `worldwide/us = 1.00x` on every
     * destination and concluded "the gap is near-uniform, §0.2 stands". That
     * conclusion was drawn from comparing a column to itself.
     *
     * It is kept, and labelled, because a silent coercion is exactly the class of
     * bug §0.1 exists to prevent — and the identity check below is what catches
     * it. Measuring true worldwide needs the provider change §0.2 deferred.
     * ====================================================================================
     */
    const worldwide = await measure(keywords, [], 'worldwide(coerced)')
    const destination = await measure(keywords, [dest.code], 'destination')

    if (worldwideWorks === null) {
      worldwideWorks = worldwide.ok
      worldwideError = worldwide.error
    }

    for (const keyword of keywords) {
      rows.push({
        destination: dest.label,
        expect: dest.expect,
        keyword,
        us: us.volumes.get(keyword) ?? null,
        worldwide: worldwide.volumes.get(keyword) ?? null,
        destinationCode: destination.volumes.get(keyword) ?? null,
      })
    }
  }

  console.log(
    `${'destination'.padEnd(16)} ${'us'.padStart(8)} ${'world'.padStart(8)} ${'dest-code'.padStart(10)}  keyword`,
  )
  for (const r of rows) {
    console.log(
      `${r.destination.padEnd(16)} ${fmt(r.us).padStart(8)} ${fmt(r.worldwide).padStart(8)} ` +
        `${fmt(r.destinationCode).padStart(10)}  ${r.keyword}`,
    )
  }

  // --- Coverage first. A degraded run must not read as a measured one. -------
  const unmeasuredUs = rows.filter((r) => r.us == null).length
  if (failures.length > 0 || unmeasuredUs > 0) {
    console.log('\n=== coverage ===')
    console.log(
      `${unmeasuredUs} of ${rows.length} keyword-rows have NO US figure. That is UNMEASURED, ` +
        `not zero demand — a quota error and a market with no searches look identical in the table above.`,
    )
    for (const f of [...new Set(failures)]) console.log(`  ! ${f}`)
  }

  // --- §0.1: how large is the destination-code error? ------------------------
  console.log('\n=== §0.1 — the invariant, priced ===')
  const destPairs = rows.filter((r) => r.us != null && r.destinationCode != null)
  if (destPairs.length === 0) {
    console.log('Not measurable — no keyword carried both a US and a destination-code figure.')
  } else {
    const ratios = destPairs.map((r) => (r.destinationCode! + 1) / (r.us! + 1))
    const med = median(ratios)
    const contributing = [...new Set(destPairs.map((r) => r.destination))].join(', ')
    console.log(
      `Buying at the destination's own code returns a MEDIAN ${(med * 100).toFixed(1)}% of the US ` +
        `figure (n=${destPairs.length}, from ${contributing}).`,
    )
    /**
     * Median, not mean. One low-volume row ("hot tub suites miami": 10 US, 10
     * local) has a ratio of 1.0 and pulls a mean of eight points a long way. The
     * high-volume rows are the ones that matter and they cluster far below.
     */
    const worst = destPairs.reduce((a, b) =>
      (a.destinationCode! + 1) / (a.us! + 1) < (b.destinationCode! + 1) / (b.us! + 1) ? a : b,
    )
    console.log(
      `  worst single row: "${worst.keyword}" — ${worst.us} US vs ${worst.destinationCode} at the ` +
        `destination's code (${((worst.us! + 1) / (worst.destinationCode! + 1)).toFixed(0)}x undercount)`,
    )
    console.log(
      med < 0.5
        ? `>> MEASURED: violating the invariant would undercount by ~${(1 / med).toFixed(1)}x at the median. ` +
            `The rule earns its place.`
        : '>> Smaller than expected. Do not relax anything on this alone — the localised-SERP half of §0.1 is untouched by it.',
    )
  }

  // --- §0.2: does the US choice reorder the grid? ----------------------------
  console.log('\n=== §0.2 — what country:US costs ===')
  /**
   * The identity check, and it is the whole point of running the column.
   * Byte-identical volumes across two supposedly different scopes means the
   * second request was the first one again.
   */
  const paired = rows.filter((r) => r.us != null && r.worldwide != null)
  const identical = paired.length > 0 && paired.every((r) => r.us === r.worldwide)

  if (worldwideWorks === false) {
    console.log(`Worldwide did not answer: ${worldwideError}`)
  } else if (identical) {
    console.log(
      `Worldwide is byte-identical to US on all ${paired.length} paired rows.\n` +
        `>> THE ARM DID NOT RUN. \`normalizeGeoIds\` (google-ads/keyword-volume.ts:142-152) converts an\n` +
        `   empty geo list to [2840] before the request is built, so this column is US measured twice.\n` +
        `   Worldwide remains UNMEASURED. §0.2's ranking claim is therefore still an argument, not a\n` +
        `   measurement — and it cannot be tested without the provider change §0.2 deferred.`,
    )
  } else {
    const byDest = new Map<string, number[]>()
    for (const r of paired) {
      const list = byDest.get(r.destination) ?? []
      list.push((r.worldwide! + 1) / (r.us! + 1))
      byDest.set(r.destination, list)
    }
    if (byDest.size < 2) {
      console.log('Not enough paired measurements across destinations to compare.')
    } else {
      const meds = [...byDest.entries()].map(([dest, ratios]) => ({ dest, ratio: median(ratios) }))
      for (const m of meds) console.log(`  ${m.dest.padEnd(16)} worldwide/us = ${m.ratio.toFixed(2)}x`)
      const hi = Math.max(...meds.map((m) => m.ratio))
      const lo = Math.min(...meds.map((m) => m.ratio))
      const spread = hi / Math.max(lo, 0.0001)
      console.log(`\n  spread (highest / lowest) = ${spread.toFixed(2)}x`)
      console.log(
        spread > 2
          ? '>> RULE FIRES: the gap VARIES by destination, so country:US reorders the grid. Revisit §0.2.'
          : '>> Rule does not fire: the gap is near-uniform, so it divides out of the ranking. §0.2 stands.',
      )
    }
  }

  console.log('\nCost: $0. Google Ads volume is free and there is no paid fallback by policy.')
}

await main()
